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

import {
  gateColumns,
  hydrateWork,
  type WorkParticipantRow,
  type WorkProgressRow,
  type WorkRow,
} from "./mapping.js";

const PARTICIPANT_COLUMNS = `
  work_participant_id,
  membership_id,
  relationship_type,
  added_by_identity_id,
  added_by_membership_id,
  added_at,
  removed_by_identity_id,
  removed_by_membership_id,
  removed_at
`;

const PROGRESS_COLUMNS = `
  work_progress_record_id,
  content,
  recorded_by_identity_id,
  recorded_by_membership_id,
  recorded_at
`;

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
  completed_by_membership_id,
  completion_summary,
  completed_at,
  cancelled_at,
  cancelled_by_identity_id,
  cancelled_by_membership_id,
  cancellation_reason,
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
    if (row === undefined) {
      return null;
    }

    const [participants, progress] = await Promise.all([
      this.participantsOf(organizationId, [workId]),
      this.progressOf(organizationId, [workId]),
    ]);

    return hydrateWork(row, {
      participants: participants.get(workId) ?? [],
      progress: progress.get(workId) ?? [],
    });
  }

  /**
   * Child rows for a set of Work, keyed by Work.
   *
   * Read in one statement per collection rather than one per Work: a listing of
   * fifty Work would otherwise issue a hundred extra queries, and the
   * Aggregate cannot be hydrated without them.
   */
  private async participantsOf(
    organizationId: OrganizationId,
    workIds: readonly WorkId[],
  ): Promise<Map<WorkId, WorkParticipantRow[]>> {
    const grouped = new Map<WorkId, WorkParticipantRow[]>();
    if (workIds.length === 0) {
      return grouped;
    }

    const result = await this.client.query<WorkParticipantRow & { work_id: string }>(
      `SELECT work_id, ${PARTICIPANT_COLUMNS}
         FROM work_participants
        WHERE organization_id = $1
          AND work_id = ANY($2::uuid[])
        ORDER BY added_at`,
      [organizationId, workIds],
    );

    for (const row of result.rows) {
      const key = row.work_id as WorkId;
      const list = grouped.get(key);
      if (list === undefined) grouped.set(key, [row]);
      else list.push(row);
    }
    return grouped;
  }

  private async progressOf(
    organizationId: OrganizationId,
    workIds: readonly WorkId[],
  ): Promise<Map<WorkId, WorkProgressRow[]>> {
    const grouped = new Map<WorkId, WorkProgressRow[]>();
    if (workIds.length === 0) {
      return grouped;
    }

    const result = await this.client.query<WorkProgressRow & { work_id: string }>(
      `SELECT work_id, ${PROGRESS_COLUMNS}
         FROM work_progress_records
        WHERE organization_id = $1
          AND work_id = ANY($2::uuid[])
        ORDER BY recorded_at`,
      [organizationId, workIds],
    );

    for (const row of result.rows) {
      const key = row.work_id as WorkId;
      const list = grouped.get(key);
      if (list === undefined) grouped.set(key, [row]);
      else list.push(row);
    }
    return grouped;
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
         completion_summary, completed_at,
         cancelled_at, cancelled_by_identity_id, cancelled_by_membership_id, cancellation_reason,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12,
         $13,
         $14, $15,
         $16, $17, $18,
         $19, $20,
         $21, $22, $23, $24,
         $25, $26, $27
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
        work.completedByMembershipId,
        work.completionSummary,
        work.completedAt,
        work.cancelledAt,
        work.cancelledByIdentityId,
        work.cancelledByMembershipId,
        work.cancellationReason,
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
              completed_by_membership_id = $14,
              completion_summary = $15,
              completed_at = $16,
              cancelled_at = $17,
              cancelled_by_identity_id = $18,
              cancelled_by_membership_id = $19,
              cancellation_reason = $20,
              version = $21,
              updated_at = $22
        WHERE organization_id = $23
          AND work_id = $24
          AND version = $25`,
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
        work.completedByMembershipId,
        work.completionSummary,
        work.completedAt,
        work.cancelledAt,
        work.cancelledByIdentityId,
        work.cancelledByMembershipId,
        work.cancellationReason,
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

    await this.writeChildren(work);
  }

  /**
   * Reconcile the child collections against what is stored.
   *
   * Unknown rows are inserted; known participant rows receive their removal
   * only. Content columns are never rewritten, because neither collection has an
   * edit command: a participant row's relationship and attribution are fixed at
   * insert, and a progress record is append-only. Writing them again would make
   * a rewrite possible through a path the Aggregate does not offer.
   */
  private async writeChildren(work: WorkState): Promise<void> {
    const storedParticipants = await this.client.query<{
      work_participant_id: string;
      removed_at: Date | null;
    }>(
      `SELECT work_participant_id, removed_at
         FROM work_participants
        WHERE organization_id = $1 AND work_id = $2`,
      [work.organizationId, work.workId],
    );
    const known = new Map(
      storedParticipants.rows.map((r) => [r.work_participant_id, r.removed_at]),
    );

    for (const participant of work.participants) {
      if (!known.has(participant.participantId)) {
        await this.insertParticipant(work, participant);
        continue;
      }
      // Only the transition from active to ended is written, and only once.
      if (participant.removedAt !== null && known.get(participant.participantId) === null) {
        await this.client.query(
          `UPDATE work_participants
              SET removed_by_identity_id = $1,
                  removed_by_membership_id = $2,
                  removed_at = $3
            WHERE organization_id = $4
              AND work_participant_id = $5
              AND removed_at IS NULL`,
          [
            participant.removedByIdentityId,
            participant.removedByMembershipId,
            participant.removedAt,
            work.organizationId,
            participant.participantId,
          ],
        );
      }
    }

    const storedProgress = await this.client.query<{ work_progress_record_id: string }>(
      `SELECT work_progress_record_id
         FROM work_progress_records
        WHERE organization_id = $1 AND work_id = $2`,
      [work.organizationId, work.workId],
    );
    const recorded = new Set(
      storedProgress.rows.map((r) => r.work_progress_record_id),
    );

    for (const record of work.progressRecords) {
      if (recorded.has(record.progressRecordId)) continue;
      await this.client.query(
        `INSERT INTO work_progress_records (
           work_progress_record_id, organization_id, work_id, content,
           recorded_by_identity_id, recorded_by_membership_id, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.progressRecordId,
          work.organizationId,
          work.workId,
          record.content,
          record.recordedByIdentityId,
          record.recordedByMembershipId,
          record.recordedAt,
        ],
      );
    }
  }

  private async insertParticipant(
    work: WorkState,
    participant: WorkState["participants"][number],
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO work_participants (
         work_participant_id, organization_id, work_id, membership_id,
         relationship_type,
         added_by_identity_id, added_by_membership_id, added_at,
         removed_by_identity_id, removed_by_membership_id, removed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        participant.participantId,
        work.organizationId,
        work.workId,
        participant.membershipId,
        participant.relationshipType,
        participant.addedByIdentityId,
        participant.addedByMembershipId,
        participant.addedAt,
        participant.removedByIdentityId,
        participant.removedByMembershipId,
        participant.removedAt,
      ],
    );
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

    const workIds = result.rows.map((r) => r.work_id as WorkId);
    const [participants, progress] = await Promise.all([
      this.participantsOf(organizationId, workIds),
      this.progressOf(organizationId, workIds),
    ]);

    return result.rows.map((row) =>
      hydrateWork(row, {
        participants: participants.get(row.work_id as WorkId) ?? [],
        progress: progress.get(row.work_id as WorkId) ?? [],
      }),
    );
  }
}
