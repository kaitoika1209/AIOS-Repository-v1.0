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
        // `authorization_audit_records` is listed explicitly: it holds no
        // foreign keys — deliberately, so a row outlives whatever it refers to —
        // so `CASCADE` from the business tables never reaches it.
        `TRUNCATE decision_revisions, decisions, work_items, outbox_messages,
                  authorization_audit_records,
                  notifications,
                  decision_secretary_contributions, secretary_assistance_grants,
                  dead_letter_events, event_replays, processed_events,
                  consumer_ordering_state,
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

  /**
   * The audit rows for one permission, oldest first.
   *
   * Polled rather than read once: the interceptor never awaits its write into
   * the response, on purpose — an audit outage must not become an availability
   * outage — so the row lands shortly after the request resolves.
   */
  const auditRows = async (permission: string, expected = 1) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await pool.query(
        `SELECT * FROM authorization_audit_records
          WHERE permission = $1 ORDER BY evaluated_at, created_at`,
        [permission],
      );
      if (result.rows.length >= expected) return result.rows;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no audit row for ${permission} after 500ms`);
  };

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

  describe("request correlation (baseline item 3)", () => {
    it("ties the audit row and the Outbox event to one identifier", async () => {
      // The property the whole item exists for, and the one that was false: the
      // edge audit, the use-case audit, and the Outbox each minted their own
      // `correlationId`, so a single request produced three unrelated values and
      // nothing could be followed from the command to the event it caused.
      const res = await request(server())
        .post("/works")
        .set(as(MEMBER))
        .send({ title: "Correlated" })
        .expect(201);

      const returned = res.headers["x-correlation-id"];
      expect(returned).toMatch(/^[0-9a-f-]{36}$/);

      const audit = await pool.query(
        `SELECT correlation_id, request_id FROM authorization_audit_records
          WHERE permission = 'work.create' ORDER BY created_at DESC LIMIT 1`,
      );
      const outbox = await pool.query(
        `SELECT correlation_id FROM outbox_messages
          WHERE aggregate_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [res.body.workId],
      );

      expect(audit.rows[0]?.correlation_id).toBe(returned);
      expect(outbox.rows[0]?.correlation_id).toBe(returned);
    });

    it("gives two requests two identifiers", async () => {
      // Guards against the opposite failure — a constant, or a value cached
      // across requests, would satisfy the test above and correlate nothing.
      const first = await request(server())
        .post("/works").set(as(MEMBER)).send({ title: "One" }).expect(201);
      const second = await request(server())
        .post("/works").set(as(MEMBER)).send({ title: "Two" }).expect(201);

      expect(first.headers["x-correlation-id"]).not.toBe(
        second.headers["x-correlation-id"],
      );
    });

    it("returns its own identifier, never the caller's", async () => {
      // "public API responses return the server-owned `correlationId`, not the
      // caller-supplied value."
      const res = await request(server())
        .post("/works")
        .set(as(MEMBER))
        .set("x-external-correlation-id", "client-chosen-value")
        .send({ title: "Not yours" })
        .expect(201);

      expect(res.headers["x-correlation-id"]).not.toBe("client-chosen-value");

      const audit = await pool.query(
        `SELECT correlation_id FROM authorization_audit_records
          WHERE permission = 'work.create' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(audit.rows[0]?.correlation_id).not.toBe("client-chosen-value");
    });

    it("correlates a refusal, which the guard writes before any interceptor runs", async () => {
      // Why the correlation is middleware and not an interceptor. Nest runs
      // guards before interceptors, so a refusal's audit row is written before
      // an interceptor could establish anything — and a refused request is the
      // one an investigation most often starts from.
      const res = await request(server())
        .get("/works")
        .set({ "x-dev-subject": OUTSIDER.subject, "x-organization-id": ORG })
        .expect(404);

      expect(res.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);

      // Polled, because the guard deliberately does not await its audit write —
      // an audit outage must not become an availability outage — so the row
      // lands shortly after the response.
      let denial: { correlation_id: string } | undefined;
      for (let attempt = 0; attempt < 50 && denial === undefined; attempt += 1) {
        const rows = await pool.query<{ correlation_id: string }>(
          `SELECT correlation_id FROM authorization_audit_records
            WHERE outcome = 'Deny' ORDER BY created_at DESC LIMIT 1`,
        );
        denial = rows.rows[0];
        if (denial === undefined) await new Promise((r) => setTimeout(r, 10));
      }

      expect(denial?.correlation_id).toBe(res.headers["x-correlation-id"]);
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

      // "ReopenRejectedMemory | Editor, related Work Member, or Admin" — the
      // same required relationship as editing and submitting, because reopening
      // is what makes the draft editable again. So the permission is not what
      // separates callers here; the relationship is. STRANGER holds every
      // ordinary Member permission and no relationship to this Memory.
      await request(server())
        .post(`/memories/${draft.memoryId}/reopen`)
        .set(as(STRANGER))
        .expect(403);

      const reopened = await request(server())
        .post(`/memories/${draft.memoryId}/reopen`)
        .set(as(MEMBER))
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


  describe("Organization creation", () => {
    /**
     * A subject with no Identity and no Membership anywhere.
     *
     * Not seeded in `beforeEach`: the point is that creation works for someone
     * the system has never seen, which is the only way the first Organization
     * can ever exist.
     */
    const FOUNDER = { subject: "founder-1", email: "founder@example.test" };

    const asFounder = () => ({
      "x-dev-subject": FOUNDER.subject,
      "x-dev-display-name": "Olivia Reed",
      "x-dev-email": FOUNDER.email,
    });

    it("creates an Organization for a subject with no Membership at all", async () => {
      // No `x-organization-id`: the route is exempt from Organization
      // resolution, because the Organization does not exist yet.
      const res = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Northwind" })
        .expect(201);

      expect(res.body).toMatchObject({ name: "Northwind", status: "Active", version: 1 });
      expect(res.body.organizationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.membershipId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("makes the creator an active Owner who can immediately act", async () => {
      const created = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Northwind" })
        .expect(201);

      const scoped = {
        "x-dev-subject": FOUNDER.subject,
        "x-organization-id": created.body.organizationId,
      };

      // The bootstrap invariant, observed from outside: the Organization is
      // Active and its Owner already holds authority in the same request cycle.
      const members = await request(server())
        .get(`/organizations/${created.body.organizationId}/members`)
        .set(scoped)
        .expect(200);

      expect(members.body.items).toHaveLength(1);
      expect(members.body.items[0]).toMatchObject({
        membershipId: created.body.membershipId,
        status: "Active",
        roles: ["OrganizationOwner"],
      });

      await request(server())
        .post("/works")
        .set(scoped)
        .send({ title: "First Work" })
        .expect(201);
    });

    it("lists the caller's own Organizations, and nobody else's", async () => {
      // The route A2 needed and the API did not have. Without it a client can
      // be told which single Organization to use, but cannot offer a choice.
      const first = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Zephyr" })
        .expect(201);
      const second = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Acme Holdings" })
        .expect(201);

      // No `x-organization-id`, deliberately: requiring it would mean naming an
      // Organization in order to ask which Organizations may be named.
      const mine = await request(server())
        .get("/organizations")
        .set(asFounder())
        .expect(200);

      expect(mine.body.organizations.map((o: { name: string }) => o.name)).toEqual([
        "Acme Holdings",
        "Zephyr",
      ]);
      expect(mine.body.organizations.map((o: { organizationId: string }) => o.organizationId))
        .toEqual([second.body.organizationId, first.body.organizationId]);

      // MEMBER is seeded into ORG by `beforeEach` and has no Membership in
      // either of the two above. Tenant isolation on this route
      // comes from the query being derived from the subject — there is no
      // header here to check, so nothing else could be enforcing it.
      const hers = await request(server())
        .get("/organizations")
        .set({ "x-dev-subject": MEMBER.subject })
        .expect(200);

      const ids = hers.body.organizations.map((o: { organizationId: string }) => o.organizationId);
      expect(ids).not.toContain(first.body.organizationId);
      expect(ids).not.toContain(second.body.organizationId);
    });

    it("is empty for an authenticated subject that belongs to nothing", async () => {
      const res = await request(server())
        .get("/organizations")
        .set({ "x-dev-subject": "nobody-at-all" })
        .expect(200);

      // Empty rather than 404: belonging to nothing is an ordinary state, and a
      // 404 would say the route was wrong rather than the answer empty.
      expect(res.body.organizations).toEqual([]);
    });

    it("refuses an unauthenticated caller", async () => {
      // Exempt from Organization resolution, and only from that. The route
      // still requires a verified subject — it is the subject that scopes it.
      await request(server()).get("/organizations").expect(401);
    });

    it("keeps a Suspended Organization listed, so its Owner can reach reactivate", async () => {
      const created = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Northwind" })
        .expect(201);

      const scoped = {
        "x-dev-subject": FOUNDER.subject,
        "x-organization-id": created.body.organizationId,
      };
      await request(server())
        .post(`/organizations/${created.body.organizationId}/suspend`)
        .set(scoped)
        .send({ reason: "Billing lapsed." })
        .expect(201);

      const listed = await request(server())
        .get("/organizations")
        .set(asFounder())
        .expect(200);

      const found = listed.body.organizations.find(
        (o: { organizationId: string }) => o.organizationId === created.body.organizationId,
      );
      expect(found).toMatchObject({ status: "Suspended", roles: ["OrganizationOwner"] });

      // And the path it exists to keep open actually works from there.
      await request(server())
        .post(`/organizations/${created.body.organizationId}/reactivate`)
        .set(scoped)
        .send({ reason: "Billing settled." })
        .expect(201);
    });

    it("creates the Human Identity, and reuses it for a second Organization", async () => {
      const first = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "First" })
        .expect(201);
      const second = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Second" })
        .expect(201);

      expect(second.body.organizationId).not.toBe(first.body.organizationId);

      const client = await pool.connect();
      try {
        const identities = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM authentication_subjects WHERE subject = $1`,
          [FOUNDER.subject],
        );
        // "A person may have Memberships in multiple Organizations" — one
        // Identity, two Organizations.
        expect(identities.rows[0]!.n).toBe(1);

        const memberships = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM memberships m
             JOIN human_identities h ON h.identity_id = m.identity_id
             JOIN authentication_subjects s ON s.identity_id = h.identity_id
            WHERE s.subject = $1`,
          [FOUNDER.subject],
        );
        expect(memberships.rows[0]!.n).toBe(2);
      } finally {
        client.release();
      }
    });

    it("writes the Owner role assignment", async () => {
      const created = await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Northwind" })
        .expect(201);

      const client = await pool.connect();
      try {
        const roles = await client.query<{
          role: string;
          assigned_by_membership_id: string;
        }>(
          `SELECT role, assigned_by_membership_id FROM membership_role_assignments
            WHERE membership_id = $1`,
          [created.body.membershipId],
        );
        // The creator is their own assigner: there is no earlier actor to
        // attribute the first Owner role to.
        expect(roles.rows[0]).toEqual({
          role: "OrganizationOwner",
          assigned_by_membership_id: created.body.membershipId,
        });
      } finally {
        client.release();
      }
    });

    it("writes nothing when the name is rejected", async () => {
      await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "   " })
        .expect(400);

      const client = await pool.connect();
      try {
        const subjects = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM authentication_subjects WHERE subject = $1`,
          [FOUNDER.subject],
        );
        // The Identity is created inside the same transaction, so a refusal
        // leaves no orphan behind.
        expect(subjects.rows[0]!.n).toBe(0);
      } finally {
        client.release();
      }
    });

    it("refuses an unauthenticated caller", async () => {
      await request(server())
        .post("/organizations")
        .send({ name: "Anonymous" })
        .expect(401);
    });

    it("emits OrganizationCreated and MembershipActivated", async () => {
      await request(server())
        .post("/organizations")
        .set(asFounder())
        .send({ name: "Northwind" })
        .expect(201);

      const client = await pool.connect();
      try {
        const rows = await client.query<{ event_type: string; aggregate_type: string }>(
          `SELECT event_type, aggregate_type FROM outbox_messages
            ORDER BY recorded_at, event_sequence`,
        );
        expect(rows.rows).toEqual([
          { event_type: "OrganizationCreated", aggregate_type: "Organization" },
          { event_type: "MembershipActivated", aggregate_type: "Membership" },
        ]);
      } finally {
        client.release();
      }
    });

    it("renames, and refuses a Member renaming", async () => {
      const renamed = await request(server())
        .patch(`/organizations/${ORG}`)
        .set(as(OWNER))
        .send({ name: "Renamed Org" })
        .expect(200);
      expect(renamed.body.name).toBe("Renamed Org");

      await request(server())
        .patch(`/organizations/${ORG}`)
        .set(as(MEMBER))
        .send({ name: "Mine now" })
        .expect(403);
    });

    it("reports another Organization in the path as 404", async () => {
      await request(server())
        .patch(`/organizations/${OTHER_ORG}`)
        .set(as(OWNER))
        .send({ name: "Not mine" })
        .expect(404);
      await request(server())
        .get(`/organizations/${OTHER_ORG}`)
        .set(as(OWNER))
        .expect(404);
    });
  });

  /**
   * The Owner-held Organization lifecycle (ADR-0017).
   *
   * These are the tests that only exist at this level, because the property the
   * design turns on is a property of the guard: while an Organization is
   * Suspended, `PrincipalResolver` refuses every request in it, so reactivation
   * is reachable only through ADR-0014's status exemption. Nothing below HTTP
   * can demonstrate that.
   */
  describe("the Organization lifecycle", () => {
    const suspend = (who = OWNER, reason = "Pausing operations.") =>
      request(server())
        .post(`/organizations/${ORG}/suspend`)
        .set(as(who))
        .send({ reason });

    it("suspends, locks the Organization, and reactivates", async () => {
      await suspend().expect(201);

      // Every ordinary route is now 404 — not 403. The Organization's
      // availability is not something a caller may probe.
      await request(server()).get("/works").set(as(OWNER)).expect(404);
      await request(server()).post("/works").set(as(MEMBER)).send({ title: "x" }).expect(404);

      const back = await request(server())
        .post(`/organizations/${ORG}/reactivate`)
        .set(as(OWNER))
        .send({ reason: "Resuming." })
        .expect(201);
      expect(back.body.status).toBe("Active");

      await request(server()).get("/works").set(as(OWNER)).expect(200);
    });

    /**
     * The exemption is exactly one route wide. If it leaked to the controller or
     * to any sibling, suspension would stop meaning anything.
     */
    it("exempts reactivation alone, not its neighbours", async () => {
      await suspend().expect(201);

      for (const path of [
        `/organizations/${ORG}/suspend`,
        `/organizations/${ORG}/archive`,
      ]) {
        await request(server())
          .post(path)
          .set(as(OWNER))
          .send({ reason: "While suspended." })
          .expect(404);
      }
      await request(server())
        .patch(`/organizations/${ORG}`)
        .set(as(OWNER))
        .send({ name: "Renamed" })
        .expect(404);
      await request(server()).get(`/organizations/${ORG}`).set(as(OWNER)).expect(404);
    });

    /**
     * The exemption widens the Organization-status check and nothing else. A
     * Member of a suspended Organization still resolves — and is still refused,
     * on the permission.
     */
    it("still refuses a non-Owner on the exempt route", async () => {
      await suspend().expect(201);

      await request(server())
        .post(`/organizations/${ORG}/reactivate`)
        .set(as(MEMBER))
        .send({ reason: "Let me out." })
        .expect(403);
      await request(server())
        .post(`/organizations/${ORG}/reactivate`)
        .set(as(REVIEWER))
        .send({ reason: "Let me out." })
        .expect(403);
    });

    it("refuses an outsider on the exempt route as absent", async () => {
      await suspend().expect(201);

      // The exemption does not make a suspended Organization discoverable.
      await request(server())
        .post(`/organizations/${ORG}/reactivate`)
        .set(as(OUTSIDER, ORG))
        .send({ reason: "Mine now." })
        .expect(404);
    });

    it("gives the lifecycle to the Owner alone", async () => {
      for (const who of [MEMBER, REVIEWER]) {
        await request(server())
          .post(`/organizations/${ORG}/suspend`)
          .set(as(who))
          .send({ reason: "Mine now." })
          .expect(403);
        await request(server())
          .post(`/organizations/${ORG}/archive`)
          .set(as(who))
          .send({ reason: "Mine now." })
          .expect(403);
      }
    });

    it("requires a reason on every lifecycle command", async () => {
      for (const path of ["suspend", "archive"]) {
        await request(server())
          .post(`/organizations/${ORG}/${path}`)
          .set(as(OWNER))
          .send({})
          .expect(400);
        // Present but blank is the Aggregate's refusal, not the edge's.
        await request(server())
          .post(`/organizations/${ORG}/${path}`)
          .set(as(OWNER))
          .send({ reason: "   " })
          .expect(422);
      }
    });

    it("refuses archival while Work is live, and allows it once resolved", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .send({ expectedVersion: work.version })
        .expect(201);

      const refused = await request(server())
        .post(`/organizations/${ORG}/archive`)
        .set(as(OWNER))
        .send({ reason: "Closing." })
        .expect(409);
      // The count, not the identifiers: a refusal must not become a listing of
      // Work the caller holds no relationship to.
      expect(refused.body.message).toContain("1");
      expect(JSON.stringify(refused.body)).not.toContain(work.workId);

      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ expectedVersion: work.version + 1, completionSummary: "Done." })
        .expect(201);

      await request(server())
        .post(`/organizations/${ORG}/archive`)
        .set(as(OWNER))
        .send({ reason: "Closing." })
        .expect(201);
    });

    it("locks an archived Organization with no way back", async () => {
      await request(server())
        .post(`/organizations/${ORG}/archive`)
        .set(as(OWNER))
        .send({ reason: "Closing." })
        .expect(201);

      await request(server()).get("/works").set(as(OWNER)).expect(404);
      // Archival is terminal, so the recovery exemption does not cover it. This
      // is the assertion that keeps `allowSuspended` from becoming
      // `allowNotActive`.
      await request(server())
        .post(`/organizations/${ORG}/reactivate`)
        .set(as(OWNER))
        .send({ reason: "Reopen." })
        .expect(404);
    });

    it("archives a suspended Organization without a detour through Active", async () => {
      await suspend().expect(201);
      // Not reachable over HTTP while suspended — archive is not exempt — so the
      // Owner reactivates first. The Aggregate permits Suspended → Archived;
      // the route is what requires the detour, and that is worth stating.
      await request(server())
        .post(`/organizations/${ORG}/archive`)
        .set(as(OWNER))
        .send({ reason: "Closing." })
        .expect(404);
    });

    it("records the lifecycle transitions in the audit", async () => {
      await suspend().expect(201);
      await request(server())
        .post(`/organizations/${ORG}/reactivate`)
        .set(as(OWNER))
        .send({ reason: "Resuming." })
        .expect(201);

      const rows = await auditRows("organization.suspend", 2);
      const transition = rows.find((r) => r.command_type === "SuspendOrganization");
      expect(transition).toMatchObject({
        outcome: "Allow",
        previous_state: "Active",
        next_state: "Suspended",
        resource_type: "Organization",
        membership_id: OWNER.membership,
      });
    });

    it("writes one event per transition", async () => {
      await suspend().expect(201);
      await request(server())
        .post(`/organizations/${ORG}/reactivate`)
        .set(as(OWNER))
        .send({ reason: "Resuming." })
        .expect(201);

      const events = await pool.query<{ event_type: string; payload: { reason: string } }>(
        `SELECT event_type, payload FROM outbox_messages
          WHERE aggregate_type = 'Organization'
          ORDER BY aggregate_version`,
      );
      expect(events.rows.map((r) => r.event_type)).toEqual([
        "OrganizationSuspended",
        "OrganizationReactivated",
      ]);
      expect(events.rows[0]?.payload.reason).toBe("Pausing operations.");
    });
  });

  /**
   * Role assignment (ADR-0018).
   *
   * Against the real schema, where `uq_membership_role_assignments_active` and
   * the append-only revocation columns are enforced by the database rather than
   * by a double.
   */
  describe("role assignment", () => {
    const members = `/organizations/${ORG}/members`;

    const assign = (target: string, role: string, who = OWNER) =>
      request(server())
        .post(`${members}/${target}/assign-role`)
        .set(as(who))
        .send({ role });

    const revoke = (target: string, role: string, who = OWNER, reason = "Reassigned.") =>
      request(server())
        .post(`${members}/${target}/revoke-role`)
        .set(as(who))
        .send({ role, reason });

    const rolesOf = async (target: string) => {
      const res = await request(server()).get(members).set(as(OWNER)).expect(200);
      const found = (res.body.items as { membershipId: string; roles: string[] }[]).find(
        (m) => m.membershipId === target,
      );
      return found?.roles ?? [];
    };

    it("grants a role and the Member can immediately use it", async () => {
      // STRANGER is a plain Member: no `memory.approve`, so no review authority.
      await assign(STRANGER.membership, "Reviewer").expect(201);
      expect(await rolesOf(STRANGER.membership)).toContain("Reviewer");

      const rows = await pool.query(
        `SELECT role, revoked_at, assigned_by_identity_id
           FROM membership_role_assignments
          WHERE membership_id = $1 AND role = 'Reviewer'`,
        [STRANGER.membership],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        revoked_at: null,
        // Attribution the Membership row has nowhere to hold.
        assigned_by_identity_id: OWNER.identity,
      });
    });

    it("stamps the assignment on revocation instead of deleting it", async () => {
      await assign(STRANGER.membership, "Reviewer").expect(201);
      await revoke(STRANGER.membership, "Reviewer", OWNER, "Moving off review.").expect(201);

      expect(await rolesOf(STRANGER.membership)).not.toContain("Reviewer");

      const rows = await pool.query(
        `SELECT revoked_at, revocation_reason, revoked_by_identity_id
           FROM membership_role_assignments
          WHERE membership_id = $1 AND role = 'Reviewer'`,
        [STRANGER.membership],
      );
      // The row survives. "There is no direct mutable role-array replacement
      // without audit events."
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        revocation_reason: "Moving off review.",
        revoked_by_identity_id: OWNER.identity,
      });
      expect(rows.rows[0]?.revoked_at).not.toBeNull();
    });

    it("can re-grant a role that was revoked, leaving both rows", async () => {
      await assign(STRANGER.membership, "Reviewer").expect(201);
      await revoke(STRANGER.membership, "Reviewer").expect(201);
      await assign(STRANGER.membership, "Reviewer").expect(201);

      // Two rows for the same (membership, role): one revoked, one active.
      // `uq_membership_role_assignments_active` permits that and only that.
      const rows = await pool.query(
        `SELECT revoked_at FROM membership_role_assignments
          WHERE membership_id = $1 AND role = 'Reviewer'`,
        [STRANGER.membership],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
    });

    it("refuses a duplicate grant rather than writing a second active row", async () => {
      await assign(STRANGER.membership, "Reviewer").expect(201);
      await assign(STRANGER.membership, "Reviewer").expect(422);
    });

    it("refuses to revoke a role the Member does not hold", async () => {
      await revoke(STRANGER.membership, "Reviewer").expect(422);
    });

    it("refuses an unknown role at the edge", async () => {
      await request(server())
        .post(`${members}/${STRANGER.membership}/assign-role`)
        .set(as(OWNER))
        .send({ role: "Superuser" })
        .expect(400);
    });

    it("requires a reason to revoke", async () => {
      await assign(STRANGER.membership, "Reviewer").expect(201);
      await request(server())
        .post(`${members}/${STRANGER.membership}/revoke-role`)
        .set(as(OWNER))
        .send({ role: "Reviewer" })
        .expect(400);
    });

    it("lets an Admin grant an ordinary role but not Ownership", async () => {
      await assign(MEMBER.membership, "OrganizationAdmin").expect(201);

      await assign(STRANGER.membership, "Reviewer", MEMBER).expect(201);
      // The target role narrows the actor, even though the Admin holds the
      // permission.
      await assign(STRANGER.membership, "OrganizationOwner", MEMBER).expect(403);
      await revoke(MEMBER.membership, "OrganizationAdmin", MEMBER, "x").expect(201);
    });

    it("refuses every self-assignment, including the Owner's own", async () => {
      await assign(OWNER.membership, "Reviewer", OWNER).expect(403);
    });

    it("gives the permission to nobody below Admin", async () => {
      await assign(STRANGER.membership, "Reviewer", REVIEWER).expect(403);
      await revoke(STRANGER.membership, "Member", REVIEWER).expect(403);
    });

    /**
     * The dead end this change exists to close, end to end. The Organization
     * seeds exactly one Owner, so before this the Owner Membership could never
     * be suspended, revoked, or replaced while the Organization was Active.
     */
    it("closes the Last Owner dead end", async () => {
      await request(server())
        .post(`${members}/${OWNER.membership}/suspend`)
        .set(as(OWNER))
        .send({ reason: "Stepping back." })
        .expect(409);

      // "The Organization must first: assign another Owner."
      await assign(STRANGER.membership, "OrganizationOwner").expect(201);

      await request(server())
        .post(`${members}/${OWNER.membership}/suspend`)
        .set(as(OWNER))
        .send({ reason: "Stepping back." })
        .expect(201);
    });

    it("refuses to revoke Ownership from the last active Owner", async () => {
      await revoke(OWNER.membership, "OrganizationOwner", OWNER, "Leaving.").expect(409);
    });

    it("records the grant in the audit", async () => {
      await assign(STRANGER.membership, "Reviewer").expect(201);

      const [row] = await auditRows("organization.assign_role");
      expect(row).toMatchObject({
        outcome: "Allow",
        resource_type: "Membership",
        resource_id: STRANGER.membership,
        membership_id: OWNER.membership,
      });
    });

    it("writes one event per role change, on the Membership stream", async () => {
      await assign(STRANGER.membership, "Reviewer").expect(201);
      await revoke(STRANGER.membership, "Reviewer").expect(201);

      const events = await pool.query<{ event_type: string; aggregate_type: string }>(
        `SELECT event_type, aggregate_type FROM outbox_messages
          WHERE event_type LIKE 'OrganizationRole%'
          ORDER BY aggregate_version`,
      );
      expect(events.rows).toEqual([
        { event_type: "OrganizationRoleAssigned", aggregate_type: "Membership" },
        { event_type: "OrganizationRoleRevoked", aggregate_type: "Membership" },
      ]);
    });
  });

  describe("Member lifecycle", () => {
    const members = `/organizations/${ORG}/members`;

    it("suspends a Member, whose authority stops immediately", async () => {
      const res = await request(server())
        .post(`${members}/${MEMBER.membership}/suspend`)
        .set(as(OWNER))
        .send({ reason: "On leave" })
        .expect(201);

      expect(res.body.status).toBe("Suspended");

      // "existing sessions must fail current Membership validation" — the
      // principal resolver declines to issue one, so every route refuses.
      await request(server()).get("/works").set(as(MEMBER)).expect(404);
    });

    it("reactivates a suspended Member with the roles that were retained", async () => {
      await request(server())
        .post(`${members}/${MEMBER.membership}/suspend`)
        .set(as(OWNER))
        .send({ reason: "On leave" })
        .expect(201);

      await request(server())
        .post(`${members}/${MEMBER.membership}/reactivate`)
        .set(as(OWNER))
        .send({ reason: "Returned" })
        .expect(201);

      // Not reissued, restored: role assignments were never removed.
      const work = await request(server())
        .post("/works")
        .set(as(MEMBER))
        .send({ title: "Back at it" })
        .expect(201);
      expect(work.body.workId).toBeDefined();
    });

    it("revokes a Member permanently", async () => {
      const res = await request(server())
        .post(`${members}/${MEMBER.membership}/revoke`)
        .set(as(OWNER))
        .send({ reason: "Left the company" })
        .expect(201);

      expect(res.body.status).toBe("Revoked");
      await request(server()).get("/works").set(as(MEMBER)).expect(404);

      // Terminal: there is no reinstatement command.
      await request(server())
        .post(`${members}/${MEMBER.membership}/reactivate`)
        .set(as(OWNER))
        .send({ reason: "Changed our minds" })
        .expect(409);
    });

    it("refuses to remove the only active Owner", async () => {
      // The Last Owner Invariant. Reported as 409, not 422: the caller can
      // change the outcome by appointing another Owner first.
      await request(server())
        .post(`${members}/${OWNER.membership}/revoke`)
        .set(as(OWNER))
        .send({ reason: "Leaving" })
        .expect(409);

      await request(server())
        .post(`${members}/${OWNER.membership}/suspend`)
        .set(as(OWNER))
        .send({ reason: "On leave" })
        .expect(409);
    });

    it("refuses self-removal even when another Owner remains", async () => {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE membership_role_assignments SET role = 'OrganizationOwner'
            WHERE membership_id = $1`,
          [STRANGER.membership],
        );
      } finally {
        client.release();
      }

      // The invariant is satisfied, so what refuses this is the self-removal
      // rule: revoking your own Membership spends the authority that authorized
      // the request.
      await request(server())
        .post(`${members}/${OWNER.membership}/revoke`)
        .set(as(OWNER))
        .send({ reason: "Leaving" })
        .expect(422);
    });

    it("requires a reason for every lifecycle command", async () => {
      for (const command of ["suspend", "reactivate", "revoke"]) {
        await request(server())
          .post(`${members}/${MEMBER.membership}/${command}`)
          .set(as(OWNER))
          .send({})
          .expect(400);
      }
    });

    it("denies a Member and a Reviewer every lifecycle command", async () => {
      for (const who of [MEMBER, REVIEWER]) {
        for (const command of ["suspend", "reactivate", "revoke"]) {
          await request(server())
            .post(`${members}/${STRANGER.membership}/${command}`)
            .set(as(who))
            .send({ reason: "Mine now" })
            .expect(403);
        }
      }
    });

    it("reports another Organization's Membership as 404", async () => {
      await request(server())
        .post(`${members}/${OUTSIDER.membership}/suspend`)
        .set(as(OWNER))
        .send({ reason: "Not mine" })
        .expect(404);
    });

    it("emits the registered lifecycle events", async () => {
      await request(server())
        .post(`${members}/${MEMBER.membership}/suspend`)
        .set(as(OWNER))
        .send({ reason: "On leave" })
        .expect(201);
      await request(server())
        .post(`${members}/${MEMBER.membership}/reactivate`)
        .set(as(OWNER))
        .send({ reason: "Returned" })
        .expect(201);
      await request(server())
        .post(`${members}/${MEMBER.membership}/revoke`)
        .set(as(OWNER))
        .send({ reason: "Left" })
        .expect(201);

      const client = await pool.connect();
      try {
        const rows = await client.query<{ event_type: string; aggregate_type: string }>(
          `SELECT event_type, aggregate_type FROM outbox_messages
            ORDER BY recorded_at, event_sequence`,
        );
        expect(rows.rows).toEqual([
          { event_type: "MembershipSuspended", aggregate_type: "Membership" },
          { event_type: "MembershipReactivated", aggregate_type: "Membership" },
          { event_type: "MembershipRevoked", aggregate_type: "Membership" },
        ]);
      } finally {
        client.release();
      }
    });
  });

  /**
   * Granting and revoking the Secretary's advisory operations (ADR-0019).
   *
   * Against the real schema, where `uq_secretary_grants_active` admits one
   * active grant per five-field identity and the revocation columns are
   * enforced by the database.
   */
  describe("assistance grants", () => {
    const grants = `/organizations/${ORG}/assistance-grants`;

    const grant = (who = OWNER, operation = "decision.draft_material") =>
      request(server())
        .post(grants)
        .set(as(who))
        .send({ operation, reason: "Enabling Decision drafting." });

    const revoke = (who = OWNER, operation = "decision.draft_material") =>
      request(server()).post(`${grants}/revoke`).set(as(who)).send({ operation });

    const activeGrants = async () => {
      const rows = await pool.query<{ assistance_operation: string }>(
        `SELECT assistance_operation FROM secretary_assistance_grants
          WHERE organization_id = $1 AND revoked_at IS NULL`,
        [ORG],
      );
      return rows.rows.map((r) => r.assistance_operation);
    };

    it("grants an operation and resolves its context from the registry", async () => {
      const res = await grant().expect(201);

      // The caller named an operation; the context and contract version came
      // from the declared registry, never from the body.
      expect(res.body).toEqual({
        operation: "decision.draft_material",
        contextKey: "Decision",
        portContractVersion: 1,
      });
      expect(await activeGrants()).toEqual(["decision.draft_material"]);
    });

    it("stamps the grant on revocation instead of deleting it", async () => {
      await grant().expect(201);
      await revoke().expect(201);

      expect(await activeGrants()).toEqual([]);
      const rows = await pool.query<{ revoked_by_membership_id: string }>(
        `SELECT revoked_by_membership_id FROM secretary_assistance_grants
          WHERE organization_id = $1`,
        [ORG],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.revoked_by_membership_id).toBe(OWNER.membership);
    });

    it("can re-grant after revoking, leaving both rows", async () => {
      await grant().expect(201);
      await revoke().expect(201);
      await grant().expect(201);

      // `uq_secretary_grants_active` constrains active rows only, so the history
      // survives beside the current grant.
      const rows = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM secretary_assistance_grants WHERE organization_id = $1`,
        [ORG],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
    });

    it("grants idempotently rather than writing a second active row", async () => {
      await grant().expect(201);
      await grant().expect(201);
      expect(await activeGrants()).toEqual(["decision.draft_material"]);
    });

    it("reports revoking what is not granted as absent", async () => {
      await revoke().expect(404);
    });

    it("refuses an operation the build does not declare", async () => {
      await request(server())
        .post(grants)
        .set(as(OWNER))
        .send({ operation: "decision.approve", reason: "Widening the port." })
        .expect(422);
      await request(server())
        .post(grants)
        .set(as(OWNER))
        .send({ reason: "No operation." })
        .expect(400);
    });

    it("gives both commands to Owner and Admin, and to nobody else", async () => {
      for (const who of [MEMBER, REVIEWER]) {
        await grant(who).expect(403);
        await revoke(who).expect(403);
      }
    });

    /**
     * The behaviour the grant exists to gate. Revoking it stops the Secretary
     * from drafting, without touching anything the Decision already holds.
     */
    it("stops the Secretary drafting once revoked", async () => {
      await grant().expect(201);

      const work = await createWork();
      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Which database?",
          question: "Which database should we standardise on?",
          options: [{ optionId: "pg", summary: "PostgreSQL" }],
        })
        .expect(201);

      await request(server())
        .post(`/decisions/${decision.body.decisionId}/assistance`)
        .set(as(MEMBER))
        .send({ operation: "decision.draft_material" })
        .expect(201);

      await revoke().expect(201);

      await request(server())
        .post(`/decisions/${decision.body.decisionId}/assistance`)
        .set(as(MEMBER))
        .send({ operation: "decision.draft_material" })
        .expect(422);
    });
  });

  describe("Secretary assistance (ADR-0011)", () => {
    /** A Draft Decision, with the Work it belongs to so it can be re-read. */
    const draft = async () => {
      const work = await createWork();
      const decision = await request(server())
        .post("/decisions")
        .set(as(MEMBER))
        .send({
          relatedWorkId: work.workId,
          title: "Which database?",
          question: "Which database should we standardise on?",
          options: [{ optionId: "pg", summary: "PostgreSQL" }],
          isBlocking: true,
        })
        .expect(201);
      return { decisionId: decision.body.decisionId as string, workId: work.workId };
    };

    /** There is no `GET /decisions/{id}`; decisions are read through their Work. */
    const reread = async (workId: string) => {
      const res = await request(server())
        .get(`/decisions/by-work/${workId}`)
        .set(as(MEMBER))
        .expect(200);
      return res.body.items[0];
    };

    const grant = async (overrides: Record<string, unknown> = {}) => {
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO secretary_assistance_grants
             (grant_id, organization_id, secretary_principal_id, context_key,
              assistance_operation, port_contract_version,
              granted_at, granted_by_membership_id, reason)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), $6, 'test')`,
          [
            ORG,
            overrides["secretaryPrincipalId"] ?? "decision-secretary",
            overrides["contextKey"] ?? "Decision",
            overrides["assistanceOperation"] ?? "decision.draft_material",
            overrides["portContractVersion"] ?? 1,
            OWNER.membership,
          ],
        );
      } finally {
        client.release();
      }
    };

    it("refuses assistance with no active grant, and grants nothing on refusal", async () => {
      const { decisionId } = await draft();

      // Deny by default. The route exists and the caller holds the permission;
      // what is missing is the Organization's grant.
      await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(422);

      const listed = await request(server())
        .get(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(200);
      expect(listed.body.items).toEqual([]);
    });

    it("produces an advisory contribution that changes no Decision content", async () => {
      const { decisionId, workId } = await draft();
      await grant();

      const before = await reread(workId);

      const res = await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(201);

      expect(res.body).toMatchObject({
        contributionType: "DecisionMaterialDraft",
        authoredBy: "AI",
        secretaryPrincipalId: "decision-secretary",
        requestedByMembershipId: MEMBER.membership,
        adoptedAt: null,
      });

      // The Decision is untouched: same version, same question.
      expect(await reread(workId)).toEqual(before);
    });

    it("refuses a grant for another Secretary or another contract version", async () => {
      const { decisionId } = await draft();
      await grant({ secretaryPrincipalId: "some-other-secretary" });
      await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(422);

      await grant({ portContractVersion: 99 });
      await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(422);
    });

    it("records adoption only through the Human's own edit command", async () => {
      const { decisionId } = await draft();
      await grant();
      const contribution = await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(201);

      // An ordinary edit adopts nothing.
      await request(server())
        .patch(`/decisions/${decisionId}`)
        .set(as(MEMBER))
        .send({ context: "my own words" })
        .expect(200);
      let listed = await request(server())
        .get(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(200);
      expect(listed.body.items[0].adoptedAt).toBeNull();

      // Naming the contribution on the edit records that it was adopted. The
      // content written is still whatever the Human sent.
      await request(server())
        .patch(`/decisions/${decisionId}`)
        .set(as(MEMBER))
        .send({
          context: contribution.body.content,
          adoptedContributionId: contribution.body.contributionId,
        })
        .expect(200);
      listed = await request(server())
        .get(`/decisions/${decisionId}/assistance`)
        .set(as(MEMBER))
        .expect(200);
      expect(listed.body.items[0].adoptedAt).not.toBeNull();
    });

    it("denies a Reviewer, who holds no assistance permission", async () => {
      const { decisionId } = await draft();
      await grant();
      await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(as(REVIEWER))
        .expect(403);
    });

    it("denies a Member unrelated to the Decision", async () => {
      const { decisionId } = await draft();
      await grant();
      await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(as(STRANGER))
        .expect(403);
    });

    it("reports another Organization's Decision as absent", async () => {
      await grant();
      await request(server())
        .post(`/decisions/${randomUUID()}/assistance`)
        .set(as(MEMBER))
        .expect(404);
    });
  });

  describe("the resolved principal", () => {
    it("returns the caller's own Membership and the roles authorization used", async () => {
      const res = await request(server()).get("/me").set(as(REVIEWER)).expect(200);

      expect(res.body).toEqual({
        identityId: REVIEWER.identity,
        membershipId: REVIEWER.membership,
        organizationId: ORG,
        roles: ["Reviewer"],
      });
    });

    it("takes no parameter saying whose principal to return", async () => {
      // Two callers, two answers, from the same route with the same body.
      const member = await request(server()).get("/me").set(as(MEMBER)).expect(200);
      expect(member.body.membershipId).toBe(MEMBER.membership);
    });

    it("refuses an unauthenticated caller", async () => {
      await request(server()).get("/me").set("x-organization-id", ORG).expect(401);
    });
  });

  /**
   * The authorization audit.
   *
   * The property that motivated it: **a refused command produces no event**, so
   * the Outbox holds no trace of a denial. Every one of these tests that asserts
   * a `Deny` row is asserting something the Outbox structurally cannot record.
   */
  describe("the authorization audit", () => {
    it("records an Allow row for a command that succeeds", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .send({ expectedVersion: work.version })
        .expect(201);

      // The edge row specifically. The use case records a second row for the
      // same permission, and its `evaluatedAt` is the request's start time, so
      // it sorts first — see "records the decision at the edge and the states
      // in the use case".
      const rows = await auditRows("work.start", 2);
      const row = rows.find((r) => r.command_type.startsWith("POST "));
      expect(row).toMatchObject({
        outcome: "Allow",
        reason_code: null,
        command_type: "POST /works/:workId/start",
        principal_type: "HumanMember",
        identity_id: MEMBER.identity,
        membership_id: MEMBER.membership,
        organization_id: ORG,
        resource_type: "Work",
        resource_id: work.workId,
      });
    });

    it("records a Deny row naming why, for a command that is refused", async () => {
      const work = await createWork();
      // A Reviewer reviews; the matrix gives them no `work.start`.
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(REVIEWER))
        .send({ expectedVersion: work.version })
        .expect(403);

      const [row] = await auditRows("work.start");
      expect(row).toMatchObject({
        outcome: "Deny",
        reason_code: "PERMISSION_DENIED",
        membership_id: REVIEWER.membership,
        resource_type: "Work",
        resource_id: work.workId,
        previous_state: null,
        next_state: null,
      });
    });

    /**
     * The refusal that leaves nothing else behind. A cross-tenant request is
     * answered `404` and touches no row in any business table, so without this
     * record there is no evidence the attempt was ever made.
     */
    it("records a cross-tenant attempt that the response reports as absent", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(OUTSIDER, OTHER_ORG))
        .send({ expectedVersion: work.version })
        .expect(404);

      const [row] = await auditRows("work.start");
      expect(row).toMatchObject({
        outcome: "Deny",
        reason_code: "NOT_FOUND",
        membership_id: OUTSIDER.membership,
        // The Organization the caller acted in, not the one that owns the Work.
        // An audit row must not leak which tenant holds the resource.
        organization_id: OTHER_ORG,
        resource_id: work.workId,
      });
    });

    it("records an invalid transition as a denial with the domain's code", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ expectedVersion: work.version, completionSummary: "Done." })
        .expect(409);

      const [row] = await auditRows("work.complete");
      expect(row).toMatchObject({
        outcome: "Deny",
        reason_code: "WORK_INVALID_TRANSITION",
        membership_id: MEMBER.membership,
      });
    });

    /**
     * The two halves, on one request. The edge records the decision; the use
     * case records the states, which the edge cannot see because it holds the
     * request and the response, never the row the handler read.
     */
    it("records the decision at the edge and the states in the use case", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .send({ expectedVersion: work.version })
        .expect(201);

      const rows = await auditRows("work.start", 2);
      expect(rows).toHaveLength(2);

      const edge = rows.find((r) => r.command_type.startsWith("POST "));
      const transition = rows.find((r) => r.command_type === "StartWork");
      expect(edge).toMatchObject({ outcome: "Allow", previous_state: null });
      expect(transition).toMatchObject({
        outcome: "Allow",
        previous_state: "Draft",
        next_state: "InProgress",
      });
    });

    it("stamps every row with the policy it was decided under", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(MEMBER))
        .send({ expectedVersion: work.version })
        .expect(201);

      for (const row of await auditRows("work.start", 2)) {
        expect(row).toMatchObject({
          policy_id: "aios-authorization-model",
          policy_version: 1,
        });
      }
    });

    /**
     * `mvp.md` asks for "every protected action", and a query is not one. A row
     * per list request would bury the ones that matter.
     */
    it("records nothing for a read", async () => {
      await createWork();
      await request(server()).get("/works").set(as(MEMBER)).expect(200);

      const rows = await pool.query(
        `SELECT permission FROM authorization_audit_records
          WHERE command_type LIKE 'GET %'`,
      );
      expect(rows.rows).toHaveLength(0);
    });

    /**
     * "The audit repository should expose `Insert` only" and "Audit information
     * must not be silently overwritten". The application code has no method that
     * could; this asserts the rows themselves are not rewritten by the ordinary
     * lifecycle of what they refer to.
     */
    it("keeps the denial after the resource it refers to is gone", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(as(REVIEWER))
        .send({ expectedVersion: work.version })
        .expect(403);
      await auditRows("work.start");

      const client = await pool.connect();
      try {
        await client.query(`DELETE FROM work_items WHERE work_id = $1`, [
          work.workId,
        ]);
      } finally {
        client.release();
      }

      const [row] = await auditRows("work.start");
      expect(row).toMatchObject({ outcome: "Deny", resource_id: work.workId });
    });

    /**
     * Steps 2 to 4 of the Policy Evaluation Algorithm are refused by the guard,
     * which Nest runs *before* interceptors — so the interceptor never sees
     * them. They are recorded by the guard instead, and this is the test that
     * says so: without it, a caller reaching into an Organization they do not
     * belong to would leave no trace anywhere.
     */
    it("records a refusal made before the handler was reached", async () => {
      await request(server())
        .post("/works")
        .set(as(OUTSIDER, ORG))
        .send({ title: "Ship it" })
        .expect(404);

      const [row] = await auditRows("work.create");
      expect(row).toMatchObject({
        outcome: "Deny",
        reason_code: "NO_MEMBERSHIP",
        principal_type: "AuthenticatedSubject",
        // Attributable to the subject that presented the request, even though no
        // Membership resolved and therefore no principal exists.
        principal_id: `${DEV_PROVIDER}:${OUTSIDER.subject}`,
        membership_id: null,
        organization_id: ORG,
        command_type: "POST /works",
      });
    });

    /**
     * Authentication failure is not an authorization decision: the request never
     * becomes a command, so there is no principal to attribute and nothing the
     * audit could say beyond what the access log already does.
     */
    it("records nothing for a request that fails authentication", async () => {
      await request(server())
        .post("/works")
        .set("x-organization-id", ORG)
        .send({ title: "Ship it" })
        .expect(401);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await pool.query(`SELECT 1 FROM authorization_audit_records`);
      expect(rows.rows).toHaveLength(0);
    });
  });

  describe("in-app notifications", () => {
    const memoryOptions = {
      memory: {
        generator: new DeterministicMemoryGenerator(),
        secretaryIdentityId: SECRETARY_IDENTITY_ID,
        systemPrincipalId: "memory-generator",
      },
    };

    const drain = () => drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

    const notificationsFor = async (who: typeof MEMBER) => {
      const res = await request(server())
        .get("/notifications")
        .set(as(who))
        .expect(200);
      return res.body as {
        items: { notificationId: string; notificationType: string; subjectId: string }[];
        unacknowledged: number;
      };
    };

    it("notifies the new assignee, and nobody else", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: STRANGER.membership })
        .expect(201);
      await drain();

      const assignee = await notificationsFor(STRANGER);
      expect(assignee.items).toHaveLength(1);
      expect(assignee.items[0]).toMatchObject({
        notificationType: "WorkAssigned",
        subjectId: work.workId,
      });
      expect(assignee.unacknowledged).toBe(1);

      // The Member who did the assigning is not told they did it.
      expect((await notificationsFor(MEMBER)).items).toEqual([]);
    });

    it("does not notify anyone when an assignment is only cleared", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: STRANGER.membership })
        .expect(201);
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: null })
        .expect(201);
      await drain();

      // Only the assignment, not the unassignment: nobody is newly responsible.
      expect((await notificationsFor(STRANGER)).items).toHaveLength(1);
    });

    it("tells the Reviewer a Decision is waiting, and the Work's members the outcome", async () => {
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
      await drain();

      // Nothing assigns a reviewer to a Decision, so the Reviewer role is the
      // audience.
      const reviewer = await notificationsFor(REVIEWER);
      expect(reviewer.items.map((n) => n.notificationType)).toEqual([
        "DecisionSubmittedForReview",
      ]);

      await request(server())
        .post(`/decisions/${decision.body.decisionId}/approve`)
        .set(as(REVIEWER))
        .send({ selectedOptionId: "pg", rationale: "Fewest moving parts." })
        .expect(201);
      await drain();

      // The Work's creator learns the outcome; the Reviewer who decided does not
      // get told about their own decision.
      const creator = await notificationsFor(MEMBER);
      expect(creator.items.map((n) => n.notificationType)).toEqual([
        "DecisionResolved",
      ]);
      expect(
        (await notificationsFor(REVIEWER)).items.map((n) => n.notificationType),
      ).toEqual(["DecisionSubmittedForReview"]);
    });

    it("notifies through the Memory review cycle", async () => {
      const work = await createWork("Ship the beta");
      await request(server()).post(`/works/${work.workId}/start`).set(as(MEMBER)).expect(201);
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(as(MEMBER))
        .send({ completionSummary: "Beta shipped on Friday" })
        .expect(201);
      await drain();

      const memory = await request(server())
        .get(`/memories/by-work/${work.workId}`)
        .set(as(MEMBER))
        .expect(200);
      const memoryId = memory.body.memory.memoryId;

      await request(server())
        .post(`/memories/${memoryId}/submit`)
        .set(as(MEMBER))
        .expect(201);
      await drain();
      expect(
        (await notificationsFor(REVIEWER)).items.map((n) => n.notificationType),
      ).toEqual(["MemoryReadyForReview"]);

      await request(server())
        .post(`/memories/${memoryId}/reject`)
        .set(as(REVIEWER))
        .send({ note: "Add the scope decision." })
        .expect(201);
      await drain();
      expect(
        (await notificationsFor(MEMBER)).items.map((n) => n.notificationType),
      ).toEqual(["MemoryRejected"]);
    });

    it("writes one notification when the event is redelivered", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: STRANGER.membership })
        .expect(201);
      await drain();

      const client = await pool.connect();
      try {
        // Redelivery: the Outbox row is returned to Pending and the consumer's
        // processed-event row is cleared, so the projection runs again.
        await client.query(
          `UPDATE outbox_messages SET status = 'Pending', published_at = NULL
            WHERE event_type = 'WorkAssignmentChanged'`,
        );
        await client.query(`DELETE FROM processed_events WHERE consumer_name = 'notifications'`);
      } finally {
        client.release();
      }
      await drain();

      // `uq_notifications_recipient_event` is what makes this one row.
      expect((await notificationsFor(STRANGER)).items).toHaveLength(1);
    });

    it("records the projection as its own consumer delivery", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: STRANGER.membership })
        .expect(201);
      await drain();

      const client = await pool.connect();
      try {
        const rows = await client.query<{ consumer_name: string; status: string }>(
          `SELECT consumer_name, status FROM processed_events
            WHERE event_type = 'WorkAssignmentChanged'`,
        );
        // Two consumers can handle one event; each has its own row.
        expect(rows.rows).toEqual([
          { consumer_name: "notifications", status: "Processed" },
        ]);
      } finally {
        client.release();
      }
    });

    it("acknowledges a notification, once", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: STRANGER.membership })
        .expect(201);
      await drain();

      const before = await notificationsFor(STRANGER);
      const id = before.items[0]!.notificationId;

      await request(server())
        .post(`/notifications/${id}/acknowledge`)
        .set(as(STRANGER))
        .expect(204);

      const after = await notificationsFor(STRANGER);
      expect(after.unacknowledged).toBe(0);
      expect(after.items[0]!.notificationId).toBe(id);

      // Already acknowledged: reported absent rather than as a conflict.
      await request(server())
        .post(`/notifications/${id}/acknowledge`)
        .set(as(STRANGER))
        .expect(404);
    });

    it("cannot read or acknowledge another Member's notification", async () => {
      const work = await createWork();
      await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(as(MEMBER))
        .send({ assigneeMembershipId: STRANGER.membership })
        .expect(201);
      await drain();

      const id = (await notificationsFor(STRANGER)).items[0]!.notificationId;

      // The list has no parameter for whose it is, and acknowledging is scoped by
      // recipient in the statement itself.
      expect((await notificationsFor(OWNER)).items).toEqual([]);
      await request(server())
        .post(`/notifications/${id}/acknowledge`)
        .set(as(OWNER))
        .expect(404);
    });

    it("rejects a malformed notification id", async () => {
      await request(server())
        .post("/notifications/not-a-uuid/acknowledge")
        .set(as(MEMBER))
        .expect(400);
    });

    it("is now a rebuildable projection the replay route accepts", async () => {
      // The first registered Projection Consumer, so `events.replay_projection`
      // is no longer a route that can only refuse.
      const res = await request(server())
        .post("/admin/events/replay/projection")
        .set(as(OWNER))
        .send({
          consumerName: "notifications",
          reasonCode: "DRIFT",
          reason: "Suspected missing notifications.",
        })
        .expect(201);

      expect(res.body.replayId).toMatch(/^[0-9a-f-]{36}$/);
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

    /**
     * A dead-lettered consumer delivery, written directly.
     *
     * Driving a real consumer to permanent failure needs a deliberately broken
     * handler; what the recovery commands need is the pair of rows.
     */
    const seedDeadLetter = async (
      consumerName: string,
      organizationId = ORG,
      orderingKey: string | null = null,
    ): Promise<{ deadLetterId: string; eventId: string }> => {
      const eventId = randomUUID();
      const deadLetterId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO processed_events
             (consumer_name, event_id, event_type, schema_version, organization_id,
              aggregate_type, aggregate_id, aggregate_version, correlation_id,
              status, attempt_count, first_received_at, failed_at,
              ordering_key_type, ordering_key, source_sequence)
           VALUES ($1, $2, 'DecisionApproved', 1, $3, 'Decision', $4, 1, $5,
                   'Failed', 5, now(), now(), $6, $7, 1)`,
          [
            consumerName, eventId, organizationId, randomUUID(), randomUUID(),
            orderingKey === null ? null : "AggregateStream", orderingKey,
          ],
        );
        await client.query(
          `INSERT INTO dead_letter_events
             (dead_letter_id, organization_id, consumer_name, event_id,
              ordering_key_type, ordering_key, source_sequence,
              failure_category, error_code, status,
              first_failed_at, last_failed_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 'DomainRejection', 'WORK_INVALID_TRANSITION',
                   'Open', now(), now(), now(), now())`,
          [
            deadLetterId, organizationId, consumerName, eventId,
            orderingKey === null ? null : "AggregateStream", orderingKey,
          ],
        );
        if (orderingKey !== null) {
          await client.query(
            `INSERT INTO consumer_ordering_state
               (consumer_ordering_state_id, consumer_name, organization_id,
                ordering_key_type, ordering_key, blocked_event_id, blocked_sequence,
                blocked_at, block_reason_code, status, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'AggregateStream', $3, $4, 1,
                     now(), 'WORK_INVALID_TRANSITION', 'Blocked', now())`,
            [consumerName, organizationId, orderingKey, eventId],
          );
        }
      } finally {
        client.release();
      }
      return { deadLetterId, eventId };
    };

    const deadLetterRow = async (deadLetterId: string) => {
      const client = await pool.connect();
      try {
        const result = await client.query<{
          status: string;
          version: string;
          resolved_by_membership_id: string | null;
          resolution_reason_code: string | null;
        }>(
          `SELECT status, version, resolved_by_membership_id, resolution_reason_code
             FROM dead_letter_events WHERE dead_letter_id = $1`,
          [deadLetterId],
        );
        return result.rows[0]!;
      } finally {
        client.release();
      }
    };

    it("lists dead-lettered deliveries separately from failed publications", async () => {
      const { deadLetterId, eventId } = await seedDeadLetter("decision-outcome");

      const res = await request(server())
        .get("/admin/events/dead-letters")
        .set(as(OWNER))
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        deadLetterId,
        eventId,
        consumerName: "decision-outcome",
        status: "Open",
        processedEventStatus: "Failed",
        errorCode: "WORK_INVALID_TRANSITION",
        version: 1,
      });

      // The Outbox is untouched: a consumer failing is not a publication failure.
      const published = await request(server())
        .get("/admin/events/failed")
        .set(as(OWNER))
        .expect(200);
      expect(published.body.items).toEqual([]);
    });

    it("does not show another Organization's dead letters", async () => {
      await seedDeadLetter("decision-outcome", OTHER_ORG);
      const res = await request(server())
        .get("/admin/events/dead-letters")
        .set(as(OWNER))
        .expect(200);
      expect(res.body.items).toEqual([]);
    });

    it("refuses to skip a consumer whose registration prohibits it", async () => {
      const { deadLetterId } = await seedDeadLetter("memory-generation");

      // `memory-generation` registers skipPolicy=Prohibited: its recovery store
      // is the generation operation, and discarding the trigger would leave two
      // records disagreeing about whether the Work was ever considered.
      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/skip`)
        .set(as(OWNER))
        .send({ expectedVersion: 1, reasonCode: "OPERATOR_DECISION", reason: "Stuck." })
        .expect(422);

      expect((await deadLetterRow(deadLetterId)).status).toBe("Open");
    });

    it("refuses to skip a Domain Coordination consumer with no safety evidence", async () => {
      const { deadLetterId } = await seedDeadLetter("decision-outcome");

      // "Allow only with registered safety or compensation evidence."
      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/skip`)
        .set(as(OWNER))
        .send({ expectedVersion: 1, reasonCode: "OPERATOR_DECISION", reason: "Stuck." })
        .expect(422);

      expect((await deadLetterRow(deadLetterId)).status).toBe("Open");
    });

    it("skips atomically once the evidence is supplied", async () => {
      const { deadLetterId, eventId } = await seedDeadLetter(
        "decision-outcome",
        ORG,
        "Decision:x",
      );

      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/skip`)
        .set(as(OWNER))
        .send({
          expectedVersion: 1,
          reasonCode: "COMPENSATED",
          reason: "The Work was resolved directly by its owner.",
          safetyEvidenceReference: "runbook/decision-outcome-manual-resolution",
        })
        .expect(204);

      const dead = await deadLetterRow(deadLetterId);
      expect(dead.status).toBe("Skipped");
      // The resolution attribution is inseparable from the resolution.
      expect(dead.resolved_by_membership_id).toBe(OWNER.membership);
      expect(dead.resolution_reason_code).toBe("COMPENSATED");

      const client = await pool.connect();
      try {
        // Processed event and ordering state moved in the same transaction.
        const processed = await client.query<{ status: string }>(
          `SELECT status FROM processed_events WHERE event_id = $1`,
          [eventId],
        );
        expect(processed.rows[0]!.status).toBe("Skipped");

        const ordering = await client.query<{ status: string }>(
          `SELECT status FROM consumer_ordering_state WHERE ordering_key = 'Decision:x'`,
        );
        expect(ordering.rows[0]!.status).toBe("Active");
      } finally {
        client.release();
      }
    });

    it("refuses a skip fenced on a stale version", async () => {
      const { deadLetterId } = await seedDeadLetter("decision-outcome");

      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/skip`)
        .set(as(OWNER))
        .send({
          expectedVersion: 7,
          reasonCode: "COMPENSATED",
          reason: "Resolved directly.",
          safetyEvidenceReference: "runbook/x",
        })
        .expect(409);

      expect((await deadLetterRow(deadLetterId)).status).toBe("Open");
    });

    it("requires an expected version, a reason code, and a reason", async () => {
      const { deadLetterId } = await seedDeadLetter("decision-outcome");

      for (const body of [
        { reasonCode: "X", reason: "y", safetyEvidenceReference: "r" },
        { expectedVersion: 1, reason: "y", safetyEvidenceReference: "r" },
        { expectedVersion: 1, reasonCode: "X", safetyEvidenceReference: "r" },
      ]) {
        await request(server())
          .post(`/admin/events/dead-letters/${deadLetterId}/skip`)
          .set(as(OWNER))
          .send(body)
          .expect(400);
      }
    });

    it("denies an Admin the domain-consumer reprocess by default", async () => {
      const { deadLetterId } = await seedDeadLetter("decision-outcome");

      // "Deny unless explicit Organization policy grants it", and no
      // per-Organization policy exists in this release.
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE membership_role_assignments SET role = 'OrganizationAdmin'
            WHERE membership_id = $1`,
          [OWNER.membership],
        );
      } finally {
        client.release();
      }

      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/reprocess`)
        .set(as(OWNER))
        .send({ expectedVersion: 1, reasonCode: "HANDLER_FIXED", reason: "Deployed a fix." })
        .expect(403);
    });

    it("queues a reprocess and records the durable intent", async () => {
      const { deadLetterId, eventId } = await seedDeadLetter(
        "decision-outcome",
        ORG,
        "Decision:y",
      );

      const res = await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/reprocess`)
        .set(as(OWNER))
        .send({ expectedVersion: 1, reasonCode: "HANDLER_FIXED", reason: "Deployed a fix." })
        .expect(201);

      expect(res.body.replayId).toMatch(/^[0-9a-f-]{36}$/);

      const client = await pool.connect();
      try {
        const replay = await client.query<{
          replay_mode: string;
          status: string;
          requested_by_membership_id: string;
          reason_code: string;
          authorization_policy_version: number;
        }>(`SELECT * FROM event_replays WHERE replay_id = $1`, [res.body.replayId]);

        // The intent is the approval, so it records who asked and under which
        // policy — not just that something happened.
        expect(replay.rows[0]).toMatchObject({
          replay_mode: "ReprocessWithCurrentHandler",
          status: "Running",
          requested_by_membership_id: OWNER.membership,
          reason_code: "HANDLER_FIXED",
          authorization_policy_version: 1,
        });

        const processed = await client.query<{ status: string; attempt_count: number }>(
          `SELECT status, attempt_count FROM processed_events WHERE event_id = $1`,
          [eventId],
        );
        // Requeued for the current handler, with the attempt history intact.
        expect(processed.rows[0]).toEqual({ status: "RetryPending", attempt_count: 5 });

        const ordering = await client.query<{ status: string }>(
          `SELECT status FROM consumer_ordering_state WHERE ordering_key = 'Decision:y'`,
        );
        expect(ordering.rows[0]!.status).toBe("Recovering");
      } finally {
        client.release();
      }
    });

    it("refuses to reprocess another Organization's dead letter as 404", async () => {
      const { deadLetterId } = await seedDeadLetter("decision-outcome", OTHER_ORG);

      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/reprocess`)
        .set(as(OWNER))
        .send({ expectedVersion: 1, reasonCode: "HANDLER_FIXED", reason: "Fix." })
        .expect(404);
    });

    it("refuses a projection rebuild for a consumer that is not a projection", async () => {
      // The route is implemented and authorized; the registry answers that
      // there is no projection to rebuild. That refusal is the honest outcome,
      // and it is recorded as a Denied replay so the attempt is auditable.
      await request(server())
        .post("/admin/events/replay/projection")
        .set(as(OWNER))
        .send({
          consumerName: "decision-outcome",
          reasonCode: "DRIFT",
          reason: "Suspected drift.",
        })
        .expect(422);

      const client = await pool.connect();
      try {
        const replay = await client.query<{ status: string; result_code: string }>(
          `SELECT status, result_code FROM event_replays WHERE replay_mode = 'RebuildProjection'`,
        );
        expect(replay.rows[0]).toMatchObject({
          status: "Denied",
          result_code: "NOT_A_PROJECTION",
        });
      } finally {
        client.release();
      }
    });

    it("reports an unregistered consumer as absent", async () => {
      await request(server())
        .post("/admin/events/replay/projection")
        .set(as(OWNER))
        .send({ consumerName: "no-such-consumer", reasonCode: "X", reason: "y" })
        .expect(404);
    });

    /**
     * The two halves of a consumer replay have to meet.
     *
     * A consumer failure leaves the Outbox row `Failed`, and the publisher
     * claims only `Pending` ones. Readying the consumer without readying the
     * message made the replay inert — accepted, audited, and with nothing ever
     * redelivered. Found by the Release Acceptance Criteria suite, where
     * "Temporary generation failure can be retried" could not be demonstrated
     * through either recovery command.
     */
    it("returns the message to Pending so the replay actually redelivers", async () => {
      const { deadLetterId, eventId } = await seedDeadLetter("decision-outcome");

      // `seedDeadLetter` builds the consumer side only, so the message it
      // refers to is added here, in the state a consumer failure leaves it.
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO outbox_messages (
             outbox_id, event_id, event_type, event_category, schema_version,
             aggregate_type, aggregate_id, aggregate_version, event_sequence,
             organization_id, payload, headers, destination,
             occurred_at, recorded_at, correlation_id,
             status, attempt_count, next_attempt_at, last_error_code
           ) VALUES (
             gen_random_uuid(), $1, 'DecisionApproved', 'Domain', 1,
             'Decision', gen_random_uuid(), 1, 1,
             $2, '{}'::jsonb, '{}'::jsonb, 'local',
             now(), now(), gen_random_uuid(),
             'Failed', 5, now(), 'WORK_INVALID_TRANSITION'
           )`,
          [eventId, ORG],
        );
      } finally {
        client.release();
      }

      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/reprocess`)
        .set(as(OWNER))
        .send({ expectedVersion: 1, reasonCode: "FIXED", reason: "Handler corrected." })
        .expect(201);

      const message = await pool.query<{ status: string }>(
        `SELECT status FROM outbox_messages WHERE event_id = $1`,
        [eventId],
      );
      expect(message.rows[0]?.status).toBe("Pending");

      // The consumer side is ready too, and `attempt_count` survives — a
      // poisonous message must stay visible as one.
      const delivery = await pool.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM processed_events WHERE event_id = $1`,
        [eventId],
      );
      expect(delivery.rows[0]?.status).toBe("RetryPending");
      expect(delivery.rows[0]?.attempt_count).toBeGreaterThan(0);
    });

    it("records a Deny row for each refused recovery command", async () => {
      const { deadLetterId } = await seedDeadLetter("decision-outcome");
      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/skip`)
        .set(as(MEMBER))
        .send({ expectedVersion: 1, reasonCode: "X", reason: "y" })
        .expect(403);

      const [row] = await auditRows("events.skip");
      expect(row).toMatchObject({
        outcome: "Deny",
        reason_code: "PERMISSION_DENIED",
        permission: "events.skip",
        membership_id: MEMBER.membership,
        resource_type: "DeadLetter",
        resource_id: deadLetterId,
      });
    });

    it("denies a Member every consumer recovery command", async () => {
      const { deadLetterId } = await seedDeadLetter("decision-outcome");

      await request(server()).get("/admin/events/dead-letters").set(as(MEMBER)).expect(403);
      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/skip`)
        .set(as(MEMBER))
        .send({ expectedVersion: 1, reasonCode: "X", reason: "y" })
        .expect(403);
      await request(server())
        .post(`/admin/events/dead-letters/${deadLetterId}/reprocess`)
        .set(as(MEMBER))
        .send({ expectedVersion: 1, reasonCode: "X", reason: "y" })
        .expect(403);
      await request(server())
        .post("/admin/events/replay/projection")
        .set(as(MEMBER))
        .send({ consumerName: "decision-outcome", reasonCode: "X", reason: "y" })
        .expect(403);
    });
  });
});
