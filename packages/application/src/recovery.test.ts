/**
 * What the recovery metrics claim, and what they refuse to claim.
 *
 * Most of these tests are about absence. The architecture's whole point in
 * naming ten separate metrics is that "backup-job success is not proof of
 * recoverability", and the way that lesson gets undone in practice is a metric
 * that reports zero for something nobody measured.
 */

import { describe, expect, it } from "vitest";

import { Metrics, type MetricSample, type MetricSink } from "./metrics.js";
import {
  DR_EXERCISE_MAX_AGE_SECONDS,
  RECOVERY_METRICS,
  RESTORE_TEST_MAX_AGE_SECONDS,
  RPO_ALARM_SECONDS,
  RPO_SECONDS,
  ageSeconds,
  publishRecoveryMetrics,
  startRecoveryReporter,
  type RecoveryStatus,
} from "./recovery.js";

class CapturingSink implements MetricSink {
  readonly samples: MetricSample[] = [];
  emit(samples: readonly MetricSample[]): void {
    this.samples.push(...samples);
  }
  async shutdown(): Promise<boolean> {
    return true;
  }
}

const NOW = new Date("2026-08-05T12:00:00.000Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

const known: RecoveryStatus = {
  walArchiveLagSeconds: 12,
  latestRestorablePointAt: ago(300),
  pitrWindowDays: 14,
  backupIntegrityFailureTotal: 0,
  restoreTestFailureTotal: 0,
  latestRestoreTest: { at: ago(86_400), achievedRpoSeconds: 240, achievedRtoSeconds: 3_600 },
  disasterRecoveryExerciseAt: ago(86_400 * 30),
  externalEffectUnknownTotal: 0,
};

const unknown: RecoveryStatus = {
  walArchiveLagSeconds: null,
  latestRestorablePointAt: null,
  pitrWindowDays: null,
  backupIntegrityFailureTotal: 0,
  restoreTestFailureTotal: 0,
  latestRestoreTest: null,
  disasterRecoveryExerciseAt: null,
  externalEffectUnknownTotal: 0,
};

const published = (sink: CapturingSink): Map<string, number> =>
  new Map(sink.samples.map((s) => [s.name, s.value]));

describe("publishing", () => {
  it("publishes all ten when everything is known", () => {
    const sink = new CapturingSink();
    const withheld = publishRecoveryMetrics(known, NOW, new Metrics(sink, "aios-worker"));

    expect(withheld).toEqual([]);
    expect([...published(sink).keys()].sort()).toEqual([...RECOVERY_METRICS].sort());
  });

  it("turns timestamps into ages", () => {
    const sink = new CapturingSink();
    publishRecoveryMetrics(known, NOW, new Metrics(sink, "aios-worker"));
    const values = published(sink);

    expect(values.get("latest_restorable_point_age_seconds")).toBe(300);
    expect(values.get("restore_test_age_seconds")).toBe(86_400);
    expect(values.get("disaster_recovery_exercise_age_seconds")).toBe(86_400 * 30);
  });

  it("withholds what is not known rather than publishing zero", () => {
    // The test this file exists for. A zero here is a flat green line meaning
    // "recoverable to this instant" for a database nobody can prove is
    // recoverable at all — the exact false reassurance these metrics were
    // written to prevent, arriving through the metric that prevents it.
    const sink = new CapturingSink();
    const withheld = publishRecoveryMetrics(unknown, NOW, new Metrics(sink, "aios-worker"));

    expect(withheld).toEqual([
      "wal_archive_lag_seconds",
      "latest_restorable_point_age_seconds",
      "pitr_window_days",
      "restore_test_rpo_seconds",
      "restore_test_rto_seconds",
      "restore_test_age_seconds",
      "disaster_recovery_exercise_age_seconds",
    ]);
    expect(published(sink).has("latest_restorable_point_age_seconds")).toBe(false);
  });

  it("still publishes the counts, which are knowable whenever the store is", () => {
    const sink = new CapturingSink();
    publishRecoveryMetrics(
      { ...unknown, backupIntegrityFailureTotal: 2, externalEffectUnknownTotal: 1 },
      NOW,
      new Metrics(sink, "aios-worker"),
    );
    const values = published(sink);

    expect(values.get("backup_integrity_failure_total")).toBe(2);
    expect(values.get("recovery_external_effect_unknown_total")).toBe(1);
  });

  it("carries no dimension that could identify a database or a recovery point", () => {
    // "Recovery-point timestamps, provider request identifiers, backup object
    // names, database names, and raw error text belong in restricted
    // operational records, not metric labels."
    const sink = new CapturingSink();
    publishRecoveryMetrics(known, NOW, new Metrics(sink, "aios-worker"));

    for (const sample of sink.samples) {
      expect(Object.keys(sample.dimensions)).toEqual(["service"]);
    }
  });

  it("floors a future timestamp at zero instead of reporting a negative age", () => {
    // A clock disagreement between the database and this process. A negative age
    // reads as "more recent than now" and would satisfy every threshold here,
    // which is the direction that matters: skew must not silence an alarm.
    expect(ageSeconds(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
  });
});

describe("the thresholds the alarms will use", () => {
  it("alarms before the RPO is consumed rather than when it is", () => {
    // "Operations MUST alert before the 15-minute RPO is consumed." An alarm at
    // exactly 900 seconds reports a missed objective; it does not prevent one.
    expect(RPO_SECONDS).toBe(900);
    expect(RPO_ALARM_SECONDS).toBeLessThan(RPO_SECONDS);
  });

  it("matches the control-failure ages the architecture states", () => {
    expect(RESTORE_TEST_MAX_AGE_SECONDS).toBe(31 * 86_400);
    expect(DR_EXERCISE_MAX_AGE_SECONDS).toBe(92 * 86_400);
  });
});

describe("the reporter", () => {
  it("publishes once immediately rather than waiting out the first interval", async () => {
    // The interval is hours. Waiting one out means a restarted Worker reports no
    // recovery capability at all for that long, and a deploy is exactly when
    // somebody is watching.
    const sink = new CapturingSink();
    let reads = 0;
    const stop = startRecoveryReporter(
      {
        read: async () => {
          reads += 1;
          return known;
        },
      },
      new Metrics(sink, "aios-worker"),
      3_600_000,
      () => NOW,
    );

    await new Promise((resolve) => setImmediate(resolve));
    stop();

    expect(reads).toBe(1);
    expect(sink.samples).toHaveLength(RECOVERY_METRICS.length);
  });

  it("survives a source that throws", async () => {
    // Telemetry about recoverability must not be able to take down the process
    // whose recoverability it describes.
    const sink = new CapturingSink();
    const stop = startRecoveryReporter(
      {
        read: async () => {
          throw new Error("database unreachable");
        },
      },
      new Metrics(sink, "aios-worker"),
      3_600_000,
      () => NOW,
    );

    await new Promise((resolve) => setImmediate(resolve));
    stop();

    expect(sink.samples).toHaveLength(0);
  });
});
