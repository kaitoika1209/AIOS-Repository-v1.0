/**
 * The Organization Aggregate.
 *
 * Implements `docs/architecture/identity-and-organization.md`. The Aggregate
 * owns "Organization identity, Organization name, Organization lifecycle status,
 * creation metadata, suspension, archival" — and explicitly "does not contain
 * all Membership entities". Memberships reference it by `organizationId` and are
 * their own Aggregate.
 *
 * The tenant boundary lives here, which is why nothing in this file reads or
 * writes another Aggregate: the Organization cannot be the thing that decides
 * who belongs to it and also the thing that stores them.
 */

import type {
  AggregateVersion,
  IdentityId,
  MembershipId,
  OrganizationId,
  OrganizationStatus,
} from "@aios/types";
import { isHumanMember, type Principal } from "@aios/types";

import { InvalidTransitionError, ValidationError } from "./errors.js";
import { stampOrganization, type OrganizationEvent } from "./events.js";
import type { ActorContext, CommandResult } from "./work.js";

export interface OrganizationState {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly status: OrganizationStatus;
  readonly createdByIdentityId: IdentityId;
  readonly suspendedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly version: AggregateVersion;
}

export type OrganizationResult = CommandResult<OrganizationState, OrganizationEvent>;

const MAX_NAME = 200;

const validateName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("Organization name is required.", { field: "name" });
  }
  if (trimmed.length > MAX_NAME) {
    throw new ValidationError(`Organization name exceeds ${MAX_NAME} characters.`, {
      field: "name",
      max: MAX_NAME,
    });
  }
  return trimmed;
};

export interface CreateOrganizationInput {
  readonly organizationId: OrganizationId;
  readonly name: string;
  /**
   * The Identity creating it, resolved from the authenticated subject.
   *
   * Passed explicitly rather than taken from a principal, because there is no
   * `HumanMemberPrincipal` to take it from: the creator holds no Membership
   * anywhere in this Organization until the bootstrap creates one. This is the
   * same shape `acceptInvitation` has, and for the same reason.
   */
  readonly createdByIdentityId: IdentityId;
}

/**
 * Create an Organization.
 *
 * `Active` is the only entry state. There is no draft or pending Organization:
 * the bootstrap invariant says the state "Organization = Active, Active Owner
 * Membership = Missing" must never become externally visible, and the
 * Application Layer satisfies it by creating both in one transaction.
 *
 * The Owner Membership is *not* created here. It is a separate Aggregate, and
 * merging it in would be exactly the boundary violation the document warns
 * against: "Organization bootstrap is an exceptional coordinated-creation
 * workflow. It does not merge Aggregate boundaries."
 */
export const createOrganization = (
  input: CreateOrganizationInput,
  now: Date,
): OrganizationResult => {
  const name = validateName(input.name);

  const state: OrganizationState = {
    organizationId: input.organizationId,
    name,
    status: "Active",
    createdByIdentityId: input.createdByIdentityId,
    suspendedAt: null,
    archivedAt: null,
    version: 1 as AggregateVersion,
  };

  return {
    state,
    events: stampOrganization(state.version, [
      {
        type: "OrganizationCreated",
        organizationId: state.organizationId,
        name,
        occurredAt: now,
        actorIdentityId: input.createdByIdentityId,
        // Null, and this is the one Organization event where it always is: the
        // creator's Membership does not exist yet when this event is produced.
        actorMembershipId: null,
      },
    ]),
  };
};

/**
 * Rename an Organization.
 *
 * Refused once the Organization is `Archived`. An archived Organization is a
 * historical record, and renaming one would change what past Work, Decisions,
 * and Memory appear to have belonged to.
 */
export const renameOrganization = (
  state: OrganizationState,
  name: string,
  ctx: ActorContext,
): OrganizationResult => {
  const principal = requireOwnMember(state, ctx, "rename", "renamed");
  if (state.status === "Archived") {
    throw new InvalidTransitionError("Organization", state.status, "organization.rename", [
      "Active",
      "Suspended",
    ]);
  }

  const next = validateName(name);
  // A rename that changes nothing still advances the version, for the same
  // reason a no-op Work edit does: a caller holding a stale expected version
  // must not have it accepted because their no-op happened to match.
  const version = (state.version + 1) as AggregateVersion;

  return {
    state: { ...state, name: next, version },
    events: stampOrganization(version, [
      {
        type: "OrganizationRenamed",
        organizationId: state.organizationId,
        name: next,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId as MembershipId,
      },
    ]),
  };
};

/** Whether the Organization may currently carry business authority. */
export const isOperable = (state: OrganizationState): boolean =>
  state.status === "Active";

