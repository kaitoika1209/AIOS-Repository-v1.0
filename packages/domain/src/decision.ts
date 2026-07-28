/**
 * The Decision Aggregate.
 *
 * Implements `docs/architecture/state-machines/decision.md` and
 * `docs/architecture/aggregates/decision.md`.
 *
 * The Decision is authoritative for its own content, revisions, review history,
 * and resolution. Work holds only a completion-gate snapshot derived from the
 * events emitted here (ADR-0007).
 *
 * Rejected is deliberately non-terminal: a rejected revision may begin a new
 * revision of the same organizational question. Approved and Withdrawn are
 * terminal.
 */

import type {
  AggregateVersion,
  DecisionId,
  DecisionStatus,
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
} from "@aios/types";
import { isHumanMember, type Principal } from "@aios/types";

import {
  CrossOrganizationError,
  DomainError,
  HumanAuthorityRequiredError,
  InvalidTransitionError,
  ValidationError,
} from "./errors.js";
import type { DecisionEvent } from "./events.js";
import type { ActorContext, CommandResult } from "./work.js";

export interface DecisionOption {
  readonly optionId: string;
  readonly summary: string;
}

export interface DecisionResolution {
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string;
  readonly outcome: "Approved" | "Rejected" | "Withdrawn";
  readonly resolvedByIdentityId: IdentityId;
  readonly resolvedAt: Date;
  readonly rationale: string;
  readonly selectedOptionId: string | null;
}

export interface DecisionState {
  readonly decisionId: DecisionId;
  readonly organizationId: OrganizationId;
  readonly relatedWorkId: WorkId;
  readonly question: string;
  readonly context: string | null;
  readonly options: readonly DecisionOption[];
  readonly status: DecisionStatus;
  readonly revisionNumber: number;
  /** Set when the current revision is submitted; identifies the locked draft. */
  readonly submittedSnapshotId: string | null;
  readonly createdByIdentityId: IdentityId;
  /** Every resolved revision, oldest first. A new revision never erases one. */
  readonly resolutions: readonly DecisionResolution[];
  readonly version: AggregateVersion;
}

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
  decision: DecisionState,
  ctx: ActorContext,
): void => {
  const actual =
    "organizationId" in ctx.principal ? ctx.principal.organizationId : undefined;
  if (actual !== decision.organizationId) {
    throw new CrossOrganizationError(
      decision.organizationId,
      String(actual),
      "Decision",
    );
  }
};

const requireStatus = (
  decision: DecisionState,
  command: string,
  allowed: readonly DecisionStatus[],
): void => {
  if (!allowed.includes(decision.status)) {
    throw new InvalidTransitionError(
      "Decision",
      decision.status,
      command,
      allowed,
    );
  }
};

const nextVersion = (v: AggregateVersion): AggregateVersion =>
  (v + 1) as AggregateVersion;

const requireSubmittedSnapshot = (decision: DecisionState): string => {
  if (decision.submittedSnapshotId === null) {
    throw new DomainError(
      "DECISION_INVALID_TRANSITION",
      "The Decision has no submitted revision snapshot.",
      { decisionId: decision.decisionId },
    );
  }
  return decision.submittedSnapshotId;
};

export interface CreateDecisionInput {
  readonly decisionId: DecisionId;
  readonly organizationId: OrganizationId;
  readonly relatedWorkId: WorkId;
  readonly question: string;
  readonly context?: string | null;
  readonly options?: readonly DecisionOption[];
}

