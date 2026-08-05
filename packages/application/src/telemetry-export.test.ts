/**
 * The bounds (baseline item 2).
 *
 * These are the whole feature. An exporter that sends metrics is easy; an
 * exporter that cannot grow, cannot block, cannot retry for ever, and cannot
 * hold a shutdown open is what the baseline asks for — and each of those is only
 * true if something proves it against a backend that misbehaves.
 *
 * So every transport here fails on purpose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nullLogger, setLogger } from "./logging.js";
import type { MetricSample } from "./metrics.js";
import {
  BoundedMetricExporter,
  DEFAULT_LIMITS,
  InvalidExportLimitsError,
  validateLimits,
  type ExportLimits,
  type MetricTransport,
} from "./telemetry-export.js";

/**
 * A usable configuration, with the batch kept inside the queue.
 *
 * `maxBatchSize` tracks `maxQueuedRecords` unless a test names it: the
 * validation refuses a batch larger than the queue that must hold it, so a
 * helper that ignored the relationship would fail every small-queue test for a
 * reason unrelated to what it was checking.
 */
const limits = (over: Partial<ExportLimits> = {}): ExportLimits => {
  const merged = { ...DEFAULT_LIMITS, flushIntervalMs: 60_000, ...over };
  return {
    ...merged,
    maxBatchSize:
      over.maxBatchSize ?? Math.min(merged.maxBatchSize, merged.maxQueuedRecords),
  };
};

const sample = (
  priority: MetricSample["priority"] = "Ordinary",
  at = new Date(),
): MetricSample => ({
  name: "http_server_requests_total",
  kind: "Counter",
  value: 1,
  dimensions: { service: "aios" },
  priority,
  at,
});

/** Records what it was given and whether it was aborted. */
class RecordingTransport implements MetricTransport {
  readonly name = "recording";
  readonly batches: (readonly MetricSample[])[] = [];

  async send(batch: readonly MetricSample[]): Promise<void> {
    this.batches.push(batch);
  }
}

class AlwaysFailingTransport implements MetricTransport {
  readonly name = "failing";
  attempts = 0;

  async send(): Promise<void> {
    this.attempts += 1;
    throw new Error("backend is down");
  }
}

/** Never resolves until aborted, which is what a hung backend looks like. */
class HangingTransport implements MetricTransport {
  readonly name = "hanging";
  aborts = 0;

