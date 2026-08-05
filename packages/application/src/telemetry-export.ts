/**
 * The bounded telemetry exporter (baseline item 2).
 *
 * The baseline asks for "bounded telemetry exporters with queue limits,
 * timeouts, retry ceilings, loss counters, shutdown deadlines". Every one of
 * those is a bound, and the reason they are all mandatory is one sentence in the
 * architecture:
 *
 *     Caller threads, event loops, and Worker claim loops MUST NOT
 *     synchronously wait for a remote telemetry backend.
 *
 * An exporter without bounds does not merely lose telemetry when its backend is
 * slow — it grows until the process that was working fine dies of it. The
 * failure mode is that observing the system is what takes the system down, and
 * it arrives during the incident the telemetry was meant to explain.
 *
 * So: a fixed queue, a documented non-blocking admission policy, a retry
 * ceiling, and a shutdown deadline. Nothing here awaits a remote call on behalf
 * of a caller, and nothing allocates a second queue to hold the overflow of the
 * first — "The process MUST NOT allocate a second unbounded overflow queue."
 */

import { getLogger } from "./logging.js";
import {
  METRIC_PRIORITIES,
  type MetricPriority,
  type MetricSample,
  type MetricSink,
} from "./metrics.js";

/**
 * Where a batch actually goes.
 *
 * Separated from the queue on purpose: the bounds are the part that must be
 * right, and they must be testable without a backend. A transport that throws
 * or hangs is the normal case this is designed around, not an edge one.
 */
export interface MetricTransport {
  readonly name: string;
  send(batch: readonly MetricSample[], signal: AbortSignal): Promise<void>;
}

/**
 * Every limit the architecture requires, with no optional ones.
 *
 * "Limits are configuration validated at startup. A missing or unlimited value
 * is invalid in production." There is no `Infinity` and no `undefined` here —
 * an unset limit cannot be expressed, which is a stronger guarantee than
 * validating one.
 */
export interface ExportLimits {
  readonly maxQueuedRecords: number;
  readonly maxQueuedBytes: number;
  readonly maxBatchSize: number;
  readonly maxConcurrentRequests: number;
  readonly requestTimeoutMs: number;
  readonly maxRetryAttempts: number;
  readonly maxBackoffMs: number;
  readonly flushIntervalMs: number;
  readonly shutdownFlushMs: number;
}

export const DEFAULT_LIMITS: ExportLimits = {
  maxQueuedRecords: 10_000,
  // A rough per-sample size is enough: the point is a ceiling on memory, not an
  // accounting of it. Measuring exactly would cost more than the bound saves.
  maxQueuedBytes: 4 * 1024 * 1024,
  maxBatchSize: 500,
  maxConcurrentRequests: 2,
  requestTimeoutMs: 5_000,
  maxRetryAttempts: 3,
  maxBackoffMs: 30_000,
  flushIntervalMs: 10_000,
  shutdownFlushMs: 5_000,
};

export class InvalidExportLimitsError extends Error {
  readonly code = "INVALID_EXPORT_LIMITS" as const;
}

/**
 * Refuse an unusable configuration at startup rather than at 3am.
 *
 * Throwing here is correct where dropping a sample is not: this runs once,
 * before the process serves anything, and a process configured to buffer
 * telemetry without limit should not start.
 */
export const validateLimits = (limits: ExportLimits): void => {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new InvalidExportLimitsError(
        `${key} must be a finite positive number; a missing or unlimited value is invalid.`,
      );
    }
  }
  if (limits.maxBatchSize > limits.maxQueuedRecords) {
    throw new InvalidExportLimitsError(
      "maxBatchSize cannot exceed maxQueuedRecords; a batch that cannot be queued can never be sent.",
    );
  }
};

/** A rough constant cost per queued sample, for the byte ceiling. */
const APPROXIMATE_SAMPLE_BYTES = 256;

const RANK: Record<MetricPriority, number> = {
  Sampled: 0,
  Ordinary: 1,
  HighPriority: 2,
};

interface Counters {
  attempted: number;
  failed: number;
  droppedByPriority: Map<MetricPriority, number>;
  shutdownFlushTimeouts: number;
}

