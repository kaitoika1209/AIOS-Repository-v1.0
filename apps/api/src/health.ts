/**
 * Process health, as the four surfaces the architecture separates.
 *
 * `observability-and-operations.md` is explicit that "a combined green or red
 * status MUST NOT be used to represent all four concerns", and gives each
 * surface a different question:
 *
 *   HTTP liveness    Should this HTTP process be restarted?
 *   HTTP readiness   Can this process safely accept the traffic routed to it?
 *   Worker liveness  Should this Worker process be restarted?
 *   Worker readiness Can this Worker safely claim and process its work now?
 *
 * The distinction is not pedantry, it is the difference between a restart loop
 * and a brief outage. Liveness deliberately checks nothing that a restart cannot
 * repair: "HTTP liveness MUST NOT depend on PostgreSQL, Outbox lag, Worker
 * status, an AI provider, or the telemetry backend. A transient dependency
 * outage must not cause a restart loop." A liveness probe that pings the
 * database turns a thirty-second database blip into every replica restarting at
 * once, which is how a recoverable incident becomes an outage.
 *
 * The two asynchronous surfaces — workflow health and administrative
 * diagnostics — are not here. They are authorized, Organization-scoped queries
 * over durable facts, so they belong on the authenticated API rather than on an
 * unauthenticated probe port. `release-readiness.md` records them as the
 * remaining half of baseline item 8.
 */

import type { Pool } from "pg";

import { loadMigrations, planFor } from "@aios/persistence";

/**
 * A probe outcome.
 *
 * `Unknown` exists because the architecture requires it: "`Unknown` and `Stale`
 * are explicit outcomes. Missing evidence MUST NOT be presented as `Healthy`."
 * A check that could not run reports `Unknown`, never `Ready`.
 */
export type ProbeStatus = "Ready" | "Unready" | "Unknown";

/**
 * Why a probe reached its status.
 *
 * A closed set, because the architecture requires the diagnostic surface to
 * "use stable bounded reason codes rather than unbounded error text" — and
 * because a reason code derived from a driver's error message would leak the
 * connection details the same document forbids exposing.
 */
export type ReasonCode =
  | "OK"
  | "DATABASE_UNAVAILABLE"
  | "MIGRATIONS_PENDING"
  | "DATABASE_READ_ONLY"
  | "PROBE_TIMEOUT"
  | "LOOP_STALLED"
  | "SHUTTING_DOWN"
  | "ADMINISTRATIVELY_PAUSED";

export interface ProbeResult {
  readonly status: ProbeStatus;
  readonly reasonCode: ReasonCode;
}

/** How long a readiness check may take before it is reported as timed out. */
const PROBE_TIMEOUT_MS = Number.parseInt(process.env["PROBE_TIMEOUT_MS"] ?? "2000", 10);

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T | "timeout"> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    // Otherwise the timer alone keeps the process alive between probes.
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Everything both readiness surfaces need from PostgreSQL, in one round trip.
 *
 * One connection and one statement because readiness is polled continuously: a
 * probe that opened several connections would, under the pool exhaustion it is
 * meant to detect, become the thing making the process unready.
 */
const databaseState = async (
  pool: Pool,
): Promise<{ reachable: boolean; writable: boolean }> => {
  const client = await pool.connect();
  try {
    const result = await client.query<{ in_recovery: boolean; read_only: string }>(
      `SELECT pg_is_in_recovery() AS in_recovery,
              current_setting('transaction_read_only') AS read_only`,
    );
    const row = result.rows[0];
    return {
      reachable: true,
      // Both, because they fail differently: a replica answers reads happily
      // while every authoritative write fails, and the architecture requires
      // write-serving readiness to fail when "the process cannot atomically
      // persist the authoritative mutation, required audit, and Outbox record".
      writable: row !== undefined && !row.in_recovery && row.read_only === "off",
    };
  } finally {
    client.release();
  }
};

/**
 * Whether the schema the code expects is the schema the database has.
 *
 * The migration ledger (ADR-0020) makes this answerable rather than assumed: a
 * process whose migrations have not been applied will fail on its first real
 * query, and failing readiness instead keeps it out of the load balancer until
 * the migrator has run.
 */
const migrationsApplied = async (pool: Pool): Promise<boolean> => {
  const client = await pool.connect();
  try {
    const plan = await planFor(client, loadMigrations());
    return plan.pending.length === 0;
  } finally {
    client.release();
  }
};

