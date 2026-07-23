# Work Aggregate

## Purpose

The Work Aggregate represents a unit of organizational activity within AIOS.

Work is the primary place where Members collaborate, make Decisions, receive assistance from the Secretary, and produce organizational experience.

A Work Aggregate is responsible for protecting the consistency of a Work throughout its lifecycle.

---

## Aggregate Root

```text
Work
```

`Work` is the Aggregate Root.

All changes to Work-related state must be performed through the Work Aggregate.

External components must not directly modify internal entities or value objects.

---

## Identity

Each Work has a globally unique identifier.

```text
WorkId
```

A Work belongs to exactly one Organization.

The identity of a Work never changes.

---

## Responsibilities

The Work Aggregate is responsible for:

- Maintaining the Work title and description
- Managing Work participants
- Managing the Work lifecycle
- Associating Decisions with the Work
- Recording Secretary contributions
- Determining whether the Work can be completed
- Emitting domain events when important changes occur
- Preserving references required for Memory generation

The Work Aggregate is not responsible for:

- Approving Decisions
- Generating or reviewing Memory
- Creating or publishing Knowledge
- Managing Organization membership
- Evaluating Organization-level authorization policies

---

## Entities

### Work

The Aggregate Root.

Suggested attributes:

```text
Work
- id: WorkId
- organizationId: OrganizationId
- title: WorkTitle
- description: WorkDescription
- status: WorkStatus
- creatorId: MemberId
- participants: WorkParticipant[]
- decisionReferences: DecisionId[]
- secretaryContributions: SecretaryContribution[]
- createdAt: Timestamp
- updatedAt: Timestamp
- completedAt: Timestamp?
- archivedAt: Timestamp?
```

---

### WorkParticipant

Represents a Member participating in the Work.

Suggested attributes:

```text
WorkParticipant
- memberId: MemberId
- role: WorkParticipantRole
- joinedAt: Timestamp
```

A participant is identified by `MemberId` within the Work Aggregate.

The same Member cannot appear more than once in the participant list.

---

### SecretaryContribution

Represents a contribution made by the Secretary during the Work.

Examples include:

- Summaries
- Suggestions
- Drafts
- Questions
- Risk identification
- Decision-support information

Suggested attributes:

```text
SecretaryContribution
- id: SecretaryContributionId
- type: ContributionType
- content: ContributionContent
- modelVersion: ModelVersion
- promptVersion: PromptVersion
- createdAt: Timestamp
```

Secretary contributions are historical records and must not be silently overwritten.

A revised contribution must be recorded as a new contribution.

---

## Value Objects

### WorkTitle

Represents the title of a Work.

Rules:

- Must not be empty
- Must remain within the configured maximum length
- Must contain meaningful visible characters

---

### WorkDescription

Represents the purpose, context, and expected outcome of a Work.

Rules:

- May be empty during Draft
- Should be defined before completion
- Must remain within the configured maximum length

---

### WorkStatus

Possible values:

```text
Draft
InProgress
WaitingForDecision
Completed
Archived
```

Transitions are defined in:

```text
docs/architecture/state-machines/work.md
```

The Aggregate must reject invalid transitions.

---

### WorkParticipantRole

Initial roles:

```text
Owner
Contributor
Observer
```

#### Owner

May manage the Work and request lifecycle transitions.

#### Contributor

May contribute to the Work.

#### Observer

Has read-only access to the Work.

Organization-level authorization rules may further restrict these actions.

---

## Relationships

### Organization

Every Work belongs to exactly one Organization.

```text
Organization 1 ─── * Work
```

A Work cannot be transferred between Organizations.

---

### Member

A Work is created by one active Member.

A Work may contain multiple participants.

Member details are not owned by the Work Aggregate.

The Work Aggregate stores only Member identifiers and participation information.

---

### Decision

A Work may reference zero or more Decisions.

```text
Work 1 ─── * Decision
```

Decision is an independent Aggregate.

The Work Aggregate stores Decision identifiers but does not own the Decision lifecycle.

A Work may enter `WaitingForDecision` when an unresolved blocking Decision exists.

---

### Memory

A completed Work becomes the source of one Memory.

```text
Work 1 ─── 0..1 Memory
```

Memory is created outside the Work Aggregate in response to a domain event.

The Work Aggregate does not generate or store the Memory itself.

---

### Secretary

The Secretary may assist with Work but does not own or control it.

The Secretary cannot:

- Complete Work
- Archive Work
- Approve Decisions
- Change participants
- Perform human-only authorization actions

---

## Commands

The Work Aggregate may support the following domain commands:

```text
CreateWork
UpdateWorkDetails
AddParticipant
RemoveParticipant
StartWork
MarkWaitingForDecision
ResumeWork
CompleteWork
ArchiveWork
RecordSecretaryContribution
ReferenceDecision
```

Commands represent intent.

A command may be rejected when its preconditions are not satisfied.

---

## Business Rules

### Work Creation

- A Work must belong to an existing Organization.
- A Work must be created by an active Member.
- The creator becomes the initial Owner.
- A newly created Work starts in `Draft`.
- A Work must have exactly one Owner in the MVP.

---

### Participant Management

- Only active Organization Members may participate.
- A Member cannot be added more than once.
- The Work must always retain one Owner.
- The current Owner cannot be removed unless ownership is transferred first.
- Archived Work participants cannot be changed.

