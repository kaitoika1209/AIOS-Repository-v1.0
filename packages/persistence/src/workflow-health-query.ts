/**
 * Asynchronous workflow health, derived live from the durable facts (ADR-0021).
 *
 * No projection table. ADR-0021 records why the live query comes first: the
 * `organization_workflow_health` projection exists to precompute what this asks
 * for, and building it before the query existed would have been guessing at the
 * shape. It also adds a failure mode this does not have — a projection can be
 * stale, and stale must not read as healthy.
 *
 * Every query is scoped by `organization_id`, which all four tables carry. That
 * is not a convention here, it is the difference between an operational answer
 * and a tenant-isolation break.
 */

import type { PoolClient } from "pg";

import type { OrganizationId } from "@aios/types";
import {
  describeError,
  getLogger,
  type WorkflowCounts,
  type WorkflowHealthQuery,
  type WorkflowType,
} from "@aios/application";

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
           -- age is not what makes it serious. It is Critical on arrival.
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
}
