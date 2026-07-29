/**
 * Generation operation persistence against a real PostgreSQL database.
 *
 * Almost everything worth testing here is a database guarantee rather than a
 * code path: the logical-identity unique index, the two check constraints that
 * bind `Generated` to a linked Memory, and the conditional updates that decide
 * which of two racing workers owns an attempt. None of that exists in a
 * fixture.
 *
 * Skipped when DATABASE_URL is unset.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MemoryId, OrganizationId, WorkId } from "@aios/types";

import { PostgresGenerationOperationRepository } from "./generation-operation-repository.js";

const url = process.env["DATABASE_URL"];

const SCHEMA = "test_generation_ops";
const suite = url ? describe : describe.skip;

const repoRoot = resolve(import.meta.dirname, "../../..");
const NOW = new Date("2026-07-29T10:00:00Z");
const LEASE = new Date("2026-07-29T10:05:00Z");

const ORG = OrganizationId("11111111-1111-1111-1111-111111111111");
const IDENTITY = "33333333-3333-3333-3333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-4444-444444444444";
const POLICY = 2;

suite("PostgresGenerationOperationRepository", () => {
  let pool: Pool;
  let workId: WorkId;

  beforeAll(async () => {
    execFileSync("python3", [resolve(repoRoot, "scripts/extract_schema.py")], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    const schema = readFileSync(resolve(repoRoot, "build/schema.sql"), "utf8");

    const client = await pool.connect();
    try {
      await client.query(
        `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`,
      );
      await client.query(schema);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    workId = WorkId(randomUUID());
    const client = await pool.connect();
    try {
      await client.query(
        `TRUNCATE memory_generation_operations, memory_revisions, memories,
                  work_items, membership_role_assignments, memberships,
                  organizations, human_identities CASCADE`,
      );
      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Tester', 1, now(), now())`,
        [IDENTITY],
      );
      await client.query(
        `INSERT INTO organizations
           (organization_id, name, status, created_by_identity_id, version, created_at, updated_at)
         VALUES ($1, 'Org', 'Active', $2, 1, now(), now())`,
        [ORG, IDENTITY],
      );
      await client.query(
        `INSERT INTO memberships
           (membership_id, organization_id, identity_id, status, invited_at,
            activated_at, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Active', now(), now(), 1, now(), now())`,
        [MEMBERSHIP, ORG, IDENTITY],
      );
      await client.query(
        `INSERT INTO work_items
           (work_id, organization_id, title, status, completion_gate_type,
            created_by_identity_id, created_by_membership_id,
            completed_at, completed_by_identity_id, completed_by_membership_id,
            completion_summary, version, created_at, updated_at)
         VALUES ($1, $2, 'Ship it', 'Completed', 'NotRequired', $3, $4,
                 now(), $3, $4, 'Done', 3, now(), now())`,
        [workId, ORG, IDENTITY, MEMBERSHIP],
      );
    } finally {
      client.release();
    }
  });

  const withRepo = async <T>(
    fn: (
      repo: PostgresGenerationOperationRepository,
      client: PoolClient,
    ) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(new PostgresGenerationOperationRepository(client), client);
    } finally {
      client.release();
    }
  };

  const open = (repo: PostgresGenerationOperationRepository, hash = "input-hash") =>
    repo.ensure({
      generationOperationId: randomUUID(),
      organizationId: ORG,
      workId,
      generationPolicyVersion: POLICY,
      sourceEventId: randomUUID(),
      sourceSnapshotId: randomUUID(),
      sourceSnapshotHash: "snapshot-hash",
      providerInputHash: hash,
      promptTemplateVersion: 1,
      outputSchemaVersion: 1,
      now: NOW,
    });

  /** A Memory row, so `complete` has something valid to link. */
  const insertMemory = async (client: PoolClient): Promise<MemoryId> => {
    const memoryId = MemoryId(randomUUID());
    await client.query(
      `INSERT INTO memories
         (memory_id, organization_id, source_work_id,
          source_snapshot_id, source_snapshot_hash, status, is_active,
          current_revision_id, current_revision_number,
          generation_policy_version, generated_by_system_principal_id,
          generated_at, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'snapshot-hash','Generated',true,$5,1,$6,
               'memory-generator', now(), 1, now(), now())`,
      [memoryId, ORG, workId, randomUUID(), randomUUID(), POLICY],
    );
    return memoryId;
  };

  it("opens an operation in Pending with no attempts", async () => {
    const operation = await withRepo((repo) => open(repo));
    expect(operation).toMatchObject({
      status: "Pending",
      attemptCount: 0,
      memoryId: null,
      providerInputHash: "input-hash",
    });
  });

  it("returns the same operation for a redelivered event", async () => {
    const [first, second] = await withRepo(async (repo) => [
      await open(repo),
      await open(repo),
    ]);

    // Identity is (organization, work, policy). A redelivered WorkCompleted
    // must not start a parallel attempt.
    expect(second.generationOperationId).toBe(first.generationOperationId);
  });

  it("keeps the original provider input hash when reopened", async () => {
    const [, second] = await withRepo(async (repo) => [
      await open(repo, "first-hash"),
      await open(repo, "second-hash"),
    ]);

    // A retry must reuse the same provider input, or idempotency and
    // auditability are both lost (ADR-0012).
    expect(second.providerInputHash).toBe("first-hash");
  });

  it("claims an operation and counts the attempt", async () => {
    const claimed = await withRepo(async (repo) => {
      const operation = await open(repo);
      return repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-1",
        leaseUntil: LEASE,
        now: NOW,
      });
    });

    expect(claimed).toMatchObject({ status: "Generating", attemptCount: 1 });
  });

  it("refuses a second claim while the lease holds", async () => {
    const second = await withRepo(async (repo) => {
      const operation = await open(repo);
      await repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-1",
        leaseUntil: LEASE,
        now: NOW,
      });
      return repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-2",
        leaseUntil: LEASE,
        now: NOW,
      });
    });

    // Null, not an error: two workers racing for one WorkCompleted is expected
    // under at-least-once delivery, and the loser simply has nothing to do.
    expect(second).toBeNull();
  });

  it("reclaims an expired lease without resetting the attempt count", async () => {
    const reclaimed = await withRepo(async (repo) => {
      const operation = await open(repo);
      await repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-1",
        leaseUntil: LEASE,
        now: NOW,
      });
      return repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-2",
        leaseUntil: new Date("2026-07-29T10:20:00Z"),
        now: new Date("2026-07-29T10:10:00Z"),
      });
    });

    // Preserving the count is what stops a wedged operation from retrying
    // forever: recovery is not a fresh start.
    expect(reclaimed).toMatchObject({ status: "Generating", attemptCount: 2 });
  });

  it("completes a claimed operation and links the Memory", async () => {
    const row = await withRepo(async (repo, client) => {
      const operation = await open(repo);
      await repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-1",
        leaseUntil: LEASE,
        now: NOW,
      });
      const memoryId = await insertMemory(client);
      await repo.complete({
        generationOperationId: operation.generationOperationId,
        memoryId,
        modelReference: "claude-opus-5",
        now: NOW,
      });
      const result = await client.query(
        `SELECT status, memory_id, model_reference, completed_at
           FROM memory_generation_operations WHERE generation_operation_id = $1`,
        [operation.generationOperationId],
      );
      return result.rows[0];
    });

    expect(row).toMatchObject({
      status: "Generated",
      model_reference: "claude-opus-5",
    });
    expect(row.memory_id).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
  });

  it("refuses to complete an operation this worker no longer holds", async () => {
    await expect(
      withRepo(async (repo, client) => {
        const operation = await open(repo);
        const memoryId = await insertMemory(client);
        // Never claimed — the fence in `complete` is `status = 'Generating'`.
        await repo.complete({
          generationOperationId: operation.generationOperationId,
          memoryId,
          modelReference: "claude-opus-5",
          now: NOW,
        });
      }),
    ).rejects.toThrow(/not claimed/);
  });

  it("cannot mark an operation Generated without a Memory", async () => {
    // `ck_memory_generation_operations_memory_link` is what turns "Generated
    // requires a linked existing Memory" from a sentence in the document into
    // something the database refuses to violate.
    await expect(
      withRepo(async (repo, client) => {
        const operation = await open(repo);
        await client.query(
          `UPDATE memory_generation_operations
              SET status = 'Generated', completed_at = now()
            WHERE generation_operation_id = $1`,
          [operation.generationOperationId],
        );
      }),
    ).rejects.toThrow(/ck_memory_generation_operations_memory_link/);
  });

  it("moves a retryable failure to RetryPending with a next attempt time", async () => {
    const row = await withRepo(async (repo, client) => {
      const operation = await open(repo);
      await repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-1",
        leaseUntil: LEASE,
        now: NOW,
      });
      await repo.fail({
        generationOperationId: operation.generationOperationId,
        errorCode: "PROVIDER_ERROR",
        terminal: false,
        nextAttemptAt: new Date("2026-07-29T10:01:00Z"),
        now: NOW,
      });
      const result = await client.query(
        `SELECT status, last_error_code, next_attempt_at, locked_by
           FROM memory_generation_operations WHERE generation_operation_id = $1`,
        [operation.generationOperationId],
      );
      return result.rows[0];
    });

    expect(row).toMatchObject({
      status: "RetryPending",
      last_error_code: "PROVIDER_ERROR",
      locked_by: null,
    });
    expect(row.next_attempt_at).not.toBeNull();
  });

  it("leaves a terminal failure unclaimable", async () => {
    const reclaimed = await withRepo(async (repo) => {
      const operation = await open(repo);
      await repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-1",
        leaseUntil: LEASE,
        now: NOW,
      });
      await repo.fail({
        generationOperationId: operation.generationOperationId,
        errorCode: "GENERATION_UNGROUNDED",
        terminal: true,
        nextAttemptAt: null,
        now: NOW,
      });
      return repo.claim({
        generationOperationId: operation.generationOperationId,
        lockedBy: "worker-2",
        leaseUntil: LEASE,
        now: new Date("2026-07-29T11:00:00Z"),
      });
    });

    // A terminal Failed row does not free the identity. Clearing it is a typed
    // retry command, not another redelivery.
    expect(reclaimed).toBeNull();
  });
});
