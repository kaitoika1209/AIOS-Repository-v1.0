/**
 * Decision row to domain mapping.
 *
 * A Decision is assembled from a root row plus its revision rows. Review
 * evidence lives on the revision that was resolved, so review records are
 * reconstructed from the revisions rather than stored separately.
 */

import type {
  AggregateVersion,
  DecisionId,
  DecisionStatus,
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
} from "@aios/types";
import type {
  DecisionOption,
  DecisionResolutionOutcome,
  DecisionReviewRecord,
  DecisionRevision,
  DecisionState,
  RevisionStatus,
} from "@aios/domain";

export interface DecisionRootRow {
  decision_id: string;
  organization_id: string;
  related_work_id: string;
  is_blocking: boolean;
  status: string;
  current_revision_id: string | null;
  current_revision_number: number;
  created_by_identity_id: string;
  created_by_membership_id: string;
  submitted_revision_id: string | null;
  decided_revision_id: string | null;
  version: string | number;
}

export interface DecisionRevisionRow {
  decision_revision_id: string;
  organization_id: string;
  decision_id: string;
  revision_number: number;
  revision_status: string;
  title: string;
  question: string;
  context: string | null;
  options: unknown;
  rationale: string | null;
  created_by_identity_id: string;
  created_by_membership_id: string;
  reviewed_by_identity_id: string | null;
  reviewed_by_membership_id: string | null;
  reviewed_at: Date | null;
  review_rationale: string | null;
  selected_option_id: string | null;
  created_at: Date;
}

const toVersion = (value: string | number): AggregateVersion =>
  (typeof value === "string" ? Number.parseInt(value, 10) : value) as AggregateVersion;

const toRevision = (row: DecisionRevisionRow): DecisionRevision => ({
  revisionId: row.decision_revision_id,
  revisionNumber: row.revision_number,
  status: row.revision_status as RevisionStatus,
  title: row.title,
  question: row.question,
  context: row.context,
  // JSONB arrives parsed; rebuilt into plain objects so no driver value reaches
  // the domain.
  options: ((row.options ?? []) as DecisionOption[]).map((o) => ({
    optionId: o.optionId,
    summary: o.summary,
  })),
  rationale: row.rationale,
  createdByIdentityId: row.created_by_identity_id as IdentityId,
  createdByMembershipId: row.created_by_membership_id as MembershipId,
  createdAt: row.created_at,
});

const RESOLVED: readonly string[] = ["Approved", "Rejected", "Withdrawn"];

/** A revision that has been reviewed carries its own review record. */
const toReviewRecord = (
  row: DecisionRevisionRow,
): DecisionReviewRecord | null => {
  if (!RESOLVED.includes(row.revision_status) || row.reviewed_by_identity_id === null) {
    return null;
  }
  return {
    revisionId: row.decision_revision_id,
    revisionNumber: row.revision_number,
    outcome: row.revision_status as DecisionResolutionOutcome,
    reviewedByIdentityId: row.reviewed_by_identity_id as IdentityId,
    reviewedByMembershipId: row.reviewed_by_membership_id as MembershipId,
    reviewedAt: row.reviewed_at ?? new Date(0),
    rationale: row.review_rationale ?? "",
    selectedOptionId: row.selected_option_id,
  };
};

export const hydrateDecision = (
  root: DecisionRootRow,
  revisions: readonly DecisionRevisionRow[],
): DecisionState => ({
  decisionId: root.decision_id as DecisionId,
  organizationId: root.organization_id as OrganizationId,
  relatedWorkId: root.related_work_id as WorkId,
  isBlocking: root.is_blocking,
  status: root.status as DecisionStatus,
  revisions: revisions.map(toRevision),
  currentRevisionId: root.current_revision_id,
  submittedRevisionId: root.submitted_revision_id,
  decidedRevisionId: root.decided_revision_id,
  reviewRecords: revisions
    .map(toReviewRecord)
    .filter((r): r is DecisionReviewRecord => r !== null),
  createdByIdentityId: root.created_by_identity_id as IdentityId,
  createdByMembershipId: root.created_by_membership_id as MembershipId,
  version: toVersion(root.version),
});
