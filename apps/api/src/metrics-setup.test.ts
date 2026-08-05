/**
 * Which sink a process gets, and what it says about it.
 *
 * The startup decision is the whole point of `metrics-setup.ts`: an operator who
 * asked for CloudWatch and got silence must be able to find out why from one log
 * record, not from an empty dashboard during an incident. These tests are about
 * that record as much as about the sink.
 */

import { describe, expect, it } from "vitest";

import { BoundedMetricExporter, nullSink } from "@aios/application";

import { limitsFrom, startMetrics } from "./metrics-setup.js";

const base = { NODE_ENV: "production", SERVICE_VERSION: "0.0.0" } as NodeJS.ProcessEnv;

describe("choosing a sink", () => {
  it("is silent when nothing is configured", () => {
    const runtime = startMetrics({ ...base }, "aios-api", null);

    expect(runtime.sink).toBe(nullSink);
    expect(runtime.reason).toContain("no metric sink configured");
  });

  it("builds the CloudWatch exporter when a Region is present", async () => {
    const runtime = startMetrics(
      { ...base, METRICS_SINK: "cloudwatch", AWS_REGION: "ap-northeast-1" },
      "aios-api",
      null,
    );

    expect(runtime.sink).toBeInstanceOf(BoundedMetricExporter);
    expect(runtime.reason).toContain("AIOS");
    expect(runtime.reason).toContain("ap-northeast-1");

    runtime.stop();
    await runtime.flush();
  });

  it("refuses to guess a Region, and says so", async () => {
    // ADR-0003 pins ap-northeast-1. An SDK left to its own default would decide
    // where a production Organization's operational metrics are stored, which is
    // a data-residency decision made by a fallback.
    const runtime = startMetrics({ ...base, METRICS_SINK: "cloudwatch" }, "aios-api", null);

    expect(runtime.sink).toBe(nullSink);
    expect(runtime.reason).toContain("AWS_REGION is unset");
  });

  it("falls back rather than refusing to start", () => {
    // The asymmetry with `validateLimits`, which throws. An unbounded buffer is
    // a way for telemetry to kill the process; a missing Region is a way for
    // telemetry to be absent. Taking the API down for the second would make
    // observability the outage.
    expect(() =>
      startMetrics({ ...base, METRICS_SINK: "cloudwatch" }, "aios-api", null),
    ).not.toThrow();
  });

  it("refuses CloudWatch and stdout under NODE_ENV=test", () => {
    const cloud = startMetrics(
      { NODE_ENV: "test", METRICS_SINK: "cloudwatch", AWS_REGION: "ap-northeast-1" },
      "aios-api",
      null,
    );
    const out = startMetrics({ NODE_ENV: "test", METRICS_SINK: "stdout" }, "aios-api", null);

    expect(cloud.sink).toBe(nullSink);
    expect(cloud.reason).toContain("refused under NODE_ENV=test");
    // A suite that published its metrics to stdout would bury its own output.
    expect(out.sink).toBe(nullSink);
  });
});

describe("limits", () => {
  it("falls back to the default for a value that would remove a bound", () => {
    // Zero, a negative, and a non-number all mean "no limit" if taken literally,
    // and an unlimited exporter must not be expressible from configuration.
    const limits = limitsFrom({ METRICS_MAX_QUEUED: "0", METRICS_MAX_BATCH: "not-a-number" });

    expect(limits.maxQueuedRecords).toBe(10_000);
    expect(limits.maxBatchSize).toBe(500);
  });
});
