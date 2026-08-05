/**
 * The recovery metrics (baseline item 10, Phase 2 of the infrastructure roadmap).
 *
 * `observability-and-operations.md` lists ten metrics by name and states the
 * reason they exist in one sentence:
 *
 *     Backup-job success is not proof of recoverability.
 *
 * Everything in this file follows from that. A backup job's exit code answers
 * "did the job run"; the latest confirmed restorable point, the integrity
 * result, the restore-test result, the achieved RPO and RTO, and the age of the
 * latest exercise answer "can this be recovered", and those are different
 * claims. The architecture requires all six to be "observable independently",
 * which is why there is no single `backup_healthy` gauge here and never should
 * be.
 *
 * **A value that is not known is not published.** This is the one design
 * decision worth arguing about, so: publishing zero for
 * `latest_restorable_point_age_seconds` when the restorable point is unknown
 * would draw a flat, green line meaning "recoverable to this instant" for a
 * database nobody can prove is recoverable at all. That is precisely the false
 * reassurance the architecture is warning about, in the metric written to
 * prevent it. Unknown is therefore *absent*, and every alarm over these series
 * is configured `TreatMissingData: breaching` — asserted by `check_infra.py`,
 * because an absent series with the default `missing` treatment is an alarm
 * that stays in INSUFFICIENT_DATA forever and never fires.
 *
 * The thresholds below are exported because the CloudWatch alarm definitions
 * must use the same numbers, and `check_infra.py` compares the templates against
 * these constants rather than against a second copy in prose.
 */

import { getLogger } from "./logging.js";
import type { MetricName, Metrics } from "./metrics.js";

/**
 * The Recovery Point Objective, in seconds.
 *
 * "Operations MUST alert before the 15-minute RPO is consumed" — so the alarm
 * threshold is deliberately below this, not equal to it. An alarm that fires
 * exactly when the objective is breached reports a missed objective rather than
 * preventing one.
 */
export const RPO_SECONDS = 900;

/** Where the alarm sits, leaving time to act before the RPO is consumed. */
export const RPO_ALARM_SECONDS = 600;

/** "PITR restore window >= 14 days". */
export const MIN_PITR_WINDOW_DAYS = 14;

/** "A restore test older than 31 days ... is a control failure". */
export const RESTORE_TEST_MAX_AGE_SECONDS = 31 * 24 * 60 * 60;

/** "... or a disaster-recovery exercise older than 92 days". */
export const DR_EXERCISE_MAX_AGE_SECONDS = 92 * 24 * 60 * 60;

/**
 * What one verified restore test measured.
 *
 * The achieved figures belong together with the timestamp: an RPO of four
 * minutes is a fact about a particular exercise, and quoting it without saying
 * when it was measured is how a number from eight months ago ends up on a
 * status page.
 */
export interface RestoreTestEvidence {
  readonly at: Date;
  readonly achievedRpoSeconds: number;
  readonly achievedRtoSeconds: number;
}

/**
 * Everything the ten metrics are derived from.
 *
 * `null` means *not known*, not zero, and the difference is load-bearing
 * throughout. The counters are not nullable because a count of failures is
 * knowable whenever the store is reachable, and a store that is unreachable
 * fails the whole read rather than reporting a partial one.
 */
export interface RecoveryStatus {
  /** From `pg_stat_archiver.last_archived_time`. Null before the first archive. */
  readonly walArchiveLagSeconds: number | null;
  /** Provider-confirmed. Null wherever the provider does not report one. */
  readonly latestRestorablePointAt: Date | null;
  /** The configured PITR retention. Null outside a managed provider. */
  readonly pitrWindowDays: number | null;
  readonly backupIntegrityFailureTotal: number;
  readonly restoreTestFailureTotal: number;
  readonly latestRestoreTest: RestoreTestEvidence | null;
  readonly disasterRecoveryExerciseAt: Date | null;
  /**
   * Deliveries that failed against an `ExternalBusinessEffect` consumer and are
   * still open.
   *
   * "For an external side effect whose pre-restore outcome is unknown, the
   * consumer MUST use the effect ledger ... Blind replay of a non-idempotent
   * external effect is prohibited." Each one is an ordering key that stays
   * blocked until a human proves what the provider did.
   *
   * Derived from the consumer registry rather than hardcoded. No consumer in the
   * MVP registry declares `ExternalBusinessEffect`, so this is structurally zero
   * today — but it is zero because a query said so, and it starts measuring on
   * the day someone registers one, which a hardcoded zero would not.
   */
  readonly externalEffectUnknownTotal: number;
}

/** Where a `RecoveryStatus` comes from. Implemented in persistence. */
export interface RecoveryStatusSource {
  read(): Promise<RecoveryStatus>;
}

/**
 * The ten, in the order the architecture lists them.
 *
 * Exported so `check_infra.py` can assert that every one of them is either
 * alarmed or deliberately on a dashboard, and so the catalogue and this list
 * cannot drift apart without a test noticing.
 */
