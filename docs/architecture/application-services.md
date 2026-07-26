# Application Services

**Status:** Draft  
**Phase:** MVP  
**Architecture:** Modular Monolith

---

# Purpose

Application Services coordinate business use cases, including single-Aggregate commands and the few documented workflows that span multiple Aggregates.

They orchestrate workflows, manage transactional boundaries, invoke aggregate commands, and coordinate asynchronous processing through Domain Events.

Application Services contain application workflow, evaluate Authorization and Domain Policy ports, and enforce external or cross-Aggregate preconditions that require scoped repository facts.

They do **not** own Aggregate-local lifecycle rules or mutate Aggregate-owned state directly. Rule ownership follows ADR-0009; not every business-relevant rule is an Aggregate invariant.

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
- Evaluating documented external and cross-Aggregate preconditions.
- Invoking context-owned Domain Policies or Specifications with explicit facts.

---

# Non-Responsibilities

Application Services are **not** responsible for:

- Aggregate-local lifecycle rule enforcement.
- Aggregate validation.
- Aggregate invariants.
- Human business judgment.
- Authorization policy definition.
- Domain Policy definition.
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

They coordinate execution without duplicating Aggregate or Domain Policy semantics.

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
- External and cross-Aggregate precondition evaluation.
- Invocation of Authorization and Domain Policies.

---

## Domain Layer

Responsible for:

- Aggregate-local business rules and invariants.
- Context-owned Domain Policies and Specifications.
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

# Rule Ownership

Every rule has one primary enforcement owner. The Application Service may coordinate enforcement, but it must not duplicate another owner's semantics.

| Rule category | Primary owner | Typical example |
|---|---|---|
| Aggregate-local invariant | Aggregate Root | A completed Work cannot be completed again |
| Context-wide deterministic rule | Domain Policy or Specification | A rule derived from facts that do not naturally belong to one Aggregate |
| Permission decision | Authorization Policy | Whether an Actor may execute a command in an Organization |
| External or cross-Aggregate precondition | Application Service | Required related records exist and belong to the same Organization |
| Structural or race-safe integrity | PostgreSQL constraint | Unique key, foreign key, version check, tenant-consistent reference |
| Long-running temporal rule | Durable process handler | Retry, timeout, and completion of Work-to-Memory generation |
| Delivery behavior | Platform Runtime | Outbox claiming, backoff, dead-letter handling, metrics |

The complete classification, failure semantics, and verification requirements are defined by [ADR-0009](../adr/0009-assign-rule-enforcement-responsibilities.md).

---

# Design Principles

Application Services follow several architectural principles.

---

## Principle 1

Aggregate-local rules belong inside the owning Aggregate. Multi-fact domain meaning that has no natural Aggregate owner belongs in a context-owned deterministic Domain Policy or Specification.

Application Services may enforce documented external preconditions, but never duplicate Aggregate transition logic or Domain Policy semantics.

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

This workflow coordinates Work with submission of an immutable blocking Decision revision. It may create the Decision first or use the active Draft revision of an existing rejected or withdrawn Decision.

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
      ├── Create or load Decision Draft
      ├── Submit Decision revision for review
      ├── Ask Work to record the exact submitted-revision reference
      │
      ├── Save Work
      ├── Add or save Decision
      │
      └── Write Outbox events
      ▼
Commit
```

---

## Atomic Coordination

Within the Modular Monolith, the MVP coordinates activation of the blocking relationship in one PostgreSQL transaction.

```text
BEGIN

Load Work

Create and add Decision, or load existing Decision with expected version

Decision.SubmitForReview(humanActor)

blockingReference = (
    decisionId,
    revisionNumber,
    submittedSnapshotId
)

Work.RequestBlockingDecision(blockingReference)

Save Work with expected version

Add new Decision or save existing Decision with expected version

Write WorkDecisionRequested to Outbox

Write DecisionCreated to Outbox

Write DecisionSubmitted to Outbox

Record processed command

