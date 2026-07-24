# Events and Transactional Outbox Architecture

**Status:** Draft  
**Phase:** MVP  
**Architecture:** Modular Monolith  
**Database:** PostgreSQL  
**Delivery Model:** At-Least-Once  
**Consistency Model:** Transactional Local Consistency and Eventual Cross-Aggregate Consistency

---

# Purpose

This document defines how AIOS represents, persists, publishes, consumes, retries, and audits events.

Events connect independently authoritative Aggregates without creating direct Aggregate-to-Aggregate dependencies.

The Transactional Outbox guarantees that committed domain state changes have durable event records.

The event architecture supports:

- Work lifecycle coordination
- Decision outcome propagation
- Memory generation
- Identity and Membership consequences
- notifications
- audit projections
- read-model updates
- operational reconciliation

---

# Goals

The event architecture must ensure that:

- committed Aggregate changes produce durable event records
- uncommitted changes never produce externally visible events
- event delivery may occur more than once without duplicate business effects
- Aggregates remain independent
- cross-Aggregate workflows are eventually consistent
- event contracts are explicit and versioned
- event ordering is defined where required
- failed processing is observable and recoverable
- event causation remains traceable
- Organization boundaries are preserved
- Human authority is not expanded through event processing
- future external messaging can be introduced without changing Aggregate behavior

---

# Non-Goals

This document does not define:

- distributed transactions
- exactly-once broker delivery
- global event ordering
- event sourcing
- Aggregate reconstruction from events
- multi-region event replication
- cross-Organization event sharing
- external marketplace events
- public webhook contracts
- long-running Saga orchestration
- BPM workflow engines
- Knowledge lifecycle events
- AI Employee autonomy events

These capabilities require separate future architecture.

---

# Core Event Model

AIOS distinguishes three event concepts:

```text
Domain Event

Integration Event

Operational Event
```

These concepts may share infrastructure, but they serve different architectural purposes.

---

# Domain Event

A Domain Event represents a business fact that occurred inside an Aggregate.

Examples:

```text
WorkCompleted

DecisionApproved

DecisionRejected

MemoryApproved

MembershipRevoked

OrganizationSuspended
```

A Domain Event is emitted only after an Aggregate accepts a valid command.

---

# Domain Event Meaning

A Domain Event is written in past tense because it describes a committed fact.

Preferred:

```text
DecisionApproved
```

Avoid:

```text
ApproveDecision
```

Commands express intent.

Events express facts.

---

# Domain Event Ownership

Every Domain Event is owned by exactly one Aggregate type.

Examples:

```text
WorkCompleted
    owned by Work Aggregate

DecisionApproved
    owned by Decision Aggregate

MemoryGenerated
    owned by Memory Aggregate

MembershipSuspended
    owned by Membership Aggregate
```

Only the owning Aggregate may originate that event.

---

# Aggregate Event Authority

An Application Service must not fabricate a Domain Event on behalf of an Aggregate.

Incorrect:

```text
Application Service decides Work is complete

↓

Creates WorkCompleted event directly
```

Correct:

```text
Application Service calls Work.CompleteWork(...)

↓

Work Aggregate validates command

↓

Work Aggregate emits WorkCompleted
```

---

# Integration Event

An Integration Event is a stable message contract intended for asynchronous consumers.

It may be derived from a Domain Event.

Example:

```text
Domain Event:
    DecisionApproved

Integration Event:
    DecisionOutcomeOccurred
```

An Integration Event may intentionally expose less internal detail than the source Domain Event.

---

# Integration Event Purpose

Integration Events provide:

- stable asynchronous contracts
- decoupling from internal Aggregate structure
- explicit schema versioning
- safe publication to future external brokers
- compatibility across module boundaries

---

# Domain Event Versus Integration Event

```text
Domain Event
    describes an internal domain fact

Integration Event
    describes a stable message for consumers
```

The two may use the same payload in the MVP only when:

- ownership is explicit
- schema is explicit
- consumers do not depend on internal object structure
- future translation remains possible

---

# Operational Event

An Operational Event represents infrastructure or processing activity.

Examples:

```text
OutboxPublicationFailed

EventProcessingRetried

MemoryGenerationAttemptFailed

SessionInvalidationCompleted

ReconciliationFindingCreated
```

Operational Events do not represent authoritative business decisions.

---

# Operational Event Authority

Operational Events may be emitted by:

- Background Workers
- Outbox publishers
- reconciliation services
- infrastructure adapters
- monitoring components

They must not be confused with Domain Events.

---

# Event Categories

Recommended categories:

```text
Domain

Integration

Operational

Audit
```

An event record should identify its category explicitly where multiple categories share storage or tooling.

---

# Event Lifecycle

A typical event follows this lifecycle:

```text
Aggregate Command
      │
      ▼
Aggregate Emits Domain Event
      │
      ▼
Application Service Collects Event
      │
      ▼
Event Persisted to Outbox
      │
      ▼
Database Transaction Commits
      │
      ▼
Background Worker Publishes Event
      │
      ▼
Consumer Processes Event
      │
      ▼
Consumer Commits Effects
```

---

# Event Creation Boundary

Events are created during Aggregate command execution.

They are not published during Aggregate execution.

The Aggregate may collect pending Domain Events internally.

Example:

```text
work.CompleteWork(actor)

pendingEvents =
    work.ReleaseDomainEvents()
```

The exact API may differ, but the responsibility boundary must remain unchanged.

---

# Event Persistence Boundary

The Application Service persists:

- Aggregate state
- Aggregate version
- Domain Events in the Outbox
- command idempotency record
- required audit metadata

in one PostgreSQL transaction.

---

# Event Publication Boundary

Publication occurs only after the source transaction commits.

The Background Worker is responsible for publication.

The synchronous request does not directly publish to an external broker.

---

# Event Consumption Boundary

Consumers process committed events.

A consumer may:

- execute an Application Service
- invoke an Aggregate command
- update a read model
- send a notification
- record operational metadata

A consumer must not directly mutate Aggregate persistence tables.

---

# Event Authority Principle

An event proves that a fact already occurred.

It does not grant unrestricted authority.

Example:

```text
DecisionApproved
```

may cause:

```text
Work.RecordDecisionOutcome(...)
```

It may not cause:

```text
Work.CompleteWork(...)
```

because Work completion requires new Human intent.

---

# Event Causation Principle

Every event should identify what caused it.

Conceptual chain:

```text
Human Command

↓

Domain Event

↓

System Handler Command

↓

New Domain Event
```

Each step preserves:

- correlationId
- causationId
- source event identity
- Organization scope

---

# Event Contract

Every asynchronously processed event must use an explicit contract.

Recommended envelope:

```text
EventEnvelope
- eventId
- eventType
- eventCategory
- schemaVersion
- aggregateType
- aggregateId
- aggregateVersion
- organizationId
- occurredAt
- recordedAt
- correlationId
- causationId
- actorReference
- payload
```

---

# Event Identifier

Every event has a globally unique:

```text
eventId
```

The eventId is generated once.

Retries and repeated publication preserve the same eventId.

---

# Event Type

The eventType identifies the semantic event.

Examples:

```text
WorkCompleted

DecisionApproved

MembershipRevoked
```

Event type names must remain stable within a schema version.

---

# Event Category

Recommended values:

```text
Domain

Integration

Operational

Audit
```

Consumers may use category to apply different handling policies.

---

# Schema Version

Every event contract includes:

```text
schemaVersion
```

Example:

```text
eventType = WorkCompleted

schemaVersion = 1
```

A consumer must know which schema versions it supports.

---

# Aggregate Type

The aggregateType identifies the source Aggregate category.

Examples:

```text
Work

Decision

Memory

HumanIdentity

Organization

Membership
```

---

# Aggregate Identifier

The aggregateId identifies the source Aggregate instance.

Example:

```text
aggregateType = Decision

aggregateId = decision-123
```

---

# Aggregate Version

The aggregateVersion is the version produced by the committed state transition.

Example:

```text
Decision version 4

↓

DecisionApproved aggregateVersion = 4
```

This supports per-Aggregate ordering and stale-event detection.

---

# Organization Identifier

Every Organization-owned event includes:

```text
organizationId
```

The event Organization must match:

- source Aggregate Organization
- target handler execution context
- related Aggregate Organization

Cross-Organization event processing is prohibited.

---

# Global Identity Events

Some Human Identity events may not originate inside one Organization.

Example:

```text
HumanIdentityDisabled
```

Such events may use:

```text
organizationId = null
```

only when the contract explicitly defines global scope.

Consumers must then derive affected Organizations through authorized internal queries.

---

# Occurred At

```text
occurredAt
```

records when the domain fact occurred according to the domain or application clock.

It is set once and remains unchanged through retries.

---

# Recorded At

```text
recordedAt
```

records when the event was persisted in the Outbox.

Usually:

```text
recordedAt >= occurredAt
```

---

# Correlation Identifier

```text
correlationId
```

groups all commands and events belonging to one business flow.

Example:

```text
ApproveDecision command

DecisionApproved event

RecordDecisionOutcome command

WorkDecisionOutcomeRecorded event
```

All share the same correlationId.

---

# Causation Identifier

```text
causationId
```

identifies the command or event that directly caused the current event.

Example:

```text
DecisionApproved.causationId
    = ApproveDecision.commandId
```

---

# Root Correlation

When a command begins a new business flow:

```text
correlationId = commandId
```

When an event triggers follow-up processing:

```text
correlationId = incomingEvent.correlationId

causationId = incomingEvent.eventId
```

---

# Actor Reference

Domain Events should include the ActorReference responsible for the source transition where business attribution matters.

Possible actor types:

```text
HumanMember

Secretary

System
```

---

# Human Actor Event

Example:

```text
DecisionApproved
- actorReference.actorType = HumanMember
- actorReference.actorId = identityId
- actorReference.membershipId = membershipId
```

---

# System Actor Event

Example:

```text
MemoryGenerated
- actorReference.actorType = System
- actorReference.actorId = memory-generation-worker
```

The source WorkCompleted event preserves the Human who completed Work.

---

# Secretary Actor Event

Secretary events are advisory.

Example:

```text
SecretaryContributionCreated
- actorReference.actorType = Secretary
```

A Secretary event must not represent:

- Work completion
- Decision approval
- Decision rejection
- Memory approval
- Knowledge promotion

---

# Event Payload

The payload contains event-specific data.

Example:

```text
WorkCompleted payload
- workId
- completionSummary
- completedAt
- completionGate
```

The payload must contain enough immutable information for intended consumers.

---

# Event Payload Design

Payloads should:

- use stable identifiers
- include immutable source facts
- avoid direct entity object serialization
- avoid database row representations
- avoid internal ORM metadata
- minimize sensitive data
- remain bounded in size
- use explicit field names

---

# Event Payload Prohibitions

Events must not contain:

- passwords
- access tokens
- invitation secrets
- private signing keys
- raw session credentials
- complete authentication claims
- unnecessary personal data
- arbitrary internal exception objects
- unbounded document content

---

# Large Content References

Large content should be referenced rather than embedded.

Example:

```text
MemoryGenerated
- memoryId
- contentRevisionId
- sourceWorkId
```

Avoid embedding full Memory content when consumers can load it through authorized services.

---

# Event Immutability

After an event is committed:

- eventId never changes
- eventType never changes
- schemaVersion never changes
- payload never changes
- occurredAt never changes
- correlationId never changes
- causationId never changes

Corrections require a new event.

---

# Event Correction

An incorrect committed event must not be edited.

A correction may use:

```text
Corrective Domain Event

Superseding Event

Administrative Repair Event
```

The correction must preserve reference to the original eventId.

---

# Event Naming

Event names should:

- use past tense
- describe one committed fact
- avoid implementation terms
- avoid transport terms
- remain domain-specific

Preferred:

```text
MembershipRevoked
```

Avoid:

```text
MembershipRowUpdated
```

---

# Event Granularity

An event should represent one meaningful fact.

Avoid overly broad events:

```text
WorkChanged
```

Prefer:

```text
WorkStarted

WorkCompleted

WorkCancelled
```

Specific events improve consumer clarity and policy enforcement.

---

# Event Completeness

An event should contain enough information to identify:

- what happened
- which Aggregate changed
- which Organization owns the event
- when it occurred
- who caused it
- which flow it belongs to
- which schema applies

---

# Source of Truth

The Aggregate state is the current source of truth for domain state.

The event is the durable fact notification.

AIOS MVP is not event-sourced.

Aggregates are not reconstructed by replaying all historical events.

---

# Event History

Events provide:

- integration history
- audit correlation
- asynchronous processing input
- operational recovery support

They do not replace dedicated domain history where an Aggregate requires richer internal revision records.

---

# Domain Event Catalog

The MVP event catalog includes events from the following domains:

```text
Work

Decision

Memory

Human Identity

Organization

Membership
```

---

# Work Events

Representative Work events:

```text
WorkCreated

WorkStarted

WorkUpdated

WorkDecisionRequested

WorkDecisionOutcomeRecorded

WorkCompleted

WorkCancelled
```

---

# Decision Events

Representative Decision events:

```text
DecisionCreated

DecisionDraftEdited

SecretaryContributionRecorded

DecisionSubmitted

DecisionApproved

DecisionRejected

DecisionWithdrawn

DecisionRevisionStarted
```

---

# Memory Events

Representative Memory events:

```text
MemoryGenerated

MemoryEdited

SecretaryContributionRecorded

MemorySubmittedForReview

MemoryApproved

MemoryRejected

MemoryReopened
```

When identical event names could occur in multiple domains, the event catalog should use module-qualified names or unambiguous contracts.

Example:

```text
DecisionSecretaryContributionRecorded

MemorySecretaryContributionRecorded
```

---

# Human Identity Events

Representative events:

```text
HumanIdentityCreated

HumanIdentityProfileUpdated

AuthenticationSubjectLinked

AuthenticationSubjectUnlinked

HumanIdentityDisabled

HumanIdentityReactivated
```

---

# Organization Events

Representative events:

```text
OrganizationCreated

OrganizationRenamed

OrganizationSuspended

OrganizationReactivated

OrganizationArchived
```

