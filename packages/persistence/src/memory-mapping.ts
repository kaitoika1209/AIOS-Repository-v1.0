/**
 * Memory row to domain mapping.
 *
 * Review evidence lives on the revision that was resolved, so review records
 * are reconstructed from the revisions plus the root's review columns rather
 * than from a separate table.
 */

import type {
  AggregateVersion,
  IdentityId,
  MembershipId,
  MemoryId,
  MemoryStatus,
  OrganizationId,
  WorkId,
} from "@aios/types";
import type {
  MemoryRevision,
  MemoryRevisionStatus,
  MemoryReviewRecord,
  MemoryState,
} from "@aios/domain";

export interface MemoryRootRow {
  memory_id: string;
  organization_id: string;
  source_work_id: string;
  source_snapshot_id: string;
  source_snapshot_hash: string;
  status: string;
  is_active: boolean;
  current_revision_id: string;
  current_revision_number: number;
  generation_policy_version: number;
  generated_by_system_principal_id: string;
  generated_at: Date;
  submitted_revision_id: string | null;
  reviewed_revision_id: string | null;
  version: string | number;
}

export interface MemoryRevisionRow {
  memory_revision_id: string;
  organization_id: string;
  memory_id: string;
  revision_number: number;
  revision_status: string;
  title: string;
  summary: string;
  content: string;
  source_references: unknown;
  created_by_actor_type: string;
  created_by_actor_id: string;
  created_by_membership_id: string | null;
  content_hash: string;
  created_at: Date;
}

const toVersion = (value: string | number): AggregateVersion =>
  (typeof value === "string" ? Number.parseInt(value, 10) : value) as AggregateVersion;

const toRevision = (row: MemoryRevisionRow): MemoryRevision => ({
  revisionId: row.memory_revision_id,
  revisionNumber: row.revision_number,
  status: row.revision_status as MemoryRevisionStatus,
  title: row.title,
  summary: row.summary,
  content: row.content,
  sourceReferences: ((row.source_references ?? []) as string[]).map(String),
  author: {
    actorType: row.created_by_actor_type as "HumanMember" | "AI" | "System",
    actorId: row.created_by_actor_id as IdentityId,
    membershipId: row.created_by_membership_id as MembershipId | null,
  },
  contentHash: row.content_hash,
  createdAt: row.created_at,
});

/**
 * Rebuild review records.
 *
 * Only the most recent review is stored on the root, so earlier ones are
 * inferred from resolved revisions. That is enough for the MVP, where the
 * outcome and the revision it resolved are what a reviewer needs to see.
 */
const toReviewRecords = (
  root: MemoryRootRow,
  revisions: readonly MemoryRevisionRow[],
  reviewedBy: { identityId: string | null; membershipId: string | null; note: string | null; at: Date | null },
): readonly MemoryReviewRecord[] =>
  revisions
    .filter((r) => r.revision_status === "Approved" || r.revision_status === "Rejected")
    .map((r) => ({
      revisionId: r.memory_revision_id,
      revisionNumber: r.revision_number,
      outcome: r.revision_status as "Approved" | "Rejected",
      reviewedByIdentityId: (reviewedBy.identityId ?? r.created_by_actor_id) as IdentityId,
      reviewedByMembershipId: (reviewedBy.membershipId ?? "") as MembershipId,
      reviewedAt: reviewedBy.at ?? r.created_at,
      note: reviewedBy.note ?? "",
    }));

export const hydrateMemory = (
  root: MemoryRootRow & {
    reviewed_by_identity_id?: string | null;
    reviewed_by_membership_id?: string | null;
    review_note?: string | null;
    reviewed_at?: Date | null;
  },
  revisions: readonly MemoryRevisionRow[],
): MemoryState => ({
  memoryId: root.memory_id as MemoryId,
  organizationId: root.organization_id as OrganizationId,
  sourceWorkId: root.source_work_id as WorkId,
  status: root.status as MemoryStatus,
  isActive: root.is_active,
  provenance: {
    sourceSnapshotId: root.source_snapshot_id,
    sourceSnapshotHash: root.source_snapshot_hash,
    generationPolicyVersion: root.generation_policy_version,
    generatedBySystemPrincipalId: root.generated_by_system_principal_id,
    generatedAt: root.generated_at,
  },
  revisions: revisions.map(toRevision),
  currentRevisionId: root.current_revision_id,
  submittedRevisionId: root.submitted_revision_id,
  reviewedRevisionId: root.reviewed_revision_id,
  reviewRecords: toReviewRecords(root, revisions, {
    identityId: root.reviewed_by_identity_id ?? null,
    membershipId: root.reviewed_by_membership_id ?? null,
    note: root.review_note ?? null,
    at: root.reviewed_at ?? null,
  }),
  version: toVersion(root.version),
});
