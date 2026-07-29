/**
 * Domain events emitted by the Work and Decision Aggregates.
 *
 * Every event here is registered in the MVP catalogue. Future event names must
 * not appear (ADR-0010). In particular `MemoryGenerationRequested` and
 * `MemoryGenerationFailed` are deliberately absent: both state machine and
 * events documents state they are not registered events, and generation
 * operation state is the authoritative process evidence instead.
 *
 * Events are recorded by the Aggregate and published through the Transactional
 * Outbox in the same transaction as the state change (ADR-0006).
 */

import type {
  DecisionId,
  IdentityId,
  MembershipId,
  MemoryId,
  OrganizationId,
  Role,
  WorkId,
} from "@aios/types";

export interface DomainEventBase {
  readonly organizationId: OrganizationId;
  /**
   * The Aggregate version this event was produced at.
   *
   * Required on every domain event, and part of the Outbox stream-position
   * uniqueness constraint. Consumers use it to reject an older version after a
   * newer one has already been applied.
   */
  readonly aggregateVersion: number;
  readonly occurredAt: Date;
  /** The Identity whose authority produced this event. */
  readonly actorIdentityId: IdentityId;
  /**
   * Null when the actor holds no Membership in this Organization.
   *
   * Two cases produce it: an AI or System Principal, which never holds one
   * (Memory generation); and a human accepting an invitation, who does not hold
   * one *yet* — the Membership that acceptance activates is named in the event
   * payload instead.
   */
  readonly actorMembershipId: MembershipId | null;
}

export interface WorkCreated extends DomainEventBase {
  readonly type: "WorkCreated";
  readonly workId: WorkId;
  readonly title: string;
}

/**
 * The Work's own details changed.
 *
 * Carries the title but not the description: consumers use this to keep a
 * listing readable, and the description can be long. A consumer that needs the
 * full content reads the Aggregate.
 */
export interface WorkDetailsUpdated extends DomainEventBase {
  readonly type: "WorkDetailsUpdated";
  readonly workId: WorkId;
  readonly title: string;
}

/**
 * The Work's assignee changed.
 *
 * Carries the resulting assignee rather than a verb, so an unassignment is the
 * same event with `assigneeMembershipId: null`. A consumer that keeps a
 * "my work" listing applies one rule instead of two.
 */
export interface WorkAssignmentChanged extends DomainEventBase {
  readonly type: "WorkAssignmentChanged";
  readonly workId: WorkId;
  readonly assigneeMembershipId: MembershipId | null;
  readonly previousAssigneeMembershipId: MembershipId | null;
}

/**
 * A participant was added or removed.
 *
 * One event per Member changed, not one per command: the aggregate version is
 * shared, and `event_sequence` distinguishes them within it.
 */
export interface WorkParticipantChanged extends DomainEventBase {
  readonly type: "WorkParticipantChanged";
  readonly workId: WorkId;
  readonly membershipId: MembershipId;
  readonly change: "Added" | "Removed";
}

/**
 * An attributable progress update was appended.
 *
 * Carries no content. Progress text is free-form business detail, and the
 * events document keeps payloads to what a consumer needs to route on; a
 * consumer that needs the text reads the record.
 */
export interface WorkProgressRecorded extends DomainEventBase {
  readonly type: "WorkProgressRecorded";
  readonly workId: WorkId;
  readonly progressRecordId: string;
}

export interface WorkStarted extends DomainEventBase {
  readonly type: "WorkStarted";
  readonly workId: WorkId;
}

export interface WorkDecisionRequested extends DomainEventBase {
  readonly type: "WorkDecisionRequested";
  readonly workId: WorkId;
  readonly decisionId: DecisionId;
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string;
}

export interface WorkDecisionOutcomeRecorded extends DomainEventBase {
  readonly type: "WorkDecisionOutcomeRecorded";
  readonly workId: WorkId;
  readonly decisionId: DecisionId;
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string;
  readonly outcome: "Approved" | "Rejected" | "Withdrawn";
}

/** The durable trigger for Memory generation (ADR-0008). */
export interface WorkCompleted extends DomainEventBase {
  readonly type: "WorkCompleted";
  readonly workId: WorkId;
  readonly completionSummary: string;
}

