/**
 * The migration chain must reproduce the documented schema exactly (ADR-0020).
 *
 * Two schemas are built in the same database:
 *
 * - one by applying `migrations/*.sql` in order, as a deployment would;
 * - one by applying `build/schema.sql`, generated from
 *   `persistence-and-data-model.md`, as every other test suite does.
 *
 * Their catalogs are then compared. This is the property that keeps ADR-0015
 * intact once migrations exist: **the documents remain the authority on what the
 * schema is, and the migrations on how an existing database reaches it.** A
 * migration written without the matching documentation edit fails here, and so
 * does a documentation edit with no migration behind it.
 *
 * Without this, the two descriptions drift and the documents quietly become
 * decoration — the exact failure ADR-0015 exists to prevent, arriving by another
 * route.
 *
 * Skipped when DATABASE_URL is unset.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMigrations, migrate, planFor } from "./migrations.js";

const url = process.env["DATABASE_URL"];
const suite = url ? describe : describe.skip;
const repoRoot = resolve(import.meta.dirname, "../../..");

/** Built by the migration chain. */
const MIGRATED = "test_migrated";
/** Built by the DDL the documents describe. */
const DOCUMENTED = "test_documented";

interface Column {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface Definition {
  table_name: string;
  name: string;
  definition: string;
}

suite("the migration chain reproduces the documented schema", () => {
  let pool: Pool;

  /**
   * Everything the comparison covers, for one schema.
   *
   * `schema_migrations` is excluded throughout. It is created by the runner and
   * deliberately absent from the documented DDL — including it would make this
   * test compare the migration system against itself.
   */
  const columnsOf = async (schema: string): Promise<Column[]> => {
    const result = await pool.query<Column>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name <> 'schema_migrations'
        ORDER BY table_name, column_name`,
      [schema],
    );
    return result.rows;
  };

  /**
   * Both schemas exist in one database, so PostgreSQL renders cross-table
   * references schema-qualified. That qualification is the one difference the
   * comparison must ignore — it is an artefact of building both side by side,
   * not a difference in what was created.
   */
  const unqualified = (rows: Definition[], schema: string): Definition[] =>
    rows.map((row) => ({
      ...row,
      definition: row.definition.replace(new RegExp(`\\b${schema}\\.`, "g"), ""),
    }));

  const constraintsOf = async (schema: string): Promise<Definition[]> => {
    const result = await pool.query<Definition>(
      `SELECT rel.relname AS table_name,
              con.conname  AS name,
              pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = $1
          AND rel.relname <> 'schema_migrations'
        ORDER BY rel.relname, con.conname`,
      [schema],
    );
    // A foreign key renders as `REFERENCES <schema>.<table>(...)`.
    return unqualified(result.rows, schema);
  };

  const indexesOf = async (schema: string): Promise<Definition[]> => {
    const result = await pool.query<Definition>(
      `SELECT tablename AS table_name,
              indexname  AS name,
              indexdef   AS definition
         FROM pg_indexes
        WHERE schemaname = $1
          AND tablename <> 'schema_migrations'
        ORDER BY tablename, indexname`,
      [schema],
    );
    // `CREATE INDEX ... ON <schema>.<table>`.
    return unqualified(result.rows, schema);
  };

  beforeAll(async () => {
    execFileSync("python3", [resolve(repoRoot, "scripts/extract_schema.py")], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    pool = new Pool({ connectionString: url });

    const client = await pool.connect();
    try {
      for (const schema of [MIGRATED, DOCUMENTED]) {
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
      }
      await client.query(`SET search_path TO ${DOCUMENTED}`);
      await client.query(readFileSync(resolve(repoRoot, "build/schema.sql"), "utf8"));
    } finally {
      client.release();
    }

    // Applied the way a deployment would, through the runner itself rather than
    // by concatenating the files — so the runner's own behaviour is under test.
    await migrate(pool, { schema: MIGRATED });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("produces the same tables", async () => {
    const migrated = new Set((await columnsOf(MIGRATED)).map((c) => c.table_name));
    const documented = new Set((await columnsOf(DOCUMENTED)).map((c) => c.table_name));

    expect([...migrated].sort()).toEqual([...documented].sort());
    expect(migrated.size).toBeGreaterThan(0);
  });

  it("produces the same columns, types, nullability, and defaults", async () => {
    expect(await columnsOf(MIGRATED)).toEqual(await columnsOf(DOCUMENTED));
  });

  it("produces the same constraints", async () => {
    // Definitions come from `pg_get_constraintdef`, so this compares what
    // PostgreSQL understands rather than how the SQL happened to be written.
    expect(await constraintsOf(MIGRATED)).toEqual(await constraintsOf(DOCUMENTED));
  });

  it("produces the same indexes", async () => {
    expect(await indexesOf(MIGRATED)).toEqual(await indexesOf(DOCUMENTED));
  });

  it("records every migration it applied, and applies each once", async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${MIGRATED}`);
      const plan = await planFor(client, loadMigrations());

      expect(plan.applied).toEqual(loadMigrations().map((m) => m.version));
      expect(plan.pending).toEqual([]);
      expect(plan.changed).toEqual([]);
    } finally {
      client.release();
    }
  });

  it("is idempotent: running again applies nothing", async () => {
    // The property a deployment depends on. Every instance starting up runs the
    // migrator, and all but the first must be a no-op.
    expect(await migrate(pool, { schema: MIGRATED })).toEqual([]);
  });

  it("refuses to migrate when an applied migration has changed", async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${MIGRATED}`);
      await client.query(
        "UPDATE schema_migrations SET checksum = 'tampered' WHERE version = $1",
        [loadMigrations()[0]!.version],
      );
    } finally {
      client.release();
    }

    // An edited migration means some databases hold one schema and some another.
    // Nothing else in the system would reveal it, so this refuses loudly rather
    // than continuing.
    await expect(migrate(pool, { schema: MIGRATED })).rejects.toThrow(/has changed since/);

    const restore = await pool.connect();
    try {
      await restore.query(`SET search_path TO ${MIGRATED}`);
      await restore.query(
        "UPDATE schema_migrations SET checksum = $2 WHERE version = $1",
        [loadMigrations()[0]!.version, loadMigrations()[0]!.checksum],
      );
    } finally {
      restore.release();
    }
  });

  /**
   * The property that motivated ADR-0020.
   *
   * `build/schema.sql` describes a destination: applied to a database that holds
   * rows it fails on the first `CREATE TABLE`, which is why a populated database
   * previously had no way forward at all. This exercises a two-step chain
   * against real data and asserts the data is still there afterwards.
   *
   * The chain is written to a temporary directory rather than added to
   * `migrations/`, because the repository ships exactly one migration and a
   * second one invented for a test would have to be reverted before every
   * release.
   */
  it("moves a database that already holds rows", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "aios-migrations-"));
    writeFileSync(
      resolve(directory, "0001_baseline.sql"),
      readFileSync(resolve(repoRoot, "migrations/0001_baseline.sql"), "utf8"),
    );

    const schema = "test_populated";
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }

    await migrate(pool, { schema, directory });

    // A row that must survive the next migration.
    const identityId = "0a105eed-0000-4000-8000-0000000000f1";
    const seeded = await pool.connect();
    try {
      await seeded.query(`SET search_path TO ${schema}`);
      await seeded.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Before the migration', 1, now(), now())`,
        [identityId],
      );
    } finally {
      seeded.release();
    }

    writeFileSync(
      resolve(directory, "0002_add_column.sql"),
      "ALTER TABLE human_identities ADD COLUMN pronouns text NULL;",
    );
    expect(await migrate(pool, { schema, directory })).toEqual(["0002_add_column"]);

    const after = await pool.connect();
    try {
      await after.query(`SET search_path TO ${schema}`);
      const rows = await after.query<{ display_name: string; pronouns: string | null }>(
        "SELECT display_name, pronouns FROM human_identities WHERE identity_id = $1",
        [identityId],
      );
      // The row is still there, and the new column exists beside it.
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toEqual({
        display_name: "Before the migration",
        pronouns: null,
      });
    } finally {
      after.release();
    }
  }, 60_000);

  /**
   * A failing migration must leave the database on the previous version rather
   * than partway through this one — the reason each migration and its ledger row
   * share a transaction.
   */
  it("rolls a failed migration back whole", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "aios-migrations-"));
    writeFileSync(
      resolve(directory, "0001_baseline.sql"),
      readFileSync(resolve(repoRoot, "migrations/0001_baseline.sql"), "utf8"),
    );

    const schema = "test_rollback";
    const client = await pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      client.release();
    }
    await migrate(pool, { schema, directory });

    // Valid first statement, invalid second. Without one transaction per
    // migration the column would exist and the ledger would deny it.
    writeFileSync(
      resolve(directory, "0002_half_valid.sql"),
      "ALTER TABLE human_identities ADD COLUMN half text NULL;\n" +
        "ALTER TABLE no_such_table ADD COLUMN nope text NULL;",
    );

    await expect(migrate(pool, { schema, directory })).rejects.toThrow(/0002_half_valid/);

    const after = await pool.connect();
    try {
      const column = await after.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'human_identities'
            AND column_name = 'half'`,
        [schema],
      );
      expect(column.rows).toHaveLength(0);

      await after.query(`SET search_path TO ${schema}`);
      const ledger = await after.query("SELECT version FROM schema_migrations");
      expect(ledger.rows.map((r) => r.version)).toEqual(["0001_baseline"]);
    } finally {
      after.release();
    }
  }, 60_000);
});
