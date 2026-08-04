/**
 * The probe listener.
 *
 * A separate HTTP server, on its own port, rather than routes on the API.
 * Three reasons, in order of weight:
 *
 * 1. **The Worker has no API.** It is its own process (baseline item 13) with no
 *    Nest application and no routes, and the architecture requires it to have
 *    liveness and readiness all the same. Serving probes from the API would
 *    leave the Worker unobservable, so a second mechanism would be needed
 *    anyway. This is that mechanism, used by both.
 *
 * 2. **The authorization guard stays absolute.** A load balancer holds no
 *    credential, so probes must be reachable without one — and `app.ts` states
 *    the property this preserves: "no route can be reached without a resolved
 *    principal (ADR-0013)". Adding an unauthenticated path through
 *    `RequestContextGuard` would make that sentence false for every reader who
 *    relies on it. Here there is no guard to exempt.
 *
 * 3. **The port need not be public.** An orchestrator reaches it inside the
 *    network; nothing has to route it from outside.
 *
 * What it returns is deliberately almost nothing. The architecture: the endpoint
 * "MUST return a minimal status and MUST NOT expose dependency names, connection
 * details, versions, or error text publicly." A reason code is a bounded enum
 * from `health.ts`, not a message, and is the only detail on the wire.
 *
 *     GET /health/live    → 200 always, unless shutting down
 *     GET /health/ready   → 200 Ready, 503 otherwise
 */

import { createServer, type Server } from "node:http";

import { getLogger } from "@aios/application";

import type { ProbeResult } from "./health.js";

export interface ProbeServerOptions {
  readonly port: number;
  /**
   * What this process reports for liveness.
   *
   * Supplied rather than assumed constant: the Worker answers it from its loop
   * heartbeat, and both processes answer `Unready` once shutdown begins so an
   * orchestrator stops routing before the process disappears.
   */
  readonly liveness: () => ProbeResult;
  readonly readiness: () => Promise<ProbeResult>;
}

const send = (
  response: import("node:http").ServerResponse,
  result: ProbeResult,
): void => {
  // 503 for anything that is not `Ready`, including `Unknown`. Missing evidence
  // must not be presented as healthy, and there is no HTTP status that means
  // "we could not tell" — so it is treated as not ready, which is the safe
  // direction for a routing decision.
  const status = result.status === "Ready" ? 200 : 503;
  const body = JSON.stringify({ status: result.status, reasonCode: result.reasonCode });
  response.writeHead(status, {
    "content-type": "application/json",
    // A cached probe answer is a stale probe answer.
    "cache-control": "no-store",
  });
  response.end(body);
};

export const startProbeServer = (options: ProbeServerOptions): Server => {
  const server = createServer((request, response) => {
    // No routing library and no request parsing: this server exists to answer
    // two fixed paths, and every additional capability is attack surface on a
    // port that answers before authentication.
    const path = (request.url ?? "").split("?")[0];

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }

    if (path === "/health/live") {
      send(response, options.liveness());
      return;
    }

    if (path === "/health/ready") {
      void options
        .readiness()
        .then((result) => send(response, result))
        // A probe that throws is not ready. Reporting the failure as `Unknown`
        // rather than inventing a cause keeps the bounded reason codes honest.
        .catch(() => send(response, { status: "Unknown", reasonCode: "PROBE_TIMEOUT" }));
      return;
    }

    response.writeHead(404).end();
  });

  // The probe port must never be the reason the process stays alive.
  server.unref();
  server.listen(options.port, () => {
    getLogger().log({
      severity: "INFO",
      operationalLogName: "probe.listening",
      operationalLogClass: "Operations",
      operationalLogCategory: "Operations",
      message: "Probe listener started.",
      outcome: "Success",
      attributes: { "http.port": options.port },
    });
  });

  return server;
};
