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
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  type HumanMemberPrincipal,
} from "@aios/types";
import {
  assigneeOf,
  assignMember,
  completeWork,
  createWork,
  recordProgress,
  startWork,
  unassignMember,
  VersionConflictError,
  type ActorContext,
} from "@aios/domain";

import { PostgresWorkRepository } from "./work-repository.js";
import { PostgresOutbox } from "./outbox.js";

const url = process.env["DATABASE_URL"];

/**
 * Each database-backed suite owns a PostgreSQL schema.
 *
 * The suites all rebuild the schema from the documents, so sharing `public`
 * makes them race whenever two run at once. An isolated schema per suite keeps
 * them independent without serialising the whole test run.
 */
const SCHEMA = "test_work_repo";
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

    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    const schema = readFileSync(resolve(repoRoot, "build/schema.sql"), "utf8");

    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
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
      await client.query(
        "TRUNCATE work_items, work_participants, work_progress_records, memberships, outbox_messages CASCADE",
      );
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
      // `work_participants.membership_id` is a composite foreign key, so the
      // participant tests need a real Membership to point at.
      await client.query(
        `INSERT INTO memberships
           (membership_id, organization_id, identity_id, status,
            invited_at, activated_at, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Active', now(), now(), 1, now(), now())`,
        [MEMBERSHIP, ORG, IDENTITY],
      );
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

  describe("child collections", () => {
    const assign = (work: ReturnType<typeof newWork>, to = MEMBERSHIP) =>
      assignMember(work, { participantId: randomUUID(), membershipId: to }, ctx);

    it("round-trips an assignment", async () => {
      const created = newWork();
      const assigned = assign(created).state;

      const loaded = await withClient(async (repo) => {
        await repo.insert(created);
        await repo.update(assigned, created.version);
        return repo.findById(ORG, created.workId);
      });

      expect(assigneeOf(loaded!)).toBe(MEMBERSHIP);
      expect(loaded!.participants[0]).toMatchObject({
        relationshipType: "Assignee",
        addedByIdentityId: IDENTITY,
        addedByMembershipId: MEMBERSHIP,
        removedAt: null,
      });
    });

    it("writes the removal without rewriting the row", async () => {
      const created = newWork();
      const assigned = assign(created).state;
      const cleared = unassignMember(assigned, {
        ...ctx,
        now: new Date("2026-07-28T12:00:00Z"),
      }).state;

      const loaded = await withClient(async (repo) => {
        await repo.insert(created);
        await repo.update(assigned, created.version);
        await repo.update(cleared, assigned.version);
        return repo.findById(ORG, created.workId);
      });

      expect(assigneeOf(loaded!)).toBeNull();
      // One row, ended — not a delete and not a second row.
      expect(loaded!.participants).toHaveLength(1);
      expect(loaded!.participants[0]).toMatchObject({
        addedAt: NOW,
        removedAt: new Date("2026-07-28T12:00:00Z"),
        removedByMembershipId: MEMBERSHIP,
      });
    });

    it("refuses two active Assignees at the database level", async () => {
      const created = newWork();
      const assigned = assign(created).state;

      // The Aggregate ends the previous assignment, so reaching this state
      // requires bypassing it. The unique index is the backstop that makes the
      // invariant true even then.
      await expect(
        withClient(async (repo) => {
          await repo.insert(created);
          await repo.update(assigned, created.version);
          await repo.update(
            {
              ...assigned,
              participants: [
                ...assigned.participants,
                { ...assigned.participants[0]!, participantId: randomUUID() },
              ],
              version: (assigned.version + 1) as typeof assigned.version,
            },
            assigned.version,
          );
        }),
      ).rejects.toThrowError(/uq_work_participants_active_relationship/);
    });

    it("round-trips progress records in order", async () => {
      const started = startWork(newWork(), ctx).state;
      const first = recordProgress(
        started,
        { progressRecordId: randomUUID(), content: "First" },
        ctx,
      ).state;
      const second = recordProgress(
        first,
        { progressRecordId: randomUUID(), content: "Second" },
        { ...ctx, now: new Date("2026-07-28T12:00:00Z") },
      ).state;

      const loaded = await withClient(async (repo) => {
        await repo.insert(started);
        await repo.update(first, started.version);
        await repo.update(second, first.version);
        return repo.findById(ORG, started.workId);
      });

      expect(loaded!.progressRecords.map((r) => r.content)).toEqual([
        "First",
        "Second",
      ]);
      expect(loaded!.progressRecords[0]).toMatchObject({
        recordedByIdentityId: IDENTITY,
        recordedByMembershipId: MEMBERSHIP,
      });
    });

    it("does not rewrite a progress record that is already stored", async () => {
      const started = startWork(newWork(), ctx).state;
      const recorded = recordProgress(
        started,
        { progressRecordId: randomUUID(), content: "Original" },
        ctx,
      ).state;

      await withClient(async (repo) => {
        await repo.insert(started);
        await repo.update(recorded, started.version);
        // A tampered in-memory copy must not reach the stored row: the
        // collection is append-only and has no edit path.
        await repo.update(
          {
            ...recorded,
            progressRecords: [
              { ...recorded.progressRecords[0]!, content: "Tampered" },
            ],
            version: (recorded.version + 1) as typeof recorded.version,
          },
          recorded.version,
        );
      });

      const loaded = await withClient((repo) => repo.findById(ORG, started.workId));
      expect(loaded!.progressRecords[0]!.content).toBe("Original");
    });

    it("does not leak another Organization's children", async () => {
      const created = newWork();
      const assigned = assign(created).state;

      await withClient(async (repo) => {
        await repo.insert(created);
        await repo.update(assigned, created.version);
      });

      const loaded = await withClient((repo) =>
        repo.findById(OTHER_ORG, created.workId),
      );
      expect(loaded).toBeNull();
    });
  });


  /**
   * The check constraints the documented DDL declares.
   *
   * Exercised with raw SQL on purpose: the repository can never violate them,
   * which is exactly why they need proving. They are the backstop for every
   * write path that does not go through the Aggregate — a migration, a fix-up
   * script, a future repository.
   */
  describe("documented constraints", () => {
    const insertParticipant = (columns: string, values: string, params: unknown[]) =>
      withRawClient((client) =>
        client.query(
          `INSERT INTO work_participants
             (work_participant_id, organization_id, work_id, membership_id,
              relationship_type, added_by_identity_id, added_by_membership_id,
              added_at${columns})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8${values})`,
          params,
        ),
      );

    const withRawClient = async <T>(fn: (c: PoolClient) => Promise<T>) => {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    };

    const seedWork = async () => {
      const work = newWork();
      await withClient((repo) => repo.insert(work));
      return work;
    };

    it("refuses a removal with no attribution", async () => {
      const work = await seedWork();

      // Recording *when* a relationship ended but not *who* ended it would
      // break the traceability rule the Work Aggregate states.
      await expect(
        insertParticipant(
          ", removed_at",
          ", $9",
          [
            randomUUID(), ORG, work.workId, MEMBERSHIP, "Participant",
            IDENTITY, MEMBERSHIP, NOW, NOW,
          ],
        ),
      ).rejects.toThrowError(/ck_work_participants_removal/);
    });

    it("refuses a relationship type outside the recommended values", async () => {
      const work = await seedWork();

      await expect(
        insertParticipant("", "", [
          randomUUID(), ORG, work.workId, MEMBERSHIP, "Owner",
          IDENTITY, MEMBERSHIP, NOW,
        ]),
      ).rejects.toThrowError(/ck_work_participants_relationship_type/);
    });

    it("refuses blank progress content", async () => {
      const work = await seedWork();

      await expect(
        withRawClient((client) =>
          client.query(
            `INSERT INTO work_progress_records
               (work_progress_record_id, organization_id, work_id, content,
                recorded_by_identity_id, recorded_by_membership_id, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [randomUUID(), ORG, work.workId, "   ", IDENTITY, MEMBERSHIP, NOW],
          ),
        ),
      ).rejects.toThrowError(/ck_work_progress_records_content/);
    });

    it("refuses a participant from another Organization", async () => {
      const work = await seedWork();

      // The composite foreign key, not a check the caller could omit.
      await expect(
        insertParticipant("", "", [
          randomUUID(), OTHER_ORG, work.workId, MEMBERSHIP, "Participant",
          IDENTITY, MEMBERSHIP, NOW,
        ]),
      ).rejects.toThrowError(/work_participants_organization_id_work_id_fkey/);
    });
  });

});
