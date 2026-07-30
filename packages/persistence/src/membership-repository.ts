/**
 * PostgreSQL Membership and Identity repositories (ADR-0015).
 *
 * A Membership spans three tables: `memberships`, its active role assignments in
 * `membership_role_assignments`, and the invitations issued for it in
 * `organization_invitations`. All three are part of the Aggregate, so all three
 * are written inside the one transaction.
 *
 * Two schema facts shape almost everything here:
 *
 * - `ck_memberships_identity_presence` makes `identity_id` null exactly while
 *   the status is `Invited`. Activation is what binds an Identity, and the
 *   database refuses any other combination.
 * - Only `token_hash` is stored. Nothing in this file can reconstruct a token.
 */

import type { PoolClient } from "pg";

import {
  IdentityId,
  InvitationId,
  MembershipId,
  OrganizationId,
  type IdentityStatus,
  type InvitationStatus,
  type MembershipStatus,
  type Role,
} from "@aios/types";
import {
  VersionConflictError,
  type InvitationState,
  type MembershipState,
} from "@aios/domain";
import type {
  IdentityRecord,
  IdentityRepository,
  MembershipRepository,
  OrganizationMemberSummary,
} from "@aios/application";

interface MembershipRow {
  membership_id: string;
  organization_id: string;
  identity_id: string | null;
  pending_invitee_email: string | null;
  status: string;
  invited_by_identity_id: string | null;
  invited_by_membership_id: string | null;
  invited_at: Date | null;
  activated_at: Date | null;
  revoked_by_identity_id: string | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
  version: string | number;
}

