/**
 * The Organization workflow-health projection, and the derivation behind it
 * (ADR-0021, ADR-0023).
 *
 * Two halves of one thing. `countsFor` derives the current answer from the
 * source tables; the reconcile calls it and writes the result through `upsert`;
 * `readFor` returns what was written. The route reads only the projection, so
 * "the numbers look fine" and "the numbers are current" stay distinguishable —
 * ADR-0023 records why a stale-projection fallback to the live query would
 * defeat the whole point.
 *
 * Every query is scoped by `organization_id`, which all four source tables
 * carry. That is not a convention here, it is the difference between an
 * operational answer and a tenant-isolation break.
 */

import type { PoolClient } from "pg";

import { OrganizationId } from "@aios/types";
import {
  describeError,
  getLogger,
  type WorkflowCounts,
  type WorkflowHealthQuery,
  type WorkflowHealthRow,
  type WorkflowReasonCode,
  type WorkflowStatus,
  type WorkflowType,
} from "@aios/application";

interface ProjectionRow {
  workflow_type: string;
  status: string;
  reason_code: string;
  pending_count: number;
  oldest_pending_at: Date | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  consecutive_failures: number;
  terminal_failure_count: number;
  last_error_code: string | null;
  source_high_water_mark: Date;
  projection_version: number;
  updated_at: Date;
}

/** Narrowed by the table's own check constraints, not by trust. */
const toRow = (row: ProjectionRow): WorkflowHealthRow => ({
  workflowType: row.workflow_type as WorkflowType,
  status: row.status as WorkflowStatus,
  reasonCode: row.reason_code as WorkflowReasonCode,
  pendingCount: row.pending_count,
  oldestPendingAt: row.oldest_pending_at,
  lastAttemptAt: row.last_attempt_at,
  lastSuccessAt: row.last_success_at,
  consecutiveFailures: row.consecutive_failures,
  terminalFailureCount: row.terminal_failure_count,
  lastErrorCode: row.last_error_code,
  sourceHighWaterMark: row.source_high_water_mark,
  projectionVersion: row.projection_version,
  updatedAt: row.updated_at,
});

interface CountRow {
  pending: string;
  oldest_seconds: string | null;
  unresolved: string;
}

/**
 * One query per workflow, each naming its own table's notion of "not finished".
 *
 * Written out rather than generated, because each table's terminal states are a
 * fact about that state machine — `Skipped` is terminal for a delivery and
 * `Abandoned` is terminal for a generation, and a shared abstraction would have
 * to encode both anyway while hiding which is which.
 */
const QUERIES: Readonly<Record<WorkflowType, string>> = {
  OutboxPublication: `
    SELECT count(*) AS pending,
           EXTRACT(EPOCH FROM (now() - min(recorded_at)))::bigint AS oldest_seconds,
           count(*) FILTER (WHERE status = 'Failed') AS unresolved
      FROM outbox_messages
     WHERE organization_id = $1 AND status <> 'Published'`,

  ConsumerDelivery: `
    SELECT count(*) AS pending,
           EXTRACT(EPOCH FROM (now() - min(first_received_at)))::bigint AS oldest_seconds,
           count(*) FILTER (WHERE status = 'Failed') AS unresolved
      FROM processed_events
     WHERE organization_id = $1 AND status NOT IN ('Processed', 'Skipped')`,

  DeadLetter: `
    SELECT count(*) AS pending,
           EXTRACT(EPOCH FROM (now() - min(first_failed_at)))::bigint AS oldest_seconds,
           -- Every unresolved dead letter is a decision waiting for a person, so
           -- age is not what makes it serious. It is Blocked on arrival.
           count(*) AS unresolved
      FROM dead_letter_events
     WHERE organization_id = $1 AND status NOT IN ('Resolved', 'Skipped')`,

  MemoryGeneration: `
    SELECT count(*) AS pending,
           EXTRACT(EPOCH FROM (now() - min(created_at)))::bigint AS oldest_seconds,
           count(*) FILTER (WHERE status = 'Failed') AS unresolved
      FROM memory_generation_operations
     WHERE organization_id = $1
       AND status NOT IN ('Generated', 'Failed', 'Abandoned')`,
};

export class PostgresWorkflowHealthQuery implements WorkflowHealthQuery {
  constructor(private readonly client: PoolClient) {}

