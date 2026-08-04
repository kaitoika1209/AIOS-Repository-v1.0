/**
 * The Organization resource: finding one, creating one, and running one.
 *
 * Three authorization shapes, in one controller because they are the same
 * resource:
 *
 * - `GET /organizations` has no permission and no Organization context. It
 *   answers "which Organizations may I act in", so requiring the header that
 *   names one would be circular (ADR-0014).
 * - `POST /organizations` likewise. The caller is bringing the Organization into
 *   existence, so there is no Membership for a permission to attach to and
 *   nothing for `X-Organization-Id` to select among.
 * - Everything else is ordinary. By then the caller is a Member, and the
 *   permission applies.
 *
 * The first two are the reason the other routes can be strict: a client that can
 * enumerate and create Organizations never needs one configured for it.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import { OrganizationId, type OrganizationStatus } from "@aios/types";
import {
  listCallerOrganizationsUseCase,
  ASSISTANCE_OPERATIONS,
  archiveOrganizationUseCase,
  createOrganizationUseCase,
  grantAssistanceUseCase,
  revokeAssistanceUseCase,
  getOrganizationUseCase,
  reactivateOrganizationUseCase,
  renameOrganizationUseCase,
  suspendOrganizationUseCase,
  type UseCaseDependencies,
} from "@aios/application";

import {
  contextOf,
  RecoversSuspendedOrganization,
  subjectOf,
  WithoutOrganizationContext,
} from "./request-context.js";
import { DECISION_ASSISTANCE, USE_CASE_DEPENDENCIES } from "./tokens.js";
import type { DecisionAssistanceProvider } from "@aios/application";

interface OrganizationResponse {
  organizationId: string;
  name: string;
  status: OrganizationStatus;
  version: number;
}

const requireName = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException("name is required.");
  }
  return value;
};

/**
 * Every lifecycle command requires one.
 *
 * Rejected at the edge as a `400` when it is missing or the wrong type, and by
 * the Aggregate as a `422` when it is present but blank — the same split every
 * other command uses. An Organization that went dark without a recorded reason
 * leaves nobody able to say why afterwards.
 */
const requireReason = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new BadRequestException("reason is required.");
  }
  return value;
};

const respond = (organization: {
  organizationId: string;
  name: string;
  status: OrganizationStatus;
  version: number;
}): OrganizationResponse => ({
  organizationId: organization.organizationId,
  name: organization.name,
  status: organization.status,
  version: organization.version,
});

