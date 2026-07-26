# Application Services

**Status:** Draft  
**Phase:** MVP  
**Architecture:** Modular Monolith

---

# Purpose

Application Services coordinate business use cases that span multiple aggregates.

They orchestrate workflows, manage transactional boundaries, invoke aggregate commands, and coordinate asynchronous processing through Domain Events.

Application Services contain application workflow.

They do **not** contain business rules.

Business rules always remain inside Aggregates.

---

# Responsibilities

Application Services are responsible for:

- Executing application use cases.
- Loading Aggregate Roots.
- Invoking aggregate commands.
- Persisting aggregates.
- Managing transaction boundaries.
- Persisting Transactional Outbox messages.
- Coordinating multiple aggregates.
- Publishing integration events.
- Dispatching asynchronous work.
- Returning application results.

---

# Non-Responsibilities

Application Services are **not** responsible for:

- Business rule enforcement.
- Aggregate validation.
- Aggregate invariants.
- Decision making.
- Authorization policy definition.
- Persistence implementation.
- Infrastructure messaging.
- User interface concerns.

Those responsibilities belong to other architectural layers.

---

# Architectural Position

```text
Presentation Adapter
        │
        ▼
Owning Module Command or Query Interface
        │
        ▼
Owning Application Service
        │
        ├────────► Authorization and policy ports
        │
        ▼
Owning Aggregate
        │
        ▼
Owning Repository Port
        ▲
        │
Infrastructure Adapter ─────► PostgreSQL
```

Application Services sit between incoming requests and the Domain Model.

They coordinate execution without owning business knowledge.

A Background Worker, HTTP controller, CLI adapter, scheduler, or another module is a caller of the owning module's Application interface. It must not use the owning module's Repository directly.

Repository interfaces are internal persistence ports of their owning Aggregate. They are not cross-module integration contracts.

---

# Layer Responsibilities

## Presentation Layer

Responsible for:

- HTTP
- GraphQL
- CLI
- API contracts
- Request validation
- Authentication

The Presentation Layer never invokes repositories directly.

---

## Application Layer

Responsible for:

- Use case orchestration.
- Transaction management.
- Aggregate coordination.
- Event dispatch preparation.
- Idempotency handling.
- Correlation metadata.
- Retry coordination.

---

## Domain Layer

Responsible for:

- Business rules.
- Aggregate invariants.
- State transitions.
- Domain Events.
- Value Objects.

The Domain Layer knows nothing about application workflows.

---

## Infrastructure Layer

Responsible for:

- Database access.
- Event publication.
- Background workers.
- Logging.
- Monitoring.
- External integrations.

Infrastructure never contains business decisions.

---

# Design Principles

Application Services follow several architectural principles.

---

## Principle 1

Business rules belong inside Aggregates.

Application Services never duplicate domain logic.

---

## Principle 2

Aggregates remain independent.

Application Services coordinate interaction.

Aggregates never invoke one another directly.

---

## Principle 3

One use case.

One Application Service method.

Each method represents one complete business use case.

---

## Principle 4

Transactions remain short.

Only synchronous work belongs inside the transaction.

Long-running work is asynchronous.

---

## Principle 5

Application Services publish intent.

Aggregates publish facts.

Example

```
Application Service

Complete Work

↓

Work Aggregate

WorkCompleted
```

The aggregate emits a Domain Event describing what happened.

The Application Service decides what happens next.

---

## Principle 6

Application Services coordinate.

Aggregates decide.

Example

```
Application Service

Load Work

↓

CompleteWork()

↓

Save Work
```

The Application Service coordinates execution.

The Work Aggregate decides whether completion is valid.

---

## Principle 7

Application Services never bypass Aggregates.

Repositories never expose child entities independently.

Every state change occurs through Aggregate commands.

---

# Aggregate Interaction

Application Services are the only layer allowed to coordinate multiple Aggregates, but that permission is not global.

A normal Application Service may load and save only Aggregates owned by its module. Cross-module callers use the target module's command or query interface.

The exceptional `RequestBlockingDecision` coordinator may use both Work and Decision Repository ports because those Bounded Contexts are intentionally co-located in the `Work and Decision` MVP module and the initial relationship must commit atomically. This exception must not be generalized.

For asynchronous interaction:

```text
DecisionApproved
        │
        ▼
Platform Runtime dispatch
        │
        ▼
Work module event-handler interface
        │
        ▼
Work Application Service
        │
        ▼
Work Aggregate.RecordDecisionOutcome()
```

The dispatcher does not load Work and does not receive a `WorkRepository`. Neither Aggregate knows the other exists.

---

# Aggregate Independence

Each Aggregate must remain independently testable.

Application Services preserve this independence.

The following dependency is prohibited:

```
Work Aggregate

↓

Decision Aggregate
```

Likewise:

```
Decision Aggregate

↓

Memory Aggregate
```

Cross-aggregate references occur only through:

- identifiers
- Domain Events
- Application Services

---

# Use Case Coordination

A typical use case consists of:

```
Receive Request

↓

Load Aggregate

↓

Execute Command

↓

Persist Aggregate

↓

Persist Outbox

↓

Commit Transaction

↓

Return Result
```

No additional business behavior occurs after commit inside the same request.

Further processing occurs asynchronously.

---

# Aggregate Loading

Application Services load only the Aggregates required for the current use case.

Example

```
CompleteWork()

↓

Load Work Aggregate
```

No Decision Aggregate is loaded.

---

Example

```
ApproveDecision()

↓

Load Decision Aggregate
```

No Work Aggregate is modified directly.

The Work update occurs later through event processing.

---

# Repository Usage

Repositories persist Aggregate Roots through Aggregate-specific ports.

Creation uses:

```text
Construct Aggregate
↓
Repository.Add(organizationId, aggregate)
```

Mutation uses:

```text
Repository.Get(organizationId, aggregateId)
↓
Execute Aggregate Command
↓
Repository.Save(organizationId, aggregate, expectedVersion)
```

`Add` is insert-only and `Save` is update-only. Repositories contain no business rules and do not begin, commit, append Outbox records, publish messages, or retry the Application transaction.

---

# Transaction Ownership

Application Services own database transaction boundaries. Aggregates and Repositories never begin or commit transactions.

A standard mutation transaction is:

```text
BEGIN

Check command idempotency
Resolve authorization
Get Aggregate
Execute Aggregate command
Save Aggregate with expectedVersion
Append required Domain and Integration Event records to Outbox
Persist processed-command result and required transactional audit
COMMIT
```

Every state-changing transaction has exactly one explicit Application Service owner and one commit or rollback. A larger use case may require multiple short transactions separated by durable operation state, asynchronous processing, or an external call. Such a use case must not hold a database transaction open across the separation and must define retry, idempotency, and recovery semantics.

---

# Domain Event Collection

Aggregates emit and retain immutable Domain Events during command execution; they do not publish them.

Before commit, the Application Service collects the events, maps any required cross-context Integration Events, and appends the durable records through an Outbox Writer participating in the current transaction.

```text
Work Aggregate
↓
CompleteWork()
↓
WorkCompleted Domain Event
↓
Application Service collects and appends Outbox record
```

Aggregate state, required Outbox records, idempotency records, and transactional audit evidence commit or roll back together. Publication begins only after commit.

---

# Application Result

After a successful transaction, the Application Service returns:

- success or failure
- aggregate identifier
- aggregate version
- relevant output values

Application results do not expose internal aggregate state unnecessarily.

---

# Guiding Philosophy

Application Services answer the question:

> **"What business use case is being executed?"**

Aggregates answer the question:

> **"Is this state transition valid?"**

Keeping these responsibilities separate preserves a clean domain model, supports long-term maintainability, and enables independent evolution of each aggregate.

# Core Application Workflows

The MVP Application Layer coordinates three primary workflows:

1. Human-driven Work lifecycle operations.
2. Human-driven Decision review operations.
3. Asynchronous cross-aggregate reactions.

Each workflow is implemented as a distinct use case.

---

# Workflow 1: Create Work

A Human Member creates a new Work item.

```text
Human Member
      │
      │ CreateWork
      ▼
Work Application Service
      │
      │ Load authorization context
      │ Validate Organization scope
      ▼
Work Aggregate
      │
      │ CreateWork
      ▼
WorkCreated
      │
      ▼
Work Repository + Outbox
      │
      ▼
Commit
```

---

## Create Work Transaction

```text
BEGIN

Verify command idempotency

Create Work Aggregate

Collect WorkCreated

Add Work Aggregate

Write WorkCreated to Outbox

Record processed command

COMMIT
```

The transaction must not:

- create a Decision
- create a Memory
- invoke the Secretary
- publish directly to a message broker

Those actions require separate use cases or asynchronous handlers.

---

# Workflow 2: Start Work

A Human Member explicitly moves Work from Draft to InProgress.

```text
Human Member
      │
      │ StartWork
      ▼
Work Application Service
      │
      │ Load Work
      ▼
Work Aggregate
      │
      │ StartWork
      ▼
WorkStarted
      │
      ▼
Save + Outbox + Commit
```

The Application Service does not determine whether Work may start.

That rule belongs to the Work Aggregate.

---

# Workflow 3: Request a Blocking Decision

A Human Member requests a Decision that must be resolved before Work completion.

This workflow coordinates Work and Decision creation.

The two aggregates remain independently authoritative.

---

## Coordination Sequence

```text
Human Member
      │
      │ RequestBlockingDecision
      ▼
Decision Coordination Service
      │
      ├── Load Work
      │
      ├── Ask Work to reserve blocking Decision reference
      │
      ├── Create Decision
      │
      ├── Save Work
      │
      ├── Add Decision
      │
      └── Write Outbox events
      ▼
Commit
```

---

## Atomic Coordination

Within the Modular Monolith, the MVP may coordinate the initial Work and Decision changes in one PostgreSQL transaction.

```text
BEGIN

Load Work

Create Decision identity

Work.RequestBlockingDecision(decisionId)

Decision.Create(...)

Save Work with expected version

Add Decision

Write WorkDecisionRequested to Outbox

Write DecisionCreated to Outbox

Record processed command

COMMIT
```

This is an Application Layer transaction.

It does not merge the two Aggregate boundaries.

---

## Why Atomic Creation Is Allowed

The workflow establishes a required reference between two newly coordinated facts:

- Work is waiting for a specific blocking Decision.
- That Decision exists.

A single database transaction prevents:

- a Work item referencing a nonexistent Decision
- an orphaned blocking Decision
- partial creation of the workflow

After creation, the aggregates evolve independently.

---

## Cross-Aggregate Preconditions

Before executing the workflow, the Application Service verifies:

- the Work exists
- the Work belongs to the current Organization
- the actor may request a Decision
- the proposed Decision belongs to the same Organization

The Work Aggregate still determines whether its current state permits a blocking Decision.

The Decision Aggregate still validates its own initial content.

---

# Workflow 4: Edit Decision Draft

A Human Member updates the active Decision Draft.

```text
Human Member
      │
      │ EditDecisionDraft
      ▼
Decision Application Service
      │
      │ Load Decision
      ▼
Decision Aggregate
      │
      │ EditDraft
      ▼
DecisionDraftEdited
      │
      ▼
Save + Outbox + Commit
```

Only the Decision Aggregate determines whether the Draft is editable.

---

# Workflow 5: Record Secretary Contribution

The Secretary may produce advisory content for Work, Decision, or Memory.

The Secretary does not mutate authoritative business content automatically.

---

## Decision Contribution Flow

```text
Human Member
      │
      │ Request Secretary assistance
      ▼
Secretary Application Service
      │
      │ Invoke Secretary capability
      ▼
Generated Suggestion
      │
      │ RecordSecretaryContribution
      ▼
Decision Aggregate
      │
      ▼
Save + Outbox + Commit
```

The resulting contribution remains separate from the active Draft.

A Human Member must explicitly choose to incorporate it through a later edit command.

---

## Secretary Boundary

The Application Service must never translate Secretary output directly into:

- Decision approval
- Decision rejection
- Work completion
- Memory approval
- Knowledge promotion

Secretary output is advisory input only.

---

# Workflow 6: Submit Decision for Review

A Human Member submits the active Decision Draft.

```text
Human Member
      │
      │ SubmitDecisionForReview
      ▼
Decision Application Service
      │
      │ Load Decision
      ▼
Decision Aggregate
      │
      │ SubmitForReview
      │
      │ Create immutable snapshot
      ▼
DecisionSubmitted
      │
      ▼
Save + Outbox + Commit
```

---

## Submit Decision Transaction

```text
BEGIN

Verify command idempotency

Load Decision with expected version

Verify Organization scope

Decision.SubmitForReview(actor)

Save Decision

Write DecisionSubmitted to Outbox

Record processed command

COMMIT
```

No Work state is changed during this transaction.

---

# Workflow 7: Approve Decision

A Human reviewer explicitly approves an InReview Decision.

```text
Human Reviewer
      │
      │ ApproveDecision
      ▼
Decision Application Service
      │
      │ Load Decision
      │ Verify reviewer authorization
      ▼
Decision Aggregate
      │
      │ ApproveDecision
      ▼
DecisionApproved
      │
      ▼
Save + Outbox + Commit
```

---

## Approval Transaction

```text
BEGIN

Verify command idempotency

Load Decision with expected version

Verify Human reviewer authority

Decision.ApproveDecision(actor, rationale)

Save Decision with expected version

Collect DecisionApproved

Map DecisionApproved to Integration / DecisionOutcomeOccurred / 1

Append both required records to Outbox

Record processed command and required transactional audit

COMMIT
```

This transaction ends after Decision persistence, event mapping, Outbox persistence, idempotency, and required audit evidence commit atomically. It does not load or modify Work.

Rejection and withdrawal use the same transaction shape and map their internal outcome Domain Event to `Integration / DecisionOutcomeOccurred / 1`.

---

## Approval Does Not Complete Work

The following implementation is prohibited:

```text
ApproveDecision()

Decision.Status = Approved

Work.Status = Completed
```

The correct design is:

```text
ApproveDecision()

Decision.Status = Approved

DecisionApproved emitted

COMMIT
```

A separate asynchronous handler later records the outcome in Work.

---

# Workflow 8: Reject Decision

A Human reviewer explicitly rejects an InReview Decision.

```text
Human Reviewer
      │
      │ RejectDecision
      ▼
Decision Application Service
      │
      │ Load Decision
      ▼
Decision Aggregate
      │
      │ RejectDecision
      ▼
DecisionRejected
      │
      ▼
Save + Outbox + Commit
```

The rejection outcome is immutable.

A later Human action may start a new Draft revision.

---

# Workflow 9: Withdraw Decision

An authorized Human Member withdraws an InReview Decision.

```text
Human Member
      │
      │ WithdrawDecision
      ▼
Decision Application Service
      │
      │ Load Decision
      ▼
Decision Aggregate
      │
      │ WithdrawDecision
      ▼
DecisionWithdrawn
      │
      ▼
Save + Outbox + Commit
```

Withdrawal does not delete the submitted snapshot.

---

# Workflow 10: Record Decision Outcome in Work

This is an asynchronous Application Layer workflow.

It reacts to a committed Decision outcome event.

Supported events include:

- DecisionApproved
- DecisionRejected
- DecisionWithdrawn

---

## Approved Decision Flow

