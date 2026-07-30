/**
 * PostgreSQL assistance grant and contribution repositories.
 *
 * The grant check is a single statement over the partial unique index, so
 * "deny by default" is a query that finds nothing rather than a branch someone
 * could forget to write.
 */

import type { PoolClient } from "pg";

import type { DecisionId, IdentityId, MembershipId, OrganizationId } from "@aios/types";
import type {
  AssistanceGrantRepository,
  ContributionType,
  SecretaryContribution,
  SecretaryContributionRepository,
} from "@aios/application";

export class PostgresAssistanceGrantRepository
  implements AssistanceGrantRepository
{
  constructor(private readonly client: PoolClient) {}

  async isGranted(input: {
    organizationId: OrganizationId;
    secretaryPrincipalId: string;
    contextKey: string;
    assistanceOperation: string;
    portContractVersion: number;
  }): Promise<boolean> {
    const result = await this.client.query(
      `SELECT 1
         FROM secretary_assistance_grants
        WHERE organization_id = $1
          AND secretary_principal_id = $2
          AND context_key = $3
          AND assistance_operation = $4
          AND port_contract_version = $5
          AND revoked_at IS NULL`,
      [
        input.organizationId,
        input.secretaryPrincipalId,
        input.contextKey,
        input.assistanceOperation,
        input.portContractVersion,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async grant(input: {
    grantId: string;
    organizationId: OrganizationId;
    secretaryPrincipalId: string;
    contextKey: string;
    assistanceOperation: string;
    portContractVersion: number;
    grantedByMembershipId: MembershipId;
    reason: string;
    now: Date;
  }): Promise<void> {
    // `DO NOTHING` on the active-grant index: granting twice is idempotent, and
    // the second call must not create a duplicate the revocation path would then
    // have to find twice.
    await this.client.query(
      `INSERT INTO secretary_assistance_grants (
         grant_id, organization_id, secretary_principal_id,
         context_key, assistance_operation, port_contract_version,
         granted_at, granted_by_membership_id, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (organization_id, secretary_principal_id, context_key,
                    assistance_operation, port_contract_version)
         WHERE revoked_at IS NULL
         DO NOTHING`,
      [
        input.grantId,
        input.organizationId,
        input.secretaryPrincipalId,
        input.contextKey,
        input.assistanceOperation,
        input.portContractVersion,
        input.now,
        input.grantedByMembershipId,
        input.reason,
      ],
    );
  }
}

interface ContributionRow {
  contribution_id: string;
  decision_id: string;
  decision_revision_id: string;
  secretary_principal_id: string;
  requested_by_membership_id: string;
  contribution_type: string;
  content: string;
  created_at: Date;
  adopted_at: Date | null;
  adopted_by_identity_id: string | null;
}

export class PostgresSecretaryContributionRepository
  implements SecretaryContributionRepository
{
  constructor(private readonly client: PoolClient) {}

  async append(input: {
    contributionId: string;
    organizationId: OrganizationId;
    decisionId: DecisionId;
    decisionRevisionId: string;
    secretaryPrincipalId: string;
    requestedByIdentityId: IdentityId;
    requestedByMembershipId: MembershipId;
    contributionType: ContributionType;
    content: string;
    generationId: string;
    now: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO decision_secretary_contributions (
         contribution_id, organization_id, decision_id, decision_revision_id,
         secretary_principal_id, requested_by_identity_id, requested_by_membership_id,
         contribution_type, content, generation_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.contributionId,
        input.organizationId,
        input.decisionId,
        input.decisionRevisionId,
        input.secretaryPrincipalId,
        input.requestedByIdentityId,
        input.requestedByMembershipId,
        input.contributionType,
        input.content,
        input.generationId,
        input.now,
      ],
    );
  }

  async listForDecision(
    organizationId: OrganizationId,
    decisionId: DecisionId,
  ): Promise<readonly SecretaryContribution[]> {
    const result = await this.client.query<ContributionRow>(
      `SELECT contribution_id, decision_id, decision_revision_id,
              secretary_principal_id, requested_by_membership_id,
              contribution_type, content, created_at,
              adopted_at, adopted_by_identity_id
         FROM decision_secretary_contributions
        WHERE organization_id = $1
          AND decision_id = $2
        ORDER BY created_at`,
      [organizationId, decisionId],
    );

    return result.rows.map((row) => ({
      contributionId: row.contribution_id,
      decisionId: row.decision_id as DecisionId,
      decisionRevisionId: row.decision_revision_id,
      secretaryPrincipalId: row.secretary_principal_id,
      requestedByMembershipId: row.requested_by_membership_id as MembershipId,
      contributionType: row.contribution_type as ContributionType,
      content: row.content,
      createdAt: row.created_at,
      adoptedAt: row.adopted_at,
      adoptedByIdentityId: row.adopted_by_identity_id as IdentityId | null,
    }));
  }

  async markAdopted(input: {
    organizationId: OrganizationId;
    decisionId: DecisionId;
    contributionId: string;
    adoptedByIdentityId: IdentityId;
    now: Date;
  }): Promise<boolean> {
    // Scoped by Decision as well as Organization, so an edit to one Decision
    // cannot mark a contribution belonging to another as adopted. Adoption is
    // recorded once: a second edit does not re-adopt.
    const result = await this.client.query(
      `UPDATE decision_secretary_contributions
          SET adopted_at = $4, adopted_by_identity_id = $5
        WHERE organization_id = $1
          AND decision_id = $2
          AND contribution_id = $3
          AND adopted_at IS NULL`,
      [
        input.organizationId,
        input.decisionId,
        input.contributionId,
        input.now,
        input.adoptedByIdentityId,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
