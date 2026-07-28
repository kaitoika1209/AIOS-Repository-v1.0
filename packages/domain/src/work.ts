/**
 * The Work Aggregate.
 *
 * Implements `docs/architecture/state-machines/work.md` and
 * `docs/architecture/aggregates/work.md`.
 *
 * Framework-free by ADR-0001 and coding-standards.md: no ORM, no HTTP, no
 * clock, no id generation. Time and identifiers are supplied by the caller so
 * the Aggregate stays deterministic and testable.
 *
 * Commands return a new `Work` plus the events they emit. The Aggregate never
 * mutates in place and never loads another Aggregate — the completion gate is
 * the only knowledge it holds about a Decision.
 */

import type {
  AggregateVersion,
  DecisionId,
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  WorkStatus,
} from "@aios/types";
import { isHumanMember, type Principal } from "@aios/types";

import {
  type BlockingReference,
  type CompletionGate,
  gateNotRequired,
  isPending,
  permitsCompletion,
  referencesMatch,
} from "./completion-gate.js";
import {
  CrossOrganizationError,
  DomainError,
  HumanAuthorityRequiredError,
  InvalidTransitionError,
  ValidationError,
} from "./errors.js";
import { stampWork, type WorkEvent } from "./events.js";

export interface WorkState {
  readonly workId: WorkId;
  readonly organizationId: OrganizationId;
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkStatus;
  readonly completionGate: CompletionGate;
  readonly blockingReference: BlockingReference | null;
  readonly createdByIdentityId: IdentityId;
  readonly createdByMembershipId: MembershipId;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly completedByIdentityId: IdentityId | null;
  readonly completedByMembershipId: MembershipId | null;
  readonly completionSummary: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelledByIdentityId: IdentityId | null;
  readonly cancelledByMembershipId: MembershipId | null;
  readonly cancellationReason: string | null;
  readonly version: AggregateVersion;
}

export interface CommandResult<TState, TEvent> {
  readonly state: TState;
  readonly events: readonly TEvent[];
}

/** Context every command carries: who is acting, and when. */
export interface ActorContext {
  readonly principal: Principal;
  readonly now: Date;
}

const MAX_TITLE = 200;

const requireHuman = (
  { principal }: ActorContext,
  command: string,
): { identityId: IdentityId; membershipId: MembershipId } => {
  if (!isHumanMember(principal)) {
    throw new HumanAuthorityRequiredError(command, principal.type);
  }
  return {
    identityId: principal.identityId,
    membershipId: principal.membershipId,
  };
};

const requireSameOrganization = (
  work: WorkState,
  ctx: ActorContext,
  subject: string,
): void => {
  const actual =
    "organizationId" in ctx.principal ? ctx.principal.organizationId : undefined;
  if (actual !== work.organizationId) {
    throw new CrossOrganizationError(
      work.organizationId,
      String(actual),
      subject,
    );
  }
};

const requireStatus = (
  work: WorkState,
  command: string,
  allowed: readonly WorkStatus[],
): void => {
  if (!allowed.includes(work.status)) {
    throw new InvalidTransitionError("Work", work.status, command, allowed);
  }
};

const nextVersion = (v: AggregateVersion): AggregateVersion =>
  (v + 1) as AggregateVersion;

const validateTitle = (title: string): string => {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("Work title is required.", { field: "title" });
  }
  if (trimmed.length > MAX_TITLE) {
    throw new ValidationError(`Work title exceeds ${MAX_TITLE} characters.`, {
      field: "title",
      max: MAX_TITLE,
    });
  }
  return trimmed;
};

export interface CreateWorkInput {
  readonly workId: WorkId;
  readonly organizationId: OrganizationId;
  readonly title: string;
  readonly description?: string | null;
}

