# ADR-0020: Adopt Forward-Only Migrations, Checked Against the Documented DDL

**Status:** Proposed  
**Date:** 2026-07-31  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** before the first production write, when a migration needs an operation PostgreSQL cannot run inside a transaction, or when the schema grows large enough that a full-schema comparison becomes slow

**Scope classification:** MVP Normative

## Context

[ADR-0015](0015-use-documented-ddl-and-direct-sql-for-persistence.md) makes
`docs/architecture/persistence-and-data-model.md` the authority on the schema, and
`scripts/extract_schema.py` turns that document into `build/schema.sql` — 1,685 lines of
`CREATE TABLE`, constraints, and indexes. Every test suite applies it to a freshly created,
empty schema.

That works precisely because every database it has ever touched was empty. The generated
file describes a destination and nothing else: applied to a database that already holds
rows, it fails on the first `CREATE TABLE`.

So there is today no way to change the schema of a database that contains data. There is no
migration tooling, no migration history, and no decision about either. The first production
write makes this a live problem, and every day after that makes it more expensive — a
schema gap is cheap to close before there is anything to preserve and expensive afterwards.

`docs/engineering/release-readiness.md` names this as the item most easily missed, "because
everything works today".

### The obvious fix would cost the property ADR-0015 bought

Adopting a conventional migration tool and hand-writing the chain gives two descriptions of
the same schema: the documents, and the accumulated migrations. Nothing would keep them
equal. The documents would drift into decoration — still read, no longer true — which is
the exact failure ADR-0015 exists to prevent, arriving by a different route.

## Decision

### Migrations are hand-written, numbered, and forward-only

```text
migrations/0001_baseline.sql
migrations/0002_....sql
```

Each file is applied inside one transaction together with its ledger row, so a migration
either lands completely or not at all. PostgreSQL's transactional DDL is what makes that
possible and is a reason the MVP is on PostgreSQL rather than a database without it.

`0001_baseline.sql` is the schema as it stands: the current `extract_schema.py` output,
frozen. Every database that exists today was built from exactly that, so the baseline is
not a claim about history — it is the state every environment is already in.

### The chain must reproduce the documents exactly, and CI proves it

`packages/persistence/src/migrations.test.ts` builds two PostgreSQL schemas:

- one by applying `migrations/*.sql` in order;
- one by applying `build/schema.sql`, generated from the documents.

It then compares the catalogs — tables, columns with their types, nullability and defaults,
constraint definitions, and index definitions — and fails on any difference.

It is a test rather than a `scripts/` check because it needs a database, and the repository
already runs database-backed tests where `DATABASE_URL` is set. The documentation checks
stay dependency-free and fast.

This is what keeps ADR-0015 intact. **The documents remain the authority on what the schema
is; the migrations are the authority on how an existing database reaches it.** Neither can
drift, because a divergent pair cannot be merged.

It also decides where a schema change starts: in the document. A migration written without
the corresponding documentation edit fails the check, and so does a documentation edit with
no migration behind it.

### The ledger is infrastructure, not domain

```sql
CREATE TABLE schema_migrations (
    version     text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL
);
```

Created by the runner if absent, and **excluded from the comparison**. It records how a
database got to its current state, which is not something the domain schema describes. It
is deliberately absent from `persistence-and-data-model.md`: including it would make the
check compare the migration system against itself.

`checksum` is recorded so that editing an already-applied migration is detectable. The
runner refuses to proceed when a recorded checksum no longer matches the file, because an
edited migration means some databases have one version and some another, and nothing else
would reveal it.

The runner is TypeScript (`apps/api/src/migrate.ts`) using the `pg` driver the application
already depends on, rather than a script in another language. It runs during deployment, so
it must not add a runtime to the production image.

### Forward-only, with restore as the rollback path

No `down` migrations.

The architecture already requires "continuous WAL archiving, a physical base backup at
least every 24 hours, a 14-day PITR window, a monthly verified restore test". That is a
tested recovery mechanism. A `down` migration is a second one that is exercised only in the
emergency it was written for, and a `down` that drops a column destroys data point-in-time
recovery would have preserved.

Reversing a deployment therefore means restoring, or writing a new forward migration. The
"Deployment rollback" runbook the observability baseline requires must say which, and must
say that a released migration is not un-released.

The cost is real: a migration that is wrong in production cannot be undone by re-running a
tool. That is the intended pressure. It is also why the check above runs on every change —
the cheapest place to catch a bad migration is before it merges.

## Alternatives considered

### A conventional migration tool with hand-written migrations, and no check

Rejected. This is the industry default and it is what produces the drift described above.
The tool is not the problem; the missing equivalence proof is. Adding the check to a
third-party tool would have been acceptable — the reason not to is below.

### A third-party migration tool with the equivalence check bolted on

Rejected for the MVP, though it remains reasonable later. The runner this ADR needs is a
loop over ordered `.sql` files inside transactions, with a ledger and a checksum: small
enough that a dependency buys mostly its own configuration surface, and small enough to
read in full before trusting it with a production schema.

Reconsider when migrations need capabilities this does not have — advisory locking across
concurrently deploying instances is the likeliest trigger.

### Generate migrations by diffing the documented DDL against the live schema

Rejected. It is the most attractive option on paper and the least trustworthy in practice:
a generated `ALTER` knows the shape difference and not the intent, so it cannot tell a
rename from a drop-and-add, and the difference between those two is whether the data
survives. A human writes the migration; the check confirms the destination.

### Drop and recreate, relying on backups

Rejected as an approach to routine schema change. It is what the system does today by
accident rather than by choice, and it destroys data that is the product's entire purpose
to retain.

## Consequences

A schema change now has a fixed shape: edit `persistence-and-data-model.md`, write the
migration, run the check. Three steps, one of them mechanical, none of them optional.

The check needs a PostgreSQL instance, so it lives with the database-backed tests rather
than in `scripts/`. Documentation-only CI stays dependency-free and fast.

Comparing whole schemas is `O(schema)` on every run rather than `O(change)`. At 1,685 lines
this is fast; if it stops being fast the comparison can be cached against the baseline, and
the review trigger above names that.

Two things this ADR does not solve, recorded so their absence is deliberate:

- **Zero-downtime migrations.** A migration that rewrites a large table locks it. The MVP
  targets small organizations and accepts a maintenance window; the "Deployment rollback"
  runbook is where that window is described. Expand-and-contract sequencing becomes
  necessary with scale, not with correctness.
- **Concurrent deployment.** Two instances starting at once could both attempt the same
  migration. The ledger's primary key makes the loser fail rather than double-apply, which
  is safe but noisy. An advisory lock is the fix and is deferred until deployment is
  automated enough for it to happen.

## Related documents

- [ADR-0015: Keep the Documented DDL Authoritative and Use Direct SQL](0015-use-documented-ddl-and-direct-sql-for-persistence.md)
- [ADR-0006: Use a PostgreSQL Transactional Outbox](0006-use-postgresql-transactional-outbox.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [Observability and Operations](../architecture/observability-and-operations.md) — backup, PITR, and the deployment-rollback runbook
- [Release Readiness](../engineering/release-readiness.md)
