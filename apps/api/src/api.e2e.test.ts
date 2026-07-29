/**
 * End-to-end HTTP tests: real Nest application, real PostgreSQL, real schema
 * extracted from the documents.
 *
 * These cover the parts that only exist once HTTP is involved — tenancy
 * resolution, status-code mapping, and the fact that a reviewer approving a
 * Decision still does not complete Work.
 *
 * Skipped when DATABASE_URL is unset.
 */

import "reflect-metadata";

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SECRETARY_IDENTITY_ID, createApp, dependenciesFor } from "./app.js";
import { drainOutbox } from "./outbox-worker.js";
import { DeterministicMemoryGenerator } from "./deterministic-memory-generator.js";
import { DEV_ISSUER, DEV_PROVIDER, DevAuthAdapter } from "./dev-auth.js";

const url = process.env["DATABASE_URL"];

/**
 * Each database-backed suite owns a PostgreSQL schema.
 *
 * The suites all rebuild the schema from the documents, so sharing `public`
 * makes them race whenever two run at once. An isolated schema per suite keeps
 * them independent without serialising the whole test run.
 */
const SCHEMA = "test_api_e2e";
const suite = url ? describe : describe.skip;

const repoRoot = resolve(import.meta.dirname, "../../..");

const ORG = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG = "22222222-2222-2222-2222-222222222222";
const SUSPENDED_ORG = "66666666-6666-6666-6666-666666666666";

const MEMBER = { identity: "33333333-3333-3333-3333-333333333333", membership: "44444444-4444-4444-4444-444444444444", subject: "member-1" };
const REVIEWER = { identity: "77777777-7777-7777-7777-777777777777", membership: "88888888-8888-8888-8888-888888888888", subject: "reviewer-1" };
const OUTSIDER = { identity: "99999999-9999-9999-9999-999999999999", membership: "aaaaaaaa-9999-9999-9999-999999999999", subject: "outsider-1" };
const OWNER = { identity: "bbbbbbbb-1111-1111-1111-111111111111", membership: "cccccccc-1111-1111-1111-111111111111", subject: "owner-1" };
// A second plain Member of ORG, related to nothing. Exists so the relationship
// half of authorization can be tested apart from the permission half: STRANGER
// holds every ordinary Member permission and no relationship to any resource.
const STRANGER = { identity: "dddddddd-1111-1111-1111-111111111111", membership: "eeeeeeee-1111-1111-1111-111111111111", subject: "stranger-1" };

