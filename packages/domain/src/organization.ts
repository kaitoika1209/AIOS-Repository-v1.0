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
  const principal: Principal = ctx.principal;
  if (!isHumanMember(principal)) {
    throw new ValidationError("Only a Human Member may rename an Organization.");
  }
  if (principal.organizationId !== state.organizationId) {
    throw new ValidationError("An Organization may only be renamed by its own Member.");
  }
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
