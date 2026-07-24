# Decision Aggregate

**Status:** Draft  
**Phase:** MVP  
**Bounded Context:** Decision Management

---

# Purpose

The Decision Aggregate models the complete lifecycle of a business decision from creation through review and final resolution.

A Decision represents a proposal that requires explicit human review before becoming an approved organizational decision.

The aggregate is responsible for maintaining the integrity of the decision lifecycle, preserving immutable review snapshots, recording review history, and ensuring that business rules are consistently enforced.

The Decision Aggregate does **not** execute business actions.

Business actions resulting from an approved decision are coordinated by the Application Layer.

---

# Responsibilities

The Decision Aggregate is responsible for:

- Managing the decision lifecycle.
- Managing editable draft revisions.
- Creating immutable submitted snapshots.
- Recording review history.
- Recording secretary contributions.
- Preserving complete audit history.
- Publishing domain events describing lifecycle changes.

---

# Non-Responsibilities

The Decision Aggregate is **not** responsible for:

- Completing Work.
- Updating Work status.
- Managing Completion Gates.
- Generating Memory.
- Promoting Knowledge.
- Managing Organizations.
- Managing Members.
- Executing workflows.
- Cross-aggregate orchestration.

Those responsibilities belong to other aggregates or to the Application Layer.

---

# Aggregate Boundary

The Decision Aggregate owns every object that participates directly in the lifecycle of a Decision.

Everything required to determine whether a Decision is internally valid must exist inside the aggregate.

The aggregate boundary guarantees transactional consistency for all decision state transitions.

---

# Aggregate Root

```
Decision
```

The Decision Aggregate Root is the single entry point for all modifications.

External systems never modify child entities directly.

---

# Aggregate Structure

```
Decision
 ├── DecisionRevision
 ├── DecisionSubmittedSnapshot
 ├── DecisionReviewRecord
 ├── DecisionSecretaryContribution
 └── DecisionActivityRecord
```

---

# Aggregate Relationships

```
Organization
      │
      │ owns
      ▼
Decision
```

A Decision belongs to exactly one Organization.

---

```
Work
  │
  │ references
  ▼
Decision
```

A Work item may reference one or more Decisions.

The Decision Aggregate does not know the internal state of Work.

---

```
Decision
      │
      │ reviewed by
      ▼
Member
```

Only Human Members review Decisions.

---

```
Decision
      │
      │ emits events
      ▼
Application Layer
```

The aggregate publishes domain events only.

The Application Layer decides how those events affect other aggregates.

---

# Lifecycle

```
Draft
    │
    ▼
InReview
 ├────────► Approved
 │
 ├────────► Rejected
 │
 └────────► Withdrawn
```

---

# State Definitions

## Draft

The Decision is editable.

The current revision may be modified freely.

Secretary suggestions may be incorporated.

No immutable review snapshot exists yet.

---

## InReview

The current revision has been submitted.

The submitted revision is immutable.

Editors cannot modify submitted content.

Only reviewers may approve, reject, or withdraw the review.

---

## Approved

The submitted revision has been approved.

The approved snapshot becomes immutable forever.

No additional edits are allowed.

Any future changes require a new Decision.

---

## Rejected

The submitted revision has been rejected.

The rejected snapshot remains immutable.

A new Draft Revision may be created.

The rejected revision itself can never be edited.

---

## Withdrawn

The submitted review has been withdrawn before approval.

The submitted snapshot remains immutable.

A new Draft Revision may be created.

---

# Decision Revision Model

Every Decision evolves through revisions.

Each revision represents one complete proposal.

Example:

```
Revision 1
Draft
      │
Submit
      │
Rejected
      │
Start Revision
      ▼
Revision 2
Draft
      │
Submit
      │
Approved
```

Older revisions remain immutable forever.

---

# Entities

## Decision

Aggregate Root.

Owns:

- lifecycle
- revisions
- review history
- secretary contributions
- activity history

Responsible for enforcing every business invariant.

---

## DecisionRevision

Represents one editable proposal.

Contains:

- title
- summary
- rationale
- proposed actions
- supporting references

Only one Draft Revision may exist at any time.

---

## DecisionSubmittedSnapshot

Represents the immutable content that reviewers actually evaluated.

