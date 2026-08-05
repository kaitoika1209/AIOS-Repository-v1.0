/**
 * Health probes, checked against the conditions they exist to catch.
 *
 * A readiness probe that returns `Ready` unconditionally passes every test
 * written against a working database, so most of this file is about arranging
 * the failures: a database that is not there, migrations that have not run, a
 * database that answers reads and refuses writes. Each is a real production
 * state, and a probe that misses one is worse than no probe — an orchestrator
 * routes traffic to the instance and trusts it.
 *
 * Skipped when DATABASE_URL is unset, like the other database-backed suites.
 */

import { Pool } from "pg";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "@aios/persistence";

import { httpReadiness, loopLiveness, workerReadiness } from "./health.js";

const url = process.env["DATABASE_URL"];
const describeDb = url === undefined ? describe.skip : describe;

/**
 * Databases created for this file alone.
 *
 * `health_migrated` gets the migration chain; `health_pending` deliberately does
 * not, which is the only way to observe the pending-migration branch.
 */
const MIGRATED = "aios_health_migrated";
const PENDING = "aios_health_pending";

const urlFor = (database: string): string => {
  const parsed = new URL(url ?? "");
  parsed.pathname = `/${database}`;
  return parsed.toString();
};

let admin: Pool;
let migrated: Pool;
let pending: Pool;

describeDb("process health probes", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    for (const name of [MIGRATED, PENDING]) {
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.query(`CREATE DATABASE ${name}`);
    }

    migrated = new Pool({ connectionString: urlFor(MIGRATED) });
    await migrate(migrated, {});

    pending = new Pool({ connectionString: urlFor(PENDING) });
  }, 60_000);

  afterAll(async () => {
    await migrated?.end();
    await pending?.end();
    for (const name of [MIGRATED, PENDING]) {
      await admin?.query(`DROP DATABASE IF EXISTS ${name}`);
    }
    await admin?.end();
  });

  describe("HTTP readiness", () => {
    it("is ready when the schema is current and the database writable", async () => {
      expect(await httpReadiness(migrated)).toEqual({
        status: "Ready",
        reasonCode: "OK",
      });
    });

    it("refuses when migrations have not been applied", async () => {
      // The failure this prevents: a deploy where the image shipped but the
      // migrator did not run. Without the check the process joins the load
      // balancer and fails every request against a schema that isn't there.
      expect(await httpReadiness(pending)).toEqual({
        status: "Unready",
        reasonCode: "MIGRATIONS_PENDING",
      });
    });

    it("refuses when the database is unreachable", async () => {
      const nowhere = new Pool({
        connectionString: urlFor(MIGRATED).replace(/:\d+\//, ":1/"),
        // Otherwise the pool retries past the probe's own timeout and the test
        // observes PROBE_TIMEOUT instead of the connection failure.
        connectionTimeoutMillis: 500,
      });
      try {
        expect(await httpReadiness(nowhere)).toEqual({
          status: "Unready",
          reasonCode: "DATABASE_UNAVAILABLE",
        });
      } finally {
        await nowhere.end();
      }
    });

    it("refuses when the database will not accept writes", async () => {
      // A read-only database answers `SELECT 1` perfectly. Every authoritative
      // write, its audit row, and its Outbox record fail — which is precisely
      // the state the architecture says write-serving readiness must catch, and
      // precisely the one a connectivity check reports as healthy.
      await admin.query(
        `ALTER DATABASE ${MIGRATED} SET default_transaction_read_only = on`,
      );
      const readOnly = new Pool({ connectionString: urlFor(MIGRATED) });
      try {
        expect(await httpReadiness(readOnly)).toEqual({
          status: "Unready",
          reasonCode: "DATABASE_READ_ONLY",
        });
      } finally {
        await readOnly.end();
        await admin.query(
          `ALTER DATABASE ${MIGRATED} RESET default_transaction_read_only`,
        );
      }
    });

    it("is ready again once the database is writable", async () => {
      // Guards the reset above: a probe that latched Unready would make the
      // previous test poison every one after it.
      expect((await httpReadiness(migrated)).status).toBe("Ready");
    });
  });

  describe("Worker readiness", () => {
    it("requires the same durable conditions as the API", async () => {
      // Not because the two are interchangeable, but because a Worker cannot
      // claim an Outbox row against a read-only database or a stale schema
      // either.
      expect(await workerReadiness(migrated)).toEqual({
        status: "Ready",
        reasonCode: "OK",
      });
      expect((await workerReadiness(pending)).reasonCode).toBe("MIGRATIONS_PENDING");
    });

    it("is unready when the Worker type is administratively paused", async () => {
      // The architecture requires readiness to verify "the Worker type is not
      // administratively paused" (ADR-0022). Before pause existed there was
      // nothing to read, and the check was recorded as a gap.
      expect(await workerReadiness(migrated, new Set(["MemoryGeneration"]))).toEqual({
        status: "Unready",
        reasonCode: "ADMINISTRATIVELY_PAUSED",
      });
    });

    it("reports the pause even when the database is unreachable", async () => {
      // Checked before the database on purpose. Reporting DATABASE_UNAVAILABLE
      // for a Worker that was deliberately stopped would send an operator after
      // the wrong thing.
      const unreachable = new Pool({
        connectionString: "postgresql://nobody@127.0.0.1:1/none",
        connectionTimeoutMillis: 200,
      });
      unreachable.on("error", () => {});
      try {
        expect(
          (await workerReadiness(unreachable, new Set(["OutboxPublication"]))).reasonCode,
        ).toBe("ADMINISTRATIVELY_PAUSED");
      } finally {
        await unreachable.end();
      }
    });

    it("is ready when nothing is paused", async () => {
      // An Organization-scoped pause never reaches here: the probe answers for a
      // process, and a process with one tenant paused can still claim and process
      // for every other one.
      expect((await workerReadiness(migrated, new Set())).status).toBe("Ready");
    });
  });
});

describe("Worker liveness", () => {
  const now = new Date("2026-08-04T12:00:00Z");

  it("is alive before the first tick", () => {
    // A Worker still starting has no tick to be stale. Reporting Unready here
    // would have the supervisor restart it during its own startup, forever.
    expect(loopLiveness(null, now, 60_000)).toEqual({
      status: "Ready",
      reasonCode: "OK",
    });
  });

  it("is alive while the loop is turning", () => {
    const recent = new Date(now.getTime() - 5_000);
    expect(loopLiveness(recent, now, 60_000).status).toBe("Ready");
  });

  it("reports a stalled loop", () => {
    const old = new Date(now.getTime() - 120_000);
    expect(loopLiveness(old, now, 60_000)).toEqual({
      status: "Unready",
      reasonCode: "LOOP_STALLED",
    });
  });

  it("does not call a slow drain a stall", () => {
    // The distinction the architecture draws: liveness "MUST distinguish an
    // active long-running operation from a dead Worker". A drain lasting just
    // under the threshold is working, not dead.
    const busy = new Date(now.getTime() - 59_000);
    expect(loopLiveness(busy, now, 60_000).status).toBe("Ready");
  });
});
