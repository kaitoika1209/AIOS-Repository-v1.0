# Memory Aggregate
> **Document status:** Proposed · **Blueprint version:** 0.2.1 · **Applies to:** Organizational Memory
## Purpose
The Memory Aggregate represents the human-reviewable historical record created from one completed Work.
A Memory captures the Work outcome, relevant Decisions, important context, participants, timeline, AI contributions, draft lessons, review history, and provenance.
A Memory begins as an editable AI-assisted draft. It becomes authoritative organizational history only after explicit human approval.
A Memory is not Knowledge. Knowledge may later be created from one or more Approved Memories through a separate business process.
---
# Aggregate Root
```text
Memory
```
`Memory` is the Aggregate Root.
All lifecycle changes and modifications to Memory-owned data must occur through the Aggregate.
External components must not directly modify:
- status;
- draft content;
- submitted snapshots;
- draft-cycle number;
- edit history;
- review history;
- approval or rejection records;
- generation provenance;
- source references; or
- audit information.
---
# Aggregate Boundary
The Memory Aggregate owns:
- one Memory identity;
- one Organization reference;
- one source Work reference;
- current status;
- current editable draft;
- immutable submitted snapshots;
- draft-cycle number;
- edit history;
- review history;
- Secretary contributions;
- generation provenance;
- source-reference metadata;
- current resolution;
- lifecycle timestamps; and
- Aggregate version.
It does not own:
- Work;
- Decision;
- Organization;
- Member;
- Secretary;
- generation-job state;
- notifications;
- search projections;
- Knowledge;
- Evidence;
- Capability; or
- archival policy.
Only Memory-owned objects may change in a Memory transaction.
---
# Identity and Ownership
Each Memory has a globally unique:
```text
MemoryId
```
A Memory belongs to exactly one Organization and exactly one completed Work.
Suggested identity fields:
```text
Memory
- id: MemoryId
- organizationId: OrganizationId
- workId: WorkId
```
`MemoryId`, `OrganizationId`, and `WorkId` never change.
One Memory Aggregate represents one Work only.
The MVP permits at most one Memory per completed Work.
A database-level unique constraint on `workId` should reinforce this rule.
---
# Responsibilities
The Memory Aggregate is responsible for:
- managing the Memory review lifecycle;
- holding the current editable draft;
- preserving submitted review snapshots;
- accepting attributable draft edits;
- preventing edits during review;
- recording approval and rejection;
- reopening Rejected Memory;
- preserving generation provenance;
- preserving source references;
- preserving human and Secretary contributions;
- enforcing Approved Memory immutability;
- preventing invalid transitions;
- enforcing local invariants;
- emitting Domain Events; and
- maintaining audit history.
It is not responsible for:
- deciding when Work is complete;
- modifying Work or Decision;
- executing AI-provider calls;
- scheduling generation jobs;
- evaluating Organization-wide permissions;
- creating or promoting Knowledge;
- managing Evidence or Capability;
- archival;
- search indexing; or
- notification delivery.
---
# Suggested Aggregate Structure
```text
Memory
├── currentDraft: MemoryDraft?
├── submittedSnapshots: MemorySubmittedSnapshot[]
├── editHistory: MemoryEditRecord[]
├── reviewHistory: MemoryReviewRecord[]
├── secretaryContributions: MemorySecretaryContribution[]
├── sourceReferences: MemorySourceReferences
├── generationProvenance: MemoryGenerationProvenance
└── resolution: MemoryResolution?
```
Suggested root attributes:
```text
Memory
- id: MemoryId
- organizationId: OrganizationId
- workId: WorkId
- status: MemoryStatus
- draftCycle: DraftCycle
- currentDraft: MemoryDraft?
- submittedSnapshots: MemorySubmittedSnapshot[]
- editHistory: MemoryEditRecord[]
- reviewHistory: MemoryReviewRecord[]
- secretaryContributions: MemorySecretaryContribution[]
- sourceReferences: MemorySourceReferences
- generationProvenance: MemoryGenerationProvenance
- resolution: MemoryResolution?
- createdAt: Timestamp
- updatedAt: Timestamp
- approvedAt: Timestamp?
- aggregateVersion: AggregateVersion
```
`currentDraft` exists only while status is `Generated`.
An immutable submitted snapshot exists while status is `InReview`, `Rejected`, or `Approved`.
---
# Entities and Records
## MemoryDraft
`MemoryDraft` contains the currently editable content.
```text
MemoryDraft
- title: MemoryTitle
- summary: MemorySummary
- outcome: WorkOutcomeDescription
- timeline: MemoryTimeline
- lessonsObserved: LessonDraft[]
- unresolvedItems: UnresolvedItem[]
- participantReferences: ParticipantReference[]
- decisionReferences: DecisionReference[]
- additionalContext: MemoryContext
- updatedAt: Timestamp
```
Rules:
- editable only while Memory is `Generated`;
- belongs to the current draft cycle;
- cannot change Organization or source Work;
- must satisfy structural validation before submission; and
- is not authoritative history.
## MemorySubmittedSnapshot
An immutable snapshot submitted for one review cycle.
```text
MemorySubmittedSnapshot
- id: SubmittedSnapshotId
- draftCycle: DraftCycle
- content: MemoryContent
- sourceReferences: MemorySourceReferences
- submittedBy: HumanMemberId
- submittedAt: Timestamp
- contentHash: ContentHash
```
Rules:
- created only by `SubmitMemoryForReview`;
- immutable after creation;
- associated with exactly one draft cycle; and
- receives at most one authoritative outcome.
## MemoryEditRecord
An attributable draft change.
```text
MemoryEditRecord
- id: MemoryEditRecordId
- draftCycle: DraftCycle
- actor: ActorReference
- changeType: MemoryEditType
- explanation: EditExplanation?
- changedFields: MemoryFieldReference[]
- beforeHash: ContentHash
- afterHash: ContentHash
- createdAt: Timestamp
```
Edit records are append-only.
Human and Secretary edits must remain distinguishable.
## MemoryReviewRecord
A human review action.
```text
MemoryReviewRecord
- id: MemoryReviewRecordId
- submittedSnapshotId: SubmittedSnapshotId
- draftCycle: DraftCycle
- reviewerId: HumanMemberId
- action: Approved | Rejected
- comment: ReviewComment?
- reason: ReviewReason?
- createdAt: Timestamp
```
Rules:
- only Human Members create review records;
- records are append-only; and
- one submitted snapshot has at most one authoritative outcome.
## MemorySecretaryContribution
AI assistance that contributed to the Memory.
```text
MemorySecretaryContribution
- id: SecretaryContributionId
- secretaryId: SecretaryId
- draftCycle: DraftCycle
- contributionType: ContributionType
- contentReference: ContributionContentReference
- modelVersion: ModelVersion
- promptVersion: PromptVersion?
- policyVersion: GenerationPolicyVersion?
- sourceReferenceIds: SourceReferenceId[]
- createdAt: Timestamp
```
Secretary contributions are append-only and advisory.
They do not represent human authority.
---
# Value Objects
## MemoryStatus
```text
Generated
InReview
Rejected
Approved
```
Transitions are defined in:
```text
docs/architecture/state-machines/memory.md
```
All other transitions are rejected.
## DraftCycle
A positive integer:
```text
1, 2, 3, ...
```
Rules:
- starts at `1`;
- increments only when Rejected Memory is reopened;
- never decreases;
- does not change Memory identity; and
- is not a separate `MemoryRevision`.
## MemoryContent
The complete reviewable historical representation.
```text
MemoryContent
- title
- summary
- outcome
- timeline
- lessonsObserved
- unresolvedItems
- participantReferences
- decisionReferences
- additionalContext
```
Rules:
- editable only inside `currentDraft`;
- immutable in a submitted snapshot;
- immutable after approval; and
- must preserve traceable source context for important claims.
## MemorySourceReferences
```text
MemorySourceReferences
- workId: WorkId
- workCompletionTimestamp: Timestamp
- workSnapshotReference: SourceSnapshotReference
- decisionReferences: DecisionReference[]
- participantReferences: ParticipantReference[]
- sourceArtifactReferences: SourceArtifactReference[]
```
Rules:
- source Work never changes;
- referenced objects must belong to the same Organization;
- references in an Approved snapshot are immutable; and
- references do not transfer ownership of external Aggregates.
## MemoryGenerationProvenance
```text
MemoryGenerationProvenance
- generationRequestId: GenerationRequestId
- secretaryId: SecretaryId
- modelProvider: ModelProvider?
- modelVersion: ModelVersion
- promptVersion: PromptVersion?
- policyVersion: GenerationPolicyVersion?
- generatedAt: Timestamp
- sourceReferenceIds: SourceReferenceId[]
- outputHash: ContentHash
```
Generation provenance is immutable.
## MemoryResolution
```text
ApprovedResolution
- reviewerId
- submittedSnapshotId
- comment?
- resolvedAt
```
```text
RejectedResolution
- reviewerId
- submittedSnapshotId
- reason
- resolvedAt
```
A Rejected resolution moves into review history when the Memory is reopened.
An Approved resolution is permanent.
## ActorReference
```text
ActorReference
- actorType: HumanMember | AIPrincipal | SystemPrincipal
- actorId: ActorId
```
Only Human Members may approve or reject.
---
# Commands
The Aggregate may support:
```text
CreateGeneratedMemory
EditGeneratedMemory
RecordSecretaryContribution
SubmitMemoryForReview
ApproveMemory
RejectMemory
ReopenRejectedMemory
```
There is no user-facing manual:
```text
CreateMemory
```
There is no MVP command for:
```text
ArchiveMemory
RequestKnowledgePromotion
ModifyApprovedMemory
```
Archival is outside the business lifecycle.
Knowledge promotion belongs to the future Knowledge domain.
---
# Command Behavior
## CreateGeneratedMemory
Creates a Memory from validated AI-generated content.
Application-level preconditions include:
- a valid completed Work;
- matching Organization;
- no existing Memory for the Work;
- valid source references; and
- validated generation output.
Aggregate effects:
- state becomes `Generated`;
- draft cycle starts at `1`;
- current draft is created;
- generation provenance is recorded;
- source references are recorded;
- initial Secretary contribution is recorded; and
- `MemoryGenerated` is emitted.
The Aggregate does not load or modify Work.
## EditGeneratedMemory
Rules:
- Memory must be `Generated`;
- actor must be attributable;
- Organization and Work cannot change;
- prior submitted snapshots cannot change;
- content must remain valid; and
- an append-only edit record is created.
A Secretary suggestion must not be recorded as a human edit.
## RecordSecretaryContribution
Rules:
- contribution belongs to this Memory;
- Secretary and model attribution are present;
- source references are valid;
- contribution is append-only; and
- contribution alone cannot change state.
Applying suggested content requires a draft-edit command.
## SubmitMemoryForReview
Transition:
```text
Generated → InReview
```
Effects:
- validate required content;
- create an immutable submitted snapshot;
- lock draft content;
- record submitter and time;
- open one review cycle; and
- emit `MemorySubmittedForReview`.
Submission is not approval.
## ApproveMemory
Transition:
```text
InReview → Approved
```
Rules:
- only an authorized Human Member may approve;
- submitted snapshot exists;
- no outcome already exists;
- generation provenance is complete;
- review record is appended;
- approved snapshot becomes permanent;
- resolution becomes Approved; and
- `MemoryApproved` is emitted.
Approval does not create Knowledge.
## RejectMemory
Transition:
```text
InReview → Rejected
```
Rules:
- only an authorized Human Member may reject;
- a reason is required;
- no outcome already exists;
- submitted snapshot remains immutable;
- rejection record is appended;
- resolution becomes Rejected; and
- `MemoryRejected` is emitted.
## ReopenRejectedMemory
Transition:
```text
Rejected → Generated
```
Rules:
- only an authorized Human Member may reopen;
- an explanation is required;
- rejected snapshot and review record remain unchanged;
- draft cycle increments;
- a new editable draft is created from rejected content;
- prior Rejected resolution remains in history;
- current active resolution is cleared; and
- `MemoryReopenedForRevision` is emitted.
This does not create a new Memory or `MemoryRevision`.
---
# Business Rules
## Generation
Generation starts only after Work completion and runs outside the Memory Aggregate.
The process:
- consumes `WorkCompleted`;
- loads permitted source material;
- invokes the Secretary or AI provider;
- validates output;
- retries temporary failure;
- prevents duplicate processing; and
- invokes `CreateGeneratedMemory`.
Generation job states are operational process states, not `MemoryStatus`.
## Draft Editing
Generated Memory is editable because AI output may be inaccurate or incomplete.
The system must preserve:
- initial generated content;
- each accepted change;
- actor;
- timestamp; and
- submitted snapshot reviewed.
## Review
A review evaluates one immutable submitted snapshot.
Editing during `InReview` is prohibited.
A reviewer must approve or reject with a reason.
AI may assist but cannot decide.
## Approval
Approval means:
> The submitted Memory is accepted as an accurate-enough historical representation of the completed Work.
Approval does not mean:
> The Memory is reusable organizational Knowledge.
Approved Memory is immutable.
## Rejection and Reopening
Rejection preserves the submitted snapshot.
Reopening:
- keeps one Memory identity;
- creates a new draft cycle;
- preserves prior review history; and
- enables correction before resubmission.
The MVP intentionally omits a separate pre-approval `MemoryRevision`.
## Post-Approval Correction
Approved Memory cannot be corrected in place.
A future append-only `MemoryRevision` process may preserve the original record, correction reason, human authority, revision chain, and historical accessibility.
That process is outside the MVP.
---
# Relationships
## Organization
Every Memory belongs to one Organization.
It cannot reference Work, Decisions, Members, or Secretary context from another Organization.
Ownership is immutable.
## Work
```text
Work 1 ─── 0..1 Memory
```
Work is the source but does not own the Memory Aggregate.
The Memory Aggregate does not modify Work.
Creation is coordinated after `WorkCompleted`.
## Decision
Memory may reference multiple Decisions related to its Work.
Decision remains authoritative for its lifecycle, selected option, rationale, and review history.
Memory stores identifiers, stable references, historical outcomes, and summarized context.
It must not rewrite Decision history.
## Secretary
The Secretary may summarize Work and Decisions, organize timelines, suggest lessons, identify missing context, and propose corrections.
The Secretary must never submit autonomously, approve, reject, reopen, modify Approved Memory, or promote Knowledge.
## Knowledge
Knowledge is not owned by Memory.
```text
Approved Memory
      ↓ future Evidence and promotion
Knowledge
```
An Approved Memory may later support zero, one, or many Knowledge records.
Knowledge never modifies source Memory.
The MVP Memory Aggregate does not emit `KnowledgePromotionRequested`.
---
# Local Aggregate Invariants
## Identity
- Memory has exactly one identity.
- Memory represents exactly one Work.
- Memory identity never changes.
- Organization and Work references never change.
## Lifecycle
- Memory is in exactly one state.
- Only defined transitions are valid.
- Approved is terminal.
- Rejected returns only through explicit reopening.
- At most one active review cycle exists.
- At most one authoritative outcome exists per submitted snapshot.
## Draft
- Only Generated Memory is editable.
- Current draft belongs to the current draft cycle.
- Every edit is attributable.
- Draft edits cannot alter prior submitted snapshots.
- Draft content is non-authoritative.
## Review
- InReview requires one immutable submitted snapshot.
- InReview content is locked.
- Only a Human Member may approve or reject.
- A review cycle cannot be both Approved and Rejected.
- Review records are append-only.
## Rejection
A Rejected Memory contains a submitted snapshot, rejecting Human Member, rejection reason, and rejection timestamp.
The rejected snapshot and record are immutable.
## Approval
An Approved Memory contains an approved submitted snapshot, approving Human Member, approval timestamp, source references, generation provenance, and complete review history.
Approved content and metadata are immutable.
## Draft Cycle
- Starts at `1`.
- Increments only through reopening.
- Never decreases.
- Does not change Memory identity.
- Prior cycles remain traceable.
## Historical Integrity
- Generation provenance is immutable.
- Submitted snapshots are immutable.
- Review records are append-only.
- Secretary contributions are append-only.
- Edit records are append-only or reconstructable as an immutable chain.
- Actor identity and timestamps are immutable.
- Human, AI, and system actions remain distinguishable.
---
# Cross-Aggregate Preconditions
The following are required but are not local Memory Aggregate invariants:
- Organization exists;
- source Work exists and is Completed;
- Work and Memory belong to the same Organization;
- referenced Decisions exist;
- referenced Decisions belong to the same Organization and Work;
- acting Human Member is active and authorized;
- Secretary operates for the same Organization;
- no other Memory exists for the Work; and
- generation originates from a valid `WorkCompleted` event.
These are enforced through Application Services, authorization policies, repositories, database constraints, unique indexes, Transactional Outbox processing, and idempotent handlers.
They must not be described as rules the Memory Aggregate can prove alone.
---
# Domain Events
The Aggregate may emit:
```text
MemoryGenerated
MemoryDraftEdited
MemorySecretaryContributionRecorded
MemorySubmittedForReview
MemoryApproved
MemoryRejected
MemoryReopenedForRevision
```
Every event includes:
- event identifier;
- Memory identifier;
- Work identifier;
- Organization identifier;
- draft cycle;
- Aggregate version;
- timestamp;
- acting principal; and
- transition-specific data.
`MemoryGenerated` includes generation provenance.
Review events identify the Human Member who acted.
Events requiring downstream processing must use a Transactional Outbox or equivalent durable mechanism.
---
# Transaction Boundary
One Memory transaction may modify only:
- current draft;
- status;
- submitted snapshots;
- draft-cycle counter;
- edit history;
- review history;
- Secretary contributions;
- generation provenance;
- source-reference metadata;
- resolution;
- timestamps; and
- Aggregate version.
It must not directly modify:
- Work;
- Decision;
- Organization;
- Member;
- Secretary;
- Knowledge;
- generation jobs;
- notifications;
- search index; or
- activity feed.
Cross-Aggregate coordination occurs through Application Services and durable events.
---
# Authorization Boundary
The Application Layer evaluates Organization-level permission before invoking the Aggregate.
Examples include active Membership, reviewer permission, self-approval policy, role restrictions, Organization suspension, and resource visibility.
The Aggregate still enforces:
- AI cannot approve or reject;
- only Human Members perform review outcomes;
- only Generated content is editable;
- Approved Memory cannot change; and
- actor identity is recorded.
Authorization success never bypasses Aggregate invariants.
---
# Consistency Model
Memory-owned state is strongly consistent inside one Aggregate transaction.
Relationships with generation, notifications, activity feeds, search, analytics, and future Knowledge promotion may be eventually consistent.
Eventual consistency must not weaken Approved Memory immutability.
---
# Repository Interface
```text
MemoryRepository
- findById(memoryId): Memory?
- findByWorkId(workId): Memory?
- existsByWorkId(workId): boolean
- save(memory, expectedVersion): void
```
The repository must support optimistic concurrency.
Infrastructure should enforce uniqueness of `workId`.
The domain model must not depend on database, ORM, transport, or framework-specific types.
---
# Application Service Responsibilities
## Generating Memory
The Application Service consumes `WorkCompleted`, checks idempotency, confirms that no Memory exists, loads permitted source data, invokes Secretary generation outside the domain transaction, validates the result, creates the Aggregate in `Generated`, saves it under unique `workId` protection, and publishes `MemoryGenerated` durably.
Generation failure must not reopen Work.
## Editing Memory
The Application Service authenticates the actor, evaluates Organization permission, loads Memory, invokes `EditGeneratedMemory`, saves with the expected Aggregate version, and publishes the edit event. Secretary-assisted edits preserve AI attribution.
## Reviewing Memory
The Application Service authenticates a Human Member, evaluates review permission, loads Memory, invokes submit, approve, reject, or reopen, saves with the expected Aggregate version, and publishes events durably. It must not edit Aggregate fields directly.
# Concurrency and Idempotency
Use optimistic concurrency through:
```text
aggregateVersion
```
A stale command fails and reloads current state.
Conflicts include editing during submission, simultaneous reviewers, reopening during another action, duplicate generation completion, and repeated approval.
Idempotency requirements:
- repeated `WorkCompleted` does not create another Memory;
- repeated generation completion does not create another Memory;
- repeated edit command does not duplicate edit records;
- repeated approval does not duplicate review records;
- one submitted snapshot receives only one outcome; and
- repeated downstream events do not change state twice.
Infrastructure may use:
```text
CommandId
EventId
GenerationRequestId
IdempotencyKey
AggregateVersion
```
---
# Failure Semantics
- Generation failure leaves Work Completed, exposes no partial Memory, records the operational failure, and permits retry.
- Edit failure leaves the previous draft unchanged and commits no edit event.
- Approval or rejection failure leaves Memory `InReview` with no authoritative outcome.
- Downstream notification, projection, or indexing failure does not reverse a committed Memory transition and must be retried.
# Audit Requirements
Every Memory preserves identifiers, source references, initial generated content, Secretary and model provenance, every draft cycle, attributable edits, Secretary contributions, submitted snapshots, submitters, review records, reviewer identity, approval comments or rejection reasons, timestamps, current status, Aggregate version, and complete transition history.
Historical information must never be silently overwritten, and human, AI, and system actions must remain distinguishable.
# Related Documents
`docs/architecture/overview.md`, `docs/product/mvp.md`, `docs/product/roadmap.md`, `docs/architecture/state-machines/memory.md`, `docs/architecture/state-machines/work.md`, `docs/architecture/state-machines/decision.md`, `docs/architecture/aggregates/work.md`, `docs/architecture/aggregates/decision.md`, `docs/architecture/aggregates/knowledge.md`, and `docs/architecture/authorization.md`.
