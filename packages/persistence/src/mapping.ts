/**
 * Row to domain mapping.
 *
 * The persistence document requires database rows to map through persistence
 * DTOs before domain objects are constructed, and forbids domain objects from
 * depending on SQL result types or driver values. Every conversion between a
 * `pg` row and a domain object happens in this file.
 *
 * Hydration trusts validated persisted state: it restores version and lifecycle
 * state and emits no domain events.
 */

import type {
  AggregateVersion,
  DecisionId,
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  WorkStatus,
} from "@aios/types";
import type { CompletionGate, WorkState } from "@aios/domain";

/** Shape of a `work_items` row, as the driver returns it. */
export interface WorkRow {
  work_id: string;
  organization_id: string;
  title: string;
  description: string | null;
  status: string;
  completion_gate_type: string;
  completion_gate_decision_id: string | null;
  completion_gate_revision_number: number | null;
  completion_gate_submitted_snapshot_id: string | null;
  blocking_decision_id: string | null;
  blocking_decision_revision_number: number | null;
  blocking_decision_submitted_snapshot_id: string | null;
  decision_outcome: string | null;
  created_by_identity_id: string;
  created_by_membership_id: string;
  started_at: Date | null;
  completed_by_identity_id: string | null;
  completed_by_membership_id: string | null;
  completion_summary: string | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancelled_by_identity_id: string | null;
  cancelled_by_membership_id: string | null;
  cancellation_reason: string | null;
  version: string | number;
}

/**
 * `version` is `bigint`, which `pg` returns as a string to avoid precision
 * loss. Converting here rather than in the repository keeps that driver detail
 * out of every query site.
 */
const toVersion = (value: string | number): AggregateVersion =>
  (typeof value === "string" ? Number.parseInt(value, 10) : value) as AggregateVersion;

const toGate = (row: WorkRow): CompletionGate => {
  if (row.completion_gate_type === "NotRequired") {
    return { kind: "NotRequired" };
  }

  const reference = {
    decisionId: row.completion_gate_decision_id as DecisionId,
    revisionNumber: row.completion_gate_revision_number!,
    submittedSnapshotId: row.completion_gate_submitted_snapshot_id!,
  };

  switch (row.completion_gate_type) {
    case "Pending":
      return { kind: "Pending", reference };
    case "Satisfied":
      return {
        kind: "Satisfied",
        reference,
        approvedAt: row.completed_at ?? new Date(0),
        approvedBy: (row.completed_by_identity_id ?? "") as IdentityId,
      };
    case "Unsatisfied":
      return {
        kind: "Unsatisfied",
        reference,
        outcome: (row.decision_outcome ?? "Rejected") as "Rejected" | "Withdrawn",
        resolvedAt: row.completed_at ?? new Date(0),
        resolvedBy: (row.completed_by_identity_id ?? "") as IdentityId,
      };
    default:
      throw new Error(`Unknown completion gate type: ${row.completion_gate_type}`);
  }
};

export const hydrateWork = (row: WorkRow): WorkState => ({
  workId: row.work_id as WorkId,
  organizationId: row.organization_id as OrganizationId,
  title: row.title,
  description: row.description,
  status: row.status as WorkStatus,
  completionGate: toGate(row),
  blockingReference:
    row.blocking_decision_id === null
      ? null
      : {
          decisionId: row.blocking_decision_id as DecisionId,
          revisionNumber: row.blocking_decision_revision_number!,
          submittedSnapshotId: row.blocking_decision_submitted_snapshot_id!,
        },
  createdByIdentityId: row.created_by_identity_id as IdentityId,
  createdByMembershipId: row.created_by_membership_id as MembershipId,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  completedByIdentityId: row.completed_by_identity_id as IdentityId | null,
  completedByMembershipId: row.completed_by_membership_id as MembershipId | null,
  completionSummary: row.completion_summary,
  cancelledAt: row.cancelled_at,
  cancelledByIdentityId: row.cancelled_by_identity_id as IdentityId | null,
  cancelledByMembershipId: row.cancelled_by_membership_id as MembershipId | null,
  cancellationReason: row.cancellation_reason,
  version: toVersion(row.version),
});

/** Flattens the completion gate union into the columns the schema defines. */
export const gateColumns = (
  gate: CompletionGate,
): {
  type: string;
  decisionId: string | null;
  revisionNumber: number | null;
  snapshotId: string | null;
  outcome: string | null;
} => {
  if (gate.kind === "NotRequired") {
    return {
      type: "NotRequired",
      decisionId: null,
      revisionNumber: null,
      snapshotId: null,
      outcome: null,
    };
  }
  return {
    type: gate.kind,
    decisionId: gate.reference.decisionId,
    revisionNumber: gate.reference.revisionNumber,
    snapshotId: gate.reference.submittedSnapshotId,
    outcome: gate.kind === "Unsatisfied" ? gate.outcome : gate.kind === "Satisfied" ? "Approved" : null,
  };
};

/* Decision mapping lives in `decision-mapping.ts`: a Decision spans two tables. */
