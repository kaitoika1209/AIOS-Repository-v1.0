/**
 * The Membership Aggregate.
 *
 * Implements the Membership sections of
 * `docs/architecture/identity-and-organization.md`, which give Membership its
 * own Aggregate so an Organization with many Members does not become one
 * oversized write boundary.
 *
 * A Membership is the durable relationship between a Human Identity and an
 * Organization. It is not a principal: only an `Active` Membership can produce a
 * `HumanMemberPrincipal`, and an `Invited` one grants no business authority at
 * all. That distinction is the whole point of the invitation flow — the row
 * exists, and confers nothing, until a human accepts.
 *
 * Role assignments and invitations are child entities: the aggregate document
 * lists "active role assignments" and "invitation metadata" among what
 * Membership owns.
 */

import type {
  AggregateVersion,
  IdentityId,
  InvitationId,
  InvitationStatus,
  MembershipId,
  MembershipStatus,
  OrganizationId,
  Role,
} from "@aios/types";

import {
  InvalidTransitionError,
  InvitationNotAcceptableError,
  ValidationError,
} from "./errors.js";
import { stampMembership, type MembershipEvent } from "./events.js";
import type { ActorContext, CommandResult } from "./work.js";

/**
 * One issued invitation.
 *
 * Several may exist for one Membership: resending supersedes its predecessor
 * rather than mutating it, so a token that was already delivered stops working
 * without erasing the record that it was sent.
 */