---

# Membership Events

Representative events:

```text
MembershipInvited

MembershipActivated

MembershipSuspended

MembershipReactivated

MembershipRevoked

OrganizationRoleAssigned

OrganizationRoleRevoked

OrganizationOwnershipTransferred
```

---

# Event Catalog Ownership

Each module owns:

- event names
- payload definitions
- schema versions
- source Aggregate mapping
- allowed consumers
- privacy classification
- deprecation policy

A shared event catalog may document all contracts.

---

# Event Consumer Registry

Every asynchronously consumed event must have an explicit consumer registration.

Conceptual registry:

```text
DecisionApproved
    -> RecordDecisionOutcomeInWorkHandler

DecisionRejected
    -> RecordDecisionOutcomeInWorkHandler

DecisionWithdrawn
    -> RecordDecisionOutcomeInWorkHandler

WorkCompleted
    -> GenerateMemoryHandler

MembershipRevoked
    -> AssignmentReconciliationHandler

HumanIdentityDisabled
    -> SessionInvalidationHandler
```

---

# Unhandled Events

A committed event may legitimately have no asynchronous consumer.

Examples:

- event exists only for audit
- event supports future projections
- event is currently informational

However, consumer absence must be intentional and documented.

---

# Unknown Event Types

When a Worker receives an unknown eventType:

```text
Do not discard silently

Do not mutate domain state

Record processing failure

Move to operational failure handling
```

Unknown event types may indicate:

- deployment mismatch
- configuration error
- unsupported producer version
- corrupted data

---

# Unsupported Schema Versions

When eventType is known but schemaVersion is unsupported:

```text
Consumer fails permanently

Event remains recoverable

Operational alert is raised
```

The consumer must not guess field interpretation.

---

# Event Ordering Model

AIOS requires ordering only within one Aggregate stream.

Conceptual stream key:

```text
aggregateType + aggregateId
```

Events in one Aggregate stream use aggregateVersion for order.

---

# Per-Aggregate Ordering Example

```text
Decision version 2
    DecisionDraftEdited

Decision version 3
    DecisionSubmitted

Decision version 4
    DecisionApproved
```

A consumer should not treat version 4 as preceding version 3.

---

# No Global Ordering

AIOS does not require a total order across:

- different Work Aggregates
- Work and Decision
- different Organizations
- different modules

No business invariant may depend on global publication order.

---

# Eventual Consistency

Cross-Aggregate effects are eventually consistent.

Valid temporary states include:

```text
Decision = Approved

Work Completion Gate = Pending
```

and:

```text
Work = Completed

Memory = Not Yet Generated
```

These states must be:

- observable
- retryable
- reconcilable
- safe for Human users

---

# Event Security Boundary

Events are trusted only after validation.

Consumers must verify:

- event source
- event type
- schema version
- Organization scope
- required identifiers
- payload structure
- allowed causation
- consumer capability

An event is not trusted merely because it exists in a queue.

---

# Organization Event Isolation

A consumer processing:

```text
organizationId = org-alpha
```

must not:

- load org-beta resources
- combine data from org-beta
- write to org-beta Aggregates
- publish a follow-up event under org-beta

Organization mismatch is a permanent security failure.

---

# Event Actor Authority

Consumers must distinguish:

```text
Actor who caused the source fact

System principal executing the handler
```

Example:

```text
DecisionApproved
    actor = Human reviewer

RecordDecisionOutcome handler
    principal = System
```

The System records the approved outcome.

It does not become the Decision approver.

---

# Core Event Invariants

The following invariants must always hold:

1. Every Domain Event originates from exactly one Aggregate.
2. Every committed Domain Event has a unique eventId.
3. Aggregate state and Outbox event persist atomically.
4. Uncommitted Aggregate changes produce no published events.
5. Event payloads are immutable after commit.
6. Every asynchronous event has an explicit schemaVersion.
7. Organization-owned events contain the correct organizationId.
8. Consumers preserve correlationId and causationId.
9. Event delivery is assumed to occur at least once.
10. Consumers must be idempotent.
11. Ordering is required only per Aggregate stream.
12. No event grants unrestricted Human authority.
13. Secretary events remain advisory.
14. System handlers remain operational.
15. Cross-Aggregate consistency is eventual.
16. Unknown event contracts fail visibly.
17. Failed events remain recoverable.
18. Events do not replace Aggregate state as the MVP source of truth.

---

# Guiding Principles

Commands answer:

> What does an actor want to happen?

Aggregates answer:

> Is that change valid?

Domain Events answer:

> What business fact occurred?

Integration Events answer:

> What stable fact should asynchronous consumers receive?

The Transactional Outbox answers:

> How is that committed fact delivered reliably?

# Transactional Outbox

The Transactional Outbox guarantees reliable publication of committed events.

It solves the dual-write problem between:

- PostgreSQL Aggregate persistence
- asynchronous event delivery

Aggregate state and event records are committed in one local database transaction.

---

# Dual-Write Problem

Without a Transactional Outbox, an Application Service might:

```text
Save Aggregate

↓

Commit Database Transaction

↓

Publish Event
```

If event publication fails after the database commit:

```text
Domain state = committed

Event = lost
```

Downstream consumers would never learn about the committed fact.

---

# Opposite Failure

Publishing before commit is also unsafe.

```text
Publish Event

↓

Database Commit Fails
```

Result:

```text
Consumer observes event

Source Aggregate change does not exist
```

This creates a false business fact.

---

# Outbox Solution

The correct pattern is:

```text
BEGIN

Load Aggregate

Execute Command

Save Aggregate

Persist Events to Outbox

Persist Command Idempotency Record

COMMIT
```

After commit:

```text
Background Worker

↓

Reads Outbox

↓

Publishes Event

↓

Records Publication Result
```

---

# Atomicity Guarantee

The following writes must be atomic:

```text
Aggregate state

Aggregate version

Outbox event records

Processed command record

Required transactional audit metadata
```

If any required write fails:

```text
Entire transaction rolls back
```

---

# Outbox Ownership

The Outbox belongs to the Application and Infrastructure architecture.

Aggregates do not:

- insert Outbox rows
- publish messages
- know publication status
- retry publication
- access brokers
- update delivery metadata

Aggregates only emit Domain Events.

---

# Outbox Writer

The Application Layer uses an Outbox Writer inside the current transaction.

Conceptual interface:

```text
OutboxWriter

Append(
    eventEnvelope
)
```

or:

```text
AppendAll(
    eventEnvelopes
)
```

The writer must use the same PostgreSQL transaction as Aggregate persistence.

---

# Event Envelope Creation

The Application Layer or a dedicated event mapper creates the persisted envelope.

Conceptual sequence:

```text
Aggregate emits Domain Event

↓

Application Layer enriches metadata

↓

Domain Event mapped to EventEnvelope

↓

EventEnvelope persisted to Outbox
```

---

# Metadata Enrichment

The persisted envelope may add metadata not owned by the Aggregate.

Examples:

```text
eventId

recordedAt

correlationId

causationId

schemaVersion

eventCategory

publication destination
```

Business facts inside the payload must still originate from the Aggregate.

---

# Outbox Record

Recommended Outbox record:

```text
OutboxMessage
- outboxId
- eventId
- eventType
- eventCategory
- schemaVersion
- aggregateType
- aggregateId
- aggregateVersion
- organizationId
- payload
- headers
- occurredAt
- recordedAt
- correlationId
- causationId
- actorReference
- status
- attemptCount
- nextAttemptAt
- firstAttemptAt
- lastAttemptAt
- publishedAt
- lockedBy
- lockedUntil
- lastErrorCode
- lastErrorMessage
```

The exact schema may be simplified while preserving required behavior.

---

# Outbox Identifier

```text
outboxId
```

identifies the persistence record.

It is distinct from:

```text
eventId
```

The same eventId must not produce multiple authoritative Outbox messages for the same publication contract unless explicit fan-out records are used.

---

# Event Identifier Uniqueness

Recommended constraint:

```text
UNIQUE (event_id)
```

When one logical event is published independently to multiple destinations, use either:

```text
event_id + destination
```

or a separate delivery table.

---

# Payload Storage

Recommended PostgreSQL payload type:

```text
jsonb
```

Benefits include:

- explicit structured storage
- queryability for operations
- schema-version metadata
- portability to message infrastructure

Payload validation must occur before persistence.

---

# Headers Storage

Headers may be stored as:

```text
jsonb
```

Possible headers include:

```text
contentType

traceParent

producerModule

destination

privacyClassification
```

Headers must not duplicate essential authoritative envelope fields unnecessarily.

---

# Outbox Status Model

Recommended statuses:

```text
Pending

Claimed

Published

Failed
```

An implementation may represent Claimed through lock fields instead of a durable status.

---

# Pending Status

```text
Pending
```

means:

- source transaction committed
- event is eligible for publication
- publication has not succeeded
- nextAttemptAt has arrived

---

# Claimed Status

```text
Claimed
```

means one Worker currently owns the publication attempt.

The claim must expire automatically if the Worker crashes.

A permanent lock is prohibited.

---

# Published Status

```text
Published
```

means the configured publication operation succeeded.

The record stores:

```text
publishedAt
```

Published does not imply every downstream consumer has completed processing.

---

# Failed Status

```text
Failed
```

means automated publication has stopped because:

- retry limit was exceeded
- error was classified as permanent
- contract is invalid
- operator intervention is required

Failed records remain durable and recoverable.

---

# Recommended PostgreSQL Table

Conceptual DDL:

```sql
CREATE TABLE outbox_messages (
    outbox_id              uuid PRIMARY KEY,
    event_id               uuid NOT NULL,
    event_type             text NOT NULL,
    event_category         text NOT NULL,
    schema_version         integer NOT NULL,
    aggregate_type         text NOT NULL,
    aggregate_id           text NOT NULL,
    aggregate_version      bigint NOT NULL,
    organization_id        uuid NULL,
    payload                jsonb NOT NULL,
    headers                jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at            timestamptz NOT NULL,
    recorded_at            timestamptz NOT NULL,
    correlation_id         uuid NOT NULL,
    causation_id           uuid NULL,
    actor_reference        jsonb NULL,
    status                 text NOT NULL,
    attempt_count          integer NOT NULL DEFAULT 0,
    next_attempt_at        timestamptz NOT NULL,
    first_attempt_at       timestamptz NULL,
    last_attempt_at        timestamptz NULL,
    published_at           timestamptz NULL,
    locked_by              text NULL,
    locked_until           timestamptz NULL,
    last_error_code        text NULL,
    last_error_message     text NULL
);
```

---

# Recommended Constraints

```sql
ALTER TABLE outbox_messages
ADD CONSTRAINT uq_outbox_event_id
UNIQUE (event_id);
```

```sql
ALTER TABLE outbox_messages
ADD CONSTRAINT ck_outbox_status
CHECK (
    status IN (
        'Pending',
        'Claimed',
        'Published',
        'Failed'
    )
);
```

```sql
ALTER TABLE outbox_messages
ADD CONSTRAINT ck_outbox_schema_version
CHECK (
    schema_version > 0
);
```

```sql
ALTER TABLE outbox_messages
ADD CONSTRAINT ck_outbox_attempt_count
CHECK (
    attempt_count >= 0
);
```

---

# Recommended Indexes

```sql
CREATE INDEX ix_outbox_pending
ON outbox_messages (
    next_attempt_at,
    recorded_at
)
WHERE status = 'Pending';
```

```sql
CREATE INDEX ix_outbox_claim_expiry
ON outbox_messages (
    locked_until
)
WHERE status = 'Claimed';
```

```sql
CREATE INDEX ix_outbox_aggregate_stream
ON outbox_messages (
    aggregate_type,
    aggregate_id,
    aggregate_version
);
```

```sql
CREATE INDEX ix_outbox_correlation
ON outbox_messages (
    correlation_id
);
```

```sql
CREATE INDEX ix_outbox_organization
ON outbox_messages (
    organization_id,
    recorded_at
);
```

---

# Outbox Insert Flow

For each Domain Event:

```text
Generate eventId

↓

Resolve event contract

↓

Assign schemaVersion

↓

Add correlation and causation

↓

Serialize payload

↓

Validate payload

↓

Insert Outbox row
```

All rows are inserted before transaction commit.

---

# Multiple Events in One Command

An Aggregate command may emit multiple events.

Example:

```text
Membership accepted

↓

MembershipActivated

OrganizationRoleAssigned
```

The Application Service persists every emitted event in deterministic Aggregate order.

---

# Event Position Within Transaction

When one command emits multiple events for the same Aggregate version, the design should include a sequence.

Recommended additional field:

```text
eventSequence
```

or:

```text
eventIndex
```

Stream order then becomes:

```text
aggregateVersion

eventSequence
```

---

# Recommended Event Sequence

Conceptual record:

```text
aggregateVersion = 5

eventSequence = 1
```

The sequence is scoped to one Aggregate version.

Recommended uniqueness:

```text
UNIQUE (
    aggregate_type,
    aggregate_id,
    aggregate_version,
    event_sequence
)
```

---

# Aggregate Version Semantics

The aggregateVersion in the event must match the committed Aggregate version resulting from the command.

Example:

```text
Loaded Work version = 8

CompleteWork succeeds

Saved Work version = 9

WorkCompleted.aggregateVersion = 9
```

---

# Publication Architecture

The MVP may publish events using:

```text
PostgreSQL Outbox

↓

Local Background Worker

↓

In-Process Event Dispatcher
```

An external broker is optional.

---

# Local Publication

In a Modular Monolith, publication may mean:

```text
Load Outbox Message

↓

Deserialize Integration Event

↓

Dispatch to registered local consumers
```

The event remains asynchronous even when no external broker exists.

---

# External Broker Publication

A future deployment may publish to:

- Kafka
- RabbitMQ
- Amazon SQS
- Google Pub/Sub
- Azure Service Bus

Broker introduction must not change Aggregate behavior.

---

# Publication Destination

The Outbox record may include:

```text
destination
```

Examples:

```text
local-domain-bus

integration-bus

audit-stream

notification-queue
```

