# ADR-0014: Establish the MVP Database Migration Baseline

> **Status:** Accepted  
> **Date:** 2026-07-30  
> **Blueprint version:** 0.2.1

## Context

The Blueprint defines relational structures and constraints, but implementation needs one authoritative order for cyclic Aggregate references, Organization-scoped foreign keys, immutable revisions, the Transactional Outbox, and durable Memory generation.

The repository has no production schema or legacy tenant data. The first implementation is therefore a greenfield baseline, not a simulated expand-and-contract migration. Future changes after data exists remain subject to expand-and-contract rules.

## Decision

### Baseline and ownership

The MVP schema is installed by ordered, version-controlled, forward-only SQL migrations grouped by owning implementation module. Application-generated UUIDs are used; the baseline does not depend on a UUID extension.

The authoritative sequence is defined in [MVP Database Migration Plan](../architecture/mvp-database-migration-plan.md). It separates table creation, candidate keys, cross-module foreign keys, lifecycle checks, immutable-revision triggers, indexes, role grants, and verification.

### Execution contract

- Each ordinary migration runs in one transaction under a PostgreSQL advisory deployment lock.
- `CREATE INDEX CONCURRENTLY` runs outside a transaction in an isolated migration.
- Migration history is append-only and records identifier, checksum, timestamps, actor, application version, and failure evidence.
- An applied migration checksum is immutable; correction uses a new forward migration.
- Application instances never race to migrate on startup. A single deployment job migrates before rollout.

### Structural tenant isolation

Every authoritative Organization-owned relationship uses a composite foreign key beginning with `organization_id`. Referenced tables expose matching candidate keys. Globally unique UUIDs do not justify single-column foreign keys for tenant-owned data.

The baseline does not enable Row-Level Security. This explicit MVP tradeoff relies on scoped repositories, authorization, composite foreign keys, least-privilege grants, and isolation tests. Enabling RLS requires a later reviewed migration covering transaction-local tenant context and Worker/admin policies.

### Cyclic Root and revision references

Root and owned-revision tables are created before Root-to-current, submitted, and reviewed foreign keys are added. Those ownership foreign keys are `DEFERRABLE INITIALLY DEFERRED`, allowing one Aggregate transaction while preserving commit-time integrity.

Deferral is limited to documented Root/owned-child cycles and approved local coordination cases. It is not the default for cross-Aggregate references.

### Memory and generation invariants

The baseline enforces:

- unconditional uniqueness of `(organization_id, source_work_id)` on `memories`;
- unconditional uniqueness of `(organization_id, work_id)` on `memory_generation_operations`;
- immutable source-snapshot and generation fingerprints;
- status-dependent Memory, claim, schedule, result, and completion fields;
- Organization/Work/source provenance through composite foreign keys;
- `Generated` operation state only with a matching `memory_id`;
- non-negative attempt and claim versions; and
- database-time lease comparisons in claim and finalization statements.

`generation_policy_version` is immutable provenance, not an identity component. There is no `memories.is_active` column.

### Immutability and authority

Submitted Decision revisions, submitted Memory revisions, Approved Memory content, source snapshots, and Outbox payloads are protected from ordinary updates by grants and narrow rejection triggers. Migration and data-governance roles do not share credentials with runtime roles.

Triggers enforce persisted immutability only; they do not orchestrate business behavior. They use stable error identifiers and a safe function `search_path`.

### Deployment gate

Write traffic is prohibited until CI or a verification migration proves:

- required constraints and indexes exist by exact name;
- cross-Organization substitution fails;
- lifecycle checks reject invalid combinations;
- immutable rows reject ordinary mutation;
- duplicate generation operations and Memories lose safely under concurrency;
- Outbox and processed-event identities are unique; and
- runtime roles cannot alter schema, disable triggers, or truncate authoritative tables.

## Alternatives considered

### Generate the baseline only from ORM metadata

Rejected because ORM metadata alone does not reliably express partial indexes, deferrable composite foreign keys, validation phases, immutable-row triggers, concurrent indexes, or runtime grants. ORM models mirror the schema; reviewed SQL migrations are authoritative.

### Enable RLS in the first migration

Deferred because Workers and administrative recovery need a complete tenant-context contract. Incomplete policies create false assurance or operational bypasses. RLS remains a later defense-in-depth decision.

### Use single-column foreign keys for UUIDs

Rejected because existence is not proof of tenant ownership.

### Add future-domain tables now

Rejected. Knowledge, Evidence, Capability, external-business-effect, broker, and semantic-search persistence are outside the MVP.

## Consequences

Positive consequences:

- one deterministic schema order;
- database enforcement of tenant and concurrency invariants;
- atomic cyclic Aggregate persistence with commit-time checks;
- detectable drift and migration mutation; and
- no unnecessary compatibility scaffolding for the greenfield baseline.

Costs and constraints:

- reviewed SQL is required outside ordinary ORM generation;
- migration and runtime roles must be provisioned separately;
- concurrent indexes require runner support; and
- RLS adoption remains explicit future work.

## Related documents

- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [ADR-0006](0006-use-postgresql-transactional-outbox.md)
- [ADR-0008](0008-define-work-to-memory-generation-process.md)
- [ADR-0009](0009-assign-rule-enforcement-responsibilities.md)
- [ADR-0012](0012-define-memory-source-snapshot-and-data-governance.md)
- [ADR-0013](0013-govern-coordinated-aggregate-transactions.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [MVP Database Migration Plan](../architecture/mvp-database-migration-plan.md)
