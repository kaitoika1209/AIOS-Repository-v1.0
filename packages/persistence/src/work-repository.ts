/**
 * PostgreSQL Work repository (ADR-0015).
 *
 * Every statement names `organization_id` even where the primary key alone
 * would identify the row. That is the Organization-Scoped Repository Rule from
 * the persistence document: tenant scope belongs in the SQL, not only in the
 * caller's intent.
 *
 * Updates are conditional on the version the caller read. Zero affected rows is
 * a version conflict, which ADR-0014 surfaces as `409`.
 */

import type { PoolClient } from "pg";

import type { OrganizationId, WorkId } from "@aios/types";
import { VersionConflictError, type WorkState } from "@aios/domain";
import type { WorkRepository } from "@aios/application";

import { gateColumns, hydrateWork, type WorkRow } from "./mapping.js";

const COLUMNS = `
  work_id,
  organization_id,
  title,
  description,
  status,
  completion_gate_type,
  completion_gate_decision_id,
  completion_gate_revision_number,
  completion_gate_submitted_snapshot_id,
  blocking_decision_id,
  blocking_decision_revision_number,
  blocking_decision_submitted_snapshot_id,
  decision_outcome,
  created_by_identity_id,
  created_by_membership_id,
  started_at,
  completed_by_identity_id,
  completion_summary,
  completed_at,
  cancelled_at,
  version
`;

export class PostgresWorkRepository implements WorkRepository {
  constructor(private readonly client: PoolClient) {}

  async findById(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<WorkState | null> {
    const result = await this.client.query<WorkRow>(
      `SELECT ${COLUMNS}
         FROM work_items
        WHERE organization_id = $1
          AND work_id = $2`,
      [organizationId, workId],
    );

    const row = result.rows[0];
    return row === undefined ? null : hydrateWork(row);
  }

  async insert(work: WorkState): Promise<void> {
    const gate = gateColumns(work.completionGate);

    await this.client.query(
      `INSERT INTO work_items (
         work_id, organization_id, title, description, status,
         completion_gate_type,
         completion_gate_decision_id,
         completion_gate_revision_number,
         completion_gate_submitted_snapshot_id,
         blocking_decision_id,
         blocking_decision_revision_number,
         blocking_decision_submitted_snapshot_id,
         decision_outcome,
         created_by_identity_id, created_by_membership_id,
         started_at, completed_by_identity_id, completed_by_membership_id,
         completion_summary, completed_at, cancelled_at,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12,
         $13,
         $14, $15,
         $16, $17, $18,
         $19, $20, $21,
         $22, $23, $24
       )`,
      [
        work.workId,
        work.organizationId,
        work.title,
        work.description,
        work.status,
        gate.type,
        gate.decisionId,
        gate.revisionNumber,
        gate.snapshotId,
        work.blockingReference?.decisionId ?? null,
        work.blockingReference?.revisionNumber ?? null,
        work.blockingReference?.submittedSnapshotId ?? null,
        gate.outcome,
        work.createdByIdentityId,
        work.createdByMembershipId,
        work.startedAt,
        work.completedByIdentityId,
        work.completedByIdentityId === null ? null : work.createdByMembershipId,
        work.completionSummary,
        work.completedAt,
        work.cancelledAt,
        work.version,
        new Date(),
        new Date(),
      ],
    );
  }

  async update(work: WorkState, expectedVersion: number): Promise<void> {
    const gate = gateColumns(work.completionGate);

    const result = await this.client.query(
      `UPDATE work_items
          SET title = $1,
              description = $2,
              status = $3,
              completion_gate_type = $4,
              completion_gate_decision_id = $5,
              completion_gate_revision_number = $6,
              completion_gate_submitted_snapshot_id = $7,
              blocking_decision_id = $8,
              blocking_decision_revision_number = $9,
              blocking_decision_submitted_snapshot_id = $10,
              decision_outcome = $11,
              started_at = $12,
              completed_by_identity_id = $13,
              completion_summary = $14,
              completed_at = $15,
              cancelled_at = $16,
              version = $17,
              updated_at = $18
        WHERE organization_id = $19
          AND work_id = $20
          AND version = $21`,
      [
        work.title,
        work.description,
        work.status,
        gate.type,
        gate.decisionId,
        gate.revisionNumber,
        gate.snapshotId,
        work.blockingReference?.decisionId ?? null,
        work.blockingReference?.revisionNumber ?? null,
        work.blockingReference?.submittedSnapshotId ?? null,
        gate.outcome,
        work.startedAt,
        work.completedByIdentityId,
        work.completionSummary,
        work.completedAt,
        work.cancelledAt,
        work.version,
        new Date(),
        work.organizationId,
        work.workId,
        expectedVersion,
      ],
    );

    // Zero rows means either the version moved or the row belongs to another
    // Organization. Both are refusals to write, never a silent no-op.
    if (result.rowCount === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }
  }

  async listByOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly WorkState[]> {
    const result = await this.client.query<WorkRow>(
      `SELECT ${COLUMNS}
         FROM work_items
        WHERE organization_id = $1
        ORDER BY created_at DESC`,
      [organizationId],
    );

    return result.rows.map(hydrateWork);
  }
}