The MVP may use one local destination.

---

# Publication Worker

The Publication Worker is responsible for:

- polling eligible records
- claiming records safely
- publishing messages
- recording success
- classifying failure
- scheduling retry
- releasing expired claims
- exposing operational metrics

---

# Worker Polling

Conceptual loop:

```text
Wait for poll interval

↓

Claim eligible batch

↓

Publish each event

↓

Record result

↓

Repeat
```

Polling frequency is configurable.

---

# Safe Claim Query

Recommended PostgreSQL pattern:

```sql
SELECT outbox_id
FROM outbox_messages
WHERE status = 'Pending'
  AND next_attempt_at <= now()
ORDER BY recorded_at, outbox_id
FOR UPDATE SKIP LOCKED
LIMIT :batch_size;
```

The Worker then updates claimed rows within the same short transaction.

---

# Claim Transaction

```text
BEGIN

Select Pending rows
FOR UPDATE SKIP LOCKED

Set:
    status = Claimed
    lockedBy = workerId
    lockedUntil = now + leaseDuration
    attemptCount = attemptCount + 1
    firstAttemptAt if null
    lastAttemptAt = now

COMMIT
```

Publication occurs after the claim transaction.

---

# Why Publication Occurs Outside Claim Transaction

Network or handler execution may be slow.

Holding row locks during publication would:

- increase database contention
- create long transactions
- reduce Worker throughput
- complicate crash recovery

The lease preserves ownership without holding an open transaction.

---

# Claim Lease

Every claim must have:

```text
lockedUntil
```

If the Worker crashes, another Worker may reclaim the event after lease expiry.

---

# Claim Ownership

A Worker may update publication outcome only when:

```text
lockedBy = currentWorkerId
```

and the lease is still valid, or the implementation uses equivalent fencing protection.

---

# Fencing Token

For stronger protection, a claim may include:

```text
claimVersion
```

Each reclaim increments the version.

A stale Worker cannot overwrite a newer Worker’s result.

---

# Publication Success

After successful publication:

```text
BEGIN

Verify claim ownership

Set status = Published

Set publishedAt = now

Clear lock fields

Clear transient error fields

COMMIT
```

---

# Publication Failure

After failed publication:

```text
Classify error
```

If transient:

```text
status = Pending

nextAttemptAt = calculated retry time

clear claim
```

If permanent or retry-exhausted:

```text
status = Failed

clear claim

preserve error metadata
```

---

# Publication Acknowledgement

When an external broker is used, the Outbox record is marked Published only after the broker confirms acceptance according to the configured producer guarantee.

A local function call returning before durable consumer acceptance must not be described as broker publication success.

---

# At-Least-Once Publication

A Worker may publish successfully and crash before marking the Outbox row Published.

Result:

```text
Same event may be published again
```

Therefore:

```text
Consumers must be idempotent
```

---

# Exactly-Once Prohibition

The MVP must not claim exactly-once end-to-end delivery.

The reliable guarantee is:

```text
At-least-once delivery

+

Idempotent consumer effects
```

This provides effectively-once business outcomes where implemented correctly.

---

# Publication Ordering

The Outbox Worker should preserve order within one Aggregate stream where consumers require it.

Ordering key:

```text
aggregateType + aggregateId
```

---

# Ordering Challenge

Multiple Worker instances may claim consecutive events from the same Aggregate.

Example:

```text
Worker A claims Decision version 4

Worker B claims Decision version 5
```

Worker B could publish first.

The design must address this when strict stream order is required.

---

# MVP Ordering Strategy

Recommended MVP strategy:

- order Outbox polling by recordedAt
- prevent concurrent publication for the same Aggregate stream
- use aggregateVersion for validation
- allow parallel publication across different Aggregate streams

---

# Stream Locking

Possible implementation:

```text
Acquire logical lock on:
    aggregateType + aggregateId
```

Then publish eligible events for that stream in version order.

PostgreSQL advisory locks are one possible implementation.

---

# Stream Head Query

A message is publishable only when no earlier unpublished event exists for the same Aggregate.

Conceptual condition:

```sql
NOT EXISTS (
    SELECT 1
    FROM outbox_messages earlier
    WHERE earlier.aggregate_type = current.aggregate_type
      AND earlier.aggregate_id = current.aggregate_id
      AND (
          earlier.aggregate_version < current.aggregate_version
          OR (
              earlier.aggregate_version = current.aggregate_version
              AND earlier.event_sequence < current.event_sequence
          )
      )
      AND earlier.status <> 'Published'
);
```

---

# Stream Blocking

If an earlier event in the same Aggregate stream is Failed:

```text
Later events remain blocked
```

until the failure is resolved or an explicit skip policy is applied.

Silent reordering is prohibited.

---

# Skip Policy

Skipping a failed event is an exceptional operator action.

It requires:

- reason
- operator identity
- impact analysis
- audit record
- explicit confirmation that later events remain meaningful
- reconciliation after skip

The MVP should prefer repair and replay over skip.

---

# Cross-Stream Parallelism

Events from different Aggregate streams may publish concurrently.

Example:

```text
Work A version 4

Work B version 9
```

No ordering is required between them.

---

# Organization Ordering

The MVP does not require one global sequence per Organization.

Organization-wide ordering would create unnecessary contention.

Only explicit workflows that require Organization-scoped locking should use it.

---

# Event Mapping

A Domain Event may be persisted directly or translated to an Integration Event.

Recommended mapping interface:

```text
EventContractMapper

Map(
    DomainEvent,
    EventMetadata
) -> EventEnvelope[]
```

One Domain Event may map to:

- one Integration Event
- multiple destination-specific events
- no Integration Event when only local audit is required

---

# Fan-Out

When one event has multiple independent destinations, two patterns are possible.

---

## Pattern A: One Outbox Event, Multiple Consumers

```text
One published event

↓

Multiple registered consumers
```

Each consumer tracks its own processing state.

This is preferred inside the MVP Modular Monolith.

---

## Pattern B: One Delivery Record per Destination

```text
One logical event

↓

Multiple destination delivery records
```

This is useful when destinations have independent publication guarantees.

---

# Publication Record Versus Consumer Record

Outbox publication answers:

> Has the event been delivered to the event transport?

Consumer processing answers:

> Has this consumer applied the event?

These are different records.

---

# Event Versioning

Every event contract has an explicit schema version.

Versioning applies to:

- envelope
- payload
- semantic meaning

---

# Versioning Goals

Versioning must allow:

- producers and consumers to deploy independently where needed
- old events to remain processable
- replay after software upgrades
- safe contract evolution
- explicit rejection of incompatible payloads

---

# Schema Version Ownership

The module owning the event defines:

- current schema version
- supported prior versions
- compatibility policy
- migration or upcasting rules
- deprecation timeline

---

# Compatible Changes

Usually compatible changes include:

- adding optional fields
- adding nullable metadata
- adding fields with safe defaults
- expanding descriptive content without semantic change

Consumers must tolerate unknown optional fields.

---

# Potentially Breaking Changes

Breaking changes include:

- removing fields
- renaming fields
- changing field types
- changing identifier meaning
- changing timestamp semantics
- changing enum meaning
- changing event meaning
- changing Organization scope
- changing authority interpretation

Breaking changes require a new schema version.

---

# Enum Evolution

Adding a new enum value may be breaking when consumers use exhaustive matching.

Consumers should:

- handle supported values explicitly
- reject unknown authority-sensitive values
- avoid silently mapping unknown values to a valid existing value

---

# New Schema Version

Example:

```text
DecisionApproved v1

DecisionApproved v2
```

Both may coexist during migration.

The eventType may remain stable while schemaVersion changes.

---

# Event Type Replacement

When semantic meaning changes significantly, use a new eventType instead of only increasing schemaVersion.

Example:

```text
DecisionApproved

is not equivalent to

DecisionApprovalConsensusReached
```

---

# Upcasting

An Upcaster converts an older event representation into the current internal consumer model.

Conceptual flow:

```text
Stored Event v1

↓

Upcaster

↓

Current Internal Event Model
```

The original stored event remains unchanged.

---

# Upcaster Rules

Upcasters must:

- be deterministic
- preserve original eventId
- preserve occurredAt
- preserve correlation and causation
- preserve Organization scope
- not invent business facts
- be covered by compatibility tests

---

# Downcasting

Downcasting a new event into an older semantic contract is discouraged.

When required for an external destination, use an explicit destination adapter.

---

# Envelope Version

The envelope itself may also have a version.

Example:

```text
envelopeVersion = 1
```

Payload schemaVersion and envelopeVersion solve different concerns.

---

# Contract Registry

A contract registry should define:

```text
eventType
schemaVersion
eventCategory
sourceAggregate
payloadSchema
privacyClassification
supportedConsumers
deprecatedAt
```

The registry may initially be implemented in version-controlled code.

---

# Serialization Format

Recommended MVP format:

```text
UTF-8 JSON
```

Serialization must be deterministic enough for:

- payload hashing
- contract testing
- debugging
- replay

Strict byte-for-byte canonical JSON is optional unless signatures require it.

---

# Content Type

Recommended content type:

```text
application/json
```

When external brokers are introduced, include content type and schema metadata in message headers.

---

# Timestamp Format

Serialized timestamps should use:

```text
ISO 8601 / RFC 3339

UTC
```

Example:

```text
2026-07-24T09:30:00Z
```

---

# Identifier Serialization

Identifiers should serialize consistently as strings.

Consumers must not infer identifier type from formatting alone.

---

# Null Handling

Optional fields should have explicit nullability.

Missing and null must not silently represent different business meanings unless the contract documents that distinction.

---

# Event Payload Validation

Before Outbox insertion, validate:

- eventType is registered
- schemaVersion is supported
- required fields exist
- identifiers are structurally valid
- Organization scope is correct
- payload size is within limit
- prohibited sensitive fields are absent
- actor type is permitted for the event

---

# Authority-Sensitive Validation

Examples:

```text
DecisionApproved
    requires HumanMember actor
```

```text
WorkCompleted
    requires HumanMember actor
```

```text
MemoryGenerated
    may use System actor
```

An invalid actor/event combination must fail before commit.

---

# Payload Size Limit

The MVP should define a maximum serialized event size.

Recommended initial operational limit:

```text
256 KB
```

The exact limit may vary.

Large content should use references.

---

# Outbox Retention

Published Outbox records should not grow without bound.

Retention options include:

- move old Published records to archive storage
- partition by recordedAt
- delete after retention period when audit requirements permit
- preserve event history in a separate durable event archive

---

# Retention Separation

The Outbox is primarily a delivery mechanism.

It should not automatically be treated as the permanent legal audit store.

Audit retention and Outbox retention may differ.

---

# Partitioning

PostgreSQL table partitioning is optional for the MVP.

It may be introduced when volume requires it.

Possible partition key:

```text
recordedAt
```

Partitioning must preserve:

- eventId uniqueness
- pending-event queries
- stream ordering
- replay access

---

# Outbox Cleanup

Cleanup may remove only records that are:

```text
Published

AND

older than retention threshold

AND

not required for replay or audit
```

Pending, Claimed, or Failed records must not be deleted by routine cleanup.

---

# Claim Recovery

A recovery job resets expired claims.

Conceptual flow:

```text
Find Claimed records where lockedUntil < now

↓

Set status = Pending

↓

Clear lock fields

↓

Preserve attempt count

↓

Set nextAttemptAt
```

---

# Clock Requirements

Outbox timing depends on a consistent clock.

The system should use:

- UTC
- injected application clock for tests
- database time or synchronized service time
- bounded clock-skew assumptions

---

# Database Time

Using PostgreSQL:

```text
now()
```

for claim and retry timestamps reduces disagreement between Workers.

---

# Publication Configuration

Recommended configurable values:

```text
pollInterval

batchSize

claimLeaseDuration

maximumAttempts

baseRetryDelay

maximumRetryDelay

payloadSizeLimit

publishedRetentionPeriod

failedEventAlertThreshold
```

Configuration must not alter event business meaning.

---

# Notification Mechanism

Polling is sufficient for the MVP.

PostgreSQL `LISTEN / NOTIFY` may be added as a wake-up optimization.

It must not become the delivery guarantee.

The Outbox table remains the source of pending publication work.

---

# Worker Deployment

The publisher may run:

- inside the same process as the HTTP Application
- as a separate Worker process
- as multiple Worker replicas

All options remain part of the Modular Monolith codebase.

---

# Multiple Worker Safety

Multiple Workers require:

- safe claim semantics
- bounded lease
- claim ownership verification
- idempotent publication
- per-stream ordering strategy
- observable Worker identity

---

# Publication Idempotency

Where the destination supports producer deduplication, use:

```text
eventId
```

as the message deduplication key.

Destination deduplication is defense in depth.

Consumers must still be idempotent.

---

# Broker Partition Key

When a broker is introduced, recommended partition key:

```text
aggregateType + aggregateId
```

This supports per-Aggregate ordering.

OrganizationId alone is too broad and may reduce scalability.

---

# Message Key

Recommended message key:

```text
aggregateType:aggregateId
```

The eventId remains the unique message identity.

---

# Publication Failure Classification

Publication errors should be classified as:

```text
Transient

PermanentContract

PermanentSecurity

Configuration

Unknown
```

---

## Transient Publication Failure

Examples:

- network timeout
- temporary broker outage
- database connectivity issue
- throttling

Action:

```text
Retry with backoff
```

---

## Permanent Contract Failure

Examples:

- serialization failure
- invalid event schema
- unsupported destination contract
- payload exceeds configured limit

Action:

```text
Mark Failed

Alert

Require repair
```

---

## Permanent Security Failure

Examples:

- Organization mismatch
- invalid actor type
- prohibited sensitive field
- untrusted destination

Action:

```text
Mark Failed

Raise high-severity alert

Do not retry unchanged payload
```

---

## Configuration Failure

Examples:

- missing destination
- missing producer configuration
- unregistered event type

Action:

```text
Fail visibly

Retry only after configuration correction
```

---

# Publication Retry Schedule

Recommended backoff:

