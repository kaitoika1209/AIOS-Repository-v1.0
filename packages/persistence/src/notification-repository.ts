/**
 * PostgreSQL notification repository.
 *
 * A projection store, so there is no version column and no optimistic
 * concurrency: rows are appended by a consumer and dismissed by their recipient,
 * and nothing else ever writes them.
 *
 * Every statement is scoped by `organization_id` *and* `recipient_membership_id`.
 * The second is not redundant — it is what stops a Member from reading or
 * dismissing another Member's attention list by naming its identifier.
 */

import type { PoolClient } from "pg";

import type {
  MembershipId,
  NotificationType,
  OrganizationId,
} from "@aios/types";
import type {
  NotificationRecord,
  NotificationRepository,
} from "@aios/application";

interface NotificationRow {
  notification_id: string;
  notification_type: string;
  subject_type: string;
  subject_id: string;
  title: string;
  occurred_at: Date;
  acknowledged_at: Date | null;
}

const hydrate = (row: NotificationRow): NotificationRecord => ({
  notificationId: row.notification_id,
  notificationType: row.notification_type as NotificationType,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  title: row.title,
  occurredAt: row.occurred_at,
  acknowledgedAt: row.acknowledged_at,
});

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly client: PoolClient) {}

  async append(input: {
    notificationId: string;
    organizationId: OrganizationId;
    recipientMembershipId: MembershipId;
    notificationType: NotificationType;
    subjectType: string;
    subjectId: string;
    title: string;
    sourceEventId: string;
    occurredAt: Date;
  }): Promise<void> {
    // `DO NOTHING` on the recipient/event conflict is the consumer's
    // idempotency: at-least-once delivery means the same event arrives twice,
    // and the second arrival must not produce a second notification.
    await this.client.query(
      `INSERT INTO notifications (
         notification_id, organization_id, recipient_membership_id,
         notification_type, subject_type, subject_id, title,
         source_event_id, occurred_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (recipient_membership_id, source_event_id) DO NOTHING`,
      [
        input.notificationId,
        input.organizationId,
        input.recipientMembershipId,
        input.notificationType,
        input.subjectType,
        input.subjectId,
        input.title,
        input.sourceEventId,
        input.occurredAt,
        new Date(),
      ],
    );
  }

  async listForMember(
    organizationId: OrganizationId,
    recipientMembershipId: MembershipId,
    limit: number,
  ): Promise<readonly NotificationRecord[]> {
    const result = await this.client.query<NotificationRow>(
      `SELECT notification_id, notification_type, subject_type, subject_id,
              title, occurred_at, acknowledged_at
         FROM notifications
        WHERE organization_id = $1
          AND recipient_membership_id = $2
        ORDER BY occurred_at DESC, created_at DESC
        LIMIT $3`,
      [organizationId, recipientMembershipId, limit],
    );
    return result.rows.map(hydrate);
  }

  async acknowledge(input: {
    organizationId: OrganizationId;
    recipientMembershipId: MembershipId;
    notificationId: string;
    now: Date;
  }): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE notifications
          SET acknowledged_at = $4
        WHERE organization_id = $1
          AND recipient_membership_id = $2
          AND notification_id = $3
          AND acknowledged_at IS NULL`,
      [
        input.organizationId,
        input.recipientMembershipId,
        input.notificationId,
        input.now,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
