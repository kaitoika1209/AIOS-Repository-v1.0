/**
 * Membership use cases — the invitation flow.
 *
 * Implements the invitation workflow in
 * `docs/architecture/identity-and-organization.md`: an authorized Human invites
 * an address, a token is delivered out of band, and acceptance is what binds an
 * Identity and produces a Membership that can carry authority.
 *
 * Acceptance is the odd one out and deliberately so. Every other use case here
 * takes an Organization-scoped context; acceptance cannot, because the caller is
 * not yet a Member of anything. ADR-0014 records that exemption for the route,
 * and it stops there — the token names the Organization, the caller never does.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { MembershipId, OrganizationId, Role } from "@aios/types";
import {
  acceptInvitation,
  InvitationNotAcceptableError,
  inviteToOrganization,
  normalizeEmail,
  reactivateMembership,
  resendInvitation,
  revokeInvitation,
  revokeMembership,
  suspendMembership,
  currentInvitation,
  ValidationError,
  type MembershipState,
} from "@aios/domain";

import { requirePermission } from "./authorization.js";
import {
  NotFoundError,
  type OrganizationMemberSummary,
  type RepositoryBundle,
  type UseCaseDependencies,
} from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

/**
 * Default invitation lifetime.
 *
 * The invitation rules require a bounded validity period but name no number.
 * Seven days is long enough to survive a weekend and short enough that a leaked
 * token stops mattering quickly.
 */
export const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Issue an invitation token.
 *
 * 32 bytes from a cryptographic source, base64url encoded. The raw value is
 * returned to the caller exactly once and never stored; only the hash is
 * persisted, so a database disclosure yields nothing redeemable.
 */
export const issueToken = (): { token: string; tokenHash: string } => {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
};

export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * Compare two hashes without leaking where they differ.
 *
 * The domain's own equality check runs on hashes of equal length, which makes
 * the timing signal small — but a token is a bearer credential, and comparing
 * one in variable time is the kind of detail that is cheap to get right here and
 * expensive to notice later.
 */
export const hashesEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

/** What an invitation command returns: the state, plus the one-time token. */
export interface IssuedInvitation {
  readonly membership: MembershipState;
  /** Shown to the sender once. Never persisted, never logged. */
  readonly token: string;
}

const loadMembership = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
  membershipId: MembershipId,
): Promise<MembershipState> => {
  const membership = await tx.memberships.findById(organizationId, membershipId);
  if (membership === null) {
    throw new NotFoundError("Membership");
  }
  return membership;
};

export interface InviteMemberInput {
  readonly email: string;
  readonly roles: readonly Role[];
}

/**
 * Invite a person to the acting Organization.
 *
 * The duplicate check is a query across the Organization rather than an
 * Aggregate invariant, so it lives here. It is advisory: two concurrent invites
 * to the same address both pass it, and the partial unique index
 * `uq_memberships_pending_invitation` fails the loser.
 */
export const inviteMemberUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: InviteMemberInput,
): Promise<IssuedInvitation> => {
  requirePermission(ctx.principal, "organization.invite_member");

  const email = normalizeEmail(input.email);
  const { token, tokenHash } = issueToken();

  const membership = await deps.uow.transaction(async (tx) => {
    const existing = await tx.memberships.findByEmail(ctx.organizationId, email);
    if (existing !== null && existing.status !== "Revoked") {
      throw new ValidationError(
        existing.status === "Invited"
          ? "This address has already been invited."
          : "This person is already a Member of this Organization.",
        { status: existing.status },
      );
    }

    const { state, events } = inviteToOrganization(ctx, {
      membershipId: deps.ids.membershipId(),
      organizationId: ctx.organizationId,
      inviteeEmail: email,
      roles: input.roles,
      invitationId: deps.ids.invitationId(),
      tokenHash,
      expiresAt: new Date(ctx.now.getTime() + INVITATION_LIFETIME_MS),
    });

    await tx.memberships.insert(state);
    await tx.outbox.append(events);
    return state;
  });

  return { membership, token };
};

