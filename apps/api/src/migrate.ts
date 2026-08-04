/**
 * Schema migration command (ADR-0020).
 *
 * A thin entry point. The runner lives in `@aios/persistence`, where the schema
 * is that package's subject; this exists so deployment has something to invoke
 * beside `seed` and `evaluate`.
 *
 *     pnpm --filter @aios/api migrate
 *     pnpm --filter @aios/api migrate -- --status
 */


import { createPool, loadMigrations, migrate, planFor } from "@aios/persistence";

const main = async (): Promise<number> => {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url.length === 0) {
    console.error("DATABASE_URL is not set.");
    return 1;
  }

  const statusOnly = process.argv.includes("--status");
  const pool = createPool({ connectionString: url });

  try {
    if (statusOnly) {
      const client = await pool.connect();
      try {
        const plan = await planFor(client, loadMigrations());
        console.log(`Applied: ${plan.applied.length}   Pending: ${plan.pending.length}`);
        for (const migration of plan.pending) {
          console.log(`  pending  ${migration.version}`);
        }
        for (const version of plan.changed) console.log(`  CHANGED  ${version}`);
        // A changed migration is a failure even in a read-only report: some
        // databases hold one schema and some another.
        return plan.changed.length > 0 ? 1 : 0;
      } finally {
        client.release();
      }
    }

    const applied = await migrate(pool, { log: (line) => console.log(line) });
    console.log(
      applied.length === 0 ? "Up to date." : `Applied ${applied.length} migration(s).`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
};

process.exitCode = await main();