interface InvitationRow {
  invitation_id: string;
  invitation_version: number;
  token_hash: string;
  status: string;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const MEMBERSHIP_COLUMNS = `
  membership_id, organization_id, identity_id,
  pending_invitee_email, status,
  invited_by_identity_id, invited_by_membership_id, invited_at, activated_at,
  revoked_by_identity_id, revoked_at, revocation_reason,
  version
`;

const INVITATION_COLUMNS = `
  invitation_id, invitation_version, token_hash, status,
  expires_at, consumed_at, revoked_at, created_at
`;

const hydrate = (
  row: MembershipRow,
  roles: readonly string[],
  invitations: readonly InvitationRow[],
): MembershipState => ({
  membershipId: MembershipId(row.membership_id),
  organizationId: OrganizationId(row.organization_id),
  identityId: row.identity_id === null ? null : IdentityId(row.identity_id),
  pendingInviteeEmail: row.pending_invitee_email,
  status: row.status as MembershipStatus,
  roles: roles as readonly Role[],
  invitedByIdentityId:
    row.invited_by_identity_id === null ? null : IdentityId(row.invited_by_identity_id),
  invitedByMembershipId:
    row.invited_by_membership_id === null
      ? null
      : MembershipId(row.invited_by_membership_id),
  invitedAt: row.invited_at,
  activatedAt: row.activated_at,
  revokedByIdentityId:
    row.revoked_by_identity_id === null ? null : IdentityId(row.revoked_by_identity_id),
  revokedAt: row.revoked_at,
  revocationReason: row.revocation_reason,
  invitations: invitations.map(
    (invitation): InvitationState => ({
      invitationId: InvitationId(invitation.invitation_id),
      invitationVersion: invitation.invitation_version,
      tokenHash: invitation.token_hash,
      status: invitation.status as InvitationStatus,
      expiresAt: invitation.expires_at,
      consumedAt: invitation.consumed_at,
      revokedAt: invitation.revoked_at,
      createdAt: invitation.created_at,
    }),
  ),
  // `version` is `bigint`, which the driver returns as a string.
  version: Number(row.version) as MembershipState["version"],
});

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly client: PoolClient) {}

  async findById(
    organizationId: OrganizationId,
    membershipId: MembershipId,
  ): Promise<MembershipState | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM memberships
        WHERE organization_id = $1 AND membership_id = $2`,
      [organizationId, membershipId],
    );
    return this.complete(result.rows[0]);
  }

  /**
   * Find a Membership by an invitation token hash.
   *
   * The one lookup with no Organization argument, because the caller has no
   * Organization yet — see the port. The `uq_organization_invitations_token_hash`
   * constraint is what makes "the token names one Organization" true rather than
   * hopeful.
   */
  async findByInvitationTokenHash(
    tokenHash: string,
  ): Promise<MembershipState | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS.split(",")
        .map((c) => `m.${c.trim()}`)
        .join(", ")}
         FROM memberships m
         JOIN organization_invitations i
           ON i.organization_id = m.organization_id
          AND i.membership_id = m.membership_id
        WHERE i.token_hash = $1`,
      [tokenHash],
    );
    return this.complete(result.rows[0]);
  }

  /**
   * Any Membership already addressed to this person.
   *
   * Two ways to be addressed: a pending invitation carries the address, and an
   * activated Membership carries an Identity that has it. Checking only the
   * first would let an existing Member be invited again.
   */
  async findByEmail(
    organizationId: OrganizationId,
    normalizedEmail: string,
  ): Promise<MembershipState | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS.split(",")
        .map((c) => `m.${c.trim()}`)
        .join(", ")}
         FROM memberships m
         LEFT JOIN human_identities h ON h.identity_id = m.identity_id
        WHERE m.organization_id = $1
          AND (m.pending_invitee_email_normalized = $2
               OR h.primary_email_normalized = $2)
        ORDER BY m.created_at DESC
        LIMIT 1`,
      [organizationId, normalizedEmail],
    );
    return this.complete(result.rows[0]);
  }

  async findByIdentity(
    organizationId: OrganizationId,
    identityId: IdentityId,
  ): Promise<MembershipState | null> {
    const result = await this.client.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM memberships
        WHERE organization_id = $1 AND identity_id = $2`,
      [organizationId, identityId],
    );
    return this.complete(result.rows[0]);
  }

  private async complete(
    row: MembershipRow | undefined,
  ): Promise<MembershipState | null> {
    if (row === undefined) return null;

    const roles = await this.client.query<{ role: string }>(
      `SELECT role FROM membership_role_assignments
        WHERE organization_id = $1 AND membership_id = $2 AND revoked_at IS NULL
        ORDER BY assigned_at ASC`,
      [row.organization_id, row.membership_id],
    );

    const invitations = await this.client.query<InvitationRow>(
      `SELECT ${INVITATION_COLUMNS} FROM organization_invitations
        WHERE organization_id = $1 AND membership_id = $2
        ORDER BY invitation_version ASC`,
      [row.organization_id, row.membership_id],
    );

    return hydrate(
      row,
      roles.rows.map((r) => r.role),
      invitations.rows,
    );
  }

  async insert(membership: MembershipState): Promise<void> {
    const now = new Date();

    await this.client.query(
      `INSERT INTO memberships (
         membership_id, organization_id, identity_id,
         pending_invitee_email, pending_invitee_email_normalized,
         status,
         invited_by_identity_id, invited_by_membership_id, invited_at,
         activated_at, version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,lower($4),$5,$6,$7,$8,$9,$10,$11,$11)`,
      [
        membership.membershipId,
        membership.organizationId,
        membership.identityId,
        membership.pendingInviteeEmail,
        membership.status,
        membership.invitedByIdentityId,
        membership.invitedByMembershipId,
        membership.invitedAt,
        membership.activatedAt,
        membership.version,
        now,
      ],
    );

    // The inviter is recorded as the assigner. An invitation names the roles,
    // so there is no separate assignment action to attribute them to.
    for (const role of membership.roles) {
      await this.client.query(
        `INSERT INTO membership_role_assignments (
           role_assignment_id, organization_id, membership_id, role,
           assigned_by_identity_id, assigned_by_membership_id, assigned_at
         ) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6)`,
        [
          membership.organizationId,
          membership.membershipId,
          role,
          membership.invitedByIdentityId,
          membership.invitedByMembershipId,
          membership.invitedAt ?? now,
        ],
      );
    }

    for (const invitation of membership.invitations) {
      await this.insertInvitation(membership, invitation);
    }
  }

  private async insertInvitation(
    membership: MembershipState,
    invitation: InvitationState,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO organization_invitations (
         invitation_id, organization_id, membership_id, invitation_version,
         token_hash, status, expires_at, consumed_at, revoked_at,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        invitation.invitationId,
        membership.organizationId,
        membership.membershipId,
        invitation.invitationVersion,
        invitation.tokenHash,
        invitation.status,
        invitation.expiresAt,
        invitation.consumedAt,
        invitation.revokedAt,
        invitation.createdAt,
      ],
    );
  }

  async update(membership: MembershipState, expectedVersion: number): Promise<void> {
    const result = await this.client.query(
      `UPDATE memberships
          SET identity_id = $1,
              pending_invitee_email = $2,
              pending_invitee_email_normalized = lower($2),
              status = $3,
              activated_at = $4,
              revoked_by_identity_id = $5,
              revoked_at = $6,
              revocation_reason = $7,
              version = $8,
              updated_at = $9
        WHERE organization_id = $10 AND membership_id = $11 AND version = $12`,
      [
        membership.identityId,
        membership.pendingInviteeEmail,
        membership.status,
        membership.activatedAt,
        membership.revokedByIdentityId,
        membership.revokedAt,
        membership.revocationReason,
        membership.version,
        new Date(),
        membership.organizationId,
        membership.membershipId,
        expectedVersion,
      ],
    );

    if (result.rowCount === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }

    const existing = await this.client.query<{ invitation_id: string }>(
      `SELECT invitation_id FROM organization_invitations
        WHERE organization_id = $1 AND membership_id = $2`,
      [membership.organizationId, membership.membershipId],
    );
    const known = new Set(existing.rows.map((r) => r.invitation_id));

    for (const invitation of membership.invitations) {
      if (known.has(invitation.invitationId)) {
        // Only lifecycle columns move. `token_hash` is never rewritten: a
        // reissue is a new row with a higher `invitation_version`.
        await this.client.query(
          `UPDATE organization_invitations
              SET status = $1, consumed_at = $2, revoked_at = $3, updated_at = $4
            WHERE organization_id = $5 AND invitation_id = $6`,
          [
            invitation.status,
            invitation.consumedAt,
            invitation.revokedAt,
            new Date(),
            membership.organizationId,
            invitation.invitationId,
          ],
        );
      } else {
        await this.insertInvitation(membership, invitation);
      }
    }
  }

  async listActiveByRole(
    organizationId: OrganizationId,
    role: Role,
  ): Promise<readonly MembershipId[]> {
    const result = await this.client.query<{ membership_id: string }>(
      `SELECT DISTINCT m.membership_id
         FROM memberships m
         JOIN membership_role_assignments r
           ON r.organization_id = m.organization_id
          AND r.membership_id = m.membership_id
        WHERE m.organization_id = $1
          AND m.status = 'Active'
          AND r.role = $2
          AND r.revoked_at IS NULL`,
      [organizationId, role],
    );
    return result.rows.map((row) => row.membership_id as MembershipId);
  }

  async listMembers(
    organizationId: OrganizationId,
  ): Promise<readonly OrganizationMemberSummary[]> {
    const result = await this.client.query<{
      membership_id: string;
      status: string;
      identity_id: string | null;
      display_name: string | null;
      email: string | null;
      invited_at: Date | null;
      activated_at: Date | null;
      invitation_expires_at: Date | null;
      roles: string[] | null;
    }>(
      `SELECT m.membership_id,
              m.status,
              m.identity_id,
              h.display_name,
              COALESCE(h.primary_email, m.pending_invitee_email) AS email,
              m.invited_at,
              m.activated_at,
              (SELECT i.expires_at
                 FROM organization_invitations i
                WHERE i.organization_id = m.organization_id
                  AND i.membership_id = m.membership_id
                ORDER BY i.invitation_version DESC
                LIMIT 1) AS invitation_expires_at,
              (SELECT array_agg(r.role ORDER BY r.assigned_at)
                 FROM membership_role_assignments r
                WHERE r.organization_id = m.organization_id
                  AND r.membership_id = m.membership_id
                  AND r.revoked_at IS NULL) AS roles
         FROM memberships m
         LEFT JOIN human_identities h ON h.identity_id = m.identity_id
        WHERE m.organization_id = $1
        ORDER BY m.created_at ASC`,
      [organizationId],
    );

    return result.rows.map((row) => ({
      membershipId: MembershipId(row.membership_id),
      status: row.status as MembershipStatus,
      roles: (row.roles ?? []) as readonly Role[],
      identityId: row.identity_id === null ? null : IdentityId(row.identity_id),
      displayName: row.display_name,
      email: row.email,
      invitedAt: row.invited_at,
      activatedAt: row.activated_at,
      invitationExpiresAt: row.invitation_expires_at,
    }));
  }
}

