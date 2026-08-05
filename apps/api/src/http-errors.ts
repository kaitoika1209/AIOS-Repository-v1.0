/**
 * Domain and application errors mapped to the HTTP contract in ADR-0014.
 *
 * The mapping is by error *code*, never by message text, which is what lets
 * messages change without changing behaviour.
 *
 * Two choices are deliberate:
 *
 * - An invalid state-machine transition is `409`, not `422`. The request is well
 *   formed and no invariant is broken; the Aggregate is simply not in a state
 *   that accepts the command.
 * - A cross-tenant resource is `404`, never `403`. A `403` would confirm that
 *   the resource exists in some other Organization.
 */

import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { Response } from "express";

import { DomainError } from "@aios/domain";
import {
  describeError,
  getLogger, AccessDeniedError, NotFoundError } from "@aios/application";

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  WORK_INVALID_TRANSITION: 409,
  DECISION_INVALID_TRANSITION: 409,
  WORK_COMPLETION_GATE_UNSATISFIED: 409,
  WORK_BLOCKING_DECISION_EXISTS: 409,
  WORK_BLOCKING_REFERENCE_MISMATCH: 409,
  WORK_IMMUTABLE: 409,
  DECISION_IMMUTABLE: 409,
  MEMORY_INVALID_TRANSITION: 409,
  MEMORY_IMMUTABLE: 409,
  MEMBERSHIP_INVALID_TRANSITION: 409,
  ORGANIZATION_INVALID_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  VALIDATION_FAILED: 422,
  HUMAN_AUTHORITY_REQUIRED: 403,
  // Cross-Organization references are reported as absent, not forbidden.
  CROSS_ORGANIZATION_REFERENCE: 404,
  // An unacceptable invitation is reported as absent for the same reason a
  // cross-tenant resource is. A `409` here would separate "this token exists
  // but is expired" from "this token is not real", which is precisely the
  // distinction a caller guessing tokens wants.
  INVITATION_NOT_ACCEPTABLE: 404,
};

/**
 * Application error codes that are not `DomainError`s.
 *
 * `RECOVERY_NOT_PERMITTED` is `422`: the request is well formed and the caller
 * holds the permission, but the consumer's registration forbids the operation.
 * A `403` would say the caller lacks authority, which is the wrong diagnosis —
 * no role grants a skip the registration prohibits.
 */
const APPLICATION_STATUS: Readonly<Record<string, number>> = {
  RECOVERY_NOT_PERMITTED: 422,
  // `409`, not `422`: the request is well formed and the Membership is in a
  // state that accepts the command. What refuses it is the Organization's
  // current shape, which the caller can change by appointing another Owner.
  LAST_OWNER_REQUIRED: 409,
  // Well-formed, and the Organization accepts archival — what refuses it is
  // Work the caller can still finish or cancel.
  LIVE_WORK_REMAINS: 409,
  // `422`, not `403`: the caller holds the assistance permission and the route
  // exists. What refuses it is the absence of an Organization grant, which no
  // role can supply — "deny-by-default" (ADR-0011).
  ASSISTANCE_NOT_GRANTED: 422,
};

const codeOf = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : null;

/** Codes for framework exceptions that carry none of their own. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  401: "NOT_AUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION_FAILED",
};

/**
 * The database is unreachable, shutting down, or refusing writes.
 *
 * These are `503`, not `500`, and running runbook 1 is what found them mapped
 * wrongly: stopping PostgreSQL under the API turned every authoritative command
 * into `500 INTERNAL_ERROR`. The runbook asks an operator to "reject
 * authoritative commands safely", and a `500` is not safe rejection — it is
 * indistinguishable from a defect in the code. A client will not retry it, an
 * SLI counts it against the service's own correctness rather than its
 * dependency's availability, and an operator reading logs sees
 * `http.unhandled_error` instead of a database outage they could have named in
 * one glance.
 *
 * `503` says the opposite of all three: temporary, retry, not our logic.
 *
 * Node socket errors cover unreachable; PostgreSQL class `08` is a connection
 * exception and class `57` is operator intervention — `57P01` admin shutdown,
 * `57P03` cannot connect now, both of which a restart or failover produces.
 * `53300` is too many connections, which is the pool exhaustion runbook 1's
 * sibling covers, and `25006` is a write attempted against a read-only
 * transaction, which is what a promoted replica answers.
 */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "25006",
]);

const isUnavailable = (error: unknown): boolean => {
  const code = codeOf(error);
  if (code === null) return false;
  // Class 08 is "connection exception" in full: 08000, 08003, 08006, 08001,
  // 08004, 08007, 08P01. Matched by prefix rather than enumerated, because the
  // class is the thing that means "the connection failed" and a member added by
  // a future PostgreSQL release should not need a code change here.
  return UNAVAILABLE_CODES.has(code) || code.startsWith("08");
};

