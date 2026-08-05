/**
 * Consumer-side delivery state.
 *
 * `processed_events` records whether a named consumer handled an event;
 * `dead_letter_events` records a permanent failure an operator may act on; and
 * `consumer_ordering_state` records whether later deliveries for the same key
 * may proceed. The events document requires the three to change together, and
 * every method here issues its statements inside the caller's transaction so
 * they do.
 *
 * "A partial skip is prohibited" is the sharpest form of that rule, and `skip`
 * is written as one fenced sequence for exactly that reason.
 */

import type { PoolClient } from "pg";

import type { IdentityId, MembershipId, OrganizationId } from "@aios/types";
import type {
  ConsumerDeliveryRepository,
  DeadLetteredDelivery,
} from "@aios/application";

interface DeadLetterRow {
  dead_letter_id: string;
  consumer_name: string;
  event_id: string;
  event_type: string;
  organization_id: string;
  dead_letter_status: string;
  dead_letter_version: string | number;
  processed_event_status: string;
  error_code: string;
  failure_category: string;
  ordering_key_type: string | null;
  ordering_key: string | null;
  ordering_state_version: string | number | null;
  first_failed_at: Date;
  last_failed_at: Date;
}

/**
 * Selected columns, joined to the processed event and the ordering state.
 *
 * No payload, no `last_error_message`, no `error_reference` content — the same
 * redaction the failed-event listing applies, for the same reason: an operator
 * deciding whether to skip needs to know what failed, not what it said.
 */
const DEAD_LETTER_SELECT = `
  SELECT d.dead_letter_id,
         d.consumer_name,
         d.event_id,
         p.event_type,
         d.organization_id,
         d.status        AS dead_letter_status,
         d.version       AS dead_letter_version,
         p.status        AS processed_event_status,
         d.error_code,
         d.failure_category,
         d.ordering_key_type,
         d.ordering_key,
         o.version       AS ordering_state_version,
         d.first_failed_at,
         d.last_failed_at
    FROM dead_letter_events d
    JOIN processed_events p
      ON p.consumer_name = d.consumer_name
     AND p.event_id = d.event_id
    LEFT JOIN consumer_ordering_state o
      ON o.consumer_name = d.consumer_name
     AND o.organization_id = d.organization_id
     AND o.ordering_key_type = d.ordering_key_type
     AND o.ordering_key = d.ordering_key
`;

const hydrate = (row: DeadLetterRow): DeadLetteredDelivery => ({
  deadLetterId: row.dead_letter_id,
  consumerName: row.consumer_name,
  eventId: row.event_id,
  eventType: row.event_type,
  organizationId: row.organization_id as OrganizationId,
  deadLetterStatus: row.dead_letter_status,
  // bigint, which the driver returns as a string.
  deadLetterVersion: Number(row.dead_letter_version),
  processedEventStatus: row.processed_event_status,
  errorCode: row.error_code,
  failureCategory: row.failure_category,
  orderingKeyType: row.ordering_key_type,
  orderingKey: row.ordering_key,
  orderingStateVersion:
    row.ordering_state_version === null ? null : Number(row.ordering_state_version),
  firstFailedAt: row.first_failed_at,
  lastFailedAt: row.last_failed_at,
});

