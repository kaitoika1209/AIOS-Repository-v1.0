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

import { isHumanMember, type DecisionId, type OrganizationId, type WorkId } from "@aios/types";
import {
  ValidationError,
  approveDecision,
  createDecision,
  currentRevision,
  rejectDecision,
  recordDecisionOutcome,
  requestBlockingDecision,
  startRevision,
  submitForReview,
  submittedRevision,
  withdrawDecision,
  type DecisionOption,
  type DecisionState,
  type WorkState,
  updateDraft,
} from "@aios/domain";

import {
  AssistanceNotGrantedError,
  DECISION_PORT_CONTRACT_VERSION,
  findGrantSpec,
  type DecisionAssistanceProvider,
  type SecretaryContribution,
} from "./assistance.js";
import { recordTransition } from "./audit.js";
import { requirePermission } from "./authorization.js";
import {
  requireDecisionRelationship,
  requireWorkRelationship,
} from "./relationships.js";
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


/**
 * Record a Decision lifecycle transition.
 *
 * See `auditWorkTransition`: the edge records the decision, the use case records
 * what changed.
 */
const auditDecisionTransition = (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  before: { status: string },
  after: { status: string },
  resourceId: string,
  permission: string,
  commandType: string,
): void => {
  if (before.status === after.status) return;
  recordTransition(deps.audit, {
    organizationId: ctx.organizationId,
    identityId: isHumanMember(ctx.principal) ? ctx.principal.identityId : null,
    membershipId: isHumanMember(ctx.principal) ? ctx.principal.membershipId : null,
    commandType,
    permission,
    resourceType: "Decision",
    resourceId,
    previousState: before.status,
    nextState: after.status,
    now: ctx.now,
  });
};

export const createDecisionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: {
    readonly relatedWorkId: WorkId;
    readonly title: string;
    readonly question: string;
    readonly context?: string | null;
    readonly options?: readonly DecisionOption[];
    readonly isBlocking?: boolean;
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
        revisionId: deps.ids.revisionId(),
        title: input.title,
        question: input.question,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.isBlocking === undefined ? {} : { isBlocking: input.isBlocking }),
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
/**
 * Edit the Draft revision's content.
 *
 * Only a Draft revision is editable. A submitted revision is what a reviewer
 * evaluated and what Work's completion gate points at, so changing it would
 * rewrite the evidence rather than the proposal.
 */
