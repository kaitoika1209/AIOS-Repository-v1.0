# Work Aggregate
> **Document status:** Proposed · **Blueprint version:** 0.2.1 · **Applies to:** Work Management
## Purpose
The Work Aggregate represents one Organization-owned unit of activity performed toward an intended outcome.
It preserves:
- what the Work is intended to achieve;
- who created and participates in it;
- who is responsible for it;
- its current lifecycle state;
- progress and activity history;
- its local Decision completion gate;
- explicit completion or cancellation;
- Secretary contributions; and
- the durable business fact that may trigger Memory generation.
The Work Aggregate is the sole owner of Work lifecycle state.
The central rule is:
> A Decision may satisfy a completion gate, but only an explicit Work command from an authorized Human Member may complete the Work.
Decision approval never completes Work automatically.
---
# Aggregate Root
```text
Work
```
`Work` is the Aggregate Root.
All state changes and all modifications to Work-owned data must occur through the Aggregate.
External components must not directly modify:
- Work status;
- title or description;
- intended outcome;
- assignments;
- participant references;
- progress history;
- blocking Decision reference;
- completion gate;
- completion record;
- cancellation record;
- Secretary contributions;
- activity history; or
- Aggregate version.
---
# Aggregate Boundary
The Work Aggregate owns:
- one Work identity;
- one Organization reference;
- one creator reference;
- current Work status;
- Work details;
- intended outcome;
- assignment records;
- participant references;
- progress records;
- Secretary contributions;
- current completion-gate snapshot;
- current blocking Decision reference;
- recorded blocking Decision outcomes;
- completion record;
- cancellation record;
- lifecycle timestamps;
- activity history; and
- Aggregate version.
The Work Aggregate does not own:
- Organization;
- Member;
- Secretary;
- Decision;
- Memory;
- generation-job state;
- notifications;
- search projections;
- Knowledge;
- workflow templates; or
- archival policy.
Only Work-owned objects may change in one Work transaction.
---
# Identity and Ownership
Each Work has a globally unique:
```text
WorkId
```
A Work belongs to exactly one Organization.
Suggested identity fields:
```text
Work
- id: WorkId
- organizationId: OrganizationId
- creatorId: HumanMemberId
```
`WorkId`, `OrganizationId`, and `creatorId` are immutable after creation.
A Work cannot be transferred to another Organization.
---
# Responsibilities
The Work Aggregate manages lifecycle, details, assignments, participants, attributable progress, Secretary contributions, one local blocking-Decision gate, authoritative Decision outcomes, explicit completion or cancellation, local invariants, Domain Events, terminal immutability, and audit history.
It does not own Decision review, Organization authorization, Member lifecycle, Memory generation or uniqueness, AI-provider execution, arbitrary workflow design, notification delivery, or archival policy.
# Suggested Aggregate Structure
```text
Work
- id, organizationId, creatorId
- status, details
- assignments, participants
- progressHistory, secretaryContributions
- completionGate, blockingDecisionId
- decisionOutcomeHistory
- completionRecord, cancellationRecord
- activityHistory
- createdAt, updatedAt, startedAt
- aggregateVersion
```
# Entities and Records
## WorkAssignment
Represents active responsibility assigned to a Human Member.
```text
WorkAssignment
- memberId: HumanMemberId
- assignmentType: AssignmentType
- assignedBy: HumanMemberId
- assignedAt: Timestamp
```
Rules:
- a Member appears at most once per active assignment type;
- only non-terminal Work may change assignments;
- assignment history is auditable; and
- assignment does not itself grant Organization permission.
## WorkParticipant
Represents a Human Member participating in the Work without necessarily owning responsibility.
```text
WorkParticipant
- memberId: HumanMemberId
- addedBy: HumanMemberId
- addedAt: Timestamp
```
Rules:
- duplicate active participant references are rejected;
- only non-terminal Work may change participants; and
- participant history remains traceable.
## WorkProgressRecord
Represents an attributable progress update.
```text
WorkProgressRecord
- id: WorkProgressRecordId
- actor: ActorReference
- content: ProgressContent
- createdAt: Timestamp
```
Progress records are append-only.
A progress update does not change Work state unless a separate lifecycle command succeeds.
## WorkSecretaryContribution
Represents AI assistance related to the Work.
Examples include draft descriptions, progress summaries, risk identification, next-action suggestions, Decision preparation, and completion-summary preparation.
```text
WorkSecretaryContribution
- id: SecretaryContributionId
- secretaryId: SecretaryId
- contributionType: ContributionType
- contentReference: ContributionContentReference
- modelVersion: ModelVersion
- promptVersion: PromptVersion?
- sourceReferenceIds: SourceReferenceId[]
- createdAt: Timestamp
```
Secretary contributions are append-only and advisory.
They never represent human authority.
## WorkDecisionOutcomeRecord
Stores the authoritative outcome applied to the local completion gate.
```text
WorkDecisionOutcomeRecord
- decisionId: DecisionId
- outcome: Approved | Rejected | Withdrawn
- originatingHumanActorId: HumanMemberId
- decisionResolvedAt: Timestamp
- processedBy: SystemPrincipalId?
- processedAt: Timestamp
- sourceEventId: EventId
```
Rules:
- records are append-only;
- one `sourceEventId` is applied at most once;
- the Decision remains authoritative for its own content and history; and
- this record exists only to enforce Work-local completion rules.
## WorkCompletionRecord
```text
WorkCompletionRecord
- completedBy: HumanMemberId
- completedAt: Timestamp
- completionSummary: CompletionSummary?
```
Rules:
- created only by `CompleteWork`;
- immutable after creation;
- exists only when status is `Completed`; and
- cannot coexist with a cancellation record.
## WorkCancellationRecord
```text
WorkCancellationRecord
- cancelledBy: HumanMemberId
- reason: CancellationReason
- cancelledAt: Timestamp
```
Rules:
- created only by `CancelWork`;
- reason is required;
- immutable after creation;
- exists only when status is `Cancelled`; and
- cannot coexist with a completion record.
## WorkActivityRecord
An append-only record of meaningful Work changes.
```text
WorkActivityRecord
- id: WorkActivityRecordId
- actor: ActorReference
- action: WorkActivityType
- occurredAt: Timestamp
- metadata: ActivityMetadata?
```
Activity history must distinguish human, AI, and system actions.
---
# Value Objects
## WorkStatus
```text
Draft
InProgress
WaitingForDecision
Completed
Cancelled
```
Transitions are defined in:
```text
docs/architecture/state-machines/work.md
```
All other transitions are rejected.
## WorkDetails
```text
WorkDetails
- title: WorkTitle
- description: WorkDescription
- intendedOutcome: IntendedOutcome
- context: WorkContext
```
Rules:
- title and intended outcome are required before start;
- editable only while state permits;
- immutable after completion or cancellation; and
- changes are attributable.
## CompletionGate
```text
NotRequired
Pending(decisionId)
Satisfied(decisionId, approvedAt, approvedBy)
Unsatisfied(decisionId, outcome, resolvedAt, resolvedBy)
```
The completion gate is a local snapshot.
It is not the source of truth for Decision content or review history.
Rules:
- `WaitingForDecision` requires `Pending`;
- `Pending` identifies exactly one blocking Decision;
- `Satisfied` requires an Approved Decision outcome;
- `Unsatisfied` requires Rejected or Withdrawn;
- completion is prohibited while `Pending` or required-but-`Unsatisfied`; and
- Decision outcome application is idempotent.
## ActorReference
```text
ActorReference
- actorType: HumanMember | AIPrincipal | SystemPrincipal
- actorId: ActorId
```
Only Human Members may start, complete, or cancel Work.
System Principals may apply authoritative Decision outcomes.
AI Principals may assist but cannot change lifecycle state.
---
# Commands
The Aggregate may support:
```text
CreateWork
UpdateWorkDetails
AssignMember
UnassignMember
AddParticipant
RemoveParticipant
RecordProgress
RecordSecretaryContribution
StartWork
RequestBlockingDecision
RecordDecisionOutcome
CompleteWork
CancelWork
```
There is no MVP command for:
```text
ArchiveWork
ReopenCompletedWork
ReopenCancelledWork
CompleteWorkFromDecision
```
Archival is outside the business lifecycle.
Terminal Work cannot be reopened in the MVP.
---
# Command Behavior
## CreateWork
Creates Work in `Draft`.
Application-level preconditions include:
- Organization exists;
- creator is an active Human Member;
- creator is authorized; and
- required initial values are valid.
Aggregate effects:
- assign identity and ownership;
- set status to `Draft`;
- initialize completion gate;
- record creation activity; and
- emit `WorkCreated`.
## UpdateWorkDetails
Rules:
- Work must be `Draft` or `InProgress`;
- actor must be an authorized Human Member;
- updated values must remain valid;
- terminal Work cannot change; and
- `WorkDetailsUpdated` is emitted when meaningful details change.
Limited contextual updates during `WaitingForDecision` may be allowed only when they do not alter the submitted Decision or completion gate.
## AssignMember and UnassignMember
Rules:
- Work must be non-terminal;
- actor must be an authorized Human Member;
- target Member reference is validated by the Application Layer;
- duplicate active assignments are rejected;
- required responsibility rules remain satisfied; and
- assignment changes are audited.
## AddParticipant and RemoveParticipant
Rules:
- Work must be non-terminal;
- duplicate active participants are rejected;
- Organization membership is validated outside the Aggregate; and
- changes are audited.
## RecordProgress
Rules:
- Work must be `InProgress` or `WaitingForDecision`;
- actor must be attributable;
- record is append-only; and
- progress alone never completes Work.
## RecordSecretaryContribution
Rules:
- Work must not be terminal;
- Secretary and model attribution are present;
- contribution is append-only;
- contribution alone cannot change Work state; and
- applying suggested content requires an explicit human-authorized command.
## StartWork
Transition:
```text
Draft → InProgress
```
Rules:
- only an authorized Human Member may start;
- title and intended outcome are valid;
- required responsibility data is present;
- `startedAt` is recorded once; and
- `WorkStarted` is emitted.
## RequestBlockingDecision
Transition:
```text
InProgress → WaitingForDecision
```
Rules:
- only an authorized Human Member may request;
- no unresolved blocking Decision already exists;
- `decisionId` is supplied by coordinated Decision creation or submission;
- completion gate becomes `Pending(decisionId)`;
- `blockingDecisionId` is recorded; and
- `WorkDecisionRequested` is emitted.
The Work Aggregate does not create the Decision.
## RecordDecisionOutcome
Transition:
```text
WaitingForDecision → InProgress
```
Rules:
- matching blocking `decisionId` is required;
- outcome comes from an authoritative Decision event;
- source event has not already been applied;
- Approved sets the gate to `Satisfied`;
- Rejected or Withdrawn sets the gate to `Unsatisfied`;
- outcome history is appended;
- blocking reference is cleared; and
- `WorkDecisionOutcomeRecorded` is emitted.
The technical processor must preserve the originating Human Member separately from the System Principal that applies the event.
## CompleteWork
Transition:
```text
InProgress → Completed
```
Rules:
- only an authorized Human Member may complete;
- no blocking Decision is pending;
- completion gate is `NotRequired` or `Satisfied`;
- required completion data is present;
- completion record is created;
- business content becomes immutable;
- one `WorkCompleted` event is emitted; and
- the event is persisted durably.
Decision approval never invokes this command implicitly.
## CancelWork
Transitions:
```text
Draft → Cancelled
InProgress → Cancelled
WaitingForDecision → Cancelled
```
Rules:
- only an authorized Human Member may cancel;
- reason is required;
- cancellation record is created;
- existing Decision history is preserved;
- Work becomes immutable; and
- `WorkCancelled` is emitted.
Cancellation does not withdraw or cancel a Decision automatically.
---
# Business Rules
## Work Start
Work starts only through explicit human action.
AI recommendation, assignment creation, elapsed time, or external activity cannot infer that Work started.
## Blocking Decision
For the MVP:
- one unresolved blocking Decision may exist at a time;
- non-blocking Decisions may also relate to the Work;
- only a submitted unresolved blocking Decision should place Work in `WaitingForDecision`;
- Work returns to `InProgress` after an authoritative outcome is recorded; and
- the resulting gate determines whether completion is allowed.
## Work Completion
Completion is an explicit business judgment by an authorized Human Member.
Completion is not inferred from:
- Decision approval;
- progress percentage;
- due date;
- Secretary recommendation;
- external event delivery; or
- Memory generation success.
## Work Cancellation
Cancellation is explicit, reasoned, and terminal.
Cancelled Work does not generate Memory in the MVP.
A future phase may define a separate learning record for cancelled Work.
## Terminal Immutability
`Completed` and `Cancelled` Work are immutable for business data.
Read models may hide or archive terminal Work without changing its business status.
---
# Relationships
## Organization
Every Work belongs to exactly one Organization.
Organization is the ownership and authorization scope.
The Work Aggregate stores `OrganizationId` but does not own Organization state.
## Member
Work stores Human Member identifiers for:
- creator;
- assignments;
- participants;
- completion actor;
- cancellation actor; and
- originating Decision actors.
Member lifecycle and permissions remain outside the Aggregate.
## Decision
```text
Work 1 ─── * Decision
```
Decision owns proposal, review, selected option, rationale, and resolution.
Work owns:
- `WaitingForDecision`;
- local completion gate;
- blocking Decision reference;
- recorded Decision outcome; and
- explicit Work completion.
Decision never directly modifies Work state.
## Memory
```text
Work 1 ─── 0..1 Memory
```
Successful Work completion emits `WorkCompleted`.
A downstream process may then generate Memory.
The Work Aggregate does not:
- create Memory;
- guarantee generation success;
- retry generation;
- prevent duplicate Memory; or
- manage Memory review.
Memory failure never reverses Work completion.
## Secretary
The Secretary may draft, summarize, organize, identify risks, prepare Decision context, and prepare completion information.
The Secretary must never start, complete, cancel, or satisfy the completion gate.
---
# Local Aggregate Invariants
## Identity and Ownership
- Work has exactly one identity.
- Work belongs to exactly one Organization.
- Creator is recorded exactly once.
- Identity, Organization, and creator never change.
## Lifecycle
- Work is in exactly one state.
- Only State Machine transitions are valid.
- Completed and Cancelled are terminal.
- Every lifecycle transition records actor and timestamp.
- State timestamps are immutable once set.
## Details
- Required title and intended outcome are present before start.
- Terminal Work details are immutable.
- Detail changes are attributable.
## Assignment and Participation
- Duplicate active assignments of the same type are rejected.
- Duplicate active participants are rejected.
- Terminal Work cannot change assignments or participants.
- Assignment and participant history remains traceable.
## Decision Gate
- At most one blocking Decision is pending.
- `WaitingForDecision` requires a Pending gate.
- Pending gate requires the matching `blockingDecisionId`.
- `InProgress` cannot retain a Pending gate.
- Decision outcome applies only to the matching pending Decision.
- The same source event cannot apply twice.
- Satisfied requires Approved.
- Unsatisfied requires Rejected or Withdrawn.
## Completion
- Only `InProgress` Work may become Completed.
- Pending gate prohibits completion.
- Required Unsatisfied gate prohibits completion.
- Only a Human Member may complete.
- Completion record is complete and immutable.
- Completed Work has no cancellation record.
## Cancellation
- Only non-terminal Work may be cancelled.
- Only a Human Member may cancel.
- Reason is required.
- Cancellation record is complete and immutable.
- Cancelled Work has no completion record.
## Historical Integrity
- Progress records are append-only.
- Decision outcome records are append-only.
- Secretary contributions are append-only.
- Activity history is append-only.
- Human, AI, and system actions remain distinguishable.
---
# Cross-Aggregate Preconditions
The following are required but are not local Work Aggregate invariants:
- Organization exists;
- acting Human Member is active and authorized;
- assigned or participating Members belong to the Organization;
- related Decision exists;
- Decision and Work belong to the same Organization;
- only one unresolved blocking Decision exists across repositories;
- Decision outcome is authoritative;
- no duplicate Memory is generated; and
- Secretary operates for the same Organization.
These are enforced through:
- Application Services;
- authorization policies;
- repositories;
- database constraints;
- Transactional Outbox processing;
- idempotent event handlers; and
- process coordination.
They must not be described as facts the Work Aggregate can prove alone.
---
# Domain Events
The Aggregate may emit:
```text
WorkCreated
WorkDetailsUpdated
WorkAssignmentChanged
WorkParticipantChanged
WorkProgressRecorded
WorkSecretaryContributionRecorded
WorkStarted
WorkDecisionRequested
WorkDecisionOutcomeRecorded
WorkCompleted
WorkCancelled
```
Every event includes:
- event identifier;
- Work identifier;
- Organization identifier;
- Aggregate version;
- timestamp;
- acting principal; and
- transition-specific data.
`WorkDecisionOutcomeRecorded` also includes:
- Decision identifier;
- outcome;
- originating Human Member;
- Decision resolution timestamp;
- source event identifier; and
- processing System Principal where applicable.
`WorkCompleted` contains enough immutable completion context for downstream Memory generation.
Required downstream events must use a Transactional Outbox or equivalent durable mechanism.
---
# Transaction Boundary
One Work transaction may modify only Work-owned details, assignments, participants, progress, Secretary contributions, status, completion gate, blocking Decision reference, Decision outcome history, terminal records, activity history, timestamps, and Aggregate version.
It must not directly modify Organization, Member, Secretary, Decision, Memory, generation jobs, notifications, search indexes, or projections.
Cross-Aggregate coordination occurs through Application Services and durable events.
# Authorization Boundary
The Application Layer evaluates Organization-level permissions before invoking the Aggregate.
Examples include:
- active Membership;
- Work creation permission;
- assignment permission;
- completion permission;
- cancellation permission;
- Organization suspension; and
- resource visibility.
The Aggregate still enforces domain-level actor rules:
- only Human Members start, complete, or cancel;
- AI cannot change lifecycle state;
- System Principal may apply only authoritative Decision outcomes;
- terminal Work cannot change; and
- actor identity is recorded.
Authorization success never bypasses Aggregate invariants.
---
# Consistency Model
Work-owned state is strongly consistent inside one Aggregate transaction.
Relationships with Decision coordination, Memory generation, notifications, activity feeds, search, and analytics may be eventually consistent.
Eventual consistency must not permit invalid Work completion.
The local completion gate exists specifically to protect the completion transition without loading another Aggregate inside Work.
---
# Repository Interface
```text
WorkRepository
- findById(workId): Work?
- save(work, expectedVersion): void
- exists(workId): boolean
```
Cross-Aggregate coordination may also use:
```text
DecisionRepository
- findUnresolvedBlockingByWorkId(workId): Decision?
```
The Work repository must support optimistic concurrency.
The domain model must not depend on database, ORM, transport, or framework-specific types.
---
# Application Service Responsibilities
## Creating and Updating Work
Authenticate the Human Member, evaluate Organization permission, validate referenced Members, load or create Work, invoke the Aggregate command, save with the expected version, and publish events durably.
## Requesting a Blocking Decision
Coordinate Decision creation or submission, confirm that no unresolved blocking Decision exists, invoke `RequestBlockingDecision`, and save both outcomes reliably. When one atomic transaction is unavailable, use durable events, idempotency, and visible recovery.
## Applying a Decision Outcome
Consume the authoritative Decision event, check idempotency, load Work, verify the matching blocking `decisionId`, invoke `RecordDecisionOutcome`, save with the expected version, and publish the resulting Work event.
Decision resolution never invokes `CompleteWork`.
## Completing Work
Authenticate a Human Member, evaluate completion permission, load Work, invoke `CompleteWork`, and save Work plus `WorkCompleted` in one transaction through an Outbox. Downstream Memory generation finishes independently.
# Concurrency and Idempotency
Use optimistic concurrency through:
```text
aggregateVersion
```
A stale command fails and reloads current state.
Conflicts include:
- simultaneous detail edits;
- assignment change during completion;
- cancellation during completion;
- Decision outcome during cancellation;
- duplicate Decision events; and
- repeated completion.
Idempotency requirements:
- one Decision outcome event applies once;
- repeated completion does not emit another `WorkCompleted`;
- repeated cancellation does not create another record;
- repeated progress command does not duplicate a record; and
- repeated downstream `WorkCompleted` delivery does not alter Work state.
Infrastructure may use:
```text
CommandId
EventId
IdempotencyKey
AggregateVersion
```
---
# Failure Semantics
- A failed Work transaction commits neither state nor Domain Events.
- Failed Decision-to-Work coordination leaves Decision resolved and retries the Work update idempotently.
- Failed Memory generation leaves Work `Completed`.
- Failed projections or notifications do not reverse committed Work state.
- Secretary failure never changes Work state.
# Audit Requirements
Every Work preserves identifiers, details and intended-outcome history, assignments, participants, progress, Secretary provenance, current status, completion-gate history, blocking Decision references, applied Decision outcomes, lifecycle actors and timestamps, completion or cancellation records, Aggregate version, and complete transition history.
Historical information must never be silently overwritten, and human, AI, and system actions must remain distinguishable.
# Related Documents
`docs/architecture/overview.md`, `docs/product/mvp.md`, `docs/product/roadmap.md`, `docs/architecture/state-machines/work.md`, `docs/architecture/state-machines/decision.md`, `docs/architecture/state-machines/memory.md`, `docs/architecture/aggregates/decision.md`, `docs/architecture/aggregates/memory.md`, and `docs/architecture/authorization.md`.
