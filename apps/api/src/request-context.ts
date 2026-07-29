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

import { OrganizationId, type HumanMemberPrincipal } from "@aios/types";

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

@Injectable()
export class RequestContextGuard implements CanActivate {
  private readonly reflector = new Reflector();

  constructor(
    private readonly auth: AuthAdapter,
    private readonly resolver: PrincipalResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const subject = await this.auth.authenticate(request);
    if (subject === null) {
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

    const resolution = await this.resolver.resolve(
      subject,
      OrganizationId(header),
    );
    if (!resolution.ok) {
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
