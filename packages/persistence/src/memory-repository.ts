/**
 * PostgreSQL Memory repository (ADR-0015).
 *
 * A Memory spans `memories` and `memory_revisions`, the same shape as Decision.
 * Revision content is written only while the stored revision is `Generated`,
 * which is what keeps a submitted, approved, or rejected revision usable as
 * review evidence.
 *
 * `uq_memories_active_source_work` enforces one active Memory per Work in the
 * database, so a redelivered `WorkCompleted` cannot produce a second draft.
 */

import type { PoolClient } from "pg";

import type { MemoryId, OrganizationId, WorkId } from "@aios/types";
import {
  VersionConflictError,
  type MemoryRevision,
  type MemoryState,
} from "@aios/domain";

import {
  hydrateMemory,
  type MemoryRevisionRow,
  type MemoryRootRow,
} from "./memory-mapping.js";

const ROOT_COLUMNS = `
  memory_id, organization_id, source_work_id,
  source_snapshot_id, source_snapshot_hash,
  status, is_active,
  current_revision_id, current_revision_number,
  generation_policy_version, generated_by_system_principal_id, generated_at,
  submitted_revision_id, reviewed_revision_id,
  reviewed_by_identity_id, reviewed_by_membership_id, review_note, reviewed_at,
  version
`;

const REVISION_COLUMNS = `
  memory_revision_id, organization_id, memory_id,
  revision_number, revision_status,
  title, summary, content, source_references,
  created_by_actor_type, created_by_actor_id, created_by_membership_id,
  content_hash, created_at
`;

/** Repositories are Organization-scoped by signature, not by convention. */
export class PostgresMemoryRepository {
  constructor(private readonly client: PoolClient) {}

  async findById(
    organizationId: OrganizationId,
    memoryId: MemoryId,
  ): Promise<MemoryState | null> {
    const root = await this.client.query<MemoryRootRow>(
      `SELECT ${ROOT_COLUMNS} FROM memories
        WHERE organization_id = $1 AND memory_id = $2`,
      [organizationId, memoryId],
    );
    const rootRow = root.rows[0];
    if (rootRow === undefined) return null;

    return hydrateMemory(rootRow, await this.revisionsOf(organizationId, memoryId));
  }

  async findActiveByWork(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<MemoryState | null> {
    const root = await this.client.query<MemoryRootRow>(
      `SELECT ${ROOT_COLUMNS} FROM memories
        WHERE organization_id = $1 AND source_work_id = $2 AND is_active = true`,
      [organizationId, workId],
    );
    const rootRow = root.rows[0];
    if (rootRow === undefined) return null;

    return hydrateMemory(
      rootRow,
      await this.revisionsOf(organizationId, rootRow.memory_id as MemoryId),
    );
  }

  async listByOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly MemoryState[]> {
    const roots = await this.client.query<MemoryRootRow>(
      `SELECT ${ROOT_COLUMNS} FROM memories
        WHERE organization_id = $1
        ORDER BY generated_at DESC`,
      [organizationId],
    );

    const out: MemoryState[] = [];
    for (const root of roots.rows) {
      out.push(
        hydrateMemory(
          root,
          await this.revisionsOf(organizationId, root.memory_id as MemoryId),
        ),
      );
    }
    return out;
  }

  private async revisionsOf(
    organizationId: OrganizationId,
    memoryId: MemoryId,
  ): Promise<MemoryRevisionRow[]> {
    const result = await this.client.query<MemoryRevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM memory_revisions
        WHERE organization_id = $1 AND memory_id = $2
        ORDER BY revision_number ASC`,
      [organizationId, memoryId],
    );
    return result.rows;
  }

  async insert(memory: MemoryState): Promise<void> {
    const current = memory.revisions.find(
      (r) => r.revisionId === memory.currentRevisionId,
    );

    await this.client.query(
      `INSERT INTO memories (
         memory_id, organization_id, source_work_id,
         source_snapshot_id, source_snapshot_hash,
         status, is_active,
         current_revision_id, current_revision_number,
         generation_policy_version, generated_by_system_principal_id, generated_at,
         submitted_revision_id, reviewed_revision_id,
         version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        memory.memoryId,
        memory.organizationId,
        memory.sourceWorkId,
        memory.provenance.sourceSnapshotId,
        memory.provenance.sourceSnapshotHash,
        memory.status,
        memory.isActive,
        memory.currentRevisionId,
        current?.revisionNumber ?? 1,
        memory.provenance.generationPolicyVersion,
        memory.provenance.generatedBySystemPrincipalId,
        memory.provenance.generatedAt,
        memory.submittedRevisionId,
        memory.reviewedRevisionId,
        memory.version,
        new Date(),
        new Date(),
      ],
    );

    for (const revision of memory.revisions) {
      await this.insertRevision(memory, revision);
    }
  }

