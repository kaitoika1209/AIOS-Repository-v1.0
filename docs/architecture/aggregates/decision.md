# Decision Aggregate

## Purpose

The Decision Aggregate represents a deliberate organizational choice made within a Work.

A Decision records:

- What must be decided
- Which options were considered
- Who proposed the Decision
- Who approved, rejected, or withdrew it
- Why the final outcome was selected
- Whether the Decision blocks completion of the related Work

The Decision Aggregate is responsible for preserving the integrity, traceability, and finality of organizational decisions.

---

## Aggregate Root

```text
Decision
```

`Decision` is the Aggregate Root.

All changes to a Decision must be performed through the Decision Aggregate.

External components must not directly modify:

- Decision status
- Options
- Outcome
- Rationale
- Review history
- Audit information

---

## Identity

Each Decision has a globally unique identifier.

```text
DecisionId
```

A Decision belongs to:

- Exactly one Organization
- Exactly one Work

The identity and ownership of a Decision never change.

A Decision cannot be transferred to another Organization or Work.

---

## Responsibilities

The Decision Aggregate is responsible for:

- Maintaining the Decision question
- Managing proposed options
- Identifying whether the Decision is blocking
- Managing the Decision lifecycle
- Recording approval, rejection, withdrawal, and revision
- Preserving the selected option and rationale
- Preventing invalid state transitions
- Preserving human and Secretary contributions
- Emitting domain events for important changes
- Maintaining a complete audit history

The Decision Aggregate is not responsible for:

- Managing the Work lifecycle
- Automatically completing or resuming Work
- Generating Memory
- Creating Knowledge
- Managing Organization membership
- Evaluating Organization-wide authorization policy
- Executing the selected course of action

---

## Entities

### Decision

The Aggregate Root.

Suggested attributes:

```text
Decision
- id: DecisionId
- organizationId: OrganizationId
- workId: WorkId
- title: DecisionTitle
- question: DecisionQuestion
- context: DecisionContext
- status: DecisionStatus
- blocking: BlockingStatus
- proposerId: MemberId
- options: DecisionOption[]
- selectedOptionId: DecisionOptionId?
- rationale: DecisionRationale?
- reviewHistory: DecisionReviewRecord[]
- secretaryContributions: DecisionSecretaryContribution[]
- revision: DecisionRevision
- createdAt: Timestamp
- updatedAt: Timestamp
- resolvedAt: Timestamp?
- withdrawnAt: Timestamp?
```

---

### DecisionOption

Represents one possible choice within the Decision.

Suggested attributes:

```text
DecisionOption
- id: DecisionOptionId
- title: OptionTitle
- description: OptionDescription
- proposedBy: ActorReference
- createdAt: Timestamp
```

A Decision must contain at least one option before approval.

An option belongs to exactly one Decision.

Option identifiers are unique within the Decision Aggregate.

---

### DecisionReviewRecord

Represents a human review action.

Suggested attributes:

```text
DecisionReviewRecord
- id: DecisionReviewRecordId
- reviewerId: MemberId
- action: DecisionReviewAction
- selectedOptionId: DecisionOptionId?
- reason: ReviewReason?
- revision: DecisionRevision
- createdAt: Timestamp
```

Possible actions:

```text
Approved
Rejected
Withdrawn
Revised
```

Review records are append-only.

They must never be overwritten or deleted.

---

### DecisionSecretaryContribution

Represents assistance provided by the Secretary.

Examples include:

- Summarizing the issue
- Generating alternative options
- Comparing advantages and disadvantages
- Identifying risks
- Retrieving related organizational experience
- Drafting a rationale

Suggested attributes:

```text
DecisionSecretaryContribution
- id: SecretaryContributionId
- type: ContributionType
- content: ContributionContent
- modelVersion: ModelVersion
- promptVersion: PromptVersion
- createdAt: Timestamp
```

Secretary contributions are advisory records.

They do not represent organizational authority.

---

## Value Objects

### DecisionTitle

A concise name for the Decision.

Rules:

- Must not be empty
- Must contain meaningful visible characters
- Must remain within the configured maximum length

---

### DecisionQuestion

Defines the question that requires an organizational choice.

Examples:

