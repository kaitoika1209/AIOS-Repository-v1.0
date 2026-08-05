/**
 * Reconciling the workflow-health projection (ADR-0023).
 *
 * The architecture: the projection "SHOULD update after each committed workflow
 * transition and MUST be reconciled on a schedule from Outbox delivery state,
 * processed-event records, Memory generation attempts, projection checkpoints,
 * and reconciliation findings."
 *
 * This is the MUST. One mechanism does three jobs, which is why it is worth
 * building before the optional per-transition update:
 *
 *   - it is the **scheduled reconciliation**, run from the Worker loop;
 *   - it is the **rebuild** — "The projection MUST be rebuildable. Rebuilding or
 *     deleting it does not change the underlying business or delivery truth" —
 *     because deleting every row and reconciling reproduces it exactly;
 *   - it is the **drift detector**.
 *
 * That last one needs care. A recompute-and-upsert cannot drift from its own
 * source, so a check that re-derived the answer and compared it to itself would
 * be a check that cannot fail. Instead the reconcile **reports what it changed**:
 * rows inserted, rows whose status moved, rows removed. A non-zero correction is
 * the finding. Zero means the projection was already right.
 *
 * There is no permission here and no principal. This is a scheduled job, not a
 * command — nothing about it is attributable to a person, which is also why the
 * projection row carries no Membership.
 */

import { getLogger } from "./logging.js";
import type { UseCaseDependencies } from "./ports.js";
import {
  PROJECTION_VERSION,
  WORKFLOW_TYPES,
  classify,
  type WorkflowHealthRow,
  type WorkflowType,
} from "./workflow-health.js";

/**
 * What one reconcile pass changed.
 *
 * The architecture requires reconciliation to detect "pending source records
 * absent from the health projection" and "terminal failures reported as
 * Healthy". Both are corrections this reports rather than conditions it looks
 * for: an absent row is `inserted`, and a row that claimed `Healthy` over a
 * terminal failure is a `statusChanged` from `Healthy` to `Blocked`.
 */
export interface ReconcileResult {
  readonly organizations: number;
  readonly inserted: number;
  readonly statusChanged: number;
  readonly removed: number;
  /**
   * Whether the newest source observation moved since the previous pass.
   *
   * The architecture's "source high-water mark that stops advancing". False on
   * an idle system is normal and false while work is pending is not, which is
   * why the count of pending items is reported beside it rather than instead.
   */
  readonly highWaterMarkAdvanced: boolean;
  readonly pendingAcrossAll: number;
}

/**
 * Recompute every Organization's projection from the source tables.
 *
 * The whole set rather than a delta, because the cost of the aggregate is small
 * at MVP volumes and a delta would need its own notion of what changed — a
 * second derivation, which is the thing this exists to be the single copy of.
 */
export const reconcileWorkflowHealthUseCase = async (
  deps: UseCaseDependencies,
): Promise<ReconcileResult> => {
  const observedAt = deps.clock.now();

  return deps.uow.transaction(async (tx) => {
    const organizationIds = await tx.workflowHealth.organizationsToObserve();

    let inserted = 0;
    let statusChanged = 0;
    let pendingAcrossAll = 0;
    let previousHighWaterMark: Date | null = null;

    for (const organizationId of organizationIds) {
      const existing = new Map(
        (await tx.workflowHealth.readFor(organizationId)).map((row) => [
          row.workflowType,
          row,
        ]),
      );

      for (const row of existing.values()) {
        if (
          previousHighWaterMark === null ||
          row.sourceHighWaterMark > previousHighWaterMark
        ) {
          previousHighWaterMark = row.sourceHighWaterMark;
        }
      }

      const counts = await tx.workflowHealth.countsFor(organizationId);
      const rows: WorkflowHealthRow[] = [];

      for (const workflowType of WORKFLOW_TYPES) {
        const measured = counts[workflowType] ?? null;
        const { status, reasonCode } = classify(measured);
        const before = existing.get(workflowType);

        if (before === undefined) inserted += 1;
        else if (before.status !== status) statusChanged += 1;

        pendingAcrossAll += measured?.pending ?? 0;

        rows.push({
          workflowType: workflowType as WorkflowType,
          status,
          reasonCode,
          pendingCount: measured?.pending ?? 0,
          oldestPendingAt: ageToInstant(measured?.oldestPendingSeconds ?? null, observedAt),
          // Carried forward rather than recomputed: the source tables record
          // when work was attempted, not when this job looked at them, and a
          // reconcile that overwrote them with its own clock would erase the
          // only evidence of when a workflow last moved.
          lastAttemptAt: before?.lastAttemptAt ?? null,
          lastSuccessAt:
            (measured?.pending ?? 0) === 0 && (measured?.unresolvedFailures ?? 0) === 0
              ? observedAt
              : (before?.lastSuccessAt ?? null),
          consecutiveFailures:
            (measured?.unresolvedFailures ?? 0) > 0
              ? (before?.consecutiveFailures ?? 0) + 1
              : 0,
          terminalFailureCount: measured?.unresolvedFailures ?? 0,
          lastErrorCode: before?.lastErrorCode ?? null,
          sourceHighWaterMark: observedAt,
          projectionVersion: PROJECTION_VERSION,
          updatedAt: observedAt,
        });
      }

      await tx.workflowHealth.upsert(organizationId, rows);
    }

    // Organizations that no longer exist, or that the source no longer reports.
    // The foreign key already makes a cross-Organization reference impossible,
    // so this covers the other half of "duplicate rows or cross-Organization
    // references": rows outliving what they described.
    const removed = await tx.workflowHealth.removeOthers(organizationIds);

    const result: ReconcileResult = {
      organizations: organizationIds.length,
      inserted,
      statusChanged,
      removed,
      highWaterMarkAdvanced:
        previousHighWaterMark === null || observedAt > previousHighWaterMark,
      pendingAcrossAll,
    };

    // Logged at WARN when it corrected something, because a projection that
    // keeps needing correction is a defect in whatever should have kept it
    // current — and if per-transition updates are added later, a correction
    // count that stays at zero is the evidence they work.
    if (result.inserted > 0 || result.statusChanged > 0 || result.removed > 0) {
      getLogger().log({
        severity: "WARN",
        operationalLogName: "workflow_health.reconciled",
        operationalLogClass: "Worker",
        operationalLogCategory: "Operations",
        message: "The workflow-health projection needed correcting.",
        outcome: "Success",
        attributes: {
          "projection.organizations": result.organizations,
          "projection.inserted": result.inserted,
          "projection.status_changed": result.statusChanged,
          "projection.removed": result.removed,
        },
      });
    }

    return result;
  });
};

/**
 * Turn "the oldest pending item is N seconds old" back into an instant.
 *
 * The counts port reports an age because that is what the status rule needs and
 * what a live query naturally produces; the projection stores an instant because
 * an age written to a table is wrong the moment it is written.
 */
const ageToInstant = (ageSeconds: number | null, observedAt: Date): Date | null =>
  ageSeconds === null ? null : new Date(observedAt.getTime() - ageSeconds * 1000);
