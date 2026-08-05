/**
 * The diagnostic queries, against a schema built the way a deployment builds it.
 *
 * This suite applies the **migration chain** rather than `build/schema.sql`, and
 * that is the point rather than a detail. Every other database-backed suite
 * builds from the documented DDL, which has no `schema_migrations` — so a query
 * against the migration ledger is invisible to all of them. A wrong column name
 * there passed every test and failed the first time the route was called against
 * a real deployment.
 *
 * Skipped when DATABASE_URL is unset.
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { OrganizationId } from "@aios/types";

import { PostgresDiagnosticsQuery } from "./diagnostics-query.js";
import { migrate } from "./migrations.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;
const SCHEMA = "test_diagnostics";

const ORG = OrganizationId("11111111-1111-4111-8111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-4222-8222-222222222222");
const IDENTITY = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP = "44444444-4444-4444-8444-444444444444";
const WINDOW_START = new Date(Date.now() - 60 * 60 * 1000);

suite("the diagnostic queries", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    } finally {
      client.release();
    }
    // The deployment path, ledger and all. `migrate` takes the pool because it
    // owns its own transaction per migration.
    await migrate(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `TRUNCATE outbox_messages, processed_events, consumer_ordering_state,
                  dead_letter_events, memory_generation_operations,
                  worker_pauses, organization_workflow_health,
                  work_items, memberships, organizations, human_identities CASCADE`,
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
      await client.query(
        `INSERT INTO memberships
           (membership_id, organization_id, identity_id, status, invited_at,
            activated_at, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Active', now(), now(), 1, now(), now())`,
        [MEMBERSHIP, ORG, IDENTITY],
      );
    } finally {
      client.release();
    }
  });

  const gather = async (organizationId = ORG) => {
    const client = await pool.connect();
    try {
      return await new PostgresDiagnosticsQuery(client).gather(
        organizationId,
        WINDOW_START,
        50,
      );
    } finally {
      client.release();
    }
  };

  const outboxRow = async (
    organizationId: string,
    over: {
      status?: string;
      lockedUntil?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
    } = {},
  ) => {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO outbox_messages (
           outbox_id, event_id, event_type, event_category, schema_version,
           aggregate_type, aggregate_id, aggregate_version, event_sequence,
           organization_id, payload, headers, destination,
           occurred_at, recorded_at, correlation_id, actor_reference,
           status, attempt_count, next_attempt_at, last_attempt_at,
           locked_until, last_error_code, last_error_message
         ) VALUES ($1, $2, 'WorkCompleted', 'Domain', 1, 'Work', $3, 1, 1,
                   $4, '{}'::jsonb, '{}'::jsonb, 'local', now(), now(), $5, '{}'::jsonb,
                   $6, 1, now(), now(), $7, $8, $9)`,
        [
          randomUUID(),
          randomUUID(),
          randomUUID(),
          organizationId,
          randomUUID(),
          over.status ?? "Pending",
          over.lockedUntil ?? null,
          over.errorCode ?? null,
          over.errorMessage ?? null,
        ],
      );
    } finally {
      client.release();
    }
  };

  it("reads the migration ledger the runner actually created", async () => {
    const facts = await gather();

    // The assertion that would have caught a guessed column name. Every other
    // suite builds its schema from the documented DDL, where this table does not
    // exist at all.
    expect(facts.schemaVersion).toMatch(/^\d{4}_/);
  });

  it("counts pending, failed, and claims whose lease expired", async () => {
    await outboxRow(ORG);
    await outboxRow(ORG, { status: "Failed", errorCode: "PROVIDER_TIMEOUT" });
    await outboxRow(ORG, {
      status: "Claimed",
      lockedUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    // A live claim, which is not a problem and must not be counted as one.
    await outboxRow(ORG, {
      status: "Claimed",
      lockedUntil: new Date(Date.now() + 60_000).toISOString(),
    });

    const facts = await gather();

    expect(facts.outbox).toMatchObject({ pending: 1, failed: 1, claimExpired: 1 });
    expect(facts.outbox.oldestPendingSeconds).not.toBeNull();
  });

  it("reports error codes and never the messages beside them", async () => {
    await outboxRow(ORG, {
      status: "Failed",
      errorCode: "PROVIDER_TIMEOUT",
      errorMessage: "connection to secret-host:5432 failed for user bob@example.test",
    });

    const facts = await gather();

    expect(facts.outbox.errorCodes).toEqual([
      { errorCode: "PROVIDER_TIMEOUT", count: 1 },
    ]);
    expect(JSON.stringify(facts)).not.toContain("secret-host");
  });

  it("excludes failures older than the window", async () => {
    await outboxRow(ORG, { status: "Failed", errorCode: "OLD_FAILURE" });
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE outbox_messages SET last_attempt_at = now() - interval '2 days'`,
      );
    } finally {
      client.release();
    }

    const facts = await gather();

    // The time bound the architecture requires, doing something. The row is
    // still counted in `failed`, which is a current-state count; only the
    // windowed breakdown drops it.
    expect(facts.outbox.errorCodes).toEqual([]);
    expect(facts.outbox.failed).toBe(1);
  });

  it("counts nothing belonging to another Organization", async () => {
    await outboxRow(OTHER_ORG, { status: "Failed", errorCode: "THEIRS" });

    const facts = await gather(ORG);

    expect(facts.outbox).toMatchObject({ pending: 0, failed: 0 });
    expect(facts.outbox.errorCodes).toEqual([]);
  });

  it("counts blocked ordering keys by status", async () => {
    const client = await pool.connect();
    try {
      // `ck_consumer_ordering_state_blocked` ties the status to its evidence:
      // a Blocked key must name the event, the instant, and the reason.
      for (const status of ["Blocked", "Active"]) {
        const blocked = status === "Blocked";
        await client.query(
          `INSERT INTO consumer_ordering_state (
             consumer_ordering_state_id, consumer_name, organization_id,
             ordering_key_type, ordering_key, status,
             blocked_event_id, blocked_at, block_reason_code,
             version, updated_at
           ) VALUES ($1, 'decision-outcome', $2, 'AggregateStream', $3, $4,
                     $5, $6, $7, 1, now())`,
          [
            randomUUID(),
            ORG,
            randomUUID(),
            status,
            blocked ? randomUUID() : null,
            blocked ? new Date() : null,
            blocked ? "DELIVERY_FAILED" : null,
          ],
        );
      }
    } finally {
      client.release();
    }

    const facts = await gather();

    expect(facts.deliveries.blockedOrderingKeys).toBe(1);
  });

  it("answers with zeroes rather than failing for an Organization with no history", async () => {
    const facts = await gather(OTHER_ORG);

    // A diagnostic surface that threw on an empty Organization would be one an
    // operator could not use on a new tenant, which is when they most want it.
    expect(facts.outbox).toMatchObject({ pending: 0, failed: 0, claimExpired: 0 });
    expect(facts.deliveries.deadLettersByStatus).toEqual({});
    expect(facts.generation.byStatus).toEqual({});
  });
});
