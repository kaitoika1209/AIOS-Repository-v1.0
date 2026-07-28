# ADR-0015: Keep the Documented DDL Authoritative and Use Direct SQL for Persistence

**Status:** Proposed  
**Date:** 2026-07-28  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** before adding a second persistence technology, when repository mapping code becomes a maintenance burden, or when a read model needs a query surface direct SQL serves poorly

## Context

`docs/engineering/tech-stack.md` selects Prisma as the ORM. Implementing the
persistence layer forces a question that selection does not answer: **what owns
the schema?**

The repository already has an answer. `docs/architecture/persistence-and-data-model.md`
and `docs/architecture/events-and-outbox.md` contain the DDL for every table,
`scripts/extract_schema.py` turns those blocks into an executable script, and CI
applies it to a real PostgreSQL instance on every push. Applying it that way has
already caught three defects that reading the documents did not.

Introducing `prisma migrate` would make `prisma/migrations/` a second, writable
source of truth for the same schema. Introducing `prisma db pull` instead keeps
the documents authoritative but commits a generated `schema.prisma` that must be
regenerated whenever the documents change.

The persistence document — which owns this subject under
[Document Governance](../document-governance.md) — is more specific than the
technology selection:

- "An ORM **may** be used." Permission, not a requirement.
- An ORM "must not obscure" Aggregate boundaries, optimistic concurrency,
  explicit SQL constraints, Organization scoping, Outbox atomicity, or lock
  acquisition.
- Avoid "**automatic schema generation in production**".
- **SQL-First Operations**: direct SQL is appropriate for "worker claims,
  bounded cleanup, partial indexes, advisory locks, migration backfills,
  operational queries, performance-sensitive projections".
- "Database rows should map to persistence DTOs before constructing Domain
  objects", and domain objects must not depend on ORM annotations or SQL result
  types.

The last point matters: the mapping layer is required regardless of which client
is used, so an ORM does not remove that work.

The MVP's persistence needs are concentrated in exactly the operations the
document lists as SQL-first. Optimistic concurrency is a conditional
`UPDATE ... WHERE version = $expected`. The Outbox publisher claims rows with
`FOR UPDATE SKIP LOCKED`. Tenant isolation depends on composite foreign keys and
partial unique indexes that an ORM schema language models incompletely.

## Decision

### The documented DDL remains the only schema source

`docs/architecture/persistence-and-data-model.md` and
`docs/architecture/events-and-outbox.md` own the schema. `scripts/extract_schema.py`
produces the executable form. No tool generates, migrates, or infers the schema
from code.

### No ORM in the MVP persistence layer

Repositories are implemented with the PostgreSQL driver (`pg`) and hand-written
SQL. This is a use of the permission the persistence document already grants,
not a departure from it.

`tech-stack.md` is updated to record that Prisma is not used in the MVP, so the
technology list and the architecture agree.

### Repositories map through persistence DTOs

Every repository converts rows to a DTO and then to a domain object through an
explicit hydration function. Hydration trusts validated persisted state, restores
the version and lifecycle state, and emits no domain events.

Domain objects never see a `pg` type, a row object, or a JSONB driver value.
`@aios/domain` keeps its single dependency on `@aios/types`.

### Optimistic concurrency is explicit

Every update is conditional on the version the caller read:

```sql
UPDATE work_items
   SET status = $1, version = $2, updated_at = $3
 WHERE organization_id = $4
   AND work_id = $5
   AND version = $6
```

Zero affected rows is a version conflict, surfaced as `409` per ADR-0014. No
repository performs a read-then-write without this guard.

### Organization scope is in the SQL, not only in the caller

Every statement includes `organization_id` in its `WHERE` clause, even when the
primary key alone would identify the row. A repository method that cannot name
the Organization does not exist.

### Migrations are ordinary SQL files

When the schema changes, the documents change first and a numbered SQL migration
follows. `scripts/extract_schema.py` remains the way a fresh database is built,
and CI keeps proving the documents apply cleanly.

## Alternatives considered

### Prisma with `prisma migrate`

Rejected. It makes `prisma/migrations/` authoritative for the schema, which
directly contradicts the documents and the CI check that keeps them executable.
It is also the "automatic schema generation" the persistence document tells us to
avoid.

### Prisma with `prisma db pull` (introspection only)

Rejected, though it was the initial preference. It keeps the documents
authoritative, but commits a generated `schema.prisma` that silently goes stale
whenever the documents change, and it buys a typed client while the operations
that actually matter — conditional version updates, `SKIP LOCKED` claims, partial
indexes — still require raw SQL. Prisma also does not model CHECK constraints, so
several invariants the schema enforces would be invisible in the generated
schema. That is precisely the "obscures explicit SQL constraints" the document
warns against.

### A query builder such as Kysely

Reasonable, and closer to this decision than Prisma is. Rejected for the MVP only
because it adds a dependency without removing the mapping layer the document
requires. It remains the natural first step if hand-written SQL becomes
repetitive.

### Keep Prisma because tech-stack.md says so

Rejected. `tech-stack.md` is an engineering standard (rank 4); the persistence
document owns this subject (rank 3) and only permits an ORM. Resolving the
conflict by updating the lower-ranked document is what the governance hierarchy
prescribes.

## Consequences

Benefits:

- one schema source, already verified against a real database in CI;
- optimistic concurrency, tenant scoping, and Outbox claims are written
  explicitly rather than inferred from an ORM's behaviour;
- CHECK constraints, composite foreign keys, and partial unique indexes stay
  fully expressed; and
- `@aios/domain` keeps exactly one dependency.

Costs:

- repository code is longer, and row-to-domain mapping is written by hand;
- there is no generated client, so a schema change that is not mirrored in a
  repository is caught by tests rather than by the compiler — which is why the
  repository tests run against the real schema; and
- richer read models later may want a query builder, requiring a follow-up
  decision.

## Follow-up: Decision persistence is blocked

Implementing this ADR surfaced a mismatch that must be resolved before the
Decision repository can be written. It is recorded here rather than worked
around, because a mapping written today would encode the mismatch.

The `decisions` table keeps only root state — status, revision pointers, and
review outcome. Revision *content* lives in `decision_revisions`, which is one of
the tables still documented conceptually and has no DDL. The Decision Aggregate
document likewise models `DecisionRevision`, `DecisionSubmittedSnapshot`, and
`DecisionReviewRecord` as child entities.

The current `DecisionState` in `@aios/domain` flattens all of that onto the root:
`question`, `context`, and `options` are root fields, and `startRevision` bumps
the revision number while leaving them in place. A subsequent edit therefore
overwrites the content of the rejected revision, which contradicts the Decision
state machine: *"A transition from `Rejected` to `Draft` starts a new revision of
the same organizational question. It does not erase or rewrite the rejected
revision."*

The domain model is wrong here, not the schema. Resolving it requires modelling
revisions as child entities and adding DDL for `decision_revisions`, and only
then can Decision persistence be implemented.

Work persistence is unaffected: `work_items` and the Work Aggregate agree, and
the repository is tested against the documented schema.

## Related documents

- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [Events and Outbox](../architecture/events-and-outbox.md)
- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [ADR-0006](0006-use-postgresql-transactional-outbox.md)
- [ADR-0014](0014-adopt-rest-with-explicit-command-sub-resources.md)
- [Technology Stack](../engineering/tech-stack.md)
- [Document Governance](../document-governance.md)