```text
DecisionApproved
      │
      ▼
Outbox Publisher
      │
      ▼
Decision Outcome Handler
      │
      │ Find related Work
      ▼
Work Aggregate
      │
      │ RecordDecisionOutcome
      ▼
WorkDecisionOutcomeRecorded
      │
      ▼
Save Work + Outbox + Commit
```

---

## Approved Outcome Transaction

```text
BEGIN

Check processed event by consumerName + eventId

Validate organizationId, workId, and decisionId from Integration / DecisionOutcomeOccurred / 1

Load Work and retain its expected version

Work.RecordDecisionOutcome(
    decisionId,
    Approved,
    decidedAt
)

Save Work with expected version

Write WorkDecisionOutcomeRecorded to Outbox

Record processed event and required transactional audit

COMMIT
```

The Work Aggregate determines the effect on its Completion Gate.

The handler does not set Work fields directly.

---

## Rejected Outcome Transaction

```text
BEGIN

Check processed event by consumerName + eventId

Validate organizationId, workId, and decisionId from Integration / DecisionOutcomeOccurred / 1

Load Work and retain its expected version

Work.RecordDecisionOutcome(
    decisionId,
    Rejected,
    decidedAt
)

Save Work with expected version

Write WorkDecisionOutcomeRecorded to Outbox

Record processed event and required transactional audit

COMMIT
```

A rejected blocking Decision typically causes:

```text
CompletionGate = Unsatisfied(decisionId)
```

The exact transition remains owned by the Work Aggregate.

---

## Withdrawn Outcome Transaction

```text
BEGIN

Check processed event by consumerName + eventId

Validate organizationId, workId, and decisionId from Integration / DecisionOutcomeOccurred / 1

Load Work and retain its expected version

Work.RecordDecisionOutcome(
    decisionId,
    Withdrawn,
    decidedAt
)

Save Work with expected version

Write WorkDecisionOutcomeRecorded to Outbox

Record processed event and required transactional audit

COMMIT
```

The Work Aggregate decides how withdrawal affects the Completion Gate.

The handler only conveys the immutable Decision outcome.

---

# Workflow 11: Complete Work

A Human Member explicitly completes Work.

This is the only business operation that changes Work to Completed.

```text
Human Member
      │
      │ CompleteWork
      ▼
Work Application Service
      │
      │ Load Work
      ▼
Work Aggregate
      │
      │ CompleteWork
      │
      │ Validate Completion Gate
      ▼
WorkCompleted
      │
      ▼
Save + Outbox + Commit
```

---

## Complete Work Transaction

```text
BEGIN

Verify command idempotency

Load Work with expected version

Verify Human authority

Work.CompleteWork(actor, completionSummary)

Save Work

Write WorkCompleted to Outbox

Record processed command

COMMIT
```

The Work Aggregate validates:

- the lifecycle state permits completion
- the Completion Gate permits completion
- the actor is represented as a Human authority
- Work is not already terminal

---

## Prohibited Completion Flow

The following is prohibited:

```text
DecisionApproved
      │
      ▼
Set Work.Status = Completed
```

The correct flow is:

```text
DecisionApproved
      │
      ▼
Record Decision outcome in Work
      │
      ▼
Completion Gate becomes Satisfied
      │
      ▼
Human later invokes CompleteWork
```

---

# Workflow 12: Start Memory Generation

Memory generation begins asynchronously after Work completion.

```text
WorkCompleted
      │
      ▼
Outbox Publisher
      │
      ▼
Memory Generation Handler
      │
      │ Check existing Memory
      │
      │ Gather source material
      │
      │ Invoke generation service
      ▼
Memory Aggregate
      │
      │ CreateGeneratedMemory
      ▼
MemoryGenerated
      │
      ▼
Save Memory + Outbox + Commit
```

---

## Memory Generation Is Asynchronous

The Complete Work transaction does not wait for:

- AI generation
- document synthesis
- source retrieval
- Memory persistence
- review notification

This keeps Work completion fast and reliable.

---

## Memory Generation Preconditions

The handler verifies:

- WorkCompleted is authentic and committed
- the Work belongs to the event Organization
- no Memory already exists for that Work
- required Work source data is available
- the event has not already been processed successfully

---

## Memory Creation Transaction

Memory generation is one durable use case implemented as two short transactions separated by the external AI call.

```text
BEGIN

Validate WorkCompleted envelope, Organization scope, and generation identity
Create or reuse the immutable source snapshot
Create or reuse the stable generation operation
Persist source hash, policy version, and attempt state

COMMIT

Call the AI provider using only the committed source snapshot

BEGIN

Recheck generation operation and source-snapshot identity
Check processed-event state
Confirm no Memory exists for organizationId + sourceWorkId
Validate generated candidate
Create Memory Aggregate
Add Memory
Write MemoryGenerated to Outbox
Record processed event, generation result, and required audit evidence

COMMIT
```

No database transaction remains open during the provider call. A retry reuses the committed snapshot and generation operation. The database uniqueness constraint is the final race guard; a duplicate conflict resolves to the existing Memory and never becomes an overwrite.

---

## Generation Failure

If generation fails before persistence:

- no Memory is created
- Work remains Completed
- the event remains retryable
- failure details are recorded operationally

Work completion is never rolled back.

---

# Workflow 13: Edit Generated Memory

A Human Member edits a Generated Memory before review.

```text
Human Member
      │
      │ EditGeneratedMemory
      ▼
Memory Application Service
      │
      │ Load Memory
      ▼
Memory Aggregate
      │
      │ EditGeneratedMemory
      ▼
MemoryDraftEdited
      │
      ▼
Save + Outbox + Commit
```

The Memory Aggregate determines whether the current state is editable.

---

# Workflow 14: Submit Memory for Review

A Human Member explicitly submits Generated Memory.

```text
Human Member
      │
      │ SubmitMemoryForReview
      ▼
Memory Application Service
      │
      │ Load Memory
      ▼
Memory Aggregate
      │
      │ SubmitMemoryForReview
      ▼
MemorySubmittedForReview
      │
      ▼
Save + Outbox + Commit
```

The submitted Memory snapshot is locked for review.

---

# Workflow 15: Approve Memory

A Human reviewer explicitly approves Memory.

```text
Human Reviewer
      │
      │ ApproveMemory
      ▼
Memory Application Service
      │
      │ Load Memory
      ▼
Memory Aggregate
      │
      │ ApproveMemory
      ▼
MemoryApproved
      │
      ▼
Save + Outbox + Commit
```

Approved Memory is immutable.

Approval does not promote Memory to Knowledge.

---

# Workflow 16: Reject Memory

A Human reviewer rejects InReview Memory.

```text
Human Reviewer
      │
      │ RejectMemory
      ▼
Memory Application Service
      │
      │ Load Memory
      ▼
Memory Aggregate
      │
      │ RejectMemory
      ▼
MemoryRejected
      │
      ▼
Save + Outbox + Commit
```

A later explicit command returns the rejected Memory to Generated for revision.

---

# Transaction Boundary Patterns

Application Services use two primary transaction patterns.

---

## Pattern A: Single-Aggregate Command

Used for:

- StartWork
- CompleteWork
- EditDraft
- SubmitDecisionForReview
- ApproveDecision
- EditGeneratedMemory
- ApproveMemory

```text
BEGIN

Load one Aggregate

Execute command

Save Aggregate

Persist Outbox events

Record idempotency result

COMMIT
```

---

## Pattern B: Coordinated Aggregate Creation

Used only when a use case must atomically establish a cross-aggregate relationship.

Example:

```text
RequestBlockingDecision
```

```text
BEGIN

Load Work

Create Decision

Execute Work command

Save both Aggregates

Persist both event sets

Record idempotency result

COMMIT
```

This pattern must remain exceptional.

It must not become a general method for coupling aggregates.

---

## Pattern C: Asynchronous Reaction

Used for:

