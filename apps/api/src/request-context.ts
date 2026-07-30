/**
 * Per-request context: who is acting, in which Organization, at what time.
 *
 * ADR-0014 resolves tenancy once at the edge from a verified `X-Organization-Id`
 * header rather than repeating it in every path. This guard is that edge — no
 * handler runs before it has produced a principal.
 */

import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { randomUUID } from "node:crypto";

import { OrganizationId, type HumanMemberPrincipal } from "@aios/types";
import {
  AUDIT_OUTCOMES,
  type AuditRepository,
} from "@aios/application";

import { permissionFor } from "./route-registry.js";
import {
  PrincipalResolver,
  type AuthenticatedSubject,
  type ResolutionFailure,
} from "./principal-resolver.js";

export type { AuthenticatedSubject };

/** Extracts the authenticated subject from a request. */
export interface AuthAdapter {
  authenticate(request: Request): Promise<AuthenticatedSubject | null>;
}

export interface RequestContext {
  readonly principal: HumanMemberPrincipal;
  readonly organizationId: OrganizationId;
  readonly now: Date;
  readonly idempotencyKey: string | null;
  readonly expectedVersion: number | null;
}

/**
 * An authenticated caller with no Organization context.
 *
 * There is exactly one route in this shape — invitation acceptance — and it has
 * no principal because the caller is not yet a Member of anything.
 */
export interface AnonymousOrganizationContext {
  readonly subject: AuthenticatedSubject;
  readonly now: Date;
}

declare module "express" {
  interface Request {
    aios?: RequestContext;
    aiosSubject?: AuthenticatedSubject;
  }
}

export const WITHOUT_ORGANIZATION = "aios:withoutOrganization";

/**
 * Exempt a route from Organization resolution — and only from that.
 *
 * ADR-0014 permits this for invitation acceptance alone: the caller holds no
 * Membership in the target Organization, so the resolution chain cannot succeed
 * and `X-Organization-Id` has nothing to select among. Authentication is still
 * required, and the route names no Organization of its own.
 *
 * Marking any other route with this is a defect. It does not weaken
 * authentication, but it does remove the tenant check that every other handler
 * relies on having already run.
 */
export const WithoutOrganizationContext = () =>
  SetMetadata(WITHOUT_ORGANIZATION, true);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How each resolution failure is reported.
 *
 * Everything that concerns *which* Organization the caller may act in is a
 * `404`, so a caller cannot probe for Organizations they do not belong to.
 * Only "we do not know this subject at all" is a `401`.
 */
const failureResponse = (reason: ResolutionFailure): Error => {
  switch (reason) {
    case "unknown_subject":
      return new UnauthorizedException("Not authenticated.");
    case "identity_disabled":
      return new ForbiddenException("This identity is disabled.");
    case "no_membership":
    case "membership_inactive":
    case "organization_unavailable":
      return new NotFoundException("Organization not found.");
  }
};

/** The reason code recorded for each resolution failure. */
const REASON_CODES: Readonly<Record<ResolutionFailure, string>> = {
  unknown_subject: "UNKNOWN_SUBJECT",
  identity_disabled: "IDENTITY_DISABLED",
  no_membership: "NO_MEMBERSHIP",
  membership_inactive: "MEMBERSHIP_INACTIVE",
  organization_unavailable: "ORGANIZATION_UNAVAILABLE",
};

@Injectable()
export class RequestContextGuard implements CanActivate {
  private readonly reflector = new Reflector();

  constructor(
    private readonly auth: AuthAdapter,
    private readonly resolver: PrincipalResolver,
    /**
     * Optional so a test can build a guard without a store. In the composition
     * root it is always supplied.
     */
    private readonly audit?: AuditRepository,
  ) {}

