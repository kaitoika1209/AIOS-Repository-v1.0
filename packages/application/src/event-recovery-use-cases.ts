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

import { isHumanMember } from "@aios/types";
import { VersionConflictError } from "@aios/domain";

import { requirePermission } from "./authorization.js";
import { findRegistration } from "./consumer-registry.js";
import {
  NotFoundError,
  type DeadLetteredDelivery,
  type FailedEventSummary,
  type RepositoryBundle,
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

/**
 * The authorization policy this release evaluates recovery requests under.
 *
 * Recorded on every replay row so the decision made at request time can be
 * compared with the one revalidated at execution time. A bare boolean would
 * make a policy change indistinguishable from a permission change.
 */
export const RECOVERY_POLICY_ID = "consumer-recovery-permission-matrix";
export const RECOVERY_POLICY_VERSION = 1;

/** Refused because the consumer's registration does not permit the operation. */
export class RecoveryNotPermittedError extends Error {
  readonly code = "RECOVERY_NOT_PERMITTED" as const;

  constructor(message: string) {
    super(message);
    this.name = "RecoveryNotPermittedError";
  }
}

export const listDeadLetteredUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
): Promise<readonly DeadLetteredDelivery[]> => {
  requirePermission(ctx.principal, "events.inspect_failed");
  return deps.uow.transaction((tx) =>
    tx.deliveries.listDeadLettered(ctx.organizationId, FAILED_EVENT_PAGE),
  );
};

/**
 * Load a dead letter together with the registration that governs it.
 *
 * A dead letter naming a consumer that is no longer registered is refused
 * rather than treated permissively: without a registration there is no skip
 * policy, and the document makes the registration the authority on whether the
 * operation is safe.
 */
const loadGoverned = async (
  tx: RepositoryBundle,
  ctx: WorkCommandContext,
  deadLetterId: string,
) => {
  const dead = await tx.deliveries.findDeadLetter(ctx.organizationId, deadLetterId);
  if (dead === null) {
    throw new NotFoundError("Dead letter");
  }

  const registration = findRegistration(dead.consumerName);
  if (registration === null) {
    throw new RecoveryNotPermittedError(
      `${dead.consumerName} is not a registered consumer.`,
    );
  }

  return { dead, registration };
};

/**
 * Discard one consumer's result for one event.
 *
 * The most dangerous recovery operation, and the one the registration gates
 * most tightly. `Prohibited` refuses outright; `RequiresSafetyEvidence` refuses
 * without a stated safety reference, because the document requires
 * "registered safety or compensation evidence" and an operator's confidence is
 * not evidence.
 *
 * The skip itself is one atomic sequence in the repository: processed event
 * `Failed -> Skipped`, dead letter `-> Skipped`, ordering decision. "A partial
 * skip is prohibited."
 */
export const skipDeadLetterUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: {
    readonly deadLetterId: string;
    readonly expectedDeadLetterVersion: number;
    readonly reasonCode: string;
    readonly reason: string;
    readonly safetyEvidenceReference?: string | undefined;
    readonly orderingBroken: boolean;
  },
): Promise<void> => {
  requirePermission(ctx.principal, "events.skip");

  if (!isHumanMember(ctx.principal)) {
    // "The Secretary and System Workers cannot request or approve skip."
    // Unreachable through `requirePermission`, which already refuses a
    // non-Human principal, and stated anyway so the rule is visible where it
    // applies rather than only where it is implemented.
    throw new RecoveryNotPermittedError("Skip requires a Human Member.");
  }
  const principal = ctx.principal;

  return deps.uow.transaction(async (tx) => {
    const { dead, registration } = await loadGoverned(tx, ctx, input.deadLetterId);

    if (registration.skipPolicy === "Prohibited") {
      throw new RecoveryNotPermittedError(
        `${registration.consumerName} registers skipPolicy=Prohibited.`,
      );
    }

    if (
      registration.skipPolicy === "RequiresSafetyEvidence" &&
      (input.safetyEvidenceReference ?? "").trim().length === 0
    ) {
      throw new RecoveryNotPermittedError(
        `${registration.consumerName} requires registered safety or compensation evidence to skip.`,
      );
    }

    const skipped = await tx.deliveries.skip({
      organizationId: ctx.organizationId,
      deadLetterId: input.deadLetterId,
      expectedDeadLetterVersion: input.expectedDeadLetterVersion,
      expectedOrderingStateVersion: dead.orderingStateVersion,
      reasonCode: input.reasonCode,
      resolvedByIdentityId: principal.identityId,
      resolvedByMembershipId: principal.membershipId,
      orderingBroken: input.orderingBroken,
      now: ctx.now,
    });

    if (!skipped) {
      // The dead letter moved between the read and the write, or was already
      // terminal. Reported as a conflict, not as absent: the caller saw it.
      throw new VersionConflictError(input.expectedDeadLetterVersion, -1);
    }
  });
};

/**
 * Reprocess a dead-lettered delivery with the currently deployed handler.
 *
 * `ReprocessWithCurrentHandler`. Unlike `RetryOriginal`, this asserts that the
 * handler in production now is the right one to apply — which is why the Admin
 * is denied it by default for a consumer carrying authoritative effects.
 *
 * The durable intent commits with the state change rather than before it. The
 * document requires the intent to exist before *execution*, and execution here
 * is the worker claiming the delivery afterwards, not this transaction.
 */
export const reprocessWithCurrentHandlerUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: {
    readonly deadLetterId: string;
    readonly expectedDeadLetterVersion: number;
    readonly reasonCode: string;
    readonly reason: string;
  },
): Promise<string> => {
  requirePermission(ctx.principal, "events.replay_domain_consumer");

  if (!isHumanMember(ctx.principal)) {
    throw new RecoveryNotPermittedError("Replay requires a Human Member.");
  }
  const principal = ctx.principal;

  return deps.uow.transaction(async (tx) => {
    const { dead, registration } = await loadGoverned(tx, ctx, input.deadLetterId);

    if (registration.consumerType === "Projection") {
      // A projection is rebuilt, not reprocessed. Routing it here would apply
      // the wrong recovery mode under the wrong permission.
      throw new RecoveryNotPermittedError(
        `${registration.consumerName} is a Projection Consumer; use the projection rebuild route.`,
      );
    }

    const replayId = deps.ids.replayId();
    await tx.replays.record({
      replayId,
      organizationId: ctx.organizationId,
      originalEventId: dead.eventId,
      consumerName: dead.consumerName,
      replayMode: "ReprocessWithCurrentHandler",
      requestedByIdentityId: principal.identityId,
      requestedByMembershipId: principal.membershipId,
      reasonCode: input.reasonCode,
      reason: input.reason,
      status: "Running",
      authorizationPolicyId: RECOVERY_POLICY_ID,
      authorizationPolicyVersion: RECOVERY_POLICY_VERSION,
      sourceProcessedEventStatus: dead.processedEventStatus,
      expectedDeadLetterVersion: input.expectedDeadLetterVersion,
      now: ctx.now,
    });

    const queued = await tx.deliveries.reprocess({
      organizationId: ctx.organizationId,
      deadLetterId: input.deadLetterId,
      expectedDeadLetterVersion: input.expectedDeadLetterVersion,
      now: ctx.now,
    });

    if (!queued) {
      throw new VersionConflictError(input.expectedDeadLetterVersion, -1);
    }

    return replayId;
  });
};

/**
 * Rebuild a registered projection.
 *
 * Implemented and, in this release, always refused: no registration declares
 * `consumerType = Projection`. That is the honest outcome rather than a missing
 * route — the permission is granted, the request is authorized, and the
 * registry answers that there is no projection to rebuild.
 *
 * The refusal is recorded as a `Denied` replay so the attempt is auditable.
 */
export const rebuildProjectionUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: {
    readonly consumerName: string;
    readonly reasonCode: string;
    readonly reason: string;
  },
): Promise<string> => {
  requirePermission(ctx.principal, "events.replay_projection");

  if (!isHumanMember(ctx.principal)) {
    throw new RecoveryNotPermittedError("Replay requires a Human Member.");
  }
  const principal = ctx.principal;

  const registration = findRegistration(input.consumerName);
  if (registration === null || !registration.enabled) {
    // Nothing is recorded for a consumer that does not exist: there is no
    // registration to have denied the request, and writing a replay row naming
    // one would invent a target.
    throw new NotFoundError("Consumer");
  }

  const replayId = deps.ids.replayId();
  const permitted = registration.consumerType === "Projection";

  // The intent commits before the refusal is raised. Throwing inside the
  // transaction would roll back the very audit record the intent exists to
  // leave, so a denied attempt would vanish — which is the opposite of what
  // "captured as durable intent" requires.
  await deps.uow.transaction(async (tx) => {
    await tx.replays.record({
      replayId,
      organizationId: ctx.organizationId,
      // A rebuild targets the projection rather than one event, and the column
      // is NOT NULL. The nil UUID says "no single source event" without
      // inventing one a later reader could try to follow.
      originalEventId: "00000000-0000-0000-0000-000000000000",
      consumerName: input.consumerName,
      replayMode: "RebuildProjection",
      requestedByIdentityId: principal.identityId,
      requestedByMembershipId: principal.membershipId,
      reasonCode: input.reasonCode,
      reason: input.reason,
      // `Validating` rather than the eventual status: the documented
      // transitions are `Requested -> Validating` then `Validating -> Denied`,
      // and a terminal status must carry `completed_at`, which only `settle`
      // sets.
      status: "Validating",
      authorizationPolicyId: RECOVERY_POLICY_ID,
      authorizationPolicyVersion: RECOVERY_POLICY_VERSION,
      sourceProcessedEventStatus: "NotApplicable",
      expectedDeadLetterVersion: null,
      now: ctx.now,
    });

    if (!permitted) {
      await tx.replays.settle({
        replayId,
        organizationId: ctx.organizationId,
        status: "Denied",
        resultCode: "NOT_A_PROJECTION",
        now: ctx.now,
      });
    }
  });

  if (!permitted) {
    throw new RecoveryNotPermittedError(
      `${input.consumerName} is not a registered Projection Consumer.`,
    );
  }

  return replayId;
};
