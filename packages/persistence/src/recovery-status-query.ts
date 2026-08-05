/**
 * The recovery status this cluster can prove about itself.
 *
 * Four of the ten metrics are provider-independent facts a PostgreSQL
 * connection can answer, and this reads them. The two that only a managed
 * provider knows — the confirmed latest restorable point and the configured PITR
 * window — are returned as `null` here and overlaid by a provider-specific
 * source (`RdsRecoveryStatusSource`). Null means *not known*, never zero:
 * publishing zero for the age of a restorable point nobody has confirmed is the
 * false reassurance `observability-and-operations.md` names by name.
 *
 * Nothing here is Organization-scoped, and that is deliberate rather than an
 * omission. Recovery is a property of the cluster: a restore returns every
 * Organization or none.
 */

import type { Pool } from "pg";

import { CONSUMER_REGISTRY, type RecoveryStatus, type RecoveryStatusSource } from "@aios/application";

/**
 * Consumers whose pre-restore outcome cannot be proven by reading PostgreSQL.
 *
 * Read from the registry rather than written down, so this measures the system
 * that exists rather than the one that existed when it was written. No MVP
 * consumer declares `ExternalBusinessEffect` — `memory-generation` is
 * `ExternalComputation`, which ADR-0004 defines as having no authoritative
 * business effect and being safe to retry — so the count is structurally zero
 * today, and starts measuring the day someone registers one.
 */
const externalEffectConsumers = (): readonly string[] =>
  CONSUMER_REGISTRY.filter((c) => c.sideEffectClass === "ExternalBusinessEffect").map(
    (c) => c.consumerName,
  );

interface ArchiverRow {
  lag_seconds: string | null;
}

interface ControlRow {
  control_type: string;
  outcome: string;
  performed_at: Date;
  achieved_rpo_seconds: number | null;
  achieved_rto_seconds: number | null;
}

export class PostgresRecoveryStatusQuery implements RecoveryStatusSource {
  constructor(private readonly pool: Pool) {}

  async read(): Promise<RecoveryStatus> {
    // `pg_stat_archiver` is available on RDS as well as on a self-managed
    // cluster: the provider manages the archive command, but the statistics view
    // still reports what it did. `last_archived_time` is null before the first
    // segment is archived, which includes every cluster with `archive_mode` off
    // — a genuine "not known", and the reason this is nullable rather than zero.
    const archiver = await this.pool.query<ArchiverRow>(
      `SELECT EXTRACT(EPOCH FROM (now() - last_archived_time)) AS lag_seconds
         FROM pg_stat_archiver`,
    );

    // The newest event of each control type, plus the cumulative failures. One
    // query rather than four round trips, and `DISTINCT ON` uses
    // `ix_recovery_control_latest` directly.
    const latest = await this.pool.query<ControlRow>(
      `SELECT DISTINCT ON (control_type)
              control_type, outcome, performed_at,
              achieved_rpo_seconds, achieved_rto_seconds
         FROM recovery_control_events
        ORDER BY control_type, performed_at DESC`,
    );

    const failures = await this.pool.query<{ control_type: string; count: string }>(
      `SELECT control_type, count(*) AS count
         FROM recovery_control_events
        WHERE outcome = 'Failed'
        GROUP BY control_type`,
    );

    const consumers = externalEffectConsumers();
    // `= ANY($1)` with an empty array is a valid predicate that matches nothing,
    // so the no-external-consumer case needs no branch — and the query is
    // exercised either way, which a branch would prevent.
    const unresolved = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM dead_letter_events
        WHERE consumer_name = ANY($1::text[])
          AND status IN ('Open', 'Investigating', 'ReadyForReplay')`,
      [consumers],
    );

    const byType = new Map(latest.rows.map((row) => [row.control_type, row]));
    const failureCount = new Map(
      failures.rows.map((row) => [row.control_type, Number(row.count)]),
    );

    const restoreTest = byType.get("RestoreTest");
    const exercise = byType.get("DisasterRecoveryExercise");
    const lag = archiver.rows[0]?.lag_seconds ?? null;

    return {
      walArchiveLagSeconds: lag === null ? null : Number(lag),
      // Provider-side. Overlaid by the RDS source; left unknown everywhere else,
      // because a self-managed cluster's restorable point is a property of the
      // archive destination rather than of the database being asked.
      latestRestorablePointAt: null,
      pitrWindowDays: null,
      backupIntegrityFailureTotal: failureCount.get("BackupIntegrityCheck") ?? 0,
      restoreTestFailureTotal: failureCount.get("RestoreTest") ?? 0,
      // Only a *passing* test carries achieved figures — the schema enforces it
      // — so a latest test that failed reports its age through the absence of
      // an RPO and RTO rather than through a zero.
      latestRestoreTest:
        restoreTest === undefined ||
        restoreTest.achieved_rpo_seconds === null ||
        restoreTest.achieved_rto_seconds === null
          ? null
          : {
              at: restoreTest.performed_at,
              achievedRpoSeconds: restoreTest.achieved_rpo_seconds,
              achievedRtoSeconds: restoreTest.achieved_rto_seconds,
            },
      disasterRecoveryExerciseAt: exercise?.performed_at ?? null,
      externalEffectUnknownTotal: Number(unresolved.rows[0]?.count ?? 0),
    };
  }
}

/** What `scripts/restore_drill.sh` and the exercise record when they finish. */
export interface RecoveryControlEvent {
  readonly id: string;
  readonly controlType: "RestoreTest" | "DisasterRecoveryExercise" | "BackupIntegrityCheck";
  readonly outcome: "Passed" | "Failed";
  readonly performedAt: Date;
  readonly achievedRpoSeconds: number | null;
  readonly achievedRtoSeconds: number | null;
  readonly evidenceReference: string | null;
  readonly performedBy: string;
}

/**
 * Record one control event.
 *
 * Insert-only. There is no update and no delete: a control event is evidence,
 * and a wrong result is corrected by recording the later test that supersedes
 * it, which is also what actually happened.
 */
export const recordRecoveryControlEvent = async (
  pool: Pool,
  event: RecoveryControlEvent,
): Promise<void> => {
  await pool.query(
    `INSERT INTO recovery_control_events (
        recovery_control_event_id, control_type, outcome, performed_at,
        achieved_rpo_seconds, achieved_rto_seconds,
        evidence_reference, performed_by, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      event.id,
      event.controlType,
      event.outcome,
      event.performedAt,
      event.achievedRpoSeconds,
      event.achievedRtoSeconds,
      event.evidenceReference,
      event.performedBy,
    ],
  );
};
