# ADR-0006: Use a PostgreSQL Transactional Outbox with Durable Local Consumer Handoff

- Status: Accepted
- Date: 2026-07-26
- Blueprint Version: v0.2.1
- Decision Owner: Platform Runtime
- Review Trigger: before introducing an external broker, changing local fan-out persistence, independently deploying a required consumer, or materially changing delivery, retention, replay, or recovery requirements

---

# Context

AIOS commits authoritative Aggregate state to PostgreSQL and performs required downstream work asynchronously.

The architecture must prevent:

- committed domain state with no durable asynchronous message;
- a message describing a transaction that later rolls back; and
- a local Outbox record marked Published before every required consumer delivery is durable.

The last failure is possible in a brokerless Modular Monolith when a dispatcher marks the Outbox Published and then stops during in-memory fan-out. A consumer not yet recorded may never receive the event after restart.

The MVP therefore needs an explicit atomic boundary between the source Outbox record and all enabled local consumer deliveries.

---

# Decision

AIOS uses PostgreSQL Transactional Outbox records as the durable source of required asynchronous publication.

For the MVP local destination, publication completes only when one PostgreSQL transaction:

1. verifies the active Outbox claim;
2. resolves the versioned enabled consumer set;
3. inserts one `processed_events` row in `Pending` status for every target consumer;
4. records the consumer-set version and target count; and
5. changes the Outbox record to `Published`.

If this transaction fails, neither Published nor a partial local fan-out commits.

Consumer effects occur later through independently claimed processed-event rows.

---

# Scope of the Guarantee

A domain change that promises a required downstream reaction cannot commit without its required Outbox record.

This does not mean every database mutation requires an Integration Event. The owning Application Service decides, under the event catalog and use-case contract, which emitted Domain Events require durable local handling, mapping to an Integration Event, an external destination, or no asynchronous publication.

Outbox records are reliable notifications and processing inputs. Aggregate tables remain authoritative current state, and the MVP is not event-sourced.

---

# Event Ownership

Aggregates emit Domain Events and never write Outbox rows, enumerate consumers, publish messages, manage retries, or know delivery outcomes.

The Application Layer collects emitted events, enriches trusted metadata, maps stable Integration Events where required, validates the versioned contract, and appends required Outbox records inside the source transaction.

Cross-Bounded-Context consumers subscribe to Integration Events rather than internal Aggregate object structure.

---

# Source Transaction

For a command with required asynchronous reactions:

~~~text
BEGIN

Validate command idempotency and authorization
Load or create Aggregate
Execute Aggregate command
Persist Aggregate state and version
Append required Outbox records
Persist processed-command result and required audit

COMMIT
~~~

The Outbox insert uses the same PostgreSQL transaction as Aggregate persistence. No Worker, dispatcher, broker, or external provider is invoked before commit.

---

# Publication Destination

Each Outbox record has exactly one `destination`.

The MVP destination is:

~~~text
local-consumer-bus
~~~

A future broker or independently guaranteed integration uses a separate destination record.

Outbox uniqueness is:

~~~text
eventId + destination
~~~

Destination-specific delivery state is Outbox metadata, not part of the immutable Domain Event payload.

---

# Durable Local Handoff

The local publisher acquires a bounded, fenced claim in a short transaction.

It then performs:

~~~text
BEGIN

Lock Outbox record
Verify Claimed status, owner, fencing version, and lease
Resolve compatible enabled ConsumerRegistration entries
Calculate consumerSetVersion and targetCount

Insert processed_events:
    identity = consumerName + eventId
    status = Pending
    firstReceivedAt = databaseNow
    consumerSetVersion = resolved version
    trusted Organization, ordering, and source metadata

Verify materialized target count

Set Outbox = Published
Set publishedAt, consumerSetVersion, and targetCount
Clear publication claim

COMMIT
~~~

Insertion is conflict-safe on `consumerName + eventId`. Retry after uncertain commit reuses the same identities.

