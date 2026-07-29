/**
 * PostgreSQL event recovery repository (ADR-0015).
 *
 * Two statements, both scoped by `organization_id` in the SQL itself rather than
 * by a check the caller could omit. That is the authorization document's rule
 * made structural: "the immutable source event determines `organizationId`", and
 * a recovery request cannot name another one.
 *
 * Neither statement selects `payload`, `headers`, `actor_reference`, or
 * `last_error_message`. An operator inspecting a delivery failure needs to know
 * what failed and why it failed, not what the business content was.
 */

import type { PoolClient } from "pg";

import type { OrganizationId } from "@aios/types";
import type {
  EventRecoveryRepository,
  FailedEventSummary,
} from "@aios/application";

interface FailedRow {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string | number;
  attempt_count: number;
  last_error_code: string | null;
  occurred_at: Date;
  last_attempt_at: Date | null;
}

export class PostgresEventRecoveryRepository implements EventRecoveryRepository {
  constructor(private readonly client: PoolClient) {}

  async listFailed(
    organizationId: OrganizationId,
    limit: number,
  ): Promise<readonly FailedEventSummary[]> {
    const result = await this.client.query<FailedRow>(
      `SELECT event_id, event_type, aggregate_type, aggregate_id,
              aggregate_version, attempt_count, last_error_code,
              occurred_at, last_attempt_at
         FROM outbox_messages
        WHERE organization_id = $1
          AND status = 'Failed'
        ORDER BY last_attempt_at DESC NULLS LAST, recorded_at DESC
        LIMIT $2`,
      [organizationId, limit],
    );

    return result.rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      // `aggregate_version` is bigint, which the driver returns as a string.
      aggregateVersion: Number(row.aggregate_version),
      attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code,
      occurredAt: row.occurred_at,
      lastAttemptAt: row.last_attempt_at,
    }));
  }

  async retryFailed(
    organizationId: OrganizationId,
    eventId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE outbox_messages
          SET status = 'Pending',
              next_attempt_at = $3,
              locked_by = NULL,
              locked_until = NULL
        WHERE organization_id = $1
          AND event_id = $2
          AND status = 'Failed'`,
      [organizationId, eventId, now],
    );

    // `attempt_count`, `last_error_code`, and `first_attempt_at` are left
    // alone. They are the evidence of how hard the system already tried;
    // clearing them would let a poisonous message cycle indefinitely while
    // looking untouched each time.
    return (result.rowCount ?? 0) > 0;
  }
}
