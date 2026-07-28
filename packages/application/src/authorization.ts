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
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OrganizationOwner: [
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
    "events.replay_domain_consumer",
    "events.replay_projection",
  ],
  Member: [
    "work.create",
    "work.edit",
    "work.start",
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
    "decision.approve",
    "decision.reject",
    "decision.withdraw",
    "memory.approve",
    "memory.reject",
  ],
};

export class AuthorizationError extends Error {
  readonly code = "PERMISSION_DENIED" as const;
  readonly permission: Permission;

  constructor(permission: Permission) {
    super(`Permission denied: ${permission}.`);
    this.name = "AuthorizationError";
    this.permission = permission;
  }
}

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