```text
delay =
    min(
        maximumRetryDelay,
        baseRetryDelay × 2^(attemptCount - 1)
    )
    + jitter
```

Retries must be bounded.

---

# Failure Preservation

The Outbox record should preserve only bounded error information.

Recommended:

```text
lastErrorCode

lastErrorMessage

errorReference
```

Avoid storing:

- full unbounded stack traces
- credentials
- raw network payloads
- sensitive provider responses

---

# Part 2 Invariants

The Transactional Outbox implementation must preserve:

1. Aggregate state and Outbox rows commit atomically.
2. Publication occurs only after commit.
3. Every eventId is unique.
4. Retries preserve the original eventId.
5. Claims expire safely after Worker failure.
6. Publication is at least once.
7. Consumers cannot assume one delivery.
8. Per-Aggregate order is preserved where required.
9. Failed stream-head events block later stream events unless explicitly repaired.
10. Unknown or invalid contracts fail visibly.
11. Schema versions are explicit.
12. Breaking contract changes use a new version or event type.
13. Outbox cleanup never deletes pending or failed work.
14. Large or sensitive data is not embedded unnecessarily.
15. Organization and actor metadata are validated before commit.

---

# Part 2 Design Summary

The Transactional Outbox provides a durable boundary between synchronous domain transactions and asynchronous processing.

The design guarantees:

```text
Committed Aggregate Change

+

Committed Event Record

=

One Atomic PostgreSQL Transaction
```

Publication is performed later by safely coordinated Workers.

The resulting delivery model is:

```text
At-Least-Once Publication

Per-Aggregate Ordering

Explicit Event Versioning

Recoverable Failure
```

Consumer idempotency completes the reliability model.

# Consumer Processing Model

Consumers react to committed events after publication.

A consumer may perform one of four responsibilities:

```text
Execute a cross-Aggregate Application Service

Update a read model

Invoke an external integration

Record operational or audit information
```

Every consumer must define its responsibility explicitly.

---

# Consumer Types

Recommended consumer categories:

```text
Domain Coordination Consumer

Projection Consumer

Integration Consumer

Operational Consumer
```

---

# Domain Coordination Consumer

A Domain Coordination Consumer reacts to one Aggregate fact by invoking an Application Service against another Aggregate.

Examples:

```text
DecisionApproved
    -> RecordDecisionOutcomeInWorkHandler

WorkCompleted
    -> GenerateMemoryHandler

MembershipRevoked
    -> AssignmentReconciliationHandler
```

The consumer does not modify the target Aggregate directly.

---

# Projection Consumer

A Projection Consumer updates a read model.

Examples:

```text
DecisionSubmitted
    -> DecisionReviewQueueProjection

WorkCompleted
    -> CompletedWorkProjection

MemoryApproved
    -> ApprovedMemoryProjection
```

Read models are eventually consistent.

They do not own authoritative domain state.

---

# Integration Consumer

An Integration Consumer communicates with an external service.

Examples:

```text
MembershipInvited
    -> InvitationEmailHandler

OrganizationSuspended
    -> ExternalAccessRevocationHandler

MemoryApproved
    -> NotificationHandler
```

External integration failure does not roll back the source domain fact.

---

# Operational Consumer

An Operational Consumer performs infrastructure or maintenance work.

Examples:

```text
HumanIdentityDisabled
    -> SessionInvalidationHandler

MembershipRevoked
    -> SecuritySessionCleanupHandler

OutboxPublicationFailed
    -> OperationsAlertHandler
```

Operational consumers have no Human business authority.

---

# Consumer Registration

Every consumer must be registered explicitly.

Conceptual registration:

```text
ConsumerRegistration
- consumerName
- eventType
- supportedSchemaVersions
- handlerType
- capability
- retryPolicy
- orderingRequirement
- enabled
```

---

# Consumer Name

Every consumer has a stable:

```text
consumerName
```

Examples:

```text
work-decision-outcome-handler

memory-generation-handler

decision-review-queue-projector

membership-invitation-email-handler
```

The name is used for:

- idempotency
- metrics
- logs
- failure handling
- replay targeting
- operational ownership

---

# Consumer Version

A consumer implementation may have a version.

Example:

```text
consumerName = memory-generation-handler

consumerVersion = 2
```

Consumer version is distinct from event schemaVersion.

---

# Consumer Capability

Each consumer has a narrow System capability.

Example:

```text
work-decision-outcome-handler
    capability = work.record_decision_outcome
```

```text
memory-generation-handler
    capability = memory.create_generated
```

Consumers must not receive unrelated authority.

---

# Consumer Processing Flow

A standard consumer follows:

```text
Receive Event

↓

Validate Envelope

↓

Validate Event Contract

↓

Resolve System Principal

↓

Verify Organization Scope

↓

Check Handler Idempotency

↓

Execute Handler Logic

↓

Persist Effects and Processed Record

↓

Commit

↓

Acknowledge Success
```

---

# Envelope Validation

Before processing, the consumer validates:

- eventId exists
- eventType is registered
- schemaVersion is supported
- eventCategory is supported
- aggregateType is valid
- aggregateId is valid
- aggregateVersion is positive
- occurredAt is valid
- correlationId exists
- Organization scope is valid
- payload matches the registered contract

Invalid envelopes must not reach domain mutation logic.

---

# Contract Validation

Contract validation checks:

```text
Required fields

Field types

Identifier structure

Enum values

Payload size

Actor requirements

Organization requirements

Semantic prerequisites
```

A structurally valid JSON payload is not necessarily a valid event contract.

---

# Consumer Organization Scope

Every Organization-owned event is processed in exactly one Organization context.

Conceptual rule:

```text
event.organizationId
    =
handler.executionOrganizationId
    =
targetResource.organizationId
```

Any mismatch is a permanent security failure.

---

# Global Event Processing

A global event such as:

```text
HumanIdentityDisabled
```

may have:

```text
organizationId = null
```

The consumer may query affected Organizations.

Each resulting Organization-specific action must execute separately.

Example:

```text
HumanIdentityDisabled
      │
      ▼
Find Active Memberships
      │
      ├── Process org-alpha
      ├── Process org-beta
      └── Process org-gamma
```

One Organization failure must not silently block all others indefinitely.

---

# Handler Transaction Boundary

Domain-changing handlers use a short database transaction.

```text
BEGIN

Check processed event

Authorize System capability

Load target Aggregate

Execute Aggregate command

Save Aggregate

Write new Outbox events

Record processed event

COMMIT
```

External calls must not occur inside this transaction unless they are short, local, and transactionally safe.

---

# External Preparation Boundary

When the handler requires external preparation:

```text
Load immutable source data

↓

Call external service outside transaction

↓

Validate result

↓

BEGIN short persistence transaction

↓

Recheck idempotency and target state

↓

Persist result

↓

COMMIT
```

Memory generation follows this pattern.

---

# Consumer Acknowledgement

The transport acknowledgement occurs only after successful consumer processing.

For a local PostgreSQL-backed dispatcher, acknowledgement may mean:

- handler result recorded
- processing state marked completed
- transaction committed

For an external broker, acknowledgement follows broker-specific semantics.

---

# Handler-Level Idempotency

Event publication is at least once.

Therefore every consumer must tolerate duplicate delivery.

The idempotency key is:

```text
consumerName + eventId
```

---

# Why EventId Alone Is Insufficient

One event may have multiple consumers.

Example:

```text
WorkCompleted
    -> GenerateMemoryHandler
    -> CompletedWorkProjection
    -> CompletionNotificationHandler
```

Each consumer must process the event independently.

Therefore:

```text
eventId
```

alone cannot represent completion for all consumers.

---

# Processed Event Store

Recommended processed-event record:

```text
ProcessedEvent
- consumerName
- eventId
- eventType
- schemaVersion
- organizationId
- aggregateType
- aggregateId
- aggregateVersion
- correlationId
- status
- firstReceivedAt
- processingStartedAt
- processedAt
- attemptCount
- handlerVersion
- resultReference
- lastErrorCode
- lastErrorMessage
```

---

# Processed Event Status

Recommended statuses:

```text
Processing

Processed

RetryPending

Failed

Skipped
```

A minimal implementation may use separate processing and failure tables.

Equivalent semantics must remain available.

---

# Processed Status

```text
Processed
```

means the consumer effect committed successfully.

Future duplicate delivery returns success without repeating the effect.

---

# Processing Status

```text
Processing
```

means one Worker has claimed consumer processing.

Processing claims must expire or be recoverable after a crash.

---

# Retry Pending Status

```text
RetryPending
```

means processing failed transiently and is scheduled for another attempt.

---

# Failed Status

```text
Failed
```

means automatic retries have stopped.

Operator or deployment intervention is required.

---

# Skipped Status

```text
Skipped
```

means an authorized operator explicitly chose not to apply the event for that consumer.

Skipping is exceptional and auditable.

---

# Recommended Processed Event Table

Conceptual DDL:

```sql
CREATE TABLE processed_events (
    consumer_name          text NOT NULL,
    event_id               uuid NOT NULL,
    event_type             text NOT NULL,
    schema_version         integer NOT NULL,
    organization_id        uuid NULL,
    aggregate_type         text NOT NULL,
    aggregate_id           text NOT NULL,
    aggregate_version      bigint NOT NULL,
    correlation_id         uuid NOT NULL,
    status                 text NOT NULL,
    first_received_at      timestamptz NOT NULL,
    processing_started_at  timestamptz NULL,
    processed_at           timestamptz NULL,
    attempt_count          integer NOT NULL DEFAULT 0,
    handler_version        integer NULL,
    result_reference       jsonb NULL,
    last_error_code        text NULL,
    last_error_message     text NULL,

    PRIMARY KEY (
        consumer_name,
        event_id
    )
);
```

---

# Atomic Consumer Effect

For domain-changing consumers, the following must commit atomically:

```text
Target Aggregate state

Target Aggregate version

New Outbox events

Processed event record

Required audit metadata
```

---

# Duplicate Delivery Flow

```text
Receive Event

↓

Find:
consumerName + eventId

↓

Status = Processed

↓

Return Success

↓

Do Not Execute Handler Again
```

Duplicate delivery is an expected condition.

It should not produce an error alert.

---

# Duplicate While Processing

When another Worker is already processing the same event:

```text
Status = Processing
```

The second Worker should:

- avoid concurrent execution
- defer processing
- retry after the processing lease expires
- avoid reporting a permanent failure

---

# Processing Lease

A processing claim may contain:

```text
lockedBy

lockedUntil

claimVersion
```

The same lease principles used by the Outbox publisher apply to consumers.

---

# Business-Level Idempotency

Technical processed-event storage is necessary but not sufficient.

Target Aggregates should also defend against duplicate logical facts.

Example:

```text
Work.RecordDecisionOutcome(
    decisionId,
    Approved
)
```

The Work Aggregate should recognize that the same Decision outcome has already been recorded.

---

# Technical and Domain Idempotency

The reliability model uses both:

```text
Processed Event Store
    prevents duplicate handler execution
```

and:

```text
Aggregate Invariants
    prevent duplicate business effects
```

This defense in depth protects against:

- lost processed-event records
- manual replay errors
- alternate consumers
- migration defects
- duplicate logical events with different eventIds

---

# Duplicate Logical Event

Two different eventIds may incorrectly describe the same business fact.

Example:

```text
DecisionApproved event A

DecisionApproved event B

same decisionId
same revision
```

The processed-event store sees different messages.

The target Aggregate or handler business key must prevent duplicate outcome application.

---

# Business Idempotency Key

Examples:

```text
Decision outcome:
    decisionId + decisionRevision

Memory generation:
    workId + generationPolicyVersion

Invitation delivery:
    membershipId + invitationVersion

Projection update:
    aggregateType + aggregateId + aggregateVersion
```

---

# Projection Idempotency

A projection consumer may store the latest applied Aggregate version.

Conceptual rule:

```text
incoming aggregateVersion
    <=
projection lastAppliedVersion

↓

Ignore as duplicate or stale
```

---

# Projection Gap

When:

```text
incoming aggregateVersion
    >
lastAppliedVersion + 1
```

the projection has detected a gap.

It must not silently assume missing events are irrelevant.

---

# Projection Gap Handling

Possible actions:

- defer the event
- request earlier events
- rebuild the affected projection entry from source state
- trigger reconciliation
- raise an operational alert

The chosen strategy must be explicit per projection.

---

# Domain Consumer Ordering

A domain coordination consumer must verify whether event order matters.

Example:

```text
DecisionSubmitted version 3

DecisionApproved version 4
```

A consumer that only handles DecisionApproved may not need to process DecisionSubmitted.

However, it must still verify that the target state can safely accept the approved outcome.

---

# Stale Event Handling

An event is stale when a newer fact has already been applied.

Example:

```text
DecisionApproved revision 1

DecisionApproved revision 2 already recorded
```

Possible result:

```text
No operation

Mark event processed as stale
```

The handler must record why no mutation was required.

---

# No-Op Success

A valid event may require no new effect because the target state already reflects it.

Examples:

- duplicate Decision outcome already recorded
- session already invalidated
- projection already at a newer version
- Memory already generated for the Work

The handler may record:

```text
Processed

result = NoOpAlreadyApplied
```

---

# Consumer Retry Model

Consumers retry transient failures.

They do not retry unchanged permanent failures automatically.

---

# Retryable Failures

Examples:

```text
Database temporarily unavailable

Optimistic concurrency conflict

External service timeout

Rate limit

Temporary dependency outage

Processing lease interruption
```

---

# Non-Retryable Failures

Examples:

```text
Unsupported schema version

Malformed event payload

Organization mismatch

Prohibited actor type

Unknown required identifier

Invalid source event for capability

Deterministic domain rejection caused by invalid event
```

---

# Retry Classification

Recommended categories:

```text
TransientInfrastructure

TransientConcurrency

TransientExternalDependency

PermanentContract

PermanentSecurity

PermanentDomain

Configuration

Unknown
```

---

# Transient Infrastructure Failure

Examples:

- database connection interruption
- broker timeout
- temporary storage failure
- process shutdown

Action:

```text
Retry with bounded backoff
```

---

# Transient Concurrency Failure

