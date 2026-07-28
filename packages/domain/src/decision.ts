/**
 * The Decision Aggregate.
 *
 * Implements `docs/architecture/state-machines/decision.md` and
 * `docs/architecture/aggregates/decision.md`.
 *
 * Revisions are child entities, not root fields. That is the point of the
 * model: a revision becomes immutable when it leaves Draft, so starting a new
 * revision after a rejection preserves the rejected content as evidence rather
 * than overwriting it. The state machine is explicit that a new revision "does
 * not erase or rewrite the rejected revision".
 *
 * The Decision knows nothing about Work status, the completion gate, Memory, or
 * Knowledge. Coordination happens in the Application Layer through events.
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
import { isHumanMember } from "@aios/types";

import {
  CrossOrganizationError,
  DomainError,
  HumanAuthorityRequiredError,
  InvalidTransitionError,
  ValidationError,
} from "./errors.js";
import { stampDecision, type DecisionEvent } from "./events.js";
import type { ActorContext, CommandResult } from "./work.js";

export interface DecisionOption {
  readonly optionId: string;
  readonly summary: string;
}

/** `docs/architecture/persistence-and-data-model.md` — Decision Revision Status. */
export type RevisionStatus =
  | "Draft"
  | "Submitted"
  | "Approved"
  | "Rejected"
  | "Withdrawn";

/**
 * One editable proposal.
 *
 * Immutable once `status` leaves `Draft`. The repository must not issue content
 * updates for a non-Draft revision, and the aggregate refuses them here.
 */
export interface DecisionRevision {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly status: RevisionStatus;
  readonly title: string;
  readonly question: string;
  readonly context: string | null;
  readonly options: readonly DecisionOption[];
  readonly rationale: string | null;
  readonly createdByIdentityId: IdentityId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: Date;
}

/** The outcomes a review may produce. */
export type DecisionResolutionOutcome = "Approved" | "Rejected" | "Withdrawn";

/** Append-only review evidence. Never overwritten. */
export interface DecisionReviewRecord {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly outcome: DecisionResolutionOutcome;
  readonly reviewedByIdentityId: IdentityId;
  readonly reviewedByMembershipId: MembershipId;
  readonly reviewedAt: Date;
  readonly rationale: string;
  readonly selectedOptionId: string | null;
}

export interface DecisionState {
  readonly decisionId: DecisionId;
  readonly organizationId: OrganizationId;
  /** Immutable external identifier. Not a reference to a loaded Work object. */
  readonly relatedWorkId: WorkId;
  readonly isBlocking: boolean;
  readonly status: DecisionStatus;
  readonly revisions: readonly DecisionRevision[];
  /** The Draft revision, when one exists. Only one may exist at a time. */
  readonly currentRevisionId: string | null;
  /**
   * The submitted revision. This is the value Work stores as
   * `submittedSnapshotId` in its completion gate.
   */
  readonly submittedRevisionId: string | null;
  readonly decidedRevisionId: string | null;
  readonly reviewRecords: readonly DecisionReviewRecord[];
  readonly createdByIdentityId: IdentityId;
  readonly createdByMembershipId: MembershipId;
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
    throw new InvalidTransitionError("Decision", decision.status, command, allowed);
  }
};

const nextVersion = (v: AggregateVersion): AggregateVersion =>
  (v + 1) as AggregateVersion;

/** The Draft revision. Absent whenever the Decision is not editable. */
export const currentRevision = (d: DecisionState): DecisionRevision | null =>
  d.revisions.find((r) => r.revisionId === d.currentRevisionId) ?? null;

export const submittedRevision = (d: DecisionState): DecisionRevision | null =>
  d.revisions.find((r) => r.revisionId === d.submittedRevisionId) ?? null;

export const revisionByNumber = (
  d: DecisionState,
  revisionNumber: number,
): DecisionRevision | null =>
  d.revisions.find((r) => r.revisionNumber === revisionNumber) ?? null;

const replaceRevision = (
  revisions: readonly DecisionRevision[],
  updated: DecisionRevision,
): readonly DecisionRevision[] =>
  revisions.map((r) => (r.revisionId === updated.revisionId ? updated : r));

const requireDraftRevision = (
  decision: DecisionState,
  command: string,
): DecisionRevision => {
  const revision = currentRevision(decision);
  if (revision === null || revision.status !== "Draft") {
    throw new DomainError(
      "DECISION_INVALID_TRANSITION",
      "The Decision has no editable Draft revision.",
      { decisionId: decision.decisionId, command },
    );
  }
  return revision;
};

const validateOptions = (options: readonly DecisionOption[]): void => {
  if (options.length === 0) {
    throw new ValidationError(
      "A Decision must offer at least one option before review.",
      { field: "options" },
    );
  }
  const ids = options.map((o) => o.optionId);
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError("Duplicate option identity.", { field: "options" });
  }
};

export interface CreateDecisionInput {
  readonly decisionId: DecisionId;
  readonly organizationId: OrganizationId;
  readonly relatedWorkId: WorkId;
  readonly revisionId: string;
  readonly title: string;
  readonly question: string;
  readonly context?: string | null;
  readonly options?: readonly DecisionOption[];
  readonly isBlocking?: boolean;
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

