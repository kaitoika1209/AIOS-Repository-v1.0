/**
 * Outbox worker entry point.
 *
 * The asynchronous halves of ADR-0007 and ADR-0008: propagating Decision
 * outcomes onto the Work completion gate, projecting notifications, and turning
 * a completed Work into a generated Memory draft.
 *
 * Its own process because the observability baseline requires "separate HTTP
 * liveness/readiness, Worker liveness/readiness" — a Worker that cannot be
 * observed or paused independently of the API is not a Worker, it is a timer
 * inside a web server. `chooseWorkerMode` keeps the API from also draining
 * unless the environment says to, so the two do not silently double up.
 *
 * Running several of these at once is safe. The Outbox claim uses
 * `FOR UPDATE SKIP LOCKED` and each consumer records its own delivery, so two
 * workers divide the queue rather than duplicating it.
 *
 *     pnpm --filter @aios/api worker
 */

import "reflect-metadata";

import { createPool } from "@aios/persistence";

import { chooseGenerator } from "./anthropic-memory-generator.js";
import { SECRETARY_IDENTITY_ID, dependenciesFor } from "./app.js";
import { loopLiveness, workerReadiness } from "./health.js";
import { drainOutbox } from "./outbox-worker.js";
import { startProbeServer } from "./probe-server.js";

/** How long to wait after an empty drain before polling again. */
const IDLE_INTERVAL_MS = Number.parseInt(process.env["WORKER_INTERVAL_MS"] ?? "500", 10);

/** How many messages one drain claims. */
const BATCH_SIZE = Number.parseInt(process.env["WORKER_BATCH_SIZE"] ?? "20", 10);

const main = async (): Promise<void> => {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is required.");
  }

  const pool = createPool({ connectionString });
  const deps = dependenciesFor(pool);

  const { generator, reason } = chooseGenerator(process.env);
  console.log(`Outbox worker starting. Memory generation: ${reason}`);

  const options = {
    memory: {
      generator,
      secretaryIdentityId: SECRETARY_IDENTITY_ID,
      systemPrincipalId: "memory-generator",
      // Distinguishes this worker's generation lease from another replica's, so
      // an abandoned attempt can be attributed when it is reclaimed.
      workerId: process.env["WORKER_ID"] ?? `worker-${process.pid}`,
    },
  };

  let stopping = false;
  /** Resolves once the drain in flight has finished, so shutdown can wait. */
  let inFlight: Promise<unknown> = Promise.resolve();

  /**
   * When the loop last completed a pass.
   *
   * The one thing Worker liveness can usefully check. A drain that is slow is
   * alive; a loop that stopped turning is not, and only the second is repaired
   * by a restart.
   */
  let lastTickAt: Date | null = null;

  // Generous against the interval, because a Worker restarted for being busy is
  // worse than one restarted late: a drain claims Outbox rows, and killing it
  // mid-claim leaves them to expire rather than being handed back.
  const STALL_AFTER_MS = Number.parseInt(
    process.env["WORKER_STALL_MS"] ?? String(Math.max(IDLE_INTERVAL_MS * 20, 60_000)),
    10,
  );

  startProbeServer({
    port: Number.parseInt(process.env["PROBE_PORT"] ?? "3012", 10),
    liveness: () =>
      stopping
        ? { status: "Unready", reasonCode: "SHUTTING_DOWN" }
        : loopLiveness(lastTickAt, new Date(), STALL_AFTER_MS),
    readiness: async () =>
      stopping
        ? { status: "Unready", reasonCode: "SHUTTING_DOWN" }
        : workerReadiness(pool),
  });

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; finishing the drain in flight.`);
    // Waited on rather than cut short: a drain killed midway leaves claimed
    // messages to time out rather than being handed back, which delays exactly
    // the work a deploy was trying not to disrupt.
    void inFlight.finally(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  while (!stopping) {
    inFlight = drainOutbox(pool, deps, BATCH_SIZE, options)
      .then((result) => {
        if (result.applied > 0 || result.failed > 0 || result.notified > 0) {
          console.log(
            JSON.stringify({
              event: "outbox.drain",
              claimed: result.claimed,
              applied: result.applied,
              alreadyApplied: result.alreadyApplied,
              failed: result.failed,
              notified: result.notified,
            }),
          );
        }
        return result;
      })
      .catch((error: unknown) => {
        // Logged and retried on the next tick. A worker that exits on the first
        // transient database error is a worker that needs a supervisor to do
        // what the loop can do itself.
        console.error("Outbox worker error", error);
        return null;
      });

    await inFlight;
    // After the drain settles, whether it succeeded or failed. A Worker whose
    // every drain is erroring is still turning, and a restart would not help —
    // that is asynchronous workflow health's problem, not liveness's.
    lastTickAt = new Date();

    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_INTERVAL_MS));
    }
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
