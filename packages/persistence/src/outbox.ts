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
 * Aggregate a given event belongs to. `aggregate_type` and `aggregate_id` are
 * part of the stream-position uniqueness constraint, so they must be derived
 * consistently rather than guessed per call site.
 */
const aggregateOf = (
  event: DomainEvent,
): { type: "Work" | "Decision"; id: string } =>
  "workId" in event && !("decisionId" in event && event.type.startsWith("Decision"))
    ? { type: "Work", id: event.workId }
    : { type: "Decision", id: (event as { decisionId: string }).decisionId };

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
