/**
 * The cardinality rule (ADR-0003).
 *
 * This is the tenant-safety property of the metrics layer, and it is worth more
 * than the metrics themselves:
 *
 *     CloudWatch metric dimensions ... MUST NOT contain `organizationId`,
 *     Aggregate identifiers, Human identifiers, content, external correlation
 *     identifiers, or other tenant-sensitive values. This permits
 *     provider-managed metric rollups to exist beyond the active 30-day AIOS
 *     query window without becoming a hidden tenant-data retention path.
 *
 * Rollups outlive the query window, so an identifier that reaches a dimension is
 * not deletable by anything AIOS controls. A code review cannot be the only
 * thing standing between a call site and that.
 */

import { describe, expect, it } from "vitest";

import { nullLogger, setLogger } from "./logging.js";
import {
  ALLOWED_DIMENSIONS,
  MAX_DIMENSION_VALUE,
  METRIC_CATALOGUE,
  Metrics,
  outcomeClassOf,
  rejectionFor,
  type MetricSample,
  type MetricSink,
} from "./metrics.js";

class CapturingSink implements MetricSink {
  readonly samples: MetricSample[] = [];
  emit(samples: readonly MetricSample[]): void {
    this.samples.push(...samples);
  }
  async shutdown(): Promise<boolean> {
    return true;
  }
}

setLogger(nullLogger);

describe("a dimension that could identify a tenant", () => {
  it("is refused", () => {
    for (const forbidden of [
      "organizationId",
      "organization_id",
      "workId",
      "identityId",
      "membershipId",
      "correlationId",
      "user",
      "email",
    ]) {
      expect(
        rejectionFor("http_server_requests_total", 1, { [forbidden]: "anything" }),
      ).toBe("FORBIDDEN_DIMENSION");
    }
  });

  it("is refused by dropping the sample, never by throwing", () => {
    const sink = new CapturingSink();
    const metrics = new Metrics(sink, "aios");

    // A metric bug must not be able to fail a request. "drop additional
    // diagnostic detail rather than block an authoritative transaction or
    // Worker lease."
    expect(() =>
      metrics.count("http_server_requests_total", {
        organizationId: "11111111-1111-1111-1111-111111111111",
      } as never),
    ).not.toThrow();

    expect(sink.samples).toEqual([]);
  });

  it("refuses an allowed name carrying an unbounded value", () => {
    // A bounded name with an unbounded value is still unbounded. The realistic
    // arrival is a route template that failed to match and fell back to a path.
    expect(
      rejectionFor("http_server_requests_total", 1, {
        route_template: "/works/".padEnd(MAX_DIMENSION_VALUE + 1, "x"),
      }),
    ).toBe("DIMENSION_TOO_LONG");
  });

  it("allows the server-derived names", () => {
    expect(
      rejectionFor("http_server_requests_total", 1, {
        service: "aios-api",
        route_template: "/works/:workId",
        http_method: "POST",
        operation: "work.create",
        outcome_class: "2xx",
      }),
    ).toBeNull();
  });
});

describe("the catalogue is closed", () => {
  it("refuses a metric nobody declared", () => {
    // ADR-0003 caps active time series at 100 without review, and a cap is
    // unmeasurable if any string can become a metric.
    expect(rejectionFor("something_i_just_invented_total", 1, {})).toBe("UNKNOWN_METRIC");
  });

  it("stays inside the review budget", () => {
    // Not a proof of the series count — dimensions multiply it — but a tripwire
    // on the part that is countable. A catalogue that grew past this without
    // anyone noticing is the failure ADR-0003's limit exists to catch.
    expect(Object.keys(METRIC_CATALOGUE).length).toBeLessThanOrEqual(40);
  });

  it("refuses a non-finite value", () => {
    // A division by zero upstream becomes NaN, and a NaN in a rollup poisons
    // every aggregate computed from it.
    expect(rejectionFor("outbox_pending_total", Number.NaN, {})).toBe("NON_FINITE_VALUE");
    expect(rejectionFor("outbox_pending_total", Infinity, {})).toBe("NON_FINITE_VALUE");
  });
});

describe("what is emitted", () => {
  it("carries the service on every sample without the caller saying so", () => {
    const sink = new CapturingSink();
    new Metrics(sink, "aios-worker").count("worker_jobs_started_total");

    expect(sink.samples[0]?.dimensions.service).toBe("aios-worker");
  });

  it("marks ordinary telemetry as droppable and security signals as not", () => {
    const sink = new CapturingSink();
    const metrics = new Metrics(sink, "aios");

    metrics.count("http_server_requests_total");
    metrics.countHighPriority("telemetry_export_failure_total", { signal: "metrics" });

    expect(sink.samples[0]?.priority).toBe("Ordinary");
    expect(sink.samples[1]?.priority).toBe("HighPriority");
  });
});

describe("the outcome class", () => {
  it("collapses status codes to five values", () => {
    // A dimension per status code would be five hundred time series for one
    // metric, against a budget of a hundred in total.
    expect(outcomeClassOf(200)).toBe("2xx");
    expect(outcomeClassOf(404)).toBe("4xx");
    expect(outcomeClassOf(503)).toBe("5xx");
    expect(new Set([200, 201, 204, 404, 422].map(outcomeClassOf)).size).toBe(2);
  });
});

describe("the allowlist itself", () => {
  it("names only server-derived values", () => {
    // Read as a list rather than asserted piecemeal, so adding a name to it is
    // a change someone has to look at here.
    expect([...ALLOWED_DIMENSIONS]).toEqual([
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
    ]);
  });
});