export interface WorkCancelled extends DomainEventBase {
  readonly type: "WorkCancelled";
  readonly workId: WorkId;
  readonly reason: string;
}

export interface DecisionCreated extends DomainEventBase {
  readonly type: "DecisionCreated";
  readonly decisionId: DecisionId;
  readonly relatedWorkId: WorkId;
  readonly question: string;
}

export interface DecisionSubmitted extends DomainEventBase {
  readonly type: "DecisionSubmitted";
  readonly decisionId: DecisionId;
  readonly relatedWorkId: WorkId;
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string;
}

export interface DecisionApproved extends DomainEventBase {
  readonly type: "DecisionApproved";
  readonly decisionId: DecisionId;
  readonly relatedWorkId: WorkId;
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string;
  readonly selectedOptionId: string;
  readonly rationale: string;
}

export interface DecisionRejected extends DomainEventBase {
  readonly type: "DecisionRejected";
  readonly decisionId: DecisionId;
  readonly relatedWorkId: WorkId;
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string;
  readonly rationale: string;
}

export interface DecisionWithdrawn extends DomainEventBase {
  readonly type: "DecisionWithdrawn";
  readonly decisionId: DecisionId;
  readonly relatedWorkId: WorkId;
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string | null;
  readonly reason: string;
}

export interface MemoryGenerated extends DomainEventBase {
  readonly type: "MemoryGenerated";
  readonly memoryId: MemoryId;
  readonly sourceWorkId: WorkId;
}

export interface MemorySubmittedForReview extends DomainEventBase {
  readonly type: "MemorySubmittedForReview";
  readonly memoryId: MemoryId;
  readonly sourceWorkId: WorkId;
  readonly revisionNumber: number;
}

export interface MemoryApproved extends DomainEventBase {
  readonly type: "MemoryApproved";
  readonly memoryId: MemoryId;
  readonly sourceWorkId: WorkId;
  readonly revisionNumber: number;
}

export interface MemoryRejected extends DomainEventBase {
  readonly type: "MemoryRejected";
  readonly memoryId: MemoryId;
  readonly sourceWorkId: WorkId;
  readonly revisionNumber: number;
}

export type MemoryEvent =
  | MemoryGenerated
  | MemorySubmittedForReview
  | MemoryApproved
  | MemoryRejected;

/**
 * Membership events.
 *
 * The registered subset confirmed by `identity-and-organization.md`. There is no
 * event for issuing or reissuing a token: a resend changes no Membership fact,
 * and revoking an invitation reaches `Revoked` and so emits `MembershipRevoked`
 * with a reason, exactly as revoking an active Membership does.
 *
 * `MembershipSuspended` and `MembershipReactivated` carry a reason for the same
 * purpose the revocation reason serves: a Member whose authority was removed is
 * entitled to a record of why, and an administrator reviewing the history needs
 * one that does not depend on remembering.
 */
export interface MembershipInvited extends DomainEventBase {
  readonly type: "MembershipInvited";
  readonly membershipId: MembershipId;
  /**
   * The address the invitation was sent to. Delivery metadata, not identity —
   * the Membership carries no `identityId` until acceptance binds one.
   */
  readonly inviteeEmail: string;
  readonly initialRoles: readonly Role[];
  readonly expiresAt: Date;
}

export interface MembershipActivated extends DomainEventBase {
  readonly type: "MembershipActivated";
  readonly membershipId: MembershipId;
  readonly identityId: IdentityId;
  readonly initialRoles: readonly Role[];
}

/**
 * Authority in one Organization was temporarily removed.
 *
 * Carries `identityId` non-null: only an Active Membership can be suspended,
 * and an Active Membership always has one. Suspension is the reversible half of
 * removal — "role assignments remain stored but inactive for authorization".
 */
export interface MembershipSuspended extends DomainEventBase {
  readonly type: "MembershipSuspended";
  readonly membershipId: MembershipId;
  readonly identityId: IdentityId;
  readonly reason: string;
}

