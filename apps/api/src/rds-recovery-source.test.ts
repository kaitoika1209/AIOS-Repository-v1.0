/**
 * The provider overlay, and what happens when the provider does not answer.
 *
 * The degradation is the interesting case. A throttled control-plane call has
 * nothing to do with when the last restore test ran, and a source that failed
 * the whole read would withhold eight healthy metrics because of two.
 */

import { describe, expect, it } from "vitest";

import type { RecoveryStatus, RecoveryStatusSource } from "@aios/application";

import { RdsRecoveryStatusSource, type RdsBackupFacts } from "./rds-recovery-source.js";

const LOCAL: RecoveryStatus = {
  walArchiveLagSeconds: 8,
  latestRestorablePointAt: null,
  pitrWindowDays: null,
  backupIntegrityFailureTotal: 0,
  restoreTestFailureTotal: 1,
  latestRestoreTest: {
    at: new Date("2026-08-01T00:00:00.000Z"),
    achievedRpoSeconds: 240,
    achievedRtoSeconds: 3_600,
  },
  disasterRecoveryExerciseAt: new Date("2026-07-01T00:00:00.000Z"),
  externalEffectUnknownTotal: 0,
};

const local: RecoveryStatusSource = { read: async () => LOCAL };

describe("the RDS overlay", () => {
  it("fills in the two facts only the provider knows", async () => {
    const facts: RdsBackupFacts = {
      describe: async () => ({
        latestRestorableTime: new Date("2026-08-05T11:55:00.000Z"),
        backupRetentionDays: 14,
      }),
    };

    const status = await new RdsRecoveryStatusSource(local, facts, "aios-production").read();

    expect(status.latestRestorablePointAt).toEqual(new Date("2026-08-05T11:55:00.000Z"));
    expect(status.pitrWindowDays).toBe(14);
    expect(status.walArchiveLagSeconds).toBe(8);
  });

  it("keeps the eight local metrics when the provider call fails", async () => {
    const facts: RdsBackupFacts = {
      describe: async () => {
        throw new Error("Rate exceeded");
      },
    };

    const status = await new RdsRecoveryStatusSource(local, facts, "aios-production").read();

    expect(status.latestRestorablePointAt).toBeNull();
    expect(status.pitrWindowDays).toBeNull();
    // Still published: the restore-test age has nothing to do with a throttled
    // DescribeDBInstances, and withholding it would turn one provider hiccup
    // into a blank recovery dashboard.
    expect(status.latestRestoreTest?.achievedRpoSeconds).toBe(240);
    expect(status.restoreTestFailureTotal).toBe(1);
  });

  it("reports an unknown restorable point rather than inventing one", async () => {
    // An instance with automated backups disabled has no LatestRestorableTime.
    // The overlay must pass the absence through: a restorable point this process
    // computed would be an assertion about someone else's archive.
    const facts: RdsBackupFacts = {
      describe: async () => ({ latestRestorableTime: null, backupRetentionDays: 0 }),
    };

    const status = await new RdsRecoveryStatusSource(local, facts, "aios-production").read();

    expect(status.latestRestorablePointAt).toBeNull();
    expect(status.pitrWindowDays).toBe(0);
  });
});