COMMIT
```

For an existing Decision, load and save it with its expected version instead of creating and adding it; `DecisionCreated` is then absent, while `DecisionSubmitted` remains required. This is an Application Layer transaction.

It does not merge the two Aggregate boundaries.

---

## Why Atomic Activation Is Allowed

The workflow establishes a required reference between two newly coordinated facts:

- Work is waiting for a specific blocking Decision.
- That Decision revision exists as an immutable submitted snapshot and is `InReview`.

A single database transaction prevents:

- a Work item referencing a nonexistent Decision
- an orphaned blocking Decision
- a Draft Decision incorrectly blocking Work
- mismatched Work and Decision revision references
- partial creation of the workflow

After activation, the aggregates evolve independently.

---

## Cross-Aggregate Preconditions

Before executing the workflow, the Application Service verifies:

- the Work exists
- the Work belongs to the current Organization
- the actor may request a Decision
- the proposed Decision belongs to the same Organization
- the Decision is new, or is Rejected or Withdrawn with exactly one active Draft revision
- the blocking Draft is complete enough to submit

The Work Aggregate still determines whether its current state permits a blocking Decision.

The Decision Aggregate still validates its own initial content and submission rules. The Work Aggregate receives the immutable `decisionId`, `revisionNumber`, and `submittedSnapshotId` only after `SubmitForReview` succeeds in memory; neither change is visible unless the transaction commits.

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
Secretary Runtime Adapter
      │
      │ Invoke context-owned DecisionAiAssistancePort
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

The `Secretary Runtime Adapter` is non-owning. It does not contain Decision rules and receives no Decision Repository, Aggregate, database, generic command bus, or unrestricted query access.

Each context owns a narrow AI Assistance Application Port. The port exposes only typed advisory operations; Human-only and System-only commands are absent from the interface. Invocation requires an Organization-scoped, versioned assistance grant and an initiating Human command or separately permitted System workflow.

Provider output is untrusted candidate data. The owning context validates and optionally records it through a normal Aggregate command. Human adoption is a later command that reloads current state and re-evaluates authorization and invariants. See [ADR-0011](../adr/0011-bound-secretary-to-context-owned-assistance-ports.md).

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
    revisionNumber,
    submittedSnapshotId,
    decisionAggregateVersion,
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
    revisionNumber,
    submittedSnapshotId,
    decisionAggregateVersion,
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
CompletionGate = Unsatisfied(decisionId, revisionNumber, submittedSnapshotId)
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
    revisionNumber,
    submittedSnapshotId,
    decisionAggregateVersion,
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

## Outcome Races and Terminal No-Ops

The handler matches the complete active blocking reference: `decisionId`, `revisionNumber`, and `submittedSnapshotId`. `decisionId` alone is not sufficient when a later revision reuses the same Decision identity.

On an optimistic-concurrency conflict, the handler reloads Work and re-evaluates the event. If Work was cancelled first, the handler records the event as a terminal no-op with the reason and audit evidence; it does not reopen Work, restore a Completion Gate, or retry forever. If Work already records the same submitted-revision outcome, the handler records duplicate or stale success. A mismatched current reference or a conflicting outcome for the same submitted snapshot is blocked or failed for investigation and never rebinds the gate automatically.

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

Memory generation begins asynchronously after Work completion and is classified as `ExternalComputation`, not `ExternalBusinessEffect`.

`Integration / WorkCompleted / 1` is the only registered MVP trigger. The handler does not emit or wait for a separate `MemoryGenerationRequested` event; the committed source snapshot and `memory_generation_operation` are the durable process checkpoint.

```text
WorkCompleted
      │
      ▼
Memory Generation Consumer Claim
      │
      ▼
Committed Source Snapshot + Generation Operation
      │
      ▼
Fenced Generation Attempt
      │
      ▼
AI Provider Call Outside Transaction
      │
      ▼
Validate Candidate
      │
      ▼
CreateGeneratedMemory
      │
      ▼
