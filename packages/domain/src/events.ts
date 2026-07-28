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
  OrganizationId,
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
  /** The Human Identity whose authority produced this event. */
  readonly actorIdentityId: IdentityId;
  readonly actorMembershipId: MembershipId;
}

export interface WorkCreated extends DomainEventBase {
  readonly type: "WorkCreated";
  readonly workId: WorkId;
  readonly title: string;
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

export type WorkEvent =
  | WorkCreated
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

export type DomainEvent = WorkEvent | DecisionEvent;

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
