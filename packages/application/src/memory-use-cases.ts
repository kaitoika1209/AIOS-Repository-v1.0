/**
 * Memory use cases.
 *
 * Two distinct halves:
 *
 * - **Generation** runs under a System Principal from the durable
 *   `WorkCompleted` trigger (ADR-0008). It carries no Human authority and
 *   produces a draft that is authoritative for nothing.
 * - **Review** is Human-only. Approval is what turns a draft into the
 *   organization's record of the completed Work.
 *
 * Memory generation is `ExternalComputation` (ADR-0004): the provider call has
 * no authoritative business effect and is safe to retry.
 */

import { isHumanMember, type MemoryId, type OrganizationId, type WorkId } from "@aios/types";
import {
  approveMemory,
  createGeneratedMemory,
  currentMemoryRevision,
  editGeneratedMemory,
  rejectMemory,
  reopenMemory,
  submitMemoryForReview,
  type ActorContext,
  type GeneratedContent,
  type MemoryState,
} from "@aios/domain";

import { recordTransition } from "./audit.js";
import { requirePermission } from "./authorization.js";
import { requireMemoryRelationship } from "./relationships.js";
import {
  buildProviderInput,
  canonicalize,
  providerInputHash,
  type ProviderInput,
} from "./generation-policy.js";
import { GenerationRejectedError, requireGrounded } from "./groundedness.js";
import {
  NotFoundError,
  type RepositoryBundle,
  type UseCaseDependencies,
} from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

/**
 * Produces the draft content for a completed Work.
 *
 * A provider-neutral port (ADR-0004, ADR-0011). The Secretary reaches the
 * provider through this and nothing else, and the implementation is chosen at
 * the edge — which is what lets a deterministic stub stand in for a model
 * without the domain or use cases knowing.
 */
export interface MemoryGenerator {
  readonly policyVersion: number;
  readonly promptTemplateVersion: number;
  readonly outputSchemaVersion: number;
  /** Recorded on the operation so a draft can be traced to what produced it. */
  readonly modelReference: string;
  /**
   * Produce candidate content from the canonical provider input.
   *
   * Takes `ProviderInput` rather than `WorkState` deliberately. The generation
   * policy limits what crosses this boundary — no identity references, no
   * fields the model has no use for — and passing the Aggregate would make that
   * limit a convention an adapter could quietly ignore.
   */
  generate(input: {
    readonly providerInput: ProviderInput;
    readonly providerInputHash: string;
  }): Promise<GeneratedContent>;
}

const loadMemory = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
  memoryId: MemoryId,
): Promise<MemoryState> => {
  const memory = await tx.memories.findById(organizationId, memoryId);
  if (memory === null) {
    throw new NotFoundError("Memory");
  }
  return memory;
};

export interface GenerateMemoryInput {
  readonly organizationId: OrganizationId;
  readonly workId: WorkId;
  /** The Outbox row that carried `WorkCompleted`. */
  readonly sourceEventId: string;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotHash: string;
  /** The Secretary credited as the author of the generated draft. */
  readonly secretaryIdentityId: Parameters<
    typeof createGeneratedMemory
  >[0]["generatedBy"];
  readonly systemPrincipalId: string;
  /** Identifies the worker holding the lease, for recovery diagnostics. */
  readonly workerId: string;
}

/** How long a claimed operation is owned before another worker may reclaim it. */
export const GENERATION_LEASE_MS = 5 * 60 * 1000;

/** Backoff before a retryable failure is attempted again. */
export const GENERATION_RETRY_DELAY_MS = 60 * 1000;

/**
 * Record a Memory lifecycle transition.
 *
 * See `auditWorkTransition`: the edge records the decision, the use case records
 * what changed.
 */
const auditMemoryTransition = (
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
    resourceType: "Memory",
    resourceId,
    previousState: before.status,
    nextState: after.status,
    now: ctx.now,
  });
};

/**
 * Generate the Memory for a completed Work.
 *
 * The ordering is ADR-0004's, not a convenience: the durable operation — with
 * its source snapshot and provider-input hash — **commits before the provider is
 * called**. A process that dies mid-call therefore leaves a claimable record of
 * what was attempted rather than nothing at all.
 *
 *     tx1: find existing Memory | build provider input | open and claim operation
 *          ↓ commit
 *     provider call, outside any transaction
 *          ↓
 *     tx2: create Memory and mark the operation Generated, together
 *
 * Idempotent at three levels, because at-least-once delivery means this runs
 * more than once for the same Work: an already-`Generated` operation returns its
 * linked Memory, an unclaimable operation means another worker owns the attempt,
 * and `uq_memories_active_source_work` is the database's last word.
 */
