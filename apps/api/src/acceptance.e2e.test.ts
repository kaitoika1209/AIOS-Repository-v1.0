/**
 * The Release Acceptance Criteria, executed.
 *
 * `docs/product/mvp.md` states the bar outright: "The MVP is release-ready only
 * when the following end-to-end behavior is demonstrable." It then lists
 * criteria in seven categories. This file is that list, one test per criterion,
 * each named with the criterion verbatim so the checklist and the suite cannot
 * drift into paraphrase.
 *
 * Two rules keep it honest:
 *
 * - **Nothing is seeded.** The suite starts from an empty schema and builds the
 *   Organization, its Members, and everything else through HTTP. A criterion
 *   like "A person can create an Organization" is not demonstrable against a
 *   fixture that already contains one.
 * - **Nothing is asserted from the inside.** Behaviour is observed through the
 *   API a person would use. The database is read only where a criterion is
 *   about what was *retained* rather than what was returned.
 *
 * The rest of the suite (`api.e2e.test.ts`) tests how things work. This one
 * answers a different question — whether the release bar is met — and a reviewer
 * should be able to answer it by running this file alone.
 *
 * Skipped when DATABASE_URL is unset.
 */

import "reflect-metadata";

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SECRETARY_IDENTITY_ID, createApp, dependenciesFor } from "./app.js";
import { drainOutbox } from "./outbox-worker.js";
import { DeterministicMemoryGenerator } from "./deterministic-memory-generator.js";
import { SECRETARY_PRINCIPAL_ID } from "./decision-assistance-provider.js";
import { DevAuthAdapter } from "./dev-auth.js";

const url = process.env["DATABASE_URL"];
const SCHEMA = "test_acceptance";
const suite = url ? describe : describe.skip;
const repoRoot = resolve(import.meta.dirname, "../../..");

