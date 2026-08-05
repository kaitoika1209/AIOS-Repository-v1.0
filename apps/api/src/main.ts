/**
 * API entry point.
 *
 * Clerk authenticates when it is configured; the development adapter runs only
 * in development and test, and `chooseAuth` refuses to start otherwise. Clerk
 * replaces `DevAuthAdapter` and nothing else (ADR-0013).
 */

import "reflect-metadata";

import {
  describeError,
  getLogger, setLogger } from "@aios/application";
import { createPool } from "@aios/persistence";

import { buildDevApp } from "./app.js";
import { httpReadiness } from "./health.js";
import { captureUnhandledFailures } from "./failure-capture.js";
import { chooseLogger } from "./json-logger.js";
import { startMetrics } from "./metrics-setup.js";
import { startProbeServer } from "./probe-server.js";

const main = async (): Promise<void> => {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is required.");
  }

  // The adapter choice, and its refusal to run unverified outside development,
  // live in `chooseAuth` so the same rule applies to every entry point rather
  // than only to this one.
  const { logger, reason: logReason } = chooseLogger(process.env, "aios-api");
  setLogger(logger);
  // Registered immediately after the logger, so a failure during the rest of
  // startup is captured rather than printed and lost.
  captureUnhandledFailures();
  logger.log({
    severity: "INFO",
    operationalLogName: "logging.configured",
    operationalLogClass: "Operations",
    operationalLogCategory: "Operations",
    message: "Structured logging configured.",
    attributes: { "operations.log_sink": logReason },
  });

  const app = await buildDevApp(connectionString);

  // The first structured record, and a check that the envelope serializes at
  // all — a logger that throws on its first real call is one that throws during
  // an incident.
  logger.log({
    severity: "INFO",
    operationalLogName: "service.started",
    operationalLogClass: "Operations",
    operationalLogCategory: "Operations",
    message: "AIOS API started.",
    outcome: "Success",
  });
  const port = Number.parseInt(process.env["PORT"] ?? "3001", 10);

  // Its own pool, deliberately. Readiness exists partly to detect a saturated
  // request pool, and a probe drawing from that pool would be unable to report
  // the exhaustion it is meant to catch — it would simply block.
  const probePool = createPool({ connectionString, max: 2 });

  // On the probe pool rather than the request pool, for the same reason the
  // probes are: a collector that competed for request connections would report
  // the pool exhaustion it had helped cause.
  const metrics = startMetrics(process.env, "aios-api", probePool);
  let shuttingDown = false;

  startProbeServer({
    port: Number.parseInt(process.env["PROBE_PORT"] ?? "3011", 10),
    // Nothing but the process itself: a liveness probe that touched PostgreSQL
    // would turn a brief database outage into every replica restarting at once.
    liveness: () =>
      shuttingDown
        ? { status: "Unready", reasonCode: "SHUTTING_DOWN" }
        : { status: "Ready", reasonCode: "OK" },
    readiness: async () =>
      shuttingDown
        ? { status: "Unready", reasonCode: "SHUTTING_DOWN" }
        : httpReadiness(probePool),
  });

  // Reported before the server stops accepting, so a load balancer has a chance
  // to drain this instance rather than discovering it mid-request.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      shuttingDown = true;
      metrics.stop();
      // Flushed inside its own deadline, so a hung telemetry backend cannot
      // hold the process past its termination grace period. The exporter
      // returns false and counts the timeout rather than waiting.
      void app.close().finally(() => {
        void metrics.sink.shutdown().finally(() => {
          void probePool.end().finally(() => process.exit(0));
        });
      });
    });
  }

  await app.listen(port);
  logger.log({
    severity: "INFO",
    operationalLogName: "http.listening",
    operationalLogClass: "Operations",
    operationalLogCategory: "Operations",
    message: `AIOS API listening on :${port}`,
    outcome: "Success",
    attributes: { "http.port": port },
  });
};

main().catch((error: unknown) => {
  // Startup failed. The logger may not be configured yet, so this goes through
  // `getLogger()` — which discards when unset — and then to stderr regardless.
  // A process that cannot start is the one case where saying it twice is right.
  getLogger().log({
    severity: "ERROR",
    operationalLogName: "service.start_failed",
    operationalLogClass: "Operations",
    operationalLogCategory: "Operations",
    message: "The service failed to start.",
    outcome: "Failure",
    attributes: describeError(error),
  });
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
