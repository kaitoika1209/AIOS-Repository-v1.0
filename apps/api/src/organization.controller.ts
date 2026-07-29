/**
 * Organization membership routes.
 *
 * The one place ADR-0014 puts the Organization in the path, because there the
 * Organization *is* the resource. The path identifier is still not authority:
 * the guard has already resolved the acting Organization from the header, and
 * this controller refuses any request whose path names a different one.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import { MembershipId, ROLES, type MembershipStatus, type Role } from "@aios/types";
import {
  inviteMemberUseCase,
  listMembersUseCase,
  resendInvitationUseCase,
  revokeInvitationUseCase,
  type UseCaseDependencies,
} from "@aios/application";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

interface MemberResponse {
  membershipId: string;
  status: MembershipStatus;
  roles: string[];
  displayName: string | null;
  email: string | null;
  invitedAt: string | null;
  activatedAt: string | null;
  invitationExpiresAt: string | null;
}

/**
 * An issued invitation.
 *
 * The token is in the response body because there is no mail delivery yet: the
 * `MembershipInvited` consumer that would send it is not in this release. It is
 * returned to the caller who created it and to nobody else, and it is never
 * stored — see `docs/architecture/identity-and-organization.md`.
 */
interface InvitationResponse {
  membershipId: string;
  status: MembershipStatus;
  email: string | null;
  expiresAt: string | null;
  token: string;
}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required.`);
  }
  return value;
};

const parseRoles = (value: unknown): Role[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException("roles must be an array.");
  }
  return value.map((role) => {
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
      throw new BadRequestException(`Unknown role ${String(role)}.`);
    }
    return role as Role;
  });
};

@Controller("organizations/:organizationId/members")
export class OrganizationMemberController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  /**
   * Reject a path Organization that is not the acting one.
   *
   * A `404`, not a `403`: confirming that some other Organization exists is
   * exactly what the tenancy rules forbid.
   */
  private scoped(request: Request, organizationId: string) {
    const context = contextOf(request);
    if (context.organizationId !== organizationId) {
      throw new NotFoundException("Organization not found.");
    }
    return context;
  }

  @Get()
  async list(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
  ): Promise<{ items: MemberResponse[] }> {
    const members = await listMembersUseCase(
      this.deps,
      this.scoped(request, organizationId),
    );
    return {
      items: members.map((member) => ({
        membershipId: member.membershipId,
        status: member.status,
        roles: [...member.roles],
        displayName: member.displayName,
        email: member.email,
        invitedAt: member.invitedAt?.toISOString() ?? null,
        activatedAt: member.activatedAt?.toISOString() ?? null,
        invitationExpiresAt: member.invitationExpiresAt?.toISOString() ?? null,
      })),
    };
  }

  @Post()
  async invite(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Body() body: { email?: unknown; roles?: unknown },
  ): Promise<InvitationResponse> {
    const { membership, token } = await inviteMemberUseCase(
      this.deps,
      this.scoped(request, organizationId),
      {
        email: requireString(body.email, "email"),
        roles: parseRoles(body.roles),
      },
    );
    return present(membership, token);
  }

  @Post(":membershipId/resend-invitation")
  async resend(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Param("membershipId") membershipId: string,
  ): Promise<InvitationResponse> {
    const { membership, token } = await resendInvitationUseCase(
      this.deps,
      this.scoped(request, organizationId),
      MembershipId(membershipId),
    );
    return present(membership, token);
  }

  @Post(":membershipId/revoke-invitation")
  async revoke(
    @Req() request: Request,
    @Param("organizationId") organizationId: string,
    @Param("membershipId") membershipId: string,
    @Body() body: { reason?: unknown },
  ): Promise<{ membershipId: string; status: MembershipStatus }> {
    const membership = await revokeInvitationUseCase(
      this.deps,
      this.scoped(request, organizationId),
      MembershipId(membershipId),
      requireString(body.reason, "reason"),
    );
    return { membershipId: membership.membershipId, status: membership.status };
  }
}

const present = (
  membership: {
    membershipId: string;
    status: MembershipStatus;
    pendingInviteeEmail: string | null;
    invitations: readonly { invitationVersion: number; expiresAt: Date }[];
  },
  token: string,
): InvitationResponse => {
  const current = membership.invitations.reduce<
    { invitationVersion: number; expiresAt: Date } | null
  >(
    (latest, invitation) =>
      latest === null || invitation.invitationVersion > latest.invitationVersion
        ? invitation
        : latest,
    null,
  );

  return {
    membershipId: membership.membershipId,
    status: membership.status,
    email: membership.pendingInviteeEmail,
    expiresAt: current?.expiresAt.toISOString() ?? null,
    token,
  };
};
