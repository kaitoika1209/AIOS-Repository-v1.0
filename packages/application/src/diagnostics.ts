/**
 * Restricted administrative diagnostics (baseline item 8, ADR-0023).
 *
 * The fourth health surface, and the only one that answers "why":
 *
 *     | Asynchronous workflow health | Are durable workflows progressing? |
 *     | Administrative diagnostic health | Why is a component or workflow unhealthy? |
 *
 * It correlates evidence across components in one response, which is the whole
 * difference from workflow health — an operator holding four separate answers
 * has to line them up by hand, at the moment they are least able to.
 *
 * Every rule the architecture attaches to this surface is enforced here rather
 * than assumed:
 *
 *   - **Organization scope, default-deny cross-Organization.** There is no
 *     parameter that selects another Organization, because there is no principal
 *     who could be authorized for one.
 *   - **No raw error text, prompts, or business content.** Failures are counted
 *     by bounded `errorCode`. Nothing here is assembled from an exception —
 *     `describeError` is not used at all, because the response is built from
 *     columns.
 *   - **Bounded reason codes rather than unbounded error text**, throughout.
 *   - **Audited**, as a privileged operational read (ADR-0022).
 *   - **Time-bounded and paginated**: a `since` window clamped to seven days,
 *     and every list capped.
 *   - **Not a probe.** It lives on the authenticated API, not the probe port,
 *     and "MUST NOT be configured as a load-balancer or restart probe."
 */

import type { OrganizationId } from "@aios/types";

import { requirePermission } from "./authorization.js";
import type { UseCaseDependencies } from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";
import {
  freshnessOf,
  type ProjectionFreshness,
  type WorkflowStatus,
  type WorkflowType,
} from "./workflow-health.js";

/**
 * How far back a diagnostic query may look.
 *
 * "apply rate limits, time bounds, and pagination to detailed queries". Seven
 * days rather than unbounded because an incident older than that is answered
 * from the audit and the logs, and an unbounded window on an operational table
 * is a full scan that the incident itself will be blamed for.
 */
export const MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_WINDOW_SECONDS = 24 * 60 * 60;

/** Every list is capped. An operator who needs more needs a different tool. */
export const MAX_ITEMS = 50;

export interface DiagnosticsQuery {
  /** Seconds to look back. Clamped, never rejected — a wide window is not an error. */
  readonly windowSeconds?: number;
}

/** One bounded error class and how often it occurred. Never a message. */
export interface ErrorCodeCount {
  readonly errorCode: string;
  readonly count: number;
}

export interface OutboxDiagnostics {
  readonly pending: number;
  readonly failed: number;
  /**
   * Rows claimed by a Worker whose lease has expired.
   *
   * The condition that looks like nothing and is the reason work stops: the row
   * is not `Pending`, so nothing claims it, and not `Published`, so nothing
   * completed it.
   */
  readonly claimExpired: number;
  readonly oldestPendingSeconds: number | null;
  readonly errorCodes: readonly ErrorCodeCount[];
}

export interface DeliveryDiagnostics {
  readonly processing: number;
  readonly failed: number;
  /**
   * Ordering keys blocked behind a failure.
   *
   * Every later event on a blocked key waits, so one poison message can stop a
   * stream indefinitely while every count above looks small.
   */
  readonly blockedOrderingKeys: number;
  readonly deadLettersByStatus: Readonly<Record<string, number>>;
  readonly errorCodes: readonly ErrorCodeCount[];
}

export interface GenerationDiagnostics {
  readonly byStatus: Readonly<Record<string, number>>;
  /**
   * Operations claimed by a Worker whose lease has expired.
   *
   * The generation counterpart of `OutboxDiagnostics.claimExpired`, and the
   * honest answer to "why is nothing generating": a `Generating` row nobody owns
   * is invisible to every count that looks at status alone.
   *
   * Note what is deliberately not here: a retry-exhaustion count. Generation
   * bounds retries by making `Failed` terminal rather than by counting attempts,
   * so `byStatus.Failed` already is the exhausted set — a second field would be
   * the same number under a name that implied a ceiling that does not exist.
   */
  readonly leaseExpired: number;
  readonly oldestPendingSeconds: number | null;
  readonly errorCodes: readonly ErrorCodeCount[];
}

