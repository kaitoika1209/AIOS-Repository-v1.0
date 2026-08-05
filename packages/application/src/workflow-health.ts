/**
 * Asynchronous workflow health (baseline item 8, ADR-0021 and ADR-0023).
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
 *
 * Read from the `organization_workflow_health` projection rather than derived
 * live (ADR-0023), and the answer carries the projection's own freshness. There
 * is deliberately **no fallback to a live query when the projection is stale**:
 * the architecture says "When the projection becomes `Stale`, operators must not
 * infer that Organizations are `Healthy`", and a fallback would hide exactly the
 * failure the freshness field exists to expose — most reliably at the moment it
 * mattered most.
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
 *
 * The observability architecture introduces its own list with "MVP workflow
 * types **include**" — an open list — naming `OutboxRelay`, `MemoryGeneration`,
 * `Projection`, and `Reconciliation`. `OutboxPublication` is its `OutboxRelay`
 * under ADR-0021's name. The other two are absent because they are not workflows
 * here: the notification projection has no claim loop of its own, and
 * reconciliation is this build's own scheduled job rather than tenant work that
 * can back up. A status for a workflow that does not exist would always read
 * `NoData`, which is noise shaped like information.
 */
export const WORKFLOW_TYPES = [
  "OutboxPublication",
  "ConsumerDelivery",
  "DeadLetter",
  "MemoryGeneration",
] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

/**
 * The architecture's status vocabulary, plus `Unknown` (ADR-0023).
 *
 * ADR-0021 used `Critical` for what the architecture calls `Blocked`, and had no
 * `Stale` or `NoData`. ADR-0023 resolved that in the architecture's favour,
 * because item 11's alerts are written against these names — "a new **Blocked**
 * transition creates a High alert", "any **Stale** projection beyond two refresh
 * intervals creates a High alert" — and a translation layer between an alert rule
 * and the status it fires on is where alerts silently stop firing.
 *
 * `Unknown` is kept because the other five cannot express it. `Stale` says the
 * projection is behind and `NoData` says there is nothing to report; neither says
 * *the query did not run*. Collapsing that into either would present a failure to
 * measure as a measurement.
 */
export type WorkflowStatus =
  | "Healthy"
  | "Degraded"
  | "Blocked"
  | "Stale"
  | "NoData"
  | "Unknown";

export type WorkflowReasonCode =
  | "OK"
  | "PENDING_OVER_THRESHOLD"
  | "UNRESOLVED_FAILURE"
  | "QUERY_FAILED"
  | "PROJECTION_STALE"
  | "NOT_OBSERVED";

export interface WorkflowHealth {
  readonly workflowType: WorkflowType;
  readonly status: WorkflowStatus;
  /** Items committed and not yet finished. */
  readonly pending: number;
  /** How long the oldest of them has been waiting. Null when there are none. */
  readonly oldestPendingSeconds: number | null;
  /** Failures that will not resolve without a person. */
  readonly terminalFailures: number;
  /** A bounded code, never free text — the same rule the diagnostic surface has. */
  readonly reasonCode: WorkflowReasonCode;
  /**
   * Whether an operator has administratively paused this workflow (ADR-0022).
   *
   * Reported alongside the status rather than folded into it. A paused workflow
   * accumulates a backlog and its status honestly says so — "is committed work
   * progressing within policy" is answered `no` whether the cause is a fault or
   * a decision. This field says which, so an operator reading `Blocked` can see
   * that they are looking at their own containment rather than a new incident.
   *
   * Always `false` for the workflow types that cannot be paused.
   */
  readonly paused: boolean;
}

/**
 * How current the projection is, reported with every answer.
 *
 * Not an afterthought: it is the reason the projection is better than the live
 * query it replaced. A live query is always current, which sounds like an
 * advantage and is why the failure it lacks — no answer at all — was invisible.
 */
export interface ProjectionFreshness {
  /** Seconds since the projection last wrote. Null before its first reconcile. */
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  /** How old it may be before it is `Stale`. */
  readonly staleAfterSeconds: number;
  /** The instant the last reconcile observed, which is not when it wrote. */
  readonly sourceHighWaterMark: Date | null;
  readonly projectionVersion: number | null;
}

