# ADR-0012: Define Memory Source Snapshot and Data-Governance Semantics

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1

## Context

Approved Memory is immutable, but Work, Decision projections, Organization lifecycle, and privacy obligations do not all have the same retention semantics. A Memory that stores only mutable source identifiers cannot prove what the AI generator and Human reviewer saw. Conversely, interpreting immutability as permanent retention would make lawful erasure and Organization deletion impossible.

The platform therefore needs one canonical provenance contract before implementation. This decision defines the content, creation boundary, review binding, tenant isolation, and deletion precedence of the Work-to-Memory source snapshot. It does not introduce Event Sourcing or a general historical-snapshot framework.

## Decision

### Canonical source snapshot

Every logical Memory-generation operation owns exactly one immutable `MemorySourceSnapshot`, committed before any external AI-provider call.

It contains only the bounded facts required by the active generation policy:

- Organization, Work, `WorkCompleted` event, terminal Work Aggregate version, and immutable Work content-revision identifiers;
- normalized Work completion content as it existed at that terminal revision;
- immutable submitted or resolved Decision snapshot identifiers, revision identifiers, outcomes, and content hashes used as input;
- source schema and canonicalization versions;
- canonical snapshot hash, capture time, and data classification; and
- stable references to permitted source artifacts, without copying attachment binaries or secrets.

The canonical hash is calculated over the versioned canonical serialization. It verifies integrity; it is not anonymization, access control, or a substitute for retaining the canonical content.

Mutable Work or Decision projections, mutable Decision drafts, current search results, and live Secretary context are prohibited generation sources. If an exact referenced revision is unavailable, has a different hash, or belongs to another Organization, generation fails before provider invocation.

### Creation and transaction boundary

The initialization transaction atomically creates or proves:

- the source snapshot and its immutable Decision child rows;
- the stable generation operation bound to the snapshot identifier and hash; and
- the delivery checkpoint needed to resume processing.

The transaction then commits. Provider input is derived only from that committed snapshot, and the provider call occurs outside PostgreSQL. Retries for the same operation reuse the same snapshot, canonicalization version, generation-policy version, and provider-input hash.

A different source snapshot is a different logical generation request. It cannot replace the snapshot of an existing Memory or overwrite an existing one-Memory-per-Work result.

### Human review and approval binding

The generated Memory records the source-snapshot identifier and hash. Every submitted Memory snapshot and its review UI bind to the same source snapshot.

Approval records the submitted Memory snapshot, source-snapshot identifier, source-snapshot hash, reviewer, and resolution time. The reviewer must be able to inspect the bounded source facts and provenance used for generation. A later change to a mutable projection cannot change the meaning of the approved record.

Human editing may correct the Memory draft before submission, but it does not alter generation provenance. Rejected and reopened Memory retains the original generation snapshot; a new AI regeneration policy requires a separately designed command and must not silently replace provenance.

### Data minimization and security

The snapshot is Organization-owned Restricted domain data, not telemetry.

- every query, foreign key, uniqueness rule, provider request, export, and administrative action is Organization-scoped;
- provider input uses the minimum necessary fields and follows the Organization's approved AI-processing policy;
- raw secrets, credentials, unrestricted comments, attachment binaries, and unrelated personal data are excluded;
- database encryption, backup controls, regional constraints, authorization, and audited access apply as they do to Memory content;
- logs, traces, metrics, error records, and dead letters contain identifiers and bounded diagnostics, not canonical snapshot content; and
- snapshot hashes remain potentially linkable data and follow the same access, retention, and deletion policy as their source.

### Retention and deletion precedence

Approved Memory immutability means that ordinary domain commands cannot edit or replace approved business history. It does not override a legally authorized data-governance action.

The minimum lifecycle rules are:

| Situation | Required behavior |
|---|---|
| Work or Decision is archived | Preserve the Memory source snapshot and immutable revision references while the related Memory is retained. |
| Memory is Generated, InReview, Rejected, or Approved | Retain its source snapshot for at least the same period as the Memory. |
| Generation fails or is abandoned before Memory exists | Retain the snapshot while retry, replay, incident, audit, or dispute windows remain; then delete it under the approved retention policy. |
| Organization is archived | Stop unauthorized processing but preserve Organization-owned Memory and snapshots under the same retention policy. |
| Organization deletion is authorized | Delete or irreversibly anonymize Organization-owned Memory, snapshots, hashes, derived indexes, cached provider inputs, and pending generation data as one governed process, unless a legal hold requires retention. No data may become ownerless or cross-tenant. |
| Legal hold applies | Suspend conflicting expiry or deletion for the held scope; access remains restricted and audited. |
| Personal-data correction is required and retention remains lawful | Preserve the approved record, append a visible attributable correction or redaction annotation, and prevent stale projections or search indexes from presenting the superseded value as current. |
| Personal-data erasure is legally required | Execute a privileged, audited governance operation that removes or irreversibly redacts the required content and derived copies. Preserve only a non-content tombstone and minimum audit metadata when lawful; do not retain a reversible copy or identifying hash merely to claim immutability. |

