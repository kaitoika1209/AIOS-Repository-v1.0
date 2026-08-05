/**
 * The gauges baseline item 6 names: PostgreSQL, Outbox, Worker, queue age, and
 * Work-to-Memory.
 *
 * Sampled on a schedule rather than incremented at a call site, because every
 * one of them is a *level* rather than an event. "How many Outbox rows are
 * pending" is a question about the table, and a counter maintained in memory
 * would drift from it the first time a process restarted or a second replica
 * appeared.
 *
 * **No `organizationId` dimension, on any of them.** These are aggregates across
 * the deployment, which is what a metric backend is allowed to hold — ADR-0003
 * forbids tenant identifiers in dimensions, and the architecture says the same
 * thing from the other side: "Metric backends receive only bounded aggregate
 * status counts; Organization identifiers remain in PostgreSQL, logs, traces,
 * and authorized diagnostic results." The per-Organization answer is
 * `GET /admin/workflow-health`, which is authorized.
 */

import type { Pool } from "pg";

import { describeError, getLogger, getMetrics } from "@aios/application";

interface Levels {
  outbox_pending: number;
  outbox_claimed: number;
  outbox_failed: number;
  outbox_oldest_seconds: number;
  consumer_pending: number;
  consumer_oldest_seconds: number;
  claim_expired: number;
  generation_pending: number;
  generation_failed: number;
  generation_oldest_seconds: number;
}

/**
 * One statement for every level.
 *
 * A single round trip because this runs on a timer against the same database
 * the Workers are competing for: ten separate queries on a schedule is ten
 * chances to be the load somebody blames. Everything is a bare aggregate over
 * indexed columns.
 */
const LEVELS_SQL = `
  SELECT
    (SELECT count(*) FROM outbox_messages WHERE status = 'Pending')            AS outbox_pending,
    (SELECT count(*) FROM outbox_messages WHERE status = 'Claimed')            AS outbox_claimed,
    (SELECT count(*) FROM outbox_messages WHERE status = 'Failed')             AS outbox_failed,
    (SELECT coalesce(EXTRACT(EPOCH FROM (now() - min(recorded_at))), 0)
       FROM outbox_messages WHERE status <> 'Published')                       AS outbox_oldest_seconds,
    (SELECT count(*) FROM processed_events
      WHERE status NOT IN ('Processed', 'Skipped'))                            AS consumer_pending,
    (SELECT coalesce(EXTRACT(EPOCH FROM (now() - min(first_received_at))), 0)
       FROM processed_events WHERE status NOT IN ('Processed', 'Skipped'))     AS consumer_oldest_seconds,
    (SELECT count(*) FROM outbox_messages
      WHERE status = 'Claimed' AND locked_until IS NOT NULL
        AND locked_until < now())                                              AS claim_expired,
    (SELECT count(*) FROM memory_generation_operations
      WHERE status NOT IN ('Generated', 'Failed', 'Abandoned'))                AS generation_pending,
    (SELECT count(*) FROM memory_generation_operations WHERE status = 'Failed') AS generation_failed,
    (SELECT coalesce(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)
       FROM memory_generation_operations
      WHERE status NOT IN ('Generated', 'Failed', 'Abandoned'))                AS generation_oldest_seconds
`;

const publish = (levels: Levels, pool: Pool): void => {
  const metrics = getMetrics();

  metrics.gauge("outbox_pending_total", levels.outbox_pending);
  metrics.gauge("outbox_claimed_total", levels.outbox_claimed);
  metrics.gauge("outbox_failed_total", levels.outbox_failed);
  metrics.gauge("outbox_oldest_pending_age_seconds", levels.outbox_oldest_seconds);

  metrics.gauge("consumer_pending_total", levels.consumer_pending);
  metrics.gauge("consumer_oldest_pending_age_seconds", levels.consumer_oldest_seconds);
  metrics.gauge("worker_claim_expired_total", levels.claim_expired);

  metrics.gauge("memory_generation_pending_total", levels.generation_pending);
  metrics.gauge("memory_generation_failed_total", levels.generation_failed);
  metrics.gauge(
    "memory_generation_oldest_pending_age_seconds",
    levels.generation_oldest_seconds,
  );

  // Read from the driver rather than the database: these are *this process's*
  // connections, and pool exhaustion is a per-process condition. `waiting` is
  // the one that matters — connections in use is normal, callers queued behind
  // them is the runbook's connection-pool exhaustion arriving.
  metrics.gauge("db_pool_connections_total", pool.totalCount);
  metrics.gauge("db_pool_idle_total", pool.idleCount);
  metrics.gauge("db_pool_waiting_total", pool.waitingCount);
};

/**
 * Sample the levels on a schedule until stopped.
 *
 * Failure is logged and the loop continues. A collector that threw would take
 * down the process it was measuring, which is the exact inversion the bounded
 * exporter exists to prevent — and a database too unwell to answer an aggregate
 * is a condition the probes and the diagnostic surface already report.
 */
export const startMetricsCollector = (
  pool: Pool,
  intervalMs: number,
): (() => void) => {
  let stopped = false;

  const sample = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await pool.query<Record<keyof Levels, string>>(LEVELS_SQL);
      const row = result.rows[0];
      if (row === undefined) return;
      publish(
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, Number(value)]),
        ) as unknown as Levels,
        pool,
      );
    } catch (error) {
      getLogger().log({
        severity: "WARN",
        operationalLogName: "metrics.collection_failed",
        operationalLogClass: "Operations",
        operationalLogCategory: "Operations",
        message: "Operational levels could not be sampled; they will be retried.",
        outcome: "Failure",
        attributes: describeError(error),
      });
    }
  };

  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref();
  void sample();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
};
