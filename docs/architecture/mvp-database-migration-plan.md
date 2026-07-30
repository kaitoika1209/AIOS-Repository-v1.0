# MVP Database Migration Plan

> **Document status:** Normative  
> **Blueprint version:** 0.2.1  
> **Applies to:** Initial PostgreSQL MVP implementation

## Purpose

This document converts the persistence architecture into an executable migration sequence. It governs ordering and verification; Aggregate behavior remains governed by the domain and Application Service documents.

The baseline assumes an empty database. An environment containing authoritative data requires an environment-specific expand-and-contract plan and must not rerun this baseline destructively.

## Migration runner contract

The runner must:

- acquire one environment-scoped PostgreSQL advisory lock;
- reject an applied identifier with a different checksum;
- run ordinary files with bounded `lock_timeout`, `statement_timeout`, `application_name`, and one transaction;
- run explicitly marked concurrent-index files without a transaction;
- stop on first error;
- record durable start, completion, failure category, checksum, actor, deployment, and duration;
- never log SQL parameters containing tenant content; and
- expose schema compatibility to readiness checks.

Recommended filename format is `0001_<module>_<change>.sql`.

## Authoritative baseline order

| Order | Owner | Responsibility | Transactional |
|---:|---|---|---:|
| 0001 | platform | migration history and PostgreSQL capability checks | Yes |
| 0010 | organization | Organizations and scoped candidate keys | Yes |
| 0020 | identity | Human Identity, auth subjects, Membership, roles | Yes |
| 0030 | principals | AI/System Principal identities and Organization binding | Yes |
| 0040 | work | Work Roots, revisions, completion records | Yes |
| 0050 | decision | Decision Roots, revisions, options, review records | Yes |
| 0060 | work-decision | approved coordinated cross-module foreign keys | Yes |
| 0070 | events | Outbox, registrations, processed events, dead letters | Yes |
| 0080 | audit | append-oriented authorization and business audit | Yes |
| 0090 | memory | generation sources and Decision snapshot references | Yes |
| 0100 | memory | generation operations, Memory Roots, revisions, reviews | Yes |
| 0110 | memory | deferred Root/revision and provenance foreign keys | Yes |
| 0120 | platform | immutable-row triggers and runtime grants | Yes |
| 0130 | platform | ordinary indexes | Yes |
| 0140 | platform | only indexes proven to require `CONCURRENTLY` | No |
| 0150 | verification | constraint inventory and negative tests in CI | Yes |

Future-domain persistence is prohibited in this baseline.

## Candidate keys and foreign keys

Every tenant-owned Root exposes `UNIQUE (organization_id, <root_id>)`. Owned revisions additionally expose:

```sql
UNIQUE (organization_id, <root_id>, <revision_id>)
UNIQUE (organization_id, <root_id>, revision_number, <revision_id>)
```

Tenant-owned foreign keys begin with `organization_id`. They use `ON UPDATE RESTRICT`. Authoritative Roots and retained provenance use `ON DELETE RESTRICT`; `CASCADE` is limited to true owned children removed only through governed Root deletion.

## Memory baseline constraints

