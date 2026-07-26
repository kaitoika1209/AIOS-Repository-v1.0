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
- sourceSnapshotId: MemorySourceSnapshotId
- sourceSnapshotHash: ContentHash
- submittedBy: HumanMemberId
- submittedAt: Timestamp
- contentHash: ContentHash
```
Rules:
- created only by `SubmitMemoryForReview`;
- immutable after creation;
- associated with exactly one draft cycle;
- binds the reviewed content to the exact immutable generation source snapshot by identifier and hash; and
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
- sourceSnapshot: MemorySourceSnapshotReference
- decisionReferences: DecisionSnapshotReference[]
- participantReferences: ParticipantReference[]
- sourceArtifactReferences: SourceArtifactReference[]
```
Rules:
- source Work never changes;
- referenced objects must belong to the same Organization;
- references in an Approved snapshot are immutable; and
- references do not transfer ownership of external Aggregates.
## MemorySourceSnapshotReference

```text
MemorySourceSnapshotReference
- sourceSnapshotId: MemorySourceSnapshotId
- organizationId: OrganizationId
- workId: WorkId
- workAggregateVersion: AggregateVersion
- workContentRevisionId: WorkContentRevisionId
- workCompletedEventId: EventId
- decisionSnapshots: DecisionSnapshotReference[]
- sourceSchemaVersion: SchemaVersion
- sourceSnapshotHash: ContentHash
- capturedAt: Timestamp
```

A Memory source snapshot identifies the exact immutable source document used to generate the draft. It is created and committed before any external AI-provider call.

Each Decision reference identifies an immutable submitted or resolved Decision snapshot by Decision identity, revision or submitted-snapshot identity, and content hash. A mutable Decision draft is not a valid generation source.

The source snapshot contains the minimum normalized Work completion facts and immutable revision references required to reproduce what the generator and Human reviewer saw. It must not be rebuilt later from current mutable read models.

Rules:

- the source snapshot belongs to the same Organization and Work as the Memory;
- the identifier, schema version, source versions, and hash never change;
- the stored hash is calculated from the canonical serialized source snapshot;
- provider input transformation records its own input hash and prompt or policy version;
- a retry for the same generation operation reuses the same source snapshot;
- a replacement source snapshot requires a new explicit generation operation before a Memory exists;
- the snapshot is retained at least as long as the generated or Approved Memory; and
- Organization isolation, encryption, retention, deletion, and legal-hold rules apply because the snapshot is domain provenance, not telemetry.

The source snapshot is the authoritative record of what the generator and Human reviewer were allowed to see. Review and approval must never reconstruct it from current Work, Decision, search, or Secretary projections.

Approved Memory immutability governs ordinary domain behavior; it is not permission for indefinite retention. Archival preserves the snapshot, while legally authorized Organization deletion, personal-data erasure, correction, redaction, and legal hold follow the explicit precedence and audit rules in ADR-0012. Such actions are privileged data-governance operations, not Memory edits or state transitions.

