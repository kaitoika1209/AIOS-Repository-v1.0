/**
 * Outbox consumer for Decision outcomes.
 *
 * ADR-0007 splits Work/Decision coordination: activation is atomic, but the
 * outcome reaches Work asynchronously through the Outbox. This is that second
 * half — without it a blocked Work never leaves `WaitingForDecision`.
 *
 * Delivery is at-least-once (ADR-0006), so redelivery must be safe. It is: the
 * Work Aggregate only accepts an outcome while it is `WaitingForDecision` with
 * a matching Pending gate, so a duplicate is rejected by the domain rather than
 * applied twice. Those rejections are recorded as handled, not as failures.
 *
 * Claims use `FOR UPDATE SKIP LOCKED`, which the persistence document lists as
 * an SQL-first operation.
 */

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { DecisionId, IdentityId, MembershipId, OrganizationId, WorkId } from "@aios/types";
import {
  describeError,
  getLogger,
  applyDecisionOutcomeUseCase,
  consumersFor,
  generateMemoryUseCase,
  projectNotificationsUseCase,
  type MemoryGenerator,
  type UseCaseDependencies,
} from "@aios/application";
import { PostgresConsumerDeliveryRepository } from "@aios/persistence";
import { DomainError, type DomainEvent } from "@aios/domain";

interface OutboxRow {
  outbox_id: string;
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  schema_version: number;
  correlation_id: string;
  event_sequence: number;
  payload: {
    type?: string;
    decisionId?: string;
    relatedWorkId?: string;
    workId?: string;
    revisionNumber?: number;
    submittedSnapshotId?: string | null;
    organizationId: string;
    actorIdentityId: string;
    actorMembershipId: string | null;
  };
}

const OUTCOME_EVENTS = ["DecisionApproved", "DecisionRejected", "DecisionWithdrawn"];

/** Consumer names, matching the registry entries in `@aios/application`. */
const DECISION_OUTCOME_CONSUMER = "decision-outcome";
const MEMORY_GENERATION_CONSUMER = "memory-generation";
const NOTIFICATIONS_CONSUMER = "notifications";

/**
 * What each consumer's registration implies for a failed delivery, read once at
 * module load so the worker cannot drift from the registry.
 */
const CONSUMER_POLICY: Record<string, { blocks: boolean; ordered: boolean }> =
  Object.fromEntries(
    [
      [DECISION_OUTCOME_CONSUMER, "DecisionApproved"],
      [MEMORY_GENERATION_CONSUMER, "WorkCompleted"],
      [NOTIFICATIONS_CONSUMER, "DecisionApproved"],
    ].map(([name, eventType]) => {
      const registration = consumersFor(eventType!).find(
        (r) => r.consumerName === name,
      )!;
      return [
        name,
        {
          blocks:
            registration.failureContinuationPolicy === "BlockOrderingKey" ||
            registration.failureContinuationPolicy === "RequireExternalRecovery",
          ordered: registration.orderingRequirement !== "None",
        },
      ];
    }),
  );

const outcomeOf = (eventType: string): "Approved" | "Rejected" | "Withdrawn" =>
  eventType === "DecisionApproved"
    ? "Approved"
    : eventType === "DecisionRejected"
      ? "Rejected"
      : "Withdrawn";

/** The System Principal that applies outcomes. It holds no business authority. */
const systemPrincipal = (organizationId: OrganizationId) =>
  ({
    type: "System" as const,
    component: "decision-outcome-consumer",
    organizationId,
  });


/**
 * Record one consumer's handling of one event.
 *
 * The consumer-side half of delivery, kept separate from the Outbox row: the
 * Outbox says whether the event was published, this says whether a named
 * consumer handled it. A consumer failing is not a publication failure, and the
 * recovery operations act here rather than there.
 *
 * Returns false when the delivery is not this worker's to attempt — already
 * handled, or blocked behind an earlier failure on the same ordering key.
 */
