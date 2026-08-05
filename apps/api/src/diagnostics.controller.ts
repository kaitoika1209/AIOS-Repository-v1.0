/**
 * Restricted administrative diagnostics (ADR-0023, baseline item 8).
 *
 * `GET /admin/diagnostics` — why is a component or workflow unhealthy?
 *
 * Distinct from `GET /admin/workflow-health`, which answers whether work is
 * progressing. This answers why not, by correlating the Outbox, consumer
 * deliveries, dead letters, generation attempts, administrative pauses, and the
 * projection's own freshness in one response — because an operator holding six
 * separate answers has to line them up by hand at the worst possible moment.
 *
 * Owner-only, and Organization-scoped like every other route. The architecture
 * requires "an authenticated operator with an explicit operational role"; the MVP
 * models no operational role, so this is granted to the narrowest role that
 * exists rather than to one invented for it.
 *
 * It is **not a probe**, and the architecture says so directly: it "MUST NOT be
 * configured as a load-balancer or restart probe". Being on the authenticated API
 * rather than the probe port is what makes that structural — an orchestrator has
 * no credential to call it with.
 */

import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import type { Request } from "express";

import {
  readDiagnosticsUseCase,
  type DiagnosticsReport,
  type UseCaseDependencies,
} from "@aios/application";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

/**
 * Parsed, never validated into a rejection.
 *
 * A malformed or absurd window becomes the default and the clamp respectively.
 * An operator mid-incident should not have a query refused over a query string;
 * the response reports the window it actually used, which is the honest form of
 * accepting it.
 */
const windowFrom = (raw: unknown): number | undefined => {
  if (typeof raw !== "string") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

@Controller("admin/diagnostics")
export class DiagnosticsController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get()
  async read(
    @Req() request: Request,
    @Query("windowSeconds") windowSeconds?: string,
  ): Promise<DiagnosticsReport> {
    const report = await readDiagnosticsUseCase(this.deps, contextOf(request), {
      ...(windowFrom(windowSeconds) === undefined
        ? {}
        : { windowSeconds: windowFrom(windowSeconds)! }),
    });

    // Returned as assembled. Every field is a count, an age, a bounded code, or
    // an identifier the caller already supplied — there is nothing here to
    // redact, which is the property the use case and the SQL behind it are
    // written to preserve rather than something this layer restores.
    return report;
  }
}
