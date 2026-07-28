/**
 * Decision repository tests against a real PostgreSQL database.
 *
 * The point of these is the revision model: a Decision spans two tables, and
 * the rule that matters is that resolving or superseding a revision never
 * rewrites its content. That is checked by reading rows back after a full
 * reject-and-revise cycle.
 *
 * Skipped when DATABASE_URL is unset.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DecisionId,
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  type HumanMemberPrincipal,
} from "@aios/types";
import {
  approveDecision,
  createDecision,
  rejectDecision,
  revisionByNumber,
  startRevision,
  submitForReview,
  updateDraft,
  VersionConflictError,
  type ActorContext,
  type DecisionState,
} from "@aios/domain";

import { PostgresDecisionRepository } from "./decision-repository.js";

const url = process.env["DATABASE_URL"];

/**
 * Each database-backed suite owns a PostgreSQL schema.
 *
 * The suites all rebuild the schema from the documents, so sharing `public`
 * makes them race whenever two run at once. An isolated schema per suite keeps
 * them independent without serialising the whole test run.
 */
const SCHEMA = "test_decision_repo";
const suite = url ? describe : describe.skip;

const repoRoot = resolve(import.meta.dirname, "../../..");
const NOW = new Date("2026-07-28T10:00:00Z");

const ORG = OrganizationId("11111111-1111-1111-1111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-2222-2222-222222222222");
const IDENTITY = IdentityId("33333333-3333-3333-3333-333333333333");
const MEMBERSHIP = MembershipId("44444444-4444-4444-4444-444444444444");
const WORK = WorkId("55555555-5555-5555-5555-555555555555");

const principal: HumanMemberPrincipal = {
  type: "HumanMember",
  identityId: IDENTITY,
  membershipId: MEMBERSHIP,
  organizationId: ORG,
  roles: ["Reviewer"],
};

const ctx: ActorContext = { principal, now: NOW };

const options = [
  { optionId: "a", summary: "Do it now" },
  { optionId: "b", summary: "Defer" },
];