Created during:

```
SubmitForReview
```

The snapshot is never modified.

---

## DecisionReviewRecord

Represents one review outcome.

Contains:

- reviewer
- decision
- timestamp
- optional comments

Review history is append-only.

---

## DecisionSecretaryContribution

Represents AI assistance.

Examples:

- draft generation
- rewrite
- summary
- formatting
- suggested rationale

Secretary contributions are advisory only.

---

## DecisionActivityRecord

Records lifecycle history.

Examples:

- created
- edited
- submitted
- approved
- rejected
- withdrawn
- revision started

Activity history is append-only.

---

# Value Objects

## DecisionStatus

Represents lifecycle state.

Possible values:

```
Draft
InReview
Approved
Rejected
Withdrawn
```

---

## ActorReference

Represents the actor responsible for an operation.

Examples:

- Human Member
- Secretary
- System

Authorization rules determine which actor may execute each command.

---

## DecisionContent

Represents the complete business content of a revision.

Includes:

- title
- summary
- rationale
- proposal
- references

Validation occurs inside the aggregate.

---

## ReviewOutcome

Represents the result of a review.

Possible values:

```
Approved
Rejected
Withdrawn
```

Review outcomes are immutable once recorded.

---
# Commands

Every modification of the Decision Aggregate must occur through an explicit command.

Commands enforce business rules and preserve aggregate consistency.

---

## CreateDecision

Creates a new Decision.

Preconditions

- Organization exists.
- Creator is authorized.
- Initial content is valid.

Result

- Decision created.
- Initial Draft Revision created.
- Activity recorded.

---

## EditDraft

Updates the active Draft Revision.

Allowed only when:

- Decision status is Draft.

Not allowed when:

- InReview
- Approved
- Rejected
- Withdrawn

Result

- Draft updated.
- Activity recorded.

---

## RecordSecretaryContribution

Records advisory assistance generated by the Secretary.

Examples

- draft proposal
- rewrite
- summary
- suggested rationale
- formatting improvements

Secretary contributions never modify the Decision directly.

The Human Member decides whether to incorporate them.

Result

- Contribution recorded.
- Activity recorded.

---

## SubmitForReview

Submits the current Draft Revision for review.

Preconditions

- Status is Draft.
- Draft passes validation.
- Required fields are complete.

Behavior

- Immutable Submitted Snapshot created.
- Status becomes InReview.
- Activity recorded.

Result

- DecisionSubmitted event emitted.

---

## ApproveDecision

Approves the submitted revision.

Preconditions

- Status is InReview.
- Reviewer is authorized.

Behavior

- Review record appended.
- Status becomes Approved.
- Activity recorded.

Result

- DecisionApproved event emitted.

The Decision Aggregate does not update Work.

---

## RejectDecision

Rejects the submitted revision.

Preconditions

- Status is InReview.
- Reviewer is authorized.

Behavior

- Review record appended.
- Status becomes Rejected.
- Activity recorded.

Result

- DecisionRejected event emitted.

---

## WithdrawDecision

Withdraws the submitted review.

Preconditions

- Status is InReview.
- Request initiated by an authorized Human Member.

Behavior

- Status becomes Withdrawn.
- Activity recorded.

The submitted snapshot remains immutable.

---

## StartRevision

Creates a new Draft Revision.

Allowed only when:

- Status is Rejected
- Status is Withdrawn

Behavior

- New Draft Revision created.
- Previous revisions remain immutable.
- Status becomes Draft.
- Activity recorded.

Result

- DecisionRevisionStarted event emitted.

---

# Business Rules

The following rules define the behavior of the Decision Aggregate.

---

## Rule 1

A Decision always belongs to exactly one Organization.

---

## Rule 2

Exactly one active Draft Revision may exist.

---

## Rule 3

Only the active Draft Revision is editable.

---

## Rule 4

Submitted Snapshots are immutable.

They represent exactly what reviewers evaluated.

---

## Rule 5

Approval always applies to the submitted snapshot.

Approval never applies to the editable draft.

---

## Rule 6

Rejected revisions remain immutable forever.

A rejected revision is historical evidence.

It cannot be edited.

---

## Rule 7

Withdrawn revisions remain immutable forever.

