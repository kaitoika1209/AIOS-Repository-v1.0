/**
 * The workflow-health projection against a real database (ADR-0023).
 *
 * Everything here is a claim PostgreSQL has to hold up rather than TypeScript:
 * that the upsert round-trips every column, that a repeated reconcile updates
 * rather than duplicates, that `removeOthers` cannot reach the Organizations it
 * was told to keep, and that the check constraints refuse a status or workflow
 * type outside the vocabulary.
 *
 * Skipped when DATABASE_URL is unset.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OrganizationId, type OrganizationId as OrgId } from "@aios/types";
import type { WorkflowHealthRow } from "@aios/application";

import { PostgresWorkflowHealthQuery } from "./workflow-health-query.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;
const SCHEMA = "test_workflow_health";
const repoRoot = resolve(import.meta.dirname, "../../..");

const ORG = OrganizationId("11111111-1111-4111-8111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-4222-8222-222222222222");
const ARCHIVED_ORG = OrganizationId("33333333-3333-4333-8333-333333333333");
const IDENTITY = "44444444-4444-4444-8444-444444444444";

const OBSERVED = new Date("2026-08-05T09:00:00.000Z");

const rowFor = (over: Partial<WorkflowHealthRow> = {}): WorkflowHealthRow => ({
  workflowType: "OutboxPublication",
  status: "Healthy",
  reasonCode: "OK",
  pendingCount: 0,
  oldestPendingAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  terminalFailureCount: 0,
  lastErrorCode: null,
  sourceHighWaterMark: OBSERVED,
  projectionVersion: 1,
  updatedAt: OBSERVED,
  ...over,
});

suite("the workflow-health projection", () => {
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
        `TRUNCATE organization_workflow_health, organizations, human_identities CASCADE`,
      );
      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Operator', 1, now(), now())`,
        [IDENTITY],
      );
      for (const [org, status] of [
        [ORG, "Active"],
        [OTHER_ORG, "Suspended"],
        [ARCHIVED_ORG, "Archived"],
      ] as const) {
        await client.query(
          `INSERT INTO organizations
             (organization_id, name, status, created_by_identity_id, version, created_at, updated_at${
               status === "Suspended" ? ", suspended_at" : status === "Archived" ? ", archived_at" : ""
             })
           VALUES ($1, 'Org', $2, $3, 1, now(), now()${
             status === "Active" ? "" : ", now()"
           })`,
          [org, status, IDENTITY],
        );
      }
    } finally {
      client.release();
    }
  });

  const withQuery = async <T>(
    fn: (query: PostgresWorkflowHealthQuery) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(new PostgresWorkflowHealthQuery(client));
    } finally {
      client.release();
    }
  };

  it("round-trips every column", async () => {
    const written = rowFor({
      status: "Degraded",
      reasonCode: "PENDING_OVER_THRESHOLD",
      pendingCount: 12,
      oldestPendingAt: new Date("2026-08-05T08:30:00.000Z"),
      lastAttemptAt: new Date("2026-08-05T08:59:00.000Z"),
      lastSuccessAt: new Date("2026-08-05T08:00:00.000Z"),
      consecutiveFailures: 3,
      terminalFailureCount: 1,
      lastErrorCode: "PROVIDER_TIMEOUT",
    });

    const read = await withQuery(async (q) => {
      await q.upsert(ORG, [written]);
      return q.readFor(ORG);
    });

    // Every column, because a projection that silently drops one is a projection
    // that answers a narrower question than it claims to.
    expect(read).toEqual([written]);
  });

  it("updates rather than duplicating on a second reconcile", async () => {
    const read = await withQuery(async (q) => {
      await q.upsert(ORG, [rowFor()]);
      await q.upsert(ORG, [rowFor({ status: "Blocked", reasonCode: "UNRESOLVED_FAILURE" })]);
      return q.readFor(ORG);
    });

    expect(read).toHaveLength(1);
    expect(read[0]?.status).toBe("Blocked");
  });

  it("observes Suspended Organizations and not Archived ones", async () => {
    const observed = await withQuery((q) => q.organizationsToObserve());

    // A suspended Organization can be reactivated and its committed work is
    // still waiting; an archived one is terminal, so a projection row for it
    // would describe a workflow nobody can act on.
    expect([...observed].sort()).toEqual([ORG, OTHER_ORG].sort());
  });

  it("removes only the Organizations outside the kept set", async () => {
    const [removed, kept, gone] = await withQuery(async (q) => {
      await q.upsert(ORG, [rowFor()]);
      await q.upsert(OTHER_ORG, [rowFor()]);
      const count = await q.removeOthers([ORG]);
      return [count, await q.readFor(ORG), await q.readFor(OTHER_ORG)];
    });

    expect(removed).toBe(1);
    expect(kept).toHaveLength(1);
    expect(gone).toEqual([]);
  });

  it("keeps one Organization's rows out of another's read", async () => {
    const read = await withQuery(async (q) => {
      await q.upsert(ORG, [rowFor({ status: "Blocked", reasonCode: "UNRESOLVED_FAILURE" })]);
      return q.readFor(OTHER_ORG);
    });

    expect(read).toEqual([]);
  });

  it("refuses a status outside the vocabulary", async () => {
    // `Critical` was ADR-0021's name for `Blocked` and ADR-0023 renamed it. The
    // constraint is what stops the old name coming back through a call site
    // nobody rechecked.
    await expect(
      withQuery((q) =>
        q.upsert(ORG, [rowFor({ status: "Critical" as WorkflowHealthRow["status"] })]),
      ),
    ).rejects.toThrow(/ck_workflow_health_status/);
  });

  it("refuses a workflow type outside the vocabulary", async () => {
    await expect(
      withQuery((q) =>
        q.upsert(ORG, [
          rowFor({ workflowType: "Reconciliation" as WorkflowHealthRow["workflowType"] }),
        ]),
      ),
    ).rejects.toThrow(/ck_workflow_health_type/);
  });

  it("refuses a row for an Organization that does not exist", async () => {
    const ghost = OrganizationId("99999999-9999-4999-8999-999999999999") as OrgId;

    // The foreign key is what makes "cross-Organization references" a thing the
    // database prevents rather than a thing reconciliation has to look for.
    await expect(withQuery((q) => q.upsert(ghost, [rowFor()]))).rejects.toThrow(
      /foreign key/i,
    );
  });
});
