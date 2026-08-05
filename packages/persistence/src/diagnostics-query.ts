/**
 * Correlated operational evidence, from the durable tables (ADR-0023).
 *
 * Everything the diagnostic surface reports is a count, an age, or a bounded
 * code read out of a column. Nothing here reads a message, a payload, or a
 * prompt, and nothing is assembled from an exception — which is how the
 * architecture's rule is kept structurally rather than by remembering to redact:
 *
 *     redact secrets, connection strings, raw exception messages, prompts, and
 *     business content
 *
 * `last_error_message` exists on `outbox_messages` and is never selected here.
 * The `errorCode` columns are, because a code is a closed vocabulary the code
 * itself chose, while a message routinely quotes the row that caused it.
 *
 * Every query names `organization_id`. There is no variant that omits it.
 */

import type { PoolClient } from "pg";

import type { OrganizationId } from "@aios/types";
import type {
  DiagnosticsFacts,
  DiagnosticsQueryPort,
  ErrorCodeCount,
} from "@aios/application";

interface CodeRow {
  error_code: string | null;
  count: string;
}

interface StatusRow {
  status: string;
  count: string;
}

const toCodes = (rows: readonly CodeRow[]): ErrorCodeCount[] =>
  rows
    .filter((row): row is CodeRow & { error_code: string } => row.error_code !== null)
    .map((row) => ({ errorCode: row.error_code, count: Number(row.count) }));

const toStatuses = (rows: readonly StatusRow[]): Record<string, number> =>
  Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));

export class PostgresDiagnosticsQuery implements DiagnosticsQueryPort {
  constructor(private readonly client: PoolClient) {}

  async gather(
    organizationId: OrganizationId,
    since: Date,
    limit: number,
  ): Promise<DiagnosticsFacts> {
    const outbox = await this.client.query<{
      pending: string;
      failed: string;
      claim_expired: string;
      oldest_seconds: string | null;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'Pending') AS pending,
              count(*) FILTER (WHERE status = 'Failed') AS failed,
              -- Claimed with an expired lease: not Pending, so nothing claims
              -- it, and not Published, so nothing finished it. The state that
              -- looks like nothing and is why work stops.
              count(*) FILTER (
                WHERE status = 'Claimed' AND locked_until IS NOT NULL AND locked_until < now()
              ) AS claim_expired,
              EXTRACT(EPOCH FROM (
                now() - min(recorded_at) FILTER (WHERE status <> 'Published')
              ))::bigint AS oldest_seconds
         FROM outbox_messages
        WHERE organization_id = $1`,
      [organizationId],
    );

    const outboxCodes = await this.client.query<CodeRow>(
      `SELECT last_error_code AS error_code, count(*) AS count
         FROM outbox_messages
        WHERE organization_id = $1
          AND last_error_code IS NOT NULL
          AND last_attempt_at >= $2
        GROUP BY last_error_code
        ORDER BY count(*) DESC
        LIMIT $3`,
      [organizationId, since, limit],
    );

    const deliveries = await this.client.query<{
      processing: string;
      failed: string;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'Processing') AS processing,
              count(*) FILTER (WHERE status = 'Failed') AS failed
         FROM processed_events
        WHERE organization_id = $1`,
      [organizationId],
    );

    const blocked = await this.client.query<{ count: string }>(
      // By status rather than by `blocked_event_id IS NOT NULL`: the status is
      // the column the state machine transitions, and a key can be `Recovering`
      // with the blocked identifier still set.
      `SELECT count(*) AS count
         FROM consumer_ordering_state
        WHERE organization_id = $1 AND status = 'Blocked'`,
      [organizationId],
    );

    const deadLetters = await this.client.query<StatusRow>(
      `SELECT status, count(*) AS count
         FROM dead_letter_events
        WHERE organization_id = $1
        GROUP BY status`,
      [organizationId],
    );