/** Create Work. Draft is the only entry state. */
export const createWork = (
  input: CreateWorkInput,
  ctx: ActorContext,
): CommandResult<WorkState, WorkEvent> => {
  const actor = requireHuman(ctx, "work.create");
  if (
    isHumanMember(ctx.principal) &&
    ctx.principal.organizationId !== input.organizationId
  ) {
    throw new CrossOrganizationError(
      input.organizationId,
      ctx.principal.organizationId,
      "Work",
    );
  }

  const title = validateTitle(input.title);
  const state: WorkState = {
    workId: input.workId,
    organizationId: input.organizationId,
    title,
    description: input.description?.trim() || null,
    status: "Draft",
    completionGate: gateNotRequired(),
    blockingReference: null,
    createdByIdentityId: actor.identityId,
    createdByMembershipId: actor.membershipId,
    startedAt: null,
    completedAt: null,
    completedByIdentityId: null,
    completedByMembershipId: null,
    completionSummary: null,
    cancelledAt: null,
    cancelledByIdentityId: null,
    cancelledByMembershipId: null,
    cancellationReason: null,
    version: 1 as AggregateVersion,
  };

  return {
    state,
    events: stampWork(state.version, [
      {
        type: "WorkCreated",
        workId: state.workId,
        title: state.title,
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/** Start Work. `startedAt` is set once and can never change afterwards. */
export const startWork = (
  work: WorkState,
  ctx: ActorContext,
): CommandResult<WorkState, WorkEvent> => {
  const actor = requireHuman(ctx, "work.start");
  requireSameOrganization(work, ctx, "Work");
  requireStatus(work, "work.start", ["Draft"]);

  const state: WorkState = {
    ...work,
    status: "InProgress",
    startedAt: ctx.now,
    version: nextVersion(work.version),
  };

  return {
    state,
    events: stampWork(state.version, [
      {
        type: "WorkStarted",
        workId: work.workId,
        organizationId: work.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/**
 * Request a blocking Decision.
 *
 * The caller must already have submitted the Decision revision through the
 * coordinated use case (ADR-0007), which is why a complete reference is
 * required rather than just a `decisionId`. A Draft Decision never blocks Work.
 */
export const requestBlockingDecision = (
  work: WorkState,
  reference: BlockingReference,
  ctx: ActorContext,
): CommandResult<WorkState, WorkEvent> => {
  const actor = requireHuman(ctx, "work.request_decision");
  requireSameOrganization(work, ctx, "Work");
  requireStatus(work, "work.request_decision", ["InProgress"]);

  if (work.blockingReference !== null) {
    throw new DomainError(
      "WORK_BLOCKING_DECISION_EXISTS",
      "An unresolved blocking Decision already exists for this Work.",
      { existing: work.blockingReference },
    );
  }

  const state: WorkState = {
    ...work,
    status: "WaitingForDecision",
    blockingReference: reference,
    completionGate: { kind: "Pending", reference },
    version: nextVersion(work.version),
  };

  return {
    state,
    events: stampWork(state.version, [
      {
        type: "WorkDecisionRequested",
        workId: work.workId,
        decisionId: reference.decisionId,
        revisionNumber: reference.revisionNumber,
        submittedSnapshotId: reference.submittedSnapshotId,
        organizationId: work.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/**
 * Record an authoritative Decision outcome.
 *
 * Returns Work to `InProgress` regardless of outcome. Returning to InProgress
 * does not imply the Work may be completed — that is the gate's job.
 *
 * Applied by a System Principal processing a Decision event, so this command
 * deliberately does not require a Human principal. The originating human actor
 * travels in the event.
 */
export const recordDecisionOutcome = (
  work: WorkState,
  input: {
    readonly reference: BlockingReference;
    readonly outcome: "Approved" | "Rejected" | "Withdrawn";
    readonly resolvedByIdentityId: IdentityId;
    readonly resolvedByMembershipId: MembershipId;
  },
  ctx: ActorContext,
): CommandResult<WorkState, WorkEvent> => {
  requireStatus(work, "work.record_decision_outcome", ["WaitingForDecision"]);

  if (!isPending(work.completionGate)) {
    throw new DomainError(
      "WORK_COMPLETION_GATE_UNSATISFIED",
      "The completion gate is not Pending.",
      { gate: work.completionGate.kind },
    );
  }

  if (!referencesMatch(work.completionGate.reference, input.reference)) {
    throw new DomainError(
      "WORK_BLOCKING_REFERENCE_MISMATCH",
      "The outcome does not match the active blocking reference.",
      { expected: work.completionGate.reference, received: input.reference },
    );
  }

  const gate: CompletionGate =
    input.outcome === "Approved"
      ? {
          kind: "Satisfied",
          reference: input.reference,
          approvedAt: ctx.now,
          approvedBy: input.resolvedByIdentityId,
        }
      : {
          kind: "Unsatisfied",
          reference: input.reference,
          outcome: input.outcome,
          resolvedAt: ctx.now,
          resolvedBy: input.resolvedByIdentityId,
        };

  const state: WorkState = {
    ...work,
    status: "InProgress",
    blockingReference: null,
    completionGate: gate,
    version: nextVersion(work.version),
  };

  return {
    state,
    events: stampWork(state.version, [
      {
        type: "WorkDecisionOutcomeRecorded",
        workId: work.workId,
        decisionId: input.reference.decisionId,
        revisionNumber: input.reference.revisionNumber,
        submittedSnapshotId: input.reference.submittedSnapshotId,
        outcome: input.outcome,
        organizationId: work.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: input.resolvedByIdentityId,
        actorMembershipId: input.resolvedByMembershipId,
      },
    ]),
  };
};

/**
 * Complete Work.
 *
 * Completion is always explicit. An approved Decision satisfies the gate; it
 * never completes the Work by itself.
 */
export const completeWork = (
  work: WorkState,
  completionSummary: string,
  ctx: ActorContext,
): CommandResult<WorkState, WorkEvent> => {
  const actor = requireHuman(ctx, "work.complete");
  requireSameOrganization(work, ctx, "Work");
  requireStatus(work, "work.complete", ["InProgress"]);

  if (work.blockingReference !== null) {
    throw new DomainError(
      "WORK_BLOCKING_DECISION_EXISTS",
      "Work cannot be completed while a blocking Decision is pending.",
      { blockingReference: work.blockingReference },
    );
  }

  if (!permitsCompletion(work.completionGate)) {
    throw new DomainError(
      "WORK_COMPLETION_GATE_UNSATISFIED",
      "The completion gate requires an approved Decision.",
      { gate: work.completionGate },
    );
  }

  const summary = completionSummary.trim();
  if (summary.length === 0) {
    throw new ValidationError("A completion summary is required.", {
      field: "completionSummary",
    });
  }

  const state: WorkState = {
    ...work,
    status: "Completed",
    completedAt: ctx.now,
    completedByIdentityId: actor.identityId,
    completedByMembershipId: actor.membershipId,
    completionSummary: summary,
    version: nextVersion(work.version),
  };

  return {
    state,
    events: stampWork(state.version, [
      {
        type: "WorkCompleted",
        workId: work.workId,
        completionSummary: summary,
        organizationId: work.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/** Cancel Work. Permitted from any non-terminal state. */
export const cancelWork = (
  work: WorkState,
  reason: string,
  ctx: ActorContext,
): CommandResult<WorkState, WorkEvent> => {
  const actor = requireHuman(ctx, "work.cancel");
  requireSameOrganization(work, ctx, "Work");
  requireStatus(work, "work.cancel", [
    "Draft",
    "InProgress",
    "WaitingForDecision",
  ]);

  const state: WorkState = {
    ...work,
    status: "Cancelled",
    blockingReference: null,
    cancelledAt: ctx.now,
    cancelledByIdentityId: actor.identityId,
    cancelledByMembershipId: actor.membershipId,
    cancellationReason: reason.trim(),
    version: nextVersion(work.version),
  };

  return {
    state,
    events: stampWork(state.version, [
      {
        type: "WorkCancelled",
        workId: work.workId,
        reason: reason.trim(),
        organizationId: work.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/** Edit Work content. Terminal states make business content immutable. */
export const editWork = (
  work: WorkState,
  changes: { readonly title?: string; readonly description?: string | null },
  ctx: ActorContext,
): CommandResult<WorkState, WorkEvent> => {
  requireHuman(ctx, "work.edit");
  requireSameOrganization(work, ctx, "Work");
  requireStatus(work, "work.edit", ["Draft", "InProgress", "WaitingForDecision"]);

  const state: WorkState = {
    ...work,
    title: changes.title === undefined ? work.title : validateTitle(changes.title),
    description:
      changes.description === undefined
        ? work.description
        : changes.description?.trim() || null,
    version: nextVersion(work.version),
  };

  return { state, events: [] };
};