Memory + MemoryGenerated + Processed Event + Generation Result
```

---

## Memory Generation Is Asynchronous

The Complete Work transaction does not wait for AI generation, document synthesis, source retrieval, Memory persistence, or review notification. Work remains Completed regardless of provider availability.

---

## Memory Generation Preconditions

The handler verifies:

- `WorkCompleted` is authentic and committed;
- the Work and every source belong to the event Organization;
- no Memory already exists for that Work;
- the exact immutable source snapshot exists or can be created;
- the stable generation operation matches Work, event, policy, source hash, and provider-input hash; and
- the consumer event has not already been processed successfully.

---

## Source and Operation Transaction

```text
BEGIN
Validate WorkCompleted envelope, Organization scope, and generation identity
Create or reuse the immutable source snapshot
Create or reuse one memory_generation_operation
Verify source hash, policy version, and provider-input hash
COMMIT
```

The operation is globally stable for `organizationId + workId + generationPolicyVersion`. A conflicting fingerprint is terminal for automatic processing.

---

## Generation Claim Transaction

A real provider attempt uses a short fenced transaction:

```text
Lock generation operation
Require Pending or due RetryPending
Set status = Generating
Increment attemptCount and claimVersion
Set lockedBy, lockedUntil, lastAttemptAt using database time
COMMIT
```

The AI provider call begins only after this transaction. Long calls renew the generation lease without changing business state or incrementing the attempt count.

---

## Provider Call and Candidate Rule

The provider receives only the committed source snapshot. No PostgreSQL transaction remains open.

The provider response is untrusted candidate data. It has no domain authority and does not mean generation succeeded until the final local transaction validates the candidate and creates Memory.

A stale response whose `lockedBy`, `claimVersion`, or `lockedUntil` no longer matches is discarded. It cannot create or overwrite Memory.

---

## Memory Creation Transaction

```text
BEGIN
Verify generation status = Generating and generation fencing
Verify processed-event consumer fencing
Recheck source-snapshot identity and provider-input hash
Confirm no Memory exists for organizationId + sourceWorkId
Validate generated candidate
Create Memory Aggregate in Generated
Add Memory
Write MemoryGenerated to Outbox
Set generation operation = Generated
Set processed event = Processed with stable result reference
Record required audit evidence
COMMIT
```

A uniqueness conflict loads the existing Organization-scoped Memory, verifies the same Work and generation identity, and records prior success without overwriting it.

---

## Generation Timeout and Retry

A timeout with no usable candidate does not create unknown external business state because the provider performs computation only.

While retry budget remains, a fenced transaction changes:

```text
Generating -> RetryPending
```

It stores `nextAttemptAt`, bounded error code, and clears the generation claim. Retry reuses the exact source snapshot, policy version, provider-input hash, and generation operation.

When retry policy is exhausted, `Generating -> Failed`. A Human-authorized typed retry may later return the same operation to `RetryPending`; it must not create another logical operation.

Provider duplicate-call cost and latency are recorded operationally. They never justify duplicate Memory, accepting a stale response, or bypassing Human review.

---

## Generation Lease Recovery

Expired `Generating` claims are fenced by `claimVersion`. Recovery changes them to `RetryPending`, preserves `attemptCount`, schedules `nextAttemptAt`, records `LeaseExpired`, and clears claim fields.

Recovery itself is not a provider attempt and cannot mark the processed event successful.

---

## Generation Failure

Generation failure creates no partial Memory Aggregate and does not reopen Work. The committed source snapshot and generation operation remain as durable recovery evidence.

Failure is represented by the same operation becoming `RetryPending`, `Failed`, or explicitly `Abandoned`. `MemoryGenerationFailed` is not an MVP Domain or Integration Event. Operational logs, metrics, alerts, and typed administrative queries expose the failure.

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
destination
consumerSetVersion
targetCount
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

The configured transport durably accepted the event.

For `local-consumer-bus`, every resolved target `Pending` processed-event row and the Outbox Published transition committed atomically. This status does not mean that any consumer effect completed.

The publication timestamp, consumer-set version, and target count are recorded where applicable.

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
- atomically materializing local `Pending` consumer deliveries
- claiming and executing consumer deliveries in Consumer Worker roles
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

    If destination = local-consumer-bus:
        Resolve versioned enabled consumer set
        Atomically insert Pending processed-event rows
        and set Outbox Published

    If destination = external broker:
        Publish and await configured broker acknowledgement
        then set Outbox Published

    Otherwise:
        Fail visibly
↓
Mark Published or schedule publication retry
```

