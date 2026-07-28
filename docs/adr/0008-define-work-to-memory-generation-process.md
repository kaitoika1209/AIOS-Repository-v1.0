# ADR-0008: Define Work-to-Memory Generation as a Durable Process

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1

## Context

Human completion of Work must asynchronously produce at most one reviewable Memory for the configured generation policy. PostgreSQL is authoritative, the AI provider is an external computation service, and generated output has no business authority until validated and committed locally.

The Blueprint already defines the necessary mechanisms, but some diagrams describe `MemoryGenerationRequested` and `MemoryGenerationFailed` as if they were canonical Domain or Integration Events. The registered MVP contract instead uses `Integration / WorkCompleted / 1` as the trigger and a durable `memory_generation_operation` as the process state. Mixing those models creates duplicate scheduling paths, unclear processed-event semantics, and incompatible recovery behavior.

The MVP also stops at Approved Memory. Knowledge, Evidence, and Capability are future Bounded Contexts and must not acquire event handlers, tables, ports, or placeholder packages through the Work-to-Memory implementation.

## Decision

### Canonical trigger

`Integration / WorkCompleted / 1` is the only canonical asynchronous trigger for MVP Memory generation.

The Work completion transaction atomically commits:

- Work in `Completed`;
- the immutable completion record;
- the internal `WorkCompleted` Domain Event;
- the mapped `Integration / WorkCompleted / 1` Outbox record;
- command idempotency; and
- required transactional audit evidence.

There is no MVP Domain or Integration Event named `MemoryGenerationRequested`. The durable Outbox record and consumer registration already represent that request.

### Durable generation process

The `GenerateMemoryHandler` implements one durable process with these stages:

```text
Integration / WorkCompleted / 1
        │
        ▼
Initialization transaction
  - validate envelope and Organization
  - create or prove immutable source snapshot
  - create or reuse stable generation operation
        │ COMMIT
        ▼
Fenced claim transaction
  - Pending or due RetryPending → Generating
  - increment attemptCount and claimVersion
  - set lease using database time
        │ COMMIT
        ▼
AI provider call outside PostgreSQL
        │
        ▼
Validate untrusted candidate
        │
        ▼
Final transaction
  - verify generation and consumer fencing
  - recheck source identity and Memory uniqueness
  - create Memory in Generated
  - append MemoryGenerated
  - set operation = Generated
  - set processed event = Processed
  - persist required audit evidence
        │ COMMIT
```

The consumer event is not marked successfully processed during initialization or before the provider result commits. The stable operation is the durable recovery anchor while the source event remains in progress, retryable, failed, or blocked.

### Generation identity and source binding

One logical operation is identified by:

```text
organizationId + sourceWorkId + generationPolicyVersion
```

The operation also stores or references:

- source `WorkCompleted` event identifier;
- immutable source-snapshot identifier and canonical hash;
- terminal Work version and content-revision identity;
- immutable Decision submitted-snapshot references used as input;
- provider-input hash;
- model and prompt policy versions;
- attempt count, claim version, lease, and retry schedule; and
- bounded result or failure metadata.

Retries reuse the same operation and exact committed source snapshot. They never rebuild input from mutable current projections.

### Process states are not Memory states

The canonical generation-operation states are:

```text
Pending
Generating
RetryPending
Generated
Failed
Abandoned
```

These are operational process states. They do not belong to the Memory Aggregate lifecycle.

The Memory Aggregate begins only when validated content is committed in state `Generated`. A generation operation in `Generated` must identify the matching persisted Memory. A generation operation in `Failed` or `Abandoned` has no partial Memory.

### Failure signaling

Provider timeout, invalid output, lease loss, or retry exhaustion updates the same generation operation through a fenced PostgreSQL transaction.

- transient failure: `Generating → RetryPending`;
- retry exhaustion: `Generating → Failed`;
- explicit authorized discontinuation: eligible state → `Abandoned`;
- expired claim: recover through a new claim version; and
- stale provider response: discard without creating Memory.

There is no canonical MVP Domain or Integration Event named `MemoryGenerationFailed`. Failure is represented authoritatively by generation-operation state and exposed through operational logs, metrics, alerts, and administrative queries. A future cross-context failure event requires a registered consumer need, schema, ownership, and a new architecture decision.

### Memory lifecycle and Human authority

`MemoryGenerated` means that a reviewable AI-assisted draft was committed. It does not mean that organizational history was approved.

The MVP business flow is:

```text
WorkCompleted
        ↓ asynchronous durable process
MemoryGenerated (Memory = Generated)
        ↓ optional Human edit
MemorySubmittedForReview
        ↓ Human review
MemoryApproved | MemoryRejected
```

Only a Human Member may submit, approve, reject, or reopen Memory according to the Memory State Machine. Approved Memory is immutable. Approval does not create or request Knowledge.

### MVP boundary

The MVP terminates at:

```text
MemoryApproved | MemoryRejected
```

