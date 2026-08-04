/**
 * Organization use cases.
 *
 * Creation is the second route in the system with no permission check, and for
 * the same structural reason as invitation acceptance: the caller holds no
 * Membership anywhere in the Organization they are creating, so there is no
 * principal to hold a permission and nothing for `X-Organization-Id` to select
 * among. Authority comes from being an authenticated, Active Human Identity.
 *
 * Renaming is ordinary: by then the caller is a Member and the permission
 * applies.
 */

import { isHumanMember, type IdentityId, type OrganizationId } from "@aios/types";
import {
  ValidationError,
  archiveOrganization,
  createOrganization,
  reactivateOrganization,
  renameOrganization,
  suspendOrganization,
  type MembershipState,
  type OrganizationState,
} from "@aios/domain";

import {
  ASSISTANCE_GRANTS,
  specForOperation,
  type AssistanceGrantSpec,
} from "./assistance.js";
import { recordTransition } from "./audit.js";
import { requirePermission } from "./authorization.js";
import {
  NotFoundError,
  type CallerOrganizationSummary,
  type RepositoryBundle,
  type UseCaseDependencies,
} from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

/**
 * The authenticated caller creating an Organization.
 *
 * A subject, not a principal: no principal exists, because a principal is held
 * through a Membership and the Organization does not exist yet. The same shape
 * invitation acceptance uses, for the same reason.
 */
export interface OrganizationCreator {
  readonly subject: {
    readonly provider: string;
    readonly issuer: string;
    readonly subject: string;
  };
  readonly displayName: string;
  /**
   * The address recorded on a newly created Human Identity, when the provider
   * supplies one.
   *
   * From the verified session, never from the request body: letting a caller
   * choose it would make an unverified address look verified. Null is
   * representable — `primary_email` is nullable, and no join depends on it.
   */
  readonly email: string | null;
  readonly now: Date;
}

/**
 * Create an Organization with its first Owner.
 *
 * Both Aggregates are constructed by their own commands and persisted in one
 * transaction. This is the "exceptional coordinated-creation workflow" the
 * identity document permits, and it exists to satisfy one invariant: an Active
 * Organization must never be visible without an active Owner.
 *
 * The Owner Membership is built here rather than by `inviteToOrganization`
 * followed by `acceptInvitation`, because there is no invitation: nobody invited
 * the creator, and routing them through a token they issue to themselves would
 * be a fiction with a real bearer credential in it.
 */
export const createOrganizationUseCase = async (
  deps: UseCaseDependencies,
  creator: OrganizationCreator,
  input: { readonly name: string; readonly secretaryPrincipalId: string },
): Promise<{ organization: OrganizationState; membership: MembershipState }> => {
  const organizationId = deps.ids.organizationId();
  const membershipId = deps.ids.membershipId();

  return deps.uow.transaction(async (tx) => {
    // "Verify Human Identity is Active" is the first step of the documented
    // bootstrap transaction. An unmapped subject may create an Identity
    // (ADR-0013); a disabled one may not acquire new authority.
    const existing = await tx.identities.findBySubject(creator.subject);
    if (existing !== null && existing.status !== "Active") {
      throw new ValidationError("An Active Human Identity is required.");
    }

    const identity =
      existing ??
      (await tx.identities.createWithSubject({
        identityId: deps.ids.identityId(),
        displayName: creator.displayName,
        primaryEmail: creator.email,
        ...creator.subject,
      }));

    const created = createOrganization(
      {
        organizationId,
        name: input.name,
        createdByIdentityId: identity.identityId,
      },
      creator.now,
    );

    const ownerMembership: MembershipState = {
      membershipId,
      organizationId,
      identityId: identity.identityId,
      pendingInviteeEmail: null,
      status: "Active",
      // Nobody invited the creator, so there is no inviter to attribute.
      // Recording themselves would claim an invitation that never happened.
      invitedByIdentityId: null,
      invitedByMembershipId: null,
      invitedAt: creator.now,
      activatedAt: creator.now,
      revokedByIdentityId: null,
      revokedAt: null,
      revocationReason: null,
      invitations: [],
      roles: ["OrganizationOwner"],
      version: 1 as MembershipState["version"],
    };

    await tx.organizations.bootstrap({
      organization: created.state,
      ownerMembership,
      roleAssignmentId: deps.ids.roleAssignmentId(),
    });

    // `MembershipActivated` rather than `MembershipCreated`: the events document
    // is authoritative for registered event names and does not list the latter,
    // and activation is what actually happened — the Membership is Active from
    // the moment it exists.
    await tx.outbox.append([
      ...created.events,
      {
        type: "MembershipActivated",
        organizationId,
        aggregateVersion: 1,
        occurredAt: creator.now,
        actorIdentityId: identity.identityId,
        // The creator holds no prior Membership, so there is none to attribute
        // the activation to. The Membership it creates is named in the payload.
        actorMembershipId: null,
        membershipId,
        identityId: identity.identityId,
        initialRoles: ownerMembership.roles,
      },
    ]);

    // The baseline assistance grants (ADR-0019). Attributed to the founding
    // Owner, whose Membership is created in this same transaction — which is
    // what `granted_by_membership_id` requires, and why this is the Owner's act
    // rather than the platform granting on an Organization's behalf.
    //
    // `mvp.md` presents one Secretary per Organization as a property of an
    // Organization, not an opt-in, so a new one arrives able to assist.
    // Deny-by-default is untouched: the invocation check still demands an active
    // grant for the exact five-field identity, and still fails closed for
    // anything the registry does not declare.
    for (const spec of ASSISTANCE_GRANTS) {
      await tx.assistanceGrants.grant({
        grantId: deps.ids.grantId(),
        organizationId,
        secretaryPrincipalId: input.secretaryPrincipalId,
        contextKey: spec.contextKey,
        assistanceOperation: spec.assistanceOperation,
        portContractVersion: spec.portContractVersion,
        grantedByMembershipId: membershipId,
        reason: "Granted when the Organization was created.",
        now: creator.now,
      });
    }

    return { organization: created.state, membership: ownerMembership };
  });
};

