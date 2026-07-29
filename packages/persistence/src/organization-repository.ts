/**
 * PostgreSQL Organization repository (ADR-0015).
 *
 * The one repository whose reads are not Organization-scoped by a separate
 * argument, because the Organization *is* the scope: `organizationId` is both
 * the tenant key and the aggregate id. Every other repository takes it in
 * addition to the row's own identifier.
 *
 * `bootstrap` is the exceptional coordinated creation the identity document
 * permits. It writes the Organization, the creator's Owner Membership, and the
 * role assignment in the caller's transaction, so the state "Organization =
 * Active, Active Owner Membership = Missing" is never externally visible.
 */

import type { PoolClient } from "pg";

import type { IdentityId, OrganizationId, OrganizationStatus } from "@aios/types";
import {
  VersionConflictError,
  type MembershipState,
  type OrganizationState,
} from "@aios/domain";
import type { OrganizationRepository } from "@aios/application";

interface OrganizationRow {
  organization_id: string;
  name: string;
  status: string;
  created_by_identity_id: string;
  suspended_at: Date | null;
  archived_at: Date | null;
  version: string | number;
}

const hydrate = (row: OrganizationRow): OrganizationState => ({
  organizationId: row.organization_id as OrganizationId,
  name: row.name,
  status: row.status as OrganizationStatus,
  createdByIdentityId: row.created_by_identity_id as IdentityId,
  suspendedAt: row.suspended_at,
  archivedAt: row.archived_at,
  // bigint, which the driver returns as a string.
  version: Number(row.version) as OrganizationState["version"],
});

export class PostgresOrganizationRepository implements OrganizationRepository {
  constructor(private readonly client: PoolClient) {}

  async findById(organizationId: OrganizationId): Promise<OrganizationState | null> {
    const result = await this.client.query<OrganizationRow>(
      `SELECT organization_id, name, status, created_by_identity_id,
              suspended_at, archived_at, version
         FROM organizations
        WHERE organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : hydrate(row);
  }

  async bootstrap(input: {
    organization: OrganizationState;
    ownerMembership: MembershipState;
    roleAssignmentId: string;
  }): Promise<void> {
    const { organization, ownerMembership } = input;
    const now = new Date();

    await this.client.query(
      `INSERT INTO organizations (
         organization_id, name, status, created_by_identity_id,
         version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [
        organization.organizationId,
        organization.name,
        organization.status,
        organization.createdByIdentityId,
        organization.version,
        now,
      ],
    );

    await this.client.query(
      `INSERT INTO memberships (
         membership_id, organization_id, identity_id,
         status, invited_at, activated_at,
         version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        ownerMembership.membershipId,
        ownerMembership.organizationId,
        ownerMembership.identityId,
        ownerMembership.status,
        ownerMembership.invitedAt,
        ownerMembership.activatedAt,
        ownerMembership.version,
        now,
      ],
    );

    // The creator is recorded as their own assigner. There is no earlier actor
    // to attribute the first Owner role to, and leaving it null would break the
    // composite foreign key that keeps assignment attribution in-Organization.
    for (const role of ownerMembership.roles) {
      await this.client.query(
        `INSERT INTO membership_role_assignments (
           role_assignment_id, organization_id, membership_id, role,
           assigned_by_identity_id, assigned_by_membership_id, assigned_at
         ) VALUES ($1, $2, $3, $4, $5, $3, $6)`,
        [
          input.roleAssignmentId,
          organization.organizationId,
          ownerMembership.membershipId,
          role,
          ownerMembership.identityId,
          now,
        ],
      );
    }
  }

  async update(
    organization: OrganizationState,
    expectedVersion: number,
  ): Promise<void> {
    const result = await this.client.query(
      `UPDATE organizations
          SET name = $1,
              status = $2,
              suspended_at = $3,
              archived_at = $4,
              version = $5,
              updated_at = $6
        WHERE organization_id = $7
          AND version = $8`,
      [
        organization.name,
        organization.status,
        organization.suspendedAt,
        organization.archivedAt,
        organization.version,
        new Date(),
        organization.organizationId,
        expectedVersion,
      ],
    );

    if (result.rowCount === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }
  }
}