A withdrawn review preserves historical traceability.

---

## Rule 8

A new revision is created after rejection or withdrawal.

Previous revisions are never reused.

---

## Rule 9

Only Human Members may:

- submit
- approve
- reject
- withdraw

The Secretary cannot execute these actions.

---

## Rule 10

Secretary contributions are advisory.

They never become Decision content automatically.

---

## Rule 11

Every lifecycle transition is recorded.

Decision history is append-only.

---

## Rule 12

Every review produces exactly one Review Record.

Review records cannot be modified.

---

## Rule 13

The Decision Aggregate never changes Work.

Cross-aggregate coordination belongs to the Application Layer.

---

## Rule 14

Decision approval never completes Work.

Approval only communicates review outcome.

---

## Rule 15

Decision approval may trigger downstream processing through Domain Events.

The aggregate itself performs no orchestration.

---

# Aggregate Invariants

The following conditions must always be true.

---

## Invariant 1

The aggregate has exactly one identity.

---

## Invariant 2

The aggregate belongs to exactly one Organization.

---

## Invariant 3

At most one Draft Revision exists.

---

## Invariant 4

At most one submitted revision is under review.

---

## Invariant 5

Approved Decisions are immutable.

---

## Invariant 6

Submitted Snapshots are immutable.

---

## Invariant 7

Review history is append-only.

---

## Invariant 8

Activity history is append-only.

---

## Invariant 9

Secretary Contributions are append-only.

---

## Invariant 10

Every Submitted Snapshot belongs to exactly one Revision.

---

## Invariant 11

A Revision can produce at most one Submitted Snapshot.

---

## Invariant 12

A Review Record always references one immutable Submitted Snapshot.

---

## Invariant 13

The aggregate never references Work state.

Only external identifiers may be stored when necessary.

---

## Invariant 14

The aggregate never references Memory.

Memory is managed independently.

---

# Lifecycle Constraints

The following transitions are permitted.

```
Draft
    │ Submit
    ▼
InReview
 ├────────► Approved
 ├────────► Rejected
 └────────► Withdrawn
```

---

From Approved

No further transitions are allowed.

The lifecycle is terminal.

---

From Rejected

Only:

```
StartRevision
```

is allowed.

---

From Withdrawn

Only:

```
StartRevision
```

is allowed.

---

A Draft Revision created by StartRevision is independent from previous revisions.

Historical revisions remain immutable.

---

# Revision Model

Example

```
Revision 1

Draft
   │
Submit
   │
Rejected

Revision 2

Draft
   │
Submit
   │
Approved
```

The Decision Aggregate preserves every revision permanently.

No revision is ever deleted.

No historical snapshot is ever modified.
# Domain Events

The Decision Aggregate publishes domain events describing lifecycle changes.

Domain events are immutable facts.

They do not contain business behavior.

Business behavior is coordinated by the Application Layer.

---

## DecisionCreated

Published when a new Decision is created.

Payload

- decisionId
- organizationId
- createdBy
- createdAt

---

## DecisionDraftEdited

Published when the active Draft Revision changes.

Payload

- decisionId
- revisionNumber
- editedBy
- editedAt

---

## SecretaryContributionRecorded

Published when the Secretary provides advisory assistance.

Payload

- decisionId
- contributionId
- contributionType
- recordedAt

---

## DecisionSubmitted

Published when a Draft Revision is submitted for review.

Payload

- decisionId
- revisionNumber
- submittedSnapshotId
- submittedBy
- submittedAt

---

## DecisionApproved

Published when a submitted revision is approved.

Payload

- decisionId
- revisionNumber
- approvedBy
- approvedAt

---

## DecisionRejected

Published when a submitted revision is rejected.

Payload

- decisionId
- revisionNumber
- rejectedBy
- rejectedAt

---

## DecisionWithdrawn

Published when a submitted revision is withdrawn.

Payload

- decisionId
- revisionNumber
- withdrawnBy
- withdrawnAt

---

## DecisionRevisionStarted

Published when a new Draft Revision is created.

Payload

- decisionId
- revisionNumber
- createdBy
- createdAt

---

# Transaction Boundary

Every command executes inside a single transaction.

The transaction includes:

