/**
 * That losing the database does not end the process.
 *
 * This exists because it happened. Stopping PostgreSQL under a running API — to
 * check that readiness reported the outage — killed both the API and the Worker
 * outright, before either probe could answer. `pg.Pool` emits `error` when an
 * idle connection dies, and an `'error'` event with no listener is rethrown by
 * Node and terminates the process.
 *
 * A restart is the worst possible response to a transient database outage: every
 * replica restarts at once, each reconnects at once, and the database comes back
 * to a thundering herd. The observability architecture says so directly — "A
 * transient dependency outage must not cause a restart loop."
 *
 * Skipped when DATABASE_URL is unset.
 */

import { describe, expect, it } from "vitest";

import { createPool } from "./pool.js";

const url = process.env["DATABASE_URL"];
const describeDb = url === undefined ? describe.skip : describe;

describeDb("a pool whose connection is killed underneath it", () => {
  it("survives, and serves the next query", async () => {
    const pool = createPool({ connectionString: url });
    const killer = createPool({ connectionString: url });

    try {
      // Establish an idle connection: the failure only occurs for a connection
      // sitting in the pool, not one with a query in flight.
      const before = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = before.rows[0]?.pid;
      expect(pid).toBeGreaterThan(0);

      // What a PostgreSQL restart, a failover, or an idle timeout on a proxy
      // does to every connection at once.
      //
      // Note what this test can and cannot show. Vitest installs its own
      // process-level handlers, so without `createPool`'s listener the run fails
      // with an unhandled error and a non-zero exit — but the worker does not
      // actually die, and these assertions still pass. The regression is caught
      // by the run failing, not by the expectations below. Under plain `node`
      // the same event ends the process, which is what was observed and is the
      // thing being prevented.
      await killer.query("SELECT pg_terminate_backend($1)", [pid]);

      // Long enough for the socket error to surface on the idle client.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // The real assertion is that this line runs at all. That it also returns
      // the right answer shows the pool healed rather than merely survived: `pg`
      // discarded the dead client and opened a fresh connection.
      const after = await pool.query<{ ok: number }>("SELECT 1 AS ok");
      expect(after.rows[0]?.ok).toBe(1);
      expect(after.rows[0]).toBeDefined();
    } finally {
      await pool.end();
      await killer.end();
    }
  });
});