suite("PostgresDecisionRepository", () => {
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
        "TRUNCATE decision_revisions, decisions, work_items, outbox_messages CASCADE",
      );
      await client.query("DELETE FROM organizations");
      await client.query("DELETE FROM human_identities");
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
      await client.query(
        `INSERT INTO work_items
           (work_id, organization_id, title, status, completion_gate_type,
            created_by_identity_id, created_by_membership_id,
            version, created_at, updated_at)
         VALUES ($1, $2, 'Ship it', 'InProgress', 'NotRequired', $3, $4, 1, now(), now())`,
        [WORK, ORG, IDENTITY, MEMBERSHIP],
      );
    } finally {
      client.release();
    }
  });

  const withRepo = async <T>(
    fn: (r: PostgresDecisionRepository, c: PoolClient) => Promise<T>,
  ) => {
    const client = await pool.connect();
    try {
      return await fn(new PostgresDecisionRepository(client), client);
    } finally {
      client.release();
    }
  };

  const newDecision = (): DecisionState =>
    createDecision(
      {
        decisionId: DecisionId(randomUUID()),
        organizationId: ORG,
        relatedWorkId: WORK,
        revisionId: randomUUID(),
        title: "Launch timing",
        question: "Ship this week?",
        options,
        isBlocking: true,
      },
      ctx,
    ).state;

  it("round-trips a Draft Decision with its revision", async () => {
    const decision = newDecision();
    const loaded = await withRepo(async (repo) => {
      await repo.insert(decision);
      return repo.findById(ORG, decision.decisionId);
    });

    expect(loaded).toMatchObject({
      status: "Draft",
      isBlocking: true,
      relatedWorkId: WORK,
      currentRevisionId: decision.currentRevisionId,
      submittedRevisionId: null,
      version: 1,
    });
    expect(loaded!.revisions).toHaveLength(1);
    expect(loaded!.revisions[0]).toMatchObject({
      revisionNumber: 1,
      status: "Draft",
      question: "Ship this week?",
    });
    expect(loaded!.revisions[0]!.options.map((o) => o.optionId)).toEqual(["a", "b"]);
  });

  it("persists submission as the snapshot Work will reference", async () => {
    const decision = newDecision();
    const submitted = submitForReview(decision, ctx).state;

    const loaded = await withRepo(async (repo) => {
      await repo.insert(decision);
      await repo.update(submitted, decision.version);
      return repo.findById(ORG, decision.decisionId);
    });

    expect(loaded!.status).toBe("InReview");
    expect(loaded!.currentRevisionId).toBeNull();
    expect(loaded!.submittedRevisionId).toBe(submitted.submittedRevisionId);
    expect(loaded!.revisions[0]!.status).toBe("Submitted");
  });

  it("persists approval with reviewer, rationale, and selected option", async () => {
    const decision = newDecision();
    const submitted = submitForReview(decision, ctx).state;
    const approved = approveDecision(
      submitted,
      { selectedOptionId: "a", rationale: "Lowest risk" },
      ctx,
    ).state;

    const loaded = await withRepo(async (repo) => {
      await repo.insert(decision);
      await repo.update(submitted, decision.version);
      await repo.update(approved, submitted.version);
      return repo.findById(ORG, decision.decisionId);
    });

    expect(loaded!.status).toBe("Approved");
    expect(loaded!.reviewRecords).toHaveLength(1);
    expect(loaded!.reviewRecords[0]).toMatchObject({
      outcome: "Approved",
      selectedOptionId: "a",
      rationale: "Lowest risk",
      revisionNumber: 1,
    });
  });

  /**
   * The invariant that motivated modelling revisions as child entities.
   */
  it("does not rewrite a rejected revision when a new one is edited", async () => {
    const decision = newDecision();
    const submitted = submitForReview(decision, ctx).state;
    const rejected = rejectDecision(submitted, "Needs more data", ctx).state;
    const revised = startRevision(rejected, randomUUID(), ctx).state;
    const edited = updateDraft(
      revised,
      {
        question: "Ship next month instead?",
        options: [{ optionId: "c", summary: "Later" }],
      },
      ctx,
    ).state;

    const loaded = await withRepo(async (repo) => {
      await repo.insert(decision);
      await repo.update(submitted, decision.version);
      await repo.update(rejected, submitted.version);
      await repo.update(revised, rejected.version);
      await repo.update(edited, revised.version);
      return repo.findById(ORG, decision.decisionId);
    });

    expect(loaded!.revisions).toHaveLength(2);

    const original = revisionByNumber(loaded!, 1)!;
    expect(original.question).toBe("Ship this week?");
    expect(original.options.map((o) => o.optionId)).toEqual(["a", "b"]);
    expect(original.status).toBe("Rejected");

    const next = revisionByNumber(loaded!, 2)!;
    expect(next.question).toBe("Ship next month instead?");
    expect(next.options.map((o) => o.optionId)).toEqual(["c"]);
    expect(next.status).toBe("Draft");

    // The rejection remains as evidence.
    expect(loaded!.reviewRecords).toHaveLength(1);
    expect(loaded!.reviewRecords[0]).toMatchObject({
      outcome: "Rejected",
      revisionNumber: 1,
      rationale: "Needs more data",
    });
  });

  it("refuses a content update to a revision that has left Draft", async () => {
    const decision = newDecision();
    const submitted = submitForReview(decision, ctx).state;

    const loaded = await withRepo(async (repo) => {
      await repo.insert(decision);
      await repo.update(submitted, decision.version);

      // Force a content change on the submitted revision, bypassing the
      // aggregate. The repository must not write it.
      const tampered: DecisionState = {
        ...submitted,
        revisions: submitted.revisions.map((r) => ({
          ...r,
          question: "TAMPERED",
        })),
        version: (submitted.version + 1) as never,
      };
      await repo.update(tampered, submitted.version);
      return repo.findById(ORG, decision.decisionId);
    });

    expect(loaded!.revisions[0]!.question).toBe("Ship this week?");
  });

  it("enforces one Draft revision per Decision", async () => {
    const decision = newDecision();

    await expect(
      withRepo(async (repo, client) => {
        await repo.insert(decision);
        await client.query(
          `INSERT INTO decision_revisions
             (decision_revision_id, organization_id, decision_id, revision_number,
              revision_status, title, question, options,
              created_by_identity_id, created_by_membership_id, created_at, updated_at)
           VALUES ($1, $2, $3, 2, 'Draft', 't', 'q', '[]'::jsonb, $4, $5, now(), now())`,
          [randomUUID(), ORG, decision.decisionId, IDENTITY, MEMBERSHIP],
        );
      }),
    ).rejects.toThrowError(/uq_decision_revisions_one_draft|duplicate key/);
  });

  it("rejects a stale expected version", async () => {
    const decision = newDecision();
    const submitted = submitForReview(decision, ctx).state;

    await expect(
      withRepo(async (repo) => {
        await repo.insert(decision);
        await repo.update(submitted, decision.version);
        await repo.update(submitted, decision.version);
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("does not return a Decision belonging to another Organization", async () => {
    const decision = newDecision();
    const loaded = await withRepo(async (repo) => {
      await repo.insert(decision);
      return repo.findById(OTHER_ORG, decision.decisionId);
    });

    expect(loaded).toBeNull();
  });

  it("lists Decisions scoped to one Work and Organization", async () => {
    const decision = newDecision();
    const rows = await withRepo(async (repo) => {
      await repo.insert(decision);
      return {
        mine: await repo.listByWork(ORG, WORK),
        theirs: await repo.listByWork(OTHER_ORG, WORK),
      };
    });

    expect(rows.mine).toHaveLength(1);
    expect(rows.mine[0]!.revisions).toHaveLength(1);
    expect(rows.theirs).toHaveLength(0);
  });
});
