/**
 * Memory routes.
 *
 * The five commands in the ADR-0014 catalogue, plus reads. There is no route
 * that creates a Memory: generation is triggered by `WorkCompleted` through the
 * Outbox, never by a request.
 */

import { createHash } from "node:crypto";

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

import { MemoryId, WorkId, type MemoryStatus } from "@aios/types";
import {
  approveMemoryUseCase,
  currentMemoryRevision,
  editMemoryUseCase,
  getMemoryForWorkUseCase,
  getMemoryUseCase,
  listMemoriesUseCase,
  rejectMemoryUseCase,
  reopenMemoryUseCase,
  submitMemoryUseCase,
  type UseCaseDependencies,
} from "@aios/application";
import type { MemoryState } from "@aios/domain";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

interface MemoryResponse {
  memoryId: string;
  sourceWorkId: string;
  status: MemoryStatus;
  revisionNumber: number;
  title: string;
  summary: string;
  content: string;
  sourceReferences: string[];
  /** Who wrote the current draft — the Secretary for a freshly generated one. */
  authoredBy: string;
  provenance: {
    generationPolicyVersion: number;
    generatedBySystemPrincipalId: string;
    generatedAt: string;
  };
  reviewHistory: {
    revisionNumber: number;
    outcome: string;
    note: string;
    reviewedAt: string;
  }[];
  version: number;
}

const present = (memory: MemoryState): MemoryResponse => {
  const revision = currentMemoryRevision(memory);
  return {
    memoryId: memory.memoryId,
    sourceWorkId: memory.sourceWorkId,
    status: memory.status,
    revisionNumber: revision.revisionNumber,
    title: revision.title,
    summary: revision.summary,
    content: revision.content,
    sourceReferences: [...revision.sourceReferences],
    authoredBy: revision.author.actorType,
    provenance: {
      generationPolicyVersion: memory.provenance.generationPolicyVersion,
      generatedBySystemPrincipalId: memory.provenance.generatedBySystemPrincipalId,
      generatedAt: memory.provenance.generatedAt.toISOString(),
    },
    reviewHistory: memory.reviewRecords.map((r) => ({
      revisionNumber: r.revisionNumber,
      outcome: r.outcome,
      note: r.note,
      reviewedAt: r.reviewedAt.toISOString(),
    })),
    version: memory.version,
  };
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required.`);
  }
  return value;
};

@Controller("memories")
export class MemoryController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get()
  async list(@Req() request: Request): Promise<{ items: MemoryResponse[] }> {
    const items = await listMemoriesUseCase(this.deps, contextOf(request));
    return { items: items.map(present) };
  }

  @Get("by-work/:workId")
  async forWork(
    @Req() request: Request,
    @Param("workId") workId: string,
    // Wrapped rather than returned bare: a bare `null` serializes to an empty
    // body, which a JSON client cannot parse. "No Memory yet" is a normal
    // answer here, not an error, so it needs a representable shape.
  ): Promise<{ memory: MemoryResponse | null }> {
    const memory = await getMemoryForWorkUseCase(
      this.deps,
      contextOf(request),
      WorkId(workId),
    );
    return { memory: memory === null ? null : present(memory) };
  }

  @Get(":memoryId")
  async get(
    @Req() request: Request,
    @Param("memoryId") memoryId: string,
  ): Promise<MemoryResponse> {
    return present(
      await getMemoryUseCase(this.deps, contextOf(request), MemoryId(memoryId)),
    );
  }

  @Patch(":memoryId")
  async edit(
    @Req() request: Request,
    @Param("memoryId") memoryId: string,
    @Body() body: { title?: unknown; summary?: unknown; content?: unknown },
  ): Promise<MemoryResponse> {
    const changes = {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
      ...(typeof body.content === "string" ? { content: body.content } : {}),
    };

    // The hash covers what a reviewer will read, so it is recomputed from the
    // corrected content rather than carried over from generation.
    const hash = createHash("sha256")
      .update(JSON.stringify(changes))
      .digest("hex");

    return present(
      await editMemoryUseCase(
        this.deps,
        contextOf(request),
        MemoryId(memoryId),
        changes,
        hash,
      ),
    );
  }

  @Post(":memoryId/submit")
  async submit(
    @Req() request: Request,
    @Param("memoryId") memoryId: string,
  ): Promise<MemoryResponse> {
    return present(
      await submitMemoryUseCase(this.deps, contextOf(request), MemoryId(memoryId)),
    );
  }

  @Post(":memoryId/approve")
  async approve(
    @Req() request: Request,
    @Param("memoryId") memoryId: string,
    @Body() body: { note?: unknown },
  ): Promise<MemoryResponse> {
    return present(
      await approveMemoryUseCase(
        this.deps,
        contextOf(request),
        MemoryId(memoryId),
        typeof body.note === "string" ? body.note : "",
      ),
    );
  }

  @Post(":memoryId/reject")
  async reject(
    @Req() request: Request,
    @Param("memoryId") memoryId: string,
    @Body() body: { note?: unknown },
  ): Promise<MemoryResponse> {
    return present(
      await rejectMemoryUseCase(
        this.deps,
        contextOf(request),
        MemoryId(memoryId),
        requireString(body.note, "note"),
      ),
    );
  }

  @Post(":memoryId/reopen")
  async reopen(
    @Req() request: Request,
    @Param("memoryId") memoryId: string,
  ): Promise<MemoryResponse> {
    return present(
      await reopenMemoryUseCase(this.deps, contextOf(request), MemoryId(memoryId)),
    );
  }
}
