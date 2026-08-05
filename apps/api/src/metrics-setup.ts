/**
 * Choosing where metrics go, and reporting on the exporter itself.
 *
 * The same shape as `chooseAuth`, `chooseGenerator`, and `chooseLogger`: a
 * decision made once at startup and **logged**, so which sink is running is a
 * fact in the log rather than something inferred from what is missing.
 *
 * ADR-0003 chose CloudWatch, and that transport now exists
 * (`cloudwatch-transport.ts`). It has never run against a real account from
 * here, and `infrastructure-roadmap.md` records it as unverified until it has —
 * written-but-unapplied infrastructure has the same status as an unexecuted
 * runbook.
 *
 * A misconfiguration here **falls back loudly rather than refusing to start**,
 * which is the opposite of what `validateLimits` does one file over. The
 * asymmetry is deliberate. An unbounded buffer is a way for telemetry to kill
 * the process, so a process configured that way must not start. A missing
 * Region is a way for telemetry to be absent, and taking the API down because
 * its metrics are misconfigured would make observability the outage — "drop
 * additional diagnostic detail rather than block an authoritative transaction
 * or Worker lease."
 */

import type { Pool } from "pg";

import {
  BoundedMetricExporter,
  DEFAULT_LIMITS,
  Metrics,
  StdoutMetricTransport,
  getLogger,
  getMetrics,
  nullSink,
  setMetrics,
  type ExportLimits,
  type MetricSink,
} from "@aios/application";

import {
  CloudWatchMetricTransport,
  METRIC_NAMESPACE,
  SdkCloudWatchPutter,
} from "./cloudwatch-transport.js";
import { startMetricsCollector } from "./metrics-collector.js";

const positive = (raw: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const limitsFrom = (env: NodeJS.ProcessEnv): ExportLimits => ({
  maxQueuedRecords: positive(env["METRICS_MAX_QUEUED"], DEFAULT_LIMITS.maxQueuedRecords),
  maxQueuedBytes: positive(env["METRICS_MAX_BYTES"], DEFAULT_LIMITS.maxQueuedBytes),
  maxBatchSize: positive(env["METRICS_MAX_BATCH"], DEFAULT_LIMITS.maxBatchSize),
  maxConcurrentRequests: positive(
    env["METRICS_MAX_CONCURRENT"],
    DEFAULT_LIMITS.maxConcurrentRequests,
  ),
  requestTimeoutMs: positive(env["METRICS_TIMEOUT_MS"], DEFAULT_LIMITS.requestTimeoutMs),
  maxRetryAttempts: positive(env["METRICS_MAX_RETRIES"], DEFAULT_LIMITS.maxRetryAttempts),
  maxBackoffMs: positive(env["METRICS_MAX_BACKOFF_MS"], DEFAULT_LIMITS.maxBackoffMs),
  flushIntervalMs: positive(env["METRICS_FLUSH_MS"], DEFAULT_LIMITS.flushIntervalMs),
  shutdownFlushMs: positive(env["METRICS_SHUTDOWN_MS"], DEFAULT_LIMITS.shutdownFlushMs),
});

export interface MetricsRuntime {
  readonly sink: MetricSink;
  readonly reason: string;
  /** Stops the collector and the self-report. Does not flush. */
  stop(): void;
  /**
   * Flush within the exporter's deadline, then release the transport.
   *
   * One method rather than "call `sink.shutdown()` and then remember to close
   * the client", because the ordering is not obvious and getting it backwards
   * is silent: destroying an SDK client first aborts the in-flight flush, so the
   * last batch before a deploy — which is the batch describing the deploy —
   * disappears while `shutdown()` still reports success.
   */
  flush(): Promise<boolean>;
}

/**
 * Wire metrics for a process.
 *
 * Silent by default. An unconfigured process emitting metrics to stdout would
 * interleave them with the structured logs and make both harder to read, so
 * `METRICS_SINK=stdout` is opt-in — and under `test` it is refused outright, so
 * a suite cannot bury its own output.
 */
export const startMetrics = (
  env: NodeJS.ProcessEnv,
  service: string,
  pool: Pool | null,
): MetricsRuntime => {
  const requested = env["METRICS_SINK"] ?? "none";
  const environment = env["NODE_ENV"] ?? "development";

  let sink: MetricSink = nullSink;
  let reason = "no metric sink configured; samples are discarded";
  let dispose: (() => void) | null = null;

  if (requested === "stdout" && environment !== "test") {
    sink = new BoundedMetricExporter(new StdoutMetricTransport(), limitsFrom(env));
    reason = "JSON lines to stdout, behind the bounded exporter";
  } else if (requested === "cloudwatch" && environment !== "test") {
    // The Region is not defaulted. ADR-0003 pins `ap-northeast-1`, and a
    // transport that guessed would publish a production Organization's operational
    // metrics into whichever Region the SDK happened to pick — a data-residency
    // decision made by a fallback.
    const region = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "";

    if (region === "") {
      // Named rather than silently ignored. An operator who set this and got
      // nothing deserves to be told why, not left to discover it from an empty
      // dashboard during an incident.
      reason =
        "CloudWatch was requested but AWS_REGION is unset (ADR-0003 pins ap-northeast-1); samples are discarded";
    } else {
      const putter = new SdkCloudWatchPutter(region);
      sink = new BoundedMetricExporter(
        new CloudWatchMetricTransport(putter),
        limitsFrom(env),
      );
      dispose = () => putter.destroy();
      reason = `CloudWatch namespace ${METRIC_NAMESPACE} in ${region}, behind the bounded exporter`;
    }
  } else if (requested === "cloudwatch") {
    reason = "CloudWatch is refused under NODE_ENV=test; samples are discarded";
  }

  setMetrics(new Metrics(sink, service));

  getLogger().log({
    severity: "INFO",
    operationalLogName: "metrics.sink_selected",
    operationalLogClass: "Operations",
    operationalLogCategory: "Operations",
    message: "The metric sink was selected.",
    outcome: "Success",
    attributes: { "metrics.sink": reason },
  });

  const stops: (() => void)[] = [];

  if (pool !== null && sink !== nullSink) {
    stops.push(startMetricsCollector(pool, positive(env["METRICS_COLLECT_MS"], 15_000)));
  }

  // The exporter reporting on itself, which the architecture asks for by name:
  // `telemetry_export_queue_utilization_ratio`, `_oldest_queued_seconds`, and
  // the loss counters. Without these, a saturated exporter is invisible to
  // exactly the system that would have told you.
  if (sink instanceof BoundedMetricExporter) {
    const timer = setInterval(() => {
      const snapshot = sink.snapshot();
      const metrics = getMetrics();
      metrics.gauge("telemetry_export_queue_utilization_ratio", snapshot.utilization, {
        signal: "metrics",
      });
      metrics.gauge("telemetry_export_oldest_queued_seconds", snapshot.oldestQueuedSeconds, {
        signal: "metrics",
      });
      for (const [priority, dropped] of snapshot.dropped) {
        if (dropped > 0) {
          metrics.gauge("telemetry_export_dropped_total", dropped, {
            signal: "metrics",
            priority,
          });
        }
      }
    }, positive(env["METRICS_SELF_REPORT_MS"], 30_000));
    timer.unref();
    stops.push(() => clearInterval(timer));
  }

  return {
    sink,
    reason,
    stop: () => {
      for (const stop of stops) stop();
    },
    flush: async () => {
      const flushed = await sink.shutdown();
      dispose?.();
      return flushed;
    },
  };
};