export const editDecisionDraftUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  decisionId: DecisionId,
  changes: Parameters<typeof updateDraft>[1],
  /**
   * A Secretary contribution this edit adopts, recorded for traceability.
   *
   * Optional, and it grants nothing: the content written is whatever the Human
   * put in `changes`. "Adoption does not update the contribution into an
   * authoritative state automatically. The Human executes a Decision Aggregate
   * edit command" — this is that command, and the flag only records that it
   * happened.
   */
  adoptedContributionId?: string | undefined,
): Promise<DecisionState> => {
  requirePermission(ctx.principal, "decision.edit_draft");

  return deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    // "EditDraft | Creator, Contributor, or Admin".
    requireDecisionRelationship(ctx.principal, current, [
      "Creator",
      "Contributor",
      "Administrator",
    ]);
    const { state, events } = updateDraft(current, changes, ctx);

    await tx.decisions.update(state, current.version);
    await tx.outbox.append(events);

    if (adoptedContributionId !== undefined && isHumanMember(ctx.principal)) {
      // In the same transaction as the edit: an adoption recorded without the
      // edit landing would claim a Human took content they never wrote.
      await tx.contributions.markAdopted({
        organizationId: ctx.organizationId,
        decisionId,
        contributionId: adoptedContributionId,
        adoptedByIdentityId: ctx.principal.identityId,
        now: ctx.now,
      });
    }

    return state;
  });
};

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

    // "SubmitForReview | Creator, Contributor, or Admin".
    requireDecisionRelationship(ctx.principal, currentDecision, [
      "Creator",
      "Contributor",
      "Administrator",
    ]);

    // "RequestBlockingDecision | Assignee, Creator, or Admin" — on the Work,
    // which is the resource whose lifecycle this blocks. The Decision half of
    // the command carries its own permission but no Work relationship.
    requireWorkRelationship(ctx.principal, currentWork, [
      "Assignee",
      "Creator",
      "Administrator",
    ]);

    const submitted = submitForReview(currentDecision, ctx);

    const blocked = requestBlockingDecision(
      currentWork,
      {
        decisionId: submitted.state.decisionId,
        revisionNumber: submittedRevision(submitted.state)!.revisionNumber,
        submittedSnapshotId: submitted.state.submittedRevisionId!,
      },
      ctx,
    );

    await tx.decisions.update(submitted.state, currentDecision.version);
    await tx.work.update(blocked.state, currentWork.version);
    await tx.outbox.append([...submitted.events, ...blocked.events]);

    // ADR-0007's atomic activation changes two Aggregates, so it records two
    // transitions. One row naming both would lose which state belonged to which.
    auditDecisionTransition(
      deps, ctx, currentDecision, submitted.state, decisionId,
      "decision.submit", "SubmitForReview",
    );
    recordTransition(deps.audit, {
      organizationId: ctx.organizationId,
      identityId: isHumanMember(ctx.principal) ? ctx.principal.identityId : null,
      membershipId: isHumanMember(ctx.principal) ? ctx.principal.membershipId : null,
      commandType: "RequestBlockingDecision",
      permission: "work.request_decision",
      resourceType: "Work",
      resourceId: currentWork.workId,
      previousState: currentWork.status,
      nextState: blocked.state.status,
      now: ctx.now,
    });

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
    auditDecisionTransition(deps, ctx, current, state, decisionId, "decision.approve", "ApproveDecision");
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
    auditDecisionTransition(deps, ctx, current, state, decisionId, "decision.reject", "RejectDecision");
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
    auditDecisionTransition(deps, ctx, current, state, decisionId, "decision.withdraw", "WithdrawDecision");
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
    // "StartRevision | Creator, Contributor, or Admin".
    requireDecisionRelationship(ctx.principal, current, [
      "Creator",
      "Contributor",
      "Administrator",
    ]);
    const { state } = startRevision(current, deps.ids.revisionId(), ctx);

    await tx.decisions.update(state, current.version);
    auditDecisionTransition(
      deps, ctx, current, state, decisionId,
      "decision.start_revision", "StartRevision",
    );
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
    // Recorded under the System Principal that applied it, not under the human
    // who resolved the Decision: this row says when the Work's gate actually
    // moved, which is a later and separately observable moment. The human's
    // authority is already recorded on the Decision's own row.
    recordTransition(deps.audit, {
      organizationId: input.organizationId,
      identityId: null,
      membershipId: null,
      commandType: "RecordDecisionOutcome",
      permission: "work.record_decision_outcome",
      resourceType: "Work",
      resourceId: input.workId,
      previousState: current.status,
      nextState: state.status,
      now: ctx.now,
    });
    return state;
  });

/** Decisions attached to one Work, Organization-scoped. */
export const listDecisionsForWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
): Promise<readonly DecisionState[]> =>
  deps.uow.transaction((tx) => tx.decisions.listByWork(ctx.organizationId, workId));


/**
 * Ask the Secretary to draft Decision material.
 *
 * The generation half of ADR-0011's two-command rule. It produces an advisory
 * contribution and changes no authoritative content — the Decision is not
 * touched, and the draft reaches the proposal only if a Human edits it in.
 *
 * Four gates, in order, and each one is the ADR's:
 *
 * 1. the initiating Human holds `decision.record_secretary_contribution`;
 * 2. they hold a relationship to this Decision (step 6);
 * 3. the operation is one this build declares — an unknown one fails closed
 *    before the provider is reached; and
 * 4. an active grant authorizes it for this Organization and Secretary.
 */