export const generateMemoryUseCase = async (
  deps: UseCaseDependencies,
  generator: MemoryGenerator,
  ctx: ActorContext,
  input: GenerateMemoryInput,
): Promise<MemoryState | null> => {
  const prepared = await deps.uow.transaction(async (tx) => {
    const existing = await tx.memories.findActiveByWork(
      input.organizationId,
      input.workId,
    );
    if (existing !== null) {
      return { kind: "done" as const, memory: existing };
    }

    const work = await tx.work.findById(input.organizationId, input.workId);
    if (work === null) {
      throw new NotFoundError("Work");
    }

    // Only the Decision the completion gate points at, and only when it was
    // satisfied. Work never reads the Decision Aggregate itself, so the
    // Application Layer performs the join the generation policy requires.
    const decision =
      work.completionGate.kind === "Satisfied"
        ? await tx.decisions.findById(
            input.organizationId,
            work.completionGate.reference.decisionId,
          )
        : null;

    const providerInput = buildProviderInput(work, decision);
    const inputHash = providerInputHash(providerInput);

    const operation = await tx.generationOperations.ensure({
      generationOperationId: deps.ids.revisionId(),
      organizationId: input.organizationId,
      workId: input.workId,
      generationPolicyVersion: generator.policyVersion,
      sourceEventId: input.sourceEventId,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceSnapshotHash: input.sourceSnapshotHash,
      providerInputHash: inputHash,
      promptTemplateVersion: generator.promptTemplateVersion,
      outputSchemaVersion: generator.outputSchemaVersion,
      now: ctx.now,
    });

    // A terminal operation is not retried here. `Failed` and `Abandoned` are
    // reached deliberately — a refusal, or an ungrounded draft — and clearing
    // them requires the typed retry command, not another redelivery.
    if (operation.status === "Generated" && operation.memoryId !== null) {
      const memory = await tx.memories.findById(
        input.organizationId,
        operation.memoryId,
      );
      if (memory !== null) {
        return { kind: "done" as const, memory };
      }
    }

    const claimed = await tx.generationOperations.claim({
      generationOperationId: operation.generationOperationId,
      lockedBy: input.workerId,
      leaseUntil: new Date(ctx.now.getTime() + GENERATION_LEASE_MS),
      now: ctx.now,
    });
    if (claimed === null) {
      return { kind: "skip" as const };
    }

    return {
      kind: "claimed" as const,
      operationId: claimed.generationOperationId,
      providerInput,
      inputHash,
    };
  });

  if (prepared.kind === "done") return prepared.memory;
  // Another worker owns this attempt, or the operation is terminal. Both mean
  // there is nothing for this caller to do — not that anything went wrong.
  if (prepared.kind === "skip") return null;

  let generated: GeneratedContent;
  try {
    generated = await generator.generate({
      providerInput: prepared.providerInput,
      providerInputHash: prepared.inputHash,
    });

    // ADR-0004: the response is untrusted candidate content until this runs.
    // It happens here rather than in the adapter so it applies to every
    // generator, including one added later.
    requireGrounded(generated, canonicalize(prepared.providerInput));
  } catch (error) {
    const rejected = error instanceof GenerationRejectedError;
    await deps.uow.transaction((tx) =>
      tx.generationOperations.fail({
        generationOperationId: prepared.operationId,
        errorCode: rejected ? error.code : "PROVIDER_ERROR",
        terminal: rejected ? error.terminal : false,
        nextAttemptAt:
          rejected && error.terminal
            ? null
            : new Date(ctx.now.getTime() + GENERATION_RETRY_DELAY_MS),
        now: ctx.now,
      }),
    );
    throw error;
  }

  return deps.uow.transaction(async (tx) => {
    // Re-check inside the transaction: another worker may have won the race.
    const raced = await tx.memories.findActiveByWork(
      input.organizationId,
      input.workId,
    );
    if (raced !== null) {
      return raced;
    }

    const { state, events } = createGeneratedMemory(
      {
        memoryId: deps.ids.memoryId(),
        organizationId: input.organizationId,
        sourceWorkId: input.workId,
        revisionId: deps.ids.revisionId(),
        generated,
        provenance: {
          sourceSnapshotId: input.sourceSnapshotId,
          sourceSnapshotHash: input.sourceSnapshotHash,
          generationPolicyVersion: generator.policyVersion,
          generatedBySystemPrincipalId: input.systemPrincipalId,
          generatedAt: ctx.now,
        },
        generatedBy: input.secretaryIdentityId,
      },
      ctx,
    );

    await tx.memories.insert(state);
    await tx.outbox.append(events);

    // Same transaction as the Memory insert. "Generated requires a linked
    // existing Memory" is a check constraint, so the two cannot diverge.
    await tx.generationOperations.complete({
      generationOperationId: prepared.operationId,
      memoryId: state.memoryId,
      modelReference: generator.modelReference,
      now: ctx.now,
    });

    return state;
  });
};