export const RECOVERY_METRICS = [
  "wal_archive_lag_seconds",
  "latest_restorable_point_age_seconds",
  "pitr_window_days",
  "backup_integrity_failure_total",
  "restore_test_failure_total",
  "restore_test_rpo_seconds",
  "restore_test_rto_seconds",
  "restore_test_age_seconds",
  "disaster_recovery_exercise_age_seconds",
  "recovery_external_effect_unknown_total",
] as const satisfies readonly MetricName[];

/**
 * Age in seconds, floored at zero.
 *
 * A timestamp in the future is a clock disagreement between the database and
 * this process, not a negative age. Flooring keeps a skewed clock from
 * publishing a value that silences an alarm — which is the direction that
 * matters, since a negative age reads as "more recent than now" and would
 * satisfy every threshold here.
 */
export const ageSeconds = (at: Date, now: Date): number =>
  Math.max(0, (now.getTime() - at.getTime()) / 1000);

/**
 * Publish what is known and name what is not.
 *
 * Returns the metrics that were withheld, so the caller can log them. The log is
 * not decoration: an alarm on an absent series tells you a threshold was
 * breached, and only this record tells you the series was never published in the
 * first place — a different problem with a different fix, and one that no
 * dashboard can distinguish.
 */
export const publishRecoveryMetrics = (
  status: RecoveryStatus,
  now: Date,
  metrics: Metrics,
): readonly string[] => {
  const unknown: string[] = [];

  const gauge = (name: MetricName, value: number | null): void => {
    if (value === null) {
      unknown.push(name);
      return;
    }
    metrics.gauge(name, value);
  };

  gauge("wal_archive_lag_seconds", status.walArchiveLagSeconds);
  gauge(
    "latest_restorable_point_age_seconds",
    status.latestRestorablePointAt === null
      ? null
      : ageSeconds(status.latestRestorablePointAt, now),
  );
  gauge("pitr_window_days", status.pitrWindowDays);
  gauge("backup_integrity_failure_total", status.backupIntegrityFailureTotal);
  gauge("restore_test_failure_total", status.restoreTestFailureTotal);
  gauge(
    "restore_test_rpo_seconds",
    status.latestRestoreTest?.achievedRpoSeconds ?? null,
  );
  gauge(
    "restore_test_rto_seconds",
    status.latestRestoreTest?.achievedRtoSeconds ?? null,
  );
  gauge(
    "restore_test_age_seconds",
    status.latestRestoreTest === null ? null : ageSeconds(status.latestRestoreTest.at, now),
  );
  gauge(
    "disaster_recovery_exercise_age_seconds",
    status.disasterRecoveryExerciseAt === null
      ? null
      : ageSeconds(status.disasterRecoveryExerciseAt, now),
  );
  gauge("recovery_external_effect_unknown_total", status.externalEffectUnknownTotal);

  if (unknown.length > 0) {
    getLogger().log({
      severity: "WARN",
      operationalLogName: "recovery.metrics_unknown",
      operationalLogClass: "Operations",
      operationalLogCategory: "Operations",
      message: "Some recovery metrics could not be determined and were not published.",
      outcome: "Failure",
      attributes: {
        // The names only. A restorable-point timestamp, a database name, or a
        // provider request identifier would each be a restricted operational
        // detail: "Recovery-point timestamps, provider request identifiers,
        // backup object names, database names, and raw error text belong in
        // restricted operational records, not metric labels."
        "recovery.unknown": unknown.join(","),
        "recovery.unknown_count": unknown.length,
      },
    });
  }

  return unknown;
};

/**
 * Start publishing recovery status on an interval.
 *
 * Separate from `startMetricsCollector` because the cadence is different by two
 * orders of magnitude: the Outbox depth is worth sampling every fifteen seconds
 * and the age of a restore test is not, and `DescribeDBInstances` is a
 * rate-limited control-plane call that would be wasteful at that rate.
 *
 * A read that throws is logged and skipped. Publishing recovery telemetry must
 * not be able to take down the process whose recoverability it describes.
 */
export const startRecoveryReporter = (
  source: RecoveryStatusSource,
  metrics: Metrics,
  intervalMs: number,
  now: () => Date = () => new Date(),
): (() => void) => {
  let running = false;

  const tick = async (): Promise<void> => {
    // Skipped rather than queued. A source slower than the interval would
    // otherwise accumulate overlapping reads against the same database.
    if (running) return;
    running = true;
    try {
      publishRecoveryMetrics(await source.read(), now(), metrics);
    } catch (error) {
      getLogger().log({
        severity: "WARN",
        operationalLogName: "recovery.status_read_failed",
        operationalLogClass: "Operations",
        operationalLogCategory: "Operations",
        message: "The recovery status could not be read; no recovery metrics were published.",
        outcome: "Failure",
        attributes: {
          "recovery.reason_code":
            error instanceof Error ? error.constructor.name : "UnknownError",
        },
      });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
