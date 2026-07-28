/**
 * Decision use cases, including the two places Work and Decision must be
 * coordinated (ADR-0007).
 *
 * ADR-0007 splits coordination deliberately:
 *
 * - **Atomic activation.** Submitting a blocking Decision and moving the Work
 *   to `WaitingForDecision` happen in one transaction, so a committed state
 *   where Work waits for a revision that was never submitted is impossible.
 * - **Asynchronous outcome.** Approval resolves only the Decision. The Work
 *   completion gate is updated afterwards from the authoritative Decision
 *   event, not inside the reviewer's transaction.
 */

import type { DecisionId, OrganizationId, WorkId } from "@aios/types";
import {
  approveDecision,
  createDecision,
  rejectDecision,
  recordDecisionOutcome,
  requestBlockingDecision,
  startRevision,
  submitForReview,
  withdrawDecision,
  type DecisionOption,
  type DecisionState,
  type WorkState,
} from "@aios/domain";

import { requirePermission } from "./authorization.js";
import {
  NotFoundError,
  type RepositoryBundle,
  type UseCaseDependencies,
} from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

const loadDecision = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
  decisionId: DecisionId,
): Promise<DecisionState> => {
  const decision = await tx.decisions.findById(organizationId, decisionId);
  if (decision === null) {
    throw new NotFoundError("Decision");
  }
  return decision;
};

const loadWork = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
  workId: WorkId,
): Promise<WorkState> => {
  const work = await tx.work.findById(organizationId, workId);
  if (work === null) {
    throw new NotFoundError("Work");
  }
  return work;
};

export const createDecisionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: {
    readonly relatedWorkId: WorkId;
    readonly question: string;
    readonly context?: string | null;
    readonly options?: readonly DecisionOption[];
  },
): Promise<DecisionState> => {
  requirePermission(ctx.principal, "decision.create");

  return deps.uow.transaction(async (tx) => {
    // Confirms the Work exists in this Organization before attaching to it.
    await loadWork(tx, ctx.organizationId, input.relatedWorkId);

    const { state, events } = createDecision(
      {
        decisionId: deps.ids.decisionId(),
        organizationId: ctx.organizationId,
        relatedWorkId: input.relatedWorkId,
        question: input.question,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.options === undefined ? {} : { options: input.options }),
      },
      ctx,
    );

    await tx.decisions.insert(state);
    await tx.outbox.append(events);
    return state;
  });
};

/**
 * Submit a Decision for review and block the related Work atomically.
 *
 * Both Aggregates change in one transaction. ADR-0007 permits this single
 * exception to one-Aggregate-per-transaction because the alternative allows two
 * invalid committed states: Work waiting on a revision that does not exist, or
 * a submitted blocking revision the Work does not know about.
 */
export const submitBlockingDecisionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  decisionId: DecisionId,
): Promise<{ decision: DecisionState; work: WorkState }> => {
  requirePermission(ctx.principal, "decision.submit");
  requirePermission(ctx.principal, "work.request_decision");

  return deps.uow.transaction(async (tx) => {
    const currentDecision = await loadDecision(tx, ctx.organizationId, decisionId);
    const currentWork = await loadWork(
      tx,
      ctx.organizationId,
      currentDecision.relatedWorkId,
    );

    const submitted = submitForReview(currentDecision, deps.ids.snapshotId(), ctx);

    const blocked = requestBlockingDecision(
      currentWork,
      {
        decisionId: submitted.state.decisionId,
        revisionNumber: submitted.state.revisionNumber,
        submittedSnapshotId: submitted.state.submittedSnapshotId!,
      },
      ctx,
    );

    await tx.decisions.update(submitted.state, currentDecision.version);
    await tx.work.update(blocked.state, currentWork.version);
    await tx.outbox.append([...submitted.events, ...blocked.events]);

    return { decision: submitted.state, work: blocked.state };
  });
};

export const approveDecisionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  decisionId: DecisionId,
  input: { readonly selectedOptionId: string; readonly rationale: string },
): Promise<DecisionState> => {
  requirePermission(ctx.principal, "decision.approve");

  return deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    const { state, events } = approveDecision(current, input, ctx);

    await tx.decisions.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const rejectDecisionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  decisionId: DecisionId,
  rationale: string,
): Promise<DecisionState> => {
  requirePermission(ctx.principal, "decision.reject");

  return deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    const { state, events } = rejectDecision(current, rationale, ctx);

    await tx.decisions.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const withdrawDecisionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  decisionId: DecisionId,
  reason: string,
): Promise<DecisionState> => {
  requirePermission(ctx.principal, "decision.withdraw");

  return deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    const { state, events } = withdrawDecision(current, reason, ctx);

    await tx.decisions.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const startRevisionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  decisionId: DecisionId,
): Promise<DecisionState> => {
  requirePermission(ctx.principal, "decision.start_revision");

  return deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    const { state } = startRevision(current, ctx);

    await tx.decisions.update(state, current.version);
    return state;
  });
};

/**
 * Project a resolved Decision onto the Work completion gate.
 *
 * Runs in the consumer that handles `DecisionApproved`, `DecisionRejected`, and
 * `DecisionWithdrawn` — not in the reviewer's request. The acting principal is
 * a System Principal carrying the originating human actor forward, which is why
 * no permission check applies: the authority was already exercised when the
 * human resolved the Decision.
 *
 * Delivery is at-least-once (ADR-0006). A redelivery arrives when the Work has
 * already left `WaitingForDecision`, and the Aggregate rejects it; callers treat
 * that as already-applied rather than as a failure.
 */
export const applyDecisionOutcomeUseCase = async (
  deps: UseCaseDependencies,
  ctx: { readonly principal: WorkCommandContext["principal"]; readonly now: Date },
  input: {
    readonly organizationId: OrganizationId;
    readonly workId: WorkId;
    readonly decisionId: DecisionId;
    readonly revisionNumber: number;
    readonly submittedSnapshotId: string;
    readonly outcome: "Approved" | "Rejected" | "Withdrawn";
    readonly resolvedByIdentityId: Parameters<
      typeof recordDecisionOutcome
    >[1]["resolvedByIdentityId"];
    readonly resolvedByMembershipId: Parameters<
      typeof recordDecisionOutcome
    >[1]["resolvedByMembershipId"];
  },
): Promise<WorkState> =>
  deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, input.organizationId, input.workId);

    const { state, events } = recordDecisionOutcome(
      current,
      {
        reference: {
          decisionId: input.decisionId,
          revisionNumber: input.revisionNumber,
          submittedSnapshotId: input.submittedSnapshotId,
        },
        outcome: input.outcome,
        resolvedByIdentityId: input.resolvedByIdentityId,
        resolvedByMembershipId: input.resolvedByMembershipId,
      },
      ctx,
    );

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