  /**
   * Record a refusal the interceptor will never see.
   *
   * NestJS runs guards *before* interceptors, so everything this guard refuses
   * bypasses `AuditInterceptor` entirely. Those refusals are steps 2 to 4 of the
   * Policy Evaluation Algorithm — disabled Identity, absent or inactive
   * Membership, unavailable Organization — and they are authorization decisions
   * in exactly the sense `authorization.md` means: "Records why the actor was
   * permitted or denied."
   *
   * They are also the refusals that leave no other trace. A suspended Member
   * retrying a command all afternoon touches no business table and emits no
   * event; without this row, nothing in the system knows it happened.
   *
   * Unlike the interceptor, this does not skip `GET`. An allowed read is noise,
   * but a *refused* one is a caller reaching for something they cannot have, and
   * that is worth the row whatever the method.
   */
  private deny(
    request: Request,
    subject: AuthenticatedSubject,
    organizationId: OrganizationId | null,
    reasonCode: string,
  ): void {
    if (this.audit === undefined) return;
    const path = request.route?.path ?? request.path;
    void this.audit
      .record({
        authorizationAuditId: randomUUID(),
        requestId: randomUUID(),
        correlationId: randomUUID(),
        commandId: null,
        principalId: `${subject.provider}:${subject.subject}`,
        // No Membership was resolved, so there is no principal to type. The
        // subject is what the request actually presented.
        principalType: "AuthenticatedSubject",
        identityId: null,
        membershipId: null,
        organizationId,
        commandType: `${request.method} ${path}`,
        permission: permissionFor(request.method, path),
        resourceType: null,
        resourceId: null,
        outcome: AUDIT_OUTCOMES[1],
        reasonCode,
        previousState: null,
        nextState: null,
        evaluatedAt: new Date(),
        resultingEventId: null,
      })
      .catch((error: unknown) => {
        console.error("Audit write failed in the request guard", { error });
      });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const subject = await this.auth.authenticate(request);
    if (subject === null) {
      // Not audited, and deliberately. The audit records authorization
      // decisions — "Every authoritative command must produce an auditable
      // authorization record" — and a request that fails authentication never
      // becomes a command. There is no principal, no Organization, and nothing
      // to attribute; the access log is where a failed credential belongs.
      throw new UnauthorizedException("Not authenticated.");
    }

    if (
      this.reflector.getAllAndOverride<boolean>(WITHOUT_ORGANIZATION, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    ) {
      // Authenticated, but deliberately without a principal: `contextOf` throws
      // for these requests, so a handler cannot accidentally read one.
      request.aiosSubject = subject;
      return true;
    }

    const header = request.header("x-organization-id");
    if (header === undefined || !UUID.test(header)) {
      throw new BadRequestException("A valid X-Organization-Id header is required.");
    }

    const organizationId = OrganizationId(header);
    const resolution = await this.resolver.resolve(subject, organizationId);
    if (!resolution.ok) {
      // The Organization the caller *claimed*, which is the useful fact: it is
      // what they were reaching for, not what they hold.
      this.deny(request, subject, organizationId, REASON_CODES[resolution.reason]);
      throw failureResponse(resolution.reason);
    }

    const ifMatch = request.header("if-match");
    const parsedVersion =
      ifMatch === undefined ? null : Number.parseInt(ifMatch.replace(/"/g, ""), 10);

    request.aios = {
      principal: resolution.principal,
      organizationId: resolution.principal.organizationId,
      now: new Date(),
      idempotencyKey: request.header("idempotency-key") ?? null,
      expectedVersion:
        parsedVersion !== null && Number.isInteger(parsedVersion)
          ? parsedVersion
          : null,
    };

    return true;
  }
}

export const contextOf = (request: Request): RequestContext => {
  if (request.aios === undefined) {
    throw new UnauthorizedException("Not authenticated.");
  }
  return request.aios;
};

/** The authenticated subject for a route exempt from Organization resolution. */
export const subjectOf = (request: Request): AnonymousOrganizationContext => {
  if (request.aiosSubject === undefined) {
    throw new UnauthorizedException("Not authenticated.");
  }
  return { subject: request.aiosSubject, now: new Date() };
};
