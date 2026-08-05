/**
 * Administrative Worker pause and resume (ADR-0022).
 *
 * `/admin` is a grouping, not a privilege boundary — the same guard, the same
 * permission mechanism, the same Organization scope as every other route. A
 * pause taken here suspends claiming for the caller's Organization and no other,
 * which is what makes the permission holdable through a Membership at all.
 *
 * The global pause is deliberately not here. It has no principal in the MVP, so
 * it is deployment configuration (`WORKER_PAUSED_TYPES`) rather than a route.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import {
  PAUSABLE_WORKER_TYPES,
  isPausableWorkerType,
  pauseWorkerUseCase,
  resumeWorkerUseCase,
  type PausableWorkerType,
  type UseCaseDependencies,
} from "@aios/application";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

interface PauseResponse {
  workerType: PausableWorkerType;
  pausedAt: string;
  reasonCode: string;
  reason: string;
}

/**
 * Rejected at the edge, before the handler.
 *
 * The message names the closed set because it is a fixed vocabulary rather than
 * an identifier — an operator who typed `MemoryGenerator` needs to be told what
 * the names are, and nothing here is a hint about another tenant's data.
 */
const requireWorkerType = (value: string): PausableWorkerType => {
  if (!isPausableWorkerType(value)) {
    throw new BadRequestException(
      `workerType must be one of: ${PAUSABLE_WORKER_TYPES.join(", ")}.`,
    );
  }
  return value;
};

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required.`);
  }
  return value;
};

@Controller("admin/workers")
export class WorkersController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  /**
   * Suspend a Worker type's claiming for this Organization.
   *
   * `reason` is required rather than optional, matching `events.skip`. A pause
   * with no stated cause is a pause nobody else can safely lift.
   */
  @Post(":workerType/pause")
  async pause(
    @Req() request: Request,
    @Param("workerType") workerType: string,
    @Body() body: { reasonCode?: unknown; reason?: unknown },
  ): Promise<PauseResponse> {
    const pause = await pauseWorkerUseCase(this.deps, contextOf(request), {
      workerType: requireWorkerType(workerType),
      reasonCode: requireText(body.reasonCode, "reasonCode"),
      reason: requireText(body.reason, "reason"),
    });

    // The pause in force, which is not necessarily the one this request
    // described: pausing an already-paused Worker keeps the original reason.
    return {
      workerType: pause.workerType,
      pausedAt: pause.pausedAt.toISOString(),
      reasonCode: pause.reasonCode,
      reason: pause.reason,
    };
  }

  /**
   * Lift the pause.
   *
   * Resuming a Worker that is not paused reports `resumed: false` rather than
   * `404`. An operator restoring service should not have to work out whether
   * someone else already lifted it — the state they wanted is the state they
   * have.
   */
  @Post(":workerType/resume")
  async resume(
    @Req() request: Request,
    @Param("workerType") workerType: string,
  ): Promise<{ resumed: boolean }> {
    return resumeWorkerUseCase(
      this.deps,
      contextOf(request),
      requireWorkerType(workerType),
    );
  }
}
