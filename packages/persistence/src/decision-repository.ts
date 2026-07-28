/**
 * PostgreSQL Decision repository (ADR-0015).
 *
 * A Decision spans two tables: `decisions` holds root state and revision
 * pointers, `decision_revisions` holds the revisions themselves. Both are
 * written inside the caller's transaction, so the aggregate is never persisted
 * in a partially updated state.
 *
 * Revision content is only ever written for a revision in `Draft`. The
 * persistence document states the repository "must not issue content updates
 * when revision_status <> 'Draft'", which is what keeps submitted, approved,
 * and rejected revisions usable as evidence.
 */

import type { PoolClient } from "pg";

import type { DecisionId, OrganizationId, WorkId } from "@aios/types";
import {
  VersionConflictError,
  type DecisionState,
  type DecisionRevision,
} from "@aios/domain";
import type { DecisionRepository } from "@aios/application";

import {
  hydrateDecision,
  type DecisionRevisionRow,
  type DecisionRootRow,
} from "./decision-mapping.js";

const ROOT_COLUMNS = `
  decision_id,
  organization_id,
  related_work_id,
  is_blocking,
  status,
  current_revision_id,
  current_revision_number,
  created_by_identity_id,
  created_by_membership_id,
  submitted_revision_id,
  decided_revision_id,
  version
`;

const REVISION_COLUMNS = `
  decision_revision_id,
  organization_id,
  decision_id,
  revision_number,
  revision_status,
  title,
  question,
  context,
  options,
  rationale,
  created_by_identity_id,
  created_by_membership_id,
  reviewed_by_identity_id,
  reviewed_by_membership_id,
  reviewed_at,
  review_rationale,
  selected_option_id,
  created_at
`;

export class PostgresDecisionRepository implements DecisionRepository {
  constructor(private readonly client: PoolClient) {}

  async findById(
    organizationId: OrganizationId,
    decisionId: DecisionId,
  ): Promise<DecisionState | null> {
    const root = await this.client.query<DecisionRootRow>(
      `SELECT ${ROOT_COLUMNS}
         FROM decisions
        WHERE organization_id = $1
          AND decision_id = $2`,
      [organizationId, decisionId],
    );

    const rootRow = root.rows[0];
    if (rootRow === undefined) {
      return null;
    }

    const revisions = await this.client.query<DecisionRevisionRow>(
      `SELECT ${REVISION_COLUMNS}
         FROM decision_revisions
        WHERE organization_id = $1
          AND decision_id = $2
        ORDER BY revision_number ASC`,
      [organizationId, decisionId],
    );

    return hydrateDecision(rootRow, revisions.rows);
  }

  async insert(decision: DecisionState): Promise<void> {
    const current = decision.revisions.find(
      (r) => r.revisionId === decision.currentRevisionId,
    );

    await this.client.query(
      `INSERT INTO decisions (
         decision_id, organization_id, related_work_id, is_blocking, status,
         current_revision_id, current_revision_number,
         created_by_identity_id, created_by_membership_id,
         submitted_revision_id, decided_revision_id,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7,
         $8, $9,
         $10, $11,
         $12, $13, $14
       )`,
      [
        decision.decisionId,
        decision.organizationId,
        decision.relatedWorkId,
        decision.isBlocking,
        decision.status,
        decision.currentRevisionId,
        current?.revisionNumber ?? 1,
        decision.createdByIdentityId,
        decision.createdByMembershipId,
        decision.submittedRevisionId,
        decision.decidedRevisionId,
        decision.version,
        new Date(),
        new Date(),
      ],
    );

    for (const revision of decision.revisions) {
      await this.insertRevision(decision, revision);
    }
  }

  private async insertRevision(
    decision: DecisionState,
    revision: DecisionRevision,
  ): Promise<void> {
    const review = decision.reviewRecords.find(
      (r) => r.revisionId === revision.revisionId,
    );

    await this.client.query(
      `INSERT INTO decision_revisions (
         decision_revision_id, organization_id, decision_id,
         revision_number, revision_status,
         title, question, context, options, rationale,
         created_by_identity_id, created_by_membership_id,
         reviewed_by_identity_id, reviewed_by_membership_id, reviewed_at,
         review_rationale, selected_option_id,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3,
         $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19
       )`,
      [
        revision.revisionId,
        decision.organizationId,
        decision.decisionId,
        revision.revisionNumber,
        revision.status,
        revision.title,
        revision.question,
        revision.context,
        JSON.stringify(revision.options),
        revision.rationale,
        revision.createdByIdentityId,
        revision.createdByMembershipId,
        review?.reviewedByIdentityId ?? null,
        review?.reviewedByMembershipId ?? null,
        review?.reviewedAt ?? null,
        review?.rationale ?? null,
        review?.selectedOptionId ?? null,
        revision.createdAt,
        new Date(),
      ],
    );
  }