/**
 * The Owner acting on their own Organization.
 *
 * Every lifecycle command requires it, and the Aggregate checks it rather than
 * trusting the Application Layer's permission check: a principal from another
 * Organization holding `organization.suspend` there must not be able to suspend
 * this one.
 *
 * The *role* is not checked here. Which roles hold which permission is the
 * authorization catalogue's business, and an Aggregate that also read roles
 * would encode the same rule in two places that could disagree.
 */
const requireOwnMember = (
  state: OrganizationState,
  ctx: ActorContext,
  verb: string,
  done: string,
) => {
  const principal: Principal = ctx.principal;
  if (!isHumanMember(principal)) {
    throw new ValidationError(`Only a Human Member may ${verb} an Organization.`);
  }
  if (principal.organizationId !== state.organizationId) {
    throw new ValidationError(`An Organization may only be ${done} by its own Member.`);
  }
  return principal;
};

const requireReason = (reason: string, message: string): string => {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(message);
  }
  return trimmed;
};

/**
 * Suspend an Organization.
 *
 * A reversible pause its Owner controls. `reactivateOrganization` is the way
 * back, and it is reachable only because ADR-0014 exempts its route from the
 * Organization-status check — without that, this command would be a one-way
 * door.
 *
 * Nothing is deleted and no Membership changes: "no automatic deletion of
 * resources", "preservation of membership and audit history". The effect comes
 * entirely from the status, which `PrincipalResolver` reads on every request.
 */
export const suspendOrganization = (
  state: OrganizationState,
  reason: string,
  ctx: ActorContext,
): OrganizationResult => {
  const principal = requireOwnMember(state, ctx, "suspend", "suspended");
  if (state.status !== "Active") {
    throw new InvalidTransitionError("Organization", state.status, "SuspendOrganization", [
      "Active",
    ]);
  }
  const explanation = requireReason(reason, "A suspension reason is required.");

  const version = (state.version + 1) as AggregateVersion;
  return {
    state: { ...state, status: "Suspended", suspendedAt: ctx.now, version },
    events: stampOrganization(version, [
      {
        type: "OrganizationSuspended",
        organizationId: state.organizationId,
        reason: explanation,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId as MembershipId,
      },
    ]),
  };
};

/**
 * Return a suspended Organization to service.
 *
 * `suspendedAt` is cleared, because it describes a suspension that is over. The
 * `OrganizationSuspended` event remains the durable record that it happened —
 * the column is current state, not history.
 *
 * "At least one valid active Owner" is a rule about Memberships, which this
 * Aggregate cannot see. The Application Layer enforces it, as it does the Last
 * Owner Invariant.
 */
export const reactivateOrganization = (
  state: OrganizationState,
  reason: string,
  ctx: ActorContext,
): OrganizationResult => {
  const principal = requireOwnMember(state, ctx, "reactivate", "reactivated");
  if (state.status !== "Suspended") {
    throw new InvalidTransitionError(
      "Organization",
      state.status,
      "ReactivateOrganization",
      ["Suspended"],
    );
  }
  const explanation = requireReason(reason, "A reactivation reason is required.");

  const version = (state.version + 1) as AggregateVersion;
  return {
    state: { ...state, status: "Active", suspendedAt: null, version },
    events: stampOrganization(version, [
      {
        type: "OrganizationReactivated",
        organizationId: state.organizationId,
        reason: explanation,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId as MembershipId,
      },
    ]),
  };
};

/**
 * Archive an Organization, permanently.
 *
 * Reachable from `Active` and from `Suspended`: an Owner who paused their
 * Organization and then decided to close it should not have to reactivate it
 * first, and "Organization not already Archived" is the only precondition the
 * document states.
 *
 * There is no way back — "An Archived Organization does not return to Active in
 * the MVP" — which is why the reactivation route's exemption covers `Suspended`
 * alone.
 *
 * The rule that no Work may remain `InProgress` or `WaitingForDecision` is
 * enforced by the Application Layer. It spans Aggregates, and an Organization
 * that loaded every Work to answer it would be the boundary violation this file
 * exists to avoid.
 */
export const archiveOrganization = (
  state: OrganizationState,
  reason: string,
  ctx: ActorContext,
): OrganizationResult => {
  const principal = requireOwnMember(state, ctx, "archive", "archived");
  if (state.status === "Archived") {
    throw new InvalidTransitionError("Organization", state.status, "ArchiveOrganization", [
      "Active",
      "Suspended",
    ]);
  }
  const explanation = requireReason(reason, "An archival reason is required.");

  const version = (state.version + 1) as AggregateVersion;
  return {
    state: { ...state, status: "Archived", archivedAt: ctx.now, version },
    events: stampOrganization(version, [
      {
        type: "OrganizationArchived",
        organizationId: state.organizationId,
        reason: explanation,
        occurredAt: ctx.now,
        actorIdentityId: principal.identityId,
        actorMembershipId: principal.membershipId as MembershipId,
      },
    ]),
  };
};