export interface InvitationState {
  readonly invitationId: InvitationId;
  readonly invitationVersion: number;
  /** Only the hash is ever held. The token itself is shown once and discarded. */
  readonly tokenHash: string;
  readonly status: InvitationStatus;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface MembershipState {
  readonly membershipId: MembershipId;
  readonly organizationId: OrganizationId;
  /** Null exactly while `Invited`: an invitee may have no Identity yet. */
  readonly identityId: IdentityId | null;
  readonly pendingInviteeEmail: string | null;
  readonly status: MembershipStatus;
  readonly roles: readonly Role[];
  readonly invitedByIdentityId: IdentityId | null;
  readonly invitedByMembershipId: MembershipId | null;
  readonly invitedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly revokedByIdentityId: IdentityId | null;
  readonly revokedAt: Date | null;
  readonly revocationReason: string | null;
  readonly invitations: readonly InvitationState[];
  readonly version: AggregateVersion;
}

export type MembershipResult = CommandResult<MembershipState, MembershipEvent>;

/**
 * Roles an invitation may grant.
 *
 * `OrganizationOwner` is absent deliberately. Becoming an Owner is ownership
 * assignment or transfer, whose permissions authorization.md lists as reserved;
 * granting it through an invitation would route around a command that does not
 * exist yet. An Organization's first Owner is established when the Organization
 * is created, not by invitation.
 */
export const INVITABLE_ROLES = [
  "OrganizationAdmin",
  "Member",
  "Reviewer",
] as const satisfies readonly Role[];

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Applied when an invitation names no role, per the invitation rules. */
export const DEFAULT_INVITED_ROLE: Role = "Member";

/**
 * Email normalization for matching only.
 *
 * `primary_email_normalized` and `pending_invitee_email_normalized` are both
 * `lower(...)` in the schema, and this must agree with them or the unique index
 * on pending invitations will not mean what the code assumes. Email is never an
 * identity key — see "Email Is Not Identity" in the identity document.
 */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const nextVersion = (state: MembershipState): AggregateVersion =>
  (state.version + 1) as AggregateVersion;

export interface InviteInput {
  readonly membershipId: MembershipId;
  readonly organizationId: OrganizationId;
  readonly inviteeEmail: string;
  readonly roles: readonly Role[];
  readonly invitationId: InvitationId;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * Invite a person to an Organization.
 *
 * The caller is responsible for having established that no Active or Invited
 * Membership already exists for this address — that is a query across the
 * Organization, not an invariant this Aggregate can see. The partial unique
 * index `uq_memberships_pending_invitation` is the backstop.
 */
export const inviteToOrganization = (
  ctx: ActorContext,
  input: InviteInput,
): MembershipResult => {
  const principal = ctx.principal;
  if (principal.type !== "HumanMember") {
    throw new ValidationError("Only a Human Member may invite.", {
      principalType: principal.type,
    });
  }
  if (principal.organizationId !== input.organizationId) {
    throw new ValidationError("An invitation may not cross Organizations.");
  }

  const email = normalizeEmail(input.inviteeEmail);
  if (!EMAIL.test(email)) {
    throw new ValidationError("A valid invitee email address is required.");
  }

  const requested = input.roles.length === 0 ? [DEFAULT_INVITED_ROLE] : input.roles;
  const roles = [...new Set(requested)];
  for (const role of roles) {
    if (!(INVITABLE_ROLES as readonly Role[]).includes(role)) {
      throw new ValidationError(`Role ${role} cannot be granted by invitation.`, {
        role,
        invitable: INVITABLE_ROLES,
      });
    }
  }

  if (input.expiresAt.getTime() <= ctx.now.getTime()) {
    throw new ValidationError("An invitation must expire in the future.");
  }

  const state: MembershipState = {
    membershipId: input.membershipId,
    organizationId: input.organizationId,
    identityId: null,
    pendingInviteeEmail: email,
    status: "Invited",
    roles,
    invitedByIdentityId: principal.identityId,
    invitedByMembershipId: principal.membershipId,
    invitedAt: ctx.now,
    activatedAt: null,
    revokedByIdentityId: null,
    revokedAt: null,
    revocationReason: null,
    invitations: [
      {
        invitationId: input.invitationId,
        invitationVersion: 1,
        tokenHash: input.tokenHash,
        status: "Pending",
        expiresAt: input.expiresAt,
        consumedAt: null,
        revokedAt: null,
        createdAt: ctx.now,
      },
    ],
    version: 1 as AggregateVersion,
  };

  return {
    state,
    events: stampMembership(state.version, [
      {
        type: "MembershipInvited",
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId,
        membershipId: state.membershipId,
        inviteeEmail: email,
        initialRoles: roles,
        expiresAt: input.expiresAt,
      },
    ]),
  };
};

/**
 * The invitation a token may currently be redeemed against.
 *
 * Only the newest one counts. A resend supersedes earlier tokens, and returning
 * any Pending invitation would leave a superseded token usable.
 */
const currentInvitation = (state: MembershipState): InvitationState | null => {
  let latest: InvitationState | null = null;
  for (const invitation of state.invitations) {
    if (latest === null || invitation.invitationVersion > latest.invitationVersion) {
      latest = invitation;
    }
  }
  return latest;
};

export { currentInvitation };

export interface ResendInput {
  readonly invitationId: InvitationId;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * Reissue an invitation.
 *
 * A new invitation row supersedes the previous one, which is marked `Revoked`
 * so no earlier token remains redeemable. The Membership is untouched: resending
 * must not create a second Membership, and it is not a lifecycle transition.
 */
export const resendInvitation = (
  state: MembershipState,
  ctx: ActorContext,
  input: ResendInput,
): MembershipResult => {
  if (state.status !== "Invited") {
    throw new InvalidTransitionError("Membership", state.status, "ResendInvitation", [
      "Invited",
    ]);
  }
  if (input.expiresAt.getTime() <= ctx.now.getTime()) {
    throw new ValidationError("An invitation must expire in the future.");
  }

  const previous = currentInvitation(state);
  const supersededVersion = previous?.invitationVersion ?? 0;

  const invitations: InvitationState[] = state.invitations.map((invitation) =>
    invitation.status === "Pending"
      ? { ...invitation, status: "Revoked" as InvitationStatus, revokedAt: ctx.now }
      : invitation,
  );

  invitations.push({
    invitationId: input.invitationId,
    invitationVersion: supersededVersion + 1,
    tokenHash: input.tokenHash,
    status: "Pending",
    expiresAt: input.expiresAt,
    consumedAt: null,
    revokedAt: null,
    createdAt: ctx.now,
  });

  // No event: the Membership fact is unchanged, and the identity document lists
  // no registered event for a resend. Delivery is driven from the returned
  // invitation, not from the Outbox.
  return {
    state: { ...state, invitations, version: nextVersion(state) },
    events: [],
  };
};

/**
 * Revoke an invitation that has not been accepted.
 *
 * The Membership reaches `Revoked`, the same terminal state `RevokeMembership`
 * reaches, and emits the same registered event with a reason. It is retained
 * rather than deleted so the invitation remains auditable.
 */
export const revokeInvitation = (
  state: MembershipState,
  ctx: ActorContext,
  reason: string,
): MembershipResult => {
  if (state.status !== "Invited") {
    throw new InvalidTransitionError("Membership", state.status, "RevokeInvitation", [
      "Invited",
    ]);
  }
  const principal = ctx.principal;
  if (principal.type !== "HumanMember") {
    throw new ValidationError("Only a Human Member may revoke an invitation.");
  }
  if (reason.trim().length === 0) {
    throw new ValidationError("A revocation reason is required.");
  }

  const version = nextVersion(state);
  const next: MembershipState = {
    ...state,
    status: "Revoked",
    revokedByIdentityId: principal.identityId,
    revokedAt: ctx.now,
    revocationReason: reason,
    invitations: state.invitations.map((invitation) =>
      invitation.status === "Pending"
        ? { ...invitation, status: "Revoked" as InvitationStatus, revokedAt: ctx.now }
        : invitation,
    ),
    version,
  };

  return {
    state: next,
    events: stampMembership(version, [
      {
        type: "MembershipRevoked",
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId,
        membershipId: state.membershipId,
        identityId: state.identityId,
        reason,
      },
    ]),
  };
};


const requireReason = (reason: string, message: string): void => {
  if (reason.trim().length === 0) {
    throw new ValidationError(message);
  }
};

/**
 * The acting principal, as an administrative Membership command needs it.
 *
 * Every one of these commands is "authorized Human administrative action" in the
 * document's words. The permission itself is checked in the Application Layer;
 * what the Aggregate requires is an actor it can attribute the change to.
 */
const requireAdministrativeHuman = (
  ctx: ActorContext,
  action: string,
): { identityId: IdentityId; membershipId: MembershipId } => {
  const principal = ctx.principal;
  if (principal.type !== "HumanMember") {
    throw new ValidationError(`Only a Human Member may ${action}.`);
  }
  return {
    identityId: principal.identityId,
    membershipId: principal.membershipId,
  };
};

export interface AcceptInput {
  /** The identity the authenticated subject resolved to, or was created as. */
  readonly identityId: IdentityId;
  /** Hash of the presented token. The raw token never enters the domain. */
  readonly tokenHash: string;
  /**
   * Normalized primary email of an *existing* identity, or null when the
   * identity was created for this acceptance.
   */
  readonly existingIdentityEmail: string | null;
}

/**
 * Accept an invitation.
 *
 * There is no `ActorContext` here, and that is the point: the acceptor holds no
 * Membership in this Organization yet, so no `HumanMemberPrincipal` exists to
 * carry. Authority comes from the token.
 *
 * Every rejection path raises the same error. A caller who guesses a token must
 * not learn whether it was wrong, expired, or already used.
 */
export const acceptInvitation = (
  state: MembershipState,
  now: Date,
  input: AcceptInput,
): MembershipResult => {
  if (state.status !== "Invited") {
    throw new InvitationNotAcceptableError(`membership status ${state.status}`);
  }

  const invitation = currentInvitation(state);
  if (invitation === null) {
    throw new InvitationNotAcceptableError("no invitation issued");
  }
  if (invitation.tokenHash !== input.tokenHash) {
    // A superseded token hashes differently, so a resend invalidates it here.
    throw new InvitationNotAcceptableError("token superseded or unknown");
  }
  if (invitation.status !== "Pending") {
    throw new InvitationNotAcceptableError(`invitation status ${invitation.status}`);
  }
  // `expires_at` is the authority, not the materialized `Expired` status: an
  // invitation past its expiry is refused whether or not a sweeper has run.
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    throw new InvitationNotAcceptableError("expired");
  }

