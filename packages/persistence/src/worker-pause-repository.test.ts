/**
 * Worker pauses against a real database (ADR-0022).
 *
 * Two claims in the documented DDL are only true if PostgreSQL enforces them,
 * and neither can be demonstrated in memory: the composite foreign key that
 * refuses a Membership from another Organization, and the check constraint that
 * refuses a Worker type with no claim loop.
 *
 * Skipped when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OrganizationId } from "@aios/types";

import { PostgresWorkerPauseRepository } from "./worker-pause-repository.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;
const SCHEMA = "test_worker_pauses";
const repoRoot = resolve(import.meta.dirname, "../../..");

const ORG = OrganizationId("11111111-1111-4111-8111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-4222-8222-222222222222");
const IDENTITY = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
/** An Active Membership of `OTHER_ORG`, held by the same Identity. */
const OTHER_MEMBERSHIP = "55555555-5555-4555-8555-555555555555";

const pauseOf = (workerType: "OutboxPublication" | "MemoryGeneration") => ({
  organizationId: ORG,
  workerType,
  pausedAt: new Date("2026-08-05T09:00:00Z"),
  pausedByIdentityId: IDENTITY,
  pausedByMembershipId: MEMBERSHIP,
  reasonCode: "PROVIDER_UNSAFE",
  reason: "The provider is returning malformed candidates.",
});

suite("worker pauses", () => {
  let pool: Pool;

  beforeAll(async () => {
    execFileSync("python3", [resolve(repoRoot, "scripts/extract_schema.py")], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
      await client.query(readFileSync(resolve(repoRoot, "build/schema.sql"), "utf8"));
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `TRUNCATE worker_pauses, memberships, organizations, human_identities CASCADE`,
      );
      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Operator', 1, now(), now())`,
        [IDENTITY],
      );
      for (const org of [ORG, OTHER_ORG]) {
        await client.query(
          `INSERT INTO organizations
             (organization_id, name, status, created_by_identity_id, version, created_at, updated_at)
           VALUES ($1, 'Org', 'Active', $2, 1, now(), now())`,
          [org, IDENTITY],
        );
      }
      for (const [membership, org] of [
        [MEMBERSHIP, ORG],
        [OTHER_MEMBERSHIP, OTHER_ORG],
      ] as const) {
        await client.query(
          `INSERT INTO memberships
             (membership_id, organization_id, identity_id, status, invited_at,
              activated_at, version, created_at, updated_at)
           VALUES ($1, $2, $3, 'Active', now(), now(), 1, now(), now())`,
          [membership, org, IDENTITY],
        );
      }
    } finally {
      client.release();
    }
  });

  const withRepository = async <T>(
    fn: (repository: PostgresWorkerPauseRepository) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(new PostgresWorkerPauseRepository(client));
    } finally {
      client.release();
    }
  };

  it("stores and lists a pause", async () => {
    const stored = await withRepository(async (r) => {
      await r.pause(pauseOf("MemoryGeneration"));
      return r.listFor(ORG);
    });

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      workerType: "MemoryGeneration",
      pausedByMembershipId: MEMBERSHIP,
      reason: "The provider is returning malformed candidates.",
    });
  });

  it("keeps the first pause when the command is repeated", async () => {
    const second = await withRepository(async (r) => {
      await r.pause(pauseOf("MemoryGeneration"));
      return r.pause({ ...pauseOf("MemoryGeneration"), reason: "Something else." });
    });

    // `ON CONFLICT DO NOTHING`, then read what is in force. The first pause is
    // the one that explains the state, and an operator repeating the command
    // should not silently discard the note it carries.
    expect(second.reason).toBe("The provider is returning malformed candidates.");
  });

  it("resumes, and reports that there was nothing to resume", async () => {
    const [first, second] = await withRepository(async (r) => {
      await r.pause(pauseOf("OutboxPublication"));
      return [
        await r.resume(ORG, "OutboxPublication"),
        await r.resume(ORG, "OutboxPublication"),
      ];
    });

    expect([first, second]).toEqual([true, false]);
  });

  it("keys the pause by Organization and Worker type together", async () => {
    const stored = await withRepository(async (r) => {
      await r.pause(pauseOf("OutboxPublication"));
      await r.pause(pauseOf("MemoryGeneration"));
      await r.resume(ORG, "OutboxPublication");
      return r.listFor(ORG);
    });

    expect(stored.map((p) => p.workerType)).toEqual(["MemoryGeneration"]);
  });

  it("refuses a Membership from another Organization", async () => {
    // The composite foreign key, not the permission check. Pausing is
    // Organization business authority, so the Membership that authorized it must
    // belong to the Organization being paused — and the database says so
    // independently of whatever the application believes.
    await expect(
      withRepository((r) =>
        r.pause({ ...pauseOf("MemoryGeneration"), pausedByMembershipId: OTHER_MEMBERSHIP }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("refuses a Worker type that has no claim loop", async () => {
    await expect(
      withRepository((r) =>
        r.pause({
          ...pauseOf("MemoryGeneration"),
          // `ConsumerDelivery` is a workflow type in the health report and not a
          // pausable Worker. Accepting it would record a pause that stops
          // nothing.
          workerType: "ConsumerDelivery" as "MemoryGeneration",
        }),
      ),
    ).rejects.toThrow(/ck_worker_pause_type/);
  });

  it("does not report one Organization's pause to another", async () => {
    const theirs = await withRepository(async (r) => {
      await r.pause(pauseOf("MemoryGeneration"));
      return r.listFor(OTHER_ORG);
    });

    expect(theirs).toEqual([]);
  });
});