---

### Decision Association

- A referenced Decision must belong to the same Organization.
- A referenced Decision must belong to the same Work.
- Duplicate Decision references are not allowed.
- A blocking unresolved Decision may prevent Work completion.

Decision approval remains the responsibility of the Decision Aggregate.

---

### Work Completion

A Work may be completed only when:

- The Work is currently `InProgress`
- The Work has a title
- The Work has sufficient completion context
- No unresolved blocking Decision exists
- The requesting Member is authorized
- The Work has not already been completed or archived

Completion is irreversible in the MVP.

Completing a Work emits `WorkCompleted`.

---

### Work Archival

- Only completed Work may be archived.
- Archived Work is read-only.
- Archival must not delete historical data.
- Archived Work remains available for audit and Memory traceability.

---

### Secretary Contributions

- Every Secretary contribution must identify its model version.
- Every Secretary contribution must identify its prompt version.
- Contributions must be attributable to a specific Work.
- Secretary contributions cannot directly change Work state.
- Secretary contributions become part of the Work history used for Memory generation.

---

## Invariants

The following conditions must always remain true.

### Organization Boundary

- A Work belongs to exactly one Organization.
- All participants belong to the same Organization as the Work.
- All referenced Decisions belong to the same Organization as the Work.
- Cross-Organization references are prohibited.

---

### Ownership

- A Work has exactly one Owner in the MVP.
- The Owner is an active Organization Member.
- A Work can never exist without an Owner.

---

### Lifecycle

- Work status changes must follow the Work State Machine.
- Completed Work cannot return to an active state.
- Archived Work cannot be modified.
- `completedAt` exists only when the Work is completed or archived.
- `archivedAt` exists only when the Work is archived.

---

### Historical Integrity

- Secretary contributions are append-only.
- Decision references cannot be silently replaced.
- Completion and archival timestamps are immutable.
- Historical audit records cannot be deleted through the Work Aggregate.

---

### Completion Integrity

- A Work cannot be completed while a blocking Decision is unresolved.
- A Work can produce no more than one initial Memory.
- Memory generation must not modify the completed Work.

---

## Domain Events

The Work Aggregate may emit:

```text
WorkCreated
WorkDetailsUpdated
WorkParticipantAdded
WorkParticipantRemoved
WorkOwnershipTransferred
WorkStarted
WorkWaitingForDecision
WorkResumed
DecisionReferencedToWork
SecretaryContributionRecorded
WorkCompleted
WorkArchived
```

---

## Event Responsibilities

### WorkCreated

Indicates that a new Work has been created.

Potential consumers:

- Audit log
- Activity feed
- Notification service

---

### WorkWaitingForDecision

Indicates that progress is blocked by a Decision.

Potential consumers:

- Notification service
- Secretary
- Workflow coordination

---

### SecretaryContributionRecorded

Indicates that an AI-generated contribution has been added to the Work history.

Potential consumers:

- Audit log
- Activity feed
- Memory generation process

---

### WorkCompleted

Indicates that the Work has reached its final operational state.

Potential consumers:

- Memory generation process
- Notification service
- Analytics
- Audit log

The Work Aggregate must not create Memory directly.

---

### WorkArchived

Indicates that the Work has been moved out of active organizational activity.

Potential consumers:

- Search indexing
- Audit log
- Retention policy processes

---

## Transaction Boundary

A single transaction involving the Work Aggregate may modify:

- Work details
- Work participants
- Work status
- Decision references
- Secretary contributions

The transaction must not directly modify:

- Decision Aggregate state
- Memory Aggregate state
- Knowledge Aggregate state
- Member state
- Organization state

Cross-Aggregate coordination must occur through application services or domain events.

---

## Authorization Boundary

The Work Aggregate enforces domain-level permission preconditions such as participant role requirements.

Organization-wide authorization is evaluated before invoking the Aggregate.

Examples:

- Organization membership validation
- Organization Admin privileges
- Suspended Member restrictions

The Work Aggregate must still protect its invariants even when an application-level authorization check has already occurred.

---

## Consistency Model

The internal state of a Work is strongly consistent within the Aggregate transaction.

Relationships with independent Aggregates may be eventually consistent.

Examples:

- Memory generation after `WorkCompleted`
- Notifications after lifecycle transitions
- Search index updates
- Activity feed updates

---

## Repository Interface

A conceptual repository interface may be defined as:

```text
WorkRepository
- findById(workId): Work?
- save(work): void
- exists(workId): boolean
```

Repository implementation details belong to the infrastructure layer.

The domain model must not depend on a database or ORM.

---

## Open Questions

The following items may be refined before Blueprint v1.0.0:

- Whether ownership transfer is included in the MVP
- Whether multiple Owners should be supported after the MVP
- The exact definition of sufficient completion context
- Whether non-blocking Decisions require explicit resolution
- Maximum participant and contribution limits
- Data-retention rules for archived Work

These questions do not change the core Aggregate boundary.

---

## Related Documents

- `docs/product/mvp.md`
- `docs/product/use-cases/mvp.md`
- `docs/architecture/state-machines/work.md`
- `docs/architecture/aggregates/decision.md`
- `docs/architecture/aggregates/memory.md`
- `docs/architecture/aggregates/knowledge.md`
- `docs/architecture/authorization.md`
- `docs/glossary.md`