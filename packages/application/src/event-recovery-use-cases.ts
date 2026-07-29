/**
 * Operational recovery for failed event deliveries.
 *
 * `docs/architecture/authorization.md` is unusually specific about who may do
 * this, and the rules are not the ordinary ones:
 *
 * > An Organization-scoped recovery request requires an authenticated active
 * > HumanMemberPrincipal in the source event's Organization. Infrastructure
 * > access, database access, a SystemPrincipal, or a SecretaryPrincipal does not
 * > grant Organization business authority.
 *
 * > The immutable source event determines `organizationId`. The command payload
 * > cannot select another Organization or provide `requestedBy`.
 *
 * Both hold structurally here: the acting Organization comes from the resolved
 * principal, every statement is scoped by it, and no input names one.
 */

import { requirePermission } from "./authorization.js";
import {
  NotFoundError,
  type FailedEventSummary,
  type UseCaseDependencies,
} from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

/** Bounded so an incident cannot turn one request into an unbounded scan. */
export const FAILED_EVENT_PAGE = 100;

export const listFailedEventsUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
): Promise<readonly FailedEventSummary[]> => {
  requirePermission(ctx.principal, "events.inspect_failed");
  return deps.uow.transaction((tx) =>
    tx.eventRecovery.listFailed(ctx.organizationId, FAILED_EVENT_PAGE),
  );
};

/**
 * Return a failed delivery to the queue.
 *
 * This is `RetryOriginal`: the same event, the same handler, the same
 * at-least-once contract. It asserts nothing about whether the original attempt
 * had an effect — that is what makes it safe to expose, and what distinguishes
 * it from skip and replay, which do assert something and are not in this
 * release.
 */
export const retryFailedEventUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  eventId: string,
): Promise<void> => {
  requirePermission(ctx.principal, "events.retry");

  const retried = await deps.uow.transaction((tx) =>
    tx.eventRecovery.retryFailed(ctx.organizationId, eventId, ctx.now),
  );

  if (!retried) {
    // Not Failed, or not this Organization's. Reported the same way, because
    // distinguishing them would let an operator probe another tenant's events.
    throw new NotFoundError("Failed event");
  }
};
