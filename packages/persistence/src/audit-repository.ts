/**
 * PostgreSQL authorization audit repository.
 *
 * Insert, and nothing else — "The audit repository should expose `Insert`" only.
 * The persistence document also asks that database permissions deny ordinary
 * `UPDATE` and `DELETE` for the application role, which this code cannot
 * enforce but does not need: there is no method here that would use them.
 *
 * Writes run on their own connection rather than inside a caller's transaction.
 * That is deliberate: a denial has no transaction to join, and an audit row must
 * survive a business transaction that rolls back. An attempt that failed is
 * exactly what an auditor needs to see.
 *
 * `policyId` and `policyVersion` are stamped here rather than accepted from the
 * caller. They describe the rules the process was running, not anything about
 * the request, so a caller has nothing to say about them.
 */

import type { Pool } from "pg";

import {
  AUTHORIZATION_POLICY_ID,
  AUTHORIZATION_POLICY_VERSION,
  type AuditRecord,
  type AuditRepository,
} from "@aios/application";

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly pool: Pool) {}

  async record(entry: AuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO authorization_audit_records (
         authorization_audit_id, request_id, correlation_id, command_id,
         principal_id, principal_type, identity_id, membership_id, organization_id,
         command_type, permission, resource_type, resource_id,
         policy_id, policy_version,
         outcome, reason_code, previous_state, next_state,
         evaluated_at, resulting_event_id, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22
       )`,
      [
        entry.authorizationAuditId,
        entry.requestId,
        entry.correlationId,
        entry.commandId,
        entry.principalId,
        entry.principalType,
        entry.identityId,
        entry.membershipId,
        entry.organizationId,
        entry.commandType,
        entry.permission,
        entry.resourceType,
        entry.resourceId,
        AUTHORIZATION_POLICY_ID,
        AUTHORIZATION_POLICY_VERSION,
        entry.outcome,
        entry.reasonCode,
        entry.previousState,
        entry.nextState,
        entry.evaluatedAt,
        entry.resultingEventId,
        new Date(),
      ],
    );
  }
}