  async countsFor(
    organizationId: OrganizationId,
  ): Promise<Readonly<Partial<Record<WorkflowType, WorkflowCounts>>>> {
    const result: Partial<Record<WorkflowType, WorkflowCounts>> = {};

    for (const [workflowType, sql] of Object.entries(QUERIES) as [
      WorkflowType,
      string,
    ][]) {
      try {
        const rows = await this.client.query<CountRow>(sql, [organizationId]);
        const row = rows.rows[0];
        if (row === undefined) continue;

        result[workflowType] = {
          pending: Number(row.pending),
          oldestPendingSeconds:
            row.oldest_seconds === null ? null : Number(row.oldest_seconds),
          unresolvedFailures: Number(row.unresolved),
        };
      } catch (error) {
        // Left out of the map on purpose. The caller reports `Unknown` for an
        // absent workflow, and the architecture is explicit that missing
        // evidence must not be presented as healthy — which is exactly what a
        // zeroed row here would produce.
        getLogger().log({
          severity: "ERROR",
          operationalLogName: "workflow_health.query_failed",
          operationalLogClass: "Operations",
          operationalLogCategory: "Operations",
          message: "A workflow health query failed; it is reported as Unknown.",
          outcome: "Failure",
          attributes: { "operations.workflow_type": workflowType, ...describeError(error) },
        });
      }
    }

    return result;
  }

  async readFor(organizationId: OrganizationId): Promise<readonly WorkflowHealthRow[]> {
    const result = await this.client.query<ProjectionRow>(
      `SELECT * FROM organization_workflow_health
        WHERE organization_id = $1
        ORDER BY workflow_type`,
      [organizationId],
    );
    return result.rows.map(toRow);
  }

  /**
   * Replace this Organization's rows with the reconcile's result.
   *
   * `ON CONFLICT DO UPDATE` rather than delete-then-insert: the projection is
   * read continuously, and a delete would give every concurrent reader a moment
   * of `NoData` that is indistinguishable from an Organization the reconcile has
   * never seen.
   */
  async upsert(
    organizationId: OrganizationId,
    rows: readonly WorkflowHealthRow[],
  ): Promise<void> {
    for (const row of rows) {
      await this.client.query(
        `INSERT INTO organization_workflow_health (
           organization_id, workflow_type, status, reason_code,
           pending_count, oldest_pending_at, last_attempt_at, last_success_at,
           consecutive_failures, terminal_failure_count, last_error_code,
           source_high_water_mark, projection_version, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (organization_id, workflow_type) DO UPDATE SET
           status = EXCLUDED.status,
           reason_code = EXCLUDED.reason_code,
           pending_count = EXCLUDED.pending_count,
           oldest_pending_at = EXCLUDED.oldest_pending_at,
           last_attempt_at = EXCLUDED.last_attempt_at,
           last_success_at = EXCLUDED.last_success_at,
           consecutive_failures = EXCLUDED.consecutive_failures,
           terminal_failure_count = EXCLUDED.terminal_failure_count,
           last_error_code = EXCLUDED.last_error_code,
           source_high_water_mark = EXCLUDED.source_high_water_mark,
           projection_version = EXCLUDED.projection_version,
           updated_at = EXCLUDED.updated_at`,
        [
          organizationId,
          row.workflowType,
          row.status,
          row.reasonCode,
          row.pendingCount,
          row.oldestPendingAt,
          row.lastAttemptAt,
          row.lastSuccessAt,
          row.consecutiveFailures,
          row.terminalFailureCount,
          row.lastErrorCode,
          row.sourceHighWaterMark,
          row.projectionVersion,
          row.updatedAt,
        ],
      );
    }
  }

  /**
   * Every Organization the reconcile should observe.
   *
   * `Archived` is excluded and `Suspended` is not. A suspended Organization can
   * be reactivated and its committed work is still waiting; an archived one is
   * terminal, so a projection row for it would describe a workflow nobody can
   * act on.
   */
  async organizationsToObserve(): Promise<readonly OrganizationId[]> {
    const result = await this.client.query<{ organization_id: string }>(
      `SELECT organization_id FROM organizations
        WHERE status <> 'Archived'
        ORDER BY organization_id`,
    );
    return result.rows.map((row) => OrganizationId(row.organization_id));
  }

  async removeOthers(keep: readonly OrganizationId[]): Promise<number> {
    const result = await this.client.query(
      `DELETE FROM organization_workflow_health
        WHERE NOT (organization_id = ANY($1::uuid[]))`,
      [keep],
    );
    return result.rowCount ?? 0;
  }
}