Knowledge candidate identification, Evidence creation, Knowledge publication, Capability measurement, semantic search, external Knowledge Sources, and AI Employees are outside the implemented architecture. Names shown in future conceptual diagrams are illustrative hypotheses, not registered MVP contracts or reserved event names.

### Transaction and authority boundaries

- The Work transaction never creates Memory or calls the AI provider.
- No PostgreSQL transaction remains open during the provider call.
- The provider cannot create authoritative Memory, approve Memory, or change Work.
- The initialization, claim, retry, and finalization transactions are short and independently committed.
- The final transaction atomically binds Memory creation, `MemoryGenerated`, operation success, processed-event success, and required audit evidence.
- Generation failure never reopens or rolls back Completed Work.

### Idempotency and concurrency

- technical delivery idempotency uses consumer registration plus source event identifier;
- logical generation idempotency uses the stable operation key;
- PostgreSQL uniqueness on `(organizationId, sourceWorkId)` is the final duplicate-Memory guard;
- claims use `claimVersion`, `lockedBy`, and `lockedUntil` fencing;
- a uniqueness conflict is accepted only after proving that the existing Memory has the same Organization, source Work, source snapshot, and generation identity; and
- conflicting fingerprints are permanent integrity failures, not last-write-wins updates.

### Multi-tenant isolation

Every source snapshot, operation, Memory, event, repository lookup, uniqueness rule, and administrative command is Organization-scoped. A source Work, Decision snapshot, or existing Memory from another Organization is indistinguishable from not found to an unauthorized caller and causes generation to fail without provider invocation.

### Operations and observability

The process must expose at least:

- oldest Pending or RetryPending operation age;
- Generating lease expiry and recovery count;
- attempts, failures, retry exhaustion, and stale-response discards;
- Work-completion-to-Memory-generated latency split into Outbox, queue, provider, validation, and persistence stages;
- operations with no matching source snapshot or with fingerprint conflicts; and
- Completed Work without a Generated Memory beyond the agreed threshold.

Typed Human-authorized retry or abandonment commands must reuse the existing operation, require a reason and idempotency key, and persist durable audit evidence. Routine reconciliation must not create a second operation or rewrite Memory directly.

## Alternatives considered

### Emit `MemoryGenerationRequested` after `WorkCompleted`

Rejected for the MVP because it adds a second scheduling hop, another Outbox/consumer failure boundary, and no independent business fact. The registered `WorkCompleted` delivery already provides durable intent.

### Represent generation failure as a Memory Aggregate state

Rejected because Memory does not exist until a valid generated draft commits. Provider and worker failures belong to the generation operation.

### Call the provider in the Work transaction

Rejected because it would hold database locks across an unreliable external call and couple explicit Human Work completion to AI availability.

### Mark `WorkCompleted` processed after creating the operation

Rejected because successful consumer completion would then be recorded before the required Memory exists. The operation may durably checkpoint progress, but processed-event success is finalized with Memory creation or a proved prior success.

### Implement Knowledge promotion placeholders now

Rejected because the MVP has no approved Knowledge Aggregate, Evidence eligibility model, authorization contract, persistence model, or registered event consumer.

## Consequences

Positive consequences:

- one canonical trigger and one recovery model;
- no duplicate request-event choreography;
- exact reproducibility from immutable source input;
- safe provider retries without duplicate Memory;
- clear separation of operational process state from domain state; and
- an enforceable MVP boundary at Human-reviewed Memory.

Costs and constraints:

- the generation-operation table and fencing logic are mandatory;
- a versioned canonical source snapshot is authoritative retained provenance rather than disposable worker input;
- processed-event records may remain non-terminal while external computation is pending;
- operators need typed retry and abandonment controls; and
- a future need for cross-context generation status events requires explicit contract design.

## Required verification before implementation approval

Tests must cover:

- Work completion commits without waiting for AI;
- duplicate `WorkCompleted` delivery creates one operation and one Memory;
- initialization crash, claim crash, provider timeout, and final-transaction crash;
- lease expiry and stale-provider-response rejection;
- conflicting source or provider-input fingerprint;
- cross-Organization source reference rejection before provider invocation;
- retry exhaustion and authorized retry of the same operation;
- uniqueness conflict with matching and mismatching existing Memory;
- `MemoryGenerated` only after Memory persistence commits;
- processed-event success only with committed or proved prior Memory success;
- generation failure never changes Work; and
- Memory approval never emits or invokes Knowledge behavior.

## Related documents

- [ADR-0004](0004-separate-external-computation-and-business-effects.md)
- [ADR-0006](0006-use-postgresql-transactional-outbox.md)
- [ADR-0012](0012-define-memory-source-snapshot-and-data-governance.md)
- [Architecture Overview](../architecture/overview.md)
- [Memory Aggregate](../architecture/aggregates/memory.md)
- [Memory State Machine](../architecture/state-machines/memory.md)
- [Application Services](../architecture/application-services.md)
- [Events and Outbox](../architecture/events-and-outbox.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [MVP Scope](../product/mvp.md)