const beginDelivery = async (
  client: PoolClient,
  consumerName: string,
  row: OutboxRow,
  organizationId: OrganizationId,
  orderingKey: string | null,
): Promise<boolean> => {
  const deliveries = new PostgresConsumerDeliveryRepository(client);
  const outcome = await deliveries.claim({
    consumerName,
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    organizationId,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    correlationId: row.correlation_id,
    orderingKeyType: orderingKey === null ? null : "AggregateStream",
    orderingKey,
    sourceSequence: row.aggregate_version,
    now: new Date(),
  });
  return outcome === "Claimed";
};

const completeDelivery = (
  client: PoolClient,
  consumerName: string,
  eventId: string,
): Promise<void> =>
  new PostgresConsumerDeliveryRepository(client).complete({
    consumerName,
    eventId,
    now: new Date(),
  });

/**
 * Dead-letter this delivery, blocking the ordering key when the registration
 * says later deliveries must not pass a failed predecessor.
 */
const failDelivery = async (
  client: PoolClient,
  consumerName: string,
  eventId: string,
  organizationId: OrganizationId,
  error: unknown,
): Promise<void> => {
  const policy = CONSUMER_POLICY[consumerName];
  await new PostgresConsumerDeliveryRepository(client).fail({
    consumerName,
    eventId,
    organizationId,
    deadLetterId: randomUUID(),
    failureCategory: error instanceof DomainError ? "DomainRejection" : "Unexpected",
    errorCode: error instanceof DomainError ? error.code : "UNEXPECTED",
    blockOrderingKey: policy?.blocks ?? false,
    now: new Date(),
  });
};

export interface DrainResult {
  readonly claimed: number;
  readonly applied: number;
  readonly alreadyApplied: number;
  readonly failed: number;
  /** Notification rows written by the projection consumer. */
  readonly notified: number;
}

/**
 * Run the notification projection for one event, in its own transaction.
 *
 * Separate from the business consumer's transaction on purpose: a projection
 * failure must not roll back an authoritative effect, and the registration says
 * `ContinueIndependent` for exactly that reason. A failure is dead-lettered and
 * the projection can be rebuilt.
 */
const projectFor = async (
  client: PoolClient,
  deps: UseCaseDependencies,
  row: OutboxRow,
): Promise<number> => {
  const organizationId = OrganizationId(row.payload.organizationId);

  if (
    !(await beginDelivery(client, NOTIFICATIONS_CONSUMER, row, organizationId, null))
  ) {
    return 0;
  }

  try {
    // The payload is the event as it was appended, so the projection reads the
    // same shape the domain produced rather than a reconstruction.
    const written = await deps.uow.transaction((tx) =>
      projectNotificationsUseCase(
        deps,
        tx,
        row.payload as unknown as DomainEvent,
        row.event_id,
      ),
    );
    await completeDelivery(client, NOTIFICATIONS_CONSUMER, row.event_id);
    return written;
  } catch (error) {
    await failDelivery(
      client,
      NOTIFICATIONS_CONSUMER,
      row.event_id,
      organizationId,
      error,
    );
    return 0;
  }
};

/**
 * Process one batch of pending Outbox messages.
 *
 * Returns counts rather than throwing, so a single poisonous message cannot
 * stop the loop. A failed message stays `Failed` for operational recovery.
 */
export interface ConsumerOptions {
  /** Present once Memory generation is wired; absent leaves WorkCompleted unhandled. */
  readonly memory?: {
    readonly generator: MemoryGenerator;
    readonly secretaryIdentityId: string;
    readonly systemPrincipalId: string;
    /**
     * Identifies this worker on the generation operation's lease.
     *
     * Defaulted rather than required: a single-process development run has one
     * worker, and forcing every caller to invent a name would be noise. In a
     * deployment with several workers it should be distinct per process, so a
     * stuck lease names the process that took it.
     */
    readonly workerId?: string;
  };
}