Example:

```text
Target Aggregate changed after handler load
```

Action:

```text
Reload target Aggregate

Re-evaluate event applicability

Retry transaction
```

The handler must not reuse stale domain decisions.

---

# Transient External Dependency Failure

Examples:

- AI generation timeout
- email provider outage
- external notification service throttling

Action:

```text
Retry according to dependency-specific policy
```

External calls must have explicit timeouts.

---

# Permanent Contract Failure

Examples:

- missing required field
- unsupported schema version
- invalid field type
- payload exceeds allowed size

Action:

```text
Stop automatic retry

Mark Failed

Alert contract owner
```

---

# Permanent Security Failure

Examples:

- Organization mismatch
- invalid System capability
- event actor violates authority rules
- untrusted source
- cross-Organization target reference

Action:

```text
Stop automatic retry

Raise high-severity alert

Preserve evidence
```

---

# Permanent Domain Failure

A permanent domain failure occurs when a validly delivered event requests an impossible target transition.

Example:

```text
DecisionApproved references Work that never requested the Decision
```

Action:

- do not modify target Aggregate
- mark processing Failed
- create reconciliation finding
- investigate source association

The handler must not force the transition.

---

# Configuration Failure

Examples:

- consumer not registered
- missing policy mapping
- missing external endpoint
- invalid handler capability
- unsupported contract registry state

Action:

```text
Fail visibly

Retry only after configuration correction
```

---

# Unknown Failure

Unknown failures may be retried conservatively.

After the bounded threshold:

```text
Mark Failed

Escalate
```

Unknown exceptions must not result in endless retry loops.

---

# Retry Schedule

Recommended consumer retry formula:

```text
delay =
    min(
        maximumDelay,
        baseDelay × 2^(attemptCount - 1)
    )
    + jitter
```

Different consumers may use different retry policies.

---

# Consumer-Specific Retry Policies

Examples:

```text
Decision outcome handler
    short retry interval
    low external dependency

Memory generation handler
    longer timeout
    slower retry
    AI rate-limit awareness

Invitation email handler
    moderate retry
    delivery-provider backoff

Projection handler
    rapid retry
    gap detection
```

---

# Retry Limits

Every consumer must define:

```text
maximumAttempts

maximumElapsedTime

baseDelay

maximumDelay

timeout

retryableErrorCategories
```

Defaults may exist, but consumer-specific overrides should be explicit.

---

# Retry Safety

Before every retry, the handler checks:

- processed-event state
- current target Aggregate state
- current Organization scope
- current System capability
- existing business result
- source event validity

The handler must assume a previous attempt may have committed despite an acknowledgement failure.

---

# Retry After Commit Uncertainty

Example:

```text
Handler transaction commits

↓

Database response is lost

↓

Worker assumes failure
```

On retry:

```text
Processed event record exists

↓

Return prior success
```

This prevents duplicate mutation.

---

# Handler Timeout

Every handler must have a bounded processing timeout.

Timeout categories may include:

```text
database transaction timeout

external AI timeout

email delivery timeout

projection update timeout
```

Infinite processing is prohibited.

---

# Cancellation

Workers should support cooperative cancellation during shutdown.

A cancelled attempt must:

- release or expire processing claims
- preserve retryability
- avoid partial uncommitted state
- avoid marking success prematurely

---

# Memory Generation Consumer

Memory generation requires additional idempotency protections.

---

# Memory Generation Identity

Recommended business key:

```text
workId + memoryGenerationPolicyVersion
```

Example:

```text
work-123:v1
```

---

# Memory Generation Flow

```text
Receive WorkCompleted

↓

Check processed event

↓

Check active Memory by workId

↓

Load immutable Work source material

↓

Create generation attempt

↓

Invoke AI outside transaction

↓

Validate generated candidate

↓

BEGIN

Recheck processed event

Recheck active Memory uniqueness

Create Memory Aggregate in Generated state

Save Memory

Write MemoryGenerated to Outbox

Mark event processed

COMMIT
```

---

# Memory Generation Duplicate Result

If an active Memory already exists for the Work:

```text
Do not create another Memory

Mark event processed

Result = NoOpMemoryAlreadyExists
```

---

# AI Generation Failure

When AI generation fails:

- Work remains Completed
- no partial Memory is created
- generation attempt records the failure
- consumer retry follows policy
- Human authority is unaffected

---

# Generation Attempt State

Recommended states:

```text
Pending

Generating

Generated

Failed

Abandoned
```

Generation attempt records are operational metadata.

They are not the Memory Aggregate.

---

# Generation Policy Version

The policy version identifies:

- prompt template version
- source selection policy
- output schema
- generation model policy
- validation policy

A policy change does not automatically regenerate existing approved Memory.

---

# Decision Outcome Consumer

The Decision outcome consumer handles:

```text
DecisionApproved

DecisionRejected

DecisionWithdrawn
```

---

# Decision Outcome Business Key

Recommended key:

```text
decisionId + revisionNumber + outcome
```

The target Work must verify that the Decision is related to its Completion Gate.

---

# Decision Outcome Flow

```text
Receive Decision Outcome Event

↓

Validate Human-authoritative source actor

↓

Resolve related Work

↓

Verify same Organization

↓

Load Work

↓

Work.RecordDecisionOutcome(...)

↓

Persist Work and Outbox

↓

Mark event processed
```

---

# Decision Outcome Prohibitions

The handler must not:

- complete Work
- cancel Work
- create another Decision automatically
- rewrite the Decision
- override the Completion Gate directly
- infer a different outcome

---

# Membership Reconciliation Consumer

The Membership reconciliation consumer reacts to:

```text
MembershipSuspended

MembershipRevoked

HumanIdentityDisabled

OrganizationRoleRevoked
```

It may create administrative findings.

It may not reassign resources automatically.

---

# Session Invalidation Consumer

The Session invalidation consumer is operational.

It may invalidate:

- all sessions for a Disabled Identity
- Organization sessions for a Suspended Membership
- Organization sessions for a Revoked Membership
- sessions scoped to a Suspended or Archived Organization

Repeated invalidation is a successful no-op.

---

# Poison Event

A poison event repeatedly fails for deterministic reasons.

Examples:

```text
Malformed payload

Impossible association

Unsupported schema version

Invalid Organization relationship

Handler defect triggered by one payload

Corrupted historical event
```

---

# Poison Event Detection

An event may be classified as poison when:

- failure is permanent on first attempt
- retry threshold is exhausted
- identical deterministic failure repeats
- contract validation cannot succeed
- security validation fails

---

# Poison Event Record

Recommended record:

```text
PoisonEvent
- consumerName
- eventId
- eventType
- schemaVersion
- organizationId
- aggregateId
- correlationId
- failureCategory
- firstFailedAt
- lastFailedAt
- attemptCount
- errorCode
- errorReference
- status
- assignedTo
- resolvedAt
- resolution
```

---

# Poison Event Status

Recommended statuses:

```text
Open

Investigating

ReadyForReplay

Resolved

Skipped
```

---

# Dead Letter Storage

The MVP may use PostgreSQL-backed dead letter storage.

An external broker dead-letter queue is optional.

Required capabilities:

- durable failed-event storage
- consumer-specific failure state
- search by eventId
- search by correlationId
- retry control
- operator notes
- audit history
- alert integration

---

# Dead Letter Versus Outbox Failure

These are separate concepts.

```text
Outbox Failure
    event could not be published
```

```text
Consumer Dead Letter
    event was published but one consumer could not process it
```

One event may be Published in the Outbox while Failed for one consumer.

---

# Multi-Consumer Failure Isolation

Example:

```text
WorkCompleted
    -> Memory Generation succeeds
    -> Notification fails
    -> Projection succeeds
```

The notification failure must not erase or repeat successful consumer effects.

Each consumer tracks independent status.

---

# Poison Event Investigation

Investigation should determine:

- whether the source event is valid
- whether the event contract is supported
- whether the target association is correct
- whether the handler contains a defect
- whether data repair is required
- whether replay is safe
- whether later events are blocked

---

# Poison Event Security

Sensitive event payloads should not be copied into unrestricted support tools.

Operational interfaces should use:

- payload references
- redacted fields
- privacy classification
- role-restricted access
- audited inspection

---

# Dead Letter Alerting

High-severity alerts should be generated for:

```text
PermanentSecurity failure

Unknown event type

Unsupported authority-sensitive schema

Organization mismatch

Repeated Work or Decision coordination failure

Memory generation backlog beyond threshold
```

---

# Event Replay

Replay re-executes event processing for a selected consumer.

Replay does not alter the original event.

---

# Replay Use Cases

Examples:

```text
Handler defect fixed

Projection rebuilt

External dependency restored

Association repaired

Consumer introduced for historical events

Operational processing missed
```

---

# Replay Scope

Replay may target:

```text
One event and one consumer

One correlation flow

One Aggregate stream

One event type and time range

One Organization

One projection
```

Broad replay requires stronger operational controls.

---

# Replay Command

Conceptual administrative command:

```text
ReplayEvent
- eventId
- consumerName
- reason
- requestedBy
- replayMode
```

---

# Replay Modes

Recommended modes:

```text
RetryOriginal

ReprocessWithCurrentHandler

RebuildProjection

ValidateOnly
```

---

# Retry Original

```text
RetryOriginal
```

retries the same consumer effect using the original event contract and supported handler path.

---

# Reprocess With Current Handler

```text
ReprocessWithCurrentHandler
```

uses the current handler implementation and any registered upcaster.

The original event remains immutable.

---

# Rebuild Projection

```text
RebuildProjection
```

applies events to a disposable or resettable read model.

It must not mutate authoritative Aggregates unless explicitly designed as a domain replay.

---

# Validate Only

```text
ValidateOnly
```

runs:

- envelope validation
- contract validation
- upcasting
- handler precondition checks

without committing consumer effects.

---

# Replay Identifier

A replay attempt should have its own:

```text
replayId
```

while preserving:

```text
originalEventId
correlationId
organizationId
```

---

# Replay and Processed Events

The default behavior is:

```text
Processed event exists

↓

Replay denied or returns no-op
```

An explicit authorized replay may reset or supersede the consumer processing record.

This action must be audited.

---

# Replay Safety

Before domain-changing replay:

- verify current target Aggregate state
- verify business effect has not already occurred
- verify Organization scope
- verify System capability
- verify event contract
- verify later events are not invalidated
- define rollback or remediation strategy

---

# Replay Prohibitions

Replay must not:

- change original event payload
- change original actor
- change original Organization
- fabricate Human authority
- bypass Aggregate commands
- disable idempotency silently
- apply an event to a different resource
- rewrite historical timestamps

---

# Replay Audit

Replay audit should capture:

```text
replayId
originalEventId
consumerName
requestedBy
reason
mode
handlerVersion
startedAt
completedAt
result
```

---

# Event Reprocessing After Handler Upgrade

When a handler upgrade changes behavior:

- old successful consumer effects are not automatically replayed
- explicit migration criteria are required
- domain mutations require careful compatibility analysis
- projection rebuilds are safer than authoritative state replay

---

# Reconciliation

Reconciliation detects missing or inconsistent asynchronous outcomes.

It complements event retry.

It does not replace the Transactional Outbox.

---

# Reconciliation Purpose

Reconciliation answers:

> Did the expected consequence of a committed fact eventually occur?

Examples:

```text
Approved Decision not recorded in Work

Completed Work has no Memory attempt

Revoked Membership has unresolved active assignments

Published event has no consumer processing record

Aggregate stream has a version gap
```

---

# Reconciliation Types

Recommended categories:

```text
Workflow Reconciliation

Outbox Reconciliation

Consumer Reconciliation

Projection Reconciliation

Assignment Reconciliation
```

---

# Workflow Reconciliation

Checks cross-Aggregate expectations.

Examples:

```text
DecisionApproved
    but Work Completion Gate still Pending

WorkCompleted
    but no Memory generation record exists
```

---

# Outbox Reconciliation

Checks publication health.

Examples:

```text
Pending event older than threshold

Claimed event with expired lease

Failed stream-head event

Published timestamp missing
```

---

# Consumer Reconciliation

Checks consumer processing health.

Examples:

```text
Published event without consumer record

RetryPending beyond threshold

Processing lease expired

Failed event unresolved
```

---

# Projection Reconciliation

Checks read-model consistency.

Examples:

```text
projection version behind source Aggregate

projection stream gap

missing review-queue entry

stale Organization member directory
```

---

# Assignment Reconciliation

Checks resource relationships affected by identity lifecycle changes.

Examples:

```text
Work assigned to Revoked Membership

Decision assigned to Suspended Reviewer

Memory review assigned to Disabled Identity
```

---

# Reconciliation Findings

Recommended record:

```text
ReconciliationFinding
- findingId
- findingType
- severity
- organizationId
- sourceEventId
- aggregateType
- aggregateId
- consumerName
- detectedAt
- status
- resolutionReference
```

---

# Finding Status

Recommended statuses:

```text
Open

RecoveryScheduled

Resolved

AcceptedRisk

FalsePositive
```

---

# Reconciliation Recovery

A reconciliation job may:

- schedule the normal consumer again
- release an expired claim
- create an administrative task
- request projection rebuild
- notify operators
- mark a resolved no-op

It must not create an alternative mutation path.

---

# Normal Path Reuse

Correct recovery:

```text
Missing Memory generation

↓

Schedule WorkCompleted for GenerateMemoryHandler
```

Incorrect recovery:

```text
Insert Memory row directly
```

---

# Gap Detection

Gap detection identifies missing event versions.

For one Aggregate stream:

```text
lastProcessedVersion = 4

incomingVersion = 6
```

Version 5 may be missing.

---

# Gap Detection Record

Conceptual record:

```text
StreamGap
- consumerName
- aggregateType
- aggregateId
- expectedVersion
- receivedVersion
- detectedAt
- status
```

---

# Gap Resolution

Possible resolution paths:

- locate and process the missing event
- verify the event was intentionally absent
- rebuild consumer state from authoritative Aggregate state
- repair corrupted event history
- skip with explicit audit when safe

---

# Aggregate Version Without Event

