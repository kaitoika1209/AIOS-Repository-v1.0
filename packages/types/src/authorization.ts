/**
 * Roles and permissions.
 *
 * `PERMISSIONS` is the canonical catalogue from
 * `docs/architecture/authorization.md`. ADR-0014 requires it to stay one-to-one
 * with the route table, and the permission identifier is also the server-owned
 * `operation` value recorded for observability.
 *
 * `scripts/check_docs.py` verifies the documented catalogue against the
 * documented routes; `permissions.test.ts` verifies this file against the
 * document, so drift fails the build rather than reaching production.
 */

/** `docs/architecture/authorization.md` — Organization Roles. */
export const ROLES = [
  "OrganizationOwner",
  "OrganizationAdmin",
  "Member",
  "Reviewer",
] as const;
export type Role = (typeof ROLES)[number];

export const WORK_PERMISSIONS = [
  "work.create",
  "work.edit",
  "work.start",
  "work.assign",
  "work.record_progress",
  "work.request_decision",
  "work.complete",
  "work.cancel",
] as const;

export const DECISION_PERMISSIONS = [
  "decision.create",
  "decision.edit_draft",
  "decision.submit",
  "decision.approve",
  "decision.reject",
  "decision.withdraw",
  "decision.start_revision",
  "decision.record_secretary_contribution",
] as const;

export const MEMORY_PERMISSIONS = [
  "memory.edit_generated",
  "memory.submit",
  "memory.approve",
  "memory.reject",
  "memory.reopen",
] as const;

/**
 * Organization administration.
 *
 * One permission per command rather than a single `organization.manage_members`,
 * because ADR-0014's one-route-one-permission rule cannot hold otherwise.
 * Reading the member list is separated from administering it: every role holds
 * the former.
 */
export const ORGANIZATION_PERMISSIONS = [
  "notification.read",
  "notification.acknowledge",
  "organization.rename",
  // The Owner-held Organization lifecycle (ADR-0017).
  "organization.suspend",
  "organization.reactivate",
  "organization.archive",
  "organization.read_members",
  "organization.invite_member",
  "organization.resend_invitation",
  "organization.revoke_invitation",
  "organization.suspend_member",
  "organization.reactivate_member",
  "organization.revoke_member",
  // Role assignment (ADR-0018). Both are narrowed beyond the permission: the
  // target role decides who may act, and nobody may assign to themselves.
  "organization.assign_role",
  "organization.revoke_role",
  // Secretary assistance (ADR-0019). The request names an operation; the
  // context and contract version come from the registry, not the caller.
  "organization.grant_assistance",
  "organization.revoke_assistance",
] as const;

/** Operational recovery permissions, restricted to Owner and Admin. */
export const EVENT_PERMISSIONS = [
  "events.inspect_failed",
  "events.retry",
  "events.skip",
  "events.replay_domain_consumer",
  "events.replay_projection",
] as const;

/**
 * Operational observation and containment, restricted to Owner and Admin.
 *
 * Separate from `EVENT_PERMISSIONS` because those act on a specific failed
 * delivery and these act on the workflow as a whole — the reason ADR-0021
 * promoted the read rather than reusing `events.inspect_failed`.
 *
 * Pause and resume are two permissions rather than one (ADR-0022). Pausing stops
 * work; resuming asserts that whatever caused the pause is over. Only separate
 * permissions can express a future policy where an Admin may pause and an Owner
 * must resume.
 *
 * All three authorize an action **within the caller's own Organization**. Pausing
 * a Worker type for every Organization has no permission because the MVP models
 * no principal who could hold one; it is a deployment control instead.
 */
export const OPERATIONS_PERMISSIONS = [
  "operations.read_workflow_health",
  "operations.pause_worker",
  "operations.resume_worker",
] as const;

export const PERMISSIONS = [
  ...WORK_PERMISSIONS,
  ...DECISION_PERMISSIONS,
  ...MEMORY_PERMISSIONS,
  ...ORGANIZATION_PERMISSIONS,
  ...EVENT_PERMISSIONS,
  ...OPERATIONS_PERMISSIONS,
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions only a Human Member may hold.
 *
 * ADR-0011 and the Secretary boundary in `docs/product/mvp.md`: an AI Principal
 * can never approve, reject, or complete. Enforcement lives in the authorization
 * layer; this constant exists so the rule is testable rather than implicit.
 */
export const HUMAN_ONLY_PERMISSIONS = [
  "work.complete",
  "decision.approve",
  "decision.reject",
  "decision.withdraw",
  "memory.approve",
  "memory.reject",
] as const satisfies readonly Permission[];

export type HumanOnlyPermission = (typeof HUMAN_ONLY_PERMISSIONS)[number];

export const isHumanOnlyPermission = (
  permission: Permission,
): permission is HumanOnlyPermission =>
  (HUMAN_ONLY_PERMISSIONS as readonly Permission[]).includes(permission);