  private async insertRevision(
    memory: MemoryState,
    revision: MemoryRevision,
  ): Promise<void> {
    await this.client.query(
      `INSERT INTO memory_revisions (
         memory_revision_id, organization_id, memory_id,
         revision_number, revision_status,
         title, summary, content, source_references,
         created_by_actor_type, created_by_actor_id, created_by_membership_id,
         content_hash, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        revision.revisionId,
        memory.organizationId,
        memory.memoryId,
        revision.revisionNumber,
        revision.status,
        revision.title,
        revision.summary,
        revision.content,
        JSON.stringify(revision.sourceReferences),
        revision.author.actorType,
        revision.author.actorId,
        revision.author.membershipId,
        revision.contentHash,
        revision.createdAt,
        new Date(),
      ],
    );
  }

  async update(memory: MemoryState, expectedVersion: number): Promise<void> {
    const current = memory.revisions.find(
      (r) => r.revisionId === memory.currentRevisionId,
    );
    const review = memory.reviewRecords.at(-1) ?? null;

    const result = await this.client.query(
      `UPDATE memories
          SET status = $1,
              is_active = $2,
              current_revision_id = $3,
              current_revision_number = $4,
              submitted_revision_id = $5,
              reviewed_revision_id = $6,
              reviewed_by_identity_id = $7,
              reviewed_by_membership_id = $8,
              review_note = $9,
              reviewed_at = $10,
              version = $11,
              updated_at = $12
        WHERE organization_id = $13 AND memory_id = $14 AND version = $15`,
      [
        memory.status,
        memory.isActive,
        memory.currentRevisionId,
        current?.revisionNumber ?? 1,
        memory.submittedRevisionId,
        memory.reviewedRevisionId,
        memory.reviewedRevisionId === null ? null : review?.reviewedByIdentityId ?? null,
        memory.reviewedRevisionId === null ? null : review?.reviewedByMembershipId ?? null,
        memory.reviewedRevisionId === null ? null : review?.note ?? null,
        memory.reviewedRevisionId === null ? null : review?.reviewedAt ?? null,
        memory.version,
        new Date(),
        memory.organizationId,
        memory.memoryId,
        expectedVersion,
      ],
    );

    if (result.rowCount === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }

    const existing = await this.client.query<{ memory_revision_id: string }>(
      `SELECT memory_revision_id FROM memory_revisions
        WHERE organization_id = $1 AND memory_id = $2`,
      [memory.organizationId, memory.memoryId],
    );
    const known = new Set(existing.rows.map((r) => r.memory_revision_id));

    for (const revision of memory.revisions) {
      if (known.has(revision.revisionId)) {
        await this.updateRevision(memory, revision);
      } else {
        await this.insertRevision(memory, revision);
      }
    }
  }

  /**
   * Content is written only while the stored revision is still `Generated`.
   * A revision that has left Generated still receives its status transition —
   * that is what submitting or resolving it means — but never new content.
   */
  private async updateRevision(
    memory: MemoryState,
    revision: MemoryRevision,
  ): Promise<void> {
    await this.client.query(
      `UPDATE memory_revisions
          SET title = CASE WHEN revision_status = 'Generated' THEN $1 ELSE title END,
              summary = CASE WHEN revision_status = 'Generated' THEN $2 ELSE summary END,
              content = CASE WHEN revision_status = 'Generated' THEN $3 ELSE content END,
              content_hash = CASE WHEN revision_status = 'Generated' THEN $4 ELSE content_hash END,
              revision_status = $5,
              locked_at = CASE
                WHEN revision_status = 'Generated' AND $5 <> 'Generated' THEN now()
                ELSE locked_at
              END,
              updated_at = $6
        WHERE organization_id = $7 AND memory_revision_id = $8`,
      [
        revision.title,
        revision.summary,
        revision.content,
        revision.contentHash,
        revision.status,
        new Date(),
        memory.organizationId,
        revision.revisionId,
      ],
    );
  }
}
