/**
 * Repository tests against a real PostgreSQL database.
 *
 * These run against the schema extracted from the documents, not a hand-written
 * fixture. That is deliberate: applying the documented DDL is what previously
 * revealed a missing column and a duplicated index, and the same applies to the
 * SQL in the repository.
 *
 * Skipped when DATABASE_URL is unset so `pnpm test` stays runnable offline.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  type HumanMemberPrincipal,
} from "@aios/types";
import {
  completeWork,
  createWork,
  startWork,
  VersionConflictError,
  type ActorContext,
} from "@aios/domain";

import { PostgresWorkRepository } from "./work-repository.js";
import { PostgresOutbox } from "./outbox.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;

const repoRoot = resolve(import.meta.dirname, "../../..");
const NOW = new Date("2026-07-28T10:00:00Z");

// Fixed UUIDs: the schema types identity and organization columns as uuid.
const ORG = OrganizationId("11111111-1111-1111-1111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-2222-2222-222222222222");
const IDENTITY = IdentityId("33333333-3333-3333-3333-333333333333");
const MEMBERSHIP = MembershipId("44444444-4444-4444-4444-444444444444");

const principal: HumanMemberPrincipal = {
  type: "HumanMember",
  identityId: IDENTITY,
  membershipId: MEMBERSHIP,
  organizationId: ORG,
  roles: ["Member"],
};

const ctx: ActorContext = { principal, now: NOW };

suite("PostgresWorkRepository", () => {
  let pool: Pool;

  beforeAll(async () => {
    execFileSync("python3", [resolve(repoRoot, "scripts/extract_schema.py")], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    pool = new Pool({ connectionString: url });
    const schema = readFileSync(resolve(repoRoot, "build/schema.sql"), "utf8");

    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await client.query(schema);
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
      await client.query("TRUNCATE work_items, outbox_messages CASCADE");
      await client.query(
        `DELETE FROM organizations WHERE organization_id IN ($1, $2)`,
        [ORG, OTHER_ORG],
      );
      await client.query(`DELETE FROM human_identities WHERE identity_id = $1`, [
        IDENTITY,
      ]);
      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Tester', 1, now(), now())`,
        [IDENTITY],
      );
      for (const org of [ORG, OTHER_ORG]) {
        await client.query(
          `INSERT INTO organizations
             (organization_id, name, status, created_by_identity_id, version, created_at, updated_at)
           VALUES ($1, 'Test Org', 'Active', $2, 1, now(), now())`,
          [org, IDENTITY],
        );
      }
    } finally {
      client.release();
    }
  });

  const withClient = async <T>(fn: (r: PostgresWorkRepository) => Promise<T>) => {
    const client = await pool.connect();
    try {
      return await fn(new PostgresWorkRepository(client));
    } finally {
      client.release();
    }
  };

  const newWork = () =>
    createWork(
      { workId: WorkId(randomUUID()), organizationId: ORG, title: "Ship it" },
      ctx,
    ).state;

  it("round-trips a Draft Work without losing any field", async () => {
    const work = newWork();
    const loaded = await withClient(async (repo) => {
      await repo.insert(work);
      return repo.findById(ORG, work.workId);
    });

    expect(loaded).not.toBeNull();
    expect(loaded).toMatchObject({
      workId: work.workId,
      organizationId: ORG,
      title: "Ship it",
      status: "Draft",
      version: 1,
    });
    expect(loaded!.completionGate).toEqual({ kind: "NotRequired" });
  });

  it("persists the completion gate through a full blocking cycle", async () => {
    const work = startWork(newWork(), ctx).state;
    const decisionId = randomUUID();
    const snapshotId = randomUUID();

    const loaded = await withClient(async (repo) => {
      await repo.insert(work);

      const blocked = {
        ...work,
        status: "WaitingForDecision" as const,
        blockingReference: {
          decisionId: decisionId as never,
          revisionNumber: 1,
          submittedSnapshotId: snapshotId,
        },
        completionGate: {
          kind: "Pending" as const,
          reference: {
            decisionId: decisionId as never,
            revisionNumber: 1,
            submittedSnapshotId: snapshotId,
          },
        },
        version: (work.version + 1) as never,
      };

      await repo.update(blocked, work.version);
      return repo.findById(ORG, work.workId);
    });

    expect(loaded!.status).toBe("WaitingForDecision");
    expect(loaded!.completionGate).toMatchObject({
      kind: "Pending",
      reference: { revisionNumber: 1, submittedSnapshotId: snapshotId },
    });
    expect(loaded!.blockingReference).toMatchObject({
      submittedSnapshotId: snapshotId,
    });
  });

  it("rejects an update whose expected version is stale", async () => {
    const work = newWork();

    await expect(
      withClient(async (repo) => {
        await repo.insert(work);
        const started = startWork(work, ctx).state;
        await repo.update(started, work.version);
        // Second writer still believes it holds version 1.
        const again = completeWork(started, "done", ctx).state;
        await repo.update(again, work.version);
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("does not return Work belonging to another Organization", async () => {
    const work = newWork();
    const loaded = await withClient(async (repo) => {
      await repo.insert(work);
      return repo.findById(OTHER_ORG, work.workId);
    });

    expect(loaded).toBeNull();
  });

  it("refuses to update Work through the wrong Organization", async () => {
    const work = newWork();

    await expect(
      withClient(async (repo) => {
        await repo.insert(work);
        const started = startWork(work, ctx).state;
        await repo.update(
          { ...started, organizationId: OTHER_ORG },
          work.version,
        );
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("scopes listing to one Organization", async () => {
    const work = newWork();
    const rows = await withClient(async (repo) => {
      await repo.insert(work);
      return {
        mine: await repo.listByOrganization(ORG),
        theirs: await repo.listByOrganization(OTHER_ORG),
      };
    });

    expect(rows.mine).toHaveLength(1);
    expect(rows.theirs).toHaveLength(0);
  });

  it("writes events to the Outbox in the same transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const repo = new PostgresWorkRepository(client);
      const outbox = new PostgresOutbox(client);

      const created = createWork(
        { workId: WorkId(randomUUID()), organizationId: ORG, title: "Ship it" },
        ctx,
      );
      await repo.insert(created.state);
      await outbox.append(created.events);
      await client.query("COMMIT");

      const rows = await client.query(
        `SELECT event_type, aggregate_type, status FROM outbox_messages`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        event_type: "WorkCreated",
        aggregate_type: "Work",
        status: "Pending",
      });
    } finally {
      client.release();
    }
  });

  it("rolls back the Outbox row when the transaction fails", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const repo = new PostgresWorkRepository(client);
      const outbox = new PostgresOutbox(client);

      const created = createWork(
        { workId: WorkId(randomUUID()), organizationId: ORG, title: "Ship it" },
        ctx,
      );
      await repo.insert(created.state);
      await outbox.append(created.events);
      await client.query("ROLLBACK");

      const rows = await client.query(`SELECT count(*)::int AS n FROM outbox_messages`);
      expect(rows.rows[0].n).toBe(0);
      const work = await client.query(`SELECT count(*)::int AS n FROM work_items`);
      expect(work.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });
});