  // Matching rule, per the MVP Invitation Matching Policy. An identity that
  // already exists must be the addressee; otherwise a forwarded token would
  // silently attach an unrelated account to the Organization.
  if (
    input.existingIdentityEmail !== null &&
    state.pendingInviteeEmail !== null &&
    normalizeEmail(input.existingIdentityEmail) !== state.pendingInviteeEmail
  ) {
    throw new InvitationNotAcceptableError("addressee mismatch");
  }

  const version = nextVersion(state);
  const next: MembershipState = {
    ...state,
    identityId: input.identityId,
    // Cleared on activation: `ck_memberships_identity_presence` binds an
    // Identity from here on, and the pending address has served its purpose.
    pendingInviteeEmail: null,
    status: "Active",
    activatedAt: now,
    invitations: state.invitations.map((candidate) =>
      candidate.invitationId === invitation.invitationId
        ? { ...candidate, status: "Consumed" as InvitationStatus, consumedAt: now }
        : candidate,
    ),
    version,
  };

  return {
    state: next,
    events: stampMembership(version, [
      {
        type: "MembershipActivated",
        organizationId: state.organizationId,
        occurredAt: now,
        actorIdentityId: input.identityId,
        // Null on purpose: at the instant of acceptance the actor held no
        // Membership. The Membership this event activates is `membershipId`.
        actorMembershipId: null,
        membershipId: state.membershipId,
        identityId: input.identityId,
        initialRoles: state.roles,
      },
    ]),
  };
};

/** Whether this Membership can currently produce a `HumanMemberPrincipal`. */
export const grantsAuthority = (state: MembershipState): boolean =>
  state.status === "Active";

/**
 * Temporarily remove authority in one Organization.
 *
 * Reversible, unlike revocation, and that is the whole reason it exists:
 * "role assignments remain stored but inactive for authorization". Nothing is
 * unassigned and no history is rewritten — "assigned Work remains assigned
 * unless separately reassigned".
 *
 * The Last Owner Invariant is *not* checked here. It spans every Membership in
 * the Organization, and the Aggregate cannot see another Aggregate; the
 * Application Layer enforces it.
 */
export const suspendMembership = (
  state: MembershipState,
  ctx: ActorContext,
  reason: string,
): MembershipResult => {
  const principal = requireAdministrativeHuman(ctx, "suspend a Membership");
  if (state.status !== "Active") {
    throw new InvalidTransitionError("Membership", state.status, "SuspendMembership", [
      "Active",
    ]);
  }
  requireReason(reason, "A suspension reason is required.");

  const version = nextVersion(state);
  const next: MembershipState = { ...state, status: "Suspended", version };

  return {
    state: next,
    events: stampMembership(version, [
      {
        type: "MembershipSuspended",
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId,
        membershipId: state.membershipId,
        // Non-null by the status check: only an Active Membership reaches here,
        // and an Active Membership always carries an Identity.
        identityId: state.identityId!,
        reason,
      },
    ]),
  };
};

/** Restore a suspended Membership. Roles were retained, so none are reissued. */
export const reactivateMembership = (
  state: MembershipState,
  ctx: ActorContext,
  reason: string,
): MembershipResult => {
  const principal = requireAdministrativeHuman(ctx, "reactivate a Membership");
  if (state.status !== "Suspended") {
    throw new InvalidTransitionError("Membership", state.status, "ReactivateMembership", [
      "Suspended",
    ]);
  }
  requireReason(reason, "A reactivation reason is required.");

  const version = nextVersion(state);
  const next: MembershipState = { ...state, status: "Active", version };

  return {
    state: next,
    events: stampMembership(version, [
      {
        type: "MembershipReactivated",
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId,
        membershipId: state.membershipId,
        identityId: state.identityId!,
        reason,
      },
    ]),
  };
};

/**
 * Permanently remove future authority.
 *
 * Terminal. "The MVP should not silently change Revoked back to Active" — a
 * returning person needs a new Membership, so there is no reinstatement command
 * and no path back from this state.
 *
 * Self-removal is refused here rather than in the Application Layer, because the
 * Aggregate holds both facts it needs: who is acting, and whose Membership this
 * is. An administrator who revokes their own Membership mid-request would spend
 * the authority that authorized the request.
 *
 * Reachable from `Invited` as well as `Active` and `Suspended`, which is why
 * `revokeInvitation` is a separate command rather than a different outcome: the
 * invitation path also resolves the pending invitation.
 */
export const revokeMembership = (
  state: MembershipState,
  ctx: ActorContext,
  reason: string,
): MembershipResult => {
  const principal = requireAdministrativeHuman(ctx, "revoke a Membership");
  if (
    state.status !== "Active" &&
    state.status !== "Suspended" &&
    state.status !== "Invited"
  ) {
    throw new InvalidTransitionError("Membership", state.status, "RevokeMembership", [
      "Invited",
      "Active",
      "Suspended",
    ]);
  }
  requireReason(reason, "A revocation reason is required.");

  if (principal.membershipId === state.membershipId) {
    throw new ValidationError(
      "A Member cannot revoke their own Membership.",
      { field: "membershipId" },
    );
  }

  const version = nextVersion(state);
  const next: MembershipState = {
    ...state,
    status: "Revoked",
    revokedByIdentityId: principal.identityId,
    revokedAt: ctx.now,
    revocationReason: reason,
    // A Membership revoked while still Invited leaves no usable token behind.
    invitations: state.invitations.map((invitation) =>
      invitation.status === "Pending"
        ? { ...invitation, status: "Revoked" as InvitationStatus, revokedAt: ctx.now }
        : invitation,
    ),
    version,
  };

  return {
    state: next,
    events: stampMembership(version, [
      {
        type: "MembershipRevoked",
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId,
        membershipId: state.membershipId,
        identityId: state.identityId,
        reason,
      },
    ]),
  };
};