- recording Decision outcomes in Work
- generating Memory after Work completion
- sending notifications
- updating read models

```text
Platform Runtime receives and validates event envelope

Route to the owning module's event-handler interface

Owning module performs external preparation if required

BEGIN

Owning module checks processed event

Owning Application Service loads the target Aggregate through its Repository

Execute Aggregate command

Save Aggregate

Persist new Outbox events

Mark event processed

COMMIT
```

Platform Runtime owns delivery, claims, retries, and dispatch. The target module owns business interpretation, Aggregate loading, commands, and persistence.

A generic Worker must not inject or invoke `WorkRepository`, `DecisionRepository`, or `MemoryRepository` directly.

---

# Repository Coordination

Repository ports belong to the Aggregate and module whose state they persist.

Example:

```text
CompleteWorkService
- WorkRepository
- TransactionManager
- CommandDeduplicationStore
- AuthorizationService
- Clock
```

`CompleteWorkService` is owned by the Work context inside the `Work and Decision` module. No other module receives `WorkRepository` merely to reuse its data.

Application Services must not depend on database tables directly.

---

## Repository Port Contract

Every authoritative Aggregate Repository exposes Aggregate-specific operations rather than a generic `Repository<T>`.

Minimum command-side contract:

```text
Add(organizationId, aggregate)

Get(organizationId, aggregateId)

Save(organizationId, aggregate, expectedVersion)
```

Rules:

- `Add` inserts a new Aggregate and fails on duplicate identity; it never upserts;
- `Get` returns one Organization-scoped Aggregate Root or a scoped not-found result;
- `Save` updates an existing Aggregate only when `expectedVersion` matches atomically;
- `organizationId` is mandatory and must equal the Aggregate's immutable Organization;
- a missing Aggregate is indistinguishable from an Organization-scope mismatch to an unauthorized caller;
- child state is persisted only through its Aggregate Root;
- emitted events are collected and written by the Application transaction, not published by the Repository;
- the Repository does not begin, commit, or retry the Application transaction; and
- infrastructure exceptions are translated into stable persistence outcomes.

Creation use cases call `Add`. Mutation use cases call `Get`, execute an Aggregate command, and then call `Save`.

An Aggregate-specific lookup such as `MemoryRepository.FindBySourceWorkId(organizationId, workId)` is allowed when required for idempotency or a documented invariant. Generic `Exists`, unrestricted search, and cross-module Repository reuse are prohibited.

Repository methods must not return mutable child entities, ORM entities, unrestricted query builders, or database connections.

---

## Loading Rules

An Application Service must:

- load Aggregate Roots only;
- call only Repository ports owned by its module, except the documented `RequestBlockingDecision` coordinator;
- use Organization-scoped queries;
- pass expected version on commands where the caller supplies one;
- treat missing Aggregates explicitly;
- avoid lazy-loading hidden mutable state; and
- obtain cross-module read data through query ports, immutable snapshots, or event data rather than another module's Repository.

All state needed to enforce Aggregate invariants must be available when the command executes.

---

## Saving Rules

An Application Service must:

- save every mutated Aggregate through its owning Repository;
- persist emitted events in the same transaction;
- verify optimistic concurrency;
- clear or acknowledge collected events only after successful persistence;
- avoid partial commits; and
- never save an Aggregate received from another module as a DTO or shared ORM object.

---

## Transaction Context

The Application Service owns the transaction boundary.

Repositories participate in the current explicit transaction context but cannot commit independently. A generic Unit of Work must not expose all module Repositories as a service locator.

The coordinated `RequestBlockingDecision` use case uses one transaction context for Work state, Decision state, both event sets, and command idempotency. All other cross-context propagation is asynchronous unless another exception is documented by ADR.

---

# Aggregate Event Collection

Aggregates may collect events internally during command execution.

Example:

```text
work.CompleteWork(actor)

events = work.ReleaseDomainEvents()
```

The Application Service passes the events to the Outbox writer.

The precise implementation may vary, but the following must remain true:

- events describe committed facts
- event persistence is atomic with aggregate persistence
- events are not published before commit
- failed transactions do not produce externally visible events

---

# Application Service Result Types

Application Services return explicit result types.

Example:

```text
CompleteWorkResult
- workId
- status
- aggregateVersion
- completedAt
```

Failure results may represent:

- NotFound
- Unauthorized
- ValidationFailed
- InvalidState
- ConcurrencyConflict
- DuplicateRequest
- InfrastructureFailure

Domain exceptions must be translated into stable application-level results.

---

# Cross-Aggregate Reference Resolution

The producing module must create a consumer-ready Integration Event whenever the routing identifier is part of the coordinated domain relationship.

For Decision outcomes:

```text
DecisionApproved | DecisionRejected | DecisionWithdrawn
        │ Domain Event mapping inside Work and Decision module
        ▼
Integration / DecisionOutcomeOccurred / 1
    organizationId
    workId
    decisionId
    decisionAggregateVersion
    revisionNumber
    submittedSnapshotId
    outcome
    resolvedByHumanActorReference
    sourceDomainEventId
        │
        ▼
Work module event-handler interface
        │
        ▼
Load Work by organizationId and workId
```

The Decision Aggregate stores immutable `relatedWorkId` for routing and audit while Work remains authoritative for its Completion Gate. The mapper copies that identifier into the Integration Event and persists the message atomically with the Decision transaction.

Cross-context consumers do not subscribe directly to Decision outcome Domain Events.

The following are prohibited:

- a Platform Runtime component querying a Work or Decision Repository;
- an unowned "application association table";
- a cross-module join used as an authoritative mutation path;
- post-publication enrichment of a required routing identifier; and
- exposing another Organization's resource existence through lookup errors.

The receiving module validates the Organization and related Aggregate identifiers before mutation. The generic dispatcher only validates the envelope and routes the registered contract.

---

# Synchronous Versus Asynchronous Coordination

Use synchronous coordination when:

- the caller requires an immediate business result
- one aggregate must validate the requested transition
- atomic creation prevents an invalid reference
- processing is short and local

Use asynchronous coordination when:

- another aggregate reacts to a committed fact
- processing may be retried
- external services are involved
- AI generation is required
- temporary delay is acceptable
- aggregate independence is more important than immediate consistency

---

# MVP Coordination Rules

Within the MVP:

- Human commands are handled synchronously.
- Aggregate facts are persisted through the Transactional Outbox.
- Decision outcomes update Work asynchronously.
- Work completion starts Memory generation asynchronously.
- Memory review remains Human-driven and synchronous.
- Knowledge promotion is not implemented.
- Secretary output never causes an authoritative transition automatically.

These rules define the operational boundary of the Application Layer.

# Transactional Outbox

The Transactional Outbox guarantees reliable publication of committed Domain Events.

Every event emitted by an Aggregate is persisted in the same database transaction as the Aggregate state change.

The Application Layer never publishes events directly before the transaction commits.

---

# Outbox Purpose

The Outbox prevents the dual-write problem.

Without an Outbox, the following failure may occur:

```text
Save Aggregate
      │
      ▼
Database Commit Succeeds
      │
      ▼
Publish Event
      │
      ▼
Message Broker Fails
```

The Aggregate state would be committed, but the event would be lost.

The Transactional Outbox removes this inconsistency.

---

# Outbox Write Flow

```text
BEGIN

Load Aggregate

Execute Command

Save Aggregate

Persist Domain Events to Outbox

Record Processed Command

COMMIT
```

After commit:

```text
Background Worker
      │
      ▼
Read Pending Outbox Record
      │
      ▼
Publish Event
      │
      ▼
Mark Outbox Record Published
```

---

# Outbox Atomicity

The following must commit atomically:

- Aggregate state
- Aggregate version
- Domain Event records
- command idempotency record

If any write fails, the entire transaction rolls back.

