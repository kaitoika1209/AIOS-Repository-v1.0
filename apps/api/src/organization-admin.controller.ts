/**
 * Organization creation and naming.
 *
 * Two routes with different authorization shapes, in one controller because they
 * are the same resource:
 *
 * - `POST /organizations` has no permission and no Organization context. The
 *   caller is bringing the Organization into existence, so there is no
 *   Membership for a permission to attach to and nothing for
 *   `X-Organization-Id` to select among (ADR-0014).
 * - `PATCH /organizations/{organizationId}` is ordinary. By then the caller is a
 *   Member, and `organization.rename` applies.
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
  createOrganizationUseCase,
  getOrganizationUseCase,
  renameOrganizationUseCase,
  type UseCaseDependencies,
} from "@aios/application";

import {
  contextOf,
  subjectOf,
  WithoutOrganizationContext,
} from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

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

@Controller("organizations")
export class OrganizationAdminController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

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
      { name: requireName(body.name) },
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
    return {
      organizationId: organization.organizationId,
      name: organization.name,
      status: organization.status,
      version: organization.version,
    };
  }
}