@Controller("organizations")
export class OrganizationAdminController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
    // The Secretary a grant is issued to. Taken from the provider rather than a
    // constant, so the identifier a grant names is the one the runtime will
    // present at invocation.
    @Inject(DECISION_ASSISTANCE)
    private readonly assistance: DecisionAssistanceProvider,
  ) {}

  /**
   * The Organizations the caller may act in.
   *
   * Exempt from Organization resolution because requiring the header here would
   * be circular — the caller would have to name an Organization in order to ask
   * which ones they may name (ADR-0014).
   *
   * It takes no parameters at all, which is what makes the exemption safe: there
   * is no identifier to supply and therefore nothing to probe with, and the
   * result is derived entirely from the authenticated subject.
   *
   * Suspended Organizations are included. An Owner who cannot find a suspended
   * Organization cannot reach `organization.reactivate`, and the whole point of
   * that route's own exemption is that the recovery path stays reachable.
   */
  @Get()
  @WithoutOrganizationContext()
  async list(@Req() request: Request): Promise<{
    organizations: readonly {
      organizationId: string;
      name: string;
      status: OrganizationStatus;
      membershipId: string;
      roles: readonly string[];
    }[];
  }> {
    const context = subjectOf(request);
    const organizations = await listCallerOrganizationsUseCase(this.deps, {
      provider: context.subject.provider,
      issuer: context.subject.issuer,
      subject: context.subject.subject,
    });

    // Wrapped in an object rather than returned as a bare array: a top-level
    // array has nowhere to grow, and this list will want pagination before it
    // wants anything else.
    return { organizations };
  }

  /**
   * Create an Organization with its first Owner.
   *
   * The body carries a name and nothing else. There is no `organizationId`
   * parameter of any kind: the identifier is server-generated, so a caller
   * cannot choose it or collide with an existing tenant.
   */
  @Post()
  @WithoutOrganizationContext()
  async create(
    @Req() request: Request,
    @Body() body: { name?: unknown },
  ): Promise<OrganizationResponse & { membershipId: string }> {
    const context = subjectOf(request);
    const { organization, membership } = await createOrganizationUseCase(
      this.deps,
      {
        subject: {
          provider: context.subject.provider,
          issuer: context.subject.issuer,
          subject: context.subject.subject,
        },
        displayName: context.subject.displayName ?? context.subject.subject,
        // Derived from the verified subject, never from the body: a
        // caller-supplied address would look verified without being so. Null
        // when the provider supplies none.
        email: context.subject.email ?? null,
        now: context.now,
      },
      {
        name: requireName(body.name),
        secretaryPrincipalId: this.assistance.secretaryPrincipalId,
      },
    );

    return {
      organizationId: organization.organizationId,
      name: organization.name,
      status: organization.status,
      version: organization.version,
      membershipId: membership.membershipId,
    };
  }

  @Get(":organizationId")
  async get(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
  ): Promise<OrganizationResponse> {
    const context = contextOf(request);
    // A path Organization that is not the acting one is reported absent, never
    // forbidden: a 403 would confirm it exists.
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }

    const organization = await getOrganizationUseCase(
      this.deps,
      OrganizationId(organizationId),
    );
    return {
      organizationId: organization.organizationId,
      name: organization.name,
      status: organization.status,
      version: organization.version,
    };
  }

  @Patch(":organizationId")
  async rename(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Body() body: { name?: unknown },
  ): Promise<OrganizationResponse> {
    const context = contextOf(request);
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }

    const organization = await renameOrganizationUseCase(
      this.deps,
      context,
      requireName(body.name),
    );
    return respond(organization);
  }

  /**
   * Pause the Organization.
   *
   * The caller's *next* request will be answered `404`: once this commits, the
   * resolver refuses every route in the Organization except reactivation. That
   * is the command working, not failing.
   */
  @Post(":organizationId/suspend")
  async suspend(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Body() body: { reason?: unknown },
  ): Promise<OrganizationResponse> {
    const context = contextOf(request);
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }

    return respond(
      await suspendOrganizationUseCase(this.deps, context, requireReason(body.reason)),
    );
  }

  /**
   * Return a suspended Organization to service.
   *
   * The only route that reaches a non-Active Organization, and the reason the
   * exemption exists at all — without it, suspension would be a one-way door.
   * Everything else about the request is ordinary: an Active Membership and
   * `organization.reactivate`, which only an Owner holds.
   */
  @Post(":organizationId/reactivate")
  @RecoversSuspendedOrganization()
  async reactivate(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Body() body: { reason?: unknown },
  ): Promise<OrganizationResponse> {
    const context = contextOf(request);
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }

    return respond(
      await reactivateOrganizationUseCase(this.deps, context, requireReason(body.reason)),
    );
  }

  /**
   * Archive the Organization, permanently.
   *
   * The last command it will accept. Refused while any Work remains
   * `InProgress` or `WaitingForDecision`, because a read-only Organization has
   * no command left that could finish one.
   */
  @Post(":organizationId/archive")
  async archive(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Body() body: { reason?: unknown },
  ): Promise<OrganizationResponse> {
    const context = contextOf(request);
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }

    return respond(
      await archiveOrganizationUseCase(this.deps, context, requireReason(body.reason)),
    );
  }

  /**
   * Enable one of the Secretary's advisory operations (ADR-0019).
   *
   * The body names an operation and nothing else. Its context and port contract
   * version come from the declared registry, so a caller cannot widen a grant to
   * a context the ports do not own.
   */
  @Post(":organizationId/assistance-grants")
  async grantAssistance(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Body() body: { operation?: unknown; reason?: unknown },
  ): Promise<{ operation: string; contextKey: string; portContractVersion: number }> {
    const context = contextOf(request);
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }

    const spec = await grantAssistanceUseCase(this.deps, context, {
      secretaryPrincipalId: this.assistance.secretaryPrincipalId,
      operation: requireOperation(body.operation),
      reason: requireReason(body.reason),
    });
    return {
      operation: spec.assistanceOperation,
      contextKey: spec.contextKey,
      portContractVersion: spec.portContractVersion,
    };
  }

  /** Withdraw an advisory operation. The grant row is stamped, never deleted. */
  @Post(":organizationId/assistance-grants/revoke")
  async revokeAssistance(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Body() body: { operation?: unknown },
  ): Promise<{ operation: string; contextKey: string; portContractVersion: number }> {
    const context = contextOf(request);
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }

    const spec = await revokeAssistanceUseCase(this.deps, context, {
      secretaryPrincipalId: this.assistance.secretaryPrincipalId,
      operation: requireOperation(body.operation),
    });
    return {
      operation: spec.assistanceOperation,
      contextKey: spec.contextKey,
      portContractVersion: spec.portContractVersion,
    };
  }
}

/**
 * An operation name from the declared registry.
 *
 * Shape is checked here; whether the build declares it is checked by the use
 * case, which owns the registry. A non-string is a `400`; an unknown name is a
 * `422`, because it is well formed and refused by a domain rule.
 */
const requireOperation = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestException(
      `operation is required, and must be one of: ${ASSISTANCE_OPERATIONS.join(", ")}.`,
    );
  }
  return value;
};