- Aggregate validation
- Aggregate mutation
- Domain Event creation
- Outbox persistence

The transaction ends only after all changes have been committed successfully.

---

```
┌─────────────────────────────┐
│ Decision Aggregate          │
│                             │
│ Validation                  │
│ State Change                │
│ Domain Event                │
│ Outbox Write                │
└──────────────┬──────────────┘
               │ Commit
               ▼
        Transaction Complete
```

---

The aggregate never communicates directly with:

- Work
- Memory
- External Services
- Message Brokers

Those responsibilities belong outside the transaction boundary.

---

# Transactional Outbox

Every published Domain Event must be written to the Transactional Outbox.

The Aggregate never publishes events directly.

Example

```
ApproveDecision()

        │
        ▼

DecisionApproved

        │
        ▼

Transactional Outbox

        │
 Commit Transaction
        │
        ▼

Background Worker

        │
        ▼

Event Bus
```

This guarantees:

- atomic persistence
- reliable delivery
- retry support
- eventual consistency

---

# Authorization Boundary

Authorization is enforced before executing aggregate commands.

The aggregate assumes authorization has already been verified.

Business invariants remain enforced inside the aggregate.

---

## Human Member

Human Members may

- create Decisions
- edit Drafts
- submit for review
- approve
- reject
- withdraw
- start new revisions

Human Members are the only actors with decision authority.

---

## Secretary

The Secretary may

- generate drafts
- suggest edits
- summarize
- rewrite
- improve formatting
- provide rationale suggestions

The Secretary may never

- approve
- reject
- submit
- withdraw
- change lifecycle state

Secretary authority is advisory only.

---

## System

The System may

- publish events
- dispatch outbox messages
- maintain audit information

The System never performs business decisions.

---

# Repository Interface

The repository persists the entire Decision Aggregate.

Example

```text
DecisionRepository

save(decision)

findById(id)

exists(id)
```

Repositories never expose child entities independently.

Only Aggregate Roots are persisted.

---

# Application Services

Application Services coordinate multiple aggregates.

They contain workflow orchestration.

Business invariants remain inside aggregates.

---

## Example

Decision Approval

```
Human Member
       │
Approve Decision
       │
       ▼
Decision Aggregate
       │
DecisionApproved
       │
       ▼
Application Service
       │
RecordDecisionOutcome
       │
       ▼
Work Aggregate
```

Notice that the Decision Aggregate never calls the Work Aggregate.

---

## Example

Rejected Decision

```
DecisionRejected
       │
       ▼
Application Service
       │
Notify Work
       │
       ▼
Completion Gate
```

The Application Layer decides whether Work should remain blocked.

The Decision Aggregate has no knowledge of Completion Gates.

---

## Example

Approved Decision

```
DecisionApproved
        │
        ▼
Application Service
        │
RecordDecisionOutcome(workId)
        │
        ▼
Work Aggregate
```

The Decision Aggregate does not know:

- Work Status
- Completion Gate
- Memory
- Knowledge

---

# Cross-Aggregate Coordination

The following responsibilities belong exclusively to the Application Layer.

- locating related aggregates
- loading multiple aggregates
- coordinating transactions
- handling retries
- publishing integration events
- invoking background processes

Aggregates never coordinate each other directly.

---

# Aggregate Independence

The Decision Aggregate can be implemented, tested, and evolved independently.

It depends on no other aggregate for correctness.

All external interactions occur through Domain Events.

This preserves loose coupling and enables future scalability.
# Consistency Model

The Decision Aggregate provides strong consistency inside its own transaction boundary.

The following changes are committed atomically:

- Decision state
- active revision
- submitted snapshot
- review record
- activity record
- domain events
- outbox records

If any operation fails, the entire transaction is rolled back.

---

## Internal Consistency

All invariants owned by the Decision Aggregate are enforced synchronously.

Examples:

- only Draft content is editable
- only InReview Decisions may be approved
- submitted snapshots are immutable
- only one active review may exist
- terminal Approved Decisions cannot change

The aggregate must never be persisted in an invalid state.

---

## Cross-Aggregate Consistency

Consistency between Decision and Work is eventual.

Example:

