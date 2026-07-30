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
import { catchError, from, mergeMap, tap, throwError } from "rxjs";

import type { AuditRecord, AuditRepository } from "@aios/application";

import { permissionFor, resourceOf } from "./route-registry.js";

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

    // Reads are not audited. The audit records decisions about *actions*, and a
    // row per list request would bury the ones that matter. `mvp.md` asks for
    // "every protected action", and a query is not one.
    if (method === "GET") {
      return next.handle();
    }

    const base = {
      authorizationAuditId: randomUUID(),
      requestId: randomUUID(),
      correlationId: randomUUID(),
      commandId: null,
      commandType: route,
      permission: permissionFor(method, request.route?.path ?? request.path),
      evaluatedAt: new Date(),
    };

    const write = (entry: AuditRecord): Promise<void> =>
      this.audit.record(entry).catch((error: unknown) => {
        // Loud, and not fatal. An audit outage must not become an availability
        // outage, and the entry is reconstructable from this line.
        console.error("Audit write failed", { entry, error });
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
            outcome: "Deny",
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