const READY: ProbeResult = { status: "Ready", reasonCode: "OK" };

/**
 * Can this process safely accept the traffic routed to it?
 *
 * Note what is deliberately absent. A stopped Worker, an unavailable AI
 * provider, a lagging Outbox, and a stale projection are all listed by the
 * architecture as conditions that "MUST NOT" make HTTP readiness fail — they
 * are asynchronous workflow health, and taking the API out of rotation for them
 * would deny reads and writes that are still perfectly safe.
 */
export const httpReadiness = async (pool: Pool): Promise<ProbeResult> => {
  const state = await withTimeout(databaseState(pool), PROBE_TIMEOUT_MS).catch(
    () => null,
  );

  if (state === "timeout") return { status: "Unready", reasonCode: "PROBE_TIMEOUT" };
  if (state === null) return { status: "Unready", reasonCode: "DATABASE_UNAVAILABLE" };
  if (!state.writable) return { status: "Unready", reasonCode: "DATABASE_READ_ONLY" };

  const applied = await withTimeout(migrationsApplied(pool), PROBE_TIMEOUT_MS).catch(
    () => null,
  );

  if (applied === "timeout") return { status: "Unready", reasonCode: "PROBE_TIMEOUT" };
  // The database answered a moment ago, so this is not "unavailable" — it is a
  // check that could not be completed, which the architecture says to report as
  // `Unknown` rather than let pass as ready.
  if (applied === null) return { status: "Unknown", reasonCode: "DATABASE_UNAVAILABLE" };
  if (!applied) return { status: "Unready", reasonCode: "MIGRATIONS_PENDING" };

  return READY;
};

/**
 * Can this Worker safely claim and process its assigned work now?
 *
 * The same durable checks as HTTP readiness, for the same reasons: a Worker
 * cannot claim an Outbox row against a read-only database, and cannot claim one
 * at all if the Outbox schema is a migration behind.
 *
 * It also verifies what the architecture asks for last: "the Worker type is not
 * administratively paused". `pausedTypes` is the deployment-scoped pause
 * (ADR-0022), and it is checked before the database — a paused Worker is unready
 * whether or not PostgreSQL is reachable, and reporting `DATABASE_UNAVAILABLE`
 * for a process that was deliberately stopped would send an operator after the
 * wrong thing.
 *
 * Organization-scoped pauses are deliberately **not** checked here. The probe
 * answers for a process, and a process with one tenant paused is still able to
 * claim and process work for every other one. Reporting `Unready` for it would
 * present one Organization's containment as a platform fault — the inverse of
 * the failure the architecture names, where "global metrics can remain healthy
 * while one Organization is permanently blocked". That answer is
 * Organization-scoped, so it belongs in the Organization-scoped surface, and
 * `GET /admin/workflow-health` reports it.
 *
 * One thing the architecture asks for is still absent and recorded as a gap
 * rather than quietly assumed: "one Worker type becoming unready MUST NOT make
 * unrelated Worker types ... unready". Both types run in one loop here, so a
 * deployment pause of either makes the one process unready. Separating them is a
 * deployment-topology change, not a probe change.
 *
 * Readiness still "does not prove progress": a Worker can be ready and make
 * none, which is what asynchronous workflow health is for.
 */
export const workerReadiness = async (
  pool: Pool,
  pausedTypes: ReadonlySet<string> = new Set(),
): Promise<ProbeResult> => {
  if (pausedTypes.size > 0) {
    return { status: "Unready", reasonCode: "ADMINISTRATIVELY_PAUSED" };
  }
  return httpReadiness(pool);
};

/**
 * Is this Worker's loop still turning?
 *
 * The one liveness condition a restart can plausibly repair, and the reason
 * Worker liveness is not simply `200 OK`: the architecture asks it to detect "a
 * locally stalled execution loop", and distinguishes that from a long-running
 * operation. A drain that is slow is alive; a loop that stopped ticking is not.
 *
 * `staleAfterMs` must exceed the longest legitimate drain, or a busy Worker gets
 * restarted for doing its job.
 */
export const loopLiveness = (
  lastTickAt: Date | null,
  now: Date,
  staleAfterMs: number,
): ProbeResult => {
  // Before the first tick there is nothing to be stale. Reporting `Unready`
  // here would fail a Worker during its own startup.
  if (lastTickAt === null) return READY;
  return now.getTime() - lastTickAt.getTime() > staleAfterMs
    ? { status: "Unready", reasonCode: "LOOP_STALLED" }
    : READY;
};
