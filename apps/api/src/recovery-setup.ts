/**
 * Wiring the recovery reporter, and saying which source it got.
 *
 * The same shape as `chooseGenerator`, `chooseLogger`, and `startMetrics`: one
 * decision at startup, logged, so "why is `latest_restorable_point_age_seconds`
 * missing" is answerable from a log record instead of by reading this file.
 *
 * It runs in the Worker only. Both processes could publish these gauges and the
 * values would agree, but `DescribeDBInstances` is a rate-limited control-plane
 * call and the Worker is already the process that does periodic maintenance.
 */

import type { Pool } from "pg";

import {
  PostgresRecoveryStatusQuery,
} from "@aios/persistence";
import {
  getMetrics,
  startRecoveryReporter,
  type RecoveryStatusSource,
} from "@aios/application";

import { RdsRecoveryStatusSource, SdkRdsBackupFacts } from "./rds-recovery-source.js";

/**
 * How often recovery status is sampled.
 *
 * A minute, not the fifteen seconds the Outbox uses and not the hour the
 * restore-test age would justify on its own. The binding constraint is the RPO
 * alarm: "Operations MUST alert before the 15-minute RPO is consumed", so the
 * series it evaluates has to produce enough data points inside that window for
 * an alarm to breach and notify with time to spare.
 */
export const DEFAULT_RECOVERY_INTERVAL_MS = 60_000;

export interface RecoveryRuntime {
  readonly reason: string;
  stop(): void;
}

const NOT_RUNNING: RecoveryRuntime = {
  reason: "no metric sink is configured; recovery status is not sampled",
  stop: () => {},
};

export const startRecoveryReporting = (
  env: NodeJS.ProcessEnv,
  pool: Pool,
  publishing: boolean,
): RecoveryRuntime => {
  // Reading the status costs three queries and possibly a control-plane call.
  // With nothing to publish to, that is work whose only product is load on the
  // database the metrics describe.
  if (!publishing) return NOT_RUNNING;

  const local = new PostgresRecoveryStatusQuery(pool);
  const identifier = env["RDS_DB_INSTANCE_IDENTIFIER"] ?? "";
  const region = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "";

  let source: RecoveryStatusSource = local;
  let facts: SdkRdsBackupFacts | null = null;
  let reason =
    "PostgreSQL only; the confirmed restorable point and PITR window are not published because no managed provider was named";

  if (identifier !== "" && region !== "") {
    facts = new SdkRdsBackupFacts(region);
    source = new RdsRecoveryStatusSource(local, facts, identifier);
    reason = `PostgreSQL, with the restorable point and PITR window from RDS in ${region}`;
  } else if (identifier !== "") {
    // Named rather than silently ignored, for the same reason the metric sink
    // names a missing Region: a half-configured overlay that publishes nothing
    // looks identical to a working one on a cluster with no backups.
    reason =
      "RDS_DB_INSTANCE_IDENTIFIER is set but AWS_REGION is not; the provider's backup facts are not read";
  }

  const interval = Number.parseInt(env["RECOVERY_INTERVAL_MS"] ?? "", 10);
  const stop = startRecoveryReporter(
    source,
    getMetrics(),
    Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_RECOVERY_INTERVAL_MS,
  );

  return {
    reason,
    stop: () => {
      stop();
      facts?.destroy();
    },
  };
};
