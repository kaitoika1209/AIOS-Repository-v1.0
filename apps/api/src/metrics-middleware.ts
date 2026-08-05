/**
 * RED metrics for HTTP traffic (baseline item 5).
 *
 * Rate, errors, duration — from one counter and one histogram, dimensioned the
 * way the architecture specifies:
 *
 *     http_server_requests_total{service, route_template, http_method,
 *                                operation, outcome_class}
 *
 * `route_template` rather than the request path, and `outcome_class` rather than
 * the status code. Both are cardinality decisions and both matter: a path
 * carries identifiers, and a dimension per status code would be five hundred
 * time series for one metric against ADR-0003's budget of a hundred in total.
 *
 * `operation` is the permission identifier, the same value ADR-0014 requires the
 * audit to record — so a spike in one metric and the audit rows behind it are
 * joined by a field rather than by guesswork.
 *
 * ## Why middleware, and not an interceptor
 *
 * This started as an interceptor and was wrong twice, both times found by
 * issuing real requests and reading what came out.
 *
 * **An interceptor cannot see the status.** Nest runs interceptors *before*
 * exception filters, so on the error path the filter has not set the status yet
 * and `response.statusCode` is still the default `200`. Every refusal and every
 * failure was recorded as `2xx` — the errors half of RED silently zero.
 *
 * **An interceptor cannot see a guard's refusal at all.** Guards run before
 * interceptors, so a request rejected for a missing Membership or a failed
 * authentication never reaches one. Those are the most security-relevant
 * denials there are, and they were invisible.
 *
 * Middleware runs before guards, and `response.on("finish")` fires after the
 * filter has written the status. So this sees every request exactly once, with
 * its real outcome, including the ones nothing else in the pipeline observes.
 */

import type { NextFunction, Request, Response } from "express";

import { getMetrics, outcomeClassOf } from "@aios/application";

import { permissionFor } from "./route-registry.js";

/**
 * The route pattern, or a bounded stand-in.
 *
 * `request.route` is undefined when nothing matched — a 404 for a path nobody
 * registered. Falling back to `request.path` there would put an arbitrary
 * caller-supplied string into a metric dimension, which is the cardinality
 * explosion and a tenant-data leak in one move. `unmatched` is the honest
 * answer, and its rate is itself worth watching.
 */
const routeTemplateOf = (request: Request): string =>
  request.route?.path ?? "unmatched";

export const metricsMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const startedAt = process.hrtime.bigint();

  response.on("finish", () => {
    const route_template = routeTemplateOf(request);

    const metrics = getMetrics();
    metrics.count("http_server_requests_total", {
      route_template,
      http_method: request.method,
      // "none" for the routes that hold no permission — invitation acceptance,
      // Organization creation, listing your own Memberships, and ordinary
      // reads. A bounded literal rather than an absent dimension, so two
      // different things do not look alike in a query.
      operation: permissionFor(request.method, route_template) ?? "none",
      outcome_class: outcomeClassOf(response.statusCode),
    });
    metrics.observe(
      "http_server_request_duration_seconds",
      Number(process.hrtime.bigint() - startedAt) / 1e9,
      // Deliberately without `outcome_class`. Latency is a question about the
      // route, and splitting it by outcome doubles the series to answer a
      // question the counter already answers.
      { route_template, http_method: request.method },
    );
  });

  next();
};