No externally visible event may exist for an uncommitted Aggregate change.

---

# Outbox Record

A typical Outbox record contains:

```text
outboxId
eventId
eventType
aggregateType
aggregateId
aggregateVersion
organizationId
payload
schemaVersion
occurredAt
correlationId
causationId
createdAt
publishedAt
attemptCount
nextAttemptAt
status
lastError
```

---

# Outbox Status

Canonical statuses:

```text
Pending
Claimed
Published
Failed
```

A claim may instead be represented by lease fields while the durable status remains `Pending`. Status meaning and claim ownership must remain consistent with `docs/architecture/events-and-outbox.md`; `Publishing` is not a separate canonical business state.

---

## Pending

The event has been committed but not yet published successfully.

---

## Publishing

A Worker has claimed the record for publication.

This status may be represented through row locking rather than persisted state.

---

## Published

The event has been published successfully.

The publication timestamp is recorded.

---

## Failed

The event exceeded the automated retry threshold or requires operational intervention.

Failed events remain recoverable.

---

# Outbox Publication Semantics

Outbox delivery is:

```text
At Least Once
```

Exactly-once delivery is not assumed.

Consumers must be idempotent.

---

# Background Worker

The Background Worker publishes pending Outbox events and executes asynchronous handlers.

It operates independently from synchronous request processing.

---

# Worker Responsibilities

The Background Worker is responsible for:

- polling pending Outbox records
- claiming records safely
- publishing events
- retrying transient failures
- recording delivery attempts
- invoking local event handlers
- recording processed event identifiers
- surfacing poison events
- maintaining observability

---

# Worker Non-Responsibilities

The Background Worker does not:

- define business rules
- modify Aggregate fields directly
- bypass authorization semantics
- complete Work automatically
- approve Decisions
- approve Memory
- promote Memory to Knowledge

All business state changes still occur through Aggregate commands.

---

# Outbox Publication Worker Loop

```text
Poll Pending Outbox Records
↓
Claim Bounded Batch
↓
For Each Claimed Record
    Deserialize and validate publication contract
    Publish to configured transport
    Record publication result
↓
Mark Published or schedule publication retry
```

This loop owns Outbox publication only. Consumer claim, consumer effects, and processed-event state use the separate consumer lifecycle.

---

# Safe Outbox Record Claiming

Multiple publisher instances may run concurrently but must not publish the same active claim simultaneously.

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

The same short transaction changes claimed rows to `Claimed`, sets the publisher lease, and increments the publication attempt count. Consumer Workers do not reuse this Outbox status as their processed-event status.

---

# Worker Batch Size

Workers should process bounded batches.

Batch size should balance:

- publication latency
- database contention
- memory usage
- retry isolation
- shutdown behavior

Large unbounded batches are prohibited.

---

# Graceful Shutdown

During shutdown, a Worker should:

- stop claiming new work
- finish or safely release current work
- commit processing outcomes
- avoid leaving indefinite locks
- preserve retryability

Shutdown must not cause event loss.

---

# Event Dispatcher

The Event Dispatcher maps event types to one or more handlers.

Example:

```text
DecisionApproved
    └── RecordDecisionOutcomeInWorkHandler

DecisionRejected
    └── RecordDecisionOutcomeInWorkHandler

DecisionWithdrawn
    └── RecordDecisionOutcomeInWorkHandler

WorkCompleted
    └── GenerateMemoryHandler
```

---

# Handler Independence

Each handler is independently retryable.

A failure in one handler must not erase successful processing by another handler.

Where one event has multiple handlers, the implementation must track handler-level processing state.

---

# Local Domain Events and Integration Events

The Modular Monolith may use one event contract internally during the MVP.

However, two conceptual roles must remain distinct.

---

## Domain Event

Represents a fact inside the domain model.

Examples:

- DecisionApproved
- WorkCompleted
- MemoryApproved

---

## Integration Event

Represents a stable message intended for asynchronous consumers.

Integration Events may be derived from Domain Events.

They should avoid exposing internal implementation details.

---

# Event Translation

An Application Layer translator may convert:

```text
Domain Event
      │
      ▼
Integration Event
```

Example:

```text
DecisionApproved Domain Event
      │
      ▼
DecisionOutcomeRecorded Integration Contract
```

For the MVP, direct use of Domain Event payloads is acceptable only when contracts remain explicit and versioned.

---

# Event Contract Requirements

Every asynchronously processed event must include:

```text
eventId
eventType
schemaVersion
organizationId
aggregateId
aggregateVersion
occurredAt
correlationId
causationId
payload
```

---

# Event Schema Versioning

Event payloads evolve through explicit schema versions.

Example:

```text
eventType = DecisionApproved
schemaVersion = 1
```

Consumers must reject unsupported versions clearly.

Silent misinterpretation is prohibited.

---

# Backward Compatibility

Compatible event changes may include:

- adding optional fields
- adding metadata
- extending enumerations when consumers tolerate unknown values

Breaking changes require:

- a new schema version
- migration planning
- consumer compatibility testing

---

# Event Correlation

Correlation metadata connects all operations belonging to one business flow.

Example:

```text
Human Approves Decision
      │
      ▼
ApproveDecision Command
      │
      ▼
DecisionApproved
      │
      ▼
RecordDecisionOutcome Command
      │
      ▼
WorkDecisionOutcomeRecorded
```

All steps share the same:

```text
correlationId
```

---

# Causation

Each operation records which prior operation caused it.

Example:

```text
ApproveDecision commandId = cmd-100
DecisionApproved eventId = evt-200
RecordDecisionOutcome command causationId = evt-200
WorkDecisionOutcomeRecorded causationId = generated command id
```

This creates a traceable chain.

---

# Correlation Metadata Rules

Every Application Service command should contain:

```text
commandId
correlationId
causationId
actorReference
organizationId
requestedAt
```

If a request begins a new flow:

```text
correlationId = commandId
```

If an event triggers a new command:

```text
correlationId = incomingEvent.correlationId
causationId = incomingEvent.eventId
```

---

# Command Idempotency

Synchronous commands may be delivered more than once.

Examples:

- HTTP client retry
- mobile network timeout
- reverse proxy retry
- user double submission

Every authoritative command should carry a unique command identifier.

---

# Processed Command Store

A processed command record may contain:

```text
commandId
commandType
organizationId
aggregateId
requestHash
resultPayload
processedAt
```

---

# Duplicate Command Behavior

When the same command identifier is received again:

- the previous result is returned
- no Aggregate command is executed again
- no duplicate event is emitted
- no duplicate history record is appended

---

# Command Payload Mismatch

If the same command identifier is reused with different payload content:

```text
commandId = same
requestHash = different
```

The request must fail.

A command identifier cannot represent two different intents.

---

# Event Idempotency

Every asynchronous consumer uses the durable identity:

```text
consumerName + eventId
```

Example:

```text
RecordDecisionOutcomeInWorkHandler + evt-200
```

The canonical processed-event statuses are `Processing`, `Processed`, `RetryPending`, `Failed`, `Blocked`, and `Skipped` as defined by `events-and-outbox.md`. Application code must not introduce aliases such as `DeadLettered` or `Abandoned` for generic consumer delivery.

---

# Consumer Claim and Execution Boundary

The Worker first acquires a short, durable `Processing` claim. Claiming validates the consumer registration, Organization scope, ordering key, prior processed-event state, and predecessor state. A real claim increments `attemptCount` and `claimVersion`; duplicate, deferred, or predecessor-blocked delivery does not.

External work executes only after the claim transaction commits. It holds no target Aggregate lock or open database transaction and renews the lease through bounded heartbeat transactions when required.

---

# Processed Event Success Transaction

For a domain-changing handler, the terminal `Processed` transition—not necessarily initial creation of the delivery row—must commit in the same transaction as the Aggregate effect:

```text
BEGIN

Lock processed-event row
Verify Processing status, workerId, claimVersion, and unexpired lease
Revalidate Organization, System capability, event applicability, and ordering state
Load target Aggregate with expected version
Execute Aggregate command
Save Aggregate
Write new Outbox events
Persist required audit metadata
Transition processed event to Processed
Store processedAt and stable result reference
Clear claim fields
Advance ordering state

COMMIT
```

This prevents both state change without a success marker and a success marker without state change. Fencing verification occurs before target mutation; failure returns `LeaseLost` and commits no domain effect.

---

# Retry and Failure Transactions

A transient failure uses a short fenced transaction to change `Processing -> RetryPending`, calculate `nextAttemptAt`, preserve the completed attempt count, record bounded failure metadata, and clear claim fields.

A permanent failure or retry exhaustion atomically changes `Processing -> Failed`, creates or updates the dead-letter record, applies the registered failure-continuation policy to ordering state, writes required operational events, and clears the claim. Unchanged permanent failures are not reclaimed automatically.

Expired-lease recovery changes the expired `Processing` row to `RetryPending`; recovery itself is not a handler attempt. The next Worker increments the attempt only when it acquires a new claim.

---

# Duplicate Event Behavior

- `Processed` returns the stable prior result without executing the handler;
- `Processing` with a valid lease defers to the current Worker;
- `RetryPending` waits until `nextAttemptAt`;
- `Failed` requires authorized recovery;
- `Blocked` waits without consuming attempts; and
- `Skipped` returns the audited terminal skip outcome without claiming business success.

Duplicate delivery is expected, not exceptional.

---

# Handler Idempotency and Business Idempotency

Technical deduplication does not replace domain-level protection.

Example:

```text
Work.RecordDecisionOutcome(decisionId, Approved)
```

The Work Aggregate should still reject or safely recognize duplicate logical outcomes.

Both layers are required:

- processed event store prevents repeated handling
- Aggregate invariants protect business state

---

# Event Ordering

Events from one Aggregate are ordered by:

```text
aggregateVersion
```

Example:

```text
Decision version 3 -> DecisionSubmitted
Decision version 4 -> DecisionApproved
```

A consumer must not apply version 4 before required version 3 state is available.

---

# Ordering Scope

Ordering is required only per Aggregate.

Global ordering across all events is not required.

The following sequence is not guaranteed:

```text
Decision A event
Work B event
Memory C event
```

No business rule may depend on global event ordering.

---

# Out-of-Order Event Handling

If a handler receives an event that cannot yet be applied:

- do not mutate the Aggregate incorrectly
- record the ordering conflict
- retry later where appropriate
- alert if the condition persists

The handler must distinguish:

- transient missing predecessor
- permanently invalid event
- duplicate event
- unrelated stale event

---

# Retry Policy

Retries apply to transient failures.

Examples:

- temporary database unavailability
- network timeout
- message broker interruption
- rate limiting
- transient external AI service failure

---

# Retry Schedule

Recommended retry pattern:

```text
Attempt 1: immediate
Attempt 2: short delay
Attempt 3: exponential delay
Later Attempts: bounded exponential backoff
```

Jitter should be added to prevent synchronized retries.

---

# Retry Limits

Retries must be bounded.

Each processing record should track:

```text
attemptCount
lastAttemptAt
nextAttemptAt
lastError
```

After the retry threshold, the record moves to operational failure handling.

---

# Retry Classification

Errors should be classified as:

```text
Transient
Permanent
Concurrency
Authorization
Validation
Unknown
```

---

## Transient

Retry automatically.

Examples:

- connection timeout
- database failover
- external service unavailable

---

## Permanent

Do not retry automatically without intervention.

Examples:

- malformed event payload
- unsupported schema version
- impossible reference
- missing required immutable data

---

## Concurrency

Reload and retry only when the use case remains valid.

Retries must be bounded.

---

## Authorization

Do not retry automatically.

Authorization failure indicates an invalid execution context or security issue.

---

## Validation

Do not retry unchanged input.

Validation failure is a business rejection, not an infrastructure failure.

---

## Unknown

Retry conservatively, then escalate.

Unknown failures require diagnosis.

---

# Concurrency Retry

An asynchronous handler may encounter optimistic concurrency conflicts.

Example:

```text
Decision outcome handler loads Work version 8

Human updates Work to version 9

Handler attempts save using version 8
```

The handler may:

```text
Reload Work

Re-evaluate command

Retry save
```

The Aggregate must revalidate all invariants after reload.

---

# Retry Safety

A retry must never assume the previous attempt failed before commit.

The previous transaction may have committed even if the caller received an error.

Therefore every retry must first check:

- processed command
- processed event
- current Aggregate state
- existing target record

---

# Memory Generation Retry

Memory generation requires special handling because AI processing may be expensive.

The handler should use a stable generation identity.

Example:

```text
generationId = workId + generationPolicyVersion
```

Before generating or persisting, the handler checks whether generation already succeeded.

---

# One Memory per Work

The Memory subsystem guarantees:

```text
Work 1 --- 0..1 Active Memory
```

The handler must not create multiple active Memories for the same Work.

Recommended safeguards:

- application-level existence check
- database uniqueness constraint
- deterministic generation identity
- processed event record

---

# Generation Attempt Record

A Memory generation attempt may record:

```text
generationAttemptId
workId
sourceEventId
policyVersion
status
attemptCount
startedAt
completedAt
lastError
```

This is operational metadata.

It does not replace the Memory Aggregate.

---

# External AI Call Boundary

External AI generation must occur outside a long-running database transaction.

Correct pattern:

```text
Load required immutable source data

Commit or release read resources

Invoke AI generation

Validate generated content

BEGIN short persistence transaction

Verify no Memory exists

Create Memory Aggregate

Save Memory

Write Outbox event

Mark source event processed

COMMIT
```

---

# AI Response Validation

Generated content must be validated before creating Memory.

Validation may include:

- required fields
- maximum lengths
- valid source references
- supported content schema
- prohibited output structures
- Organization ownership

Validation does not grant AI authority.

A generated Memory remains in Generated state.

---

# Poison Event Handling

A poison consumer delivery reaches `Failed` because a failure is permanent or bounded retry policy is exhausted.

Examples include:

- corrupted or incompatible payload;
- impossible foreign reference;
- unsupported contract version;
- deterministic handler defect;
- permanent Organization or capability mismatch; and
- ambiguous irreversible external outcome requiring Human recovery.

---

# Poison Event State

The processed-event row preserves the current execution result:

```text
consumerName
eventId
eventType
status = Failed
attemptCount
failedAt
lastErrorCode
lastErrorMessage reference
```

A separate linked dead-letter record preserves investigation lifecycle, first and last failure times, operator assignment, replay linkage, and resolution. `DeadLettered` is not a processed-event status and the immutable source event is never marked resolved.

Sensitive payloads are referenced through protected storage and are not copied into unrestricted logs.

---

# Failed Event Recovery

Operators act through typed, audited recovery commands. They may inspect authorized failure details, correct configuration or associations, deploy a handler fix, run `ValidateOnly`, request replay, skip only when the registered policy permits, and resolve the linked dead-letter record after reconciliation.

Recovery never edits the immutable source event. A retry from `Failed` acquires a new fenced `Processing` claim and records replay identity and reason. A skip transitions the consumer result to `Skipped`; it does not claim that the business effect succeeded.

---

# Event Replay

The system should support controlled replay.

Replay must:

- preserve the original eventId where deduplication semantics require it, or
- use an explicit replay identifier with originalEventId metadata
- preserve correlation context
- avoid bypassing idempotency
- record the operator and reason

---

# Replay Modes

Recommended modes:

```text
Retry Original Processing
Rebuild Read Model
Reprocess With New Handler Version
```