A required local contract with no compatible enabled consumer fails visibly. Direct callback invocation, task submission, or an in-memory queue is not durable acknowledgement.

---

# Consumer Registration Snapshot

ConsumerRegistration is version-controlled configuration. Local publication stores a stable `consumerSetVersion` or equivalent hash identifying the exact target set.

- A newly enabled consumer does not automatically receive historical Published events.
- Historical backfill requires a typed rebuild, migration, or replay design.
- Disabling a consumer does not delete an existing non-terminal delivery.
- An incompatible handler or schema fails visibly.
- Already materialized delivery ownership remains stable.
- Startup validation rejects duplicate consumer names and ambiguous contract ownership.

---

# Processed-Event Lifecycle

`processed_events` is the durable per-consumer delivery and execution record.

Canonical statuses are:

~~~text
Pending
Processing
RetryPending
Processed
Failed
Blocked
Skipped
~~~

Normal lifecycle:

~~~text
NoRecord -> Pending -> Processing -> Processed
                         |
                         +-> RetryPending -> Processing
                         +-> Failed

Pending -> Blocked -> Processing
Failed -> Processing through authorized replay
Failed -> Skipped through authorized recovery
~~~

Pending means durable transport acceptance with no real handler attempt. It has no Worker lease and does not increment `attemptCount`.

A Consumer Worker changes an eligible Pending, RetryPending, or unblocked Blocked delivery to Processing only through a short claim transaction that validates registration, Organization scope, ordering, and fencing.

Processed and Skipped remain terminal for ordinary delivery.

---

# Consumer Effect Transaction

A PostgreSQL-local domain-changing consumer atomically commits:

~~~text
Target Aggregate state and version
Follow-up Outbox records
Required audit
Processed event -> Processed
Ordering-state advancement
Stable result reference
~~~

Duplicate delivery of Processed returns the prior result without repeating the effect.

Publication and consumer delivery are at least once. Business outcomes are effectively once only where consumer identity, Aggregate invariants, business idempotency, and the final transaction enforce it. End-to-end exactly once is not claimed.

---

# Meaning of Published

Outbox Published means the configured transport durably accepted the message.

For `local-consumer-bus`, every target Pending row and the Published transition committed together.

Published does not mean a consumer started, succeeded, reached a terminal state, or completed an external effect. Consumer completion remains independently observable through processed-event, dead-letter, ordering, replay, generation-operation, and external-effect records.

---

# Failure and Recovery

- Crash before local handoff commit: no Published or partial fan-out commits; the claim expires and publication retries.
- Crash after handoff commit: Published and every target delivery are durable; Consumer Workers continue.
- Uncertain handoff commit: reload the same Outbox and delivery identities; never create a new event.
- Consumer crash after claim: recover the same delivery using lease expiry and a higher fencing version.
- Permanent publication failure: Outbox becomes Failed and requires typed recovery.
- Permanent consumer failure: processed event becomes Failed with a separate dead-letter record; other consumers remain independent.

---

# Ordering

Publication order is enforced only for registered ordered streams:

~~~text
aggregateType + aggregateId
aggregateVersion + eventSequence
~~~

Consumer ordering is a separate contract. Each ConsumerRegistration declares ordering requirement, key strategy, continuation policy, side-effect class, and skip policy.

No global Organization or platform order is provided.

---

# External Broker Boundary

The MVP does not require an external broker.

When one is introduced:

- Outbox remains the database dual-write solution;
- a broker destination becomes Published only after configured broker acknowledgement;
- remote consumers maintain durable idempotency state;
- local processed-event rows are not proof of broker acceptance;
- Aggregate behavior and Human authority remain unchanged; and
- a new ADR defines producer guarantees, partitioning, retention, redelivery, security, and disaster recovery.

---

# Security and Multi-Tenant Rules

Organization scope, consumer name, consumer-set version, ordering key, source sequence, actor attribution, and capability are derived from trusted envelope and registration data, never caller input.

