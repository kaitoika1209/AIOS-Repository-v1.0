/**
 * Asynchronous workflow health (ADR-0021, baseline item 8).
 *
 * `GET /admin/workflow-health` — is committed work progressing?
 *
 * An ordinary Organization-scoped route with an ordinary permission. It claims
 * no exemption, which matters: the answer is per-Organization, and the
 * architecture notes that "Global metrics can remain healthy while one
 * Organization is permanently blocked". A route that aggregated across tenants
 * would answer the wrong question and break isolation doing it.
 *
 * Separate from `AdminEventsController` because that one acts on a specific
 * failed delivery and this one observes whether anything is moving at all —
 * which is why ADR-0021 promoted a permission rather than reusing
 * `events.inspect_failed`.
 */

import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { Request } from "express";

import {
  readWorkflowHealthUseCase,
  type UseCaseDependencies,
  type WorkflowHealthReport,
} from "@aios/application";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

interface WorkflowHealthResponse {
  organizationId: string;
  observedAt: string;
  status: WorkflowHealthReport["status"];
  /**
   * How current the projection is (ADR-0023).
   *
   * Part of the answer rather than metadata beside it. A projection that has
   * stopped refreshing reports `Stale` per workflow *and* the age here, so an
   * operator can see both that the numbers are untrustworthy and by how much.
   */
  freshness: {
    ageSeconds: number | null;
    stale: boolean;
    staleAfterSeconds: number;
    sourceHighWaterMark: string | null;
    projectionVersion: number | null;
  };
  workflows: {
    workflowType: string;
    status: string;
    pending: number;
    oldestPendingSeconds: number | null;
    terminalFailures: number;
    reasonCode: string;
    paused: boolean;
  }[];
}

@Controller("admin/workflow-health")
export class WorkflowHealthController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get()
  async read(@Req() request: Request): Promise<WorkflowHealthResponse> {
    const report = await readWorkflowHealthUseCase(this.deps, contextOf(request));

    return {
      organizationId: report.organizationId,
      observedAt: report.observedAt.toISOString(),
      // The worst of the four, so an alert can read one field rather than
      // reimplementing the ranking.
      status: report.status,
      freshness: {
        ageSeconds: report.freshness.ageSeconds,
        stale: report.freshness.stale,
        staleAfterSeconds: report.freshness.staleAfterSeconds,
        sourceHighWaterMark:
          report.freshness.sourceHighWaterMark?.toISOString() ?? null,
        projectionVersion: report.freshness.projectionVersion,
      },
      workflows: report.workflows.map((w) => ({
        workflowType: w.workflowType,
        status: w.status,
        pending: w.pending,
        oldestPendingSeconds: w.oldestPendingSeconds,
        terminalFailures: w.terminalFailures,
        // A bounded code, never free text — the same rule the diagnostic
        // surface has, and for the same reason: unbounded error text is how
        // internals reach a caller.
        reasonCode: w.reasonCode,
        // Reported beside the status, not folded into it (ADR-0022). A paused
        // workflow really is accumulating a backlog; this says the operator
        // chose that, so `Blocked` reads as containment rather than a new
        // incident.
        paused: w.paused,
      })),
    };
  }
}
