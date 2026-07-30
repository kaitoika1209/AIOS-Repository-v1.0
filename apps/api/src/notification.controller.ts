/**
 * Notification routes.
 *
 * Both act on the caller's own list, and neither takes a parameter saying whose
 * list it is. That is what makes reading and dismissing them unprivileged: the
 * recipient comes from the resolved principal, so `notification.read` and
 * `notification.acknowledge` are held by every role without granting anyone
 * sight of another Member's attention.
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
  acknowledgeNotificationUseCase,
  listNotificationsUseCase,
  type UseCaseDependencies,
} from "@aios/application";

import { contextOf } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";

interface NotificationResponse {
  notificationId: string;
  notificationType: string;
  subjectType: string;
  subjectId: string;
  title: string;
  occurredAt: string;
  acknowledgedAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("notifications")
export class NotificationController {
  constructor(
    @Inject(USE_CASE_DEPENDENCIES)
    private readonly deps: UseCaseDependencies,
  ) {}

  @Get()
  async list(
    @Req() request: Request,
  ): Promise<{ items: NotificationResponse[]; unacknowledged: number }> {
    const items = await listNotificationsUseCase(this.deps, contextOf(request));
    return {
      items: items.map((n) => ({
        notificationId: n.notificationId,
        notificationType: n.notificationType,
        subjectType: n.subjectType,
        subjectId: n.subjectId,
        title: n.title,
        occurredAt: n.occurredAt.toISOString(),
        acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null,
      })),
      // Counted from the returned page rather than by a second query. The page is
      // bounded, so this is the count of what the caller can currently see —
      // which is what a badge should show.
      unacknowledged: items.filter((n) => n.acknowledgedAt === null).length,
    };
  }

  @Post(":notificationId/acknowledge")
  @HttpCode(204)
  async acknowledge(
    @Req() request: Request,
    @Param("notificationId") notificationId: string,
  ): Promise<void> {
    if (!UUID.test(notificationId)) {
      throw new BadRequestException("notificationId must be a UUID.");
    }
    await acknowledgeNotificationUseCase(
      this.deps,
      contextOf(request),
      notificationId,
    );
  }
}
