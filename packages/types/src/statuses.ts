/**
 * Lifecycle status values.
 *
 * Every value here is normative and traceable to a state machine document. Do
 * not add a value without changing the corresponding document first — the
 * documents are authoritative, this file is a projection of them.
 */

/** `docs/architecture/identity-and-organization.md` — Organization Status. */
export const ORGANIZATION_STATUSES = ["Active", "Suspended", "Archived"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** `docs/architecture/identity-and-organization.md` — Human Identity Status. */
export const IDENTITY_STATUSES = ["Active", "Disabled"] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/** `docs/architecture/identity-and-organization.md` — Membership Status. */
export const MEMBERSHIP_STATUSES = [
  "Invited",
  "Active",
  "Suspended",
  "Revoked",
] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * `docs/architecture/persistence-and-data-model.md` — Invitation Status Values.
 *
 * Separate from {@link MembershipStatus}: one Membership may carry several
 * invitations over time (a resend supersedes its predecessor), and the
 * invitation's own lifecycle is what the token is checked against.
 *
 * `Expired` is derived. `expires_at` is the authority, so an invitation past its
 * expiry is refused whether or not anything has materialized the status.
 */
export const INVITATION_STATUSES = [
  "Pending",
  "Consumed",
  "Revoked",
  "Expired",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** `docs/architecture/state-machines/work.md` — State Summary. */
export const WORK_STATUSES = [
  "Draft",
  "InProgress",
  "WaitingForDecision",
  "Completed",
  "Cancelled",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** `docs/architecture/state-machines/decision.md` — State Summary. */
export const DECISION_STATUSES = [
  "Draft",
  "InReview",
  "Approved",
  "Rejected",
  "Withdrawn",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/**
 * `docs/architecture/state-machines/memory.md` — State Summary.
 *
 * This is the *business review* lifecycle only.
 */
export const MEMORY_STATUSES = [
  "Generated",
  "InReview",
  "Rejected",
  "Approved",
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/**
 * `docs/architecture/state-machines/memory.md` — generation operation states.
 *
 * Deliberately a separate type from {@link MemoryStatus}. `Generated` appears in
 * both, and the state machine document requires that they never share one enum:
 * this describes an application process, not the review lifecycle.
 */
export const GENERATION_OPERATION_STATUSES = [
  "Pending",
  "Generating",
  "RetryPending",
  "Generated",
  "Failed",
  "Abandoned",
] as const;
export type GenerationOperationStatus =
  (typeof GENERATION_OPERATION_STATUSES)[number];

/** Terminal states, per each state machine's "Terminal" column. */
export const TERMINAL_WORK_STATUSES = ["Completed", "Cancelled"] as const;
export const TERMINAL_DECISION_STATUSES = ["Approved", "Withdrawn"] as const;
export const TERMINAL_MEMORY_STATUSES = ["Approved"] as const;