export interface PauseDiagnostics {
  readonly workerType: string;
  readonly pausedAtSeconds: number;
  readonly reasonCode: string;
}

export interface WorkflowDiagnostics {
  readonly workflowType: WorkflowType;
  readonly status: WorkflowStatus;
  readonly pending: number;
  readonly oldestPendingSeconds: number | null;
  readonly consecutiveFailures: number;
  readonly terminalFailures: number;
}

export interface DiagnosticsReport {
  readonly organizationId: OrganizationId;
  readonly observedAt: Date;
  readonly windowSeconds: number;
  readonly projection: ProjectionFreshness;
  readonly workflows: readonly WorkflowDiagnostics[];
  readonly outbox: OutboxDiagnostics;
  readonly deliveries: DeliveryDiagnostics;
  readonly generation: GenerationDiagnostics;
  readonly pauses: readonly PauseDiagnostics[];
  /** The migration this process's schema is at, so two replicas can be compared. */
  readonly schemaVersion: string | null;
}

/** The raw figures the store gathers, before any shaping. */
export interface DiagnosticsFacts {
  readonly outbox: OutboxDiagnostics;
  readonly deliveries: DeliveryDiagnostics;
  readonly generation: GenerationDiagnostics;
  readonly schemaVersion: string | null;
}

const clampWindow = (requested: number | undefined): number => {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_WINDOW_SECONDS;
  }
  return Math.min(MAX_WINDOW_SECONDS, Math.max(60, Math.floor(requested)));
};

const secondsSince = (from: Date | null, now: Date): number | null =>
  from === null ? null : Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));

/**
 * Correlate what is known about this Organization's asynchronous processing.
 *
 * Owner-only. The architecture requires "an authenticated operator with an
 * explicit operational role" for this surface specifically, and the MVP models
 * no operational role — so it is granted to the narrowest role that exists
 * rather than to one invented for it. ADR-0023 records that as a narrowing, not
 * as a claim that the role exists.
 */
export const readDiagnosticsUseCase = async (
  deps: UseCaseDependencies,
  context: WorkCommandContext,
  query: DiagnosticsQuery = {},
): Promise<DiagnosticsReport> => {
  requirePermission(context.principal, "operations.read_diagnostics");

  const windowSeconds = clampWindow(query.windowSeconds);
  const since = new Date(context.now.getTime() - windowSeconds * 1000);

  // One transaction, because correlation is the point. Read across several, an
  // operator would be comparing an Outbox from one instant with a projection
  // from another and reasoning about the difference between them.
  const { rows, pauses, facts } = await deps.uow.transaction(async (tx) => ({
    rows: await tx.workflowHealth.readFor(context.organizationId),
    pauses: await tx.workerPauses.listFor(context.organizationId),
    facts: await tx.diagnostics.gather(context.organizationId, since, MAX_ITEMS),
  }));

  const newest = rows.reduce<(typeof rows)[number] | null>(
    (latest, row) => (latest === null || row.updatedAt > latest.updatedAt ? row : latest),
    null,
  );

  return {
    organizationId: context.organizationId,
    observedAt: context.now,
    windowSeconds,
    projection: freshnessOf(
      newest?.updatedAt ?? null,
      newest?.sourceHighWaterMark ?? null,
      newest?.projectionVersion ?? null,
      context.now,
    ),
    workflows: rows.map((row) => ({
      workflowType: row.workflowType,
      status: row.status,
      pending: row.pendingCount,
      oldestPendingSeconds: secondsSince(row.oldestPendingAt, context.now),
      consecutiveFailures: row.consecutiveFailures,
      terminalFailures: row.terminalFailureCount,
    })),
    outbox: facts.outbox,
    deliveries: facts.deliveries,
    generation: facts.generation,
    pauses: pauses.map((pause) => ({
      workerType: pause.workerType,
      pausedAtSeconds: secondsSince(pause.pausedAt, context.now) ?? 0,
      // The code, not the free-text reason. The reason is an operator's own
      // words and belongs where an operator reads it; a diagnostic response is a
      // surface the architecture requires to use "stable bounded reason codes
      // rather than unbounded error text", and it does not get to make an
      // exception for text it happens to trust.
      reasonCode: pause.reasonCode,
    })),
    schemaVersion: facts.schemaVersion,
  };
};
