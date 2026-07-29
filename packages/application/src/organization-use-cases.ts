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

import type { IdentityId, OrganizationId } from "@aios/types";
import {
  ValidationError,
  createOrganization,
  renameOrganization,
  type MembershipState,
  type OrganizationState,
} from "@aios/domain";

import { requirePermission } from "./authorization.js";
import { NotFoundError, type UseCaseDependencies } from "./ports.js";
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
  input: { readonly name: string },
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
    const current = await tx.organizations.findById(ctx.organizationId);
    if (current === null) {
      throw new NotFoundError("Organization");
    }

    const { state, events } = renameOrganization(current, name, ctx);
    await tx.organizations.update(state, current.version);
    await tx.outbox.append(events);
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