An erasure or redaction is not a normal Memory Aggregate transition and must never be disguised as a Human edit. It requires a typed administrative command, explicit scope and reason, authorization separate from ordinary Memory approval, idempotency, durable audit, downstream purge or reindex work, and reconciliation.

Backup copies expire through the approved backup lifecycle rather than in-place mutation. Restore procedures must reapply completed deletion and redaction actions before restored data is made available.

Exact retention durations, legal bases, and jurisdiction-specific workflows remain product and compliance policy. Implementation may not ship destructive Organization or personal-data deletion until that policy and its operational runbook are approved.

### Failure behavior

- Snapshot creation failure rolls back the initialization transaction and prevents provider invocation.
- A hash or version mismatch is a permanent integrity failure requiring Human investigation; automatic rebuilding from current data is prohibited.
- An unavailable or governance-restricted snapshot blocks generation, submission, or review operations that require it and surfaces a typed error.
- Partial purge, index-removal failure, or provider-cache cleanup failure remains a durable reconciliation finding until all registered stores are complete.
- A restored deleted snapshot is quarantined until deletion replay and reconciliation complete.

## Alternatives considered

### Store only Work and Decision identifiers

Rejected because mutable projections cannot prove what was generated or reviewed and may change after Work completion.

### Embed the complete prompt in `WorkCompleted`

Rejected because it enlarges Outbox, dead-letter, and support-tool exposure, couples event retention to Memory retention, and leaks unnecessary content to every consumer.

### Rebuild the snapshot on every retry

Rejected because retries could produce different provider input for one logical operation and destroy idempotency and auditability.

### Treat Approved Memory as undeletable under all circumstances

Rejected because domain immutability is not a lawful basis for indefinite personal-data retention and would make Organization deletion operationally unsafe.

### Implement a universal temporal or Event Sourcing model

Rejected for the MVP because the Work-to-Memory flow needs one bounded provenance snapshot, not a second authoritative history mechanism for every Aggregate.

## Consequences

Positive consequences:

- generation and Human approval remain reproducible without Event Sourcing;
- retries cannot drift to newer Work or Decision content;
- tenant and AI-provider data exposure is bounded;
- ordinary immutability and exceptional lawful erasure no longer contradict each other; and
- Organization deletion has an explicit completeness and restore-reconciliation contract.

Costs and constraints:

- canonical serialization and hash compatibility require versioned tests;
- source snapshots are authoritative retained data, not disposable worker input;
- review UI and exports must resolve provenance without using current mutable projections; and
- privacy deletion requires a governed cross-table process and cannot be implemented as ad hoc SQL.

## Required verification before implementation approval

Tests must cover:

- exact terminal Work and immutable Decision revisions are captured once;
- provider invocation cannot begin before snapshot commit;
- retry reuses byte-equivalent canonical input and hashes;
- mutable projection changes do not alter review or approval provenance;
- cross-Organization references fail before content access or provider invocation;
- secrets and non-allowlisted fields are excluded from snapshots, logs, traces, and dead letters;
- approval binds the reviewed Memory snapshot and source snapshot;
- archive preserves provenance while ordinary deletion commands cannot modify Approved Memory;
- authorized erasure removes or redacts active data, indexes, caches, and derived copies idempotently;
- legal hold blocks conflicting deletion;
- restore reapplies deletion and redaction actions before serving data; and
- a missing or mismatched source revision fails visibly without rebuilding from current data.

## Related documents

- [ADR-0004](0004-separate-external-computation-and-business-effects.md)
- [ADR-0008](0008-define-work-to-memory-generation-process.md)
- [ADR-0009](0009-assign-rule-enforcement-responsibilities.md)
- [Memory Aggregate](../architecture/aggregates/memory.md)
- [Application Services](../architecture/application-services.md)
- [Events and Outbox](../architecture/events-and-outbox.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [Authorization](../architecture/authorization.md)