This loop owns Outbox publication and durable local handoff only. It does not execute consumer business effects. Consumer Workers independently claim `Pending` or retry-eligible processed-event rows.

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

The Event Dispatcher maps validated event contracts to versioned ConsumerRegistration entries.

For `local-consumer-bus`, dispatch begins with one atomic transaction that inserts all target `Pending` processed-event rows and marks the Outbox record Published. Direct callback invocation is not the durable delivery boundary. Consumer Workers claim and invoke handlers independently after that commit.

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

The canonical processed-event statuses are `Pending`, `Processing`, `Processed`, `RetryPending`, `Failed`, `Blocked`, and `Skipped` as defined by `events-and-outbox.md`. Application code must not introduce aliases such as `DeadLettered` or `Abandoned` for generic consumer delivery.

---

# Consumer Claim and Execution Boundary

A local delivery first exists durably as `Pending`. The Consumer Worker then acquires a short, durable `Processing` claim from an eligible `Pending`, `RetryPending`, or unblocked `Blocked` row. Claiming validates the consumer registration, Organization scope, ordering key, prior processed-event state, and predecessor state. A real claim increments `attemptCount` and `claimVersion`; duplicate, deferred, or predecessor-blocked delivery does not.

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

This prevents both state change without a success marker and a success marker without state change. Before any target Aggregate mutation, fencing verification must require `status = Processing`, `lockedBy = currentWorkerId`, `claimVersion = acquiredClaimVersion`, and `lockedUntil > databaseNow`. Failure returns `LeaseLost` and commits no Aggregate state, Outbox event, audit record, dead-letter record, ordering-state change, or processed-event result.

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

# Memory Generation Operation

The Memory generation consumer uses one stable `memory_generation_operation`, not one mutable row per provider retry.

Canonical statuses are:

```text
Pending
Generating
RetryPending
Generated
Failed
Abandoned
```

`Generated` and `Abandoned` are terminal. `Failed` requires an authorized typed retry to become `RetryPending`.

The one-Memory-per-Work guarantee is reinforced by:

- the full unique generation-operation identity;
- processed-event identity;
- Memory uniqueness on `organizationId + sourceWorkId`;
- source and provider-input hashes; and
- fenced finalization.

---

# External AI Call Boundary

Memory generation is `ExternalComputation`. Correctness depends on local fencing and final PostgreSQL commit, not on treating a provider request as an external business effect.

Provider idempotency may reduce duplicate billable calls when supported, but it is not the domain idempotency boundary. The stable generation operation, source snapshot, and Memory uniqueness remain authoritative.

---

# External Business Effect Execution Pattern

`PostgreSQLLocal` consumers use the ordinary atomic consumer transaction. A consumer registered as `ExternalBusinessEffect` uses a different Application Service pattern.

```text
BEGIN
Create or reuse external_effect_operation = Prepared
Verify logical effect key and request fingerprint
COMMIT

BEGIN
Acquire fenced effect claim
Set Prepared or ConfirmedAbsent -> InFlight
COMMIT

Call provider outside transaction using stable provider idempotency key
or durable provider operation identity

BEGIN
Verify effect claim and provider evidence
Set effect operation outcome
Finalize processed event, dead letter, ordering state, Outbox, and audit
COMMIT
```

Timeout, acknowledgement loss, lease loss after send, or local commit failure after provider acknowledgement becomes `OutcomeUnknown` unless authoritative provider evidence proves otherwise.

Ordinary retry does not claim or resend `OutcomeUnknown`. The Operations Application Service must query the provider, repeat the same provider-enforced idempotency key within its verified retention window, or execute approved compensation.

A provider effect that is neither idempotent nor queryable cannot be enabled as an automatic MVP consumer. Application-level “already sent” checks cannot close the crash window after the external effect and before local commit.