export const requestDecisionMaterialUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  provider: DecisionAssistanceProvider,
  decisionId: DecisionId,
): Promise<SecretaryContribution> => {
  requirePermission(ctx.principal, "decision.record_secretary_contribution");
  const principal = ctx.principal;
  if (!isHumanMember(principal)) {
    // "an authenticated initiating Human command" — there is no Secretary
    // output that nobody asked for.
    throw new AssistanceNotGrantedError("Assistance requires a Human Member.");
  }

  const spec = findGrantSpec("Decision", "decision.draft_material");
  if (spec === null) {
    throw new AssistanceNotGrantedError("Unknown assistance operation.");
  }

  // Read and gate before the provider call, so an unauthorized request costs
  // nothing and leaks nothing.
  const { decision, request } = await deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    requireDecisionRelationship(ctx.principal, current, [
      "Creator",
      "Contributor",
      "Administrator",
    ]);

    const granted = await tx.assistanceGrants.isGranted({
      organizationId: ctx.organizationId,
      secretaryPrincipalId: provider.secretaryPrincipalId,
      contextKey: spec.contextKey,
      assistanceOperation: spec.assistanceOperation,
      portContractVersion: DECISION_PORT_CONTRACT_VERSION,
    });
    if (!granted) {
      throw new AssistanceNotGrantedError(
        "No active assistance grant authorizes this operation.",
      );
    }

    const revision = currentRevision(current);
    if (revision === null) {
      throw new ValidationError("The Decision has no Draft revision to assist with.");
    }

    return {
      decision: current,
      revision,
      // "the minimum permitted source data": the question, its context, and the
      // options. Not the review history, not the actor, not identifiers the
      // provider could use to ask for more.
      request: {
        question: revision.question,
        context: revision.context,
        options: revision.options.map((o) => ({
          optionId: o.optionId,
          summary: o.summary,
        })),
      },
    };
  });

  const draft = await provider.draftMaterial(request);

  const content = draft.content.trim();
  if (content.length === 0) {
    // Validation belongs to the owning context, not the provider. An empty
    // draft is a failed assistance attempt, not a contribution.
    throw new ValidationError("The Secretary returned no material.");
  }

  const contributionId = deps.ids.contributionId();

  return deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    const revision = currentRevision(current);
    if (revision === null) {
      throw new ValidationError("The Decision has no Draft revision to assist with.");
    }

    await tx.contributions.append({
      contributionId,
      organizationId: ctx.organizationId,
      decisionId,
      decisionRevisionId: revision.revisionId,
      secretaryPrincipalId: provider.secretaryPrincipalId,
      requestedByIdentityId: principal.identityId,
      requestedByMembershipId: principal.membershipId,
      contributionType: spec.contributionType,
      content,
      generationId: deps.ids.generationId(),
      now: ctx.now,
    });

    void decision;
    return {
      contributionId,
      decisionId,
      decisionRevisionId: revision.revisionId,
      secretaryPrincipalId: provider.secretaryPrincipalId,
      requestedByMembershipId: principal.membershipId,
      contributionType: spec.contributionType,
      content,
      createdAt: ctx.now,
      adoptedAt: null,
      adoptedByIdentityId: null,
    };
  });
};

export const listDecisionContributionsUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  decisionId: DecisionId,
): Promise<readonly SecretaryContribution[]> => {
  requirePermission(ctx.principal, "decision.record_secretary_contribution");
  return deps.uow.transaction(async (tx) => {
    const current = await loadDecision(tx, ctx.organizationId, decisionId);
    requireDecisionRelationship(ctx.principal, current, [
      "Creator",
      "Contributor",
      "Administrator",
    ]);
    return tx.contributions.listForDecision(ctx.organizationId, decisionId);
  });
};