export const renameOrganizationUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  name: string,
): Promise<OrganizationState> => {
  requirePermission(ctx.principal, "organization.rename");

  return deps.uow.transaction(async (tx) => {
    const current = await loadOrganization(tx, ctx.organizationId);

    const { state, events } = renameOrganization(current, name, ctx);
    await tx.organizations.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

/**
 * Refused because the Organization still has Work that archival would strand.
 *
 * `409`, not `422`: the request is well formed and the Organization is in a
 * state that accepts archival. What refuses it is the Organization's current
 * shape, which the caller can change by finishing or cancelling the Work —
 * the same shape as `LastOwnerError`.
 */
export class LiveWorkError extends Error {
  readonly code = "LIVE_WORK_REMAINS" as const;

  constructor(readonly count: number) {
    super(
      `The Organization has ${count} Work item(s) still in progress or ` +
        "waiting for a Decision. Complete or cancel them before archiving.",
    );
    this.name = "LiveWorkError";
  }
}

/**
 * ADR-0017's archival precondition: "An Organization may be archived only when
 * no Work remains InProgress or WaitingForDecision."
 *
 * Archival makes the Organization read-only, so a Work left in either state
 * could never afterwards be completed or cancelled. The check spans Aggregates,
 * which is why it is here and not in the Organization: it is the same division
 * the Last Owner Invariant follows.
 *
 * Read inside the archiving transaction, so a Work started concurrently cannot
 * slip between the check and the write.
 */
const requireNoLiveWork = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
): Promise<void> => {
  const work = await tx.work.listByOrganization(organizationId);
  const live = work.filter(
    (w) => w.status === "InProgress" || w.status === "WaitingForDecision",
  );
  if (live.length > 0) {
    // The count, not the identifiers. A caller entitled to archive is entitled
    // to know how much is outstanding, but an Owner holds no relationship to
    // every Work by default and the refusal must not become a listing.
    throw new LiveWorkError(live.length);
  }
};

/** Load the Organization this context acts in, or report it absent. */
const loadOrganization = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
): Promise<OrganizationState> => {
  const organization = await tx.organizations.findById(organizationId);
  if (organization === null) {
    throw new NotFoundError("Organization");
  }
  return organization;
};

/**
 * Record an Organization lifecycle transition.
 *
 * The edge interceptor records that the command was allowed; only here are both
 * states known. See `auditWorkTransition`.
 */
const auditOrganizationTransition = (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  before: OrganizationState,
  after: OrganizationState,
  permission: string,
  commandType: string,
): void => {
  if (before.status === after.status) return;
  recordTransition(deps.audit, {
    organizationId: ctx.organizationId,
    identityId: isHumanMember(ctx.principal) ? ctx.principal.identityId : null,
    membershipId: isHumanMember(ctx.principal) ? ctx.principal.membershipId : null,
    commandType,
    permission,
    resourceType: "Organization",
    resourceId: after.organizationId,
    previousState: before.status,
    nextState: after.status,
    now: ctx.now,
  });
};

/**
 * Pause the Organization.
 *
 * Every route in the Organization stops resolving the moment this commits —
 * `PrincipalResolver` refuses a non-Active Organization — so the caller's next
 * request will be answered `404` even though this one succeeded. The one
 * exception is `POST /organizations/{organizationId}/reactivate`, which ADR-0014
 * exempts from the status check precisely so there is a way back.
 */
export const suspendOrganizationUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  reason: string,
): Promise<OrganizationState> => {
  requirePermission(ctx.principal, "organization.suspend");

  return deps.uow.transaction(async (tx) => {
    const current = await loadOrganization(tx, ctx.organizationId);
    const { state, events } = suspendOrganization(current, reason, ctx);

    await tx.organizations.update(state, current.version);
    await tx.outbox.append(events);
    auditOrganizationTransition(
      deps, ctx, current, state, "organization.suspend", "SuspendOrganization",
    );
    return state;
  });
};