/** Reissue a token for an invitation that has not been accepted. */
export const resendInvitationUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  membershipId: MembershipId,
): Promise<IssuedInvitation> => {
  requirePermission(ctx.principal, "organization.resend_invitation");

  const { token, tokenHash } = issueToken();

  const membership = await deps.uow.transaction(async (tx) => {
    const current = await loadMembership(tx, ctx.organizationId, membershipId);
    const { state } = resendInvitation(current, ctx, {
      invitationId: deps.ids.invitationId(),
      tokenHash,
      expiresAt: new Date(ctx.now.getTime() + INVITATION_LIFETIME_MS),
    });
    await tx.memberships.update(state, current.version);
    return state;
  });

  return { membership, token };
};

export const revokeInvitationUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  membershipId: MembershipId,
  reason: string,
): Promise<MembershipState> => {
  requirePermission(ctx.principal, "organization.revoke_invitation");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMembership(tx, ctx.organizationId, membershipId);
    const { state, events } = revokeInvitation(current, ctx, reason);
    await tx.memberships.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

/**
 * The Last Owner Invariant.
 *
 * "An operation must not remove, suspend, or revoke the final active Owner when
 * the Organization remains Active." It spans every Membership in the
 * Organization, so the Aggregate cannot enforce it — it can see only itself.
 *
 * Checked against the member list inside the same transaction as the write, so a
 * concurrent revocation cannot let two requests each believe another Owner
 * remains.
 */
const requireAnotherActiveOwner = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
  losing: MembershipId,
): Promise<void> => {
  const members = await tx.memberships.listMembers(organizationId);
  const remainingOwners = members.filter(
    (m) =>
      m.membershipId !== losing &&
      m.status === "Active" &&
      m.roles.includes("OrganizationOwner"),
  );

  if (remainingOwners.length === 0) {
    throw new LastOwnerError();
  }
};

/**
 * Refused because the Organization would be left with no active Owner.
 *
 * `409`, not `422`: the request is well formed and the target Membership is in a
 * state that accepts the command. What refuses it is the Organization's current
 * shape, which the caller can change by appointing another Owner first —
 * exactly what the document prescribes ("The Organization must first: assign
 * another Owner").
 */
export class LastOwnerError extends Error {
  readonly code = "LAST_OWNER_REQUIRED" as const;

  constructor() {
    super("The Organization must keep at least one active Owner.");
    this.name = "LastOwnerError";
  }
}

/**
 * Temporarily remove a Member's authority.
 *
 * Suspension is checked against the Last Owner Invariant as well as revocation,
 * because the invariant names all three operations: a suspended Owner is not an
 * active Owner, so suspending the last one leaves the Organization ownerless
 * just as surely as revoking them.
 */
export const suspendMemberUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  membershipId: MembershipId,
  reason: string,
): Promise<MembershipState> => {
  requirePermission(ctx.principal, "organization.suspend_member");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMembership(tx, ctx.organizationId, membershipId);
    if (current.roles.includes("OrganizationOwner")) {
      await requireAnotherActiveOwner(tx, ctx.organizationId, membershipId);
    }

    const { state, events } = suspendMembership(current, ctx, reason);
    await tx.memberships.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const reactivateMemberUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  membershipId: MembershipId,
  reason: string,
): Promise<MembershipState> => {
  requirePermission(ctx.principal, "organization.reactivate_member");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMembership(tx, ctx.organizationId, membershipId);
    // No invariant applies: reactivation only ever adds an active Member.
    const { state, events } = reactivateMembership(current, ctx, reason);
    await tx.memberships.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

/**
 * Permanently remove a Member's future authority.
 *
 * Terminal, and there is no reinstatement command: a returning person needs a
 * new Membership. Self-removal is refused by the Aggregate, which holds both the
 * actor and the target.
 */
export const revokeMemberUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  membershipId: MembershipId,
  reason: string,
): Promise<MembershipState> => {
  requirePermission(ctx.principal, "organization.revoke_member");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMembership(tx, ctx.organizationId, membershipId);
    if (current.roles.includes("OrganizationOwner")) {
      await requireAnotherActiveOwner(tx, ctx.organizationId, membershipId);
    }

    const { state, events } = revokeMembership(current, ctx, reason);
    await tx.memberships.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const listMembersUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
): Promise<readonly OrganizationMemberSummary[]> => {
  requirePermission(ctx.principal, "organization.read_members");
  return deps.uow.transaction((tx) => tx.memberships.listMembers(ctx.organizationId));
};

