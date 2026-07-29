/**
 * PostgreSQL Memory generation operation repository (ADR-0004, ADR-0015).
 *
 * This table is the durable evidence that a provider call was attempted. Its
 * defining property is that the row commits *before* the call and is only
 * finalized after it, so a process killed mid-call leaves a claimable record
 * rather than silence.
 *
 * Every state change here is a conditional `UPDATE ... WHERE status = ...`. That
 * is not stylistic: with at-least-once delivery two workers can hold the same
 * `WorkCompleted`, and the row is the only thing that decides which of them owns
 * the attempt.
 */

import type { PoolClient } from "pg";

import {
  MemoryId,
  OrganizationId,
  WorkId,
  type GenerationOperationStatus,
} from "@aios/types";
import type {
  GenerationOperation,
  GenerationOperationRepository,
} from "@aios/application";

interface OperationRow {
  generation_operation_id: string;
  organization_id: string;
  work_id: string;
  generation_policy_version: number;
  source_snapshot_id: string;
  source_snapshot_hash: string;
  provider_input_hash: string;
  status: string;
  attempt_count: number;
  memory_id: string | null;
}

const COLUMNS = `
  generation_operation_id, organization_id, work_id, generation_policy_version,
  source_snapshot_id, source_snapshot_hash, provider_input_hash,
  status, attempt_count, memory_id
`;

const hydrate = (row: OperationRow): GenerationOperation => ({
  generationOperationId: row.generation_operation_id,
  organizationId: OrganizationId(row.organization_id),
  workId: WorkId(row.work_id),
  generationPolicyVersion: row.generation_policy_version,
  sourceSnapshotId: row.source_snapshot_id,
  sourceSnapshotHash: row.source_snapshot_hash,
  providerInputHash: row.provider_input_hash,
  status: row.status as GenerationOperationStatus,
  attemptCount: row.attempt_count,
  memoryId: row.memory_id === null ? null : MemoryId(row.memory_id),
});

export class PostgresGenerationOperationRepository
  implements GenerationOperationRepository
{
  constructor(private readonly client: PoolClient) {}

  async ensure(input: {
    generationOperationId: string;
    organizationId: OrganizationId;
    workId: WorkId;
    generationPolicyVersion: number;
    sourceEventId: string;
    sourceSnapshotId: string;
    sourceSnapshotHash: string;
    providerInputHash: string;
    promptTemplateVersion: number;
    outputSchemaVersion: number;
    now: Date;
  }): Promise<GenerationOperation> {
    // The conflict target is the logical identity, so a redelivered
    // WorkCompleted returns the existing row instead of racing a second
    // attempt. `DO UPDATE` with a no-op assignment is what makes RETURNING
    // yield the existing row rather than nothing.
    const result = await this.client.query<OperationRow>(
      `INSERT INTO memory_generation_operations (
         generation_operation_id, organization_id, work_id,
         source_event_id, source_snapshot_id, source_snapshot_hash,
         provider_input_hash, generation_policy_version,
         status, attempt_count, claim_version,
         prompt_template_version, output_schema_version,
         version, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pending',0,0,$9,$10,1,$11,$11)
       ON CONFLICT (organization_id, work_id, generation_policy_version)
         DO UPDATE SET updated_at = memory_generation_operations.updated_at
       RETURNING ${COLUMNS}`,
      [
        input.generationOperationId,
        input.organizationId,
        input.workId,
        input.sourceEventId,
        input.sourceSnapshotId,
        input.sourceSnapshotHash,
        input.providerInputHash,
        input.generationPolicyVersion,
        input.promptTemplateVersion,
        input.outputSchemaVersion,
        input.now,
      ],
    );

    return hydrate(result.rows[0]!);
  }

  async claim(input: {
    generationOperationId: string;
    lockedBy: string;
    leaseUntil: Date;
    now: Date;
  }): Promise<GenerationOperation | null> {
    // An expired lease is reclaimable: the previous holder is gone, and the
    // persistence document's recovery rule preserves `attempt_count` rather
    // than resetting it, so a wedged operation still exhausts its budget.
    const result = await this.client.query<OperationRow>(
      `UPDATE memory_generation_operations
          SET status = 'Generating',
              attempt_count = attempt_count + 1,
              claim_version = claim_version + 1,
              locked_by = $2,
              locked_until = $3,
              first_started_at = COALESCE(first_started_at, $4),
              last_attempt_at = $4,
              next_attempt_at = NULL,
              version = version + 1,
              updated_at = $4
        WHERE generation_operation_id = $1
          AND (
            status IN ('Pending', 'RetryPending')
            OR (status = 'Generating' AND locked_until < $4)
          )
        RETURNING ${COLUMNS}`,
      [input.generationOperationId, input.lockedBy, input.leaseUntil, input.now],
    );

    const row = result.rows[0];
    return row === undefined ? null : hydrate(row);
  }

  async complete(input: {
    generationOperationId: string;
    memoryId: MemoryId;
    modelReference: string;
    now: Date;
  }): Promise<void> {
    // `WHERE status = 'Generating'` is the fence. A worker whose lease expired
    // while the provider was slow finds zero rows here, which is correct: the
    // operation was reclaimed and its result is no longer wanted.
    const result = await this.client.query(
      `UPDATE memory_generation_operations
          SET status = 'Generated',
              memory_id = $2,
              model_reference = $3,
              completed_at = $4,
              locked_by = NULL,
              locked_until = NULL,
              last_error_code = NULL,
              version = version + 1,
              updated_at = $4
        WHERE generation_operation_id = $1
          AND status = 'Generating'`,
      [input.generationOperationId, input.memoryId, input.modelReference, input.now],
    );

    if (result.rowCount === 0) {
      throw new Error(
        `Generation operation ${input.generationOperationId} was not claimed by this worker.`,
      );
    }
  }

  async fail(input: {
    generationOperationId: string;
    errorCode: string;
    terminal: boolean;
    nextAttemptAt: Date | null;
    now: Date;
  }): Promise<void> {
    await this.client.query(
      `UPDATE memory_generation_operations
          SET status = $2,
              last_error_code = $3,
              next_attempt_at = $4,
              locked_by = NULL,
              locked_until = NULL,
              version = version + 1,
              updated_at = $5
        WHERE generation_operation_id = $1
          AND status = 'Generating'`,
      [
        input.generationOperationId,
        input.terminal ? "Failed" : "RetryPending",
        input.errorCode,
        input.nextAttemptAt,
        input.now,
      ],
    );
  }
}