Not every Aggregate version must necessarily produce a public Integration Event.

Therefore gap detection must use the event contract strategy.

Options include:

- every state-changing version produces an event
- stream sequence independent of Aggregate version
- registry of event-producing versions
- projection rebuild from source state

The MVP should prefer every meaningful Aggregate transition producing at least one Domain Event.

---

# Event Stream Sequence

For stricter gap detection, introduce:

```text
streamSequence
```

incremented only when an event is emitted.

This is optional in the MVP.

When absent, consumers must not assume every Aggregate version has a corresponding event.

---

# Stream Reconciliation

A periodic job may verify:

```text
Outbox events are unique by stream position

No duplicate aggregateVersion and eventSequence

No later Published event with blocked earlier stream head

No consumer version regression
```

---

# Reconciliation Schedule

Recommended frequencies:

```text
Expired claim recovery:
    frequent

Pending Outbox age check:
    frequent

Failed consumer check:
    frequent

Workflow reconciliation:
    periodic

Projection verification:
    periodic or on demand

Large historical consistency scan:
    scheduled maintenance
```

---

# Reconciliation Idempotency

Reconciliation jobs must be idempotent.

Duplicate detection must not create duplicate:

- replay requests
- administrative findings
- notifications
- recovery commands

---

# Reconciliation Does Not Grant Authority

A reconciliation finding is evidence of missing processing.

It does not authorize:

- Work completion
- Decision approval
- Memory approval
- Membership revocation
- role assignment

Human-only actions remain Human-only.

---

# Event Archival

Long-term event archival may support:

- replay
- audit correlation
- incident investigation
- projection rebuild
- migration

The archive must preserve immutable event envelopes.

---

# Archive Integrity

Archived events must retain:

```text
eventId

eventType

schemaVersion

payload

occurredAt

correlationId

causationId

Organization scope

actorReference
```

---

# Archive Retrieval

Replay and investigation should retrieve events by:

- eventId
- Aggregate stream
- correlationId
- Organization
- eventType
- time range

Access must remain authorization-controlled.

---

# Event Retention and Consumer State

Deleting old Outbox rows must not delete required consumer history prematurely.

Retention policies for:

```text
Outbox records

Processed events

Dead letter records

Replay records

Audit records
```

must be defined separately.

---

# Consumer State Cleanup

Processed-event records may be archived or compacted only when:

- source event can no longer be redelivered
- replay requirements are satisfied
- audit requirements are satisfied
- business deduplication remains safe

Premature deletion may allow duplicate effects.

---

# Disaster Recovery

Backup and restore must preserve consistency among:

- Aggregate tables
- Outbox messages
- processed-event records
- consumer failure records
- replay records
- reconciliation findings

Restoring Aggregate state without the corresponding Outbox may lose committed consequences.

---

# Restore Point Consistency

Backups should use a transactionally consistent database snapshot or equivalent point-in-time recovery.

Partial table restoration is prohibited for routine disaster recovery.

---

# Post-Restore Reconciliation

After restoration:

- release expired claims
- verify pending Outbox records
- verify consumer processing state
- detect replayed broker messages
- run workflow reconciliation
- verify stream ordering
- inspect failed events

---

# Consumer Processing Rules

The following rules are mandatory:

1. Every consumer has a stable consumerName.
2. Every consumer declares supported event types and schema versions.
3. Consumer effects are idempotent by consumerName and eventId.
4. Domain-changing effects commit atomically with the processed-event record.
5. Duplicate delivery returns success without repeating effects.
6. Business-level idempotency protects against duplicate logical events.
7. Organization scope is validated before target mutation.
8. System capability is narrow and explicit.
9. Retries are bounded and classified.
10. Permanent contract and security failures are not retried unchanged.
11. Poison events remain durable and inspectable.
12. Multi-consumer failures are isolated.
13. Replay preserves the original event and authority context.
14. Reconciliation uses normal Application Service paths.
15. No replay or reconciliation creates new Human business intent.
16. External calls do not hold long database transactions.
17. Consumer gaps are detected or safely rebuildable.
18. Failed processing remains observable and recoverable.

---

# Part 3 Design Summary

Consumer reliability is built from four complementary mechanisms:

```text
At-Least-Once Delivery

+

Handler-Level Idempotency

+

Aggregate Business Invariants

+

Operational Reconciliation
```

The Processed Event Store prevents repeated consumer execution.

Aggregate invariants prevent duplicate business effects.

Retry handles transient failures.

Dead letter handling preserves permanent failures for investigation.

Replay and reconciliation restore missing outcomes through the same supported Application Services used by normal processing.

This produces effectively-once business behavior without claiming exactly-once transport delivery.

# Event Security

Events are trusted system inputs only after validation.

The existence of an event record does not automatically make every payload field trustworthy.

Consumers must validate:

- producer ownership
- event type
- schema version
- Organization scope
- actor type
- payload structure
- permitted causation
- target relationship
- consumer capability

---

# Trust Boundaries

The event architecture crosses several trust boundaries:

```text
Aggregate
    -> Application Layer

Application Layer
    -> Outbox Storage

Outbox Storage
    -> Publisher

Publisher
    -> Event Transport

Event Transport
    -> Consumer

Consumer
    -> Target Application Service
```

Each boundary must validate the data required for its responsibility.

---

# Aggregate Trust

The Application Layer trusts an Aggregate to produce valid domain facts only when:

- the Aggregate was loaded from trusted persistence
- the command executed through the Aggregate API
- the Aggregate accepted the transition
- the emitted event type belongs to that Aggregate
- the event is enriched using trusted request metadata

The Application Layer must not accept arbitrary client-supplied Domain Events.

---

# Producer Validation

Before Outbox persistence, the producer validates:

```text
Registered event type

Registered schema version

Expected source Aggregate

Valid aggregateId

Valid aggregateVersion

Valid Organization scope

Permitted actor type

Payload schema

Payload size

Privacy classification
```

---

# Event Source Authenticity

Inside the MVP Modular Monolith, source authenticity is established through:

- trusted application code
- the shared PostgreSQL transaction
- controlled Outbox writes
- restricted database permissions
- internal Worker identity

Public clients must not have direct write access to the Outbox.

---

# Outbox Write Permissions

Only the application database role responsible for domain transactions may insert Outbox messages.

Recommended restrictions:

```text
Public API database role
    no direct arbitrary Outbox insert

Outbox Publisher
    read and publication-status update only

Consumer Worker
    processed-event and target-domain permissions only

Operations tooling
    restricted replay and recovery permissions
```

---

# Outbox Mutation Restrictions

After commit, event content is immutable.

The publisher may update only delivery metadata such as:

```text
status

attemptCount

nextAttemptAt

lockedBy

lockedUntil

publishedAt

lastErrorCode

lastErrorMessage
```

It must not update:

```text
eventId

eventType

schemaVersion

payload

organizationId

actorReference

occurredAt

correlationId

causationId
```

---

# Consumer Trust Validation

A consumer must verify that the event is permitted for that handler.

Example:

```text
consumerName =
    memory-generation-handler

allowed eventType =
    WorkCompleted
```

The same consumer must reject:

```text
DecisionApproved

MembershipRevoked

UnknownEvent
```

unless explicitly registered.

---

# Capability Validation

Every domain-changing consumer executes under a narrow System capability.

Example:

```text
Decision outcome consumer
    -> work.record_decision_outcome
```

It must not possess:

```text
work.complete

decision.approve

memory.approve

organization.assign_owner
```

---

# Authority-Sensitive Events

Events representing Human-authoritative facts require a Human actor.

Examples:

```text
WorkCompleted

DecisionSubmitted

DecisionApproved

DecisionRejected

DecisionWithdrawn

MemorySubmittedForReview

MemoryApproved

MemoryRejected
```

A producer must reject these events when:

```text
actorType != HumanMember
```

---

# System-Originated Events

System actors may originate operational or candidate-generation facts.

Examples:

```text
MemoryGenerated

SessionInvalidationCompleted

ReconciliationFindingCreated

EventProcessingRetried
```

These events must not be interpreted as Human approval.

---

# Secretary-Originated Events

Secretary-originated events remain advisory.

Examples:

```text
DecisionSecretaryContributionRecorded

MemorySecretaryContributionRecorded
```

Secretary events may never represent:

- Work completion
- Decision submission
- Decision approval
- Decision rejection
- Decision withdrawal
- Memory submission
- Memory approval
- Memory rejection
- Knowledge promotion

---

# Event Causation Validation

A consumer must validate that the incoming event is an allowed cause of the requested operation.

Example:

```text
DecisionApproved
    may cause
Work.RecordDecisionOutcome(Approved)
```

Invalid:

```text
DecisionApproved
    causes
Work.CompleteWork()
```

---

# Causation Whitelist

Recommended registration:

```text
RecordDecisionOutcomeInWorkHandler

Accepted causes:
- DecisionApproved
- DecisionRejected
- DecisionWithdrawn

Allowed target command:
- Work.RecordDecisionOutcome
```

---

# Event as Evidence

An event is evidence that a source fact occurred.

It is not a general-purpose bearer token.

An event must not be reused to authorize unrelated commands.

---

# Organization Security

Every Organization-owned event must include a valid:

```text
organizationId
```

A consumer must compare it with:

- target Aggregate Organization
- handler execution Organization
- related resource Organization
- principal execution scope

---

# Organization Mismatch

If any Organization identifier differs:

```text
Processing stops

No target mutation occurs

Failure classified as PermanentSecurity

High-severity audit record created
```

The consumer must not attempt to repair the mismatch by changing the event Organization.

---

# Global Event Security

Global events require explicit registration.

Examples:

```text
HumanIdentityDisabled
```

A global event must not contain an arbitrary list of Organization targets supplied by an untrusted producer.

Consumers derive affected Organizations through trusted queries.

---

# Cross-Organization Fan-Out

When a global event affects multiple Organizations:

```text
Global event
    -> internal query
    -> one Organization-scoped execution per Membership
```

Each execution has its own:

```text
organizationId

processing result

retry state

audit record
```

---

# Event Privacy

Events should contain the minimum data required by consumers.

Privacy rules apply to:

- payloads
- headers
- error records
- logs
- dead letter storage
- replay tools
- event archives

---

# Privacy Classification

Recommended classifications:

```text
PublicInternal

OrganizationConfidential

PersonalData

SecuritySensitive

Restricted
```

Every event contract should declare its classification.

---

# Event Data Minimization

Prefer:

```text
identityId

membershipId

organizationId

resourceId
```

over:

```text
full identity profile

full Membership record

complete authentication claims

full protected document content
```

---

# Personal Data in Events

Personal data may be included only when:

- required by a specific consumer
- documented in the contract
- authorized for the destination
- retained according to policy
- excluded from unnecessary logs

---

# Sensitive Field Prohibition

The following must never appear in event payloads or headers:

```text
passwords

access tokens

refresh tokens

raw invitation tokens

private signing keys

session secrets

authentication cookies

unredacted provider credentials
```

---

# Error Privacy

Failure records should preserve bounded diagnostic information.

Preferred:

```text
errorCode

errorCategory

errorReference
```

Avoid storing entire event payloads repeatedly in:

- logs
- alerts
- ticketing systems
- monitoring labels

---

# Dead Letter Access

Access to poison-event payloads must be restricted.

Authorized operators may need:

- event metadata
- redacted payload
- correlation chain
- consumer history
- failure reason

Every inspection of Restricted data should be auditable.

---

# Replay Security

Replay is an administrative operation.

It requires:

- authenticated Human operator
- explicit replay permission
- Organization scope
- target consumer
- reason
- replay mode
- audit record

---

# Replay Authorization

Recommended permissions:

```text
events.read

events.inspect_failed

events.retry

events.replay_projection

events.replay_domain_consumer

events.skip
```

Domain-changing replay should require stronger authority than projection rebuild.

---

# Replay Scope Restriction

An operator authorized for one Organization must not replay events belonging to another Organization.

Global replay requires dedicated platform authority.

---

# Skip Authorization

Skipping a failed event is more dangerous than retrying it.

It requires:

- privileged Human operator
- explicit reason
- impact confirmation
- downstream reconciliation plan
- immutable audit record

The Secretary and ordinary System Workers cannot skip events.

---

# Event Integrity

The MVP may use database access control and transaction integrity as the primary event-integrity mechanism.

Cryptographic signing is optional inside one trusted deployment boundary.

---

# External Event Signing

When events leave the AIOS trust boundary, future integration may require:

- message signing
- transport encryption
- key rotation
- destination authentication
- replay protection
- timestamp validation

These controls belong to external integration architecture.

---

# Payload Hash

The Outbox may store a payload hash.

Example:

```text
payloadHash
```

Benefits include:

- detecting accidental mutation
- replay verification
- operational comparison
- audit support

A hash does not replace access control.

---

# Event Security Invariants

The following rules are mandatory:

1. Clients cannot create Domain Events directly.
2. Only registered producers may originate registered events.
3. Event content is immutable after commit.
4. Authority-sensitive events require Human actors.
5. Secretary events remain advisory.
6. System events remain operational.
7. Consumers use narrow capability whitelists.
8. Event causation is explicitly validated.
9. Organization mismatch stops processing.
10. Global event fan-out is derived through trusted queries.
11. Secrets never appear in event payloads.
12. Replay and skip operations require Human authorization.
13. Failed-event inspection is access-controlled.
14. Events are not reusable general-purpose authority tokens.
15. Security failures fail closed.

---

# Observability

The event system must make asynchronous state visible.

Operators should be able to answer:

- Which events are pending?
- Which events are blocked?
- Which consumers are failing?
- How old is the backlog?
- Which business workflows are incomplete?
- Which event caused a target state?
- Which Organization is affected?
- Which retries have occurred?
- Can the failure be safely replayed?

---

# Logging

All event-processing logs should use structured fields.

Recommended fields:

```text
event.id

event.type

event.category

event.schema_version

event.aggregate_type

event.aggregate_id

event.aggregate_version

event.organization_id

event.correlation_id

event.causation_id

consumer.name

consumer.version

worker.id

processing.attempt

processing.status

error.category

error.code
```