```text
Decision Approved
        │
        ▼
Decision transaction committed
        │
        ▼
DecisionApproved stored in Outbox
        │
        ▼
Background Worker publishes event
        │
        ▼
Application Handler processes event
        │
        ▼
Work records Decision outcome
```

A short delay may exist between Decision approval and the corresponding Work update.

This delay is expected behavior.

---

## Source of Truth

The Decision Aggregate is the source of truth for:

- Decision lifecycle
- Decision revisions
- submitted snapshots
- review outcomes
- Decision audit history

The Work Aggregate is the source of truth for:

- Work lifecycle
- Completion Gate
- blocking Decision reference
- recorded Decision outcome
- explicit Work completion

Neither aggregate derives or overwrites the other aggregate's authoritative state.

---

# Concurrency Control

The Decision Aggregate uses optimistic concurrency control.

Each persisted aggregate contains a version number.

Example:

```text
Decision
- decisionId
- version
- status
- revisions
- reviewHistory
```

When saving:

```text
UPDATE decisions
SET ...
    version = version + 1
WHERE decision_id = :decisionId
  AND version = :expectedVersion
```

If no row is updated, a concurrency conflict has occurred.

---

## Concurrency Conflict Behavior

When a conflict occurs:

- the transaction is rolled back
- no outbox event is committed
- the caller receives a conflict result
- the latest aggregate state must be reloaded
- the command may be retried only after revalidation

Commands must not overwrite concurrent changes silently.

---

## Concurrent Draft Edits

Two Humans may attempt to edit the same Draft.

Only the first successfully committed edit is accepted.

The second edit receives a concurrency conflict.

The user must review the latest Draft before retrying.

---

## Concurrent Review Outcomes

Two reviewers may attempt to resolve the same InReview Decision.

Example:

```text
Reviewer A -> ApproveDecision
Reviewer B -> RejectDecision
```

Only one transition may commit.

After the first transition:

```text
InReview -> Approved
```

or:

```text
InReview -> Rejected
```

The second command fails because:

- the aggregate version changed, or
- the Decision is no longer InReview

Exactly one final outcome is recorded.

---

# Idempotency

Commands and event handlers must support safe retry behavior.

Network failures may occur after a transaction commits but before the caller receives confirmation.

The same request may therefore be delivered more than once.

---

## Command Idempotency

State-changing requests should include an idempotency key.

Example:

```text
commandId
organizationId
decisionId
commandType
```

The Application Layer records processed command identifiers.

Repeated delivery of the same command must not:

- create duplicate revisions
- create duplicate snapshots
- append duplicate review records
- append duplicate activities
- emit duplicate logical outcomes

---

## Review Idempotency

Approval, rejection, and withdrawal requests require particular care.

A repeated command with the same command identifier returns the previously committed result.

A different command requesting a second review outcome fails because the Decision is no longer InReview.

---

## Event Handler Idempotency

Outbox delivery is at least once.

Consumers must assume that events can be delivered repeatedly.

Handlers should record:

```text
consumerName
eventId
processedAt
```

Before applying an event, the handler checks whether that event has already been processed.

---

## Logical Event Identity

Every domain event contains:

- eventId
- eventType
- aggregateId
- aggregateVersion
- organizationId
- occurredAt
- correlationId
- causationId

These fields support:

- deduplication
- tracing
- ordering diagnostics
- audit reconstruction

---

# Event Ordering

Events from the same Decision are processed in aggregate-version order.

Example:

```text
Version 1 -> DecisionCreated
Version 2 -> DecisionDraftEdited
Version 3 -> DecisionSubmitted
Version 4 -> DecisionApproved
```

Consumers must not apply an older aggregate version after a newer version has already been processed.

Ordering across different Decisions is not guaranteed or required.

---

# Failure Semantics

Failures are classified by where they occur.

---

## Validation Failure

Examples:

- required content is missing
- rationale is empty
- no active Draft exists
- invalid revision number

Result:

- command rejected
- no state change
- no event created
- no outbox record created

---

## Authorization Failure

Examples:

- Secretary attempts approval
- unauthorized Member submits a Decision
- reviewer belongs to another Organization

Result:

- command is not executed
- aggregate is not mutated
- security event may be recorded outside the aggregate

---

## Concurrency Failure

