/**
 * The CloudWatch transport, tested against everything except CloudWatch.
 *
 * The aggregation is the part that has to be right — it decides the bill, the
 * series count, and whether a histogram's tail survives — and it is pure, so it
 * is testable here in full. What is *not* testable here is that CloudWatch
 * accepts the shape, which is why `check_infra.py` asserts the namespace and
 * dimensions the alarms reference match what this module produces, and why the
 * roadmap records the transport as unverified until it has run against a real
 * account.
 */

import { describe, expect, it } from "vitest";

import { METRIC_CATALOGUE, type MetricSample } from "@aios/application";

import {
  CloudWatchMetricTransport,
  MAX_DATA_PER_REQUEST,
  MAX_VALUES_PER_DATUM,
  SdkCloudWatchPutter,
  toMetricData,
  unitFor,
  type CloudWatchPutter,
  type PutMetricDataInput,
} from "./cloudwatch-transport.js";

const sample = (over: Partial<MetricSample> = {}): MetricSample => ({
  name: "http_server_requests_total",
  kind: "Counter",
  value: 1,
  dimensions: { service: "aios-api" },
  priority: "Ordinary",
  at: new Date("2026-08-05T00:00:00.000Z"),
  ...over,
});

class CapturingPutter implements CloudWatchPutter {
  readonly calls: PutMetricDataInput[] = [];
  readonly signals: AbortSignal[] = [];

  async put(input: PutMetricDataInput, signal: AbortSignal): Promise<void> {
    this.calls.push(input);
    this.signals.push(signal);
  }
}

describe("units", () => {
  it("derives the unit from the naming convention", () => {
    expect(unitFor("http_server_request_duration_seconds")).toBe("Seconds");
    expect(unitFor("http_server_requests_total")).toBe("Count");
    expect(unitFor("telemetry_export_queue_utilization_ratio")).toBe("None");
    expect(unitFor("pitr_window_days")).toBe("None");
  });

  it("gives every catalogued metric a unit that matches what it measures", () => {
    // The real assertion is not that a lookup returns something — it always
    // does — but that a metric named `_seconds` is never published as a Count
    // and a metric named `_total` is never published as Seconds. Both mistakes
    // produce a graph that looks plausible and is wrong by a factor of nobody
    // knows.
    for (const name of Object.keys(METRIC_CATALOGUE)) {
      const unit = unitFor(name);
      if (name.endsWith("_seconds")) expect(unit).toBe("Seconds");
      else if (name.endsWith("_total")) expect(unit).toBe("Count");
      else expect(unit).toBe("None");
    }
  });
});

describe("aggregation", () => {
  it("collapses repeated values into counts", () => {
    const data = toMetricData([sample(), sample(), sample()]);

    expect(data).toHaveLength(1);
    // Sum = 3 under the Sum statistic, SampleCount = 3. Publishing three
    // separate data points for the same series, minute, and dimensions would
    // cost three times as much and mean the same thing.
    expect(data[0]?.Values).toEqual([1]);
    expect(data[0]?.Counts).toEqual([3]);
  });

  it("keeps distinct values distinct", () => {
    const data = toMetricData([
      sample({ name: "worker_duration_seconds", kind: "Histogram", value: 0.1 }),
      sample({ name: "worker_duration_seconds", kind: "Histogram", value: 0.2 }),
      sample({ name: "worker_duration_seconds", kind: "Histogram", value: 0.1 }),
    ]);

    expect(data).toHaveLength(1);
    expect(data[0]?.Values).toEqual([0.1, 0.2]);
    expect(data[0]?.Counts).toEqual([2, 1]);
    expect(data[0]?.Unit).toBe("Seconds");
  });

  it("separates series that differ by a dimension", () => {
    const data = toMetricData([
      sample({ dimensions: { service: "aios-api", outcome_class: "2xx" } }),
      sample({ dimensions: { service: "aios-api", outcome_class: "5xx" } }),
    ]);

    expect(data).toHaveLength(2);
  });

  it("groups the same series regardless of the order its dimensions were written", () => {
    // Object key order is insertion order, and the dimensions on a sample are
    // assembled by spreading a caller's object into one carrying `service`. Two
    // call sites that spell the same series in a different order must not become
    // two time series — that is the cardinality problem arriving through the
    // back door, and it would be invisible except as a bill.
    const data = toMetricData([
      sample({ dimensions: { service: "aios-api", outcome_class: "2xx" } }),
      sample({ dimensions: { outcome_class: "2xx", service: "aios-api" } }),
    ]);

    expect(data).toHaveLength(1);
    expect(data[0]?.Counts).toEqual([2]);
    expect(data[0]?.Dimensions.map((d) => d.Name)).toEqual(["outcome_class", "service"]);
  });

  it("drops a dimension with an empty value rather than letting it fail the request", () => {
    // CloudWatch rejects a dimension whose value is empty, and rejects the
    // entire PutMetricData call when it does. One malformed dimension would
    // discard every unrelated metric that happened to share the batch.
    const data = toMetricData([sample({ dimensions: { service: "aios-api", reason_code: "" } })]);

    expect(data[0]?.Dimensions).toEqual([{ Name: "service", Value: "aios-api" }]);
  });

  it("takes the newest timestamp in a group", () => {
    const older = new Date("2026-08-05T00:00:00.000Z");
    const newer = new Date("2026-08-05T00:00:09.000Z");
    const data = toMetricData([sample({ at: newer }), sample({ at: older })]);

    expect(data[0]?.Timestamp).toEqual(newer);
  });

  it("splits a series with more distinct values than a datum can carry", () => {
    const samples = Array.from({ length: MAX_VALUES_PER_DATUM + 20 }, (_, i) =>
      sample({ name: "worker_duration_seconds", kind: "Histogram", value: i / 1000 }),
    );

    const data = toMetricData(samples);

    // Lossless: CloudWatch aggregates data points sharing a name, dimension set,
    // and minute, so two datums for one series are one series. Truncating would
    // have discarded the tail, which for a latency histogram is the only part
    // anyone reads.
    expect(data).toHaveLength(2);
    expect(data[0]?.Values).toHaveLength(MAX_VALUES_PER_DATUM);
    expect(data[1]?.Values).toHaveLength(20);
    expect(data.every((d) => d.MetricName === "worker_duration_seconds")).toBe(true);
    const published = data.flatMap((d) => d.Counts).reduce((a, b) => a + b, 0);
    expect(published).toBe(samples.length);
  });
});