  const revision: DecisionRevision = {
    revisionId: input.revisionId,
    revisionNumber: 1,
    status: "Draft",
    title: input.title.trim(),
    question,
    context: input.context?.trim() || null,
    options: input.options ?? [],
    rationale: null,
    createdByIdentityId: actor.identityId,
    createdByMembershipId: actor.membershipId,
    createdAt: ctx.now,
  };

  const state: DecisionState = {
    decisionId: input.decisionId,
    organizationId: input.organizationId,
    relatedWorkId: input.relatedWorkId,
    isBlocking: input.isBlocking ?? false,
    status: "Draft",
    revisions: [revision],
    currentRevisionId: revision.revisionId,
    submittedRevisionId: null,
    decidedRevisionId: null,
    reviewRecords: [],
    createdByIdentityId: actor.identityId,
    createdByMembershipId: actor.membershipId,
    version: 1 as AggregateVersion,
  };

  return {
    state,
    events: stampDecision(state.version, [
      {
        type: "DecisionCreated",
        decisionId: state.decisionId,
        relatedWorkId: state.relatedWorkId,
        question,
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/** Edit the Draft revision. Only Draft content is editable. */
export const updateDraft = (
  decision: DecisionState,
  changes: {
    readonly title?: string;
    readonly question?: string;
    readonly context?: string | null;
    readonly options?: readonly DecisionOption[];
    readonly rationale?: string | null;
  },
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  requireHuman(ctx, "decision.edit_draft");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.edit_draft", ["Draft"]);

  const revision = requireDraftRevision(decision, "decision.edit_draft");

  if (changes.options !== undefined) {
    const ids = changes.options.map((o) => o.optionId);
    if (new Set(ids).size !== ids.length) {
      throw new ValidationError("Duplicate option identity.", { field: "options" });
    }
  }

  const updated: DecisionRevision = {
    ...revision,
    title: changes.title === undefined ? revision.title : changes.title.trim(),
    question:
      changes.question === undefined ? revision.question : changes.question.trim(),
    context:
      changes.context === undefined
        ? revision.context
        : changes.context?.trim() || null,
    options: changes.options ?? revision.options,
    rationale:
      changes.rationale === undefined
        ? revision.rationale
        : changes.rationale?.trim() || null,
  };

  return {
    state: {
      ...decision,
      revisions: replaceRevision(decision.revisions, updated),
      version: nextVersion(decision.version),
    },
    events: [],
  };
};

/**
 * Submit for review.
 *
 * Locks the Draft revision by moving it to `Submitted`, which makes it
 * immutable and turns it into the reviewable snapshot. Its `revisionId` is what
 * Work stores as `submittedSnapshotId`.
 */
export const submitForReview = (
  decision: DecisionState,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.submit");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.submit", ["Draft"]);

  const revision = requireDraftRevision(decision, "decision.submit");
  validateOptions(revision.options);

  const submitted: DecisionRevision = { ...revision, status: "Submitted" };

  return {
    state: {
      ...decision,
      status: "InReview",
      revisions: replaceRevision(decision.revisions, submitted),
      currentRevisionId: null,
      submittedRevisionId: submitted.revisionId,
      version: nextVersion(decision.version),
    },
    events: stampDecision(nextVersion(decision.version), [
      {
        type: "DecisionSubmitted",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: submitted.revisionNumber,
        submittedSnapshotId: submitted.revisionId,
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

const resolve = (
  decision: DecisionState,
  ctx: ActorContext,
  command: string,
  outcome: "Approved" | "Rejected" | "Withdrawn",
  rationale: string,
  selectedOptionId: string | null,
): { state: DecisionState; revision: DecisionRevision; actorId: IdentityId } => {
  const actor = requireHuman(ctx, command);
  requireSameOrganization(decision, ctx);

  const revision = submittedRevision(decision);
  if (revision === null) {
    throw new DomainError(
      "DECISION_INVALID_TRANSITION",
      "The Decision has no submitted revision.",
      { decisionId: decision.decisionId },
    );
  }

  const resolved: DecisionRevision = { ...revision, status: outcome };
  const record: DecisionReviewRecord = {
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    outcome,
    reviewedByIdentityId: actor.identityId,
    reviewedByMembershipId: actor.membershipId,
    reviewedAt: ctx.now,
    rationale: rationale.trim(),
    selectedOptionId,
  };

  return {
    state: {
      ...decision,
      status: outcome,
      revisions: replaceRevision(decision.revisions, resolved),
      submittedRevisionId: null,
      decidedRevisionId: revision.revisionId,
      reviewRecords: [...decision.reviewRecords, record],
      version: nextVersion(decision.version),
    },
    revision,
    actorId: actor.identityId,
  };
};

/** Approve. Human-only, and terminal. */
export const approveDecision = (
  decision: DecisionState,
  input: { readonly selectedOptionId: string; readonly rationale: string },
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  requireStatus(decision, "decision.approve", ["InReview"]);

  const revision = submittedRevision(decision);
  if (revision !== null && !revision.options.some((o) => o.optionId === input.selectedOptionId)) {
    throw new ValidationError(
      "The selected option is not part of the submitted revision.",
      { field: "selectedOptionId", selectedOptionId: input.selectedOptionId },
    );
  }

  const resolved = resolve(
    decision,
    ctx,
    "decision.approve",
    "Approved",
    input.rationale,
    input.selectedOptionId,
  );

  return {
    state: resolved.state,
    events: stampDecision(resolved.state.version, [
      {
        type: "DecisionApproved",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: resolved.revision.revisionNumber,
        submittedSnapshotId: resolved.revision.revisionId,
        selectedOptionId: input.selectedOptionId,
        rationale: input.rationale.trim(),
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: resolved.actorId,
        actorMembershipId: (ctx.principal as { membershipId: MembershipId }).membershipId,
      },
    ]),
  };
};

/** Reject. Human-only. Non-terminal: a new revision may follow. */
export const rejectDecision = (
  decision: DecisionState,
  rationale: string,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  requireStatus(decision, "decision.reject", ["InReview"]);

  const resolved = resolve(
    decision,
    ctx,
    "decision.reject",
    "Rejected",
    rationale,
    null,
  );

  return {
    state: resolved.state,
    events: stampDecision(resolved.state.version, [
      {
        type: "DecisionRejected",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: resolved.revision.revisionNumber,
        submittedSnapshotId: resolved.revision.revisionId,
        rationale: rationale.trim(),
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: resolved.actorId,
        actorMembershipId: (ctx.principal as { membershipId: MembershipId }).membershipId,
      },
    ]),
  };
};

/**
 * Withdraw. Permitted from Draft or InReview. Terminal.
 *
 * The state machine lists Withdrawn as terminal in three places; the aggregate
 * document previously contradicted that with a `Withdrawn -> StartRevision`
 * lifecycle test, which has been corrected.
 */
export const withdrawDecision = (
  decision: DecisionState,
  reason: string,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.withdraw");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.withdraw", ["Draft", "InReview"]);

  const revision = submittedRevision(decision) ?? currentRevision(decision);
  if (revision === null) {
    throw new DomainError(
      "DECISION_INVALID_TRANSITION",
      "The Decision has no revision to withdraw.",
      { decisionId: decision.decisionId },
    );
  }

  const withdrawn: DecisionRevision = { ...revision, status: "Withdrawn" };

  return {
    state: {
      ...decision,
      status: "Withdrawn",
      revisions: replaceRevision(decision.revisions, withdrawn),
      currentRevisionId: null,
      submittedRevisionId: null,
      decidedRevisionId: revision.revisionId,
      reviewRecords: [
        ...decision.reviewRecords,
        {
          revisionId: revision.revisionId,
          revisionNumber: revision.revisionNumber,
          outcome: "Withdrawn",
          reviewedByIdentityId: actor.identityId,
          reviewedByMembershipId: actor.membershipId,
          reviewedAt: ctx.now,
          rationale: reason.trim(),
          selectedOptionId: null,
        },
      ],
      version: nextVersion(decision.version),
    },
    events: stampDecision(nextVersion(decision.version), [
      {
        type: "DecisionWithdrawn",
        decisionId: decision.decisionId,
        relatedWorkId: decision.relatedWorkId,
        revisionNumber: revision.revisionNumber,
        submittedSnapshotId: decision.submittedRevisionId,
        reason: reason.trim(),
        organizationId: decision.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/**
 * Start a new revision of a rejected Decision.
 *
 * Copies the rejected revision's content into a **new** revision rather than
 * reopening it. The rejected revision stays immutable, which is what preserves
 * it as evidence.
 */
export const startRevision = (
  decision: DecisionState,
  revisionId: string,
  ctx: ActorContext,
): CommandResult<DecisionState, DecisionEvent> => {
  const actor = requireHuman(ctx, "decision.start_revision");
  requireSameOrganization(decision, ctx);
  requireStatus(decision, "decision.start_revision", ["Rejected"]);

  const previous =
    decision.revisions.find((r) => r.revisionId === decision.decidedRevisionId) ??
    decision.revisions[decision.revisions.length - 1];

  if (previous === undefined) {
    throw new DomainError(
      "DECISION_INVALID_TRANSITION",
      "The Decision has no revision to base a new revision on.",
      { decisionId: decision.decisionId },
    );
  }

  const next: DecisionRevision = {
    revisionId,
    revisionNumber: previous.revisionNumber + 1,
    status: "Draft",
    title: previous.title,
    question: previous.question,
    context: previous.context,
    options: previous.options,
    rationale: previous.rationale,
    createdByIdentityId: actor.identityId,
    createdByMembershipId: actor.membershipId,
    createdAt: ctx.now,
  };

  return {
    state: {
      ...decision,
      status: "Draft",
      revisions: [...decision.revisions, next],
      currentRevisionId: next.revisionId,
      submittedRevisionId: null,
      decidedRevisionId: null,
      version: nextVersion(decision.version),
    },
    events: [],
  };
};
