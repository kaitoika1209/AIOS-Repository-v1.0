/**
 * Work use cases.
 *
 * Each function is one Application Service: it checks the permission, opens the
 * transaction, loads the Aggregate, lets the Aggregate decide, then persists
 * state and events together.
 *
 * The Aggregate decides whether a transition is valid. These services never
 * re-implement that rule — they coordinate.
 */

import type { OrganizationId, WorkId } from "@aios/types";
import {
  cancelWork,
  completeWork,
  createWork,
  startWork,
  type ActorContext,
  type WorkState,
} from "@aios/domain";

import { requirePermission } from "./authorization.js";
import { NotFoundError, type UseCaseDependencies } from "./ports.js";

export interface WorkCommandContext extends ActorContext {
  readonly organizationId: OrganizationId;
}

const loadWork = async (
  tx: { work: { findById: (o: OrganizationId, w: WorkId) => Promise<WorkState | null> } },
  organizationId: OrganizationId,
  workId: WorkId,
): Promise<WorkState> => {
  const work = await tx.work.findById(organizationId, workId);
  if (work === null) {
    throw new NotFoundError("Work");
  }
  return work;
};

export const createWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: { readonly title: string; readonly description?: string | null },
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.create");

  return deps.uow.transaction(async (tx) => {
    const { state, events } = createWork(
      {
        workId: deps.ids.workId(),
        organizationId: ctx.organizationId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      ctx,
    );

    await tx.work.insert(state);
    await tx.outbox.append(events);
    return state;
  });
};

export const startWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.start");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    const { state, events } = startWork(current, ctx);

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

/**
 * Complete Work.
 *
 * `WorkCompleted` is the durable trigger for Memory generation (ADR-0008). It
 * is appended to the Outbox in this transaction; generation happens later, in a
 * separate process, and cannot roll this transaction back.
 */
export const completeWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
  completionSummary: string,
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.complete");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    const { state, events } = completeWork(current, completionSummary, ctx);

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const cancelWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
  reason: string,
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.cancel");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    const { state, events } = cancelWork(current, reason, ctx);

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const getWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
): Promise<WorkState> =>
  deps.uow.transaction((tx) => loadWork(tx, ctx.organizationId, workId));

export const listWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
): Promise<readonly WorkState[]> =>
  deps.uow.transaction((tx) => tx.work.listByOrganization(ctx.organizationId));
