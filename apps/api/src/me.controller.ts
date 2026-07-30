/**
 * The caller's own resolved principal.
 *
 * The Personal Workspace is "a personalized view for a human Member", and
 * personalizing it requires knowing which Membership is acting — which the
 * client cannot infer from the member list.
 *
 * No permission, and none is needed: this returns what the guard already
 * resolved for this request and nothing a caller could not learn by acting. It
 * takes no parameter saying whose principal to return, which is what makes it
 * the caller's own.
 */

import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { Request } from "express";

import type { UseCaseDependencies } from "@aios/application";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

interface MeResponse {
  identityId: string;
  membershipId: string;
  organizationId: string;
  roles: string[];
}

@Controller("me")
export class MeController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get()
  async me(@Req() request: Request): Promise<MeResponse> {
    const { principal, organizationId } = contextOf(request);
    void this.deps;
    return {
      identityId: principal.identityId,
      membershipId: principal.membershipId,
      organizationId,
      // The roles authorization actually used, from
      // `membership_role_assignments` — not a claim from the session.
      roles: [...principal.roles],
    };
  }
}