```text
Which vendor should we select?
Should the campaign launch be delayed?
Which proposal should be presented to the client?
```

Rules:

- Must not be empty
- Must describe a choice or approval requirement
- Must not be changed after approval or withdrawal

---

### DecisionContext

Contains the background information necessary to understand the Decision.

Rules:

- May be incomplete when first proposed
- Should contain sufficient context before approval
- Must become immutable once the Decision is approved

---

### DecisionStatus

Possible values:

```text
Proposed
Approved
Rejected
Withdrawn
```

Transitions are defined in:

```text
docs/architecture/state-machines/decision.md
```

The Aggregate must reject all transitions not permitted by the State Machine.

---

### BlockingStatus

Indicates whether unresolved Decision status prevents Work completion.

Possible values:

```text
Blocking
NonBlocking
```

A blocking Decision prevents completion of its related Work while its status is `Proposed`.

Approved, Rejected, and Withdrawn Decisions are considered resolved.

---

### DecisionRationale

Explains why the selected outcome was approved.

Rules:

- Required for approval
- Required for rejection
- Required for withdrawal
- Must identify the reasoning behind the action
- Becomes immutable when the Decision is resolved

---

### DecisionRevision

A positive integer representing the current proposal revision.

```text
1, 2, 3, ...
```

Rules:

- Starts at `1`
- Increments when a rejected Decision is revised
- Never decreases
- Previous review history remains associated with its original revision

---

### ActorReference

Identifies whether a contribution was made by a human or AI actor.

Suggested structure:

```text
ActorReference
- actorType: Member | Secretary
- actorId: MemberId | SecretaryId
```

Only Members may perform authoritative lifecycle actions.

---

## Relationships

### Organization

Every Decision belongs to exactly one Organization.

```text
Organization 1 ─── * Decision
```

A Decision cannot reference Members or Work from another Organization.

---

### Work

Every Decision belongs to exactly one Work.

```text
Work 1 ─── * Decision
```

The Decision Aggregate stores the related `WorkId`.

The Work Aggregate may store a reference to the Decision.

The Decision Aggregate does not own or directly modify Work state.

When a blocking Decision is resolved, the Decision Aggregate emits a domain event.

An application service may then determine whether the related Work can resume.

---

### Member

A Decision has one proposer.

A Member may also act as:

- Approver
- Rejector
- Withdrawer
- Option contributor

Member information is not owned by the Decision Aggregate.

Only Member identifiers are stored.

---

### Secretary

The Secretary may assist the Decision process.

The Secretary may:

- Suggest options
- Compare options
- Summarize evidence
- Identify risks
- Draft rationale
- Retrieve relevant Memory or Knowledge

The Secretary must never:

- Approve a Decision
- Reject a Decision
- Withdraw a Decision
- Select the final option
- Change whether a Decision is blocking
- Resolve the Decision autonomously

---

### Memory

A resolved Decision may be referenced by the Memory generated from its related Work.

```text
Decision * ─── 1 Work
Work 1 ─── 0..1 Memory
```

The Decision Aggregate does not create or modify Memory.

Decision history remains available as source evidence for Memory generation.

---

### Knowledge

A Decision may later be cited as supporting context for Knowledge.

Knowledge does not belong to the Decision Aggregate.

Knowledge creation must not modify the historical Decision.

---

## Commands

The Decision Aggregate may support the following domain commands:

```text
ProposeDecision
UpdateDecisionDetails
AddDecisionOption
RemoveDecisionOption
MarkDecisionBlocking
MarkDecisionNonBlocking
ApproveDecision
RejectDecision
ReviseRejectedDecision
WithdrawDecision
RecordDecisionSecretaryContribution
```

Commands express intent.

Each command must validate:

- Current state
- Actor authority
- Organization boundary
- Work relationship
- Aggregate invariants

---

## Business Rules

### Decision Proposal

A Decision may be proposed only when:

- The related Organization exists
- The related Work exists
- The related Work belongs to the same Organization
- The proposer is an active Organization Member
- The related Work is not completed or archived

A newly proposed Decision:

- Starts in `Proposed`
- Starts at revision `1`
- Has no selected option
- Has no resolution rationale
- Has no resolution timestamp

---

### Revision After Rejection