export interface MembershipReactivated extends DomainEventBase {
  readonly type: "MembershipReactivated";
  readonly membershipId: MembershipId;
  readonly identityId: IdentityId;
  readonly reason: string;
}

export interface MembershipRevoked extends DomainEventBase {
  readonly type: "MembershipRevoked";
  readonly membershipId: MembershipId;
  /** Null when the invitation was revoked before anyone accepted it. */
  readonly identityId: IdentityId | null;
  readonly reason: string;
}

/**
 * Organization events.
 *
 * The registered subset this release emits. `OrganizationSuspended`,
 * `OrganizationReactivated`, and `OrganizationArchived` are registered names
 * with no command in this release — mvp.md requires creation, naming, and basic
 * settings, and says "Deleting an Organization and long-term retention policy
 * are not required for the first release".
 */
export interface OrganizationCreated extends DomainEventBase {
  readonly type: "OrganizationCreated";
  readonly name: string;
}

export interface OrganizationRenamed extends DomainEventBase {
  readonly type: "OrganizationRenamed";
  readonly name: string;
}

export type OrganizationEvent = OrganizationCreated | OrganizationRenamed;

export type MembershipEvent =
  | MembershipInvited
  | MembershipActivated
  | MembershipSuspended
  | MembershipReactivated
  | MembershipRevoked;

export type WorkEvent =
  | WorkCreated
  | WorkDetailsUpdated
  | WorkAssignmentChanged
  | WorkParticipantChanged
  | WorkProgressRecorded
  | WorkStarted
  | WorkDecisionRequested
  | WorkDecisionOutcomeRecorded
  | WorkCompleted
  | WorkCancelled;

export type DecisionEvent =
  | DecisionCreated
  | DecisionSubmitted
  | DecisionApproved
  | DecisionRejected
  | DecisionWithdrawn;

export type DomainEvent =
  | WorkEvent
  | DecisionEvent
  | MemoryEvent
  | MembershipEvent
  | OrganizationEvent;

/**
 * Outcome-bearing Decision events, which the Application Layer projects onto
 * the Work completion gate. Work never reads the Decision Aggregate directly.
 */
export const DECISION_OUTCOME_EVENTS = [
  "DecisionApproved",
  "DecisionRejected",
  "DecisionWithdrawn",
] as const;

export type DecisionOutcomeEventType = (typeof DECISION_OUTCOME_EVENTS)[number];

/**
 * Stamp a command's events with the version the Aggregate reached.
 *
 * Every event from one command shares that version; `event_sequence`
 * distinguishes them within it.
 */
type Unstamped<T> = T extends unknown ? Omit<T, "aggregateVersion"> : never;

const withVersion = <T>(aggregateVersion: number, events: readonly Unstamped<T>[]) =>
  events.map((event) => ({ ...event, aggregateVersion }) as unknown as T);

/** Stamp a Work command's events with the version the Aggregate reached. */
export const stampWork = (
  aggregateVersion: number,
  events: readonly Unstamped<WorkEvent>[],
): readonly WorkEvent[] => withVersion<WorkEvent>(aggregateVersion, events);

/** Stamp a Decision command's events with the version the Aggregate reached. */
export const stampDecision = (
  aggregateVersion: number,
  events: readonly Unstamped<DecisionEvent>[],
): readonly DecisionEvent[] => withVersion<DecisionEvent>(aggregateVersion, events);

/** Stamp a Memory command's events with the version the Aggregate reached. */
export const stampMemory = (
  aggregateVersion: number,
  events: readonly Unstamped<MemoryEvent>[],
): readonly MemoryEvent[] => withVersion<MemoryEvent>(aggregateVersion, events);

/** Stamp an Organization command's events with the version the Aggregate reached. */
export const stampOrganization = (
  aggregateVersion: number,
  events: readonly Unstamped<OrganizationEvent>[],
): readonly OrganizationEvent[] =>
  withVersion<OrganizationEvent>(aggregateVersion, events);

/** Stamp a Membership command's events with the version the Aggregate reached. */
export const stampMembership = (
  aggregateVersion: number,
  events: readonly Unstamped<MembershipEvent>[],
): readonly MembershipEvent[] =>
  withVersion<MembershipEvent>(aggregateVersion, events);