A stale aggregate version is detected.

Result:

- transaction rolled back
- caller receives conflict response
- no partial changes remain

---

## Persistence Failure

The database fails while saving the aggregate or outbox records.

Result:

- transaction rolled back
- Decision remains unchanged
- command may be retried safely

---

## Outbox Publication Failure

The Decision transaction has committed, but the Background Worker cannot publish the event.

Result:

- Decision remains committed
- outbox record remains pending
- publication is retried
- Work may temporarily retain its previous Decision outcome

The Decision transaction is never reversed because event delivery is delayed.

---

## Downstream Processing Failure

The event is published, but the Work outcome handler fails.

Result:

- Decision remains Approved, Rejected, or Withdrawn
- event processing is retried
- failure does not alter Decision history
- Work is updated only after successful handler execution

---

## Poison Event Handling

If repeated processing fails:

- retry count is recorded
- error details are retained
- the event is moved to a failed-processing state
- operational alerts are raised
- manual recovery remains possible

A poison event must not block unrelated events indefinitely.

---

# Audit Requirements

The Decision Aggregate preserves a complete and explainable history.

Audit information must answer:

- who created the Decision
- who edited each Draft
- what content was submitted
- when the submission occurred
- who approved, rejected, or withdrew it
- what rationale accompanied the outcome
- which Secretary contributions were provided
- which revision became final
- which command and event caused each transition

---

## Immutable Audit Evidence

The following records are append-only:

- Submitted Snapshots
- Review Records
- Secretary Contributions
- Activity Records
- Domain Events

Approved, rejected, and withdrawn review evidence must never be overwritten.

---

## Submitted Content Integrity

A Submitted Snapshot contains the complete reviewable content.

It must not depend on mutable Draft data for reconstruction.

The snapshot should include:

- revision number
- title
- summary
- rationale
- proposal
- supporting references
- submitter
- submission timestamp
- content schema version

Optional integrity metadata may include:

```text
contentHash
```

The hash helps detect accidental mutation or corruption.

---

## Activity Record Shape

An Activity Record may contain:

```text
activityId
decisionId
revisionNumber
activityType
actorReference
occurredAt
commandId
correlationId
metadata
```

Metadata must not replace explicit domain fields.

Critical business facts remain strongly typed.

---

# Data Retention

Decision history is organizational evidence.

Within the MVP:

- Decisions are not physically deleted
- submitted snapshots are retained
- review records are retained
- activity records are retained
- Secretary contributions are retained according to policy

Deletion and archival policies require a separate retention design.

They are outside the Decision lifecycle.

---

# Privacy and Sensitive Data

Decision content may contain confidential organizational information.

The implementation must support:

- Organization-level isolation
- authorization checks
- encrypted transport
- encrypted storage where required
- restricted audit access
- sensitive logging controls

Domain event payloads should include only information required by consumers.

Full Decision content should not be copied into integration events unless explicitly necessary.

---

# Observability

The implementation should expose operational metrics for:

- Decisions created
- Decisions submitted
- Decisions approved
- Decisions rejected
- Decisions withdrawn
- concurrency conflicts
- pending outbox records
- publication retries
- failed event handlers
- event processing latency

Logs should include:

- decisionId
- organizationId
- commandId
- eventId
- correlationId
- aggregateVersion

Decision content must not be logged indiscriminately.

---

# Testing Strategy

The Decision Aggregate should be tested independently from infrastructure.

---

## Unit Tests

Unit tests cover:

- valid state transitions
- invalid state transitions
- revision creation
- Draft editing
- snapshot immutability
- review authorization assumptions
- terminal state behavior
- emitted Domain Events
- Aggregate Invariants

---

## Required Lifecycle Tests

At minimum:

```text
Create -> Draft
Draft -> Edit
Draft -> Submit -> InReview
InReview -> Approve -> Approved
InReview -> Reject -> Rejected
Rejected -> StartRevision -> Draft
InReview -> Withdraw -> Withdrawn
Withdrawn -> StartRevision -> Draft
```

---

## Required Negative Tests

At minimum:

