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

import type { MemoryId, OrganizationId, WorkId } from "@aios/types";
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
  type WorkState,
} from "@aios/domain";

import { requirePermission } from "./authorization.js";
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
  generate(input: {
    readonly work: WorkState;
    readonly sourceSnapshotId: string;
    readonly sourceSnapshotHash: string;
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
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotHash: string;
  /** The Secretary credited as the author of the generated draft. */
  readonly secretaryIdentityId: Parameters<
    typeof createGeneratedMemory
  >[0]["generatedBy"];
  readonly systemPrincipalId: string;
}

/**
 * Generate the Memory for a completed Work.
 *
 * Idempotent by construction: at-least-once delivery means this runs more than
 * once for the same Work, and the second run finds the existing active Memory
 * and returns it. The database enforces the same rule through
 * `uq_memories_active_source_work`, so a race loses at the constraint rather
 * than producing a duplicate draft.
 *
 * The provider call happens outside the transaction; only the committed result
 * is persisted.
 */
export const generateMemoryUseCase = async (
  deps: UseCaseDependencies,
  generator: MemoryGenerator,
  ctx: ActorContext,
  input: GenerateMemoryInput,
): Promise<MemoryState> => {
  const existing = await deps.uow.transaction((tx) =>
    tx.memories.findActiveByWork(input.organizationId, input.workId),
  );
  if (existing !== null) {
    return existing;
  }

  const work = await deps.uow.transaction((tx) =>
    tx.work.findById(input.organizationId, input.workId),
  );
  if (work === null) {
    throw new NotFoundError("Work");
  }

  const generated = await generator.generate({
    work,
    sourceSnapshotId: input.sourceSnapshotId,
    sourceSnapshotHash: input.sourceSnapshotHash,
  });

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
    const { state, events } = submitMemoryForReview(current, ctx);
    await tx.memories.update(state, current.version);
    await tx.outbox.append(events);
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
    const { state } = reopenMemory(current, deps.ids.revisionId(), ctx);
    await tx.memories.update(state, current.version);
    return state;
  });
};

export { currentMemoryRevision };