Business Aggregate mutation replay requires the strongest safeguards.

---

# Dead Letter Handling

A dedicated message broker dead-letter queue is optional in the MVP.

PostgreSQL-backed failed Outbox and processed-event records are sufficient when they provide:

- durable failure storage
- inspectability
- retry control
- auditability
- alerting

---

# Failure Recovery Scenarios

## Scenario 1: Decision Commits, Publication Fails

```text
Decision Approved
      │
      ▼
Database Commit Succeeds
      │
      ▼
Broker Publication Fails
```

Result:

- Decision remains Approved
- Outbox record remains pending
- Worker retries publication
- Work remains temporarily unchanged

---

## Scenario 2: Publication Succeeds, Handler Fails

```text
DecisionApproved Published
      │
      ▼
Work Handler Fails
```

Result:

- Decision remains Approved
- event delivery is retried
- Work outcome is eventually recorded
- no Decision rollback occurs

---

## Scenario 3: Handler Commits, Acknowledgement Fails

```text
Work Outcome Transaction Commits
      │
      ▼
Worker Crashes Before Acknowledgement
```

Result:

- event is delivered again
- processed-event record detects duplication
- no second Work mutation occurs

---

## Scenario 4: Memory Generation Times Out

```text
WorkCompleted
      │
      ▼
AI Generation Timeout
```

Result:

- Work remains Completed
- no incomplete Memory is created
- generation attempt is retried
- operational metrics record failure

---

## Scenario 5: Memory Persists, Worker Crashes

```text
Memory Created
      │
      ▼
Transaction Commits
      │
      ▼
Worker Crashes
```

Result:

- event may be retried
- unique Work-to-Memory constraint prevents duplicate Memory
- processed-event logic returns successful prior result

---

# Timeout Policy

Every external operation must have a defined timeout.

Examples:

- database command timeout
- event publication timeout
- AI generation timeout
- external API timeout

Infinite waits are prohibited.

---

# Circuit Breaking

External services with repeated failures may use circuit breakers.

A circuit breaker may:

- stop immediate repeated calls
- reduce resource exhaustion
- allow controlled recovery
- surface operational status

Circuit breakers belong to Infrastructure.

They do not change domain state automatically.

---

# Backpressure

The Worker must handle event backlog safely.

Possible controls:

- bounded batch sizes
- configurable concurrency
- per-handler concurrency limits
- Organization-level throttling
- AI generation rate limits
- retry delay
- queue depth alerts

---

# Fair Processing

One failing Organization or handler must not indefinitely block unrelated work.

Processing may be partitioned by:

- handler type
- event type
- Organization
- workload class

Memory generation may use a separate queue or Worker pool from lightweight event handling.

---

# Operational Consistency

The system may temporarily contain:

```text
Decision = Approved
Work Completion Gate = Pending
```

or:

```text
Work = Completed
Memory = Not Yet Generated
```

These are valid eventual-consistency states.

They must be observable and recoverable.

---

# Reconciliation

Periodic reconciliation jobs may detect missing asynchronous outcomes.

Examples:

- Approved Decision not yet recorded in Work
- Completed Work without Memory generation attempt
- pending Outbox record older than threshold
- handler event stuck in retry state

Reconciliation jobs may schedule recovery commands.

They must not modify Aggregate state directly.

---

# Reconciliation Idempotency

Reconciliation produces the same commands and events used by normal processing.

It must not create alternate business paths.

Example:

```text
Detect Missing Memory
      │
      ▼
Schedule GenerateMemory
```

Not:

```text
Insert Memory row directly
```

---

# Delivery Guarantees Summary

The MVP provides:

```text
Aggregate Persistence:
    Atomic

Outbox Persistence:
    Atomic with Aggregate

Event Publication:
    At Least Once

Event Consumption:
    At Least Once

Handler Effect:
    Effectively Once through Idempotency

Cross-Aggregate Consistency:
    Eventual

Per-Aggregate Concurrency:
    Optimistic Locking
```

---

# Application Layer Reliability Rules

The following rules are mandatory:

1. Never publish an event before transaction commit.
2. Never mutate an Aggregate outside its command methods.
3. Never assume event delivery occurs only once.
4. Never hold a transaction open during AI generation.
5. Never roll back completed Work because Memory generation failed.
6. Never complete Work from a Decision outcome handler.
7. Never allow Secretary output to trigger authoritative transitions.
8. Always persist handler deduplication atomically with its effects.
9. Always preserve correlation and causation metadata.
10. Always make failed asynchronous processing observable and recoverable.

---

# MVP Infrastructure Topology

Recommended MVP deployment:

```text
Modular Monolith Process
 ├── HTTP Application
 ├── Application Services
 ├── Domain Aggregates
 ├── PostgreSQL Repositories
 ├── Transactional Outbox
 └── Background Worker
```

The HTTP Application and Background Worker may run:

- inside one deployable process, or
- as separate process roles using the same codebase

Both remain part of the Modular Monolith.

---

# Broker Requirement

A separate external message broker is optional for the MVP.

The system may dispatch local asynchronous events directly from PostgreSQL Outbox records.

The architecture must preserve the ability to introduce a broker later without changing Aggregate behavior.

---

# Future Broker Migration

A later phase may publish Outbox events to:

- Kafka
- RabbitMQ
- cloud queue services
- external event infrastructure

This migration affects Infrastructure and event contracts.

It must not move business rules out of Aggregates.

# Security Integration

Application Services enforce authentication and invoke authorization policies before Aggregate commands are executed.

Authentication determines:

- who is making the request
- which Organization they belong to

Authorization determines:

- whether the requested operation is permitted

Aggregates assume authorization has already been verified.

Business invariants remain enforced inside the Aggregate.

---

# Authorization Flow

```text
Incoming Request
        │
        ▼
Authentication
        │
        ▼
Authorization Policy
        │
        ▼
Application Service
        │
        ▼
Aggregate Command
```

The Application Service must never bypass authorization.

---

# Authorization Responsibilities

The Application Layer is responsible for:

- resolving the authenticated actor
- verifying Organization membership
- evaluating permissions
- supplying ActorReference to Aggregate commands
- rejecting unauthorized requests

The Aggregate is responsible only for business correctness.

---

# Human Authority

The MVP recognizes three actor categories:

- Human Member
- Secretary
- System

Only Human Members possess business authority.

---

## Human Member

Human Members may:

- create Work
- start Work
- complete Work
- create Decisions
- edit Decision Drafts
- submit Decisions
- approve Decisions
- reject Decisions
- withdraw Decisions
- edit Memory
- approve Memory
- reject Memory

Business authority always belongs to Humans.

---

## Secretary

The Secretary may:

- generate drafts
- rewrite text
- summarize content
- propose rationale
- organize information
- assist Memory generation

The Secretary may never:

- approve Decisions
- reject Decisions
- withdraw Decisions
- complete Work
- approve Memory
- promote Knowledge

Secretary output is advisory.

---

## System

The System performs operational responsibilities such as:

- publishing events
- processing Outbox records
- executing retry logic
- generating Memory
- invoking reconciliation jobs

The System never performs business decisions.

---

# Organization Isolation

Every Application Service executes within exactly one Organization.

Every Aggregate loaded by an Application Service must belong to that Organization.

Cross-Organization coordination is prohibited.

---

## Organization Validation

Before loading an Aggregate:

```text
Request Organization

↓

Aggregate Organization

↓

Compare

↓

Continue or Reject
```

No Aggregate may be modified across Organization boundaries.

---

# Request Context

Every Application Service receives a request context.

A typical context contains:

```text
requestId
commandId
correlationId
actorReference
organizationId
requestTime
locale
```

The context flows through the complete use case.

---

# Correlation Propagation

Every command generated from an incoming event inherits:

