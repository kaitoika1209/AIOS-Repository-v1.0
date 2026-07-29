/**
 * Work routes.
 *
 * One route per permission, exactly as ADR-0014's catalogue defines. State
 * transitions are command sub-resources (`POST /works/{id}/complete`), not a
 * `PATCH` carrying a status field, because each command has its own permission,
 * its own preconditions, and its own audit record.
 */

import {
  BadRequestException,
  Inject,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import { WorkId, type WorkStatus } from "@aios/types";
import {
  cancelWorkUseCase,
  completeWorkUseCase,
  createWorkUseCase,
  editWorkUseCase,
  getWorkUseCase,
  listWorkUseCase,
  startWorkUseCase,
  type UseCaseDependencies,
} from "@aios/application";
import type { WorkState } from "@aios/domain";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

/** The wire shape of a Work. JSON fields are camelCase (ADR-0014). */
interface WorkResponse {
  workId: string;
  title: string;
  description: string | null;
  status: WorkStatus;
  completionGate: string;
  blockedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completionSummary: string | null;
  version: number;
}

const present = (work: WorkState): WorkResponse => ({
  workId: work.workId,
  title: work.title,
  description: work.description,
  status: work.status,
  completionGate: work.completionGate.kind,
  blockedBy: work.blockingReference?.decisionId ?? null,
  startedAt: work.startedAt?.toISOString() ?? null,
  completedAt: work.completedAt?.toISOString() ?? null,
  completionSummary: work.completionSummary,
  version: work.version,
});

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required.`);
  }
  return value;
};

@Controller("works")
export class WorkController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get()
  async list(@Req() request: Request): Promise<{ items: WorkResponse[] }> {
    const items = await listWorkUseCase(this.deps, contextOf(request));
    return { items: items.map(present) };
  }

  @Get(":workId")
  async get(
    @Req() request: Request,
    @Param("workId") workId: string,
  ): Promise<WorkResponse> {
    return present(
      await getWorkUseCase(this.deps, contextOf(request), WorkId(workId)),
    );
  }

  @Post()
  async create(
    @Req() request: Request,
    @Body() body: { title?: unknown; description?: unknown },
  ): Promise<WorkResponse> {
    return present(
      await createWorkUseCase(this.deps, contextOf(request), {
        title: requireString(body.title, "title"),
        ...(typeof body.description === "string"
          ? { description: body.description }
          : {}),
      }),
    );
  }

  @Patch(":workId")
  async edit(
    @Req() request: Request,
    @Param("workId") workId: string,
    @Body() body: { title?: unknown; description?: unknown },
  ): Promise<WorkResponse> {
    // An omitted field means "leave it alone"; an explicit null clears the
    // description. Collapsing the two would make a PATCH unable to remove one.
    const changes = {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.description === null
        ? { description: null }
        : typeof body.description === "string"
          ? { description: body.description }
          : {}),
    };

    return present(
      await editWorkUseCase(this.deps, contextOf(request), WorkId(workId), changes),
    );
  }

  @Post(":workId/start")
  async start(
    @Req() request: Request,
    @Param("workId") workId: string,
  ): Promise<WorkResponse> {
    return present(
      await startWorkUseCase(this.deps, contextOf(request), WorkId(workId)),
    );
  }

  @Post(":workId/complete")
  async complete(
    @Req() request: Request,
    @Param("workId") workId: string,
    @Body() body: { completionSummary?: unknown },
  ): Promise<WorkResponse> {
    return present(
      await completeWorkUseCase(
        this.deps,
        contextOf(request),
        WorkId(workId),
        requireString(body.completionSummary, "completionSummary"),
      ),
    );
  }

  @Post(":workId/cancel")
  async cancel(
    @Req() request: Request,
    @Param("workId") workId: string,
    @Body() body: { reason?: unknown },
  ): Promise<WorkResponse> {
    return present(
      await cancelWorkUseCase(
        this.deps,
        contextOf(request),
        WorkId(workId),
        requireString(body.reason, "reason"),
      ),
    );
  }
}