export class PostgresConsumerDeliveryRepository
  implements ConsumerDeliveryRepository
{
  constructor(private readonly client: PoolClient) {}

  async claim(input: {
    consumerName: string;
    eventId: string;
    eventType: string;
    schemaVersion: number;
    organizationId: OrganizationId;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    correlationId: string;
    orderingKeyType: string | null;
    orderingKey: string | null;
    sourceSequence: number | null;
    now: Date;
  }): Promise<"Claimed" | "AlreadyHandled" | "Blocked"> {
    // The ordering gate first: a blocked key must not consume an attempt.
    // "A Worker MUST NOT claim a later eligible delivery while an earlier
    // delivery for the same consumer and ordering key is Processing,
    // RetryPending, Failed, or Blocked."
    if (input.orderingKey !== null) {
      const blocked = await this.client.query<{ blocked_event_id: string | null }>(
        `SELECT blocked_event_id
           FROM consumer_ordering_state
          WHERE consumer_name = $1
            AND organization_id = $2
            AND ordering_key_type = $3
            AND ordering_key = $4
            AND status = 'Blocked'`,
        [
          input.consumerName,
          input.organizationId,
          input.orderingKeyType,
          input.orderingKey,
        ],
      );
      const holder = blocked.rows[0];
      // The delivery that blocked the key is the one allowed to retry it.
      if (holder !== undefined && holder.blocked_event_id !== input.eventId) {
        return "Blocked";
      }
    }

    const result = await this.client.query<{ status: string }>(
      `INSERT INTO processed_events (
         consumer_name, event_id, event_type, schema_version, organization_id,
         aggregate_type, aggregate_id, aggregate_version, correlation_id,
         status, attempt_count, first_received_at, processing_started_at,
         last_attempt_at, ordering_key_type, ordering_key, source_sequence
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'Processing', 1, $10, $10, $10, $11, $12, $13
       )
       ON CONFLICT (consumer_name, event_id) DO UPDATE
         SET status = 'Processing',
             attempt_count = processed_events.attempt_count + 1,
             processing_started_at = $10,
             last_attempt_at = $10
         WHERE processed_events.status IN ('Pending', 'RetryPending', 'Blocked')
       RETURNING status`,
      [
        input.consumerName,
        input.eventId,
        input.eventType,
        input.schemaVersion,
        input.organizationId,
        input.aggregateType,
        input.aggregateId,
        input.aggregateVersion,
        input.correlationId,
        input.now,
        input.orderingKeyType,
        input.orderingKey,
        input.sourceSequence,
      ],
    );

    // No row returned means the conflict target existed and the WHERE clause
    // refused it: already Processed, already Skipped, or held by another
    // worker. All three mean "not mine to attempt".
    return result.rowCount === 0 ? "AlreadyHandled" : "Claimed";
  }

  async complete(input: {
    consumerName: string;
    eventId: string;
    organizationId: OrganizationId;
    now: Date;
  }): Promise<void> {
    await this.client.query(
      `UPDATE processed_events
          SET status = 'Processed',
              processed_at = $3,
              locked_by = NULL,
              locked_until = NULL
        WHERE consumer_name = $1
          AND event_id = $2
          AND status = 'Processing'`,
      [input.consumerName, input.eventId, input.now],
    );

    await this.closeReplay(input, "Completed", "ReplaySucceeded");
  }

  /**
   * The terminal transaction a replay requires, when one is in flight.
   *
   * The events architecture: for a PostgreSQL-local replay success "the linked
   * dead letter becomes `Resolved` in the same transaction as: processed event
   * `Processing -> Processed`; the target Aggregate or registered consumer
   * effect; follow-up Outbox and required audit; ordering-state advancement or
   * unblock; and replay `Running -> Completed`."
   *
   * None of it existed. Running runbook 2 is what found that: the command
   * re-queued the delivery and the drain did re-attempt it, but nothing closed
   * the loop — a replay stayed `Running` for ever, a dead letter stayed
   * `ReadyForReplay` whether the retry succeeded or failed again, and an
   * operator had no way to tell those two apart. `ReadyForReplay` reads as
   * "queued and fine" when it can mean "tried again and failed again".
   *
   * Attribution comes from the replay's requester rather than from the Worker.
   * The Worker is a System Principal with no business authority and no
   * Membership, and `ck_dead_letter_resolution` requires both on a terminal
   * dead letter — correctly, because resolving one is Organization authority.
   * The Human who authorized the replay is who resolved it, and the replay
   * record is the durable evidence of that intent.
   *
   * Does nothing when no replay is active. An ordinary retry that succeeds is
   * not a replay outcome, and inventing a resolver for it would put a name
   * against a decision nobody made.
   */
  private async closeReplay(
    input: {
      consumerName: string;
      eventId: string;
      organizationId: OrganizationId;
      now: Date;
    },
    status: "Completed" | "Failed",
    resultCode: string,
  ): Promise<void> {
    const replay = await this.client.query<{
      replay_id: string;
      requested_by_identity_id: string;
      requested_by_membership_id: string;
      reason_code: string;
    }>(
      `UPDATE event_replays
          SET status = $4,
              ${status === "Completed" ? "result_code" : "last_error_code"} = $5,
              started_at = coalesce(started_at, $3),
              completed_at = $3,
              attempt_count = attempt_count + 1,
              version = version + 1,
              updated_at = $3
        WHERE consumer_name = $1
          AND original_event_id = $2
          AND organization_id = $6
          AND status IN ('Requested', 'Validating', 'Running')
       RETURNING replay_id, requested_by_identity_id, requested_by_membership_id, reason_code`,
      [
        input.consumerName,
        input.eventId,
        input.now,
        status,
        resultCode,
        input.organizationId,
      ],
    );

    const row = replay.rows[0];
    if (row === undefined) return;

    if (status === "Failed") {
      // "ReadyForReplay -> Open when replay fails before effect." Left at
      // `ReadyForReplay`, a dead letter that had just failed again would look
      // like one still waiting its turn.
      await this.client.query(
        `UPDATE dead_letter_events
            SET status = 'Open',
                replay_id = $3,
                version = version + 1,
                updated_at = $4
          WHERE consumer_name = $1
            AND event_id = $2
            AND status = 'ReadyForReplay'`,
        [input.consumerName, input.eventId, row.replay_id, input.now],
      );
      return;
    }

    await this.client.query(
      `UPDATE dead_letter_events
          SET status = 'Resolved',
              resolution_type = 'ReplaySucceeded',
              resolution_reason_code = $5,
              resolved_by_identity_id = $3,
              resolved_by_membership_id = $4,
              resolved_at = $6,
              replay_id = $7,
              version = version + 1,
              updated_at = $6
        WHERE consumer_name = $1
          AND event_id = $2
          AND status IN ('Open', 'Investigating', 'ReadyForReplay')`,
      [
        input.consumerName,
        input.eventId,
        row.requested_by_identity_id,
        row.requested_by_membership_id,
        row.reason_code,
        input.now,
        row.replay_id,
      ],
    );

    // `Recovering -> Active`: the attempt reached a terminal state, so later
    // deliveries on the key are no longer waiting behind a recovery.
    await this.client.query(
      `UPDATE consumer_ordering_state
          SET status = 'Active',
              version = version + 1,
              updated_at = $3
        WHERE consumer_name = $1
          AND organization_id = $2
          AND status = 'Recovering'`,
      [input.consumerName, input.organizationId, input.now],
    );
  }

  async fail(input: {
    consumerName: string;
    eventId: string;
    organizationId: OrganizationId;
    deadLetterId: string;
    failureCategory: string;
    errorCode: string;
    blockOrderingKey: boolean;
    now: Date;
  }): Promise<void> {
    const updated = await this.client.query<{
      ordering_key_type: string | null;
      ordering_key: string | null;
      source_sequence: string | number | null;
    }>(
      `UPDATE processed_events
          SET status = 'Failed',
              failed_at = $3,
              last_error_code = $4,
              locked_by = NULL,
              locked_until = NULL
        WHERE consumer_name = $1
          AND event_id = $2
          AND status = 'Processing'
       RETURNING ordering_key_type, ordering_key, source_sequence`,
      [input.consumerName, input.eventId, input.now, input.errorCode],
    );

    const row = updated.rows[0];
    if (row === undefined) {
      // Not ours to fail. Creating a dead letter anyway would invent evidence
      // of a failure this worker did not observe.
      return;
    }

    await this.client.query(
      `INSERT INTO dead_letter_events (
         dead_letter_id, organization_id, consumer_name, event_id,
         ordering_key_type, ordering_key, source_sequence,
         failure_category, error_code, status,
         first_failed_at, last_failed_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Open', $10, $10, $10, $10)
       ON CONFLICT (consumer_name, event_id) DO UPDATE
         SET last_failed_at = $10,
             error_code = $9,
             failure_category = $8,
             version = dead_letter_events.version + 1,
             updated_at = $10`,
      [
        input.deadLetterId,
        input.organizationId,
        input.consumerName,
        input.eventId,
        row.ordering_key_type,
        row.ordering_key,
        row.source_sequence,
        input.failureCategory,
        input.errorCode,
        input.now,
      ],
    );

    // `BlockOrderingKey` and `RequireExternalRecovery` block; the caller
    // decides which, from the registration.
    if (input.blockOrderingKey && row.ordering_key !== null) {
      await this.client.query(
        `INSERT INTO consumer_ordering_state (
           consumer_ordering_state_id, consumer_name, organization_id,
           ordering_key_type, ordering_key,
           blocked_event_id, blocked_sequence, blocked_at, block_reason_code,
           status, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'Blocked', $7
         )
         ON CONFLICT (consumer_name, organization_id, ordering_key_type, ordering_key)
         WHERE organization_id IS NOT NULL
         DO UPDATE SET
           blocked_event_id = $5,
           blocked_sequence = $6,
           blocked_at = $7,
           block_reason_code = $8,
           status = 'Blocked',
           version = consumer_ordering_state.version + 1,
           updated_at = $7`,
        [
          input.consumerName,
          input.organizationId,
          row.ordering_key_type,
          row.ordering_key,
          input.eventId,
          row.source_sequence,
          input.now,
          input.errorCode,
        ],
      );
    }

    // The replay that asked for this attempt, if there was one. Recorded before
    // the ordering key is re-blocked so a reader of `event_replays` sees the
    // failure rather than a row still claiming to be `Running`.
    await this.closeReplay(
      {
        consumerName: input.consumerName,
        eventId: input.eventId,
        organizationId: input.organizationId,
        now: input.now,
      },
      "Failed",
      input.errorCode,
    );
  }

  async listDeadLettered(
    organizationId: OrganizationId,
    limit: number,
  ): Promise<readonly DeadLetteredDelivery[]> {
    const result = await this.client.query<DeadLetterRow>(
      `${DEAD_LETTER_SELECT}
        WHERE d.organization_id = $1
          AND d.status NOT IN ('Resolved', 'Skipped')
        ORDER BY d.last_failed_at DESC
        LIMIT $2`,
      [organizationId, limit],
    );
    return result.rows.map(hydrate);
  }

  async findDeadLetter(
    organizationId: OrganizationId,
    deadLetterId: string,
  ): Promise<DeadLetteredDelivery | null> {
    const result = await this.client.query<DeadLetterRow>(
      `${DEAD_LETTER_SELECT}
        WHERE d.organization_id = $1
          AND d.dead_letter_id = $2`,
      [organizationId, deadLetterId],
    );
    const row = result.rows[0];
    return row === undefined ? null : hydrate(row);
  }

  async skip(input: {
    organizationId: OrganizationId;
    deadLetterId: string;
    expectedDeadLetterVersion: number;
    expectedOrderingStateVersion: number | null;
    reasonCode: string;
    resolvedByIdentityId: IdentityId;
    resolvedByMembershipId: MembershipId;
    orderingBroken: boolean;
    now: Date;
  }): Promise<boolean> {
    // Fenced on the expected version, so a skip authorized against one view of
    // the failure cannot land on a different one.
    const dead = await this.client.query<{
      consumer_name: string;
      event_id: string;
      ordering_key_type: string | null;
      ordering_key: string | null;
      source_sequence: string | number | null;
    }>(
      `UPDATE dead_letter_events
          SET status = 'Skipped',
              resolution_type = 'SkipDeadLetter',
              resolution_reason_code = $4,
              resolved_by_identity_id = $5,
              resolved_by_membership_id = $6,
              resolved_at = $7,
              version = version + 1,
              updated_at = $7
        WHERE organization_id = $1
          AND dead_letter_id = $2
          AND version = $3
          AND status IN ('Open', 'Investigating')
       RETURNING consumer_name, event_id, ordering_key_type, ordering_key, source_sequence`,
      [
        input.organizationId,
        input.deadLetterId,
        input.expectedDeadLetterVersion,
        input.reasonCode,
        input.resolvedByIdentityId,
        input.resolvedByMembershipId,
        input.now,
      ],
    );

    const row = dead.rows[0];
    if (row === undefined) {
      return false;
    }

    // Processed event Failed -> Skipped. Terminal: "Skipped ... cannot later be
    // converted to Processed by generic replay."
    const processed = await this.client.query(
      `UPDATE processed_events
          SET status = 'Skipped', skipped_at = $3
        WHERE consumer_name = $1
          AND event_id = $2
          AND status = 'Failed'`,
      [row.consumer_name, row.event_id, input.now],
    );

    if (processed.rowCount === 0) {
      // The dead letter and its processed event disagreed. Refusing here
      // rolls the caller's transaction back rather than leaving a skip that
      // resolved half of the pair.
      throw new Error(
        `Processed event for ${row.consumer_name}/${row.event_id} was not Failed; skip aborted.`,
      );
    }

    if (row.ordering_key !== null) {
      // "Advance or intentionally break ordering state according to the
      // approved policy." Advancing records the skipped sequence as terminal;
      // breaking leaves the gap explicit in the reason code.
      await this.client.query(
        `UPDATE consumer_ordering_state
            SET status = 'Active',
                last_terminal_sequence = COALESCE($5, last_terminal_sequence),
                blocked_event_id = NULL,
                blocked_sequence = NULL,
                blocked_at = NULL,
                block_reason_code = NULL,
                version = version + 1,
                updated_at = $6
          WHERE consumer_name = $1
            AND organization_id = $2
            AND ordering_key_type = $3
            AND ordering_key = $4
            AND ($7::bigint IS NULL OR version = $7)`,
        [
          row.consumer_name,
          input.organizationId,
          row.ordering_key_type,
          row.ordering_key,
          input.orderingBroken ? null : row.source_sequence,
          input.now,
          input.expectedOrderingStateVersion,
        ],
      );
    }

    return true;
  }

  async reprocess(input: {
    organizationId: OrganizationId;
    deadLetterId: string;
    expectedDeadLetterVersion: number;
    now: Date;
  }): Promise<boolean> {
    const dead = await this.client.query<{
      consumer_name: string;
      event_id: string;
    }>(
      `UPDATE dead_letter_events
          SET status = 'ReadyForReplay',
              version = version + 1,
              updated_at = $4
        WHERE organization_id = $1
          AND dead_letter_id = $2
          AND version = $3
          AND status IN ('Open', 'Investigating')
       RETURNING consumer_name, event_id`,
      [
        input.organizationId,
        input.deadLetterId,
        input.expectedDeadLetterVersion,
        input.now,
      ],
    );

    const row = dead.rows[0];
    if (row === undefined) {
      return false;
    }

    // Back to RetryPending, not Pending: the delivery has been attempted, and
    // `attempt_count` is preserved so a poisonous message stays visible as one.
    await this.client.query(
      `UPDATE processed_events
          SET status = 'RetryPending', next_attempt_at = $3
        WHERE consumer_name = $1
          AND event_id = $2
          AND status = 'Failed'`,
      [row.consumer_name, row.event_id, input.now],
    );

    // And the message itself, or the replay would be inert. A consumer failure
    // leaves the Outbox row `Failed`, and the publisher claims only `Pending`
    // ones — so readying the consumer without readying the message means
    // nothing is ever redelivered to it.
    //
    // Safe for the other consumers of the same event: `claim` refuses a
    // delivery that already succeeded, so they are skipped rather than re-run.
    // `attempt_count` and `last_error_code` are left alone, as `retryFailed`
    // leaves them — they are the evidence of how hard the system already tried.
    await this.client.query(
      `UPDATE outbox_messages
          SET status = 'Pending',
              next_attempt_at = $3,
              locked_by = NULL,
              locked_until = NULL
        WHERE organization_id = $1
          AND event_id = $2
          AND status = 'Failed'`,
      [input.organizationId, row.event_id, input.now],
    );

    // The key is unblocked so the worker may claim the delivery again. It stays
    // Recovering rather than Active until the attempt reaches a terminal state.
    await this.client.query(
      `UPDATE consumer_ordering_state
          SET status = 'Recovering',
              blocked_event_id = NULL,
              blocked_sequence = NULL,
              blocked_at = NULL,
              block_reason_code = NULL,
              version = version + 1,
              updated_at = $3
        WHERE consumer_name = $1
          AND organization_id = $2
          AND status = 'Blocked'`,
      [row.consumer_name, input.organizationId, input.now],
    );

    return true;
  }
}