```sql
ALTER TABLE memories
ADD CONSTRAINT uq_memories_source_work
UNIQUE (organization_id, source_work_id);

ALTER TABLE memories
ADD CONSTRAINT ck_memories_status
CHECK (status IN ('Generated', 'InReview', 'Rejected', 'Approved'));

ALTER TABLE memories
ADD CONSTRAINT ck_memories_lifecycle_fields
CHECK (
    (status = 'Generated'
        AND submitted_revision_id IS NULL
        AND submitted_by_identity_id IS NULL
        AND submitted_by_membership_id IS NULL
        AND submitted_at IS NULL
        AND reviewed_revision_id IS NULL
        AND reviewed_by_identity_id IS NULL
        AND reviewed_by_membership_id IS NULL
        AND rejection_reason IS NULL
        AND reviewed_at IS NULL)
 OR (status = 'InReview'
        AND submitted_revision_id IS NOT NULL
        AND submitted_by_identity_id IS NOT NULL
        AND submitted_by_membership_id IS NOT NULL
        AND submitted_at IS NOT NULL
        AND reviewed_revision_id IS NULL
        AND reviewed_by_identity_id IS NULL
        AND reviewed_by_membership_id IS NULL
        AND rejection_reason IS NULL
        AND reviewed_at IS NULL)
 OR (status = 'Rejected'
        AND submitted_revision_id IS NOT NULL
        AND submitted_by_identity_id IS NOT NULL
        AND submitted_by_membership_id IS NOT NULL
        AND submitted_at IS NOT NULL
        AND reviewed_revision_id = submitted_revision_id
        AND reviewed_by_identity_id IS NOT NULL
        AND reviewed_by_membership_id IS NOT NULL
        AND rejection_reason IS NOT NULL
        AND reviewed_at IS NOT NULL)
 OR (status = 'Approved'
        AND submitted_revision_id IS NOT NULL
        AND submitted_by_identity_id IS NOT NULL
        AND submitted_by_membership_id IS NOT NULL
        AND submitted_at IS NOT NULL
        AND reviewed_revision_id = submitted_revision_id
        AND reviewed_by_identity_id IS NOT NULL
        AND reviewed_by_membership_id IS NOT NULL
        AND rejection_reason IS NULL
        AND reviewed_at IS NOT NULL)
);
```

Composite foreign keys prove submitter and reviewer Membership belongs to the same Organization and Human Identity. Rejection uses the dedicated `rejection_reason` field rather than overloading optional `review_note`. There is no `is_active` column or partial Memory uniqueness index.

## Memory generation operation DDL contract

The physical table includes `memory_id` for proved success and status checks that make invalid leases unrepresentable:

```sql
CREATE TABLE memory_generation_operations (
    generation_operation_id uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    work_id uuid NOT NULL,
    source_event_id uuid NOT NULL,
    source_snapshot_id uuid NOT NULL,
    source_snapshot_hash text NOT NULL,
    provider_input_hash text NOT NULL,
    generation_policy_version integer NOT NULL,
    prompt_template_version integer NOT NULL,
    output_schema_version integer NOT NULL,
    status text NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    claim_version bigint NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NULL,
    locked_by text NULL,
    locked_until timestamptz NULL,
    first_started_at timestamptz NULL,
    last_attempt_at timestamptz NULL,
    completed_at timestamptz NULL,
    memory_id uuid NULL,
    model_reference text NULL,
    last_error_code text NULL,
    error_reference uuid NULL,
    version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,

    CONSTRAINT uq_memory_generation_operation_identity UNIQUE (organization_id, work_id),
    CONSTRAINT uq_memory_generation_operation_scope UNIQUE (organization_id, generation_operation_id),
    CONSTRAINT ck_memory_generation_status
        CHECK (status IN ('Pending', 'Generating', 'RetryPending', 'Generated', 'Failed', 'Abandoned')),
    CONSTRAINT ck_memory_generation_counters
        CHECK (attempt_count >= 0 AND claim_version >= 0 AND version > 0),
    CONSTRAINT ck_memory_generation_versions
        CHECK (generation_policy_version > 0 AND prompt_template_version > 0 AND output_schema_version > 0),
    CONSTRAINT ck_memory_generation_claim
        CHECK ((status = 'Generating' AND locked_by IS NOT NULL AND locked_until IS NOT NULL)
            OR (status <> 'Generating' AND locked_by IS NULL AND locked_until IS NULL)),
    CONSTRAINT ck_memory_generation_schedule
        CHECK ((status = 'RetryPending' AND next_attempt_at IS NOT NULL)
            OR (status <> 'RetryPending' AND next_attempt_at IS NULL)),
    CONSTRAINT ck_memory_generation_result
        CHECK ((status = 'Generated' AND memory_id IS NOT NULL AND completed_at IS NOT NULL)
            OR (status = 'Abandoned' AND memory_id IS NULL AND completed_at IS NOT NULL)
            OR (status NOT IN ('Generated', 'Abandoned') AND memory_id IS NULL AND completed_at IS NULL))
);
```

