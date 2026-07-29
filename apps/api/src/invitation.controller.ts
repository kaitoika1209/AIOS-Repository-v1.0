/**
 * Invitation acceptance.
 *
 * The one route ADR-0014 exempts from Organization resolution. The caller is
 * authenticated but holds no Membership in the target Organization, so no
 * principal exists and `X-Organization-Id` would have nothing to select among.
 *
 * The route takes no Organization parameter in any form. The token names the
 * Organization; a caller cannot choose which one to join.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import {
  acceptInvitationUseCase,
  type UseCaseDependencies,
} from "@aios/application";

import { subjectOf, WithoutOrganizationContext } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

@Controller("invitations")
export class InvitationController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Post("accept")
  @WithoutOrganizationContext()
  async accept(
    @Req() request: Request,
    @Body() body: { token?: unknown },
  ): Promise<{ organizationId: string; membershipId: string; roles: string[] }> {
    if (typeof body.token !== "string" || body.token.trim().length === 0) {
      throw new BadRequestException("token is required.");
    }

    const context = subjectOf(request);
    const { membership, organizationId } = await acceptInvitationUseCase(
      this.deps,
      {
        subject: context.subject,
        displayName: context.subject.displayName ?? context.subject.subject,
        now: context.now,
      },
      body.token,
    );

    return {
      organizationId,
      membershipId: membership.membershipId,
      roles: [...membership.roles],
    };
  }
}