    const deliveryCodes = await this.client.query<CodeRow>(
      `SELECT error_code, count(*) AS count
         FROM dead_letter_events
        WHERE organization_id = $1 AND last_failed_at >= $2
        GROUP BY error_code
        ORDER BY count(*) DESC
        LIMIT $3`,
      [organizationId, since, limit],
    );

    const generation = await this.client.query<StatusRow>(
      `SELECT status, count(*) AS count
         FROM memory_generation_operations
        WHERE organization_id = $1
        GROUP BY status`,
      [organizationId],
    );

    const generationDetail = await this.client.query<{
      lease_expired: string;
      oldest_seconds: string | null;
    }>(
      `SELECT count(*) FILTER (
                WHERE status = 'Generating'
                  AND locked_until IS NOT NULL
                  AND locked_until < now()
              ) AS lease_expired,
              EXTRACT(EPOCH FROM (
                now() - min(created_at) FILTER (
                  WHERE status NOT IN ('Generated', 'Failed', 'Abandoned')
                )
              ))::bigint AS oldest_seconds
         FROM memory_generation_operations
        WHERE organization_id = $1`,
      [organizationId],
    );

    const generationCodes = await this.client.query<CodeRow>(
      `SELECT last_error_code AS error_code, count(*) AS count
         FROM memory_generation_operations
        WHERE organization_id = $1
          AND last_error_code IS NOT NULL
          AND updated_at >= $2
        GROUP BY last_error_code
        ORDER BY count(*) DESC
        LIMIT $3`,
      [organizationId, since, limit],
    );

    // Not Organization-scoped, and correctly so: it is the schema this process
    // runs against, which is the same for every tenant. It is here because two
    // replicas mid-deploy disagreeing about it explains a whole class of
    // symptoms that look like data corruption.
    //
    // `to_regclass` rather than a query that might throw. The ledger is created
    // by the migration runner, so a database built another way — a test schema
    // applied from the documented DDL, a restored cluster mid-recovery — does
    // not have it. Reporting `null` for one of seven sections is a smaller
    // failure than returning nothing, and a diagnostic surface that dies when a
    // fact is unavailable dies exactly when it is needed.
    //
    // A `try`/`catch` would not do: a failed statement aborts the surrounding
    // transaction, so the catch would survive and the commit would not.
    const ledger = await this.client.query<{ present: boolean }>(
      `SELECT to_regclass('schema_migrations') IS NOT NULL AS present`,
    );
    const schema = ledger.rows[0]?.present
      ? await this.client.query<{ version: string }>(
          `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
        )
      : { rows: [] as { version: string }[] };

    const outboxRow = outbox.rows[0];
    const deliveryRow = deliveries.rows[0];
    const generationRow = generationDetail.rows[0];

    return {
      outbox: {
        pending: Number(outboxRow?.pending ?? 0),
        failed: Number(outboxRow?.failed ?? 0),
        claimExpired: Number(outboxRow?.claim_expired ?? 0),
        oldestPendingSeconds:
          outboxRow?.oldest_seconds == null ? null : Number(outboxRow.oldest_seconds),
        errorCodes: toCodes(outboxCodes.rows),
      },
      deliveries: {
        processing: Number(deliveryRow?.processing ?? 0),
        failed: Number(deliveryRow?.failed ?? 0),
        blockedOrderingKeys: Number(blocked.rows[0]?.count ?? 0),
        deadLettersByStatus: toStatuses(deadLetters.rows),
        errorCodes: toCodes(deliveryCodes.rows),
      },
      generation: {
        byStatus: toStatuses(generation.rows),
        leaseExpired: Number(generationRow?.lease_expired ?? 0),
        oldestPendingSeconds:
          generationRow?.oldest_seconds == null
            ? null
            : Number(generationRow.oldest_seconds),
        errorCodes: toCodes(generationCodes.rows),
      },
      schemaVersion: schema.rows[0]?.version ?? null,
    };
  }
}
