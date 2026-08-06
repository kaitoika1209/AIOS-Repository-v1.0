#!/usr/bin/env node
/**
 * A readiness-routing reverse proxy, standing in for the ALB.
 *
 *     node scripts/staging_proxy.mjs 3100 3101:3111 3102:3112
 *
 * This is **not** an Application Load Balancer and does not pretend to be one.
 * It implements the two rules the AIOS deployment actually depends on, so that
 * the *application's* half of the contract can be rehearsed without an AWS
 * account:
 *
 *   1. **Route on readiness, not liveness.** A target is eligible only while
 *      `GET /health/ready` on its probe port answers `200`. `infra/03-compute.yaml`
 *      points the real target group at the same path and port, and
 *      `check_infra.py` asserts it.
 *   2. **Hysteresis, not a hair trigger.** Two consecutive successes to enter
 *      rotation, three consecutive failures to leave — the same shape as the
 *      target group's `HealthyThresholdCount` and `UnhealthyThresholdCount`.
 *      Without it a single slow probe removes a healthy replica, and the
 *      rehearsal measures the proxy rather than the application.
 *
 * What it deliberately does not do: TLS, connection draining, sticky sessions,
 * or anything else whose behaviour would be a claim about AWS rather than about
 * AIOS. When it has no healthy target it answers `503` with
 * `NO_HEALTHY_TARGET`, which is **distinguishable from the application's own
 * `SERVICE_UNAVAILABLE`** — during a database outage the difference between
 * "every replica refused to serve" and "the ingress lost them" is the first
 * question runbook 1 asks, and a proxy that returned the same body as the app
 * would make it unanswerable.
 */

import { createServer, request as httpRequest } from "node:http";

const [listenPort, ...targetSpecs] = process.argv.slice(2);

if (targetSpecs.length === 0) {
  console.error("usage: staging_proxy.mjs <listen-port> <app:probe> [<app:probe> ...]");
  process.exit(1);
}

const HEALTHY_AFTER = 2;
const UNHEALTHY_AFTER = 3;
const PROBE_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 1_500;

const targets = targetSpecs.map((spec) => {
  const [app, probe] = spec.split(":");
  return {
    app: Number(app),
    probe: Number(probe),
    healthy: false,
    successes: 0,
    failures: 0,
    reason: "never probed",
  };
});

let next = 0;

const log = (event, detail) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

const probe = (target) =>
  new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: target.probe, path: "/health/ready", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ ok: res.statusCode === 200, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: "probe timeout" });
    });
    req.on("error", (error) => resolve({ ok: false, body: error.code ?? "error" }));
    req.end();
  });

const sweep = async () => {
  for (const target of targets) {
    const { ok, body } = await probe(target);
    let reason = body;
    try {
      reason = JSON.parse(body).reasonCode ?? body;
    } catch {
      /* the probe answered with something that is not JSON; keep it verbatim */
    }

    if (ok) {
      target.failures = 0;
      target.successes += 1;
      if (!target.healthy && target.successes >= HEALTHY_AFTER) {
        target.healthy = true;
        log("target.in_rotation", { app: target.app, after: target.successes });
      }
    } else {
      target.successes = 0;
      target.failures += 1;
      if (target.healthy && target.failures >= UNHEALTHY_AFTER) {
        target.healthy = false;
        log("target.out_of_rotation", { app: target.app, reason, after: target.failures });
      }
    }
    target.reason = reason;
  }
};

setInterval(() => void sweep(), PROBE_INTERVAL_MS).unref?.();
void sweep();

createServer((clientReq, clientRes) => {
  // The proxy's own view of the fleet, so a rehearsal can ask what the ingress
  // believed at the moment of a failure rather than reconstructing it.
  if (clientReq.url === "/__targets") {
    clientRes.writeHead(200, { "content-type": "application/json" });
    clientRes.end(
      JSON.stringify(
        targets.map((t) => ({
          app: t.app,
          healthy: t.healthy,
          reason: t.reason,
          successes: t.successes,
          failures: t.failures,
        })),
      ),
    );
    return;
  }

  const eligible = targets.filter((t) => t.healthy);

  if (eligible.length === 0) {
    clientRes.writeHead(503, { "content-type": "application/json", "retry-after": "5" });
    clientRes.end(
      JSON.stringify({
        code: "NO_HEALTHY_TARGET",
        message: "The load balancer has no target in rotation.",
        targets: targets.map((t) => ({ app: t.app, reason: t.reason })),
      }),
    );
    log("request.no_target", { method: clientReq.method, url: clientReq.url });
    return;
  }

  const target = eligible[next++ % eligible.length];
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: target.app,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, "x-staging-target": String(target.app) },
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, {
        ...upstreamRes.headers,
        // Which replica served it. The whole point of runbook 5's mixed-version
        // exercise is being able to tell the two apart from the outside.
        "x-staging-target": String(target.app),
      });
      upstreamRes.pipe(clientRes);
    },
  );

  upstream.on("error", (error) => {
    clientRes.writeHead(502, { "content-type": "application/json" });
    clientRes.end(JSON.stringify({ code: "UPSTREAM_ERROR", target: target.app, error: error.code }));
  });

  clientReq.pipe(upstream);
}).listen(Number(listenPort), () =>
  log("proxy.listening", { port: Number(listenPort), targets: targets.map((t) => t.app) }),
);