describe("the transport", () => {
  it("publishes into the AIOS namespace", async () => {
    const putter = new CapturingPutter();
    await new CloudWatchMetricTransport(putter).send([sample()], new AbortController().signal);

    expect(putter.calls[0]?.Namespace).toBe("AIOS");
  });

  it("plumbs the abort signal through, so the exporter's timeout is real", async () => {
    // `BoundedMetricExporter` enforces `requestTimeoutMs` by aborting. A
    // transport that accepted the signal and ignored it would turn the whole
    // timeout bound into a comment, and the way that shows up in production is a
    // flush interval that silently stops firing.
    const putter = new CapturingPutter();
    const controller = new AbortController();
    await new CloudWatchMetricTransport(putter).send([sample()], controller.signal);

    expect(putter.signals[0]).toBe(controller.signal);
  });

  it("splits a batch that exceeds the per-request datum limit", async () => {
    const putter = new CapturingPutter();
    const samples = Array.from({ length: MAX_DATA_PER_REQUEST + 5 }, (_, i) =>
      sample({ dimensions: { service: "aios-api", route_template: `/r/${i}` } }),
    );

    await new CloudWatchMetricTransport(putter).send(samples, new AbortController().signal);

    expect(putter.calls).toHaveLength(2);
    expect(putter.calls[0]?.MetricData).toHaveLength(MAX_DATA_PER_REQUEST);
    expect(putter.calls[1]?.MetricData).toHaveLength(5);
  });

  it("lets a failure reach the exporter instead of swallowing it", async () => {
    // The exporter owns the retry ceiling, the loss counter, and the one WARN
    // per exhausted batch. A transport that caught its own errors would make a
    // CloudWatch outage look like a working system publishing nothing.
    const failing: CloudWatchPutter = {
      put: async () => {
        throw new Error("throttled");
      },
    };

    await expect(
      new CloudWatchMetricTransport(failing).send([sample()], new AbortController().signal),
    ).rejects.toThrow("throttled");
  });

  it("leaves the retry ceiling to the exporter", async () => {
    // The subtlest property in the file, and the only one with no symptom: the
    // exporter counts three attempts and an SDK retrying underneath it would
    // make nine, tripling the load on a backend that is throttling *because* it
    // is overloaded. Asserted against what the SDK resolved rather than what the
    // constructor asked for, because `AWS_MAX_ATTEMPTS` and a shared config file
    // can both override it.
    const putter = new SdkCloudWatchPutter("ap-northeast-1");
    try {
      expect(await putter.resolvedConfig()).toEqual({
        maxAttempts: 1,
        region: "ap-northeast-1",
      });
    } finally {
      putter.destroy();
    }
  });

  it("sends nothing when the batch is empty", async () => {
    const putter = new CapturingPutter();
    await new CloudWatchMetricTransport(putter).send([], new AbortController().signal);

    expect(putter.calls).toHaveLength(0);
  });
});