  async update(decision: DecisionState, expectedVersion: number): Promise<void> {
    const current = decision.revisions.find(
      (r) => r.revisionId === decision.currentRevisionId,
    );

    // `ck_decisions_decided_fields` requires the root to carry the reviewer and
    // timestamp whenever the Decision is resolved, and to carry none of them
    // while it is still Draft or InReview.
    const decided =
      decision.decidedRevisionId === null
        ? null
        : (decision.reviewRecords.find(
            (r) => r.revisionId === decision.decidedRevisionId,
          ) ?? null);

    const result = await this.client.query(
      `UPDATE decisions
          SET status = $1,
              is_blocking = $2,
              current_revision_id = $3,
              current_revision_number = $4,
              submitted_revision_id = $5,
              decided_revision_id = $6,
              outcome = $7,
              decided_by_identity_id = $8,
              decided_by_membership_id = $9,
              review_rationale = $10,
              decided_at = $11,
              version = $12,
              updated_at = $13
        WHERE organization_id = $14
          AND decision_id = $15
          AND version = $16`,
      [
        decision.status,
        decision.isBlocking,
        decision.currentRevisionId,
        current?.revisionNumber ??
          decision.revisions[decision.revisions.length - 1]?.revisionNumber ??
          1,
        decision.submittedRevisionId,
        decision.decidedRevisionId,
        decided?.outcome ?? null,
        decided?.reviewedByIdentityId ?? null,
        decided?.reviewedByMembershipId ?? null,
        decided?.rationale ?? null,
        decided?.reviewedAt ?? null,
        decision.version,
        new Date(),
        decision.organizationId,
        decision.decisionId,
        expectedVersion,
      ],
    );

    if (result.rowCount === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }

    const existing = await this.client.query<{ decision_revision_id: string }>(
      `SELECT decision_revision_id
         FROM decision_revisions
        WHERE organization_id = $1
          AND decision_id = $2`,
      [decision.organizationId, decision.decisionId],
    );
    const known = new Set(existing.rows.map((r) => r.decision_revision_id));

    for (const revision of decision.revisions) {
      if (!known.has(revision.revisionId)) {
        await this.insertRevision(decision, revision);
        continue;
      }
      await this.updateRevision(decision, revision);
    }
  }

  /**
   * Update one revision.
   *
   * Content columns are written only while the stored row is still `Draft`. A
   * revision that has left Draft can still receive its status transition and
   * review evidence — that is what resolving it means — but never new content.
   */
  private async updateRevision(
    decision: DecisionState,
    revision: DecisionRevision,
  ): Promise<void> {
    const review = decision.reviewRecords.find(
      (r) => r.revisionId === revision.revisionId,
    );

    await this.client.query(
      `UPDATE decision_revisions
          SET title = CASE WHEN revision_status = 'Draft' THEN $1 ELSE title END,
              question = CASE WHEN revision_status = 'Draft' THEN $2 ELSE question END,
              context = CASE WHEN revision_status = 'Draft' THEN $3 ELSE context END,
              options = CASE WHEN revision_status = 'Draft' THEN $4::jsonb ELSE options END,
              rationale = CASE WHEN revision_status = 'Draft' THEN $5 ELSE rationale END,
              revision_status = $6,
              reviewed_by_identity_id = COALESCE($7, reviewed_by_identity_id),
              reviewed_by_membership_id = COALESCE($8, reviewed_by_membership_id),
              reviewed_at = COALESCE($9, reviewed_at),
              review_rationale = COALESCE($10, review_rationale),
              selected_option_id = COALESCE($11, selected_option_id),
              updated_at = $12
        WHERE organization_id = $13
          AND decision_revision_id = $14`,
      [
        revision.title,
        revision.question,
        revision.context,
        JSON.stringify(revision.options),
        revision.rationale,
        revision.status,
        review?.reviewedByIdentityId ?? null,
        review?.reviewedByMembershipId ?? null,
        review?.reviewedAt ?? null,
        review?.rationale ?? null,
        review?.selectedOptionId ?? null,
        new Date(),
        decision.organizationId,
        revision.revisionId,
      ],
    );
  }

  async listByWork(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<readonly DecisionState[]> {
    const roots = await this.client.query<DecisionRootRow>(
      `SELECT ${ROOT_COLUMNS}
         FROM decisions
        WHERE organization_id = $1
          AND related_work_id = $2
        ORDER BY created_at DESC`,
      [organizationId, workId],
    );

    const out: DecisionState[] = [];
    for (const root of roots.rows) {
      const revisions = await this.client.query<DecisionRevisionRow>(
        `SELECT ${REVISION_COLUMNS}
           FROM decision_revisions
          WHERE organization_id = $1
            AND decision_id = $2
          ORDER BY revision_number ASC`,
        [organizationId, root.decision_id],
      );
      out.push(hydrateDecision(root, revisions.rows));
    }
    return out;
  }
}
