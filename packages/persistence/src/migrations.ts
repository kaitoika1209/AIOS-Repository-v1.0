/**
 * Schema migrations (ADR-0020).
 *
 * Migrations are hand-written, numbered, and forward-only. Each is applied
 * inside one transaction together with its ledger row, so a migration either
 * lands completely or not at all — PostgreSQL's transactional DDL is what makes
 * that possible.
 *
 * There is no `down`. The architecture already requires continuous WAL
 * archiving, a 14-day PITR window, and a monthly verified restore test; that is
 * a *tested* recovery mechanism, where a `down` migration is one exercised only
 * in the emergency it was written for — and a `down` that drops a column
 * destroys data point-in-time recovery would have preserved. Reversing a
 * deployment means restoring, or writing a new forward migration.
 *
 * TypeScript rather than a script in another language because this runs during
 * deployment: the production image already has Node and the `pg` driver, and a
 * migration runner is a bad reason to add a second runtime to it.
 *
 * Here rather than in `apps/api` because the schema is this package's subject —
 * ADR-0015 makes the documented DDL authoritative and this package is what
 * speaks to it. `apps/api/src/migrate.ts` is the command-line entry point.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../../migrations");

/**
 * The ledger, created by the runner and absent from the documented DDL.
 *
 * It records how a database reached its current state, which the domain schema
 * does not describe — and including it in `persistence-and-data-model.md` would
 * make the equivalence check compare the migration system against itself.
 */
const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
)`;

export interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

const checksumOf = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

/** Every migration on disk, ordered by filename. */
export const loadMigrations = (directory = MIGRATIONS_DIR): readonly Migration[] => {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    throw new Error(`No migrations found in ${directory}.`);
  }

  return files.map((name) => {
    const sql = readFileSync(resolve(directory, name), "utf8");
    return { version: name.replace(/\.sql$/, ""), sql, checksum: checksumOf(sql) };
  });
};

export interface MigrationPlan {
  readonly applied: readonly string[];
  readonly pending: readonly Migration[];
  /**
   * Migrations recorded as applied whose content has since changed.
   *
   * Fatal rather than a warning: an edited migration means some databases hold
   * one version of the schema and some another, and nothing else in the system
   * would reveal it.
   */
  readonly changed: readonly string[];
}

export const planFor = async (
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<MigrationPlan> => {
  await client.query(LEDGER);
  const recorded = await client.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations",
  );
  const byVersion = new Map(recorded.rows.map((r) => [r.version, r.checksum]));

  return {
    applied: [...byVersion.keys()].sort(),
    pending: migrations.filter((m) => !byVersion.has(m.version)),
    changed: migrations
      .filter((m) => byVersion.has(m.version) && byVersion.get(m.version) !== m.checksum)
      .map((m) => m.version),
  };
};

/**
 * Apply every pending migration.
 *
 * Returns the versions applied. Refuses to apply anything when an
 * already-applied migration has changed, checked before the first write so an
 * investigation does not start from a half-migrated database.
 */
export const migrate = async (
  pool: Pool,
  options: {
    readonly schema?: string;
    readonly log?: (line: string) => void;
    /** Overridden only by tests, which exercise chains this repository does not ship. */
    readonly directory?: string;
  } = {},
): Promise<readonly string[]> => {
  const log = options.log ?? (() => {});
  const client = await pool.connect();

  try {
    if (options.schema !== undefined) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${options.schema}"`);
      await client.query(`SET search_path TO "${options.schema}"`);
    }

    const migrations = loadMigrations(options.directory);
    const plan = await planFor(client, migrations);

    if (plan.changed.length > 0) {
      throw new Error(
        "Refusing to migrate. These are recorded as applied but their content " +
          `has changed since: ${plan.changed.join(", ")}.`,
      );
    }

    for (const migration of plan.pending) {
      // One transaction per migration, ledger row included. A failure leaves the
      // database on the previous version rather than partway through this one.
      await client.query("BEGIN");
      try {
        if (options.schema !== undefined) {
          await client.query(`SET search_path TO "${options.schema}"`);
        }
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum, applied_at) " +
            "VALUES ($1, $2, now())",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${migration.version} failed and was rolled back: ${String(error)}`,
        );
      }
      log(`  applied  ${migration.version}`);
    }

    return plan.pending.map((m) => m.version);
  } finally {
    client.release();
  }
};
