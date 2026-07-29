/**
 * Transactional Outbox writer (ADR-0006).
 *
 * Events are appended inside the caller's transaction, so an event can never
 * exist without the state change that produced it, and a state change can never
 * commit without its event. A separate publisher delivers them at least once.
 *
 * This writes only. Claiming and publishing belong to the publisher, which uses
 * `FOR UPDATE SKIP LOCKED` per the events document.
 */

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import type { DomainEvent } from "@aios/domain";
import type { OutboxPort } from "@aios/application";

/**
 * Aggregate a given event belongs to.
 *
 * `aggregate_type` and `aggregate_id` form part of the stream-position
 * uniqueness constraint, so the mapping is exhaustive over the event union
 * rather than inferred from which fields happen to be present. Adding an event
 * without mapping it is then a compile error, not a null-constraint violation
 * at publish time.
 */
const aggregateOf = (
  event: DomainEvent,
): {
  type: "Work" | "Decision" | "Memory" | "Membership" | "Organization";
  id: string;
} => {
  switch (event.type) {
    case "WorkCreated":
    case "WorkDetailsUpdated":
    case "WorkAssignmentChanged":
    case "WorkParticipantChanged":
    case "WorkProgressRecorded":
    case "WorkStarted":
    case "WorkDecisionRequested":
    case "WorkDecisionOutcomeRecorded":
    case "WorkCompleted":
    case "WorkCancelled":
      return { type: "Work", id: event.workId };

    case "DecisionCreated":
    case "DecisionSubmitted":
    case "DecisionApproved":
    case "DecisionRejected":
    case "DecisionWithdrawn":
      return { type: "Decision", id: event.decisionId };

    case "MemoryGenerated":
    case "MemorySubmittedForReview":
    case "MemoryApproved":
    case "MemoryRejected":
      return { type: "Memory", id: event.memoryId };

    case "MembershipInvited":
    case "MembershipActivated":
    case "MembershipSuspended":
    case "MembershipReactivated":
    case "MembershipRevoked":
      return { type: "Membership", id: event.membershipId };

    case "OrganizationCreated":
    case "OrganizationRenamed":
      // The Organization is its own stream, keyed by itself. `organizationId`
      // is both the tenant scope and the aggregate id here, which is true of no
      // other aggregate.
      return { type: "Organization", id: event.organizationId };
  }
};

export class PostgresOutbox implements OutboxPort {
  constructor(
    private readonly client: PoolClient,
    private readonly correlationId: string = randomUUID(),
  ) {}

  async append(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    // `event_sequence` is scoped to one aggregate version, so a command that
    // emits several events at the same version keeps them ordered and unique.
    // A command spanning two aggregates (ADR-0007) counts each separately.
    const sequences = new Map<string, number>();

    for (const event of events) {
      const aggregate = aggregateOf(event);
      const streamKey = `${aggregate.type}:${aggregate.id}:${event.aggregateVersion}`;
      const sequence = (sequences.get(streamKey) ?? 0) + 1;
      sequences.set(streamKey, sequence);

      await this.client.query(
        `INSERT INTO outbox_messages (
           outbox_id, event_id, event_type, event_category, schema_version,
           aggregate_type, aggregate_id, aggregate_version, event_sequence,
           organization_id, payload, headers, destination,
           occurred_at, recorded_at, correlation_id, actor_reference,
           status, attempt_count, next_attempt_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13,
           $14, $15, $16, $17,
           $18, $19, $20
         )`,
        [
          randomUUID(),
          randomUUID(),
          event.type,
          "Domain",
          1,
          aggregate.type,
          aggregate.id,
          event.aggregateVersion,
          sequence,
          event.organizationId,
          JSON.stringify(event),
          JSON.stringify({}),
          "local",
          event.occurredAt,
          new Date(),
          this.correlationId,
          // Membership is null when the actor is an AI or System Principal.
          JSON.stringify({
            identityId: event.actorIdentityId,
            membershipId: event.actorMembershipId,
          }),
          "Pending",
          0,
          new Date(),
        ],
      );
    }
  }
}
