/**
 * In-app notifications.
 *
 * `docs/product/mvp.md` requires them and fixes their shape: "Notification state
 * is stored in PostgreSQL and is therefore a `PostgreSQLLocal` consumer effect."
 * So this is a projection built from registered events, not a thing any command
 * creates directly — no use case here writes a notification on a human's behalf.
 *
 * The substance is recipient resolution. An event says what happened; it does not
 * say who needs to look. Each rule below is a reading of who the fact concerns,
 * and each one is stated rather than inferred.
 */

import {
  isHumanMember,
  type MembershipId,
  type NotificationType,
  type OrganizationId,
} from "@aios/types";
import { activeParticipantsOf, type DomainEvent } from "@aios/domain";

import { requirePermission } from "./authorization.js";
import {
  NotFoundError,
  type NotificationRecord,
  type RepositoryBundle,
  type UseCaseDependencies,
} from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

/** Bounded so one Member's list cannot become an unbounded scan. */
export const NOTIFICATION_PAGE = 50;

export const listNotificationsUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
): Promise<readonly NotificationRecord[]> => {
  requirePermission(ctx.principal, "notification.read");
  // `requirePermission` already refuses every non-Human principal, so this is a
  // narrowing rather than a second check — a notification list belongs to a
  // Membership, and only a Human Member holds one.
  const principal = ctx.principal;
  if (!isHumanMember(principal)) throw new NotFoundError("Notification");
  return deps.uow.transaction((tx) =>
    tx.notifications.listForMember(
      ctx.organizationId,
      // The caller's own Membership, from the resolved principal. There is no
      // parameter for whose list to read — that is what makes it their own.
      principal.membershipId,
      NOTIFICATION_PAGE,
    ),
  );
};

export const acknowledgeNotificationUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  notificationId: string,
): Promise<void> => {
  requirePermission(ctx.principal, "notification.acknowledge");
  const principal = ctx.principal;
  if (!isHumanMember(principal)) throw new NotFoundError("Notification");

  const acknowledged = await deps.uow.transaction((tx) =>
    tx.notifications.acknowledge({
      organizationId: ctx.organizationId,
      recipientMembershipId: principal.membershipId,
      notificationId,
      now: ctx.now,
    }),
  );

  if (!acknowledged) {
    // Already acknowledged, or addressed to someone else. Reported the same way,
    // because distinguishing them would confirm that another Member received a
    // notification the caller can name.
    throw new NotFoundError("Notification");
  }
};

interface Planned {
  readonly recipients: readonly MembershipId[];
  readonly notificationType: NotificationType;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly title: string;
}

/**
 * Members related to a Work, as notification recipients.
 *
 * Creator, current assignee, and active participants. Not "everyone in the
 * Organization": a notification that reached people with no relationship to the
 * Work would train Members to ignore the list.
 */
const workAudience = async (
  tx: RepositoryBundle,
  organizationId: OrganizationId,
  workId: string,
): Promise<readonly MembershipId[]> => {
  const work = await tx.work.findById(organizationId, workId as never);
  if (work === null) {
    return [];
  }

  return [
    work.createdByMembershipId,
    ...activeParticipantsOf(work).map((p) => p.membershipId),
  ];
};

/**
 * Who needs to look, for one event.
 *
 * Returns null when the event warrants no notification. That is a decision, not
 * a gap: `DecisionWithdrawn` reaching a reviewer who never saw the submission
 * would be noise, and a `WorkAssignmentChanged` that only cleared an assignee
 * has nobody newly responsible to tell.
 */
const plan = async (
  tx: RepositoryBundle,
  event: DomainEvent,
): Promise<Planned | null> => {
  switch (event.type) {
    case "WorkAssignmentChanged": {
      // Only the new assignee. The previous one is being told they are no longer
      // responsible, which is not something that needs their attention.
      if (event.assigneeMembershipId === null) {
        return null;
      }
      return {
        recipients: [event.assigneeMembershipId],
        notificationType: "WorkAssigned",
        subjectType: "Work",
        subjectId: event.workId,
        title: "You were assigned Work.",
      };
    }

    case "DecisionSubmitted": {
      // Nothing assigns a reviewer to a Decision in this release, so the people
      // who can act are the ones holding the Reviewer role.
      const reviewers = await tx.memberships.listActiveByRole(
        event.organizationId,
        "Reviewer",
      );
      return {
        recipients: reviewers,
        notificationType: "DecisionSubmittedForReview",
        subjectType: "Decision",
        subjectId: event.decisionId,
        title: "A Decision is waiting for review.",
      };
    }

    case "DecisionApproved":
    case "DecisionRejected": {
      // The Work's members: the outcome decides whether their Work can complete.
      return {
        recipients: await workAudience(
          tx,
          event.organizationId,
          event.relatedWorkId,
        ),
        notificationType: "DecisionResolved",
        subjectType: "Decision",
        subjectId: event.decisionId,
        title:
          event.type === "DecisionApproved"
            ? "A Decision blocking your Work was approved."
            : "A Decision blocking your Work was rejected.",
      };
    }

    case "DecisionWithdrawn":
      // Withdrawal is usually the submitter's own act, and it resolves nothing
      // for anyone else to act on. Registered for the consumer so a redelivery
      // is recorded as handled rather than failing.
      return null;

    case "MemorySubmittedForReview": {
      const reviewers = await tx.memberships.listActiveByRole(
        event.organizationId,
        "Reviewer",
      );
      return {
        recipients: reviewers,
        notificationType: "MemoryReadyForReview",
        subjectType: "Memory",
        subjectId: event.memoryId,
        title: "A Memory draft is waiting for review.",
      };
    }

    case "MemoryRejected":
      // The Work's members are the ones who can correct it — the Memory is the
      // record of their Work.
      return {
        recipients: await workAudience(
          tx,
          event.organizationId,
          event.sourceWorkId,
        ),
        notificationType: "MemoryRejected",
        subjectType: "Memory",
        subjectId: event.memoryId,
        title: "A Memory draft was rejected and needs correction.",
      };

    case "MemoryApproved":
      return {
        recipients: await workAudience(
          tx,
          event.organizationId,
          event.sourceWorkId,
        ),
        notificationType: "MemoryApproved",
        subjectType: "Memory",
        subjectId: event.memoryId,
        title: "A Memory recording your Work was approved.",
      };

    default:
      return null;
  }
};

/**
 * Project one event into notifications.
 *
 * Runs inside the consumer's transaction. Idempotent through the
 * `(recipient, sourceEvent)` uniqueness the table declares, so a redelivery
 * changes nothing rather than duplicating a Member's list.
 *
 * The actor is excluded from their own notifications: telling someone that they
 * did the thing they just did is noise, and the one case where it matters — an
 * administrator assigning Work to themselves — is still visible in the Work.
 */
export const projectNotificationsUseCase = async (
  deps: UseCaseDependencies,
  tx: RepositoryBundle,
  event: DomainEvent,
  sourceEventId: string,
): Promise<number> => {
  const planned = await plan(tx, event);
  if (planned === null) {
    return 0;
  }

  const recipients = new Set(
    planned.recipients.filter(
      (membershipId) => membershipId !== event.actorMembershipId,
    ),
  );

  for (const recipientMembershipId of recipients) {
    await tx.notifications.append({
      notificationId: deps.ids.notificationId(),
      organizationId: event.organizationId,
      recipientMembershipId,
      notificationType: planned.notificationType,
      subjectType: planned.subjectType,
      subjectId: planned.subjectId,
      title: planned.title,
      sourceEventId,
      occurredAt: event.occurredAt,
    });
  }

  return recipients.size;
};
