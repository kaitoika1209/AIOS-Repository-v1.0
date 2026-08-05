/**
 * Bounded operational metrics (baseline items 5 and 6).
 *
 * [ADR-0003](../../../docs/adr/0003-select-mvp-observability-stack.md) chose
 * CloudWatch and attached two limits that decide the whole shape of this file:
 *
 *     no more than 100 active AIOS custom metric time series without review
 *     no Organization, Aggregate, request, trace, or principal identifiers in
 *     metric dimensions
 *
 * The second is the sharper one. A metric dimension carrying `organizationId`
 * would be a tenant-data retention path hidden inside a provider's rollups —
 * "This permits provider-managed metric rollups to exist beyond the active
 * 30-day AIOS query window without becoming a hidden tenant-data retention
 * path." Rollups outlive the query window, so an identifier that reaches a
 * dimension is not deletable by anything AIOS controls.
 *
 * So the rule is enforced here, in code, rather than trusted to reviewers. A
 * forbidden dimension is refused at the call site — and refused by **dropping
 * the sample loudly**, never by throwing. Telemetry must not be able to fail a
 * request: "drop additional diagnostic detail rather than block an
 * authoritative transaction or Worker lease."
 */

import { getLogger } from "./logging.js";

/**
 * The delivery classes, in the order they are dropped under saturation.
 *
 * From the architecture's Telemetry Delivery Classes table. Authoritative
 * durability and durable operational accountability are deliberately absent:
 * Class A and Class B audit go to PostgreSQL and are "not placed behind an
 * optional telemetry exporter", so they never enter this queue and cannot be
 * dropped from it.
 */
export const METRIC_PRIORITIES = ["HighPriority", "Ordinary", "Sampled"] as const;
export type MetricPriority = (typeof METRIC_PRIORITIES)[number];

export type MetricKind = "Counter" | "Gauge" | "Histogram";

/**
 * Dimension names a metric may carry.
 *
 * A closed allowlist rather than a denylist, because a denylist is a list of
 * the mistakes somebody already made. Every name here is server-derived and
 * bounded by construction: a route template comes from the route table, an
 * outcome class has five values, a workflow type has four.
 */
export const ALLOWED_DIMENSIONS = [
  "service",
  "route_template",
  "http_method",
  "operation",
  "outcome_class",
  "workflow_type",
  "worker_type",
  "consumer_name",
  "signal",
  "priority",
  "reason_code",
  "status",
  "outcome",
] as const;
export type AllowedDimension = (typeof ALLOWED_DIMENSIONS)[number];

export type Dimensions = Partial<Record<AllowedDimension, string>>;

/**
 * How long a dimension value may be.
 *
 * A bounded name with an unbounded value is still unbounded. `route_template`
 * is the realistic way one arrives — a route pattern that failed to match and
 * fell back to the raw path would carry an identifier in it.
 */
export const MAX_DIMENSION_VALUE = 64;

export interface MetricSample {
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly dimensions: Dimensions;
  readonly priority: MetricPriority;
  readonly at: Date;
}

/** Where samples go. Implemented by the exporter; stubbed in tests. */
export interface MetricSink {
  emit(samples: readonly MetricSample[]): void;
  /** Flush what is queued, within a deadline. Returns false when it timed out. */
  shutdown(): Promise<boolean>;
}

/**
 * Why a sample was refused.
 *
 * Bounded codes, because they become a `reason_code` dimension on
 * `telemetry_export_dropped_total` — a counter about dropping that carried
 * unbounded reasons would be the cardinality problem it exists to report.
 */
export type RejectionReason =
  | "FORBIDDEN_DIMENSION"
  | "DIMENSION_TOO_LONG"
  | "UNKNOWN_METRIC"
  | "NON_FINITE_VALUE";

/**
 * The metric catalogue.
 *
 * Closed, and checked at emit. ADR-0003 caps active time series at 100 without
 * review, and a catalogue is the only way to know how many there are — an
 * `emit(name)` that accepted any string would make the cap unmeasurable and
 * therefore unenforceable.
 */