export const createDecision = (
  input: CreateDecisionInput,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.create");
  if (
    isHumanMember(ctx.principal) &&
    ctx.principal.organizationId !== input.organizationId
  ) {
    throw new CrossOrganizationError(
      input.organizationId,
      ctx.principal.organizationId,
      "Decision",
    );
  }

  const question = input.question.trim();
  if (question.length === 0) {
    throw new ValidationError("A Decision question is required.", {
      field: "question",
    });
  }

  const state: DecisionState = {
    decisionId: input.decisionId,
    organizationId: input.organizationId,
    relatedWorkId: input.relatedWorkId,
    question,
    context: input.context?.trim() || null,
    options: input.options ?? [],
    status: "Draft",
    revisionNumber: 1,
    submittedSnapshotId: null,
    createdByIdentityId: actor.identityId,
    resolutions: [],
    version: 1 as AggregateVersion,
  };

  return {
    state,
    events: [
      {
        type: "DecisionCreated",
        decisionId: state.decisionId,
        relatedWorkId: state.relatedWorkId,
        question: state.question,
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ],
  };
};

/** Edit the draft. Only a Draft is editable; InReview is locked. */
export const updateDraft = (
  decision: DecisionState,
  changes: {
    readonly question?: string;
    readonly context?: string | null;
    readonly options?: readonly DecisionOption[];
  },
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  requireHuman(ctx, "decision.edit_draft");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.edit_draft", ["Draft"]);

  const state: DecisionState = {
    ...decision,
    question:
      changes.question === undefined ? decision.question : changes.question.trim(),
    context:
      changes.context === undefined ? decision.context : changes.context?.trim() || null,
    options: changes.options ?? decision.options,
    version: nextVersion(decision.version),
  };

  return { state, events: [] };
};

/**
 * Submit for review.
 *
 * Locks the draft and produces the `submittedSnapshotId` that Work stores in
 * its completion gate. The snapshot id is supplied by the caller so the
 * Aggregate stays free of id generation.
 */
export const submitForReview = (
  decision: DecisionState,
  submittedSnapshotId: string,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.submit");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.submit", ["Draft"]);

  if (decision.options.length === 0) {
    throw new ValidationError(
      "A Decision must offer at least one option before review.",
      { field: "options" },
    );
  }

  const state: DecisionState = {
    ...decision,
    status: "InReview",
    submittedSnapshotId,
    version: nextVersion(decision.version),
  };

  return {
    state,
    events: [
      {
        type: "DecisionSubmitted",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: decision.revisionNumber,
        submittedSnapshotId,
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ],
  };
};

/** Approve. Human-only, and terminal. */
export const approveDecision = (
  decision: DecisionState,
  input: { readonly selectedOptionId: string; readonly rationale: string },
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.approve");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.approve", ["InReview"]);

  const snapshotId = requireSubmittedSnapshot(decision);

  if (!decision.options.some((o) => o.optionId === input.selectedOptionId)) {
    throw new ValidationError(
      "The selected option is not part of the submitted revision.",
      { field: "selectedOptionId", selectedOptionId: input.selectedOptionId },
    );
  }

  const state: DecisionState = {
    ...decision,
    status: "Approved",
    resolutions: [
      ...decision.resolutions,
      {
        revisionNumber: decision.revisionNumber,
        submittedSnapshotId: snapshotId,
        outcome: "Approved",
        resolvedByIdentityId: actor.identityId,
        resolvedAt: ctx.now,
        rationale: input.rationale.trim(),
        selectedOptionId: input.selectedOptionId,
      },
    ],
    version: nextVersion(decision.version),
  };

  return {
    state,
    events: [
      {
        type: "DecisionApproved",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: decision.revisionNumber,
        submittedSnapshotId: snapshotId,
        selectedOptionId: input.selectedOptionId,
        rationale: input.rationale.trim(),
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ],
  };
};

/** Reject. Human-only. Non-terminal: a new revision may follow. */
export const rejectDecision = (
  decision: DecisionState,
  rationale: string,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.reject");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.reject", ["InReview"]);

  const snapshotId = requireSubmittedSnapshot(decision);

  const state: DecisionState = {
    ...decision,
    status: "Rejected",
    resolutions: [
      ...decision.resolutions,
      {
        revisionNumber: decision.revisionNumber,
        submittedSnapshotId: snapshotId,
        outcome: "Rejected",
        resolvedByIdentityId: actor.identityId,
        resolvedAt: ctx.now,
        rationale: rationale.trim(),
        selectedOptionId: null,
      },
    ],
    version: nextVersion(decision.version),
  };

  return {
    state,
    events: [
      {
        type: "DecisionRejected",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: decision.revisionNumber,
        submittedSnapshotId: snapshotId,
        rationale: rationale.trim(),
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ],
  };
};

/**
 * Start a new revision of a rejected Decision.
 *
 * Increments the revision number and clears the submitted snapshot, so a stale
 * reference can never satisfy a gate raised for the new revision. Prior
 * resolutions are preserved.
 */
export const startRevision = (
  decision: DecisionState,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  requireHuman(ctx, "decision.start_revision");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.start_revision", ["Rejected"]);

  const state: DecisionState = {
    ...decision,
    status: "Draft",
    revisionNumber: decision.revisionNumber + 1,
    submittedSnapshotId: null,
    version: nextVersion(decision.version),
  };

  return { state, events: [] };
};

/** Withdraw. Permitted from Draft or InReview. Terminal. */
export const withdrawDecision = (
  decision: DecisionState,
  reason: string,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.withdraw");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.withdraw", ["Draft", "InReview"]);

  const state: DecisionState = {
    ...decision,
    status: "Withdrawn",
    resolutions: [
      ...decision.resolutions,
      {
        revisionNumber: decision.revisionNumber,
        submittedSnapshotId: decision.submittedSnapshotId ?? "",
        outcome: "Withdrawn",
        resolvedByIdentityId: actor.identityId,
        resolvedAt: ctx.now,
        rationale: reason.trim(),
        selectedOptionId: null,
      },
    ],
    version: nextVersion(decision.version),
  };

  return {
    state,
    events: [
      {
        type: "DecisionWithdrawn",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: decision.revisionNumber,
        submittedSnapshotId: decision.submittedSnapshotId,
        reason: reason.trim(),
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ],
  };
};