export const drainOutbox = async (
  pool: Pool,
  deps: UseCaseDependencies,
  batchSize = 20,
  options: ConsumerOptions = {},
): Promise<DrainResult> => {
  const client = await pool.connect();
  let rows: OutboxRow[];

  try {
    await client.query("BEGIN");
    const claimed = await client.query<OutboxRow>(
      `SELECT outbox_id, event_id, event_type, aggregate_type, aggregate_id,
              aggregate_version, schema_version, correlation_id, event_sequence, payload
         FROM outbox_messages
        WHERE status = 'Pending'
          AND next_attempt_at <= now()
        ORDER BY recorded_at
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [batchSize],
    );
    rows = claimed.rows;

    if (rows.length > 0) {
      await client.query(
        `UPDATE outbox_messages
            SET status = 'Claimed', last_attempt_at = now(),
                attempt_count = attempt_count + 1
          WHERE outbox_id = ANY($1::uuid[])`,
        [rows.map((r) => r.outbox_id)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    throw error;
  }

  let applied = 0;
  let alreadyApplied = 0;
  let failed = 0;
  let notified = 0;

  for (const row of rows) {
    // The notification projection runs for every event it registers for,
    // independently of the consumer that owns the business effect. Two consumers
    // handling the same event is the normal case, and each has its own
    // processed-event row.
    if (
      consumersFor(row.event_type).some(
        (r) => r.consumerName === NOTIFICATIONS_CONSUMER,
      )
    ) {
      notified += await projectFor(client, deps, row);
    }

    // WorkCompleted is the durable trigger for Memory generation (ADR-0008).
    if (row.event_type === "WorkCompleted" && options.memory !== undefined) {
      const organizationId = OrganizationId(row.payload.organizationId);

      // Unordered consumer, so no ordering key. A redelivery that this worker
      // has already handled is skipped here rather than reaching the use case.
      if (
        !(await beginDelivery(
          client,
          MEMORY_GENERATION_CONSUMER,
          row,
          organizationId,
          null,
        ))
      ) {
        alreadyApplied += 1;
        await client.query(
          `UPDATE outbox_messages SET status = 'Published', published_at = now()
            WHERE outbox_id = $1`,
          [row.outbox_id],
        );
        continue;
      }

      try {
        await generateMemoryUseCase(
          deps,
          options.memory.generator,
          {
            principal: systemPrincipal(OrganizationId(row.payload.organizationId)),
            now: new Date(),
          },
          {
            organizationId: OrganizationId(row.payload.organizationId),
            workId: WorkId(row.aggregate_id),
            sourceEventId: row.event_id,
            // The Work state at completion is the source snapshot; the Outbox
            // row's stream position identifies it uniquely (ADR-0012).
            sourceSnapshotId: row.outbox_id,
            sourceSnapshotHash: `work:${row.aggregate_id}@${row.aggregate_version}`,
            secretaryIdentityId: IdentityId(options.memory.secretaryIdentityId),
            systemPrincipalId: options.memory.systemPrincipalId,
            workerId: options.memory.workerId ?? "outbox-worker",
          },
        );
        applied += 1;
        await completeDelivery(client, MEMORY_GENERATION_CONSUMER, row.event_id);
        await client.query(
          `UPDATE outbox_messages SET status = 'Published', published_at = now()
            WHERE outbox_id = $1`,
          [row.outbox_id],
        );
      } catch (error) {
        failed += 1;
        await failDelivery(
          client,
          MEMORY_GENERATION_CONSUMER,
          row.event_id,
          organizationId,
          error,
        );
        await client.query(
          `UPDATE outbox_messages
              SET status = 'Failed', last_error_code = $2, last_error_message = $3
            WHERE outbox_id = $1`,
          [
            row.outbox_id,
            error instanceof DomainError ? error.code : "UNEXPECTED",
            error instanceof Error ? error.message.slice(0, 500) : "unknown",
          ],
        );
      }
      continue;
    }

    if (!OUTCOME_EVENTS.includes(row.event_type)) {
      // Nothing subscribes to it yet; publishing is still complete.
      await client.query(
        `UPDATE outbox_messages SET status = 'Published', published_at = now()
          WHERE outbox_id = $1`,
        [row.outbox_id],
      );
      continue;
    }

    const payload = row.payload;
    const organizationId = OrganizationId(payload.organizationId);

    // Ordered by the source Decision stream: applying a later outcome for the
    // same Decision after an earlier one failed would leave the completion gate
    // reflecting the wrong revision.
    if (
      !(await beginDelivery(
        client,
        DECISION_OUTCOME_CONSUMER,
        row,
        organizationId,
        CONSUMER_POLICY[DECISION_OUTCOME_CONSUMER]?.ordered === true
          ? `Decision:${row.aggregate_id}`
          : null,
      ))
    ) {
      alreadyApplied += 1;
      await client.query(
        `UPDATE outbox_messages SET status = 'Published', published_at = now()
          WHERE outbox_id = $1`,
        [row.outbox_id],
      );
      continue;
    }

    try {
      await applyDecisionOutcomeUseCase(
        deps,
        {
          principal: systemPrincipal(OrganizationId(payload.organizationId)),
          now: new Date(),
        },
        {
          organizationId: OrganizationId(payload.organizationId),
          workId: WorkId(payload.relatedWorkId!),
          decisionId: DecisionId(payload.decisionId!),
          revisionNumber: payload.revisionNumber!,
          submittedSnapshotId: payload.submittedSnapshotId ?? "",
          outcome: outcomeOf(row.event_type),
          resolvedByIdentityId: IdentityId(payload.actorIdentityId),
          resolvedByMembershipId: MembershipId(payload.actorMembershipId ?? ""),
        },
      );
      applied += 1;
      await completeDelivery(client, DECISION_OUTCOME_CONSUMER, row.event_id);
      await client.query(
        `UPDATE outbox_messages SET status = 'Published', published_at = now()
          WHERE outbox_id = $1`,
        [row.outbox_id],
      );
    } catch (error) {
      // A redelivery arrives when Work has already left WaitingForDecision, or
      // when the gate now references a newer revision. Both mean the outcome is
      // already accounted for — that is success for an at-least-once consumer.
      const duplicate =
        error instanceof DomainError &&
        (error.code === "WORK_INVALID_TRANSITION" ||
          error.code === "WORK_BLOCKING_REFERENCE_MISMATCH" ||
          error.code === "WORK_COMPLETION_GATE_UNSATISFIED");

      if (duplicate) {
        alreadyApplied += 1;
        await completeDelivery(client, DECISION_OUTCOME_CONSUMER, row.event_id);
        await client.query(
          `UPDATE outbox_messages SET status = 'Published', published_at = now()
            WHERE outbox_id = $1`,
          [row.outbox_id],
        );
      } else {
        failed += 1;
        await failDelivery(
          client,
          DECISION_OUTCOME_CONSUMER,
          row.event_id,
          organizationId,
          error,
        );
        await client.query(
          `UPDATE outbox_messages
              SET status = 'Failed',
                  last_error_code = $2,
                  last_error_message = $3
            WHERE outbox_id = $1`,
          [
            row.outbox_id,
            error instanceof DomainError ? error.code : "UNEXPECTED",
            error instanceof Error ? error.message.slice(0, 500) : "unknown",
          ],
        );
      }
    }
  }

  client.release();
  return { claimed: rows.length, applied, alreadyApplied, failed, notified };
};

/** Poll loop for development. Production would run this as a separate worker. */
export const startOutboxWorker = (
  pool: Pool,
  deps: UseCaseDependencies,
  intervalMs = 500,
  options: ConsumerOptions = {},
): (() => void) => {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await drainOutbox(pool, deps, 20, options);
    } catch (error) {
      getLogger().log({
        severity: "ERROR",
        operationalLogName: "worker.drain_failed",
        operationalLogClass: "Worker",
        operationalLogCategory: "Operations",
        message: "An Outbox drain failed; it will be retried.",
        outcome: "Failure",
        attributes: describeError(error),
      });
    }
    if (!stopped) setTimeout(() => void tick(), intervalMs);
  };

  void tick();
  return () => {
    stopped = true;
  };
};