export const METRIC_CATALOGUE = {
  // --- HTTP RED (baseline item 5) -----------------------------------------
  http_server_requests_total: "Counter",
  http_server_request_duration_seconds: "Histogram",
  // --- Outbox and consumers (item 6) --------------------------------------
  outbox_pending_total: "Gauge",
  outbox_claimed_total: "Gauge",
  outbox_failed_total: "Gauge",
  outbox_oldest_pending_age_seconds: "Gauge",
  consumer_pending_total: "Gauge",
  consumer_oldest_pending_age_seconds: "Gauge",
  // --- Worker (item 6) -----------------------------------------------------
  worker_jobs_started_total: "Counter",
  worker_jobs_completed_total: "Counter",
  worker_jobs_failed_total: "Counter",
  worker_claim_expired_total: "Gauge",
  worker_duration_seconds: "Histogram",
  // --- Work to Memory (item 6) ---------------------------------------------
  memory_generation_pending_total: "Gauge",
  memory_generation_failed_total: "Gauge",
  memory_generation_oldest_pending_age_seconds: "Gauge",
  // --- PostgreSQL (item 6) -------------------------------------------------
  db_pool_connections_total: "Gauge",
  db_pool_idle_total: "Gauge",
  db_pool_waiting_total: "Gauge",
  // --- Authorization (item 11's isolation alert) ---------------------------
  // Every audited refusal, by bounded reason code. HighPriority: a saturated
  // exporter must drop ordinary telemetry before it drops a security signal.
  authorization_denied_total: "Counter",
  // --- Recovery capability (item 10) ---------------------------------------
  // The ten `observability-and-operations.md` names, all gauges: each is a
  // current fact about recoverability read from the provider, the archiver, or
  // the drill's own record. The three ending `_total` are cumulative counts
  // read from a store rather than incremented here, so publishing them as
  // Counters would double-count every one on each sample.
  wal_archive_lag_seconds: "Gauge",
  latest_restorable_point_age_seconds: "Gauge",
  pitr_window_days: "Gauge",
  backup_integrity_failure_total: "Gauge",
  restore_test_failure_total: "Gauge",
  restore_test_rpo_seconds: "Gauge",
  restore_test_rto_seconds: "Gauge",
  restore_test_age_seconds: "Gauge",
  disaster_recovery_exercise_age_seconds: "Gauge",
  recovery_external_effect_unknown_total: "Gauge",
  // --- The exporter's own health (item 2) ----------------------------------
  telemetry_export_attempt_total: "Counter",
  telemetry_export_failure_total: "Counter",
  telemetry_export_dropped_total: "Counter",
  telemetry_export_queue_utilization_ratio: "Gauge",
  telemetry_export_oldest_queued_seconds: "Gauge",
  telemetry_shutdown_flush_timeout_total: "Counter",
} as const satisfies Readonly<Record<string, MetricKind>>;

export type MetricName = keyof typeof METRIC_CATALOGUE;

/**
 * Check a sample against the cardinality rules.
 *
 * Returns the reason it must be refused, or null. Separated from emission so
 * the rule can be tested as a rule — it is the part that protects tenants, and
 * it should not need a running exporter to exercise.
 */
export const rejectionFor = (
  name: string,
  value: number,
  dimensions: Readonly<Record<string, string>>,
): RejectionReason | null => {
  if (!(name in METRIC_CATALOGUE)) return "UNKNOWN_METRIC";
  if (!Number.isFinite(value)) return "NON_FINITE_VALUE";

  for (const [key, dimensionValue] of Object.entries(dimensions)) {
    if (!(ALLOWED_DIMENSIONS as readonly string[]).includes(key)) {
      return "FORBIDDEN_DIMENSION";
    }
    if (dimensionValue.length > MAX_DIMENSION_VALUE) return "DIMENSION_TOO_LONG";
  }

  return null;
};

/**
 * The metrics facade the rest of the code calls.
 *
 * Deliberately tiny and synchronous. A call site that had to await a metric
 * would be a call site that can be slowed by the telemetry backend, which is
 * the thing the architecture forbids: "Caller threads, event loops, and Worker
 * claim loops MUST NOT synchronously wait for a remote telemetry backend."
 */
export class Metrics {
  constructor(
    private readonly sink: MetricSink,
    private readonly service: string,
  ) {}

  count(name: MetricName, dimensions: Dimensions = {}, by = 1): void {
    this.record(name, "Counter", by, dimensions, "Ordinary");
  }

  gauge(name: MetricName, value: number, dimensions: Dimensions = {}): void {
    this.record(name, "Gauge", value, dimensions, "Ordinary");
  }

  observe(name: MetricName, seconds: number, dimensions: Dimensions = {}): void {
    this.record(name, "Histogram", seconds, dimensions, "Ordinary");
  }

  /** Security and integrity signals, admitted before ordinary telemetry. */
  countHighPriority(name: MetricName, dimensions: Dimensions = {}, by = 1): void {
    this.record(name, "Counter", by, dimensions, "HighPriority");
  }

  private record(
    name: MetricName,
    kind: MetricKind,
    value: number,
    dimensions: Dimensions,
    priority: MetricPriority,
  ): void {
    const withService = { ...dimensions, service: this.service };
    const rejection = rejectionFor(name, value, withService as Record<string, string>);

    if (rejection !== null) {
      // Dropped, loudly, and never thrown. A metric bug must not become a
      // request failure — and a silent drop is how a metric goes missing for a
      // quarter, so this is at ERROR with the reason named.
      getLogger().log({
        severity: "ERROR",
        operationalLogName: "metrics.sample_refused",
        operationalLogClass: "Operations",
        operationalLogCategory: "Operations",
        message: "A metric sample was refused and dropped.",
        outcome: "Failure",
        attributes: { "metric.name": name, "metric.reason_code": rejection },
      });
      return;
    }

    this.sink.emit([
      { name, kind, value, dimensions: withService, priority, at: new Date() },
    ]);
  }
}

/** Discards everything. The default, so an unconfigured process is silent. */
export const nullSink: MetricSink = {
  emit: () => {},
  shutdown: async () => true,
};

let current = new Metrics(nullSink, "aios");

export const setMetrics = (metrics: Metrics): void => {
  current = metrics;
};

export const getMetrics = (): Metrics => current;

/**
 * The HTTP outcome classes, which is what keeps `outcome_class` bounded.
 *
 * Five values rather than one per status code. A dimension per status would be
 * five hundred time series for one metric, and the questions RED answers —
 * is the rate normal, are errors rising, is latency moving — need the class
 * rather than the code.
 */
export const outcomeClassOf = (status: number): string => {
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
};