- editing while InReview fails
- editing an Approved Decision fails
- approving a Draft fails
- rejecting a Draft fails
- submitting an incomplete Draft fails
- starting a revision from Approved fails
- editing a rejected snapshot fails
- creating a second active Draft fails
- resolving the same review twice fails
- Secretary review authority is denied by the Application Layer

---

## Integration Tests

Integration tests cover:

- aggregate persistence
- optimistic concurrency
- aggregate and outbox atomicity
- outbox retry behavior
- event deduplication
- Work outcome coordination
- Organization isolation

---

## Contract Tests

Event contract tests verify:

- event names
- payload fields
- schema compatibility
- aggregate version
- correlation metadata
- backward-compatible evolution

---

# Implementation Guidance

Recommended persistence model:

```text
decisions
decision_revisions
decision_submitted_snapshots
decision_review_records
decision_secretary_contributions
decision_activity_records
outbox_messages
processed_commands
processed_events
```

The exact schema may differ.

The domain model remains the authority for invariants.

Database constraints provide additional protection but do not replace aggregate behavior.

---

## Recommended Database Constraints

Examples:

- unique Decision identity
- unique revision number per Decision
- unique snapshot per revision
- unique processed command identifier
- unique processed event per consumer
- non-null Organization ownership
- optimistic version constraint

Partial unique indexes may be used to protect active lifecycle records where appropriate.

---

# MVP Exclusions

The following capabilities are outside the Decision Aggregate MVP:

- automated AI approval
- Secretary approval authority
- multi-stage approval chains
- weighted voting
- quorum rules
- delegation workflows
- approval expiration
- scheduled approval
- Decision archival lifecycle
- modifying Approved Decisions
- direct Work completion
- direct Memory creation
- Knowledge promotion
- Evidence management
- Capability management
- marketplace integrations

These may be introduced in later phases through explicit architecture changes.

---

# Design Summary

The Decision Aggregate guarantees that:

- every Decision belongs to one Organization
- Draft content is editable
- submitted content is immutable
- review outcomes are Human-authorized
- rejected and withdrawn submissions remain historical evidence
- revisions preserve full history
- Secretary contributions remain advisory
- approval never completes Work
- Work coordination occurs through the Application Layer
- state changes and outbox writes are atomic
- downstream processing is retryable and idempotent

---

# Architect Review

## Aggregate Boundary

**Rating: ★★★★★**

The aggregate owns only the lifecycle and evidence required to make a Decision internally consistent.

Work, Memory, Organization membership, and orchestration remain outside the boundary.

---

## Domain Model

**Rating: ★★★★★**

The revision and submitted-snapshot model clearly separates editable proposals from immutable review evidence.

Rejected and withdrawn outcomes retain historical integrity.

---

## Human Authority

**Rating: ★★★★★**

Human Members retain all business authority.

The Secretary may draft, summarize, rewrite, and suggest, but cannot submit, approve, reject, or withdraw Decisions.

---

## Work Separation

**Rating: ★★★★★**

Decision approval records an outcome only.

It does not complete Work or directly change the Completion Gate.

Application Services coordinate the resulting Work update.

---

## Transaction and Event Reliability

**Rating: ★★★★★**

Aggregate persistence and outbox persistence share one transaction.

At-least-once delivery is supported through consumer idempotency and retry handling.

---

## Auditability

**Rating: ★★★★★**

Immutable snapshots, append-only review records, revision history, actor references, command identifiers, and correlation metadata provide strong organizational traceability.

---

## MVP Alignment

**Rating: ★★★★★**

The design includes only the Decision capabilities required for the MVP.

Advanced voting, delegated authority, Knowledge promotion, and AI decision authority remain explicitly excluded.

---

## Final Assessment

```text
Architecture Quality:        ★★★★★
Domain Consistency:          ★★★★★
Human Authority Model:       ★★★★★
Auditability:                ★★★★★
Implementation Readiness:    ★★★★★
MVP Scope Discipline:        ★★★★★
```

The Decision Aggregate is ready for implementation within the AIOS Modular Monolith.

It is consistent with:

- Decision State Machine
- Work Aggregate
- Memory Aggregate
- explicit Human Work completion
- Completion Gate ownership
- Transactional Outbox
- Background Worker delivery
- asynchronous cross-aggregate coordination

**Architect Review Result: APPROVED**