/**
 * Permission evaluation.
 *
 * `docs/architecture/authorization.md` defines the model this implements:
 * default-deny, Organization-scoped, roles narrowed by resource relationships,
 * and Human-only authority for approval and completion.
 *
 * `docs/engineering/review-checklist.md` and authorization.md both forbid role
 * checks in Application Services. Services ask for a *permission*; the mapping
 * from roles to permissions lives here alone.
 */

import {
  isHumanMember,
  isHumanOnlyPermission,
  type Permission,
  type Principal,
  type Role,
} from "@aios/types";

/**
 * Role to permission mapping, derived from the "Recommended MVP mapping" table
 * in authorization.md.
 *
 * `Member` receives the ordinary work permissions; approval permissions are not
 * granted automatically. `Reviewer` receives review authority only.
 *
 * Every role can read the member list — knowing who is in your Organization is
 * not administration. Inviting, resending, and revoking are Owner and Admin
 * only, which is the "Full / Limited / None / None" row in the document.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OrganizationOwner: [
    "organization.read_members",
    "organization.invite_member",
    "organization.resend_invitation",
    "organization.revoke_invitation",
    "organization.suspend_member",
    "organization.reactivate_member",
    "organization.revoke_member",
    "work.create",
    "work.edit",
    "work.start",
    "work.assign",
    "work.record_progress",
    "work.request_decision",
    "work.complete",
    "work.cancel",
    "decision.create",
    "decision.edit_draft",
    "decision.submit",
    "decision.approve",
    "decision.reject",
    "decision.withdraw",
    "decision.start_revision",
    "memory.edit_generated",
    "memory.submit",
    "memory.approve",
    "memory.reject",
    "memory.reopen",
    "events.inspect_failed",
    "events.retry",
    "events.skip",
    "events.replay_domain_consumer",
    "events.replay_projection",
  ],
  OrganizationAdmin: [
    "organization.read_members",
    "organization.invite_member",
    "organization.resend_invitation",
    "organization.revoke_invitation",
    "organization.suspend_member",
    "organization.reactivate_member",
    "organization.revoke_member",
    "work.create",
    "work.edit",
    "work.start",
    "work.assign",
    "work.record_progress",
    "work.request_decision",
    "work.complete",
    "work.cancel",
    "decision.create",
    "decision.edit_draft",
    "decision.submit",
    "decision.start_revision",
    "memory.edit_generated",
    "memory.submit",
    "events.inspect_failed",
    "events.retry",
    "events.skip",
    // `events.replay_domain_consumer` is absent deliberately. The Consumer
    // Recovery Permission Matrix gives it to the Owner and denies it to the
    // Admin "unless explicit Organization policy grants it" — and per-Organization
    // policy does not exist in this release, so the default is deny.
    "events.replay_projection",
  ],
  Member: [
    "organization.read_members",
    "work.create",
    "work.edit",
    "work.start",
    // "Work assignment | ... | Limited" for a Member, not "None". The limit is
    // the required relationship, not the permission: `AssignMember` needs
    // Creator, Admin, or Owner, so a Member may assign the Work they created and
    // no other. Granting the permission without enforcing step 6 would turn
    // "Limited" into Organization-wide, which is why this row was previously
    // withheld — the narrowing it depends on did not exist yet.
    "work.assign",
    "work.record_progress",
    "work.request_decision",
    "work.complete",
    "decision.create",
    "decision.edit_draft",
    "decision.submit",
    "decision.start_revision",
    "memory.edit_generated",
    "memory.submit",
  ],
  Reviewer: [
    "organization.read_members",
    "decision.approve",
    "decision.reject",
    "decision.withdraw",
    "memory.approve",
    "memory.reject",
  ],
};

/**
 * Refused at some step of the policy evaluation algorithm.
 *
 * The algorithm has eight steps and any of them can deny. Callers and the HTTP
 * filter care that access was refused, not which step refused it — the reason
 * belongs in the server log, never in the response.
 */
export abstract class AccessDeniedError extends Error {
  readonly code = "PERMISSION_DENIED" as const;
}

export class AuthorizationError extends AccessDeniedError {
  readonly permission: Permission;

  constructor(permission: Permission) {
    super(`Permission denied: ${permission}.`);
    this.name = "AuthorizationError";
    this.permission = permission;
  }
}

/**
 * Step 6: "require resource relationship when applicable".
 *
 * Distinct from `AuthorizationError` because the two say different things about
 * the actor. Holding the permission and lacking the relationship means the role
 * is right and the actor is a stranger to this particular resource; the reverse
 * means the role is wrong everywhere. Both are `403`, and the response body is
 * identical, but the log can tell them apart.
 */
export class RelationshipRequiredError extends AccessDeniedError {
  constructor(resource: string, required: readonly string[]) {
    super(`Requires one of ${required.join(", ")} on the ${resource}.`);
    this.name = "RelationshipRequiredError";
  }
}

/**
 * Whether the principal holds Organization-wide administrative authority.
 *
 * The one place a role is read outside `hasPermission`, and it is here rather
 * than in the relationship module for the same reason: authorization.md and the
 * review checklist both forbid Application Services from inspecting roles, so
 * every role read stays in this file.
 *
 * "Administrative Override" makes this a relationship rather than a permission:
 * Owner and Admin "may receive broader resource access", still bounded by the
 * Organization, the principal type, and the Aggregate's own invariants.
 */
export const isAdministrator = (principal: Principal): boolean =>
  isHumanMember(principal) &&
  principal.roles.some(
    (role) => role === "OrganizationOwner" || role === "OrganizationAdmin",
  );

/**
 * Whether a principal holds a permission.
 *
 * Default-deny at every step. A non-Human principal is refused any Human-only
 * permission before roles are consulted at all, because an AI Principal must
 * never acquire Human business authority through a role.
 */
export const hasPermission = (
  principal: Principal,
  permission: Permission,
): boolean => {
  if (!isHumanMember(principal)) {
    return false;
  }
  if (isHumanOnlyPermission(permission) && !isHumanMember(principal)) {
    return false;
  }
  return principal.roles.some((role) =>
    ROLE_PERMISSIONS[role].includes(permission),
  );
};

export const requirePermission = (
  principal: Principal,
  permission: Permission,
): void => {
  if (!hasPermission(principal, permission)) {
    throw new AuthorizationError(permission);
  }
};

/** Exposed for the drift test that compares this mapping to the document. */
export const rolePermissions = ROLE_PERMISSIONS;
