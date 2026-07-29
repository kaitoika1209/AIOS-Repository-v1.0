/**
 * Durable replay intent.
 *
 * The MVP has no second approver: "The authenticated authorized Human request
 * is the approval and is captured as durable intent." This table is that
 * capture, and it is written before anything executes — a replay that fails
 * mid-flight still leaves the record of who asked for it and why.
 *
 * Both requester columns come from trusted execution context. No caller
 * supplies them, which is the same rule that forbids a recovery request from
 * naming its own Organization.
 */

import type { PoolClient } from "pg";

import type { IdentityId, MembershipId, OrganizationId } from "@aios/types";
import type { ReplayRepository } from "@aios/application";

export class PostgresReplayRepository implements ReplayRepository {
  constructor(private readonly client: PoolClient) {}

  async record(input: {
    replayId: string;
    organizationId: OrganizationId;
    originalEventId: string;
    consumerName: string;
    replayMode: string;
    requestedByIdentityId: IdentityId;
    requestedByMembershipId: MembershipId;
    reasonCode: string;
    reason: string;
    status: string;
    authorizationPolicyId: string;
    authorizationPolicyVersion: number;
    sourceProcessedEventStatus: string;
    expectedDeadLetterVersion: number | null;
    now: Date;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO event_replays (
         replay_id, organization_id, original_event_id, consumer_name, replay_mode,
         requested_by_identity_id, requested_by_membership_id,
         reason_code, reason, status,
         authorization_policy_id, authorization_policy_version, authorized_at,
         source_processed_event_status, expected_dead_letter_version,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $13, $13
       )`,
      [
        input.replayId,
        input.organizationId,
        input.originalEventId,
        input.consumerName,
        input.replayMode,
        input.requestedByIdentityId,
        input.requestedByMembershipId,
        input.reasonCode,
        input.reason,
        input.status,
        input.authorizationPolicyId,
        input.authorizationPolicyVersion,
        input.now,
        input.sourceProcessedEventStatus,
        input.expectedDeadLetterVersion,
      ],
    );
  }

  async settle(input: {
    replayId: string;
    organizationId: OrganizationId;
    status: string;
    resultCode: string;
    now: Date;
  }): Promise<void> {
    // `completed_at` is set here because `ck_event_replays_terminal` requires
    // every terminal status to carry one. A settle that left it null would be
    // rejected by the database rather than stored ambiguously.
    await this.client.query(
      `UPDATE event_replays
          SET status = $3,
              result_code = $4,
              completed_at = $5,
              version = version + 1,
              updated_at = $5
        WHERE replay_id = $1
          AND organization_id = $2`,
      [input.replayId, input.organizationId, input.status, input.resultCode, input.now],
    );
  }
}
