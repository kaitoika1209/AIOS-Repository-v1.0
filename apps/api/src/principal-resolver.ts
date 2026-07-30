/**
 * Request principal resolution (ADR-0013).
 *
 * Turns an authenticated external subject plus a requested Organization into a
 * `HumanMemberPrincipal`, by walking the chain the ADR defines:
 *
 *     provider/issuer/subject → identityId → membership → roles
 *
 * Every step fails closed. A missing identity, a disabled identity, a missing
 * or non-Active Membership, or a non-Active Organization yields no principal and
 * therefore no authority — never a partially-populated one.
 *
 * Nothing below this file sees a provider token, session, or subject string.
 */

import type { Pool } from "pg";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

/** An authenticated external subject, as the auth adapter reports it. */
export interface AuthenticatedSubject {
  readonly provider: string;
  readonly issuer: string;
  readonly subject: string;
  /**
   * Profile data, not an identity key.
   *
   * Used only to name a Human Identity that invitation acceptance has to
   * create. Nothing matches on it, and the resolution chain below ignores it
   * entirely — the tuple above is what identifies a subject.
   */
  readonly displayName?: string;
  /**
   * Profile data, like `displayName` and with the same standing.
   *
   * ADR-0013: "`human_identities.primary_email` and `display_name` are
   * AIOS-owned profile values, synchronizable from Clerk but never used as a
   * join key." Absent when the provider supplies none, and the column is
   * nullable — an Identity with no recorded address is representable, and
   * inventing one would make an unverified address look verified.
   */
  readonly email?: string;
}

export type ResolutionFailure =
  | "unknown_subject"
  | "identity_disabled"
  | "no_membership"
  | "membership_inactive"
  | "organization_unavailable";

export type Resolution =
  | { readonly ok: true; readonly principal: HumanMemberPrincipal }
  | { readonly ok: false; readonly reason: ResolutionFailure };

export class PrincipalResolver {
  constructor(private readonly pool: Pool) {}

  /**
   * Resolve a principal.
   *
   * `allowSuspended` is set only by the reactivation route (ADR-0014, ADR-0017).
   * It widens the Organization-status check to admit `Suspended` and nothing
   * else — every other step, including the Membership's own Active check, runs
   * unchanged. `Archived` stays refused, because archival is terminal.
   */
  async resolve(
    subject: AuthenticatedSubject,
    organizationId: OrganizationId,
    allowSuspended = false,
  ): Promise<Resolution> {
    const client = await this.pool.connect();
    try {
      // 1. Subject → identity. This is the only lookup that touches provider
      //    values; they never travel further.
      const identity = await client.query<{ identity_id: string; status: string }>(
        `SELECT hi.identity_id, hi.status
           FROM authentication_subjects a
           JOIN human_identities hi ON hi.identity_id = a.identity_id
          WHERE a.provider = $1
            AND a.issuer = $2
            AND a.subject = $3
            AND a.unlinked_at IS NULL`,
        [subject.provider, subject.issuer, subject.subject],
      );

      const identityRow = identity.rows[0];
      if (identityRow === undefined) {
        return { ok: false, reason: "unknown_subject" };
      }
      if (identityRow.status !== "Active") {
        // Disabling in AIOS revokes authority regardless of provider state.
        return { ok: false, reason: "identity_disabled" };
      }

      // 2. Organization must exist and be Active — or Suspended, on the one
      //    route that exists to recover it.
      const organization = await client.query<{ status: string }>(
        `SELECT status FROM organizations WHERE organization_id = $1`,
        [organizationId],
      );
      const status = organization.rows[0]?.status;
      const usable =
        status === "Active" || (allowSuspended && status === "Suspended");
      if (!usable) {
        return { ok: false, reason: "organization_unavailable" };
      }

      // 3. Membership in *that* Organization. The header selects among the
      //    caller's memberships; it grants nothing on its own.
      const membership = await client.query<{
        membership_id: string;
        status: string;
      }>(
        `SELECT membership_id, status
           FROM memberships
          WHERE organization_id = $1
            AND identity_id = $2`,
        [organizationId, identityRow.identity_id],
      );

      const membershipRow = membership.rows[0];
      if (membershipRow === undefined) {
        return { ok: false, reason: "no_membership" };
      }
      if (membershipRow.status !== "Active") {
        return { ok: false, reason: "membership_inactive" };
      }

      // 4. Roles come from active assignments only — never from provider
      //    metadata.
      const roles = await client.query<{ role: string }>(
        `SELECT role
           FROM membership_role_assignments
          WHERE organization_id = $1
            AND membership_id = $2
            AND revoked_at IS NULL`,
        [organizationId, membershipRow.membership_id],
      );

      return {
        ok: true,
        principal: {
          type: "HumanMember",
          identityId: IdentityId(identityRow.identity_id),
          membershipId: MembershipId(membershipRow.membership_id),
          organizationId,
          roles: roles.rows.map((row: { role: string }) => row.role as Role),
        },
      };
    } finally {
      client.release();
    }
  }
}