Compensation is a separate typed operation and ledger row. It never deletes or rewrites the original effect history.

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

# Failed Consumer Recovery Application Service

The Operations Application Service owns consumer recovery orchestration. Repositories expose persistence; they do not authorize replay, decide whether a skip is safe, or mark a dead letter resolved independently.

MVP typed commands are:

```text
RequestConsumerReplay
SkipDeadLetter
CancelConsumerReplay
```

The actor, Membership, Organization, and policy context come from trusted `ExecutionContext`. Command payloads MUST NOT contain actor overrides.

---

# RequestConsumerReplay Flow

```text
Authenticate HumanMemberPrincipal
Resolve exactly one Organization context
Load immutable source event by Organization
Load ConsumerRegistration
Load processed event, linked dead letter, and ordering state by Organization
Require processed event = Failed
Authorize the canonical replay mode against current Membership and policy
Validate expected dead-letter and ordering-state versions
Validate owning-module recovery policy, idempotency, and side-effect class

BEGIN
Create event_replay = Requested
Store requester, reason, mode, expected versions, and policy version
Append Class B durable intent audit
COMMIT

Return replayId
```

The request transaction does not change the processed-event, dead-letter, or ordering-state result. It creates durable authorized intent for asynchronous execution.

---

# Canonical Replay Modes

Application Services use exactly:

```text
RetryOriginal
ReprocessWithCurrentHandler
RebuildProjection
ValidateOnly
```

Aliases such as “Retry Original Processing” or “Reprocess With New Handler Version” are not persisted values.

---

# Replay Validation Worker

A narrowly capable System Worker may claim a `Requested` replay but cannot create or broaden it.

Before execution it revalidates current Human Identity, Membership, Organization status, permission, policy version, source Organization, ConsumerRegistration, expected versions, handler compatibility, ordering impact, and idempotency evidence.

```text
Requested -> Validating
```

Authorization or Organization failure produces `Denied`, appends the result audit, and commits no consumer or domain mutation. A stale expected version produces `Cancelled` or a typed stale-precondition result; it is not silently retried against new state.

`ValidateOnly` terminates after read-only validation. It changes only the replay record and required audit:

```text
Validating -> Completed | Failed | Denied
```

It does not acquire a processed-event claim.

---

# Replay Execution Claim

For `RetryOriginal` or `ReprocessWithCurrentHandler`, a short transaction:

```text
Lock active replay by replayId
Verify replay = Validating
Verify no other active replay for consumerName + eventId
Lock processed event and linked dead letter
Verify processed event = Failed
Verify dead-letter and ordering expected versions
Set replay = Running with workerId, lockedUntil, and claimVersion
Set processed event Failed -> Processing with the consumer claim
COMMIT
```

External work starts only after this transaction. Replay and consumer claims use database time and independent fencing fields but remain linked by replayId.

A `RebuildProjection` execution uses a dedicated rebuild session and shadow or disposable projection. It never claims the authoritative consumer processed-event row.

---

# Replay Completion Transaction

For a PostgreSQL-local domain effect, completion uses one transaction and invokes the owning module's typed handler or command. The Operations service MUST NOT update Aggregate tables directly.

```text
BEGIN
Verify replay fencing and replay = Running
Verify processed-event consumer fencing and status = Processing
Revalidate target Aggregate expected state where required
Execute owning module command
Persist Aggregate and follow-up Outbox records
Record required audit
Set processed event = Processed with stable result reference
Set dead letter = Resolved with replayId and resolution reference
Advance or unblock ordering state
Set replay = Completed with result code and reference
COMMIT
```

A stale replay claim or consumer claim returns `LeaseLost` before target mutation and commits none of these results.

For an external effect, the handler uses the registered effect ledger and provider idempotency key. Timeout or unknown provider outcome keeps the ordering key blocked until provider reconciliation or approved compensation proves the result.

---

# Replay Failure Transaction

A transient infrastructure failure schedules retry only while the replay and consumer claims remain valid and retry policy permits it.

