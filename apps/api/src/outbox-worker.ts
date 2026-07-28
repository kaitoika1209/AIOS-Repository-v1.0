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

import type { Pool } from "pg";

import { DecisionId, IdentityId, MembershipId, OrganizationId, WorkId } from "@aios/types";
import {
  applyDecisionOutcomeUseCase,
  type UseCaseDependencies,
} from "@aios/application";
import { DomainError } from "@aios/domain";

interface OutboxRow {
  outbox_id: string;
  event_type: string;
  payload: {
    decisionId: string;
    relatedWorkId: string;
    revisionNumber: number;
    submittedSnapshotId: string | null;
    organizationId: string;
    actorIdentityId: string;
    actorMembershipId: string;
  };
}

const OUTCOME_EVENTS = ["DecisionApproved", "DecisionRejected", "DecisionWithdrawn"];

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

export interface DrainResult {
  readonly claimed: number;
  readonly applied: number;
  readonly alreadyApplied: number;
  readonly failed: number;
}

/**
 * Process one batch of pending Outbox messages.
 *
 * Returns counts rather than throwing, so a single poisonous message cannot
 * stop the loop. A failed message stays `Failed` for operational recovery.
 */
export const drainOutbox = async (
  pool: Pool,
  deps: UseCaseDependencies,
  batchSize = 20,
): Promise<DrainResult> => {
  const client = await pool.connect();
  let rows: OutboxRow[];

  try {
    await client.query("BEGIN");
    const claimed = await client.query<OutboxRow>(
      `SELECT outbox_id, event_type, payload
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

  for (const row of rows) {
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
    try {
      await applyDecisionOutcomeUseCase(
        deps,
        {
          principal: systemPrincipal(OrganizationId(payload.organizationId)),
          now: new Date(),
        },
        {
          organizationId: OrganizationId(payload.organizationId),
          workId: WorkId(payload.relatedWorkId),
          decisionId: DecisionId(payload.decisionId),
          revisionNumber: payload.revisionNumber,
          submittedSnapshotId: payload.submittedSnapshotId ?? "",
          outcome: outcomeOf(row.event_type),
          resolvedByIdentityId: IdentityId(payload.actorIdentityId),
          resolvedByMembershipId: MembershipId(payload.actorMembershipId),
        },
      );
      applied += 1;
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
        await client.query(
          `UPDATE outbox_messages SET status = 'Published', published_at = now()
            WHERE outbox_id = $1`,
          [row.outbox_id],
        );
      } else {
        failed += 1;
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
  return { claimed: rows.length, applied, alreadyApplied, failed };
};

/** Poll loop for development. Production would run this as a separate worker. */
export const startOutboxWorker = (
  pool: Pool,
  deps: UseCaseDependencies,
  intervalMs = 500,
): (() => void) => {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await drainOutbox(pool, deps);
    } catch (error) {
      console.error("Outbox worker error", error);
    }
    if (!stopped) setTimeout(() => void tick(), intervalMs);
  };

  void tick();
  return () => {
    stopped = true;
  };
};