A rejected Decision may be revised and proposed again.

A revision represents another attempt to answer the same organizational question.

A revision may:

- Add or remove options
- Update supporting context
- Incorporate new evidence
- Improve the rationale

A revision must not materially change the original organizational question.

If the organizational question changes materially, a new Decision must be created.

Each revision increments the revision number while preserving the same Decision identity and complete audit history.

---

### Option Management

While a Decision is `Proposed`:

- Options may be added
- Options may be edited
- Options may be removed
- Duplicate options should be rejected
- At least one option must remain before approval

After approval, rejection, or withdrawal:

- Options become immutable
- Selected option cannot be changed
- Historical options remain available for audit

The Secretary may propose an option, but a human Member must accept its inclusion in the Decision.

---

### Blocking Decisions

A Decision may be designated as blocking only while it is `Proposed`.

A blocking Decision prevents completion of its related Work.

For the MVP:

- A Work may have at most one unresolved blocking Decision
- A Work may have multiple non-blocking Decisions
- A resolved Decision is no longer considered blocking

Changing the blocking status requires an authorized Member.

The Secretary cannot change blocking status.

---

### Decision Approval

A Decision may be approved only when:

- Its current status is `Proposed`
- It contains at least one option
- The selected option belongs to the Decision
- An approval rationale is provided
- The approver is an active Organization Member
- The approver is authorized
- The related Work is not completed or archived

Approval results in:

- Status becoming `Approved`
- Selected option being recorded
- Rationale being recorded
- Reviewer identity being recorded
- Resolution timestamp being recorded
- `DecisionApproved` being emitted

Approval is final in the MVP.

An approved Decision cannot be revised, rejected, or withdrawn.

---

### Self-Approval

For the MVP, the proposer may approve their own Decision.

This supports small teams where separate proposer and approver roles may not exist.

The action must still:

- Be explicit
- Record the approver identity
- Record the rationale
- Be preserved in the audit history

Future governance policies may prohibit self-approval.

Such policies belong to Organization-level authorization and governance.

---

### Decision Rejection

A Decision may be rejected only when:

- Its current status is `Proposed`
- A rejection reason is provided
- The rejecting Member is active and authorized

Rejection results in:

- Status becoming `Rejected`
- No option being selected
- Rejection reason being preserved
- Resolution timestamp being recorded
- `DecisionRejected` being emitted

A rejected Decision may later be revised.

---

### Revision After Rejection

A rejected Decision may be revised when:

- The requesting Member is active and authorized
- The related Work is still active
- A revision explanation is provided

Revision results in:

- Status returning to `Proposed`
- Revision number incrementing
- Previous review records remaining unchanged
- Previous options remaining available in audit history
- Selected option remaining empty
- Previous resolution timestamp being preserved in review history
- Current resolution fields being cleared
- `DecisionRevised` being emitted

Revision does not erase the rejection.

The new proposal is another revision of the same Decision identity.

---

### Decision Withdrawal

A Decision may be withdrawn only when:

- Its current status is `Proposed`
- The requesting Member is authorized
- A withdrawal reason is provided

Withdrawal results in:

- Status becoming `Withdrawn`
- No option being selected
- Withdrawal reason being recorded
- Withdrawal timestamp being recorded
- `DecisionWithdrawn` being emitted

A withdrawn Decision cannot be resumed or revised in the MVP.

A new Decision must be proposed when the issue needs to be reconsidered.

---

### Relationship to Work Completion

Decision approval does not automatically complete the related Work.

Decision rejection does not automatically cancel the related Work.

Decision withdrawal does not automatically complete or cancel the related Work.

When a blocking Decision is resolved, an application service may:

- Re-evaluate Work completion eligibility
- Notify Work participants
- Suggest resuming Work

The Work Aggregate remains responsible for Work state transitions.

---

### Secretary Contributions

Every Secretary contribution must:

- Belong to the Decision
- Record its contribution type
- Record model version
- Record prompt version
- Record creation timestamp
- Be stored as an append-only historical entry

Secretary output must be clearly distinguishable from human input.

Secretary contributions cannot directly change Decision state.

---

## Invariants

The following conditions must always remain true.

### Decision Identity