Composite foreign keys prove that the operation Work, source event, source snapshot, and successful Memory share Organization, Work, snapshot identity, and hash. The Memory table exposes the required provenance candidate key.

Constraints cannot prove transition history. Repository compare-and-set statements and transaction tests remain mandatory.

## Fenced SQL acceptance shape

Claim, renewal, recovery, and finalization use affected-row count as the concurrency decision. Finalization includes:

```sql
WHERE generation_operation_id = :operation_id
  AND organization_id = :organization_id
  AND status = 'Generating'
  AND claim_version = :claim_version
  AND locked_by = :worker_id
  AND locked_until > transaction_timestamp()
  AND source_snapshot_hash = :source_snapshot_hash
  AND provider_input_hash = :provider_input_hash
  AND generation_policy_version = :policy_version
```

Exactly one affected row permits finalization. Zero rows never permits Memory creation outside that same transaction.

## Immutability triggers

Separate functions protect bounded field sets for:

- non-Draft Decision revision content and hashes;
- non-Generated Memory revision content and hashes;
- Approved Memory provenance and review outcome;
- generation-source canonical JSON, identifiers, versions, and hashes; and
- Outbox envelope and payload after insert.

Trigger functions are schema-owner-owned, set a safe `search_path`, and are not directly executable by runtime roles.

## Index contract

Required indexes cover Organization-leading Aggregate status/review queues, Outbox claim order, processed-event pending/retry/blocked/expired claims, generation runnable/expired claims, revision identity, one-editable-revision constraints, and foreign-key support.

The empty-database baseline uses ordinary `CREATE INDEX`. `CONCURRENTLY` is reserved for populated tables or measured lock-budget requirements.

## Role and grant gate

The schema owner owns database objects. The migration role may assume schema ownership only for approved deployment. Runtime roles cannot create or alter schema, disable triggers, truncate authoritative tables, set `session_replication_role`, use future `BYPASSRLS`, or invoke governance repair functions.

Worker grants are limited to registered Outbox, processed-event, projection, and generation-operation ports. Direct mutation of Work, Decision, or Memory lifecycle state outside owning repositories is prohibited.

## Verification gates

CI installs the baseline from empty and verifies a deterministic schema fingerprint. Upgrade tests start from the previous released migration set.

Negative tests reject:

- cross-Organization Work, Decision, Membership, snapshot, and Memory references;
- duplicate Memory and generation operation for one Work under concurrency;
- invalid Memory lifecycle combinations;
- Generated operation without matching Memory;
- lease fields outside `Generating` and stale finalization;
- mutation of immutable revisions, snapshots, Approved Memory, and Outbox payload;
- non-Human identity in Human attribution columns; and
- runtime DDL, trigger disablement, truncate, and broad table access.

Production evidence records duration, locks, verification results, schema fingerprint, backup/PITR status, and rollback classification.

## Rollback classification

- Empty greenfield installation: fully reversible by discarding the unused database.
- Additive baseline correction: forward migration preferred.
- Constraint tightening after traffic: application-rollback compatible only when old code obeys the invariant.
- Destructive or semantic conversion: forward fix required unless tested restore is explicitly approved.

No down migration may delete authoritative tenant data automatically.

## Related documents

- [ADR-0014](../adr/0014-establish-mvp-database-migration-baseline.md)
- [Persistence and Data Model](persistence-and-data-model.md)
- [Application Services](application-services.md)
- [Events and Outbox](events-and-outbox.md)
- [Memory Aggregate](aggregates/memory.md)
- [Memory Generation ADR](../adr/0008-define-work-to-memory-generation-process.md)