## MemoryGenerationProvenance
```text
MemoryGenerationProvenance
- generationRequestId: GenerationOperationId
- sourceSnapshotId: MemorySourceSnapshotId
- sourceSnapshotHash: ContentHash
- providerInputHash: ContentHash
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
- a persisted immutable source snapshot created before the provider call;
- source snapshot Organization, Work identity, version, and hash match the request;
- valid immutable source references; and
- validated generation output whose provider-input hash is recorded.
Aggregate effects:
- state becomes `Generated`;
- draft cycle starts at `1`;
- current draft is created;
- generation provenance, including source snapshot and provider-input hashes, is recorded;
- the exact immutable source snapshot reference and source references are recorded;
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

It is classified as `ExternalComputation`: the AI provider produces untrusted candidate content but does not create an authoritative Memory or other external business outcome.

The process:

- consumes `WorkCompleted`;
- commits the exact immutable source snapshot;
- creates or reuses one stable generation operation;
- acquires a fenced generation claim;
- invokes the Secretary or AI provider outside PostgreSQL;
- validates output;
- schedules bounded retry for temporary failure;
- discards stale or lease-lost responses;
- prevents duplicate Memory creation; and
- invokes `CreateGeneratedMemory`.

`Integration / WorkCompleted / 1` is the only registered MVP generation trigger. `MemoryGenerationRequested` and `MemoryGenerationFailed` are not Memory Domain Events or Integration Events; request, retry, and failure are represented by the source delivery and durable generation operation.

Generation operation states are:

```text
Pending
Generating
RetryPending
Generated
Failed
Abandoned
```

They are operational process states, not `MemoryStatus`.

A provider timeout with no usable response may duplicate compute cost when retried, but it does not create unknown business state. Retry reuses the same source snapshot, generation policy version, provider-input hash, and generation operation.

`Generated` is valid only when the final fenced PostgreSQL transaction creates or proves the matching Memory and atomically records `MemoryGenerated`, the processed-event result, and required audit.
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
The Aggregate only emits Domain Events in memory. The Application transaction atomically persists Memory state, required durable event records, idempotency records, and transactional audit evidence through the Transactional Outbox architecture; the Aggregate never inserts Outbox rows or publishes messages.
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

`MemoryRepository` is an internal persistence port of Organizational Memory.

```text
MemoryRepository
- Add(organizationId, memory)
- Get(organizationId, memoryId): Memory | NotFound
- FindBySourceWorkId(organizationId, workId): Memory | NotFound
- Save(organizationId, memory, expectedVersion)
```

Repository rules:

- `organizationId` is mandatory and must equal the Aggregate's immutable Organization;
- `Add` inserts only and must never become an upsert;
- `Save` updates only when the stored version equals `expectedVersion`;
- `Get` returns one Aggregate Root or a scoped not-found result;
- a missing Aggregate and an Aggregate owned by another Organization are indistinguishable to an unauthorized caller;
- child entities, ORM rows, query builders, and database connections are never exposed;
- the Repository does not begin, commit, publish events, or retry the Application transaction; and
- database errors are translated to stable outcomes such as `DuplicateAggregateId`, `NotFound`, `ConcurrencyConflict`, or `PersistenceFailure`.

The domain model does not depend on database, ORM, transport, or framework-specific types.

`FindBySourceWorkId` is an Aggregate-specific idempotency lookup, not a generic cross-module query. It returns only the Memory Aggregate Root and is always Organization-scoped.

Memory generation first checks the processed-event and generation-operation identities, may call `FindBySourceWorkId`, and then uses `Add`. PostgreSQL uniqueness on `(organizationId, sourceWorkId)` remains the final race-safe guard. A uniqueness conflict is translated to `MemoryAlreadyExistsForWork` and never overwrites the existing Memory.

---

# Application Service Responsibilities
## Generating Memory

The Application Service consumes `WorkCompleted` in bounded transactions separated by the external AI call.

1. It validates Organization and event identity, commits the exact immutable source snapshot, and creates or reuses the stable generation operation.
2. It acquires a `Generating` claim that increments `attemptCount` and `claimVersion`.
3. It calls the provider outside PostgreSQL using only the committed snapshot.
4. It validates the candidate.
5. In one final transaction it verifies generation and consumer fencing, calls `MemoryRepository.Add`, appends `MemoryGenerated`, sets the generation operation to `Generated`, records the processed-event result and required audit, and commits.

The uniqueness constraint on `(organizationId, sourceWorkId)` remains the final race guard. A conflicting existing Memory is accepted only after proving the same Work and generation identity; it is never overwritten.

A timeout or transient provider failure changes the same operation to `RetryPending` with `nextAttemptAt` while budget remains. Retry exhaustion changes it to `Failed`. Expired claims are recovered through `claimVersion`; a late response from a stale claim is discarded.

Generation failure does not reopen Work and creates no partial Memory.
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
- Generation failure leaves Work Completed and creates no partial Memory Aggregate. The committed source snapshot and stable generation operation remain durable retry evidence and must be reused rather than rebuilt from mutable current data.
- Provider timeout with no usable candidate becomes `RetryPending` while retry budget remains; it is not treated as an unknown external business effect.
- A stale or lease-lost provider response cannot create Memory.
- Retry exhaustion becomes `Failed`; `Abandoned` requires an explicit authorized operational decision.
- Edit failure leaves the previous draft unchanged and commits no edit event.
- Approval or rejection failure leaves Memory `InReview` with no authoritative outcome.
- Downstream notification, projection, or indexing failure does not reverse a committed Memory transition and must be retried.
# Audit Requirements
Every Memory preserves identifiers, source references, initial generated content, Secretary and model provenance, every draft cycle, attributable edits, Secretary contributions, submitted snapshots, submitters, review records, reviewer identity, approval comments or rejection reasons, timestamps, current status, Aggregate version, and complete transition history.
Historical information must never be silently overwritten, and human, AI, and system actions must remain distinguishable. A legally authorized correction, redaction, or erasure is recorded as a separate data-governance action and reconciled across projections, indexes, caches, provider inputs, and restored backups under ADR-0012.
# Related Documents
`docs/architecture/overview.md`, `docs/product/mvp.md`, `docs/product/roadmap.md`, `docs/architecture/state-machines/memory.md`, `docs/architecture/state-machines/work.md`, `docs/architecture/state-machines/decision.md`, `docs/architecture/aggregates/work.md`, `docs/architecture/aggregates/decision.md`, `docs/architecture/aggregates/knowledge.md`, `docs/architecture/authorization.md`, and `docs/adr/0012-define-memory-source-snapshot-and-data-governance.md`.