/** Codes whose responses are flattened to an indistinguishable `NOT_FOUND`. */
const OPAQUE_CODES = new Set([
  "CROSS_ORGANIZATION_REFERENCE",
  "INVITATION_NOT_ACCEPTABLE",
]);

export const statusFor = (error: unknown): number => {
  if (error instanceof AccessDeniedError) return 403;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof DomainError) return DOMAIN_STATUS[error.code] ?? 400;

  const code = codeOf(error);
  if (code !== null && code in APPLICATION_STATUS) return APPLICATION_STATUS[code]!;

  // Before the `HttpException` branch and before the `500` default: a driver
  // error carries no HTTP status of its own, so nothing else would catch it.
  if (isUnavailable(error)) return 503;

  if (error instanceof HttpException) return error.getStatus();
  return 500;
};

export const bodyFor = (error: unknown): ErrorBody => {
  if (error instanceof AccessDeniedError) {
    return {
      code: "PERMISSION_DENIED",
      // Deliberately names neither the permission nor the missing relationship.
      // The first would tell a caller which capability to go looking for; the
      // second would tell them they hold the right role and only need to get
      // themselves added to the resource. Both responses are byte-identical.
      message: "You do not have permission to perform this action.",
      details: {},
    };
  }

  if (error instanceof NotFoundError) {
    return { code: "NOT_FOUND", message: error.message, details: {} };
  }

  if (error instanceof DomainError) {
    if (OPAQUE_CODES.has(error.code)) {
      // Code, message, and details are all replaced. Leaving any of the three
      // in place would reintroduce the distinction the status code hides. The
      // original reason stays on the error object for the server log.
      return { code: "NOT_FOUND", message: "Not found.", details: {} };
    }
    return {
      code: error.code,
      message: error.message,
      details: error.details as Record<string, unknown>,
    };
  }

  const applicationCode = codeOf(error);
  if (applicationCode !== null && applicationCode in APPLICATION_STATUS) {
    return {
      code: applicationCode,
      message: error instanceof Error ? error.message : "Not permitted.",
      details: {},
    };
  }

  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === "object" && response !== null && "code" in response) {
      return {
        code: String((response as { code: unknown }).code),
        message: error.message,
        details: {},
      };
    }
    return {
      // Derived from the status rather than defaulting everything to
      // `REQUEST_INVALID`. ADR-0014 makes the code the stable, machine-readable
      // part of the contract, and reporting a failed sign-in as a malformed
      // request tells a client to fix the wrong thing.
      code: STATUS_CODES[error.getStatus()] ?? "REQUEST_INVALID",
      message: error.message,
      details: {},
    };
  }

  if (isUnavailable(error)) {
    // No driver message, no host, no port, no user. The code is the whole
    // contract — the same rule the diagnostic surface follows, and for the same
    // reason: a driver's message routinely quotes the connection string.
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "The service is temporarily unable to handle this request.",
      details: {},
    };
  }

  return { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", details: {} };
};

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = statusFor(error);

    if (status === 503) {
      // Logged as an outage rather than as a defect, at WARN rather than ERROR:
      // the service is behaving correctly and its dependency is not. Logging it
      // as `http.unhandled_error` was what made a database outage read like a
      // code fault in the one place an operator looks first.
      getLogger().log({
        severity: "WARN",
        operationalLogName: "http.dependency_unavailable",
        operationalLogClass: "Request",
        operationalLogCategory: "Application",
        message: "A request could not be served because a dependency is unavailable.",
        outcome: "Failure",
        attributes: describeError(error),
      });
      // The client is told to come back rather than left to guess. Short,
      // because a database restart is seconds and a failover is tens of them —
      // and because every client waiting the same long interval is a thundering
      // herd at the end of it.
      response.setHeader("Retry-After", "5");
    }

    if (status === 500) {
      // Internal detail stays in the log; the client gets a stable envelope.
      // The one place every unmapped failure passes through, which is why it
      // must not spread the error object: `detail` on a unique violation is a
      // user's value, and duplicates are ordinary traffic here.
      getLogger().log({
        severity: "ERROR",
        operationalLogName: "http.unhandled_error",
        operationalLogClass: "Request",
        operationalLogCategory: "Application",
        message: "A request failed with an unmapped error.",
        outcome: "Failure",
        attributes: describeError(error),
      });
    }

    response.status(status).json(bodyFor(error));
  }
}