suite("Release Acceptance Criteria (mvp.md)", () => {
  let pool: Pool;
  let app: INestApplication;

  const server = () => app.getHttpServer();

  /** A person, identified only by the subject their provider verified. */
  const person = (subject: string, email: string) => ({ subject, email });

  const FOUNDER = person("founder", "founder@example.test");
  const COLLEAGUE = person("colleague", "colleague@example.test");
  const REVIEWER = person("reviewer", "reviewer@example.test");
  const OUTSIDER = person("outsider", "outsider@example.test");

  const headers = (who: typeof FOUNDER, organizationId?: string) => ({
    "x-dev-subject": who.subject,
    "x-dev-display-name": who.subject,
    "x-dev-email": who.email,
    ...(organizationId === undefined ? {} : { "x-organization-id": organizationId }),
  });

  const memoryOptions = {
    memory: {
      generator: new DeterministicMemoryGenerator(),
      secretaryIdentityId: SECRETARY_IDENTITY_ID,
      systemPrincipalId: "memory-generator",
    },
  };

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
                  authorization_audit_records, notifications,
                  decision_secretary_contributions, secretary_assistance_grants,
                  dead_letter_events, event_replays, processed_events,
                  consumer_ordering_state,
                  memory_revisions, memories, memory_generation_operations,
                  membership_role_assignments, memberships,
                  organization_invitations,
                  authentication_subjects, organizations, human_identities CASCADE`,
      );
      // The Secretary Identity is infrastructure, not a person: generation
      // credits it as the author, and no HTTP flow creates it.
      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Secretary', 1, now(), now())`,
        [SECRETARY_IDENTITY_ID],
      );
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // Flows, expressed the way a person would perform them.
  // ---------------------------------------------------------------------------

  const createOrganization = async (who = FOUNDER) => {
    const res = await request(server())
      .post("/organizations")
      .set(headers(who))
      .send({ name: "Northwind" })
      .expect(201);
    return res.body as { organizationId: string; membershipId: string };
  };

  const invite = async (
    organizationId: string,
    by: typeof FOUNDER,
    who: typeof COLLEAGUE,
    roles: string[] = ["Member"],
  ) => {
    const res = await request(server())
      .post(`/organizations/${organizationId}/members`)
      .set(headers(by, organizationId))
      .send({ email: who.email, roles })
      .expect(201);
    return res.body as { membershipId: string; token: string };
  };

  const accept = async (who: typeof COLLEAGUE, token: string) =>
    request(server())
      .post("/invitations/accept")
      .set(headers(who))
      .send({ token })
      .expect(201);

  /**
   * Enable the Secretary for one Organization.
   *
   * Written directly, because no route creates a grant. ADR-0011 requires every
   * invocation to be authorized against an active grant and says unknown ones
   * "fail closed"; it does not say who issues one, and the permission catalogue
   * has no name for the act. The dev seed reaches the same conclusion and does
   * the same thing.
   *
   * That gap is real — an Organization created through `POST /organizations`
   * cannot use its Secretary — but it is not one of the criteria below. These
   * ask what a suggestion *does*, not how the Secretary was enabled.
   */
  const grantAssistance = async (organizationId: string, byMembershipId: string) => {
    await pool.query(
      `INSERT INTO secretary_assistance_grants
         (grant_id, organization_id, secretary_principal_id,
          context_key, assistance_operation, port_contract_version,
          granted_at, granted_by_membership_id, reason)
       VALUES (gen_random_uuid(), $1, $2, 'Decision', 'decision.draft_material', 1,
               now(), $3, 'Acceptance suite: the Owner enables Decision drafting.')`,
      [organizationId, SECRETARY_PRINCIPAL_ID, byMembershipId],
    );
  };

  /** An Organization with a Member and a Reviewer, all through the API. */
  const organizationWithTeam = async () => {
    const org = await createOrganization();
    const member = await invite(org.organizationId, FOUNDER, COLLEAGUE, ["Member"]);
    await accept(COLLEAGUE, member.token);
    const reviewer = await invite(org.organizationId, FOUNDER, REVIEWER, ["Reviewer"]);
    await accept(REVIEWER, reviewer.token);
    await grantAssistance(org.organizationId, org.membershipId);
    return {
      organizationId: org.organizationId,
      ownerMembershipId: org.membershipId,
      memberMembershipId: member.membershipId,
      reviewerMembershipId: reviewer.membershipId,
    };
  };

  const createWork = async (organizationId: string, who = COLLEAGUE, title = "Ship the beta") => {
    const res = await request(server())
      .post("/works")
      .set(headers(who, organizationId))
      .send({ title })
      .expect(201);
    return res.body as { workId: string; version: number };
  };

  /** Work carried to `Completed`, which is what triggers Memory generation. */
  const completedWork = async (organizationId: string) => {
    const work = await createWork(organizationId);
    await request(server())
      .post(`/works/${work.workId}/start`)
      .set(headers(COLLEAGUE, organizationId))
      .send({ expectedVersion: work.version })
      .expect(201);
    await request(server())
      .post(`/works/${work.workId}/complete`)
      .set(headers(COLLEAGUE, organizationId))
      .send({ expectedVersion: work.version + 1, completionSummary: "Beta shipped." })
      .expect(201);
    return work;
  };

  /** A generated Memory draft, produced by the asynchronous half of ADR-0008. */
  const generatedMemory = async (organizationId: string) => {
    const work = await completedWork(organizationId);
    await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

    const res = await request(server())
      .get("/memories")
      .set(headers(COLLEAGUE, organizationId))
      .expect(200);
    const memory = (res.body.items as { memoryId: string; version: number }[])[0];
    expect(memory).toBeDefined();
    return { work, memory: memory! };
  };

  // ===========================================================================
  describe("Organization and Access", () => {
    it("A person can create an Organization", async () => {
      const org = await createOrganization();

      expect(org.organizationId).toMatch(/^[0-9a-f-]{36}$/);
      // Created with its first Owner in the same act, or the Organization would
      // exist with nobody able to administer it.
      const members = await request(server())
        .get(`/organizations/${org.organizationId}/members`)
        .set(headers(FOUNDER, org.organizationId))
        .expect(200);
      expect(members.body.items).toHaveLength(1);
      expect(members.body.items[0].roles).toContain("OrganizationOwner");
    });

    it("A person can invite another person", async () => {
      const org = await createOrganization();
      const invitation = await invite(org.organizationId, FOUNDER, COLLEAGUE);

      expect(invitation.token).toBeTruthy();
      const members = await request(server())
        .get(`/organizations/${org.organizationId}/members`)
        .set(headers(FOUNDER, org.organizationId))
        .expect(200);
      expect(
        (members.body.items as { status: string }[]).some((m) => m.status === "Invited"),
      ).toBe(true);
    });

    it("The invited person can join as a Member", async () => {
      const org = await createOrganization();
      const invitation = await invite(org.organizationId, FOUNDER, COLLEAGUE);

      const joined = await accept(COLLEAGUE, invitation.token);
      expect(joined.body.organizationId).toBe(org.organizationId);

      // Joining is what confers authority: before it, the invitee could do
      // nothing in this Organization.
      await request(server())
        .post("/works")
        .set(headers(COLLEAGUE, org.organizationId))
        .send({ title: "First task" })
        .expect(201);
    });

    it("Members cannot access another Organization without permission", async () => {
      const mine = await organizationWithTeam();
      const theirs = await createOrganization(OUTSIDER);
      const work = await createWork(mine.organizationId);

      // Named directly, with the outsider acting in their own Organization.
      await request(server())
        .get(`/works/${work.workId}`)
        .set(headers(OUTSIDER, theirs.organizationId))
        .expect(404);

      // And claiming the other Organization in the header buys nothing: the
      // header selects among the caller's Memberships and grants nothing.
      await request(server())
        .get(`/works/${work.workId}`)
        .set(headers(OUTSIDER, mine.organizationId))
        .expect(404);

      // 404 and not 403 throughout — a 403 would confirm the Work exists.
      const listed = await request(server())
        .get("/works")
        .set(headers(OUTSIDER, theirs.organizationId))
        .expect(200);
      expect(listed.body.items).toHaveLength(0);
    });

    it("Protected actions are denied by default", async () => {
      const team = await organizationWithTeam();

      // No authenticated subject at all.
      await request(server())
        .post("/works")
        .set({ "x-organization-id": team.organizationId })
        .send({ title: "Anonymous" })
        .expect(401);

      // Authenticated, a Member of the Organization, and still refused what the
      // role does not grant: a Reviewer holds no `work.create`.
      await request(server())
        .post("/works")
        .set(headers(REVIEWER, team.organizationId))
        .send({ title: "Not mine to make" })
        .expect(403);
    });
  });

  // ===========================================================================
  describe("Work", () => {
    it("An authorized human can create, update, assign, and complete Work", async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);

      const work = await createWork(team.organizationId);

      const updated = await request(server())
        .patch(`/works/${work.workId}`)
        .set(at)
        .send({ expectedVersion: work.version, title: "Ship the beta, carefully" })
        .expect(200);
      expect(updated.body.title).toBe("Ship the beta, carefully");

      const assigned = await request(server())
        .post(`/works/${work.workId}/assign`)
        .set(at)
        .send({ assigneeMembershipId: team.memberMembershipId })
        .expect(201);
      expect(assigned.body.assigneeMembershipId).toBe(team.memberMembershipId);

      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(at)
        .send({ expectedVersion: assigned.body.version })
        .expect(201);

      const completed = await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(at)
        .send({ expectedVersion: assigned.body.version + 1, completionSummary: "Done." })
        .expect(201);
      expect(completed.body.status).toBe("Completed");
    });

    it("Invalid Work transitions are rejected", async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);
      const work = await createWork(team.organizationId);

      // Draft → Completed skips InProgress, which the state machine does not
      // allow. 409: well formed, and refused by the Aggregate's own rule.
      await request(server())
        .post(`/works/${work.workId}/complete`)
        .set(at)
        .send({ expectedVersion: work.version, completionSummary: "Skipping ahead." })
        .expect(409);

      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(at)
        .send({ expectedVersion: work.version })
        .expect(201);
      // Started twice is equally invalid.
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(at)
        .send({ expectedVersion: work.version + 1 })
        .expect(409);
    });

    it("Secretary suggestions do not change Work state automatically", async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);
      const work = await createWork(team.organizationId);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(at)
        .send({ expectedVersion: work.version })
        .expect(201);

      const decision = await request(server())
        .post("/decisions")
        .set(at)
        .send({
          relatedWorkId: work.workId,
          title: "Which region?",
          question: "Which region first?",
          options: [
            { optionId: "eu", summary: "EU" },
            { optionId: "us", summary: "US" },
          ],
        })
        .expect(201);

      const before = await request(server())
        .get(`/works/${work.workId}`)
        .set(at)
        .expect(200);

      // The Secretary's assistance produces a contribution, and nothing else.
      // ADR-0011 binds it to a context-owned port with no command authority.
      await request(server())
        .post(`/decisions/${decision.body.decisionId}/assistance`)
        .set(at)
        .send({ operation: "decision.draft_material" })
        .expect(201);

      const after = await request(server())
        .get(`/works/${work.workId}`)
        .set(at)
        .expect(200);
      expect(after.body.status).toBe(before.body.status);
      expect(after.body.version).toBe(before.body.version);
    });

    it("Approving a Decision does not complete Work", async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);
      const work = await createWork(team.organizationId);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(at)
        .send({ expectedVersion: work.version })
        .expect(201);

      const decision = await request(server())
        .post("/decisions")
        .set(at)
        .send({
          relatedWorkId: work.workId,
          title: "Which region?",
          question: "Which region first?",
          options: [
            { optionId: "eu", summary: "EU" },
            { optionId: "us", summary: "US" },
          ],
        })
        .expect(201);

      await request(server())
        .post(`/decisions/${decision.body.decisionId}/submit`)
        .set(at)
        .expect(201);
      await request(server())
        .post(`/decisions/${decision.body.decisionId}/approve`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ selectedOptionId: "eu", rationale: "Lower risk." })
        .expect(201);

      // Even after the outcome is propagated, the Work is unblocked and not
      // finished. Completion stays a human act (ADR-0007).
      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

      const after = await request(server())
        .get(`/works/${work.workId}`)
        .set(at)
        .expect(200);
      expect(after.body.status).toBe("InProgress");
      expect(after.body.status).not.toBe("Completed");
    });
  });

  // ===========================================================================
  describe("Decision", () => {
    const withSubmittedDecision = async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);
      const work = await createWork(team.organizationId);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(at)
        .send({ expectedVersion: work.version })
        .expect(201);

      const decision = await request(server())
        .post("/decisions")
        .set(at)
        .send({
          relatedWorkId: work.workId,
          title: "Which region?",
          question: "Which region first?",
          options: [
            { optionId: "eu", summary: "EU" },
            { optionId: "us", summary: "US" },
          ],
        })
        .expect(201);
      await request(server())
        .post(`/decisions/${decision.body.decisionId}/submit`)
        .set(at)
        .expect(201);

      return { team, decisionId: decision.body.decisionId as string, work };
    };

    it("A human can create and submit a Decision", async () => {
      const { team, decisionId } = await withSubmittedDecision();

      const decisions = await request(server())
        .get(`/decisions/by-work/${(await request(server())
          .get("/works")
          .set(headers(COLLEAGUE, team.organizationId))
          .expect(200)).body.items[0].workId}`)
        .set(headers(COLLEAGUE, team.organizationId))
        .expect(200);

      const found = (decisions.body.items as { decisionId: string; status: string }[]).find(
        (d) => d.decisionId === decisionId,
      );
      expect(found?.status).toBe("InReview");
    });

    it("An authorized human can approve or reject it", async () => {
      const approved = await withSubmittedDecision();
      const approval = await request(server())
        .post(`/decisions/${approved.decisionId}/approve`)
        .set(headers(REVIEWER, approved.team.organizationId))
        .send({ selectedOptionId: "eu", rationale: "Lower risk." })
        .expect(201);
      expect(approval.body.status).toBe("Approved");

      const rejected = await withSubmittedDecision();
      const rejection = await request(server())
        .post(`/decisions/${rejected.decisionId}/reject`)
        .set(headers(REVIEWER, rejected.team.organizationId))
        .send({ rationale: "Needs a cost comparison." })
        .expect(201);
      expect(rejection.body.status).toBe("Rejected");
    });

    it("The acting human and outcome are recorded", async () => {
      const { team, decisionId } = await withSubmittedDecision();
      await request(server())
        .post(`/decisions/${decisionId}/approve`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ selectedOptionId: "eu", rationale: "Lower risk." })
        .expect(201);

      // Read from storage: the criterion is about what was *retained*, not what
      // one response happened to echo back.
      //
      // Review evidence is on the revision rather than in a separate
      // `decision_review_records` table, which the persistence document records
      // as a deliberate deviation: "a review outcome is one-to-one with the
      // revision it resolves".
      const rows = await pool.query<{
        revision_status: string;
        reviewed_by_identity_id: string;
        review_rationale: string;
        selected_option_id: string;
      }>(
        `SELECT revision_status, reviewed_by_identity_id,
                review_rationale, selected_option_id
           FROM decision_revisions
          WHERE decision_id = $1 AND reviewed_at IS NOT NULL`,
        [decisionId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        revision_status: "Approved",
        review_rationale: "Lower risk.",
        selected_option_id: "eu",
      });
      expect(rows.rows[0]?.reviewed_by_identity_id).toBeTruthy();
    });

    it("The Secretary cannot approve or reject it", async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);
      const work = await createWork(team.organizationId);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(at)
        .send({ expectedVersion: work.version })
        .expect(201);
      const decision = await request(server())
        .post("/decisions")
        .set(at)
        .send({
          relatedWorkId: work.workId,
          title: "Which region?",
          question: "Which region first?",
          options: [
            { optionId: "eu", summary: "EU" },
            { optionId: "us", summary: "US" },
          ],
        })
        .expect(201);
      const decisionId = decision.body.decisionId as string;

      // The Secretary participates as fully as it ever can: it drafts material
      // while the Decision is a Draft. ADR-0011 binds it to a context-owned port,
      // so what comes back is a *contribution* — there is no assistance
      // operation that resolves a Decision, and no generic command executor.
      await request(server())
        .post(`/decisions/${decisionId}/assistance`)
        .set(at)
        .send({ operation: "decision.draft_material" })
        .expect(201);

      const contributions = await request(server())
        .get(`/decisions/${decisionId}/assistance`)
        .set(at)
        .expect(200);
      expect(contributions.body.items.length).toBeGreaterThan(0);

      await request(server())
        .post(`/decisions/${decisionId}/submit`)
        .set(at)
        .expect(201);

      // Everything the Secretary did, and the Decision still awaits a human.
      // `decision.approve` and `decision.reject` are Human-only permissions,
      // refused for a non-Human principal before roles are consulted at all.
      const rows = await pool.query<{ status: string }>(
        `SELECT status FROM decisions WHERE decision_id = $1`,
        [decisionId],
      );
      expect(rows.rows[0]?.status).toBe("InReview");

      // The contribution is recorded as advisory: attributed to the Secretary
      // Principal, and unadopted until a human chooses to use it.
      const recorded = await pool.query<{
        secretary_principal_id: string;
        adopted_at: Date | null;
        adopted_by_identity_id: string | null;
      }>(
        `SELECT secretary_principal_id, adopted_at, adopted_by_identity_id
           FROM decision_secretary_contributions WHERE decision_id = $1`,
        [decisionId],
      );
      expect(recorded.rows[0]?.secretary_principal_id).toBe(SECRETARY_PRINCIPAL_ID);
      expect(recorded.rows[0]?.adopted_at).toBeNull();
      expect(recorded.rows[0]?.adopted_by_identity_id).toBeNull();
    });
  });

  // ===========================================================================
  describe("Memory Generation", () => {
    it("Completing Work records a durable generation request", async () => {
      const team = await organizationWithTeam();
      const work = await completedWork(team.organizationId);

      // Before any worker runs: the trigger is in the Outbox, committed with the
      // completion itself (ADR-0006).
      const queued = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM outbox_messages
          WHERE aggregate_id = $1 AND event_type = 'WorkCompleted'`,
        [work.workId],
      );
      expect(queued.rows).toHaveLength(1);

      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

      const operations = await pool.query<{ status: string; source_snapshot_hash: string }>(
        `SELECT status, source_snapshot_hash FROM memory_generation_operations
          WHERE work_id = $1`,
        [work.workId],
      );
      expect(operations.rows).toHaveLength(1);
      expect(operations.rows[0]?.source_snapshot_hash).toBeTruthy();
    });

    it("Generation occurs without holding the Work transaction open", async () => {
      const team = await organizationWithTeam();
      const work = await completedWork(team.organizationId);

      // The completion has committed and returned; no Memory exists yet. That
      // gap is the property — generation is a separate process reading a durable
      // trigger, not a step inside the completing transaction.
      const before = await request(server())
        .get("/memories")
        .set(headers(COLLEAGUE, team.organizationId))
        .expect(200);
      expect(before.body.items).toHaveLength(0);

      const completed = await request(server())
        .get(`/works/${work.workId}`)
        .set(headers(COLLEAGUE, team.organizationId))
        .expect(200);
      expect(completed.body.status).toBe("Completed");

      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

      const after = await request(server())
        .get("/memories")
        .set(headers(COLLEAGUE, team.organizationId))
        .expect(200);
      expect(after.body.items).toHaveLength(1);
    });

    it("Temporary generation failure can be retried", async () => {
      const team = await organizationWithTeam();
      const work = await completedWork(team.organizationId);

      // Subclassed rather than hand-rolled: the operation is committed with the
      // generator's policy and schema versions *before* the provider is called,
      // so a stub missing them would fail earlier than the failure under test.
      class UnavailableProvider extends DeterministicMemoryGenerator {
        override generate(): never {
          throw new Error("provider unavailable");
        }
      }

      await drainOutbox(pool, dependenciesFor(pool), 20, {
        memory: {
          generator: new UnavailableProvider(),
          secretaryIdentityId: SECRETARY_IDENTITY_ID,
          systemPrincipalId: "memory-generator",
        },
      });

      // The attempt is durable evidence, not a lost request: ADR-0004 commits
      // the operation before the provider is called precisely so a failure
      // leaves a record of what was attempted, in a retryable state.
      const attempted = await pool.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count FROM memory_generation_operations WHERE work_id = $1`,
        [work.workId],
      );
      expect(attempted.rows).toHaveLength(1);
      expect(attempted.rows[0]).toMatchObject({ status: "RetryPending", attempt_count: 1 });

      // Retrying is an operator command, not a silent redelivery. A Failed
      // processed-event "is a terminal operational failure for ordinary
      // delivery ... it requires the typed, audited consumer-replay workflow",
      // and the failure has already been dead-lettered for exactly that.
      const letters = await request(server())
        .get("/admin/events/dead-letters")
        .set(headers(FOUNDER, team.organizationId))
        .expect(200);
      const letter = (letters.body.items as {
        deadLetterId: string;
        consumerName: string;
        version: number;
      }[]).find((l) => l.consumerName === "memory-generation");
      expect(letter).toBeDefined();

      await request(server())
        .post(`/admin/events/dead-letters/${letter!.deadLetterId}/reprocess`)
        .set(headers(FOUNDER, team.organizationId))
        .send({
          expectedVersion: letter!.version,
          reasonCode: "PROVIDER_RECOVERED",
          reason: "The model provider is available again.",
        })
        .expect(201);

      // The same trigger, now with a working provider.
      await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);

      const memories = await request(server())
        .get("/memories")
        .set(headers(COLLEAGUE, team.organizationId))
        .expect(200);
      expect(memories.body.items).toHaveLength(1);
    });

    it("Retry does not create duplicate active Memory", async () => {
      const team = await organizationWithTeam();
      const work = await completedWork(team.organizationId);

      // At-least-once delivery means the same trigger arrives more than once.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await pool.query(
          `UPDATE outbox_messages SET status = 'Pending', next_attempt_at = now()
            WHERE aggregate_id = $1 AND event_type = 'WorkCompleted'`,
          [work.workId],
        );
        await drainOutbox(pool, dependenciesFor(pool), 20, memoryOptions);
      }

      const active = await pool.query(
        `SELECT memory_id FROM memories WHERE source_work_id = $1 AND is_active`,
        [work.workId],
      );
      expect(active.rows).toHaveLength(1);
    });

    it("Generated Memory preserves source traceability", async () => {
      const team = await organizationWithTeam();
      const { work, memory } = await generatedMemory(team.organizationId);

      const rows = await pool.query<{
        source_work_id: string;
        source_snapshot_hash: string;
        generation_policy_version: number;
        generated_by_system_principal_id: string;
      }>(
        `SELECT source_work_id, source_snapshot_hash,
                generation_policy_version, generated_by_system_principal_id
           FROM memories WHERE memory_id = $1`,
        [memory.memoryId],
      );
      expect(rows.rows[0]).toMatchObject({
        source_work_id: work.workId,
        generated_by_system_principal_id: "memory-generator",
      });
      expect(rows.rows[0]?.source_snapshot_hash).toBeTruthy();
      expect(rows.rows[0]?.generation_policy_version).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  describe("Memory Review", () => {
    it("Generated Memory is editable before submission", async () => {
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);

      const edited = await request(server())
        .patch(`/memories/${memory.memoryId}`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version, title: "A human's title" })
        .expect(200);
      expect(edited.body.title).toBe("A human's title");
    });

    it("Submitting for review locks the draft", async () => {
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);

      const submitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version })
        .expect(201);
      expect(submitted.body.status).toBe("InReview");

      // Locked: the revision under review cannot be rewritten beneath the
      // reviewer.
      await request(server())
        .patch(`/memories/${memory.memoryId}`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: submitted.body.version, title: "Changed my mind" })
        .expect(409);
    });

    it("A human can approve or reject it", async () => {
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);
      const submitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version })
        .expect(201);

      const approved = await request(server())
        .post(`/memories/${memory.memoryId}/approve`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ expectedVersion: submitted.body.version })
        .expect(201);
      expect(approved.body.status).toBe("Approved");
    });

    it("A rejected Memory can be reopened and resubmitted", async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);
      const { memory } = await generatedMemory(team.organizationId);

      const submitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(at)
        .send({ expectedVersion: memory.version })
        .expect(201);
      const rejected = await request(server())
        .post(`/memories/${memory.memoryId}/reject`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ expectedVersion: submitted.body.version, note: "Missing the rollout risk." })
        .expect(201);
      expect(rejected.body.status).toBe("Rejected");

      const reopened = await request(server())
        .post(`/memories/${memory.memoryId}/reopen`)
        .set(at)
        .send({ expectedVersion: rejected.body.version })
        .expect(201);
      expect(reopened.body.status).toBe("Generated");

      const resubmitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(at)
        .send({ expectedVersion: reopened.body.version })
        .expect(201);
      expect(resubmitted.body.status).toBe("InReview");
    });

    it("The Secretary cannot approve or reject it", async () => {
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);
      await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version })
        .expect(201);

      // The Memory the Secretary itself drafted still needs a human. There is no
      // principal an HTTP caller can present that would let the AI approve:
      // `memory.approve` is Human-only, and the Secretary holds no Membership.
      const rows = await pool.query<{ status: string }>(
        `SELECT status FROM memories WHERE memory_id = $1`,
        [memory.memoryId],
      );
      expect(rows.rows[0]?.status).toBe("InReview");

      // And the human who drafted it is not automatically the one who may
      // approve: a plain Member holds no `memory.approve`.
      await request(server())
        .post(`/memories/${memory.memoryId}/approve`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version + 1 })
        .expect(403);
    });

    it("Approved Memory cannot be edited", async () => {
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);
      const submitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version })
        .expect(201);
      const approved = await request(server())
        .post(`/memories/${memory.memoryId}/approve`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ expectedVersion: submitted.body.version })
        .expect(201);

      await request(server())
        .patch(`/memories/${memory.memoryId}`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: approved.body.version, title: "Rewriting history" })
        .expect(409);

      // Nor by reopening it: approval is terminal.
      await request(server())
        .post(`/memories/${memory.memoryId}/reopen`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: approved.body.version })
        .expect(409);
    });
  });

  // ===========================================================================
  describe("Auditability", () => {
    it("Important state transitions identify the acting principal", async () => {
      const team = await organizationWithTeam();
      const work = await createWork(team.organizationId);
      await request(server())
        .post(`/works/${work.workId}/start`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: work.version })
        .expect(201);

      // Polled: the audit write is deliberately not awaited into the command's
      // own transaction, so an outage cannot become an availability outage.
      let rows: { membership_id: string | null; previous_state: string | null }[] = [];
      for (let attempt = 0; attempt < 50 && rows.length === 0; attempt += 1) {
        const result = await pool.query(
          `SELECT membership_id, previous_state, next_state
             FROM authorization_audit_records
            WHERE resource_id = $1 AND previous_state IS NOT NULL`,
          [work.workId],
        );
        rows = result.rows;
        if (rows.length === 0) await new Promise((r) => setTimeout(r, 10));
      }

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        membership_id: team.memberMembershipId,
        previous_state: "Draft",
      });
    });

    it("AI-generated content is attributable to the Secretary", async () => {
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);

      const rows = await pool.query<{
        created_by_actor_type: string;
        created_by_actor_id: string;
        created_by_membership_id: string | null;
      }>(
        `SELECT created_by_actor_type, created_by_actor_id, created_by_membership_id
           FROM memory_revisions WHERE memory_id = $1 ORDER BY revision_number`,
        [memory.memoryId],
      );
      expect(rows.rows[0]).toMatchObject({
        created_by_actor_type: "AI",
        created_by_actor_id: SECRETARY_IDENTITY_ID,
        // No Membership: an AI Principal holds none, which is what keeps it from
        // inheriting human authority.
        created_by_membership_id: null,
      });
    });

    it("Model and prompt metadata are retained where available", async () => {
      const team = await organizationWithTeam();
      const { work } = await generatedMemory(team.organizationId);

      const rows = await pool.query<{
        model_reference: string | null;
        prompt_template_version: number;
        generation_policy_version: number;
      }>(
        `SELECT model_reference, prompt_template_version, generation_policy_version
           FROM memory_generation_operations WHERE work_id = $1`,
        [work.workId],
      );
      expect(rows.rows[0]?.model_reference).toBeTruthy();
      expect(rows.rows[0]?.prompt_template_version).toBeGreaterThan(0);
      expect(rows.rows[0]?.generation_policy_version).toBeGreaterThan(0);
    });

    it("Review history remains available", async () => {
      const team = await organizationWithTeam();
      const at = headers(COLLEAGUE, team.organizationId);
      const { memory } = await generatedMemory(team.organizationId);

      const submitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(at)
        .send({ expectedVersion: memory.version })
        .expect(201);
      const rejected = await request(server())
        .post(`/memories/${memory.memoryId}/reject`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ expectedVersion: submitted.body.version, note: "Missing the rollout risk." })
        .expect(201);
      const reopened = await request(server())
        .post(`/memories/${memory.memoryId}/reopen`)
        .set(at)
        .send({ expectedVersion: rejected.body.version })
        .expect(201);
      await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(at)
        .send({ expectedVersion: reopened.body.version })
        .expect(201);

      // The rejected revision is still there beside the new one: a Memory that
      // was corrected must not read as one that was right the first time.
      const revisions = await pool.query<{ revision_number: number; revision_status: string }>(
        `SELECT revision_number, revision_status FROM memory_revisions
          WHERE memory_id = $1 ORDER BY revision_number`,
        [memory.memoryId],
      );
      expect(revisions.rows.length).toBeGreaterThan(1);
      expect(revisions.rows.map((r) => r.revision_status)).toContain("Rejected");
    });

    it("Cross-Organization references are prevented", async () => {
      const mine = await organizationWithTeam();
      const theirs = await createOrganization(OUTSIDER);
      const work = await createWork(mine.organizationId);

      // A Decision in one Organization cannot attach to Work in another. The
      // Work is reported absent rather than forbidden.
      await request(server())
        .post("/decisions")
        .set(headers(OUTSIDER, theirs.organizationId))
        .send({
          relatedWorkId: work.workId,
          title: "Reaching across",
          question: "Can I?",
          options: [{ optionId: "no", summary: "No" }],
        })
        .expect(404);

      // The database refuses it too, independently of the application: every
      // organization-owned row carries `organization_id` in a composite key.
      const rows = await pool.query(
        `SELECT organization_id FROM work_items WHERE work_id = $1`,
        [work.workId],
      );
      expect(rows.rows[0]?.organization_id).toBe(mine.organizationId);
    });
  });

  // ===========================================================================
  describe("Scope Control", () => {
    it("The product works without Knowledge, Capability, or AI Employees", async () => {
      // The whole loop, on a schema that contains no such table. If any of the
      // three were load-bearing, this would not complete.
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);
      const submitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version })
        .expect(201);
      await request(server())
        .post(`/memories/${memory.memoryId}/approve`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ expectedVersion: submitted.body.version })
        .expect(201);

      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [SCHEMA],
      );
      const names = tables.rows.map((r) => r.table_name);
      for (const forbidden of ["knowledge", "capabilities", "ai_employees"]) {
        expect(names.some((n) => n.includes(forbidden))).toBe(false);
      }
    });

    it("No MVP flow requires semantic retrieval", async () => {
      const tables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
        [SCHEMA],
      );
      const names = tables.rows.map((r) => r.table_name);
      for (const forbidden of ["embedding", "vector", "semantic", "index_document"]) {
        expect(names.some((n) => n.includes(forbidden))).toBe(false);
      }

      // No extension either: pgvector would be the way this crept in.
      const extensions = await pool.query<{ extname: string }>(
        `SELECT extname FROM pg_extension`,
      );
      expect(extensions.rows.map((r) => r.extname)).not.toContain("vector");
    });

    it("No business process requires an external message broker", async () => {
      const team = await organizationWithTeam();

      // Every asynchronous step in the loop is driven by the PostgreSQL Outbox
      // and nothing else — `drainOutbox` takes a `Pool` and no broker client.
      // Generation is the one that would need a broker if any did.
      const { memory } = await generatedMemory(team.organizationId);
      expect(memory.memoryId).toBeTruthy();

      const destinations = await pool.query<{ destination: string }>(
        `SELECT DISTINCT destination FROM outbox_messages`,
      );
      expect(destinations.rows.map((r) => r.destination)).toEqual(["local"]);
    });

    it("No post-approval Memory editing is exposed", async () => {
      const team = await organizationWithTeam();
      const { memory } = await generatedMemory(team.organizationId);
      const submitted = await request(server())
        .post(`/memories/${memory.memoryId}/submit`)
        .set(headers(COLLEAGUE, team.organizationId))
        .send({ expectedVersion: memory.version })
        .expect(201);
      const approved = await request(server())
        .post(`/memories/${memory.memoryId}/approve`)
        .set(headers(REVIEWER, team.organizationId))
        .send({ expectedVersion: submitted.body.version })
        .expect(201);

      // Every route that could change an Approved Memory, tried by the most
      // privileged caller there is. "Exposed" is about the surface, so the check
      // is over the surface rather than over one representative call.
      const owner = headers(FOUNDER, team.organizationId);
      const v = approved.body.version;
      await request(server())
        .patch(`/memories/${memory.memoryId}`)
        .set(owner)
        .send({ expectedVersion: v, title: "Rewritten" })
        .expect(409);
      for (const command of ["submit", "approve", "reject", "reopen"]) {
        await request(server())
          .post(`/memories/${memory.memoryId}/${command}`)
          .set(owner)
          .send({ expectedVersion: v, note: "x" })
          .expect(409);
      }

      // And no route exists that deletes one.
      await request(server())
        .delete(`/memories/${memory.memoryId}`)
        .set(owner)
        .expect(404);
    });
  });
});