interface IdentityRow {
  identity_id: string;
  status: string;
  display_name: string;
  primary_email_normalized: string | null;
}

const toIdentity = (row: IdentityRow): IdentityRecord => ({
  identityId: IdentityId(row.identity_id),
  status: row.status as IdentityStatus,
  displayName: row.display_name,
  primaryEmailNormalized: row.primary_email_normalized,
});

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly client: PoolClient) {}

  async findBySubject(subject: {
    provider: string;
    issuer: string;
    subject: string;
  }): Promise<IdentityRecord | null> {
    const result = await this.client.query<IdentityRow>(
      `SELECT h.identity_id, h.status, h.display_name, h.primary_email_normalized
         FROM authentication_subjects a
         JOIN human_identities h ON h.identity_id = a.identity_id
        WHERE a.provider = $1 AND a.issuer = $2 AND a.subject = $3
          AND a.unlinked_at IS NULL`,
      [subject.provider, subject.issuer, subject.subject],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIdentity(row);
  }

  async createWithSubject(input: {
    identityId: IdentityId;
    displayName: string;
    primaryEmail: string;
    provider: string;
    issuer: string;
    subject: string;
  }): Promise<IdentityRecord> {
    const now = new Date();

    const created = await this.client.query<IdentityRow>(
      `INSERT INTO human_identities (
         identity_id, status, display_name,
         primary_email, primary_email_normalized,
         version, created_at, updated_at
       ) VALUES ($1,'Active',$2,$3,lower($3),1,$4,$4)
       RETURNING identity_id, status, display_name, primary_email_normalized`,
      [input.identityId, input.displayName, input.primaryEmail, now],
    );

    await this.client.query(
      `INSERT INTO authentication_subjects (
         authentication_subject_id, identity_id, provider, issuer, subject,
         linked_at, created_at
       ) VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$5)`,
      [input.identityId, input.provider, input.issuer, input.subject, now],
    );

    return toIdentity(created.rows[0]!);
  }
}