  async send(_batch: readonly MetricSample[], signal: AbortSignal): Promise<void> {
    await new Promise<void>((_, reject) => {
      signal.addEventListener("abort", () => {
        this.aborts += 1;
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  }
}

beforeEach(() => {
  setLogger(nullLogger);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the limits are validated at startup", () => {
  it("refuses an unlimited queue", () => {
    // "A missing or unlimited value is invalid in production." Throwing is right
    // here and wrong at a call site: this runs once, before the process serves
    // anything.
    expect(() => validateLimits(limits({ maxQueuedRecords: Infinity }))).toThrow(
      InvalidExportLimitsError,
    );
  });

  it("refuses a zero or negative limit", () => {
    expect(() => validateLimits(limits({ requestTimeoutMs: 0 }))).toThrow(
      InvalidExportLimitsError,
    );
    expect(() => validateLimits(limits({ maxRetryAttempts: -1 }))).toThrow(
      InvalidExportLimitsError,
    );
  });

  it("refuses a batch larger than the queue that must hold it", () => {
    expect(() =>
      validateLimits(limits({ maxQueuedRecords: 10, maxBatchSize: 50 })),
    ).toThrow(/can never be sent/);
  });

  it("refuses to construct an exporter with them", () => {
    expect(
      () =>
        new BoundedMetricExporter(new RecordingTransport(), limits({ maxBatchSize: 0 })),
    ).toThrow(InvalidExportLimitsError);
  });
});

describe("the queue cannot grow", () => {
  it("drops rather than exceeding the record limit", () => {
    const exporter = new BoundedMetricExporter(
      new RecordingTransport(),
      limits({ maxQueuedRecords: 10 }),
    );

    for (let i = 0; i < 100; i += 1) exporter.emit([sample()]);

    const snapshot = exporter.snapshot();
    expect(snapshot.queued).toBe(10);
    expect(snapshot.dropped.get("Ordinary")).toBe(90);
    expect(snapshot.utilization).toBe(1);
  });

  it("drops rather than exceeding the byte limit", () => {
    // The two ceilings are independent: a small byte budget must bind even when
    // the record count would allow more.
    const exporter = new BoundedMetricExporter(
      new RecordingTransport(),
      limits({ maxQueuedRecords: 10_000, maxQueuedBytes: 256 * 4 }),
    );

    for (let i = 0; i < 50; i += 1) exporter.emit([sample()]);

    expect(exporter.snapshot().queued).toBe(4);
  });

  it("lets a high-priority sample evict a sampled one, without growing", () => {
    const exporter = new BoundedMetricExporter(
      new RecordingTransport(),
      limits({ maxQueuedRecords: 3 }),
    );

    exporter.emit([sample("Sampled"), sample("Sampled"), sample("Sampled")]);
    exporter.emit([sample("HighPriority")]);

    // "A higher priority changes the order of admission and dropping; it does
    // not permit unbounded resource use." Still three.
    const snapshot = exporter.snapshot();
    expect(snapshot.queued).toBe(3);
    expect(snapshot.dropped.get("Sampled")).toBe(1);
    expect(snapshot.dropped.get("HighPriority")).toBe(0);
  });

  it("drops an arriving sample that outranks nothing", () => {
    const exporter = new BoundedMetricExporter(
      new RecordingTransport(),
      limits({ maxQueuedRecords: 2 }),
    );

    exporter.emit([sample("HighPriority"), sample("HighPriority")]);
    exporter.emit([sample("Sampled")]);

    expect(exporter.snapshot().queued).toBe(2);
    expect(exporter.snapshot().dropped.get("Sampled")).toBe(1);
  });
});

describe("emitting never blocks the caller", () => {
  it("returns immediately while the transport hangs", async () => {
    const transport = new HangingTransport();
    // Short deadlines so the assertion is about `emit`, not about how long the
    // teardown takes.
    const exporter = new BoundedMetricExporter(
      transport,
      limits({ requestTimeoutMs: 20, shutdownFlushMs: 50, maxRetryAttempts: 1 }),
    );

    const started = Date.now();
    for (let i = 0; i < 1000; i += 1) exporter.emit([sample()]);
    const elapsed = Date.now() - started;

    // A thousand samples against a backend that never answers. The assertion is
    // deliberately generous — the property is "does not wait on the network",
    // and any real await on the transport would be seconds, not milliseconds.
    expect(elapsed).toBeLessThan(200);
    await exporter.shutdown();
  });
});

describe("retries have a ceiling", () => {
  it("stops after the configured attempts and discards the batch", async () => {
    vi.useFakeTimers();
    const transport = new AlwaysFailingTransport();
    const exporter = new BoundedMetricExporter(
      transport,
      limits({ maxRetryAttempts: 3, shutdownFlushMs: 60_000, maxBackoffMs: 10 }),
    );
    exporter.emit([sample()]);

    const flushing = exporter.shutdown();
    await vi.runAllTimersAsync();
    await flushing;

    expect(transport.attempts).toBe(3);
    // Discarded rather than requeued. Requeuing past the ceiling is the same
    // unbounded growth under another name.
    expect(exporter.snapshot().queued).toBe(0);
    expect(exporter.snapshot().failed).toBe(3);
    expect(exporter.snapshot().dropped.get("Ordinary")).toBe(1);
  });

  it("aborts a request that passes its deadline", async () => {
    vi.useFakeTimers();
    const transport = new HangingTransport();
    const exporter = new BoundedMetricExporter(
      transport,
      limits({ requestTimeoutMs: 1000, maxRetryAttempts: 1, shutdownFlushMs: 60_000 }),
    );
    exporter.emit([sample()]);

    const flushing = exporter.shutdown();
    await vi.runAllTimersAsync();
    await flushing;

    expect(transport.aborts).toBeGreaterThan(0);
  });
});

describe("shutdown has a deadline", () => {
  it("flushes what it can and reports success", async () => {
    const transport = new RecordingTransport();
    const exporter = new BoundedMetricExporter(transport, limits());
    exporter.emit([sample(), sample()]);

    expect(await exporter.shutdown()).toBe(true);
    expect(transport.batches.flat()).toHaveLength(2);
  });

  it("gives up when the backend will not answer, and counts it", async () => {
    vi.useFakeTimers();
    const exporter = new BoundedMetricExporter(
      new HangingTransport(),
      limits({ requestTimeoutMs: 50_000, shutdownFlushMs: 100, maxRetryAttempts: 1 }),
    );
    exporter.emit([sample()]);

    const flushing = exporter.shutdown();
    await vi.advanceTimersByTimeAsync(200_000);

    // False, not a hang. Holding the process open past its termination grace
    // period loses the Worker drain that graceful shutdown exists to protect.
    expect(await flushing).toBe(false);
    expect(exporter.snapshot().shutdownFlushTimeouts).toBe(1);
  });

  it("stops accepting samples once shut down", async () => {
    const exporter = new BoundedMetricExporter(new RecordingTransport(), limits());
    await exporter.shutdown();

    exporter.emit([sample()]);

    expect(exporter.snapshot().queued).toBe(0);
  });
});

describe("the exporter reports on itself", () => {
  it("reports queue utilisation and the age of the oldest sample", () => {
    const exporter = new BoundedMetricExporter(
      new RecordingTransport(),
      limits({ maxQueuedRecords: 4 }),
    );

    exporter.emit([sample("Ordinary", new Date(Date.now() - 30_000))]);
    exporter.emit([sample()]);

    const snapshot = exporter.snapshot();
    expect(snapshot.utilization).toBe(0.5);
    expect(snapshot.oldestQueuedSeconds).toBeGreaterThanOrEqual(29);
  });
});
