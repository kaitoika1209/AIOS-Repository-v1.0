/**
 * Asynchronous workflow health (baseline item 8, ADR-0021).
 *
 * Answers a question the process probes cannot: are committed workflows
 * progressing? The architecture draws the line —
 *
 *     Worker readiness does not prove progress. A Worker can be ready yet make
 *     no useful progress because of poison events, lock contention, repeated
 *     retries, or per-Organization ordering blocks.
 *
 * — so a green liveness and a green readiness are compatible with nothing having
 * moved for an hour. This is what makes that visible.
 *
 * Scoped to one Organization, always. "Global metrics can remain healthy while
 * one Organization is permanently blocked" is the reason the projection exists
 * in the architecture at all, and a route that aggregated across tenants would
 * answer the wrong question and break isolation doing it.
 */

import type { OrganizationId } from "@aios/types";

import { requirePermission } from "./authorization.js";
import type { UseCaseDependencies } from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

/**
 * The four asynchronous workflows a committed transaction can be waiting on.
 *
 * A closed set: each maps to one durable table, and one invented at a call site
 * would be a status nothing derives.
 */
export const WORKFLOW_TYPES = [
  "OutboxPublication",
  "ConsumerDelivery",
  "DeadLetter",
  "MemoryGeneration",
] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

/**
 * `Unknown` is a real outcome, not a placeholder.
 *
 * "Missing evidence MUST NOT be presented as `Healthy`." A workflow whose query
 * failed is reported as `Unknown` rather than omitted, because an operator
 * reading a list of three healthy workflows would reasonably conclude the fourth
 * was fine.
 */
export type WorkflowStatus = "Healthy" | "Degraded" | "Critical" | "Unknown";

export interface WorkflowHealth {
  readonly workflowType: WorkflowType;
  readonly status: WorkflowStatus;
  /** Items committed and not yet finished. */
  readonly pending: number;
  /** How long the oldest of them has been waiting. Null when there are none. */
  readonly oldestPendingSeconds: number | null;
  /** A bounded code, never free text — the same rule the diagnostic surface has. */
  readonly reasonCode: "OK" | "PENDING_OVER_THRESHOLD" | "UNRESOLVED_FAILURE" | "QUERY_FAILED";
}

export interface WorkflowHealthReport {
  readonly organizationId: OrganizationId;
  readonly observedAt: Date;
  /** The worst of the four, so one number can drive an alert. */
  readonly status: WorkflowStatus;
  readonly workflows: readonly WorkflowHealth[];
}

/**
 * How long a pending item may wait before it is a problem.
 *
 * Age, not count, because the architecture says so: "A quiet Organization MUST
 * NOT become Degraded only because it has no recent success. Pending age,
 * unresolved failure, ordering state, and projection freshness determine
 * health." An Organization processing a hundred items promptly is healthy; one
 * with a single item stuck for two hours is not, and a count-based rule reports
 * the opposite of both.
 */
export const DEGRADED_AFTER_SECONDS = 300;
export const CRITICAL_AFTER_SECONDS = 1800;

/** The counts one workflow's table yields. Null means the query did not answer. */
export interface WorkflowCounts {
  readonly pending: number;
  readonly oldestPendingSeconds: number | null;
  /** Failures that will not resolve without a person. */
  readonly unresolvedFailures: number;
}

const RANK: Record<WorkflowStatus, number> = {
  Healthy: 0,
  Degraded: 1,
  Unknown: 2,
  Critical: 3,
};

/**
 * Turn counts into a status.
 *
 * Pure, so the thresholds can be tested without a database — the rule is the
 * part worth getting right, and it is the part a query cannot check.
 */
export interface Classification {
  readonly status: WorkflowStatus;
  readonly reasonCode: WorkflowHealth["reasonCode"];
}

export const classify = (counts: WorkflowCounts | null): Classification => {
  if (counts === null) return { status: "Unknown", reasonCode: "QUERY_FAILED" };

  // An unresolved failure outranks age. A dead letter that arrived a second ago
  // is already a thing a person has to decide about; waiting five minutes to say
  // so would only delay the decision.
  if (counts.unresolvedFailures > 0) {
    return { status: "Critical", reasonCode: "UNRESOLVED_FAILURE" };
  }

  const age = counts.oldestPendingSeconds;
  if (age === null) return { status: "Healthy", reasonCode: "OK" };
  if (age >= CRITICAL_AFTER_SECONDS) {
    return { status: "Critical", reasonCode: "PENDING_OVER_THRESHOLD" };
  }
  if (age >= DEGRADED_AFTER_SECONDS) {
    return { status: "Degraded", reasonCode: "PENDING_OVER_THRESHOLD" };
  }
  return { status: "Healthy", reasonCode: "OK" };
};

/** The worst of several statuses, which is what an alert should read. */
export const worstOf = (statuses: readonly WorkflowStatus[]): WorkflowStatus =>
  statuses.reduce<WorkflowStatus>(
    (worst, s) => (RANK[s] > RANK[worst] ? s : worst),
    "Healthy",
  );

/**
 * Read the Organization's asynchronous workflow health.
 *
 * A read, and audited like every other routed permission. A privileged
 * operational read leaves the same trace as a privileged operational write,
 * which is what the architecture requires of the diagnostic surface and costs
 * nothing to apply here.
 */
export const readWorkflowHealthUseCase = async (
  deps: UseCaseDependencies,
  context: WorkCommandContext,
): Promise<WorkflowHealthReport> => {
  requirePermission(context.principal, "operations.read_workflow_health");

  const counts = await deps.uow.transaction((tx) =>
    tx.workflowHealth.countsFor(context.organizationId),
  );

  const workflows = WORKFLOW_TYPES.map((workflowType): WorkflowHealth => {
    const measured = counts[workflowType] ?? null;
    const { status, reasonCode } = classify(measured);
    return {
      workflowType,
      status,
      pending: measured?.pending ?? 0,
      oldestPendingSeconds: measured?.oldestPendingSeconds ?? null,
      reasonCode,
    };
  });

  return {
    organizationId: context.organizationId,
    observedAt: context.now,
    status: worstOf(workflows.map((w) => w.status)),
    workflows,
  };
};
