/**
 * The Work completion gate.
 *
 * `docs/architecture/state-machines/work.md` defines four gate values. The gate
 * is a *local snapshot* — it is not the source of truth for the Decision. It
 * exists so the Work Aggregate can enforce its own transition rules without
 * querying another Aggregate, which ADR-0005 and ADR-0007 forbid.
 *
 * The Application Layer updates the snapshot from authoritative Decision events
 * and must match the complete submitted-revision reference, never `decisionId`
 * alone: a stale revision must not satisfy a gate raised for a newer one.
 */

import type { DecisionId, IdentityId } from "@aios/types";

/**
 * Identifies one submitted Decision revision. All three parts must match.
 *
 * `submittedSnapshotId` is opaque to the domain but must be a UUID, because the
 * persistence schema types the corresponding columns as `uuid`.
 */
export interface BlockingReference {
  readonly decisionId: DecisionId;
  readonly revisionNumber: number;
  readonly submittedSnapshotId: string;
}

export interface GateNotRequired {
  readonly kind: "NotRequired";
}

export interface GatePending {
  readonly kind: "Pending";
  readonly reference: BlockingReference;
}

export interface GateSatisfied {
  readonly kind: "Satisfied";
  readonly reference: BlockingReference;
  readonly approvedAt: Date;
  readonly approvedBy: IdentityId;
}

export interface GateUnsatisfied {
  readonly kind: "Unsatisfied";
  readonly reference: BlockingReference;
  readonly outcome: "Rejected" | "Withdrawn";
  readonly resolvedAt: Date;
  readonly resolvedBy: IdentityId;
}

export type CompletionGate =
  | GateNotRequired
  | GatePending
  | GateSatisfied
  | GateUnsatisfied;

export const gateNotRequired = (): CompletionGate => ({ kind: "NotRequired" });

export const referencesMatch = (
  a: BlockingReference,
  b: BlockingReference,
): boolean =>
  a.decisionId === b.decisionId &&
  a.revisionNumber === b.revisionNumber &&
  a.submittedSnapshotId === b.submittedSnapshotId;

/**
 * Whether the gate currently permits completion.
 *
 * `Unsatisfied` blocks completion: a rejected or withdrawn Decision does not
 * permit completion when approval remains required. The Work may raise a new
 * blocking Decision from `InProgress`.
 */
export const permitsCompletion = (gate: CompletionGate): boolean =>
  gate.kind === "NotRequired" || gate.kind === "Satisfied";

export const isPending = (gate: CompletionGate): gate is GatePending =>
  gate.kind === "Pending";
