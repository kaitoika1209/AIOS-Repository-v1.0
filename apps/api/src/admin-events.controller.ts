/**
 * Operational recovery routes.
 *
 * `/admin` in the path is a grouping, not a privilege boundary. These routes go
 * through the same guard as every other route and are authorized by the same
 * permission mechanism — the authorization document is explicit that platform
 * access is not Organization authority, so there is no operator back door here.
 *
 * Only two of the five `events.*` permissions have routes in this file. Skip and
 * the two replays each require a registered ConsumerRegistration policy to
 * decide whether the operation is safe for a given consumer, and consumer
 * registration is not in this release. Exposing them without that gate would
 * ship the dangerous half of recovery without its precondition.
 */

import {
  BadRequestException,
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
  listFailedEventsUseCase,
  retryFailedEventUseCase,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}