export const getMemoryUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  memoryId: MemoryId,
): Promise<MemoryState> =>
  deps.uow.transaction((tx) => loadMemory(tx, ctx.organizationId, memoryId));

export const listMemoriesUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
): Promise<readonly MemoryState[]> =>
  deps.uow.transaction((tx) => tx.memories.listByOrganization(ctx.organizationId));

export const getMemoryForWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
): Promise<MemoryState | null> =>
  deps.uow.transaction((tx) => tx.memories.findActiveByWork(ctx.organizationId, workId));

/**
 * The relationship a Memory authoring command requires.
 *
 * "Editor, related Work Member, or Admin", which needs the source Work: a
 * Memory is the record of completed Work, and the people entitled to correct it
 * are the people who did that Work.
 *
 * Reading a second Aggregate here is a read for authorization, not a second
 * mutation — ADR-0005 constrains what one transaction may *change*, and this
 * changes nothing. A Work that cannot be read yields null, which denies the
 * relationship rather than granting it.
 */
const requireMemoryAuthoring = async (
  tx: RepositoryBundle,
  ctx: WorkCommandContext,
  memory: MemoryState,
): Promise<void> => {
  const sourceWork = await tx.work.findById(ctx.organizationId, memory.sourceWorkId);
  requireMemoryRelationship(ctx.principal, memory, sourceWork, [
    "Editor",
    "RelatedWorkMember",
    "Administrator",
  ]);
};

export const editMemoryUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  memoryId: MemoryId,
  changes: { readonly title?: string; readonly summary?: string; readonly content?: string },
  contentHash: string,
): Promise<MemoryState> => {
  requirePermission(ctx.principal, "memory.edit_generated");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMemory(tx, ctx.organizationId, memoryId);
    await requireMemoryAuthoring(tx, ctx, current);
    const { state } = editGeneratedMemory(current, changes, contentHash, ctx);
    await tx.memories.update(state, current.version);
    return state;
  });
};

export const submitMemoryUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  memoryId: MemoryId,
): Promise<MemoryState> => {
  requirePermission(ctx.principal, "memory.submit");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMemory(tx, ctx.organizationId, memoryId);
    await requireMemoryAuthoring(tx, ctx, current);
    const { state, events } = submitMemoryForReview(current, ctx);
    await tx.memories.update(state, current.version);
    await tx.outbox.append(events);
    auditMemoryTransition(deps, ctx, current, state, memoryId, "memory.submit", "SubmitMemoryForReview");
    return state;
  });
};

/** Approve. The MVP ends here: Approved Memory is the release outcome. */
export const approveMemoryUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  memoryId: MemoryId,
  note: string,
): Promise<MemoryState> => {
  requirePermission(ctx.principal, "memory.approve");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMemory(tx, ctx.organizationId, memoryId);
    const { state, events } = approveMemory(current, note, ctx);
    await tx.memories.update(state, current.version);
    await tx.outbox.append(events);
    auditMemoryTransition(deps, ctx, current, state, memoryId, "memory.approve", "ApproveMemory");
    return state;
  });
};

export const rejectMemoryUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  memoryId: MemoryId,
  note: string,
): Promise<MemoryState> => {
  requirePermission(ctx.principal, "memory.reject");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMemory(tx, ctx.organizationId, memoryId);
    const { state, events } = rejectMemory(current, note, ctx);
    await tx.memories.update(state, current.version);
    await tx.outbox.append(events);
    auditMemoryTransition(deps, ctx, current, state, memoryId, "memory.reject", "RejectMemory");
    return state;
  });
};

export const reopenMemoryUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  memoryId: MemoryId,
): Promise<MemoryState> => {
  requirePermission(ctx.principal, "memory.reopen");

  return deps.uow.transaction(async (tx) => {
    const current = await loadMemory(tx, ctx.organizationId, memoryId);
    // "ReopenRejectedMemory | Editor, related Work Member, or Admin" — the same
    // relationship as editing and submitting, because reopening is what makes
    // the draft editable again. Its absence went unnoticed while the permission
    // was held only by the Owner, who passes this check as an Administrator.
    await requireMemoryAuthoring(tx, ctx, current);
    const { state } = reopenMemory(current, deps.ids.revisionId(), ctx);
    await tx.memories.update(state, current.version);
    auditMemoryTransition(deps, ctx, current, state, memoryId, "memory.reopen", "ReopenMemory");
    return state;
  });
};

export { currentMemoryRevision };