export interface WorkflowHealthReport {
  readonly organizationId: OrganizationId;
  readonly observedAt: Date;
  /** The worst of the four, so one number can drive an alert. */
  readonly status: WorkflowStatus;
  readonly freshness: ProjectionFreshness;
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
export const BLOCKED_AFTER_SECONDS = 1800;

/**
 * How stale the projection may be before its answers stop being trusted.
 *
 * Two reconcile intervals, matching the architecture's alert rule — "any Stale
 * projection beyond two refresh intervals creates a High alert" — so the status
 * and the alert change at the same moment rather than one leading the other.
 */
export const RECONCILE_INTERVAL_SECONDS = 30;
export const STALE_AFTER_SECONDS = RECONCILE_INTERVAL_SECONDS * 2;

/**
 * The derivation's version, not the row's.
 *
 * Bumped when thresholds or the meaning of a status changes, because that makes
 * previously written rows incomparable and something has to say so. It does not
 * change historical source records, which the architecture forbids.
 */
export const PROJECTION_VERSION = 1;

/** The counts one workflow's table yields. Null means the query did not answer. */
export interface WorkflowCounts {
  readonly pending: number;
  readonly oldestPendingSeconds: number | null;
  /** Failures that will not resolve without a person. */
  readonly unresolvedFailures: number;
}

const RANK: Record<WorkflowStatus, number> = {
  Healthy: 0,
  NoData: 1,
  Degraded: 2,
  Stale: 3,
  Unknown: 4,
  Blocked: 5,
};

/**
 * Turn counts into a status.
 *
 * Pure, so the thresholds can be tested without a database — the rule is the
 * part worth getting right, and it is the part a query cannot check.
 */
export interface Classification {
  readonly status: WorkflowStatus;
  readonly reasonCode: WorkflowReasonCode;
}

export const classify = (counts: WorkflowCounts | null): Classification => {
  if (counts === null) return { status: "Unknown", reasonCode: "QUERY_FAILED" };

  // An unresolved failure outranks age. A dead letter that arrived a second ago
  // is already a thing a person has to decide about; waiting five minutes to say
  // so would only delay the decision.
  if (counts.unresolvedFailures > 0) {
    return { status: "Blocked", reasonCode: "UNRESOLVED_FAILURE" };
  }

  const age = counts.oldestPendingSeconds;
  if (age === null) return { status: "Healthy", reasonCode: "OK" };
  if (age >= BLOCKED_AFTER_SECONDS) {
    return { status: "Blocked", reasonCode: "PENDING_OVER_THRESHOLD" };
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
 * Whether the projection's last write is too old to be trusted.
 *
 * Derived at read time rather than stored, because a projection that has stopped
 * refreshing cannot write its own staleness — which is the exact case the status
 * exists for.
 */
export const freshnessOf = (
  updatedAt: Date | null,
  sourceHighWaterMark: Date | null,
  projectionVersion: number | null,
  now: Date,
): ProjectionFreshness => {
  const ageSeconds =
    updatedAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / 1000));

  return {
    ageSeconds,
    // Never reconciled is not stale — it is `NoData`, which the per-workflow
    // status reports. Calling it stale would say the projection stopped when it
    // has not started.
    stale: ageSeconds !== null && ageSeconds > STALE_AFTER_SECONDS,
    staleAfterSeconds: STALE_AFTER_SECONDS,
    sourceHighWaterMark,
    projectionVersion,
  };
};

/** One projection row, as the store returns it. */
export interface WorkflowHealthRow {
  readonly workflowType: WorkflowType;
  readonly status: WorkflowStatus;
  readonly reasonCode: WorkflowReasonCode;
  readonly pendingCount: number;
  readonly oldestPendingAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly consecutiveFailures: number;
  readonly terminalFailureCount: number;
  readonly lastErrorCode: string | null;
  readonly sourceHighWaterMark: Date;
  readonly projectionVersion: number;
  readonly updatedAt: Date;
}

const secondsBetween = (from: Date | null, to: Date): number | null =>
  from === null ? null : Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));

/**
 * Read the Organization's asynchronous workflow health.
 *
 * A read, and audited like every other routed permission — ADR-0022 made that
 * true rather than merely claimed. A privileged operational read leaves the same
 * trace as a privileged operational write, which is what the architecture
 * requires of the diagnostic surface and costs nothing to apply here.
 */
export const readWorkflowHealthUseCase = async (
  deps: UseCaseDependencies,
  context: WorkCommandContext,
): Promise<WorkflowHealthReport> => {
  requirePermission(context.principal, "operations.read_workflow_health");

  // One transaction for both, so the pauses an operator reads are the pauses
  // that were in force when the projection was read. Read separately, a resume
  // landing in between would produce a report showing a backlog with no
  // explanation for it.
  const { rows, pauses } = await deps.uow.transaction(async (tx) => ({
    rows: await tx.workflowHealth.readFor(context.organizationId),
    pauses: await tx.workerPauses.listFor(context.organizationId),
  }));

  const byType = new Map(rows.map((row) => [row.workflowType, row]));
  const paused = new Set<string>(pauses.map((p) => p.workerType));

  // Every row was written by the same reconcile, so any one of them dates the
  // projection. Taking the newest is deliberate: it is the most favourable
  // reading, and staleness reported on the most favourable reading is staleness
  // nobody can argue with.
  const newest = rows.reduce<WorkflowHealthRow | null>(
    (latest, row) =>
      latest === null || row.updatedAt > latest.updatedAt ? row : latest,
    null,
  );

  const freshness = freshnessOf(
    newest?.updatedAt ?? null,
    newest?.sourceHighWaterMark ?? null,
    newest?.projectionVersion ?? null,
    context.now,
  );

  const workflows = WORKFLOW_TYPES.map((workflowType): WorkflowHealth => {
    const row = byType.get(workflowType);

    // No row means the reconcile has never observed this workflow for this
    // Organization. Reported as `NoData` rather than `Healthy`: "Missing
    // evidence MUST NOT be presented as `Healthy`."
    if (row === undefined) {
      return {
        workflowType,
        status: "NoData",
        pending: 0,
        oldestPendingSeconds: null,
        terminalFailures: 0,
        reasonCode: "NOT_OBSERVED",
        paused: paused.has(workflowType),
      };
    }

    return {
      workflowType,
      // Staleness overrides whatever the row says, because what the row says is
      // what was true when it was written. A stale `Healthy` is the single most
      // misleading thing this surface could report.
      status: freshness.stale ? "Stale" : row.status,
      pending: row.pendingCount,
      oldestPendingSeconds: secondsBetween(row.oldestPendingAt, context.now),
      terminalFailures: row.terminalFailureCount,
      reasonCode: freshness.stale ? "PROJECTION_STALE" : row.reasonCode,
      paused: paused.has(workflowType),
    };
  });

  return {
    organizationId: context.organizationId,
    observedAt: context.now,
    status: worstOf(workflows.map((w) => w.status)),
    freshness,
    workflows,
  };
};