/**
 * A fixed-capacity queue with a documented admission policy.
 *
 * The architecture's default drop order is, in effect, "lowest priority first":
 * debug spans, then repetitive informational logs, then coalesced metric
 * updates, then aggregated warnings. This exporter carries metrics only, so the
 * ladder collapses to the three priorities — but the shape is the same, and the
 * property that matters is that admission never blocks and never grows.
 */
export class BoundedMetricExporter implements MetricSink {
  private readonly queue: MetricSample[] = [];
  private readonly counters: Counters = {
    attempted: 0,
    failed: 0,
    droppedByPriority: new Map(),
    shutdownFlushTimeouts: 0,
  };
  private inFlight = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly transport: MetricTransport,
    private readonly limits: ExportLimits = DEFAULT_LIMITS,
  ) {
    validateLimits(limits);
    this.timer = setInterval(() => void this.flushOnce(), limits.flushIntervalMs);
    // The exporter must never be the reason the process stays alive.
    this.timer.unref();
  }

  /**
   * Admit samples, or drop them. Never blocks, never awaits, never grows.
   *
   * Returns nothing on purpose. A caller that could learn whether its sample was
   * admitted is a caller that might branch on it, and branching on telemetry is
   * how telemetry starts affecting behaviour.
   */
  emit(samples: readonly MetricSample[]): void {
    if (this.stopped) return;

    for (const sample of samples) {
      if (this.hasRoom()) {
        this.queue.push(sample);
        continue;
      }

      // Full. Evict the lowest-priority queued sample if this one outranks it;
      // otherwise drop the arriving sample. Either way exactly one sample is
      // lost and the queue does not grow — "A higher priority changes the order
      // of admission and dropping; it does not permit unbounded resource use."
      const victim = this.lowestPriorityIndex();
      if (victim !== null && RANK[this.queue[victim]!.priority] < RANK[sample.priority]) {
        this.drop(this.queue[victim]!.priority);
        this.queue.splice(victim, 1);
        this.queue.push(sample);
      } else {
        this.drop(sample.priority);
      }
    }
  }

  private hasRoom(): boolean {
    return (
      this.queue.length < this.limits.maxQueuedRecords &&
      this.queue.length * APPROXIMATE_SAMPLE_BYTES < this.limits.maxQueuedBytes
    );
  }

  private lowestPriorityIndex(): number | null {
    let worst: number | null = null;
    for (let i = 0; i < this.queue.length; i += 1) {
      if (worst === null || RANK[this.queue[i]!.priority] < RANK[this.queue[worst]!.priority]) {
        worst = i;
      }
    }
    return worst;
  }

  private drop(priority: MetricPriority): void {
    this.counters.droppedByPriority.set(
      priority,
      (this.counters.droppedByPriority.get(priority) ?? 0) + 1,
    );
  }

  /**
   * Send one batch, with a deadline and a bounded retry.
   *
   * Failures are counted and the batch is discarded rather than requeued past
   * the ceiling. Requeuing indefinitely is the same unbounded growth wearing a
   * different name, and a backlog of stale samples is worth less than the
   * memory it occupies.
   */
  private async flushOnce(): Promise<void> {
    if (this.inFlight >= this.limits.maxConcurrentRequests) return;
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.limits.maxBatchSize);
    this.inFlight += 1;

    try {
      await this.sendWithRetry(batch);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async sendWithRetry(batch: readonly MetricSample[]): Promise<void> {
    for (let attempt = 1; attempt <= this.limits.maxRetryAttempts; attempt += 1) {
      this.counters.attempted += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs);
      timeout.unref();

      try {
        await this.transport.send(batch, controller.signal);
        return;
      } catch (error) {
        this.counters.failed += 1;
        if (attempt === this.limits.maxRetryAttempts) {
          // The ceiling. Logged once per exhausted batch rather than per
          // attempt, so a backend outage does not become a log flood of its own.
          getLogger().log({
            severity: "WARN",
            operationalLogName: "telemetry.export_exhausted",
            operationalLogClass: "Operations",
            operationalLogCategory: "Operations",
            message: "A telemetry batch was discarded after exhausting its retries.",
            outcome: "Failure",
            attributes: {
              "telemetry.transport": this.transport.name,
              "telemetry.batch_size": batch.length,
              "telemetry.attempts": attempt,
              "telemetry.reason_code":
                error instanceof Error && error.name === "AbortError"
                  ? "TIMEOUT"
                  : "TRANSPORT_ERROR",
            },
          });
          for (const sample of batch) this.drop(sample.priority);
          return;
        }
        // Exponential with jitter, under a ceiling. Jitter matters because every
        // replica fails at the same moment when a backend goes down, and
        // synchronised retries are what turn its outage into a thundering herd.
        const backoff = Math.min(
          this.limits.maxBackoffMs,
          2 ** (attempt - 1) * 1000 * (0.5 + Math.random()),
        );
        await new Promise((resolve) => setTimeout(resolve, backoff).unref());
      }
    }
  }

  /**
   * What the exporter knows about itself.
   *
   * Reported as the `telemetry_export_*` series the architecture names. The
   * exporter measuring its own losses is not circular: these are read from
   * memory and published like any other gauge, so a backend that is dropping
   * everything still reports how much through the next successful batch — and
   * through the logs regardless.
   */
  snapshot(): {
    queued: number;
    utilization: number;
    oldestQueuedSeconds: number;
    attempted: number;
    failed: number;
    dropped: ReadonlyMap<MetricPriority, number>;
    shutdownFlushTimeouts: number;
  } {
    const oldest = this.queue[0];
    return {
      queued: this.queue.length,
      utilization: this.queue.length / this.limits.maxQueuedRecords,
      oldestQueuedSeconds:
        oldest === undefined ? 0 : Math.max(0, (Date.now() - oldest.at.getTime()) / 1000),
      attempted: this.counters.attempted,
      failed: this.counters.failed,
      dropped: new Map(
        METRIC_PRIORITIES.map((p) => [p, this.counters.droppedByPriority.get(p) ?? 0]),
      ),
      shutdownFlushTimeouts: this.counters.shutdownFlushTimeouts,
    };
  }

  /**
   * Flush what is queued, within a deadline.
   *
   * Bounded like everything else. A shutdown that waited for a hung backend
   * would hold the process open past its termination grace period and be killed
   * uncleanly — which loses the drain the graceful shutdown existed to protect.
   * Returns false when the deadline was reached with samples still queued, and
   * counts it, because a flush that times out every deploy is a real signal.
   */
  async shutdown(): Promise<boolean> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);

    // Racing a drain against a deadline, rather than looping until the queue
    // empties. `flushOnce` removes a batch from the queue *before* sending it,
    // so an emptying queue says only that the samples left the buffer — a
    // shutdown that watched the queue alone would report success while the
    // batch was still in flight to a backend that never answers. Found by the
    // test below, which is the only reason to write it.
    const drained = (async () => {
      while (this.queue.length > 0) {
        await this.flushOnce();
        // Concurrency is capped, so `flushOnce` can decline to take work. A
        // short yield keeps this from spinning while a slot frees.
        if (this.inFlight >= this.limits.maxConcurrentRequests) {
          await new Promise((resolve) => setTimeout(resolve, 10).unref());
        }
      }
      while (this.inFlight > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10).unref());
      }
    })();

    const timedOut = await Promise.race([
      drained.then(() => false),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(true), this.limits.shutdownFlushMs).unref(),
      ),
    ]);

    if (timedOut) {
      this.counters.shutdownFlushTimeouts += 1;
      getLogger().log({
        severity: "WARN",
        operationalLogName: "telemetry.shutdown_flush_timeout",
        operationalLogClass: "Operations",
        operationalLogCategory: "Operations",
        message: "Telemetry was still queued when the shutdown deadline passed.",
        outcome: "Failure",
        attributes: {
          "telemetry.transport": this.transport.name,
          "telemetry.queued": this.queue.length,
          "telemetry.in_flight": this.inFlight,
        },
      });
      return false;
    }
    return true;
  }
}

/**
 * Writes batches to stdout as JSON lines.
 *
 * Not a production destination — ADR-0003 chose CloudWatch, and reaching it
 * needs credentials and a Region this repository has neither of. This exists so
 * the metrics are observable *now*, which is what makes the bounds above
 * testable against something rather than described.
 */
export class StdoutMetricTransport implements MetricTransport {
  readonly name = "stdout";

  async send(batch: readonly MetricSample[]): Promise<void> {
    for (const sample of batch) {
      process.stdout.write(
        `${JSON.stringify({
          metric: sample.name,
          kind: sample.kind,
          value: sample.value,
          dimensions: sample.dimensions,
          at: sample.at.toISOString(),
        })}\n`,
      );
    }
  }
}
