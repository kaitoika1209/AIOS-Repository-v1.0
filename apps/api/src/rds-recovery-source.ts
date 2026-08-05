/**
 * The two recovery facts only the provider knows.
 *
 * Eight of the ten recovery metrics come from PostgreSQL itself —
 * `pg_stat_archiver` and the `recovery_control_events` evidence table. The
 * remaining two are properties of the *managed backup*, not of the database:
 *
 * - `LatestRestorableTime` — the newest instant RDS will restore to. This is
 *   the metric the RPO is measured against, and it is the one that must never
 *   be guessed: it is confirmed by the provider, and a value this process
 *   computed would be an assertion about someone else's archive.
 * - `BackupRetentionPeriod` — the PITR window, which the baseline requires to be
 *   at least 14 days.
 *
 * This overlays them onto the PostgreSQL-side status. Where there is no managed
 * provider — a self-managed cluster, or local development — the overlay is
 * simply absent and both stay `null`, which is the honest answer rather than a
 * degraded one.
 */

import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";

import { getLogger, type RecoveryStatus, type RecoveryStatusSource } from "@aios/application";

/** What the provider was asked and what it answered. Faked in tests. */
export interface RdsBackupFacts {
  describe(identifier: string): Promise<{
    latestRestorableTime: Date | null;
    backupRetentionDays: number | null;
  }>;
}

export class SdkRdsBackupFacts implements RdsBackupFacts {
  private readonly client: RDSClient;

  constructor(region: string) {
    // Two attempts rather than one. Unlike the metric transport, this is not
    // behind an exporter that owns a retry ceiling, and it runs once a minute
    // rather than continuously — a single throttled control-plane call should
    // not blank a recovery metric until the next tick.
    this.client = new RDSClient({ region, maxAttempts: 2 });
  }

  async describe(identifier: string): Promise<{
    latestRestorableTime: Date | null;
    backupRetentionDays: number | null;
  }> {
    const response = await this.client.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
    );
    const instance = response.DBInstances?.[0];

    return {
      latestRestorableTime: instance?.LatestRestorableTime ?? null,
      backupRetentionDays: instance?.BackupRetentionPeriod ?? null,
    };
  }

  destroy(): void {
    this.client.destroy();
  }
}

/**
 * The PostgreSQL-side status with the provider's backup facts laid over it.
 *
 * A failing `DescribeDBInstances` degrades rather than fails: the eight metrics
 * the database can answer are still published, and the two the provider owns
 * stay unknown — which is what they are. Failing the whole read would withhold
 * the restore-test age because a control-plane call was throttled, and those two
 * facts have nothing to do with each other.
 */
export class RdsRecoveryStatusSource implements RecoveryStatusSource {
  constructor(
    private readonly local: RecoveryStatusSource,
    private readonly facts: RdsBackupFacts,
    private readonly instanceIdentifier: string,
  ) {}

  async read(): Promise<RecoveryStatus> {
    const status = await this.local.read();

    try {
      const backup = await this.facts.describe(this.instanceIdentifier);
      return {
        ...status,
        latestRestorablePointAt: backup.latestRestorableTime,
        pitrWindowDays: backup.backupRetentionDays,
      };
    } catch (error) {
      getLogger().log({
        severity: "WARN",
        operationalLogName: "recovery.provider_backup_facts_unavailable",
        operationalLogClass: "Operations",
        operationalLogCategory: "Operations",
        message:
          "The provider's backup facts could not be read; the restorable point and PITR window are unknown.",
        outcome: "Failure",
        attributes: {
          // The class name only. The instance identifier is a database name,
          // which "belong[s] in restricted operational records, not metric
          // labels" — and a log record that is scraped into a metric filter is
          // the way one gets there.
          "recovery.reason_code":
            error instanceof Error ? error.constructor.name : "UnknownError",
        },
      });
      return status;
    }
  }
}