suite("AIOS API", () => {
  let pool: Pool;
  let app: INestApplication;

  const as = (who: typeof MEMBER, organizationId = ORG) => ({
    "x-dev-subject": who.subject,
    "x-organization-id": organizationId,
  });

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

    app = await createApp({ pool, auth: new DevAuthAdapter() });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `TRUNCATE decision_revisions, decisions, work_items, outbox_messages,
                  memory_revisions, memories,
                  membership_role_assignments, memberships,
                  authentication_subjects, organizations, human_identities CASCADE`,
      );

      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Secretary', 1, now(), now())`,
        [SECRETARY_IDENTITY_ID],
      );

      for (const who of [MEMBER, REVIEWER, OUTSIDER, OWNER, STRANGER]) {
        await client.query(
          `INSERT INTO human_identities
             (identity_id, status, display_name, version, created_at, updated_at)
           VALUES ($1, 'Active', 'Tester', 1, now(), now())`,
          [who.identity],
        );
        await client.query(
          `INSERT INTO authentication_subjects
             (authentication_subject_id, identity_id, provider, issuer, subject, linked_at, created_at)
           VALUES ($1, $2, $3, $4, $5, now(), now())`,
          [randomUUID(), who.identity, DEV_PROVIDER, DEV_ISSUER, who.subject],
        );
      }

      for (const [org, status] of [
        [ORG, "Active"],
        [OTHER_ORG, "Active"],
        [SUSPENDED_ORG, "Suspended"],
      ] as const) {
        await client.query(
          `INSERT INTO organizations
             (organization_id, name, status, created_by_identity_id, version, created_at, updated_at${status === "Suspended" ? ", suspended_at" : ""})
           VALUES ($1, 'Org', $2, $3, 1, now(), now()${status === "Suspended" ? ", now()" : ""})`,
          [org, status, MEMBER.identity],
        );
      }

      // MEMBER and REVIEWER belong to ORG; OUTSIDER belongs to OTHER_ORG only.
      for (const [who, org, role] of [
        [MEMBER, ORG, "Member"],
        [REVIEWER, ORG, "Reviewer"],
        [OWNER, ORG, "OrganizationOwner"],
        [STRANGER, ORG, "Member"],
        [OUTSIDER, OTHER_ORG, "Member"],
      ] as const) {
        await client.query(
          `INSERT INTO memberships
             (membership_id, organization_id, identity_id, status, invited_at, activated_at,
              version, created_at, updated_at)
           VALUES ($1, $2, $3, 'Active', now(), now(), 1, now(), now())`,
          [who.membership, org, who.identity],
        );
        await client.query(
          `INSERT INTO membership_role_assignments
             (role_assignment_id, organization_id, membership_id, role,
              assigned_by_identity_id, assigned_by_membership_id, assigned_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [randomUUID(), org, who.membership, role, who.identity, who.membership],
        );
      }
    } finally {
      client.release();
    }
  });

  const server = () => app.getHttpServer();

  const createWork = async (title = "Ship the MVP") => {
    const res = await request(server())
      .post("/works")
      .set(as(MEMBER))
      .send({ title })
      .expect(201);
    return res.body as { workId: string; status: string; version: number };
  };

  describe("authentication and tenancy (ADR-0013)", () => {
    it("rejects a request with no subject", async () => {
      await request(server())
        .get("/works")
        .set("x-organization-id", ORG)
        .expect(401);
    });

    it("rejects a request with no Organization header", async () => {
      await request(server())
        .get("/works")
        .set("x-dev-subject", MEMBER.subject)
        .expect(400);
    });

    it("rejects an unknown subject", async () => {
      await request(server()).get("/works").set(as({ ...MEMBER, subject: "nobody" })).expect(401);
    });

    it("reports an Organization the caller does not belong to as 404, not 403", async () => {
      await request(server()).get("/works").set(as(OUTSIDER, ORG)).expect(404);
    });

    it("refuses a Suspended Organization", async () => {
      await request(server()).get("/works").set(as(MEMBER, SUSPENDED_ORG)).expect(404);
    });

    it("refuses a disabled identity even though the subject is known", async () => {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE human_identities SET status = 'Disabled', disabled_at = now()
            WHERE identity_id = $1`,
          [MEMBER.identity],
        );
      } finally {
        client.release();
      }
      await request(server()).get("/works").set(as(MEMBER)).expect(403);
    });
  });

  describe("content edits (PATCH)", () => {
    it("edits a Work's title and description", async () => {
      const work = await createWork();
      const edited = await request(server())
        .patch(`/works/${work.workId}`)
        .set(as(MEMBER))
        .send({ title: "Ship the MVP, revised", description: "Now with detail." })
        .expect(200);

      expect(edited.body).toMatchObject({
        title: "Ship the MVP, revised",
        description: "Now with detail.",
        // A content edit carries no lifecycle meaning (ADR-0014).
        status: "Draft",
      });
      expect(edited.body.version).toBe(work.version + 1);
    });

    it("leaves an omitted field alone but clears an explicit null", async () => {
      const work = await createWork();
      await request(server())
        .patch(`/works/${work.workId}`)
        .set(as(MEMBER))
        .send({ description: "Some detail." })
        .expect(200);

      const cleared = await request(server())
        .patch(`/works/${work.workId}`)
        .set(as(MEMBER))
        .send({ description: null })
        .expect(200);

      // Collapsing "omitted" and "null" would make PATCH unable to remove a
      // field at all.
      expect(cleared.body.title).toBe("Ship the MVP");
      expect(cleared.body.description).toBeNull();
    });

    it("refuses to edit a completed Work", async () => {
      const work = await createWork();
      await request(server()).post(`/works/${work.workId}/start`).set(as(MEMBER)).expect(201);
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Shipped" })
        .expect(201);

      // Completed Work is the source snapshot a Memory was generated from.
      await request(server())
        .patch(`/works/${work.workId}`)
        .set(as(MEMBER))
        .send({ title: "Rewriting history" })
        .expect(409);
    });

    it("refuses an empty title rather than accepting a blank one", async () => {
      const work = await createWork();
      await request(server())
        .patch(`/works/${work.workId}`)
        .set(as(MEMBER))
        .send({ title: "   " })
        .expect(422);
    });

    it("edits a Draft Decision's question", async () => {
      const work = await createWork();
      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Which database?",
          question: "Which database should we use?",
          options: [{ optionId: "pg", summary: "PostgreSQL" }],
          isBlocking: true,
        })
        .expect(201);

      const edited = await request(server())
        .patch(`/decisions/${decision.body.decisionId}`)
        .set(as(MEMBER))
        .send({ question: "Which database should we standardise on?" })
        .expect(200);

      expect(edited.body.question).toContain("standardise");
      expect(edited.body.status).toBe("Draft");
    });

    it("refuses to edit a Decision that is already in review", async () => {
      const work = await createWork();
      await request(server()).post(`/works/${work.workId}/start`).set(as(MEMBER)).expect(201);
      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Which database?",
          question: "Which database should we use?",
          options: [{ optionId: "pg", summary: "PostgreSQL" }],
          isBlocking: true,
        })
        .expect(201);
      await request(server())
        .post(`/decisions/${decision.body.decisionId}/submit`)
        .set(as(MEMBER))
        .expect(201);

      // A submitted revision is what the reviewer evaluates and what Work's
      // completion gate points at; editing it would rewrite the evidence.
      await request(server())
        .patch(`/decisions/${decision.body.decisionId}`)
        .set(as(MEMBER))
        .send({ question: "Something else entirely?" })
        .expect(409);
    });

    it("refuses an unrelated Member editing or submitting a Draft Decision", async () => {
      const work = await createWork();
      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Which database?",
          question: "Which database should we use?",
          options: [{ optionId: "pg", summary: "PostgreSQL" }],
          isBlocking: true,
        })
        .expect(201);

      // "EditDraft | Creator, Contributor, or Admin". STRANGER holds
      // `decision.edit_draft` and `decision.submit` and authored no revision.
      await request(server())
        .patch(`/decisions/${decision.body.decisionId}`)
        .set(as(STRANGER))
        .send({ question: "Rewriting someone else's proposal." })
        .expect(403);

      await request(server())
        .post(`/decisions/${decision.body.decisionId}/submit`)
        .set(as(STRANGER))
        .expect(403);
    });

    it("lets an Admin edit a Draft Decision they did not create", async () => {
      const work = await createWork();
      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Which database?",
          question: "Which database should we use?",
          options: [{ optionId: "pg", summary: "PostgreSQL" }],
          isBlocking: true,
        })
        .expect(201);

      await request(server())
        .patch(`/decisions/${decision.body.decisionId}`)
        .set(as(OWNER))
        .send({ question: "Which database should we standardise on?" })
        .expect(200);
    });

    it("refuses a Reviewer editing Work they may not edit", async () => {
      const work = await createWork();
      await request(server())
        .patch(`/works/${work.workId}`)
        .set(as(REVIEWER))
        .send({ title: "Not mine to edit" })
        .expect(403);
    });
  });

  describe("Work routes", () => {
    it("creates and lists Work scoped to the Organization", async () => {
      const work = await createWork();
      expect(work.status).toBe("Draft");

      const mine = await request(server()).get("/works").set(as(MEMBER)).expect(200);
      expect(mine.body.items).toHaveLength(1);

      const theirs = await request(server())
        .get("/works")
        .set(as(OUTSIDER, OTHER_ORG))
        .expect(200);
      expect(theirs.body.items).toHaveLength(0);
    });

    it("does not expose Work from another Organization", async () => {
      const work = await createWork();
      await request(server())
        .get(`/works/${work.workId}`)
        .set(as(OUTSIDER, OTHER_ORG))
        .expect(404);
    });

    it("runs the Draft → InProgress → Completed lifecycle", async () => {
      const work = await createWork();

      const started = await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .expect(201);
      expect(started.body.status).toBe("InProgress");

      const completed = await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Delivered" })
        .expect(201);
      expect(completed.body.status).toBe("Completed");
    });

    it("maps an invalid transition to 409 with a stable code", async () => {
      const work = await createWork();
      const res = await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Too early" })
        .expect(409);

      expect(res.body.code).toBe("WORK_INVALID_TRANSITION");
    });

    it("maps a missing required field to 400", async () => {
      await request(server()).post("/works").set(as(MEMBER)).send({}).expect(400);
    });

    it("maps a blank required field to 400, before the domain sees it", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .expect(201);

      // Structurally invalid input is a malformed request, not a domain
      // invariant violation.
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "   " })
        .expect(400);
    });

    it("denies a Reviewer creating Work, without naming the permission", async () => {
      const res = await request(server())
        .post("/works")
        .set(as(REVIEWER))
        .send({ title: "Not mine to create" })
        .expect(403);

      expect(res.body.code).toBe("PERMISSION_DENIED");
      expect(JSON.stringify(res.body)).not.toContain("work.create");
    });
  });

  describe("Work → Decision slice", () => {
    const blockedWork = async () => {
      const work = await createWork();
      await request(server()).post(`/works/${work.workId}/start`).set(as(MEMBER)).expect(201);

      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Launch timing",
          question: "Ship on Friday?",
          options: [{ optionId: "yes", summary: "Yes" }],
          isBlocking: true,
        })
        .expect(201);

      const submitted = await request(server())
        .post(`/decisions/${decision.body.decisionId}/submit`)
        .set(as(MEMBER))
        .expect(201);

      return { work, decisionId: decision.body.decisionId as string, submitted };
    };

    it("submitting a blocking Decision blocks the Work atomically (ADR-0007)", async () => {
      const { work, submitted } = await blockedWork();

      expect(submitted.body.decision.status).toBe("InReview");
      expect(submitted.body.workStatus).toBe("WaitingForDecision");

      const reloaded = await request(server())
        .get(`/works/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);
      expect(reloaded.body.status).toBe("WaitingForDecision");
      expect(reloaded.body.completionGate).toBe("Pending");
    });

    it("a Member cannot approve; a Reviewer can", async () => {
      const { decisionId } = await blockedWork();

      await request(server())
        .post(`/decisions/${decisionId}/approve`)
        .set(as(MEMBER))
        .send({ selectedOptionId: "yes", rationale: "Fine" })
        .expect(403);

      const approved = await request(server())
        .post(`/decisions/${decisionId}/approve`)
        .set(as(REVIEWER))
        .send({ selectedOptionId: "yes", rationale: "Risk accepted" })
        .expect(201);
      expect(approved.body.status).toBe("Approved");
    });

    it("approving a Decision does not complete the Work", async () => {
      const { work, decisionId } = await blockedWork();

      await request(server())
        .post(`/decisions/${decisionId}/approve`)
        .set(as(REVIEWER))
        .send({ selectedOptionId: "yes", rationale: "Risk accepted" })
        .expect(201);

      const reloaded = await request(server())
        .get(`/works/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);
      expect(reloaded.body.status).not.toBe("Completed");
    });

    it("maps a domain invariant violation to 422", async () => {
      const { decisionId } = await blockedWork();

      // Well-formed request; the option simply is not part of the submitted
      // revision, which is a domain rule rather than a malformed payload.
      const res = await request(server())
        .post(`/decisions/${decisionId}/approve`)
        .set(as(REVIEWER))
        .send({ selectedOptionId: "not-an-option", rationale: "Fine" })
        .expect(422);

      expect(res.body.code).toBe("VALIDATION_FAILED");
    });

    it("preserves the rejected revision when a new one is started", async () => {
      const { decisionId } = await blockedWork();

      await request(server())
        .post(`/decisions/${decisionId}/reject`)
        .set(as(REVIEWER))
        .send({ rationale: "Needs more data" })
        .expect(201);

      const revised = await request(server())
        .post(`/decisions/${decisionId}/revisions`)
        .set(as(MEMBER))
        .expect(201);

      expect(revised.body.revisionNumber).toBe(2);
      expect(revised.body.status).toBe("Draft");
      expect(revised.body.reviewHistory).toHaveLength(1);
      expect(revised.body.reviewHistory[0]).toMatchObject({
        outcome: "Rejected",
        revisionNumber: 1,
        rationale: "Needs more data",
      });
    });
  });

  describe("Outbox worker (ADR-0007 asynchronous half)", () => {
    const blockAndApprove = async () => {
      const work = await createWork();
      await request(server()).post(`/works/${work.workId}/start`).set(as(MEMBER)).expect(201);
      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Launch timing",
          question: "Ship on Friday?",
          options: [{ optionId: "yes", summary: "Yes" }],
          isBlocking: true,
        })
        .expect(201);
      await request(server())
        .post(`/decisions/${decision.body.decisionId}/submit`)
        .set(as(MEMBER))
        .expect(201);
      await request(server())
        .post(`/decisions/${decision.body.decisionId}/approve`)
        .set(as(REVIEWER))
        .send({ selectedOptionId: "yes", rationale: "Risk accepted" })
        .expect(201);
      return work;
    };

    it("projects an approved outcome onto the Work completion gate", async () => {
      const work = await blockAndApprove();

      const before = await request(server())
        .get(`/works/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);
      expect(before.body.status).toBe("WaitingForDecision");

      const result = await drainOutbox(pool, dependenciesFor(pool));
      expect(result.applied).toBeGreaterThanOrEqual(1);

      const after = await request(server())
        .get(`/works/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);
      expect(after.body.status).toBe("InProgress");
      expect(after.body.completionGate).toBe("Satisfied");
    });

    it("completes the slice: the human still completes the Work explicitly", async () => {
      const work = await blockAndApprove();
      await drainOutbox(pool, dependenciesFor(pool));

      const completed = await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Shipped" })
        .expect(201);
      expect(completed.body.status).toBe("Completed");
    });

    it("treats redelivery as already applied, not as a failure", async () => {
      await blockAndApprove();
      await drainOutbox(pool, dependenciesFor(pool));

      // Re-queue every published message: at-least-once delivery means the
      // consumer must tolerate seeing them again.
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE outbox_messages SET status = 'Pending', published_at = NULL`,
        );
      } finally {
        client.release();
      }

      const again = await drainOutbox(pool, dependenciesFor(pool));
      expect(again.failed).toBe(0);
      expect(again.alreadyApplied).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Outbox", () => {
    it("records events for committed commands only", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Too early" })
        .expect(409);

      const client = await pool.connect();
      try {
        const rows = await client.query(
          `SELECT event_type FROM outbox_messages ORDER BY recorded_at`,
        );
        expect(rows.rows.map((r: { event_type: string }) => r.event_type)).toEqual([
          "WorkCreated",
        ]);
      } finally {
        client.release();
      }
    });
  });
  describe("Memory (ADR-0008)", () => {
    const memoryOptions = {
      memory: {
        generator: new DeterministicMemoryGenerator(),
        secretaryIdentityId: SECRETARY_IDENTITY_ID,
        systemPrincipalId: "memory-generator",
      },
    };

    const completedWork = async () => {
      const work = await createWork("Ship the beta");
      await request(server()).post(`/works/${work.workId}/start`).set(as(MEMBER)).expect(201);
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Beta shipped on Friday" })
        .expect(201);
      return work;
    };

    it("generates a Memory draft from WorkCompleted", async () => {
      const work = await completedWork();

      const before = await request(server())
        .get(`/memories/by-work/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);
      expect(before.body.memory).toBeNull();

      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

      const after = await request(server())
        .get(`/memories/by-work/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);

      expect(after.body.memory).toMatchObject({
        status: "Generated",
        sourceWorkId: work.workId,
        title: "Ship the beta",
        authoredBy: "AI",
      });
      expect(after.body.memory.summary).toContain("Beta shipped");
      expect(after.body.memory.provenance.generationPolicyVersion).toBe(1);
    });

    it("produces one Memory even when WorkCompleted is redelivered", async () => {
      const work = await completedWork();
      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE outbox_messages SET status = 'Pending', published_at = NULL
            WHERE event_type = 'WorkCompleted'`,
        );
      } finally {
        client.release();
      }

      const again = await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);
      expect(again.failed).toBe(0);

      const all = await request(server()).get("/memories").set(as(MEMBER)).expect(200);
      expect(all.body.items.filter((m: { sourceWorkId: string }) => m.sourceWorkId === work.workId)).toHaveLength(1);
    });

    const draftFor = async () => {
      const work = await completedWork();
      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);
      const memory = await request(server())
        .get(`/memories/by-work/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);
      return memory.body.memory as { memoryId: string; version: number };
    };

    it("a human corrects the draft, then submits it for review", async () => {
      const draft = await draftFor();

      const edited = await request(server())
        .patch(`/memories/${draft.memoryId}`)
        .set(as(MEMBER))
        .send({ summary: "We shipped, and learned to cut scope earlier." })
        .expect(200);
      expect(edited.body.summary).toContain("cut scope earlier");
      expect(edited.body.revisionNumber).toBe(1);

      const submitted = await request(server())
        .post(`/memories/${draft.memoryId}/submit`)
        .set(as(MEMBER))
        .expect(201);
      expect(submitted.body.status).toBe("InReview");
    });


    it("refuses an unrelated Member editing or submitting the draft", async () => {
      const draft = await draftFor();

      // STRANGER holds `memory.edit_generated` and `memory.submit` — every
      // Member does. "Editor, related Work Member, or Admin" is what they lack:
      // the Memory is the record of Work they took no part in.
      await request(server())
        .patch(`/memories/${draft.memoryId}`)
        .set(as(STRANGER))
        .send({ summary: "Rewriting someone else's record." })
        .expect(403);

      await request(server())
        .post(`/memories/${draft.memoryId}/submit`)
        .set(as(STRANGER))
        .expect(403);
    });

    it("lets a participant on the source Work edit the draft", async () => {
      const work = await createWork("Ship the beta");
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ participantMembershipIds: [STRANGER.membership] })
        .expect(201);
      await request(server()).post(`/works/${work.workId}/start`).set(as(MEMBER)).expect(201);
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Beta shipped on Friday" })
        .expect(201);
      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

      const memory = await request(server())
        .get(`/memories/by-work/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);

      // The participant relationship is on the Work, and it reaches the Memory
      // generated from it.
      await request(server())
        .patch(`/memories/${memory.body.memory.memoryId}`)
        .set(as(STRANGER))
        .send({ summary: "I was there; this is what happened." })
        .expect(200);
    });

    it("lets an Owner who took no part in the Work edit the draft", async () => {
      const draft = await draftFor();
      await request(server())
        .patch(`/memories/${draft.memoryId}`)
        .set(as(OWNER))
        .send({ summary: "Administrative correction." })
        .expect(200);
    });

    it("a Member cannot approve; a Reviewer can, and approval is terminal", async () => {
      const draft = await draftFor();
      await request(server()).post(`/memories/${draft.memoryId}/submit`).set(as(MEMBER)).expect(201);

      await request(server())
        .post(`/memories/${draft.memoryId}/approve`)
        .set(as(MEMBER))
        .send({ note: "looks fine" })
        .expect(403);

      const approved = await request(server())
        .post(`/memories/${draft.memoryId}/approve`)
        .set(as(REVIEWER))
        .send({ note: "Accurate" })
        .expect(201);
      expect(approved.body.status).toBe("Approved");

      // Approved Memory is immutable.
      await request(server())
        .patch(`/memories/${draft.memoryId}`)
        .set(as(MEMBER))
        .send({ summary: "rewritten" })
        .expect(409);
    });

    it("rejection can be reopened, and the rejected revision survives", async () => {
      const draft = await draftFor();
      await request(server()).post(`/memories/${draft.memoryId}/submit`).set(as(MEMBER)).expect(201);

      await request(server())
        .post(`/memories/${draft.memoryId}/reject`)
        .set(as(REVIEWER))
        .send({ note: "Missing the decision rationale" })
        .expect(201);

      // memory.reopen is not a Member permission — authorization.md grants a
      // Member only "edit Generated Memory" and "submit Memory for review".
      await request(server())
        .post(`/memories/${draft.memoryId}/reopen`)
        .set(as(MEMBER))
        .expect(403);

      const reopened = await request(server())
        .post(`/memories/${draft.memoryId}/reopen`)
        .set(as(OWNER))
        .expect(201);

      expect(reopened.body.status).toBe("Generated");
      expect(reopened.body.revisionNumber).toBe(2);
      expect(reopened.body.reviewHistory).toHaveLength(1);
      expect(reopened.body.reviewHistory[0]).toMatchObject({
        outcome: "Rejected",
        revisionNumber: 1,
      });
    });

    it("does not expose a Memory from another Organization", async () => {
      const draft = await draftFor();
      await request(server())
        .get(`/memories/${draft.memoryId}`)
        .set(as(OUTSIDER, OTHER_ORG))
        .expect(404);
    });
  });

  describe("membership invitation", () => {
    const invite = (
      who = OWNER,
      body: Record<string, unknown> = {
        email: "newcomer@example.test",
        roles: ["Reviewer"],
      },
    ) =>
      request(server())
        .post(`/organizations/${ORG}/members`)
        .set(as(who))
        .send(body);

    it("issues a token that is not stored in the database", async () => {
      const response = await invite().expect(201);
      expect(response.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.body.status).toBe("Invited");

      const client = await pool.connect();
      try {
        const rows = await client.query(
          `SELECT token_hash FROM organization_invitations`,
        );
        expect(rows.rowCount).toBe(1);
        expect(rows.rows[0].token_hash).not.toBe(response.body.token);
      } finally {
        client.release();
      }
    });

    it("refuses a Member without administration authority", async () => {
      await invite(MEMBER).expect(403);
    });

    it("does not name the permission it denied", async () => {
      const response = await invite(MEMBER).expect(403);
      expect(JSON.stringify(response.body)).not.toContain("organization.");
    });

    it("lists the invitation with no Identity attached", async () => {
      await invite().expect(201);
      const response = await request(server())
        .get(`/organizations/${ORG}/members`)
        .set(as(MEMBER))
        .expect(200);

      const invited = response.body.items.find(
        (m: { status: string }) => m.status === "Invited",
      );
      expect(invited).toMatchObject({
        email: "newcomer@example.test",
        roles: ["Reviewer"],
        displayName: null,
      });
      expect(invited.invitationExpiresAt).not.toBeNull();
    });

    it("treats a path Organization the caller is not acting in as absent", async () => {
      await request(server())
        .get(`/organizations/${OTHER_ORG}/members`)
        .set(as(MEMBER))
        .expect(404);
    });

    it("grants no authority until the invitation is accepted", async () => {
      await invite().expect(201);
      // The invitee authenticates, but their Membership is Invited, so the
      // resolution chain yields no principal at all.
      await request(server())
        .get("/works")
        .set({ "x-dev-subject": "newcomer", "x-organization-id": ORG })
        .expect(401);
    });

    it("activates the Membership on acceptance", async () => {
      const invitation = await invite().expect(201);

      const accepted = await request(server())
        .post("/invitations/accept")
        .set({ "x-dev-subject": "newcomer", "x-dev-display-name": "Newcomer" })
        .send({ token: invitation.body.token })
        .expect(201);

      expect(accepted.body).toMatchObject({
        organizationId: ORG,
        membershipId: invitation.body.membershipId,
        roles: ["Reviewer"],
      });
    });

    it("carries exactly the authority the invitation granted", async () => {
      const invitation = await invite().expect(201);
      await request(server())
        .post("/invitations/accept")
        .set({ "x-dev-subject": "newcomer", "x-dev-display-name": "Newcomer" })
        .send({ token: invitation.body.token })
        .expect(201);

      const headers = { "x-dev-subject": "newcomer", "x-organization-id": ORG };
      // A Reviewer can read, but cannot create Work.
      await request(server()).get("/works").set(headers).expect(200);
      await request(server())
        .post("/works")
        .set(headers)
        .send({ title: "Not mine to create" })
        .expect(403);
    });

    it("accepts without an X-Organization-Id header", async () => {
      // The exemption ADR-0014 records. Supplying the header would be
      // impossible here: the caller is not yet a Member of anything.
      const invitation = await invite().expect(201);
      await request(server())
        .post("/invitations/accept")
        .set({ "x-dev-subject": "newcomer" })
        .send({ token: invitation.body.token })
        .expect(201);
    });

    it("still requires authentication to accept", async () => {
      const invitation = await invite().expect(201);
      await request(server())
        .post("/invitations/accept")
        .send({ token: invitation.body.token })
        .expect(401);
    });

    it("reports an unknown token exactly as it reports a revoked one", async () => {
      const invitation = await invite().expect(201);
      await request(server())
        .post(`/organizations/${ORG}/members/${invitation.body.membershipId}/revoke-invitation`)
        .set(as(OWNER))
        .send({ reason: "Sent in error" })
        .expect(201);

      const revoked = await request(server())
        .post("/invitations/accept")
        .set({ "x-dev-subject": "newcomer" })
        .send({ token: invitation.body.token })
        .expect(404);

      const unknown = await request(server())
        .post("/invitations/accept")
        .set({ "x-dev-subject": "newcomer" })
        .send({ token: "definitely-not-a-real-token" })
        .expect(404);

      // Identical bodies: a caller guessing tokens learns nothing about which
      // ones exist.
      expect(revoked.body).toEqual(unknown.body);
    });

    it("invalidates the previous token when an invitation is resent", async () => {
      const first = await invite().expect(201);
      const second = await request(server())
        .post(`/organizations/${ORG}/members/${first.body.membershipId}/resend-invitation`)
        .set(as(OWNER))
        .expect(201);

      expect(second.body.token).not.toBe(first.body.token);

      await request(server())
        .post("/invitations/accept")
        .set({ "x-dev-subject": "newcomer" })
        .send({ token: first.body.token })
        .expect(404);

      await request(server())
        .post("/invitations/accept")
        .set({ "x-dev-subject": "newcomer" })
        .send({ token: second.body.token })
        .expect(201);
    });

    it("cannot be accepted twice", async () => {
      const invitation = await invite().expect(201);
      const accept = (subject: string) =>
        request(server())
          .post("/invitations/accept")
          .set({ "x-dev-subject": subject })
          .send({ token: invitation.body.token });

      await accept("newcomer").expect(201);
      await accept("someone-else").expect(404);
    });

    it("refuses to grant OrganizationOwner by invitation", async () => {
      await invite(OWNER, {
        email: "newcomer@example.test",
        roles: ["OrganizationOwner"],
      }).expect(422);
    });

    it("refuses a second invitation to the same address", async () => {
      await invite().expect(201);
      await invite().expect(422);
    });

    it("emits MembershipInvited through the Outbox", async () => {
      await invite().expect(201);
      const client = await pool.connect();
      try {
        const rows = await client.query<{ event_type: string; aggregate_type: string }>(
          `SELECT event_type, aggregate_type FROM outbox_messages`,
        );
        expect(rows.rows).toEqual([
          { event_type: "MembershipInvited", aggregate_type: "Membership" },
        ]);
      } finally {
        client.release();
      }
    });
  });

  describe("assignment and progress", () => {
    it("assigns a Member and reports them on the Work", async () => {
      const work = await createWork();

      const res = await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: REVIEWER.membership })
        .expect(201);

      expect(res.body.assigneeMembershipId).toBe(REVIEWER.membership);
      expect(res.body.version).toBe(work.version + 1);
    });

    it("unassigns with an explicit null", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: REVIEWER.membership })
        .expect(201);

      const res = await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: null })
        .expect(201);

      expect(res.body.assigneeMembershipId).toBeNull();
    });

    it("keeps the ended assignment as a row", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: REVIEWER.membership })
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: OWNER.membership })
        .expect(201);

      const client = await pool.connect();
      try {
        const rows = await client.query<{
          membership_id: string;
          removed_at: Date | null;
          removed_by_membership_id: string | null;
        }>(
          `SELECT membership_id, removed_at, removed_by_membership_id
             FROM work_participants
            WHERE work_id = $1
            ORDER BY added_at`,
          [work.workId],
        );

        expect(rows.rows).toHaveLength(2);
        expect(rows.rows[0]).toMatchObject({
          membership_id: REVIEWER.membership,
          removed_by_membership_id: MEMBER.membership,
        });
        expect(rows.rows[0]!.removed_at).not.toBeNull();
        expect(rows.rows[1]!.removed_at).toBeNull();
      } finally {
        client.release();
      }
    });

    it("reports an assignee from another Organization as 404", async () => {
      const work = await createWork();

      // OUTSIDER's Membership is real, in OTHER_ORG. A 422 would confirm it
      // exists somewhere.
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: OUTSIDER.membership })
        .expect(404);
    });

    it("refuses a Member assigning Work they did not create", async () => {
      const work = await createWork();

      // A Member holds `work.assign` — "Limited" in the mapping table. The
      // limit is the relationship, and the message names neither.
      const res = await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(REVIEWER))
        .send({ assigneeMembershipId: REVIEWER.membership })
        .expect(403);

      expect(res.body).toEqual({
        code: "PERMISSION_DENIED",
        message: "You do not have permission to perform this action.",
        details: {},
      });
    });

    it("lets an Owner assign Work they are a stranger to", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(OWNER))
        .send({ assigneeMembershipId: OWNER.membership })
        .expect(201);
    });

    it("replaces the participant set", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ participantMembershipIds: [REVIEWER.membership, OWNER.membership] })
        .expect(201);

      const res = await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ participantMembershipIds: [OWNER.membership] })
        .expect(201);

      expect(res.body.participantMembershipIds).toEqual([OWNER.membership]);
    });

    it("rejects a request that asks for nothing", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({})
        .expect(400);
    });

    /** Work created by MEMBER, assigned to OWNER, and started. */
    const assignedAndStarted = async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: OWNER.membership })
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .expect(201);
      return work;
    };

    it("records progress from the assignee", async () => {
      const work = await assignedAndStarted();

      const res = await request(server())
        .post(`/works/${work.workId}/progress`)
        .set(as(OWNER))
        .send({ content: "Reviewed the migration plan." })
        .expect(201);

      expect(res.body.progress).toMatchObject([
        {
          content: "Reviewed the migration plan.",
          recordedByMembershipId: OWNER.membership,
        },
      ]);
      // Progress alone never completes Work.
      expect(res.body.status).toBe("InProgress");
    });

    it("refuses progress from the creator who is not doing the work", async () => {
      const work = await assignedAndStarted();

      // MEMBER holds `work.record_progress` and created the Work. Neither is
      // enough: "RecordProgress | Assignee or Participant" is the one row that
      // excludes the Creator.
      await request(server())
        .post(`/works/${work.workId}/progress`)
        .set(as(MEMBER))
        .send({ content: "Looks fine from here." })
        .expect(403);
    });

    it("refuses progress from a Reviewer at the permission, not the relationship", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: REVIEWER.membership })
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .expect(201);

      // The Reviewer is the assignee and so holds the relationship, but the
      // role carries no `work.record_progress` at all. Step 5 refuses first,
      // and the response is identical either way.
      await request(server())
        .post(`/works/${work.workId}/progress`)
        .set(as(REVIEWER))
        .send({ content: "On it." })
        .expect(403);
    });

    it("refuses progress on Work that has not started", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: MEMBER.membership })
        .expect(201);

      await request(server())
        .post(`/works/${work.workId}/progress`)
        .set(as(MEMBER))
        .send({ content: "Not started yet." })
        .expect(409);
    });

    it("emits the assignment, participant, and progress events", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({
          assigneeMembershipId: MEMBER.membership,
          participantMembershipIds: [REVIEWER.membership],
        })
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/progress`)
        .set(as(MEMBER))
        .send({ content: "Under way." })
        .expect(201);

      const client = await pool.connect();
      try {
        const rows = await client.query<{ event_type: string }>(
          `SELECT event_type FROM outbox_messages ORDER BY recorded_at, event_sequence`,
        );
        expect(rows.rows.map((r) => r.event_type)).toEqual([
          "WorkCreated",
          "WorkAssignmentChanged",
          "WorkParticipantChanged",
          "WorkStarted",
          "WorkProgressRecorded",
        ]);
      } finally {
        client.release();
      }
    });

    it("survives a reload: children come back with the Work", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({
          assigneeMembershipId: MEMBER.membership,
          participantMembershipIds: [REVIEWER.membership],
        })
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/progress`)
        .set(as(MEMBER))
        .send({ content: "Under way." })
        .expect(201);

      const res = await request(server())
        .get(`/works/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);

      expect(res.body.assigneeMembershipId).toBe(MEMBER.membership);
      expect(res.body.participantMembershipIds).toEqual([REVIEWER.membership]);
      expect(res.body.progress).toHaveLength(1);
    });
  });

  describe("operational recovery (events.*)", () => {
    /**
     * A failed delivery, written directly.
     *
     * The publisher produces this state after exhausting its retries, and
     * driving it there through the worker would take a deliberately broken
     * consumer. What the recovery routes need is the row, not the story that
     * produced it.
     */
    const seedFailed = async (
      organizationId: string,
      overrides: { attemptCount?: number } = {},
    ): Promise<string> => {
      const eventId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO outbox_messages
             (outbox_id, event_id, event_type, event_category, schema_version,
              aggregate_type, aggregate_id, aggregate_version, event_sequence,
              organization_id, payload, headers, destination,
              occurred_at, recorded_at, correlation_id, actor_reference,
              status, attempt_count, next_attempt_at, first_attempt_at,
              last_attempt_at, last_error_code, last_error_message)
           VALUES ($1, $2, 'WorkCreated', 'Domain', 1,
                   'Work', $3, 1, 1,
                   $4, $5, '{}'::jsonb, 'domain',
                   now(), now(), $6, $7,
                   'Failed', $8, now(), now(),
                   now(), 'CONSUMER_TIMEOUT', 'timed out reading title=Confidential')`,
          [
            randomUUID(),
            eventId,
            randomUUID(),
            organizationId,
            JSON.stringify({ title: "Confidential merger terms" }),
            randomUUID(),
            JSON.stringify({ identityId: MEMBER.identity }),
            overrides.attemptCount ?? 5,
          ],
        );
      } finally {
        client.release();
      }
      return eventId;
    };

    const rowOf = async (eventId: string) => {
      const client = await pool.connect();
      try {
        const result = await client.query<{ status: string; attempt_count: number }>(
          `SELECT status, attempt_count FROM outbox_messages WHERE event_id = $1`,
          [eventId],
        );
        return result.rows[0]!;
      } finally {
        client.release();
      }
    };

    it("lists failed deliveries for an Owner", async () => {
      const eventId = await seedFailed(ORG);

      const res = await request(server())
        .get("/admin/events/failed")
        .set(as(OWNER))
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        eventId,
        eventType: "WorkCreated",
        aggregateType: "Work",
        attemptCount: 5,
        lastErrorCode: "CONSUMER_TIMEOUT",
      });
    });

    it("does not disclose the payload, headers, actor, or error message", async () => {
      await seedFailed(ORG);

      const res = await request(server())
        .get("/admin/events/failed")
        .set(as(OWNER))
        .expect(200);

      // Asserted against the serialised response rather than key by key: a
      // field added to the summary later would leak silently otherwise.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain("Confidential");
      expect(body).not.toContain("timed out");
      expect(body).not.toContain(MEMBER.identity);
      expect(Object.keys(res.body.items[0]).sort()).toEqual(
        [
          "aggregateId",
          "aggregateType",
          "aggregateVersion",
          "attemptCount",
          "eventId",
          "eventType",
          "lastAttemptAt",
          "lastErrorCode",
          "occurredAt",
        ].sort(),
      );
    });

    it("does not show another Organization's failures", async () => {
      await seedFailed(OTHER_ORG);

      const res = await request(server())
        .get("/admin/events/failed")
        .set(as(OWNER))
        .expect(200);

      expect(res.body.items).toEqual([]);
    });

    it("denies a Member both inspection and retry", async () => {
      const eventId = await seedFailed(ORG);

      await request(server()).get("/admin/events/failed").set(as(MEMBER)).expect(403);
      await request(server())
        .post(`/admin/events/${eventId}/retry`)
        .set(as(MEMBER))
        .expect(403);
    });

    it("returns a failed delivery to Pending without erasing attempt_count", async () => {
      const eventId = await seedFailed(ORG, { attemptCount: 5 });

      await request(server())
        .post(`/admin/events/${eventId}/retry`)
        .set(as(OWNER))
        .expect(204);

      // The evidence of how hard the system already tried survives the retry,
      // which is what stops a poisonous message from cycling forever while
      // looking untouched.
      expect(await rowOf(eventId)).toEqual({ status: "Pending", attempt_count: 5 });
    });

    it("reports another Organization's failed event as 404, not 403", async () => {
      const eventId = await seedFailed(OTHER_ORG);

      await request(server())
        .post(`/admin/events/${eventId}/retry`)
        .set(as(OWNER))
        .expect(404);

      expect(await rowOf(eventId)).toMatchObject({ status: "Failed" });
    });

    it("refuses to retry an event that is not Failed", async () => {
      const eventId = await seedFailed(ORG);
      await request(server())
        .post(`/admin/events/${eventId}/retry`)
        .set(as(OWNER))
        .expect(204);

      // Now Pending. A second retry must not reset the schedule of a message
      // that is already queued.
      await request(server())
        .post(`/admin/events/${eventId}/retry`)
        .set(as(OWNER))
        .expect(404);
    });

    it("rejects a malformed event id as a client error", async () => {
      await request(server())
        .post("/admin/events/not-a-uuid/retry")
        .set(as(OWNER))
        .expect(400);
    });

    it("exposes no route for the recovery operations that need a consumer policy", async () => {
      // Skip and the two replays assert something about the original delivery,
      // and deciding whether that assertion is safe needs a registered
      // ConsumerRegistration. Absent, not silently permitted.
      const eventId = await seedFailed(ORG);
      await request(server())
        .post(`/admin/events/${eventId}/skip`)
        .set(as(OWNER))
        .expect(404);
      await request(server())
        .post("/admin/events/replay/consumer")
        .set(as(OWNER))
        .expect(404);
      await request(server())
        .post("/admin/events/replay/projection")
        .set(as(OWNER))
        .expect(404);
    });
  });
});