A terminal execution failure atomically:

```text
Set processed event = Failed
Set linked dead letter = Open or Investigating
Preserve ordering block
Set replay = Failed
Store bounded error code and stable error reference
Clear replay and consumer claims
Append required operational audit or Outbox evidence
```

No failure path marks the dead letter resolved or advances ordering.

---

# SkipDeadLetter Flow

`SkipDeadLetter` requires current Human authorization, registered skip policy, expected dead-letter and ordering versions, reason, ordering-impact analysis, and required reconciliation or compensation evidence.

For Domain Coordination Consumers or irreversible Integration Consumers, absence of registered safety evidence fails closed.

The successful transaction atomically:

```text
Verify processed event = Failed
Verify linked dead letter and ordering state
Verify expected versions and current authorization
Set processed event Failed -> Skipped
Set dead letter -> Skipped
Advance or intentionally break ordering state according to policy
Append required audit and recovery Outbox evidence
COMMIT
```

There is no generic `ResolveDeadLetter` mutation. `Resolved` is derived only from a committed typed recovery outcome. A successful `ValidateOnly`, deployment, restart, lease expiry, or manual flag change is not a recovery outcome.

---

# CancelConsumerReplay

Cancellation is allowed for `Requested` or `Validating`, and for `Running` only before the owning handler or external effect begins.

Cancellation uses expected replay version and current authorization. It does not roll back committed domain or external effects. An ambiguous external outcome cannot be cancelled into safety; it requires reconciliation and remains blocked.

---

# Terminal Processed-Event Rule

`Processed` and `Skipped` are terminal. Application Services MUST NOT reset, delete, or supersede these rows for generic replay.

Re-executing an already successful authoritative consumer is outside the MVP and requires a future typed migration or compensation design.

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
- the same generation operation changes to `RetryPending` when retry budget remains
- source snapshot, policy version, and provider-input hash are reused
- a late response from a stale generation claim is discarded
- retry exhaustion changes the operation to `Failed`
- provider duplicate-call cost and timeout metrics are recorded

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

It must not move Aggregate-local rules, Domain Policies, Authorization Policies, or durable process rules into transport infrastructure.

# Security Integration

Application Services enforce authentication and invoke authorization policies before Aggregate commands are executed.

Authentication determines:

- who is making the request
- which Organization they belong to

Authorization determines:

- whether the requested operation is permitted

Aggregates assume authorization has already been verified.

Each Aggregate continues to enforce the invariants of its own state and lifecycle. Authorization, cross-Aggregate preconditions, and durable process rules remain with their explicit owners under ADR-0009.

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

The Aggregate is responsible for the business correctness of its own state transition. The Application Service remains responsible for authorization invocation, external preconditions, transaction scope, and orchestration.

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

Architecturally, the Secretary Runtime is an adapter over context-owned AI Assistance Application Ports. It may not receive a Repository, Aggregate, database connection, generic command dispatcher, unrestricted search interface, or another module's internal service.

The Secretary-facing interface contains only allowlisted advisory operations. Human-only commands are structurally absent, not merely expected to be denied at runtime. Every invocation is scoped by Organization, Secretary Principal, context, assistance operation, contract version, initiating Principal, bounded source snapshot, and provenance under ADR-0011.

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

Tests follow rule ownership: Aggregate tests cover local invariants, Domain Policy tests cover context-wide deterministic rules, Application Service tests cover orchestration and external preconditions, and integration tests verify database and delivery guarantees.

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

Application Services must not duplicate Aggregate-local transition rules or Domain Policy semantics. They may enforce documented external and cross-Aggregate preconditions that require repository facts.

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

The Application Layer owns workflow and documented external preconditions, but not Aggregate-local invariants or reusable Domain Policy semantics.

Every rule is assigned to the narrowest correct owner under ADR-0009.

---

# Architect Review

## Responsibility Separation

**Rating: ★★★★★**

Application workflow is clearly separated from domain logic.

Aggregate-local rules remain inside Aggregates; other rule classes have explicit owners and failure semantics.

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
