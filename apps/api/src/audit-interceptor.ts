/**
 * Records every authorization decision.
 *
 * At the edge, in one place, rather than in each use case. That is not a
 * shortcut: a per-use-case call is forgettable, and the outcome most worth
 * recording is a denial — which a use case that refused never reaches the end of.
 *
 * Placed after the guard so the resolved principal is available, and wrapping the
 * handler so the outcome is observed rather than predicted. `mvp.md` asks that
 * "every protected action records the acting principal"; this is the one path
 * every protected action takes.
 *
 * A failure to write the audit row must not fail the request. The alternative —
 * refusing a successful command because its audit write failed — would turn an
 * observability outage into an availability one, and the row is recoverable from
 * the log. The failure is logged loudly rather than swallowed silently.
 */

import { randomUUID } from "node:crypto";
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Request } from "express";

import {
  describeError,
  getLogger,
  correlationIdForRecord,
  requestIdForRecord,
} from "@aios/application";
import { catchError, from, mergeMap, tap, throwError } from "rxjs";

import type { AuditRecord, AuditRepository } from "@aios/application";

import { isAuditedRead, permissionFor, resourceOf } from "./route-registry.js";

/**
 * The audited request, as the interceptor can see it.
 *
 * Everything here comes from the guard's resolution or the route, never from the
 * body: a caller must not be able to influence what their own audit row says.
 */
const subjectOf = (request: Request) => {
  const context = request.aios;
  if (context !== undefined) {
    return {
      principalId: context.principal.membershipId,
      principalType: context.principal.type,
      identityId: context.principal.identityId,
      membershipId: context.principal.membershipId,
      organizationId: context.organizationId,
    };
  }

  // Authenticated but with no Organization context: invitation acceptance and
  // Organization creation. The subject is known; the Membership is not.
  //
  // There is no third branch. A request with neither was refused by the guard,
  // which runs before this interceptor and records its own denials — see
  // `RequestContextGuard.deny`.
  const authenticated = request.aiosSubject!;
  return {
    principalId: `${authenticated.provider}:${authenticated.subject}`,
    principalType: "AuthenticatedSubject",
    identityId: null,
    membershipId: null,
    organizationId: null,
  };
};

/**
 * Whether the system refused the caller, or broke.
 *
 * `Deny` is a decision: a permission not held, a resource in another
 * Organization, a transition the Aggregate rejected, a request the edge would
 * not parse. Every one of those is the model working.
 *
 * `Failed` is everything else — an unhandled error after the caller was allowed
 * through. Recording those as denials was a real defect: runbook 4 reads
 * `outcome = 'Deny'` to find authority violations and probing, and an internal
 * error counted as a refusal is a false finding in the one place false findings
 * are most expensive.
 *
 * Classified by what Nest already decided rather than by matching error classes.
 * The exception filter maps every refusal to a 4xx and everything else to a 500,
 * so the status is the classification — and a new refusal type added later
 * inherits the right outcome instead of quietly landing in `Failed`.
 */
const outcomeOf = (error: unknown): "Deny" | "Failed" => {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;

  if (status !== undefined && status >= 400 && status < 500) return "Deny";
  // Not an HTTP exception at all: a domain refusal or an authorization error on
  // its way to the filter, which will map it to a 4xx.
  if (status === undefined && isRefusal(error)) return "Deny";
  return "Failed";
};

/**
 * A refusal that has not yet been mapped to a status.
 *
 * The interceptor wraps the handler and the filter runs after it, so a domain
 * rejection arrives here as itself. Matched on the `code` the domain sets rather
 * than on the class, because the classes live in three packages and an
 * `instanceof` across a workspace boundary is a bug waiting for a duplicated
 * dependency.
 */
const isRefusal = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = String((error as { code: unknown }).code);
  return code === "PERMISSION_DENIED" || code === "NOT_FOUND" || DOMAIN_CODE.test(code);
};

/** `WORK_INVALID_TRANSITION`, `VALIDATION_FAILED`, `VERSION_CONFLICT`, … */
const DOMAIN_CODE = /^[A-Z][A-Z_]+$/;

const codeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error
      ? error.name
      : "UNKNOWN";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditRepository) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method;
    const route = `${method} ${request.route?.path ?? request.path}`;

    // Ordinary reads are not audited. The audit records decisions about
    // *actions*, and a row per list request would bury the ones that matter.
    // `mvp.md` asks for "every protected action", and a query is not one.
    //
    // Privileged operational reads are the exception (ADR-0022). The
    // architecture requires the operational surface to "audit privileged or
    // cross-Organization access under the audit durability policy", and reading
    // an Organization's failed deliveries or stalled workflows is a privileged
    // access whether or not it changes anything. `isAuditedRead` names exactly
    // which reads those are; `GET /notifications` is not one of them.
    if (method === "GET" && !isAuditedRead(method, request.route?.path ?? request.path)) {
      return next.handle();
    }

    const base = {
      authorizationAuditId: randomUUID(),
      requestId: requestIdForRecord(),
      correlationId: correlationIdForRecord(),
      commandId: null,
      commandType: route,
      permission: permissionFor(method, request.route?.path ?? request.path),
      evaluatedAt: new Date(),
    };

    const write = (entry: AuditRecord): Promise<void> =>
      this.audit.record(entry).catch((error: unknown) => {
        // Loud, and not fatal. An audit outage must not become an availability
        // outage, and the entry is reconstructable from this line.
        // The entry is deliberately absent. It carries principal, Organization,
        // and resource identifiers, and the error carries whatever value the
        // database objected to.
        getLogger().log({
          severity: "ERROR",
          operationalLogName: "audit.write_failed",
          operationalLogClass: "Authorization",
          operationalLogCategory: "Security",
          message: "A command audit record could not be written.",
          outcome: "Failure",
          attributes: {
            "authorization.permission": entry.permission,
            ...describeError(error),
          },
        });
      });

    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          const subject = subjectOf(request);
          const resource = resourceOf(request, body);
          void write({
            ...base,
            ...subject,
            resourceType: resource.type,
            resourceId: resource.id,
            outcome: "Allow",
            reasonCode: null,
            // The state the command produced, when the response reports one.
            // `previousState` is what the resource was before, which only a
            // status-changing response can tell us about.
            previousState: resource.previousState,
            nextState: resource.nextState,
            resultingEventId: null,
          });
        },
      }),
      catchError((error: unknown) => {
        const subject = subjectOf(request);
        const resource = resourceOf(request, undefined);
        return from(
          write({
            ...base,
            ...subject,
            resourceType: resource.type,
            resourceId: resource.id,
            outcome: outcomeOf(error),
            // The refusal's own code — `PERMISSION_DENIED`, `NOT_FOUND`,
            // `WORK_INVALID_TRANSITION`. This is the record that would not exist
            // at all without this interceptor.
            reasonCode: codeOf(error),
            previousState: null,
            nextState: null,
            resultingEventId: null,
          }),
        ).pipe(mergeMap(() => throwError(() => error)));
      }),
    );
  }
}