---

# Logging Content

Logs should describe processing metadata, not duplicate full event content.

Preferred:

```text
Event processing failed
eventId = ...
consumerName = ...
errorCode = ...
```

Avoid:

```text
Full Memory payload dumped into log
```

---

# Correlation Logging

Every command, event, publication attempt, and consumer execution should log:

```text
correlationId
```

This allows one workflow to be traced across modules.

---

# Causation Logging

Each follow-up command or event should log:

```text
causationId
```

This supports direct parent-child tracing.

---

# Publication Metrics

Recommended Outbox metrics:

```text
outbox_pending_total

outbox_claimed_total

outbox_failed_total

outbox_published_total

outbox_publication_attempt_total

outbox_publication_failure_total

outbox_oldest_pending_age_seconds

outbox_publication_latency_seconds

outbox_claim_expired_total
```

---

# Consumer Metrics

Recommended consumer metrics:

```text
event_consumer_received_total

event_consumer_processed_total

event_consumer_duplicate_total

event_consumer_retry_total

event_consumer_failed_total

event_consumer_processing_duration_seconds

event_consumer_oldest_retry_age_seconds

event_consumer_noop_total

event_consumer_stale_total
```

Metrics should be labeled by bounded values such as:

```text
consumerName

eventType

resultCategory
```

Avoid unbounded labels such as eventId or aggregateId.

---

# Memory Generation Metrics

Recommended metrics:

```text
memory_generation_started_total

memory_generation_succeeded_total

memory_generation_failed_total

memory_generation_duration_seconds

memory_generation_retry_total

completed_work_without_memory_total
```

---

# Reconciliation Metrics

Recommended metrics:

```text
reconciliation_findings_open_total

reconciliation_findings_created_total

reconciliation_findings_resolved_total

event_stream_gap_total

expired_processing_claim_total

workflow_recovery_scheduled_total
```

---

# Dead Letter Metrics

Recommended metrics:

```text
dead_letter_open_total

dead_letter_created_total

dead_letter_resolved_total

dead_letter_replayed_total

dead_letter_skipped_total
```

---

# Backlog Age

Backlog count alone is insufficient.

The system must also measure the age of the oldest item.

Examples:

```text
oldest pending Outbox event

oldest RetryPending consumer event

oldest open poison event

oldest unresolved reconciliation finding
```

---

# Service Level Objectives

The MVP should define operational targets.

Example initial targets:

```text
Normal Outbox publication:
    within 30 seconds

Decision outcome propagation:
    within 60 seconds

Memory generation start:
    within 2 minutes

Session invalidation processing:
    within 60 seconds

Critical poison-event alert:
    within 5 minutes
```

Exact targets should be adjusted after production measurement.

---

# Alerting

Recommended alerts include:

```text
Outbox oldest pending age above threshold

Failed stream-head event

Consumer retry backlog increasing

PermanentSecurity processing failure

Unknown event type

Unsupported schema version

Memory generation failure threshold exceeded

Completed Work without Memory attempt

Expired claims accumulating

Dead letter count increasing
```

---

# Alert Severity

Suggested severity categories:

```text
Informational

Warning

High

Critical
```

Examples:

```text
Single transient notification failure
    -> Warning or no immediate alert
```

```text
Organization mismatch in domain consumer
    -> High
```

```text
Outbox publication halted globally
    -> Critical
```

---

# Health Checks

Health checks should expose:

- PostgreSQL connectivity
- Outbox publisher availability
- consumer Worker availability
- pending backlog status
- claim recovery health
- failed-event storage availability
- reconciliation scheduler health

---

# Liveness and Readiness

```text
Liveness
    Is the process running?
```

```text
Readiness
    Can the process safely accept work?
```

A Worker may be alive but not ready when:

- database unavailable
- contract registry failed
- required consumer configuration missing
- internal identity unavailable

---

# Degraded Mode

The HTTP Application may remain available during temporary Worker degradation.

Valid temporary outcomes include:

```text
Command succeeds

Outbox event remains pending

Asynchronous consequence is delayed
```

The degraded condition must be visible.

---

# Operational Dashboard

A useful MVP dashboard should show:

- pending Outbox count
- oldest pending age
- publication rate
- consumer success and failure rate
- open poison events
- stream-head failures
- Memory generation backlog
- unresolved reconciliation findings
- Worker status

---

# Correlation Search

Operators should be able to search by:

```text
eventId

correlationId

causationId

aggregateId

organizationId

consumerName
```

Search access must honor security policy.

---

# Event Timeline

An operational event timeline may display:

```text
Command accepted

Aggregate committed

Outbox event recorded

Event published

Consumer started

Consumer retried

Consumer completed

Follow-up event emitted
```

The timeline is a read model.

It does not become the source of truth.

---

# Testing Strategy

The event architecture requires tests at multiple layers:

```text
Event Contract Tests

Aggregate Event Tests

Outbox Transaction Tests

Publisher Integration Tests

Consumer Idempotency Tests

Ordering Tests

Retry Tests

Replay Tests

Security Tests

End-to-End Workflow Tests

Failure Injection Tests
```

---

# Event Contract Tests

Every event contract should test:

- event type
- schema version
- required fields
- optional fields
- serialization
- deserialization
- timestamp format
- identifier format
- actor rules
- Organization rules
- payload size
- privacy restrictions

---

# Golden Contract Tests

Stable serialized examples should be stored as golden fixtures.

Example:

```text
DecisionApproved v1 fixture
```

Tests verify that producer changes do not unintentionally break the contract.

---

# Backward Compatibility Tests

When a new schema version is introduced, test:

- current producer output
- supported old payloads
- upcasting behavior
- unknown optional fields
- unsupported breaking fields
- preserved correlation metadata
- preserved actor semantics

---

# Aggregate Event Tests

Aggregate unit tests should verify:

```text
Valid command
    -> expected event emitted
```

```text
Invalid command
    -> no event emitted
```

---

# Aggregate Event Ownership Tests

Verify that:

- Work emits only Work-owned events
- Decision emits only Decision-owned events
- Memory emits only Memory-owned events
- Membership emits only Membership-owned events
- Application Services do not fabricate Domain Events

---

# Authority Event Tests

Mandatory tests include:

```text
WorkCompleted requires HumanMember actor

DecisionApproved requires HumanMember actor

DecisionRejected requires HumanMember actor

MemoryApproved requires HumanMember actor

MemoryGenerated permits System actor

Secretary contribution requires Secretary or authorized Human actor
```

---

# Outbox Atomicity Tests

Integration tests must verify:

```text
Aggregate save succeeds
Outbox insert fails

↓

Entire transaction rolls back
```

and:

```text
Aggregate save fails

↓

No Outbox row exists
```

---

# Commit Visibility Tests

Verify that a publisher cannot see uncommitted Outbox rows.

After commit:

```text
row becomes eligible
```

After rollback:

```text
row never becomes eligible
```

---

# Outbox Uniqueness Tests

Verify:

- duplicate eventId rejected
- duplicate stream position rejected
- retry preserves eventId
- multiple destinations use explicit uniqueness model
- event sequence ordering is deterministic

---

# Publisher Claim Tests

Using real PostgreSQL concurrency, verify:

- two Workers do not claim the same row concurrently
- `SKIP LOCKED` permits parallel batches
- expired claims are recoverable
- stale Worker cannot overwrite new claim
- batch size remains bounded
- claim transaction remains short

---

# Publication Failure Tests

Inject:

- transient broker timeout
- permanent serialization error
- configuration failure
- Worker crash after publish
- Worker crash before marking Published
- database failure during publication-result update

Expected behavior must preserve at-least-once delivery.

---

# Duplicate Publication Tests

Simulate:

```text
Publish succeeds

Worker crashes before status update

Event published again
```

Each consumer must still produce one business effect.

---

# Ordering Tests

Required tests include:

- same Aggregate events publish in order
- different Aggregate streams publish concurrently
- failed stream head blocks later stream event
- repaired stream resumes correctly
- eventSequence preserves multiple-event order
- no global ordering assumption exists

---

# Schema Version Tests

Verify:

- supported version accepted
- unsupported version fails permanently
- upcaster preserves eventId
- upcaster preserves Organization
- upcaster preserves actor
- breaking semantic change uses new event type where required

---

# Consumer Idempotency Tests

For every consumer:

```text
Process same event twice

↓

One effect

Two successful deliveries
```

---

# Processed Event Atomicity Tests

Verify:

```text
Target Aggregate commits
Processed record fails

↓

Transaction rolls back
```

and:

```text
Processed record commits
Target Aggregate fails

↓

Transaction rolls back
```

---

# Business Idempotency Tests

Required examples:

- same Decision outcome with different eventIds
- duplicate WorkCompleted event
- duplicate invitation delivery event
- duplicate session invalidation
- duplicate projection update
- duplicate Memory generation trigger

---

# Consumer Concurrency Tests

Simulate:

- two Workers processing the same event
- target Aggregate changing during handler execution
- processing lease expiry
- stale Worker result update
- retry after ambiguous commit result

---

# Retry Classification Tests

Verify:

```text
TransientInfrastructure
    -> Retry
```

```text
PermanentContract
    -> Failed
```

```text
PermanentSecurity
    -> Failed and alert
```

```text
TransientConcurrency
    -> Reload and bounded retry
```

---

# Memory Generation Tests

Required tests include:

- WorkCompleted starts generation
- AI call occurs outside transaction
- generated candidate validates
- one active Memory per Work
- duplicate trigger produces no second Memory
- timeout retries
- generation failure does not roll back Work completion
- System cannot approve generated Memory

---

# Decision Outcome Tests

Required tests include:

- DecisionApproved records Approved outcome
- DecisionRejected records Rejected outcome
- DecisionWithdrawn records Withdrawn outcome
- Organization mismatch fails
- unrelated Decision fails
- duplicate outcome is no-op
- outcome handler never completes Work

---

# Poison Event Tests

Verify:

- malformed event becomes Failed
- permanent security event does not retry indefinitely
- poison record preserves metadata
- payload access is restricted
- replay after fix succeeds
- skip requires authorized Human action
- multi-consumer failure remains isolated

---

# Replay Tests

Required tests include:

- replay one failed consumer
- replay does not mutate original event
- replay preserves original Organization
- replay preserves actor attribution
- replay respects processed-event state
- projection rebuild does not mutate domain Aggregates
- unauthorized replay is denied
- replay audit is created

---

# Reconciliation Tests

Verify:

- missing Decision outcome detected
- completed Work without Memory attempt detected
- expired Outbox claim recovered
- published event without consumer record detected
- duplicate reconciliation does not duplicate recovery
- reconciliation invokes normal handler path
- reconciliation cannot complete Work or approve Memory

---

# Security Tests

Mandatory security tests include:

1. Client attempts direct Outbox insertion.
2. Secretary-originated DecisionApproved is rejected.
3. System-originated WorkCompleted is rejected.
4. Event Organization differs from target Aggregate.
5. Consumer handles unsupported event type.
6. Consumer receives unsupported schema version.
7. Replay requested by unauthorized Human.
8. Public request claims System consumer identity.
9. Event payload contains prohibited secret field.
10. Global event attempts untrusted Organization fan-out.

---

# Privacy Tests

Verify:

- event payloads exclude secrets
- dead letter tools redact Restricted fields
- logs do not contain full Memory content
- raw invitation tokens never enter events
- identity events minimize personal data
- event archives enforce access control
- metrics do not use personal identifiers as labels

---

# End-to-End Workflow Tests

## Decision to Work Flow

```text
Human approves Decision

↓

DecisionApproved persisted to Outbox

↓

Publisher delivers event

↓

Work handler records outcome

↓

WorkDecisionOutcomeRecorded persisted

↓

Human later completes Work
```

The test must verify that approval alone never completes Work.

---

## Work to Memory Flow

```text
Human completes Work

↓

WorkCompleted persisted

↓

Memory consumer starts generation

↓

Memory created in Generated state

↓

Human reviews and approves Memory
```

The test must verify that the System cannot approve Memory.

---

## Membership Revocation Flow

```text
Human revokes Membership

↓

MembershipRevoked persisted

↓

Session invalidation succeeds

↓

Assignment reconciliation creates finding

↓

No automatic reassignment occurs
```

---

# Disaster Recovery Tests

Test restoration of a consistent database snapshot containing:

- Aggregate state
- Outbox rows
- processed events
- failed events
- replay records

After restore:

- expired claims are recovered
- duplicate broker delivery is tolerated
- reconciliation identifies missing effects
- no event is silently lost

---

# Property-Based Tests

Recommended properties:

```text
For every committed Aggregate event:
    matching Outbox row exists
```

```text
For every uncommitted transaction:
    no publishable event exists
```

```text
For every duplicate consumer delivery:
    business effect count <= 1
```

```text
For every Organization mismatch:
    target mutation count = 0
```

```text
For every authoritative event:
    actorType = HumanMember
```

---

# Implementation Guidance

The event architecture should remain modular.

Recommended structure:

```text
events/

    contracts/
        EventEnvelope
        EventRegistry
        SchemaVersion
        EventSerializer

    application/
        EventMetadataFactory
        EventContractMapper
        ConsumerRegistry

    infrastructure/
        PostgreSqlOutboxWriter
        OutboxPublisher
        OutboxRepository
        ProcessedEventRepository
        DeadLetterRepository
        ReplayRepository
        ReconciliationRepository

    workers/
        OutboxPublicationWorker
        EventDispatchWorker
        ClaimRecoveryWorker
        ReconciliationWorker
```

---

# Module-Owned Events

Each domain module should own its event definitions.

Example:

```text
work/
    events/
        WorkCreated
        WorkCompleted
        WorkCancelled

decision/
    events/
        DecisionSubmitted
        DecisionApproved
        DecisionRejected

memory/
    events/
        MemoryGenerated
        MemoryApproved
```

---

# Shared Envelope

The envelope is shared infrastructure.

The business payload remains module-owned.

---

# Event Registry

The Event Registry should map:

```text
eventType

schemaVersion

payloadType

sourceAggregate

actorPolicy

OrganizationPolicy

privacyClassification

serializer

upcaster
```

