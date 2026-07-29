/**
 * Decision routes.
 *
 * `POST /decisions/{id}/submit` is the coordinated command from ADR-0007: it
 * submits the Decision *and* blocks the related Work in one transaction, so the
 * response carries both.
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

import { DecisionId, WorkId, type DecisionStatus } from "@aios/types";
import {
  approveDecisionUseCase,
  createDecisionUseCase,
  editDecisionDraftUseCase,
  listDecisionsForWorkUseCase,
  rejectDecisionUseCase,
  startRevisionUseCase,
  submitBlockingDecisionUseCase,
  withdrawDecisionUseCase,
  type UseCaseDependencies,
} from "@aios/application";
import { currentRevision, submittedRevision, type DecisionState } from "@aios/domain";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

interface DecisionResponse {
  decisionId: string;
  relatedWorkId: string;
  status: DecisionStatus;
  isBlocking: boolean;
  revisionNumber: number;
  submittedSnapshotId: string | null;
  question: string;
  options: { optionId: string; summary: string }[];
  reviewHistory: {
    revisionNumber: number;
    outcome: string;
    rationale: string;
    selectedOptionId: string | null;
    reviewedAt: string;
  }[];
  version: number;
}

const present = (decision: DecisionState): DecisionResponse => {
  // The revision a caller cares about is the editable one when it exists, and
  // otherwise the one under or after review.
  const visible =
    currentRevision(decision) ??
    submittedRevision(decision) ??
    decision.revisions[decision.revisions.length - 1];

  return {
    decisionId: decision.decisionId,
    relatedWorkId: decision.relatedWorkId,
    status: decision.status,
    isBlocking: decision.isBlocking,
    revisionNumber: visible?.revisionNumber ?? 1,
    submittedSnapshotId: decision.submittedRevisionId,
    question: visible?.question ?? "",
    options: (visible?.options ?? []).map((o) => ({
      optionId: o.optionId,
      summary: o.summary,
    })),
    reviewHistory: decision.reviewRecords.map((r) => ({
      revisionNumber: r.revisionNumber,
      outcome: r.outcome,
      rationale: r.rationale,
      selectedOptionId: r.selectedOptionId,
      reviewedAt: r.reviewedAt.toISOString(),
    })),
    version: decision.version,
  };
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required.`);
  }
  return value;
};

@Controller("decisions")
export class DecisionController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get("by-work/:workId")
  async listForWork(
    @Req() request: Request,
    @Param("workId") workId: string,
  ): Promise<{ items: DecisionResponse[] }> {
    const items = await listDecisionsForWorkUseCase(
      this.deps,
      contextOf(request),
      WorkId(workId),
    );
    return { items: items.map(present) };
  }

  @Post()
  async create(
    @Req() request: Request,
    @Body()
    body: {
      relatedWorkId?: unknown;
      title?: unknown;
      question?: unknown;
      context?: unknown;
      options?: unknown;
      isBlocking?: unknown;
    },
  ): Promise<DecisionResponse> {
    const options = Array.isArray(body.options)
      ? body.options.map((o: { optionId?: unknown; summary?: unknown }) => ({
          optionId: requireString(o?.optionId, "options[].optionId"),
          summary: requireString(o?.summary, "options[].summary"),
        }))
      : [];

    return present(
      await createDecisionUseCase(this.deps, contextOf(request), {
        relatedWorkId: WorkId(requireString(body.relatedWorkId, "relatedWorkId")),
        title: requireString(body.title, "title"),
        question: requireString(body.question, "question"),
        options,
        ...(typeof body.context === "string" ? { context: body.context } : {}),
        ...(typeof body.isBlocking === "boolean"
          ? { isBlocking: body.isBlocking }
          : {}),
      }),
    );
  }

  @Patch(":decisionId")
  async edit(
    @Req() request: Request,
    @Param("decisionId") decisionId: string,
    @Body()
    body: {
      title?: unknown;
      question?: unknown;
      context?: unknown;
      options?: unknown;
    },
  ): Promise<DecisionResponse> {
    const changes = {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.question === "string" ? { question: body.question } : {}),
      ...(body.context === null
        ? { context: null }
        : typeof body.context === "string"
          ? { context: body.context }
          : {}),
      ...(Array.isArray(body.options)
        ? {
            options: body.options.map(
              (o: { optionId?: unknown; summary?: unknown }) => ({
                optionId: requireString(o?.optionId, "options[].optionId"),
                summary: requireString(o?.summary, "options[].summary"),
              }),
            ),
          }
        : {}),
    };

    return present(
      await editDecisionDraftUseCase(
        this.deps,
        contextOf(request),
        DecisionId(decisionId),
        changes,
      ),
    );
  }

  /** Submits the Decision and blocks the related Work atomically (ADR-0007). */
  @Post(":decisionId/submit")
  async submit(
    @Req() request: Request,
    @Param("decisionId") decisionId: string,
  ): Promise<{ decision: DecisionResponse; workStatus: string }> {
    const result = await submitBlockingDecisionUseCase(
      this.deps,
      contextOf(request),
      DecisionId(decisionId),
    );
    return { decision: present(result.decision), workStatus: result.work.status };
  }

  @Post(":decisionId/approve")
  async approve(
    @Req() request: Request,
    @Param("decisionId") decisionId: string,
    @Body() body: { selectedOptionId?: unknown; rationale?: unknown },
  ): Promise<DecisionResponse> {
    return present(
      await approveDecisionUseCase(
        this.deps,
        contextOf(request),
        DecisionId(decisionId),
        {
          selectedOptionId: requireString(body.selectedOptionId, "selectedOptionId"),
          rationale: requireString(body.rationale, "rationale"),
        },
      ),
    );
  }

  @Post(":decisionId/reject")
  async reject(
    @Req() request: Request,
    @Param("decisionId") decisionId: string,
    @Body() body: { rationale?: unknown },
  ): Promise<DecisionResponse> {
    return present(
      await rejectDecisionUseCase(
        this.deps,
        contextOf(request),
        DecisionId(decisionId),
        requireString(body.rationale, "rationale"),
      ),
    );
  }

  @Post(":decisionId/withdraw")
  async withdraw(
    @Req() request: Request,
    @Param("decisionId") decisionId: string,
    @Body() body: { reason?: unknown },
  ): Promise<DecisionResponse> {
    return present(
      await withdrawDecisionUseCase(
        this.deps,
        contextOf(request),
        DecisionId(decisionId),
        requireString(body.reason, "reason"),
      ),
    );
  }

  @Post(":decisionId/revisions")
  async startRevision(
    @Req() request: Request,
    @Param("decisionId") decisionId: string,
  ): Promise<DecisionResponse> {
    return present(
      await startRevisionUseCase(
        this.deps,
        contextOf(request),
        DecisionId(decisionId),
      ),
    );
  }
}