/**
 * Return a suspended Organization to service.
 *
 * The one route that reaches a non-Active Organization. The guard still resolves
 * the caller's Membership and this still checks the permission, so the exemption
 * buys exactly one thing: the Organization's status is not itself a reason to
 * refuse.
 *
 * "At least one valid active Owner" is not re-checked. The caller *is* an active
 * Owner — no other role holds `organization.reactivate`, and the guard resolved
 * their Membership as Active before this ran — so the condition is satisfied by
 * the fact that this code is executing.
 */
export const reactivateOrganizationUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  reason: string,
): Promise<OrganizationState> => {
  requirePermission(ctx.principal, "organization.reactivate");

  return deps.uow.transaction(async (tx) => {
    const current = await loadOrganization(tx, ctx.organizationId);
    const { state, events } = reactivateOrganization(current, reason, ctx);

    await tx.organizations.update(state, current.version);
    await tx.outbox.append(events);
    auditOrganizationTransition(
      deps, ctx, current, state, "organization.reactivate", "ReactivateOrganization",
    );
    return state;
  });
};

/**
 * Archive the Organization, permanently.
 *
 * Terminal, and the last command this Organization will accept: an Archived
 * Organization is refused by the resolver like a Suspended one, and no route is
 * exempt from that for `Archived`.
 */
export const archiveOrganizationUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  reason: string,
): Promise<OrganizationState> => {
  requirePermission(ctx.principal, "organization.archive");

  return deps.uow.transaction(async (tx) => {
    const current = await loadOrganization(tx, ctx.organizationId);
    await requireNoLiveWork(tx, ctx.organizationId);
    const { state, events } = archiveOrganization(current, reason, ctx);

    await tx.organizations.update(state, current.version);
    await tx.outbox.append(events);
    auditOrganizationTransition(
      deps, ctx, current, state, "organization.archive", "ArchiveOrganization",
    );
    return state;
  });
};

export const getOrganizationUseCase = async (
  deps: UseCaseDependencies,
  organizationId: OrganizationId,
): Promise<OrganizationState> =>
  deps.uow.transaction(async (tx) => {
    const organization = await tx.organizations.findById(organizationId);
    if (organization === null) {
      throw new NotFoundError("Organization");
    }
    return organization;
  });

/**
 * Refused because the request named an operation the build does not declare.
 *
 * `422`, like every other well-formed request that violates a domain rule. The
 * operation set is a closed vocabulary (`ASSISTANCE_OPERATIONS`), not a name a
 * caller supplies — ADR-0011 requires unknown ones to fail closed, and this is
 * that boundary at granting time rather than at invocation.
 */
export class UnknownAssistanceOperationError extends Error {
  readonly code = "ASSISTANCE_NOT_GRANTED" as const;

  constructor(operation: string) {
    super(`No assistance port declares the operation ${operation}.`);
    this.name = "UnknownAssistanceOperationError";
  }
}

