/**
 * Operational recovery routes.
 *
 * `/admin` in the path is a grouping, not a privilege boundary. These routes go
 * through the same guard as every other route and are authorized by the same
 * permission mechanism — the authorization document is explicit that platform
 * access is not Organization authority, so there is no operator back door here.
 *
 * Two distinct surfaces, and the distinction is the recovery model:
 * `/failed` and `/{eventId}/retry` act on **publication** (`outbox_messages`),
 * while `/dead-letters` and its commands act on **consumption** — one named
 * consumer's handling of one event. Retrying a publication asserts nothing;
 * skipping or reprocessing a consumer result asserts something about what the
 * original delivery did, which is why those are gated on the consumer's
 * registration and not on the operator's confidence.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";

import {
  listDeadLetteredUseCase,
  listFailedEventsUseCase,
  rebuildProjectionUseCase,
  reprocessWithCurrentHandlerUseCase,
  retryFailedEventUseCase,
  skipDeadLetterUseCase,
  type UseCaseDependencies,
} from "@aios/application";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

/** Redacted by construction — see `FailedEventSummary`. */
interface FailedEventResponse {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  attemptCount: number;
  lastErrorCode: string | null;
  occurredAt: string;
  lastAttemptAt: string | null;
}

/** Redacted the same way, and joined to the delivery it belongs to. */
interface DeadLetterResponse {
  deadLetterId: string;
  consumerName: string;
  eventId: string;
  eventType: string;
  status: string;
  version: number;
  processedEventStatus: string;
  errorCode: string;
  failureCategory: string;
  orderingKey: string | null;
  firstFailedAt: string;
  lastFailedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requireUuid = (value: string, field: string): void => {
  if (!UUID.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
};

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required.`);
  }
  return value;
};

/**
 * The expected version a recovery command is fenced on.
 *
 * Required, never defaulted. Defaulting it would turn "I checked, and it is
 * still the failure I looked at" into "whatever it is now", which is exactly
 * the guarantee the expected-version rule exists to provide.
 */
const requireVersion = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BadRequestException("expectedVersion must be a positive integer.");
  }
  return value;
};

@Controller("admin/events")
export class AdminEventsController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get("failed")
  async failed(
    @Req() request: Request,
  ): Promise<{ items: FailedEventResponse[] }> {
    const items = await listFailedEventsUseCase(this.deps, contextOf(request));
    return {
      items: items.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateVersion: event.aggregateVersion,
        attemptCount: event.attemptCount,
        lastErrorCode: event.lastErrorCode,
        occurredAt: event.occurredAt.toISOString(),
        lastAttemptAt: event.lastAttemptAt?.toISOString() ?? null,
      })),
    };
  }

  @Post(":eventId/retry")
  @HttpCode(204)
  async retry(
    @Req() request: Request,
    @Param("eventId") eventId: string,
  ): Promise<void> {
    // Rejected before the query so a malformed identifier is a client error
    // rather than a driver cast failure reported as a 500.
    if (!UUID.test(eventId)) {
      throw new BadRequestException("eventId must be a UUID.");
    }
    await retryFailedEventUseCase(this.deps, contextOf(request), eventId);
  }

  @Get("dead-letters")
  async deadLetters(
    @Req() request: Request,
  ): Promise<{ items: DeadLetterResponse[] }> {
    const items = await listDeadLetteredUseCase(this.deps, contextOf(request));
    return {
      items: items.map((d) => ({
        deadLetterId: d.deadLetterId,
        consumerName: d.consumerName,
        eventId: d.eventId,
        eventType: d.eventType,
        status: d.deadLetterStatus,
        version: d.deadLetterVersion,
        processedEventStatus: d.processedEventStatus,
        errorCode: d.errorCode,
        failureCategory: d.failureCategory,
        orderingKey: d.orderingKey,
        firstFailedAt: d.firstFailedAt.toISOString(),
        lastFailedAt: d.lastFailedAt.toISOString(),
      })),
    };
  }

  /**
   * Discard one consumer's result for one event.
   *
   * `expectedVersion` is required rather than optional. The events document
   * requires a skip to carry expected versions, and a skip authorized against
   * one view of a failure must not land on a different one.
   */
  @Post("dead-letters/:deadLetterId/skip")
  @HttpCode(204)
  async skip(
    @Req() request: Request,
    @Param("deadLetterId") deadLetterId: string,
    @Body()
    body: {
      expectedVersion?: unknown;
      reasonCode?: unknown;
      reason?: unknown;
      safetyEvidenceReference?: unknown;
      orderingBroken?: unknown;
    },
  ): Promise<void> {
    requireUuid(deadLetterId, "deadLetterId");

    await skipDeadLetterUseCase(this.deps, contextOf(request), {
      deadLetterId,
      expectedDeadLetterVersion: requireVersion(body.expectedVersion),
      reasonCode: requireText(body.reasonCode, "reasonCode"),
      reason: requireText(body.reason, "reason"),
      ...(typeof body.safetyEvidenceReference === "string"
        ? { safetyEvidenceReference: body.safetyEvidenceReference }
        : {}),
      // Defaults to false: intentionally breaking ordering continuity is a
      // decision, not something a caller should get by omitting a field.
      orderingBroken: body.orderingBroken === true,
    });
  }

  @Post("dead-letters/:deadLetterId/reprocess")
  async reprocess(
    @Req() request: Request,
    @Param("deadLetterId") deadLetterId: string,
    @Body()
    body: { expectedVersion?: unknown; reasonCode?: unknown; reason?: unknown },
  ): Promise<{ replayId: string }> {
    requireUuid(deadLetterId, "deadLetterId");

    const replayId = await reprocessWithCurrentHandlerUseCase(
      this.deps,
      contextOf(request),
      {
        deadLetterId,
        expectedDeadLetterVersion: requireVersion(body.expectedVersion),
        reasonCode: requireText(body.reasonCode, "reasonCode"),
        reason: requireText(body.reason, "reason"),
      },
    );

    return { replayId };
  }

  @Post("replay/projection")
  async rebuildProjection(
    @Req() request: Request,
    @Body() body: { consumerName?: unknown; reasonCode?: unknown; reason?: unknown },
  ): Promise<{ replayId: string }> {
    const replayId = await rebuildProjectionUseCase(this.deps, contextOf(request), {
      consumerName: requireText(body.consumerName, "consumerName"),
      reasonCode: requireText(body.reasonCode, "reasonCode"),
      reason: requireText(body.reason, "reason"),
    });

    return { replayId };
  }
}