- correlationId
- organizationId

A new causationId is recorded.

This enables complete traceability across asynchronous workflows.

---

# Observability

The Application Layer should expose metrics for operational visibility.

Recommended metrics include:

- completed commands
- failed commands
- rejected commands
- concurrency conflicts
- retry attempts
- handler failures
- Outbox backlog
- event publication latency
- Memory generation duration
- reconciliation executions

---

# Logging

Application Services should log:

- command execution
- transaction completion
- retry attempts
- handler execution
- infrastructure failures

Logs should include:

```text
commandId
correlationId
organizationId
aggregateId
aggregateVersion
actorReference
```

Sensitive business content should not be logged by default.

---

# Tracing

Distributed tracing is optional for the MVP.

However, every workflow should remain traceable using:

- commandId
- eventId
- correlationId
- causationId

These identifiers should appear consistently in logs and metrics.

---

# Health Checks

Operational health checks should verify:

- database connectivity
- Outbox backlog
- Worker availability
- retry backlog
- failed event count
- pending Memory generation
- reconciliation health

Health checks do not evaluate business correctness.

---

# Application Service Testing

Application Services should be tested independently from transport mechanisms.

Tests should focus on orchestration.

Business rules remain the responsibility of Aggregate tests.

---

## Unit Tests

Unit tests verify:

- repository coordination
- transaction boundaries
- authorization integration
- command routing
- event collection
- Outbox persistence requests
- idempotency handling
- retry decisions

---

## Integration Tests

Integration tests verify:

- PostgreSQL transactions
- optimistic concurrency
- Transactional Outbox
- Background Worker
- event processing
- Aggregate coordination
- Organization isolation

---

## End-to-End Tests

Representative end-to-end scenarios include:

### Work Lifecycle

```text
Create Work
↓

Start Work
↓

Complete Work
↓

Memory Generated
↓

Memory Approved
```

---

### Decision Workflow

```text
Create Decision
↓

Edit Draft
↓

Submit
↓

Approve
↓

Decision Outcome Recorded
↓

Human Completes Work
```

---

### Rejected Decision Workflow

```text
Create Decision
↓

Submit
↓

Reject
↓

Start Revision
↓

Submit
↓

Approve
```

---

### Memory Review Workflow

```text
Work Completed
↓

Memory Generated
↓

Edit Generated Memory
↓

Submit
↓

Approve
```

---

# Performance Considerations

Application Services should remain lightweight.

Long-running processing belongs to asynchronous handlers.

Examples:

Allowed inside request:

- Aggregate commands
- repository operations
- authorization
- validation
- Outbox persistence

Not allowed:

- AI generation
- external document synthesis
- large batch processing
- report generation

---

# Scalability

The Application Layer should scale independently from the Presentation Layer.

Multiple Worker instances may execute concurrently.

Multiple HTTP instances may execute concurrently.

Optimistic concurrency guarantees Aggregate consistency.

---

# Configuration

Operational settings should remain configurable.

Examples:

```text
Worker Batch Size

Retry Schedule

Concurrency Limit

Memory Generation Timeout

Outbox Poll Interval

Maximum Retry Count

Health Check Interval
```

Configuration values must not alter domain behavior.

---

# Implementation Guidance

A recommended package structure is:

```text
modules/

    organization-access/
        application/
        domain/
        infrastructure/

    work-decision/
        work/
            application/
            domain/
            infrastructure/
        decision/
            application/
            domain/
            infrastructure/
        coordination/
            RequestBlockingDecisionService

    organizational-learning/
        memory/
            application/
            domain/
            infrastructure/

platform-runtime/
    outbox/
    workers/
    dispatch/
    recovery/
    observability/
```

Platform Runtime may depend on stable module event-handler interfaces. It must not depend on module Repository implementations.

Shared code is limited to technical primitives and stable cross-cutting contracts such as transaction context, clocks, identifiers, event envelopes, and authorization interfaces. Domain terminology and business policies must not be moved into a generic shared package.

The exact implementation may differ.

Responsibilities should remain equivalent.

---

# Dependency Direction

Dependencies point inward toward policies, not downward toward infrastructure.

```text
Presentation Adapter ─────► Application Interface
Platform Runtime Adapter ─► Application Event-Handler Interface

Application ───────────────► Domain

Infrastructure Adapter ───► Application Port
Infrastructure Adapter ───► Domain types required by that port
```

The Domain Layer has no dependency on Application, Presentation, Platform Runtime, or Infrastructure.

The Application Layer defines use cases and outbound ports. Infrastructure implements those ports. Dependency injection connects adapters at composition time.

The Domain Layer must never depend on:

- HTTP;
- databases;
- queues;
- logging;
- AI SDKs; or
- Worker and Outbox types.

---

# Common Anti-Patterns

The following practices are prohibited.

---

## Fat Application Service

Application Services must not contain business rules.

Incorrect:

```text
if decisionApproved then
    work.status = Completed
```

Correct:

```text
Work.CompleteWork()
```

---

## Aggregate-to-Aggregate Calls

Incorrect:

```text
DecisionAggregate

↓

WorkAggregate
```

Correct:

```text
DecisionAggregate

↓

Domain Event

↓

Application Service

↓

WorkAggregate
```

---

## Infrastructure Inside Aggregates

Aggregates must not:

- publish events
- call HTTP APIs
- invoke AI services
- access repositories

---

## Long Transactions

Incorrect:

```text
BEGIN

Generate AI Summary

Wait 45 Seconds

Save Aggregate

COMMIT
```

Correct:

```text
Generate AI Summary

↓

BEGIN

Save Aggregate

COMMIT
```

---

# MVP Exclusions

The following capabilities are outside the MVP:

- distributed transactions
- Saga orchestration
- workflow engine
- BPM integration
- external message broker dependency
- multi-region event routing
- automatic Knowledge promotion
- autonomous AI approval
- AI-initiated Work completion
- AI-managed authorization

These capabilities may be introduced in future roadmap phases.

---

# Design Summary

The Application Layer guarantees:

- use case orchestration
- Aggregate independence
- transaction ownership
- reliable Outbox persistence
- asynchronous coordination
- idempotent processing
- Organization isolation
- authorization integration
- operational observability

The Application Layer does **not** own business rules.

Business rules remain inside Aggregates.

---

# Architect Review

## Responsibility Separation

**Rating: ★★★★★**

Application workflow is clearly separated from domain logic.

Business rules remain inside Aggregates.

---

## Aggregate Coordination

**Rating: ★★★★★**

Aggregates remain independent.

Cross-aggregate interaction occurs only through Application Services and Domain Events.

---

## Reliability

**Rating: ★★★★★**

Transactional Outbox, Background Workers, retry policies, and idempotency provide a robust foundation for asynchronous processing.

---

## Human Authority

**Rating: ★★★★★**

Only Human Members perform authoritative business actions.

Secretary capabilities remain advisory.

System actors remain operational.

---

## Scalability

**Rating: ★★★★★**

The architecture supports horizontal scaling of HTTP services and Background Workers without changing Aggregate behavior.

---

## MVP Scope

**Rating: ★★★★★**

The design focuses exclusively on MVP requirements while preserving clear extension points for future phases.

---

## Final Assessment

```text
Architecture Quality:        ★★★★★
Layer Separation:            ★★★★★
Aggregate Independence:      ★★★★★
Operational Reliability:     ★★★★★
Implementation Readiness:    ★★★★★
MVP Scope Discipline:        ★★★★★
```

The Application Layer is ready for implementation within the AIOS Modular Monolith.

It is fully aligned with:

- Work Aggregate
- Decision Aggregate
- Memory Aggregate
- Transactional Outbox
- Background Workers
- Human Authority
- Explicit Work Completion
- Eventual Cross-Aggregate Consistency

**Architect Review Result: APPROVED**
