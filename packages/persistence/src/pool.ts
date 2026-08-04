/**
 * Connection pools that survive losing the database.
 *
 * `pg.Pool` emits an `error` event when a connection dies while sitting idle —
 * a PostgreSQL restart, a failover, an idle timeout on a proxy, an
 * administrator running `pg_terminate_backend`. In Node, an `'error'` event with
 * no listener is not ignored: it is rethrown, and the process exits.
 *
 * So a `new Pool(...)` with no error handler means a routine database restart
 * kills every API and Worker process attached to it. That is not a degraded
 * mode, it is a crash loop, and it directly contradicts what the observability
 * architecture requires of liveness: "A transient dependency outage must not
 * cause a restart loop."
 *
 * It was found by stopping PostgreSQL under a running API to check that the
 * probes reported the outage correctly. They never got the chance — both
 * processes were gone before the first probe.
 *
 * The handler does nothing but log. That is the correct amount: `pg` has already
 * discarded the broken client, and the next checkout opens a fresh connection.
 * The pool recovers on its own once the database is back; all that was ever
 * needed was for someone to be listening.
 */

import { Pool, type PoolConfig } from "pg";

import { describeError, getLogger } from "@aios/application";

/**
 * A pool that logs idle-connection failures instead of exiting.
 *
 * Every entry point should use this rather than `new Pool` directly. There is
 * no configuration difference — the only thing it adds is the listener whose
 * absence is fatal.
 */
export const createPool = (config: PoolConfig): Pool => {
  const pool = new Pool(config);

  pool.on("error", (error) => {
    // Not thrown onward, and not counted as a request failure: no caller is
    // waiting on an idle client. A query that was in flight rejects through its
    // own promise and is handled where it was issued.
    getLogger().log({
      severity: "WARN",
      operationalLogName: "database.idle_connection_lost",
      operationalLogClass: "Operations",
      operationalLogCategory: "Operations",
      message: "An idle database connection was lost; the pool will reconnect.",
      outcome: "Failure",
      attributes: describeError(error),
    });
  });

  return pool;
};