/**
 * Enable one of the Secretary's advisory operations (ADR-0019).
 *
 * The caller names an operation. Its context and port contract version are read
 * from the declared registry, so a caller cannot widen the grant's identity to
 * something the ports do not own.
 *
 * Idempotent: granting what is already granted changes nothing and is not an
 * error. `uq_secretary_grants_active` admits one active grant per identity, and
 * the repository's `ON CONFLICT DO NOTHING` is what makes a repeat harmless.
 */
export const grantAssistanceUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: {
    readonly secretaryPrincipalId: string;
    readonly operation: string;
    readonly reason: string;
  },
): Promise<AssistanceGrantSpec> => {
  requirePermission(ctx.principal, "organization.grant_assistance");

  const spec = specForOperation(input.operation);
  if (spec === null) {
    throw new UnknownAssistanceOperationError(input.operation);
  }
  const principal = requireGrantingMember(ctx);

  await deps.uow.transaction(async (tx) => {
    await tx.assistanceGrants.grant({
      grantId: deps.ids.grantId(),
      organizationId: ctx.organizationId,
      secretaryPrincipalId: input.secretaryPrincipalId,
      contextKey: spec.contextKey,
      assistanceOperation: spec.assistanceOperation,
      portContractVersion: spec.portContractVersion,
      grantedByMembershipId: principal.membershipId,
      reason: input.reason,
      now: ctx.now,
    });
  });

  return spec;
};

/**
 * Withdraw an advisory operation.
 *
 * Reported as absent when nothing was active to withdraw. Silently succeeding
 * would tell an operator the Secretary had been stopped when it had never been
 * started under that identity — the opposite of what they asked to confirm.
 */
export const revokeAssistanceUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: { readonly secretaryPrincipalId: string; readonly operation: string },
): Promise<AssistanceGrantSpec> => {
  requirePermission(ctx.principal, "organization.revoke_assistance");

  const spec = specForOperation(input.operation);
  if (spec === null) {
    throw new UnknownAssistanceOperationError(input.operation);
  }
  const principal = requireGrantingMember(ctx);

  const revoked = await deps.uow.transaction((tx) =>
    tx.assistanceGrants.revoke({
      organizationId: ctx.organizationId,
      secretaryPrincipalId: input.secretaryPrincipalId,
      contextKey: spec.contextKey,
      assistanceOperation: spec.assistanceOperation,
      portContractVersion: spec.portContractVersion,
      revokedByMembershipId: principal.membershipId,
      now: ctx.now,
    }),
  );

  if (!revoked) {
    throw new NotFoundError("Assistance grant");
  }
  return spec;
};

/**
 * The Member a grant is attributed to.
 *
 * `granted_by_membership_id` is `NOT NULL` with a composite foreign key into
 * `memberships`, so a grant always names a Member of the same Organization —
 * there is no shape in which the platform grants on an Organization's behalf.
 */
const requireGrantingMember = (ctx: WorkCommandContext) => {
  if (!isHumanMember(ctx.principal)) {
    throw new ValidationError("Only a Human Member may grant assistance.");
  }
  return ctx.principal;
};

/**
 * The Organizations the caller may act in.
 *
 * The third route with no permission check, and the reason is the same shape as
 * the other two: a permission is held through a Membership and evaluated within
 * one Organization, and this query spans Memberships and precedes the choice of
 * one. ADR-0014 records the exemption.
 *
 * It exists because `X-Organization-Id` "selects among the caller's Memberships"
 * and nothing enumerated them. `mvp.md` states twice that a person may belong to
 * more than one Organization; without this, a client could only ever be told
 * which single Organization to use, which is what the web application did.
 *
 * An unknown subject is an empty list, not an error. A person who has
 * authenticated but never accepted an invitation or created an Organization
 * belongs to nothing, and that is an ordinary state with an ordinary answer —
 * `404` would suggest the route was wrong rather than the answer empty.
 */
export const listCallerOrganizationsUseCase = async (
  deps: UseCaseDependencies,
  caller: {
    readonly provider: string;
    readonly issuer: string;
    readonly subject: string;
  },
): Promise<readonly CallerOrganizationSummary[]> =>
  deps.uow.transaction(async (tx) => {
    const identity = await tx.identities.findBySubject(caller);
    if (identity === null) return [];

    // A disabled Identity holds no authority anywhere, so it has nothing to
    // select among. Returning its Organizations would show a menu on which
    // every item refuses.
    if (identity.status !== "Active") return [];

    return tx.memberships.listOrganizationsForIdentity(identity.identityId);
  });