/**
 * The authenticated caller presenting a token.
 *
 * No principal and no Organization: neither exists yet. `displayName` is what
 * the caller is known as at the authentication provider, used only if an
 * Identity has to be created.
 */
export interface AcceptInvitationContext {
  readonly subject: {
    readonly provider: string;
    readonly issuer: string;
    readonly subject: string;
  };
  readonly displayName: string;
  readonly now: Date;
}

export interface AcceptedInvitation {
  readonly membership: MembershipState;
  readonly organizationId: OrganizationId;
}

/**
 * Accept an invitation.
 *
 * Permission is not consulted, because there is no Membership to derive one
 * from — authority is the token. Everything the flow needs is reachable from it:
 * the Membership names the Organization, and the Organization named the roles
 * when the invitation was sent.
 *
 * The Identity resolution is the part worth reading twice. An existing Identity
 * must be the addressee, or a forwarded token would attach a stranger's account
 * to the Organization. A caller with no Identity gets one, created from the
 * invitation's own address rather than from anything they supplied.
 */
export const acceptInvitationUseCase = async (
  deps: UseCaseDependencies,
  ctx: AcceptInvitationContext,
  token: string,
): Promise<AcceptedInvitation> => {
  const tokenHash = hashToken(token);

  return deps.uow.transaction(async (tx) => {
    const membership = await tx.memberships.findByInvitationTokenHash(tokenHash);
    if (membership === null) {
      // The same error the Aggregate raises, not a NotFoundError. The two
      // produce different messages, and a caller who can tell "no such token"
      // from "that token is expired" can enumerate valid tokens.
      throw new InvitationNotAcceptableError("unknown token");
    }

    const invitation = currentInvitation(membership);
    if (invitation === null || !hashesEqual(invitation.tokenHash, tokenHash)) {
      throw new InvitationNotAcceptableError("token superseded");
    }

    const existing = await tx.identities.findBySubject(ctx.subject);
    if (existing !== null && existing.status !== "Active") {
      // A disabled Identity may not acquire new authority; the invitation is
      // left untouched so it can still be accepted once the block is lifted.
      throw new InvitationNotAcceptableError("identity disabled");
    }

    // An `Invited` Membership always carries the address it was sent to; the
    // check constraint and this guard say so from both sides.
    if (existing === null && membership.pendingInviteeEmail === null) {
      throw new InvitationNotAcceptableError("no invitee address");
    }

    // Created before the invitation is validated, and undone with it: the
    // domain check below runs inside this transaction, so a refusal rolls the
    // new Identity back rather than leaving an orphan.
    const identity =
      existing ??
      (await tx.identities.createWithSubject({
        identityId: deps.ids.identityId(),
        displayName: ctx.displayName,
        // The invitation's address, not one the caller chose.
        primaryEmail: membership.pendingInviteeEmail!,
        ...ctx.subject,
      }));

    const { state, events } = acceptInvitation(membership, ctx.now, {
      identityId: identity.identityId,
      tokenHash,
      existingIdentityEmail: existing?.primaryEmailNormalized ?? null,
    });

    await tx.memberships.update(state, membership.version);
    await tx.outbox.append(events);

    return { membership: state, organizationId: state.organizationId };
  });
};
