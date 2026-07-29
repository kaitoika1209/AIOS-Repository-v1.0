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

      for (const who of [MEMBER, REVIEWER, OUTSIDER, OWNER]) {
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
});
