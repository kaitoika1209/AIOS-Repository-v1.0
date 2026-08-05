/**
 * The recovery status, against a real cluster.
 *
 * Built through the migration chain rather than `build/schema.sql`, for the
 * reason `diagnostics-query.test.ts` gives: a query the deployment path would
 * run should be tested against the schema the deployment path produces.
 *
 * The constraint tests here are as important as the query tests. The schema is
 * what stops a row claiming a failed restore *and* a four-minute achieved RPO,
 * and a constraint nobody has tried to violate is a constraint nobody knows
 * works.
 *
 * Skipped when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "./migrations.js";
import {
  PostgresRecoveryStatusQuery,
  recordRecoveryControlEvent,
  type RecoveryControlEvent,
} from "./recovery-status-query.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;
const SCHEMA = "test_recovery";

const at = (daysAgo: number): Date => new Date(Date.now() - daysAgo * 86_400_000);

const event = (over: Partial<RecoveryControlEvent> = {}): RecoveryControlEvent => ({
  id: randomUUID(),
  controlType: "RestoreTest",
  outcome: "Passed",
  performedAt: at(1),
  achievedRpoSeconds: 240,
  achievedRtoSeconds: 3_600,
  evidenceReference: "s3://aios-recovery-evidence/2026-08-04",
  performedBy: "restore-drill",
  ...over,
});

suite("the recovery status", () => {
  let pool: Pool;
  let query: PostgresRecoveryStatusQuery;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    } finally {
      client.release();
    }
    await migrate(pool);
    query = new PostgresRecoveryStatusQuery(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM recovery_control_events");
  });

  it("reports nothing known before any control event was recorded", async () => {
    const status = await query.read();

    // Not zero. A cluster that has never been restore-tested must not report a
    // restore test whose achieved RPO was zero seconds.
    expect(status.latestRestoreTest).toBeNull();
    expect(status.disasterRecoveryExerciseAt).toBeNull();
    expect(status.restoreTestFailureTotal).toBe(0);
    expect(status.backupIntegrityFailureTotal).toBe(0);
  });

  it("reads the latest restore test and its achieved figures", async () => {
    await recordRecoveryControlEvent(pool, event({ performedAt: at(40) }));
    await recordRecoveryControlEvent(
      pool,
      event({ performedAt: at(2), achievedRpoSeconds: 180, achievedRtoSeconds: 2_400 }),
    );

    const status = await query.read();

    expect(status.latestRestoreTest?.achievedRpoSeconds).toBe(180);
    expect(status.latestRestoreTest?.achievedRtoSeconds).toBe(2_400);
  });

  it("counts failures separately per control type", async () => {
    await recordRecoveryControlEvent(
      pool,
      event({ outcome: "Failed", achievedRpoSeconds: null, achievedRtoSeconds: null }),
    );
    await recordRecoveryControlEvent(
      pool,
      event({
        controlType: "BackupIntegrityCheck",
        outcome: "Failed",
        achievedRpoSeconds: null,
        achievedRtoSeconds: null,
      }),
    );

    const status = await query.read();

    expect(status.restoreTestFailureTotal).toBe(1);
    expect(status.backupIntegrityFailureTotal).toBe(1);
  });

  it("reports no achieved figures when the latest restore test failed", async () => {
    // A failing test is not a missing test — its failure is counted — but it
    // measured no RPO, so the achieved figures stay absent rather than falling
    // back to the last passing run's numbers. Reporting a four-minute RPO from
    // three months ago beside a failure from last night is how a status page
    // ends up describing a system that no longer exists.
    await recordRecoveryControlEvent(pool, event({ performedAt: at(40) }));
    await recordRecoveryControlEvent(
      pool,
      event({ performedAt: at(1), outcome: "Failed", achievedRpoSeconds: null, achievedRtoSeconds: null }),
    );

    const status = await query.read();

    expect(status.latestRestoreTest).toBeNull();
    expect(status.restoreTestFailureTotal).toBe(1);
  });

  it("leaves the provider-side facts unknown", async () => {
    // A self-managed cluster's restorable point is a property of the archive
    // destination, not of the database being asked. The RDS source overlays it;
    // guessing here would publish a confident age for a point nobody confirmed.
    const status = await query.read();

    expect(status.latestRestorablePointAt).toBeNull();
    expect(status.pitrWindowDays).toBeNull();
  });

  it("reports no WAL archive lag on a cluster that has never archived", async () => {
    // `archive_mode` off means `pg_stat_archiver.last_archived_time` is null.
    // The metric is withheld rather than published as zero, which would read as
    // "archived a moment ago" for a cluster with no recovery window at all.
    const status = await query.read();

    expect(status.walArchiveLagSeconds).toBeNull();
  });

  it("counts no unprovable external effects, because no consumer declares one", async () => {
    // Derived from the registry rather than hardcoded: `memory-generation` is
    // ExternalComputation, which ADR-0004 defines as safe to retry. The query
    // runs either way, so registering an ExternalBusinessEffect consumer starts
    // this measuring without another change here.
    const status = await query.read();

    expect(status.externalEffectUnknownTotal).toBe(0);
  });
});

suite("the recovery control constraints", () => {
  let pool: Pool;
  const SCHEMA_C = "test_recovery_constraints";

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA_C}` });
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA_C} CASCADE; CREATE SCHEMA ${SCHEMA_C};`);
    } finally {
      client.release();
    }
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses a failed restore test that claims achieved figures", async () => {
    // The false reassurance the whole section exists to prevent, refused by the
    // database rather than by a reviewer.
    await expect(
      recordRecoveryControlEvent(pool, event({ outcome: "Failed" })),
    ).rejects.toThrow(/ck_recovery_control_achieved/);
  });

  it("refuses a passing restore test that measured nothing", async () => {
    await expect(
      recordRecoveryControlEvent(
        pool,
        event({ achievedRpoSeconds: null, achievedRtoSeconds: null }),
      ),
    ).rejects.toThrow(/ck_recovery_control_achieved/);
  });

  it("refuses a control type nobody defined", async () => {
    // The achieved figures are null here so that this row violates exactly one
    // constraint. With them present it is refused by `ck_recovery_control_achieved`
    // instead — the same rejection for a different reason, which would have
    // made this test pass while proving nothing about the type check.
    await expect(
      recordRecoveryControlEvent(
        pool,
        event({
          controlType: "Vibes" as RecoveryControlEvent["controlType"],
          achievedRpoSeconds: null,
          achievedRtoSeconds: null,
        }),
      ),
    ).rejects.toThrow(/ck_recovery_control_type/);
  });

  it("refuses a negative achieved figure", async () => {
    await expect(
      recordRecoveryControlEvent(pool, event({ achievedRtoSeconds: -1 })),
    ).rejects.toThrow(/ck_recovery_control_achieved_sign/);
  });
});