- A Decision represents exactly one organizational question.
- A Decision may contain multiple revisions.
- Every revision must address the same organizational question.
- The Decision identity remains unchanged across revisions.
- If the organizational question changes materially, a new Decision must be created.
- A revision must not be used to redefine the original Decision question.

---

### Organization Boundary

- A Decision belongs to exactly one Organization.
- A Decision belongs to a Work in the same Organization.
- The proposer belongs to the same Organization.
- Every human reviewer belongs to the same Organization.
- Cross-Organization references are prohibited.

---

### Work Boundary

- A Decision belongs to exactly one Work.
- `workId` is immutable.
- A Decision cannot be proposed for completed or archived Work.
- Decision resolution does not directly mutate the Work Aggregate.

---

### Lifecycle Integrity

- Status transitions must follow the Decision State Machine.
- Approved Decisions are immutable.
- Withdrawn Decisions are immutable.
- Only rejected Decisions may return to `Proposed`.
- Revision number increments only through rejection revision.
- A Decision cannot resolve more than once within the same revision.

---

### Approval Integrity

An Approved Decision must always contain:

- At least one option
- A valid selected option
- An approver
- An approval rationale
- A resolution timestamp

The selected option must belong to the Decision.

---

### Rejection Integrity

A Rejected Decision must always contain:

- A rejecting Member
- A rejection reason
- A resolution timestamp
- No selected option

---

### Withdrawal Integrity

A Withdrawn Decision must always contain:

- A withdrawing Member
- A withdrawal reason
- A withdrawal timestamp
- No selected option

---

### Historical Integrity

- Review records are append-only.
- Secretary contributions are append-only.
- Previous revisions cannot be deleted.
- Resolved revision history cannot be rewritten.
- Actor identity and timestamps are immutable.
- Audit records remain available after Work completion or archival.

---

### AI Authority

- AI cannot perform authoritative Decision actions.
- AI-generated options do not become official until accepted by a Member.
- AI-generated rationale does not replace explicit human approval.
- All final outcomes require a human Member action.

---

### Blocking Integrity

- Only `Proposed` Decisions may actively block Work.
- A Work may have no more than one unresolved blocking Decision in the MVP.
- Approved, Rejected, and Withdrawn Decisions are resolved.
- Resolving a blocking Decision does not automatically change Work status.

---

## Domain Events

The Decision Aggregate may emit:

```text
DecisionProposed
DecisionDetailsUpdated
DecisionOptionAdded
DecisionOptionUpdated
DecisionOptionRemoved
DecisionMarkedBlocking
DecisionMarkedNonBlocking
DecisionSecretaryContributionRecorded
DecisionApproved
DecisionRejected
DecisionRevised
DecisionWithdrawn
```

---

## Event Responsibilities

### DecisionProposed

Indicates that a new organizational choice requires attention.

Potential consumers:

- Work coordination
- Notification service
- Activity feed
- Audit log
- Secretary

---

### DecisionMarkedBlocking

Indicates that the Decision prevents Work completion.

Potential consumers:

- Work application service
- Notification service
- Workflow coordination

The consumer may request that the Work enter `WaitingForDecision`.

The Decision Aggregate must not directly change Work status.

---

### DecisionApproved

Indicates that an authorized Member has selected and approved an option.

Potential consumers:

- Work application service
- Notification service
- Activity feed
- Audit log
- Memory generation process

Approval does not automatically complete Work.

---

### DecisionRejected

Indicates that the proposed Decision was not accepted.

Potential consumers:

- Work application service
- Notification service
- Activity feed
- Audit log
- Secretary

---

### DecisionRevised

Indicates that a rejected Decision has returned to the proposal process as a new revision.

Potential consumers:

- Notification service
- Activity feed
- Audit log
- Secretary

---

### DecisionWithdrawn

Indicates that the proposal is no longer being considered.

Potential consumers:

- Work application service
- Notification service
- Activity feed
- Audit log

---

## Transaction Boundary

A single Decision Aggregate transaction may modify:

- Decision details
- Decision options
- Blocking status
- Decision status
- Selected option
- Rationale
- Review history
- Secretary contributions
- Revision number

The transaction must not directly modify:

- Work Aggregate state
- Memory Aggregate state
- Knowledge Aggregate state
- Organization state
- Member state

Cross-Aggregate coordination must occur through:

- Application services
- Domain events
- Event handlers

---

## Authorization Boundary

The Decision Aggregate enforces domain-level authority rules.

Examples include:

- Only a human Member may approve
- Only an authorized Member may reject
- Only an authorized Member may withdraw
- Only active Members may perform lifecycle actions

Organization-level authorization is evaluated before invoking the Aggregate.

Examples include:

- Organization Admin permissions
- Member suspension
- Team-level policy
- Self-approval restrictions
- Separation-of-duties policy

The Aggregate must still enforce its invariants even after application-level authorization succeeds.

---

## Consistency Model

The internal state of the Decision Aggregate is strongly consistent within one transaction.

Relationships with other Aggregates may be eventually consistent.

Examples:

- Work entering `WaitingForDecision`
- Work resuming after resolution
- Notifications
- Activity feed updates
- Search indexing
- Memory generation after Work completion

---

## Repository Interface

A conceptual repository interface may be defined as:

```text
DecisionRepository
- findById(decisionId): Decision?
- save(decision): void
- exists(decisionId): boolean
- findUnresolvedBlockingByWorkId(workId): Decision?
```

Repository implementation details belong to the infrastructure layer.

The domain model must not depend on:

- Database technology
- ORM models
- Transport protocols
- Framework-specific types

---

## Application Service Responsibilities

The application layer may coordinate Decision and Work Aggregates.

Examples:

### Proposing a Blocking Decision

```text
1. Validate Organization membership
2. Load Work
3. Confirm Work is active
4. Confirm no unresolved blocking Decision exists
5. Create Decision Aggregate
6. Save Decision
7. Request Work transition to WaitingForDecision
8. Save Work
```

Where atomic cross-Aggregate transactions are unavailable, coordination should use reliable event processing and idempotency.

---

### Resolving a Blocking Decision

```text
1. Load Decision
2. Approve, reject, or withdraw Decision
3. Save Decision
4. Emit resolution event
5. Load related Work
6. Re-evaluate unresolved blocking Decisions
7. Allow an authorized Member to resume Work
```

The system must not infer that resolution means Work completion.

---

## Concurrency Requirements

Concurrent actions must not produce conflicting outcomes.

Examples:

- Two Members approving different options simultaneously
- One Member rejecting while another approves
- Option modification during approval
- Withdrawal during approval

The implementation should use optimistic concurrency control.

Suggested concept:

```text
aggregateVersion
```

A command based on a stale Aggregate version must be rejected and retried after reloading the latest state.

Only one authoritative resolution may succeed for each Decision revision.

---

## Idempotency Requirements

Lifecycle commands should support idempotent execution where practical.

Examples:

- Retrying the same approval request must not create duplicate review records.
- Reprocessing `DecisionApproved` must not resume Work multiple times.
- Reprocessing Secretary contribution events must not create duplicate entries.

Infrastructure mechanisms may use:

```text
CommandId
EventId
IdempotencyKey
```

These mechanisms must not alter the domain meaning of the Decision.

---

## Open Questions

The following items may be refined before Blueprint v1.0.0:

- Whether the MVP should support Decision revision
- Whether revision should retain one Decision identity or create a new Decision
- Whether self-approval remains enabled by default
- Whether blocking status can be changed after Work enters `WaitingForDecision`
- Whether multiple unresolved blocking Decisions should be supported after the MVP
- Whether options require explicit human acceptance before inclusion
- Whether approval requires one approver or multiple approvers
- Whether a Decision may exist without predefined options
- Whether review deadlines and escalation rules belong in the Decision domain
- Whether resolved Decisions may receive non-authoritative comments

These questions do not change the primary Aggregate boundary.

---

## Related Documents

- `docs/product/mvp.md`
- `docs/product/use-cases/mvp.md`
- `docs/architecture/aggregates/work.md`
- `docs/architecture/aggregates/memory.md`
- `docs/architecture/aggregates/knowledge.md`
- `docs/architecture/state-machines/work.md`
- `docs/architecture/state-machines/decision.md`
- `docs/architecture/authorization.md`
- `docs/glossary.md`