---

# Startup Contract Validation

Application startup should fail when:

- registered event has no serializer
- consumer supports no valid schema version
- duplicate event registration exists
- source Aggregate mapping is missing
- authority-sensitive event has no actor policy
- consumer capability is missing
- unknown destination is configured

---

# Event Serializer

The serializer must:

- use explicit contract types
- reject unknown required structures
- preserve timestamps
- preserve identifiers
- avoid serializing ORM entities
- enforce payload-size limits
- apply privacy validation

---

# Clock Abstraction

Use an injected clock for:

- occurredAt
- recordedAt
- retry timing
- lease expiry
- alert thresholds
- tests

Database time may be used for claim coordination.

---

# Identifier Generation

Use collision-resistant identifiers for:

```text
eventId

outboxId

replayId

findingId
```

UUIDs or equivalent identifiers are acceptable.

---

# Transaction Manager

The Outbox Writer must participate in the current Application Service transaction.

It must not open an independent transaction.

---

# Repository Responsibilities

## Outbox Repository

Responsible for:

- insert immutable event record
- claim eligible records
- update publication metadata
- recover expired claims
- query operational backlog

It does not interpret business meaning.

---

## Processed Event Repository

Responsible for:

- consumer-event uniqueness
- processing lease
- attempt metadata
- completion state
- result reference
- failure state

It does not mutate target Aggregates.

---

## Dead Letter Repository

Responsible for:

- durable failed-event metadata
- investigation status
- operator assignment
- resolution tracking
- replay linkage

---

# Dispatcher

The dispatcher maps one validated event to registered consumers.

It should:

- isolate consumer failures
- preserve event metadata
- create System execution context
- invoke each consumer independently
- record processing result

---

# In-Process Dispatch

For the MVP, the dispatcher may run in-process.

It must still preserve:

- asynchronous execution
- consumer-level idempotency
- independent retry
- durable failure state
- no direct Aggregate mutation

---

# Worker Separation

Recommended logical Workers:

```text
outbox-publisher

domain-coordination-worker

memory-generation-worker

notification-worker

projection-worker

reconciliation-worker
```

These may share one deployable codebase.

---

# Memory Worker Isolation

Memory generation should use separate concurrency controls because it may be:

- slow
- expensive
- rate-limited
- dependent on external AI services

It should not block lightweight Decision outcome processing.

---

# Configuration

Recommended configuration:

```text
OutboxPollInterval

OutboxBatchSize

OutboxClaimLease

ConsumerClaimLease

MaximumPublicationAttempts

MaximumConsumerAttempts

RetryBackoff

MaximumRetryDelay

PayloadSizeLimit

MemoryGenerationConcurrency

NotificationConcurrency

PublishedRetentionPeriod

ProcessedEventRetentionPeriod

DeadLetterAlertThreshold
```

---

# Configuration Safety

Configuration must not:

- disable idempotency
- bypass Organization validation
- allow non-Human authoritative events
- permit unlimited retries
- silently skip failed stream heads
- delete Failed events automatically
- expand System capability

---

# Database Permissions

Recommended separation:

```text
Application Role
    Aggregate write
    Outbox insert

Publisher Role
    Outbox read
    publication metadata update

Consumer Role
    Processed-event write
    scoped target-module access

Operations Role
    read failures
    request replay
    no arbitrary payload mutation
```

---

# Migration Guidance

Schema migrations must preserve:

- eventId uniqueness
- immutable payloads
- stream positions
- pending publication eligibility
- processing status
- replay history
- correlation metadata

---

# Contract Migration

When deploying a new event version:

1. deploy consumers that understand old and new versions
2. deploy producer emitting new version
3. observe processing
4. retire old producer path
5. retain old consumer support for replay period
6. deprecate old version explicitly

---

# Consumer Deployment Order

For breaking changes:

```text
Consumer first

Producer second
```

A producer must not emit a version that no deployed consumer supports.

---

# Rolling Deployment

During rolling deployment:

- multiple consumer versions may coexist
- processed-event uniqueness remains stable
- handlerVersion is recorded
- event contracts remain backward compatible
- claims prevent duplicate concurrent effects

---

# Operational Runbooks

The MVP should include runbooks for:

```text
Outbox backlog

Expired claims

Failed stream head

Unsupported schema version

Poison consumer event

Memory generation outage

Replay request

Organization mismatch event

Post-restore reconciliation
```

---

# Runbook: Outbox Backlog

Recommended actions:

1. verify database health
2. verify publisher Worker health
3. inspect oldest pending event
4. inspect claim expiry
5. classify publication failures
6. restore dependency
7. observe backlog drain
8. run reconciliation if required

---

# Runbook: Failed Stream Head

Recommended actions:

1. identify Aggregate stream
2. inspect failed event contract
3. determine whether repair is possible
4. deploy fix or correct configuration
5. replay failed event
6. verify later events resume
7. reconcile affected workflow
8. document resolution

---

# Runbook: Poison Consumer Event

Recommended actions:

1. identify consumer and event
2. validate Organization and actor
3. inspect redacted payload
4. classify contract, security, domain, or code failure
5. repair underlying issue
6. run ValidateOnly replay
7. execute controlled replay
8. confirm processed result
9. close dead letter record

---

# Runbook: Memory Generation Outage

Recommended actions:

1. confirm Work completion continues
2. pause or reduce generation concurrency
3. inspect external AI dependency
4. retain pending generation events
5. restore dependency
6. resume bounded retries
7. reconcile Completed Work without Memory
8. confirm no duplicate active Memories

---

# Runbook: Organization Mismatch

Recommended actions:

1. stop processing the affected event
2. preserve evidence
3. raise security alert
4. inspect source event creation
5. inspect target association
6. verify no cross-Organization mutation occurred
7. correct data through controlled process
8. replay only after approval

---

# Deployment Topology

Recommended MVP topology:

```text
AIOS Modular Monolith

├── HTTP Application
├── PostgreSQL
├── Outbox Publication Worker
├── Domain Coordination Worker
├── Memory Generation Worker
├── Projection Worker
└── Reconciliation Worker
```

Workers may run as separate process roles from one codebase.

---

# External Broker Migration

A future broker may be introduced between publisher and consumers.

Migration path:

```text
PostgreSQL Outbox

↓

Broker Publisher

↓

External Broker

↓

Consumer Workers
```

The following remain unchanged:

- Aggregate event ownership
- Outbox atomicity
- event contracts
- Human authority rules
- consumer idempotency
- Organization isolation

---

# Broker Does Not Replace Outbox

An external broker does not solve the database dual-write problem by itself.

The Transactional Outbox remains required unless another atomic mechanism is explicitly designed.

---

# Event Sourcing Exclusion

AIOS MVP is not event-sourced.

The implementation must not assume:

- full Aggregate reconstruction from events
- unlimited permanent event availability
- compensating every state transition through event replay
- event-store-specific concurrency

PostgreSQL Aggregate tables remain the current state store.

---

# MVP Exclusions

The following capabilities are outside the MVP:

- event sourcing
- globally ordered event log
- distributed transaction coordinator
- exactly-once end-to-end delivery
- multi-region active-active event replication
- public event subscriptions
- customer-defined consumers
- external webhooks
- dynamic event routing
- cross-Organization events
- event choreography across independent services
- Saga framework
- workflow engine
- user-authored retry policies
- automatic poison-event skipping
- automatic authoritative replay
- cryptographic signing of internal local events
- permanent Outbox retention as legal archive
- streaming analytics platform
- Knowledge promotion events
- Evidence lifecycle events
- Capability marketplace events
- AI Employee autonomous authority events

These require separate future architecture.

---

# Future Extension Principles

Future event architecture must preserve:

1. Aggregate-owned Domain Events.
2. atomic domain and Outbox persistence.
3. explicit contract versioning.
4. Organization isolation.
5. Human authority boundaries.
6. Secretary advisory boundaries.
7. narrow System capabilities.
8. at-least-once delivery assumptions.
9. consumer idempotency.
10. recoverable failure.
11. immutable original events.
12. auditable replay.

---

# Public Integration Events Future Phase

Future public Integration Events will require:

- external contract governance
- tenant subscription model
- destination authentication
- delivery signatures
- endpoint verification
- rate limiting
- customer-visible delivery history
- privacy filtering
- deprecation policy

Internal Domain Events must not automatically become public contracts.

---

# Marketplace Event Future Phase

Marketplace events may require:

- producer and consumer ownership
- commercial entitlement
- capability permissions
- data classification
- Organization consent
- billing correlation
- abuse controls

These concerns are outside the MVP.

---

# AI Employee Event Future Phase

AI Employee events must distinguish:

- proposed action
- authorized action
- executed operational action
- Human approval checkpoint
- revoked capability
- budget or scope exhaustion

They must not reuse the Secretary event model to imply Human authority.

---

# Implementation Checklist

Before implementation is considered complete, verify:

- every Domain Event has one owning Aggregate
- every event type is registered
- every event schema is versioned
- authority-sensitive events require Human actors
- Aggregate state and Outbox commit atomically
- eventId uniqueness is enforced
- payload size is bounded
- secrets are prohibited
- Outbox claims expire safely
- multiple Workers cannot corrupt publication state
- per-Aggregate ordering is preserved where required
- consumers have stable names
- processed-event uniqueness is enforced
- consumer effects and deduplication commit atomically
- duplicate logical facts are protected by domain invariants
- retries are bounded and classified
- poison events remain durable
- replay is authorized and audited
- reconciliation uses normal Application Service paths
- Organization mismatch fails permanently
- logs and metrics avoid sensitive payloads
- disaster recovery preserves event state
- no event causes unauthorized Work completion
- no System or Secretary event represents Human approval

---

# Design Summary

The AIOS event architecture combines:

```text
Aggregate-Owned Domain Events

Explicit Integration Contracts

PostgreSQL Transactional Outbox

At-Least-Once Publication

Idempotent Consumers

Per-Aggregate Ordering

Bounded Retry

Dead Letter Recovery

Controlled Replay

Operational Reconciliation
```

The source Aggregate owns the business fact.

The Application Layer persists the fact reliably.

The Outbox publisher delivers it asynchronously.

Consumers apply independent, idempotent consequences.

---

# Delivery Guarantees

The MVP provides:

```text
Domain State Persistence:
    Atomic

Outbox Persistence:
    Atomic with Domain State

Publication:
    At Least Once

Consumer Delivery:
    At Least Once

Consumer Business Effect:
    Effectively Once through Idempotency

Cross-Aggregate Consistency:
    Eventual

Per-Aggregate Ordering:
    Preserved where required

Global Ordering:
    Not Provided
```

---

# Core Guarantees

The architecture guarantees:

- no committed domain change without a durable event record
- no published event for a rolled-back domain change
- duplicate delivery does not require duplicate business effect
- failed processing remains visible and recoverable
- event contracts evolve explicitly
- Aggregate boundaries remain independent
- Organization scope remains intact
- Human authority cannot be created by automation
- Work completion remains explicit Human action
- Memory generation remains asynchronous
- approved Memory remains distinct from Knowledge

---

# Architect Review

## Event Ownership

**Rating: ★★★★★**

Domain Events are clearly owned by their source Aggregates.

Application Services and Workers cannot fabricate authoritative domain facts.

---

## Transactional Reliability

**Rating: ★★★★★**

Aggregate state, Aggregate version, Outbox messages, and idempotency metadata commit atomically in PostgreSQL.

The dual-write problem is resolved without distributed transactions.

---

## Delivery Semantics

**Rating: ★★★★★**

The design accurately uses at-least-once delivery and does not make an unsupported exactly-once claim.

Effectively-once business outcomes are achieved through consumer and domain idempotency.

---

## Aggregate Independence

**Rating: ★★★★★**

Cross-Aggregate workflows occur through events and Application Services.

Aggregates do not invoke one another directly.

---

## Ordering

**Rating: ★★★★★**

Ordering is correctly limited to Aggregate streams.

The design avoids unnecessary global serialization while protecting stream-head ordering.

---

## Event Evolution

**Rating: ★★★★★**

Explicit schema versions, contract ownership, compatibility rules, and upcasting provide a safe evolution path.

---

## Security

**Rating: ★★★★★**

Organization validation, actor policies, capability whitelisting, causation validation, and restricted replay prevent events from expanding authority.

---

## Human Authority

**Rating: ★★★★★**

Decision approval never completes Work.

System and Secretary actors cannot originate Human-authoritative lifecycle events.

Memory approval remains Human-controlled.

---

## Failure Recovery

**Rating: ★★★★★**

Bounded retry, dead letter handling, replay, claim recovery, and reconciliation provide complete operational recovery paths.

---

## Observability

**Rating: ★★★★★**

The architecture defines structured logging, metrics, backlog-age monitoring, correlation tracing, alerting, and operational runbooks.

---

## Testability

**Rating: ★★★★★**

Contract, transaction, concurrency, idempotency, ordering, retry, replay, security, privacy, and disaster-recovery tests are explicitly covered.

---

## MVP Scope Discipline

**Rating: ★★★★★**

The design avoids premature event sourcing, Sagas, public subscriptions, global ordering, and external broker dependency.

Future migration paths remain clear.

---

## Final Assessment

```text
Architecture Quality:          ★★★★★
Transactional Reliability:     ★★★★★
Delivery Correctness:          ★★★★★
Consumer Idempotency:          ★★★★★
Aggregate Independence:        ★★★★★
Security and Authority:        ★★★★★
Operational Recoverability:    ★★★★★
Observability:                 ★★★★★
Implementation Readiness:      ★★★★★
MVP Scope Discipline:          ★★★★★
```

The Events and Transactional Outbox architecture is ready for implementation within the AIOS Modular Monolith.

It is fully aligned with:

- Work Aggregate
- Decision Aggregate
- Memory Aggregate
- Identity and Organization
- Authorization
- Application Services
- PostgreSQL
- Background Workers
- Human authority
- Secretary advisory boundaries
- System operational boundaries
- eventual cross-Aggregate consistency
- asynchronous Memory generation

**Architect Review Result: APPROVED**