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
import { AccessDeniedError, NotFoundError } from "@aios/application";

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

  return { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", details: {} };
};

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = statusFor(error);

    if (status === 500) {
      // Internal detail stays in the log; the client gets a stable envelope.
      console.error("Unhandled error", error);
    }

    response.status(status).json(bodyFor(error));
  }
}