The Outbox Publisher may insert Pending rows only through the atomic local-handoff operation. It cannot execute handlers, change consumer outcomes, mutate Aggregate tables, fabricate Human authority, or alter event payloads.

Global events require separately registered platform scope and are not inferred from a null Organization identifier alone.

---

# Retention

Published Outbox cleanup requires durable transport acceptance, expiry of redelivery and recovery windows, satisfied audit and privacy policy, and no unresolved reconciliation dependency.

Pending, Claimed, or Failed Outbox rows are never removed by routine cleanup.

Processed-event retention is independent and must preserve required idempotency and recovery windows.

---

# Observability

Operations distinguishes:

- Outbox publication backlog and failure;
- local handoff failure;
- Pending consumer backlog and age;
- Processing lease age;
- RetryPending and Blocked backlog;
- Failed deliveries and dead letters; and
- committed consumer effects.

Required evidence includes destination, consumer-set version, target count, contract identity, failure category, and correlation metadata. High-cardinality tenant, event, Aggregate, ordering, Worker, and fencing identifiers are not metric labels.

---

# MVP Scope

The MVP uses PostgreSQL Outbox, bounded polling and claims, durable local fan-out into processed_events, Consumer Workers, at-least-once delivery, idempotent effects, dead letters, narrow replay, and reconciliation.

It does not require an external broker, distributed transactions, Event Sourcing, global ordering, generic Sagas, broad replay, exactly-once claims, or a second consumer queue table.

Using processed_events as both durable delivery and execution state is the practical tradeoff for a one-to-three-person team.

---

# Alternatives Considered

## Direct in-process invocation

Rejected because a process failure can lose a required consumer invocation and couples unrelated handler failures.

## Mark Published before consumer rows exist

Rejected because a crash can create permanent partial fan-out.

## Mark Published after every consumer completes

Rejected because transport acknowledgement and business completion are different lifecycles; one slow consumer would couple all others.

## Separate per-consumer queue table

Rejected for the MVP because processed_events.Pending provides the required durable handoff and execution identity.

## External broker from the beginning

Rejected because PostgreSQL already supplies the needed local atomicity without another production dependency.

## Exactly-once delivery

Rejected because crashes can occur after an effect and before acknowledgement. Idempotency and reconciliation remain necessary.

---

# Consequences

## Positive

- Required local consumers cannot be lost after publication.
- Fan-out is atomic and each consumer remains independently retryable.
- Publication and business completion have unambiguous meanings.
- The MVP remains brokerless and operationally proportionate.
- Registry changes become auditable.
- Future broker migration preserves the source transaction.

## Negative

- Pending becomes an additional canonical status.
- Local publication writes one row per target consumer.
- Consumer-set versioning must be maintained.
- Large fan-out increases one short transaction.
- New consumers need explicit historical backfill.
- Publisher permissions include a tightly scoped Pending-row insert.

---

# Required Verification

Tests must cover:

- Aggregate and Outbox atomicity;
- rollback when required Outbox persistence fails;
- rollback when one local target insert fails;
- crash before and after local handoff commit;
- uncertain commit and idempotent retry;
- duplicate consumerName plus eventId insertion;
- missing or incompatible consumer registration;
- registry changes during deployment;
- Pending claim and attempt-count semantics;
- duplicate publication and consumer execution;
- publication and consumer ordering;
- Organization mismatch rejection;
- independent retention; and
- restore followed by publication and consumer reconciliation.

---

# Related Documents

- `docs/architecture/events-and-outbox.md`
- `docs/architecture/persistence-and-data-model.md`
- `docs/architecture/application-services.md`
- `observability-and-operations.md`
- `docs/architecture/overview.md`
- `docs/product/mvp.md`
- `docs/adr/0004-separate-external-computation-and-business-effects.md`
- `docs/adr/0005-adopt-boundary-enforced-modular-monolith.md`
