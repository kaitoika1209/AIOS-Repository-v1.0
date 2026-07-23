# Knowledge Aggregate

## Purpose

The Knowledge Aggregate represents reusable organizational knowledge within AIOS.

Knowledge is created by generalizing verified organizational experience into guidance that can be applied beyond a single Work.

Examples include:

- Recommended practices
- Reusable methods
- Operational principles
- Validated lessons
- Known risks and countermeasures
- Organizational rules of thumb

Knowledge is not a historical record of one event.

Historical experience belongs to Memory.

Knowledge explains what the Organization currently believes to be useful, reliable, and reusable based on traceable Evidence.

Knowledge is a living organizational asset that may be strengthened, revised, deprecated, or archived as new Evidence becomes available.

---

## Roadmap Position

Knowledge management is outside the MVP defined in:

```text
docs/product/mvp.md
```

The Knowledge Aggregate is specified in Blueprint v0.2.0 to establish the future domain boundary and prevent Memory from assuming Knowledge responsibilities.

Knowledge creation, review, publication, and AI retrieval are introduced in a later roadmap phase.

The MVP may generate and approve Memory without creating Knowledge.

---

## Aggregate Root

```text
Knowledge
```

`Knowledge` is the Aggregate Root.

All authoritative changes to:

- Knowledge identity
- Current revision
- Evidence
- Confidence
- Publication status
- Capability associations
- Revision history

must be performed through the Knowledge Aggregate.

External components must not directly modify internal Knowledge revisions or Evidence associations.

---

## Identity

Each Knowledge has a globally unique identifier.

```text
KnowledgeId
```

A Knowledge represents exactly one reusable organizational insight.

A Knowledge may have multiple revisions while retaining the same identity.

All revisions must describe the same underlying organizational knowledge.

Examples of revisions belonging to the same Knowledge:

```text
Revision 1:
Sales proposals should include visual examples.

Revision 2:
Sales proposals should generally include three to five visual examples.

Revision 3:
Sales proposals for non-technical audiences should generally include
three to five visual examples.
```

The guidance has become more precise, but the underlying knowledge remains the same.

A new Knowledge must be created when the underlying subject or organizational claim changes materially.

Examples requiring separate Knowledge identities:

```text
Knowledge A:
Sales proposals should include three to five visual examples.

Knowledge B:
Client interviews should be completed within thirty minutes.
```

The Knowledge identity never changes across revisions.

---

## Responsibilities

The Knowledge Aggregate is responsible for:

- Representing one reusable organizational insight
- Maintaining the current Knowledge revision
- Preserving complete revision history
- Associating traceable Evidence with each revision
- Ensuring Evidence belongs to the same Organization
- Managing the Knowledge lifecycle
- Managing Confidence
- Associating Knowledge with organizational Capabilities
- Preserving publication and review history
- Preventing unsupported Knowledge publication
- Emitting Knowledge-related domain events
- Preserving explainability and auditability

The Knowledge Aggregate is not responsible for:

- Creating or modifying Work
- Creating or modifying Decision
- Generating or reviewing Memory
- Determining whether a Memory is historically accurate
- Managing Organization membership
- Executing AI workflows
- Calculating business outcomes from source Work
- Owning Capability definitions
- Retrieving external source content
- Enforcing Organization-wide authorization policy

---

## Entities

### Knowledge

The Aggregate Root.

Suggested attributes:

```text
Knowledge
- id: KnowledgeId
- organizationId: OrganizationId
- status: KnowledgeStatus
- currentRevisionNumber: KnowledgeRevisionNumber
- revisions: KnowledgeRevision[]
- capabilityReferences: CapabilityId[]
- createdBy: MemberId
- createdAt: Timestamp
- updatedAt: Timestamp
- publishedAt: Timestamp?
- deprecatedAt: Timestamp?
- archivedAt: Timestamp?
- aggregateVersion: AggregateVersion
```

The Aggregate exposes the current revision but permanently preserves all previous revisions.

---

### KnowledgeRevision

Represents one immutable version of the Knowledge content.

Suggested attributes:

```text
KnowledgeRevision
- revisionNumber: KnowledgeRevisionNumber
- title: KnowledgeTitle
- statement: KnowledgeStatement
- description: KnowledgeDescription
- applicability: KnowledgeApplicability
- limitations: KnowledgeLimitations
- confidence: KnowledgeConfidence
- evidence: EvidenceReference[]
- changeSummary: RevisionChangeSummary
- createdBy: ActorReference
- createdAt: Timestamp
- reviewedBy: MemberId?
- reviewedAt: Timestamp?
```

A revision becomes immutable when it is published or superseded.

Changes to published Knowledge create a new revision rather than modifying the existing revision.

---

### EvidenceReference

Represents traceable support for one Knowledge revision.

Suggested attributes:

```text
EvidenceReference
- id: EvidenceReferenceId
- sourceType: KnowledgeSourceType
- sourceId: KnowledgeSourceId
- sourceOrganizationId: OrganizationId
- relevance: EvidenceRelevance
- addedBy: ActorReference
- addedAt: Timestamp
```

For the first supported implementation:

```text
sourceType = Memory
sourceId = MemoryId
```

Only Approved Memories may be associated as Evidence.

Evidence references are immutable once their Knowledge revision is published.

The source record itself remains owned by its original Aggregate.

---

### KnowledgeReviewRecord

Represents an authoritative human review action.

Suggested attributes:

```text
KnowledgeReviewRecord
- id: KnowledgeReviewRecordId
- revisionNumber: KnowledgeRevisionNumber
- reviewerId: MemberId
- action: KnowledgeReviewAction
- comment: ReviewComment?
- createdAt: Timestamp
```

Possible review actions include:

```text
Published
RevisionRequested
Deprecated
Archived
```

Review records are append-only.

---

### KnowledgeSecretaryContribution

Represents AI assistance during Knowledge development.

Examples include:

- Identifying candidate Knowledge from approved Memories
- Comparing Evidence
- Generalizing repeated patterns
- Drafting a Knowledge statement
- Identifying contradictions
- Suggesting limitations
- Recommending a Confidence score
- Finding related Knowledge
- Suggesting Capability associations

Suggested attributes:

```text
KnowledgeSecretaryContribution
- id: SecretaryContributionId
- revisionNumber: KnowledgeRevisionNumber
- type: ContributionType
- content: ContributionContent
- modelVersion: ModelVersion
- promptVersion: PromptVersion
- sourceReferences: KnowledgeSourceReference[]
- createdAt: Timestamp
```

Secretary contributions are advisory and append-only.

They never constitute human approval.

---

## Value Objects

### KnowledgeStatus

Possible values:

```text
Draft
Published
Deprecated
Archived
```

Transitions are defined in:

```text
docs/architecture/state-machines/knowledge.md
```

The Aggregate must reject transitions not permitted by the Knowledge State Machine.

---

### KnowledgeRevisionNumber

A positive integer representing the revision sequence.

```text
1, 2, 3, ...
```

Rules:

- The first revision is `1`
- Each new revision increments the number by exactly one
- Revision numbers never decrease
- Revision numbers are never reused
- Previous revisions cannot be deleted
- Only one revision is current at a time

---

### KnowledgeTitle

A concise name for the organizational knowledge.

Rules:

- Must not be empty
- Must contain meaningful visible characters
- Must remain within the configured maximum length
- Should be understandable without opening the full description

---

### KnowledgeStatement

The reusable organizational claim or recommendation.

Example:

```text
Sales proposals for non-technical audiences should generally contain
three to five visual examples.
```

Rules:

- Must not be empty
- Must express reusable guidance or organizational understanding
- Must not merely repeat a single historical event
- Must distinguish recommendation from established policy
- Must avoid claiming certainty beyond the supporting Evidence
- Becomes immutable when its revision is published

---

### KnowledgeDescription

Provides reasoning and contextual explanation.

It may include:

- Why the Knowledge matters
- How it was derived
- How it should be applied
- Related organizational context
- Interpretation guidance

It becomes immutable when its revision is published.

---

### KnowledgeApplicability

Defines when and where the Knowledge is expected to apply.

Examples:

- Relevant teams
- Work types
- Customer segments
- Products
- Regions
- Organizational conditions

Rules:

- Must be explicit enough to prevent inappropriate generalization
- May be broad or narrow
- Must be reviewed when new Evidence comes from a different context

---

### KnowledgeLimitations

Defines known exceptions, uncertainty, and boundaries.

Examples:

- Insufficient sample size
- Applies only to non-technical audiences
- Not validated outside one market
- Conflicting Evidence exists
- Effect may depend on proposal length

Limitations must not be silently removed.

Changing a published limitation requires a new revision.

---

### KnowledgeConfidence

Represents the Organization's assessed confidence in the current Knowledge revision.

Suggested structure:

```text
KnowledgeConfidence
- score: Integer
- rationale: ConfidenceRationale
- assessedBy: ActorReference
- assessedAt: Timestamp
```

The score range is:

```text
0–100
```

Interpretation guidance:

```text
0–24    Very Low
25–49   Low
50–74   Moderate
75–89   High
90–100  Very High
```

The numeric score is the authoritative stored value.

Labels are presentation-level interpretations.

Confidence is not statistical certainty unless a defined statistical method was used.

Confidence must be explainable through:

- Evidence quantity
- Evidence quality
- Evidence diversity
- Consistency of observed outcomes
- Recency
- Known contradictions
- Applicability limitations

The Secretary may recommend a Confidence score.

A human Member must confirm the score before publication.

---

### EvidenceRelevance

Explains how a source supports, limits, or contradicts the Knowledge.

Suggested values:

```text
Supports
Limits
Contradicts
```

Evidence is not restricted to supporting information.

Contradictory Evidence must be preserved because it affects:

- Confidence
- Applicability
- Limitations
- Future revisions
- Possible deprecation

---

### RevisionChangeSummary

Explains why a new revision was created.

Rules:

- Required for revisions after revision `1`
- Must describe material changes
- Must identify new, removed, or reinterpreted Evidence
- Must not rewrite prior revision history

---

### KnowledgeSourceType

Represents the type of source used as Evidence.

Initial supported value:

```text
Memory
```

Potential future values:

```text
Decision
Document
Policy
Manual
ExternalReference
```

Adding a source type requires explicit architecture and governance review.

A source type must not be activated merely by adding an enum value.

Its:

- validation rules
- trust model
- ownership
- retention behavior
- authorization
- traceability requirements

must first be defined.

---

### ActorReference

Identifies the human or AI actor responsible for a contribution.

Suggested structure:

```text
ActorReference
- actorType: Member | Secretary
- actorId: MemberId | SecretaryId
```

Only human Members may perform authoritative publication and lifecycle actions.

---

## Relationships

### Organization

Every Knowledge belongs to exactly one Organization.

```text
Organization 1 ─── * Knowledge
```

Knowledge cannot be transferred between Organizations.

All associated Evidence must originate from the same Organization unless a future external-source policy explicitly permits otherwise.

---

### Memory

Approved Memory is the initial supported Evidence source.

```text
Approved Memory * ─── * Knowledge Revision
```

A Knowledge revision must reference at least one Approved Memory before publication.

A single Approved Memory may support multiple Knowledge records.

A single Knowledge revision may reference multiple Approved Memories.

Knowledge does not own or modify Memory.

Archiving a source Memory must not break historical Evidence references.

Rejected Memories cannot be used as Evidence.

---

### Decision

Decision may be preserved inside source Memory and may provide explanatory context.

In the initial implementation, Decision is not a direct Evidence source.

A future version may support direct Decision Evidence after its:

- trust rules
- status requirements
- revision semantics
- authorization requirements

are defined.

---

### Capability

Knowledge may be associated with zero or more Capabilities.

```text
Knowledge * ─── * Capability
```

Examples:

```text
Sales
Marketing
Engineering
Customer Support
Project Management
```

Capability is not owned by the Knowledge Aggregate.

The Knowledge Aggregate stores only `CapabilityId` references.

Capability association helps:

- Human discovery
- AI retrieval
- Organizational learning analysis
- Future AI Employee specialization

A Knowledge may be published without a Capability association unless Organization policy requires one.

---

### Secretary

The Secretary may assist in creating and maintaining Knowledge.

The Secretary may:

- Detect repeated patterns across approved Memories
- Recommend Knowledge candidates
- Draft Knowledge content
- Recommend Evidence
- Identify conflicting Evidence
- Recommend Confidence
- Recommend applicability and limitations
- Suggest revisions or deprecation
- Retrieve relevant published Knowledge

The Secretary must never:

- Publish Knowledge
- Deprecate Knowledge
- Archive Knowledge
- Confirm Confidence authoritatively
- Remove published Evidence
- Rewrite published revisions
- Treat Draft Knowledge as authoritative organizational guidance

---

## Commands

The Knowledge Aggregate may support:

```text
CreateKnowledgeDraft
UpdateKnowledgeDraft
AddEvidence
RemoveDraftEvidence
SetKnowledgeConfidence
AssociateCapability
RemoveCapabilityAssociation
PublishKnowledge
CreateKnowledgeRevision
UpdateKnowledgeRevisionDraft
PublishKnowledgeRevision
DeprecateKnowledge
ArchiveKnowledge
RecordKnowledgeSecretaryContribution
```

Commands represent intent.

Every command must validate:

- Current Knowledge status
- Current revision
- Actor authority
- Organization boundary
- Evidence eligibility
- Aggregate invariants
- Optimistic concurrency version

---

## Business Rules

### Knowledge Draft Creation

A Knowledge Draft may be created when:

- The Organization exists
- The creator is an active authorized Member
- At least one candidate Approved Memory is identified
- All candidate Evidence belongs to the same Organization
- The proposed subject represents reusable Knowledge rather than one historical event

A newly created Knowledge:

- Starts in `Draft`
- Starts at revision `1`
- Has no publication timestamp
- Has no confirmed publication review
- Is not available as authoritative AI guidance

The Secretary may propose a Draft.

A human Member must explicitly create or accept it as an organizational Knowledge Draft.

---

### Knowledge Identity

A Knowledge represents exactly one reusable organizational insight.

A Knowledge may contain multiple revisions.

Every revision must represent the same underlying insight.

A revision may change:

- Wording
- Precision
- Applicability
- Limitations
- Confidence
- Evidence
- Supporting explanation

A revision must not redefine the Knowledge into a materially different organizational claim.

If the underlying subject or claim changes materially, a new Knowledge must be created.

---

### Evidence Eligibility

For the initial supported implementation:

- Evidence must reference an existing Memory
- The Memory must be `Approved`
- The Memory must belong to the same Organization
- Duplicate references within one revision are prohibited
- Evidence relevance must be recorded
- Evidence must remain traceable

A Draft may temporarily have no Evidence while being prepared.

A Knowledge cannot be published without at least one eligible Evidence reference.

---

### Evidence Diversity

Multiple Memories are preferred but not mandatory.

A Knowledge may be published from one Approved Memory when an authorized human reviewer determines that:

- The insight is sufficiently important
- The source is credible
- Applicability is appropriately limited
- Confidence reflects the limited Evidence
- The publication rationale is recorded

The system must not present a single-source Knowledge as broadly validated without qualification.

---

### Contradictory Evidence

Contradictory Evidence must not be deleted merely because it lowers Confidence.

When contradictory Evidence is added, reviewers must consider whether to:

- Lower Confidence
- Narrow applicability
- Add or revise limitations
- Create a new revision
- Deprecate the Knowledge
- Create separate Knowledge for materially different contexts

The Aggregate preserves the contradiction and the response to it.

---

### Confidence Assessment

A Knowledge revision must have a Confidence score before publication.

The score must include a rationale.

The Secretary may recommend the score using a documented method.

A human reviewer must confirm the score.

Adding Evidence does not automatically change the authoritative Confidence score.

Instead, new Evidence may trigger:

```text
KnowledgeRevisionRecommended
```

or a human review workflow.

This avoids unexplained changes to published organizational guidance.

---

### Capability Association

Capabilities may be associated while Knowledge is in Draft or Published state.

Associations must reference Capabilities belonging to the same Organization.

Changing Capability associations does not necessarily require a new content revision when the Knowledge meaning remains unchanged.

All association changes must still be audited.

Organization policy may require a revision when Capability association affects interpretation or access.

---

### Publication

Knowledge may be published only when:

- Current status is `Draft`
- The current revision has a title
- The current revision has a reusable Knowledge statement
- Applicability is defined
- Known limitations are recorded
- At least one eligible Evidence reference exists
- Confidence has been confirmed by a human Member
- The publisher is an active authorized Member
- All Evidence belongs to the same Organization
- No required review condition remains unresolved

Publication results in:

- Status becoming `Published`
- Current revision becoming immutable
- Publisher identity being recorded
- Publication timestamp being recorded
- `KnowledgePublished` being emitted

Published Knowledge may be used as authoritative organizational context by AIOS.

---

### Published Knowledge Use

Only Published Knowledge may be treated as active organizational guidance.

Draft Knowledge may be visible to authorized reviewers but must not be presented as established Knowledge.

Deprecated Knowledge may be retrieved for historical or explanatory purposes but must be clearly marked and should not be prioritized for recommendations.

Archived Knowledge is excluded from ordinary retrieval.

---

### Revision Creation

A new revision may be created from Published Knowledge when:

- New Evidence becomes available
- Existing Evidence is reinterpreted
- Confidence changes
- Applicability changes
- Limitations change
- The statement requires refinement
- Contradictory Evidence is discovered
- Organizational practice evolves

Creating a revision:

- Preserves the same `KnowledgeId`
- Increments the revision number by exactly one
- Copies the previous revision as a starting point
- Creates a mutable revision Draft
- Preserves the previously published revision
- Records the reason for revision

The previously published revision remains authoritative until the new revision is published.

---

### Revision Publication

A new revision may be published only when it satisfies all normal publication requirements.

Publishing a new revision:

- Makes the new revision current
- Makes the new revision immutable
- Preserves the prior revision as historical
- Updates the Aggregate publication timestamp
- Emits `KnowledgeRevisionPublished`

Publication must not erase earlier Evidence, Confidence, limitations, or statements.

---

### Deprecation

Published Knowledge may be deprecated when:

- It is no longer recommended
- Evidence has become unreliable
- The organizational context has materially changed
- Better Knowledge replaces it
- Contradictory Evidence substantially weakens it
- A governing policy supersedes it

Deprecation requires:

- An authorized human Member
- A reason
- A deprecation timestamp
- Optional reference to replacement Knowledge

Deprecated Knowledge:

- Remains searchable
- Remains auditable
- Must be clearly marked
- Should not be prioritized by AI
- Cannot be edited directly

A new revision may restore Deprecated Knowledge only if the future State Machine explicitly permits reactivation.

For Blueprint v0.2.0, reactivation is not supported.

---

### Archival

Knowledge may be archived when it no longer belongs in active or deprecated organizational reference.

Archival requires:

- An authorized human Member
- An archive reason
- An archive timestamp

Archived Knowledge:

- Is read-only
- Remains available for audit
- Is excluded from ordinary AI retrieval
- Must not return to an active state in the initial implementation

Archival never deletes revision or Evidence history.

---

### Secretary Contributions

Every Secretary contribution must record:

- Knowledge identity
- Relevant revision number
- Contribution type
- Content
- Model version
- Prompt version
- Source references
- Creation timestamp

Secretary contributions must remain distinguishable from human-authored content.

AI assistance must not be represented as human approval.

---

## Invariants

The following conditions must always remain true.

### Knowledge Identity

- A Knowledge represents exactly one reusable organizational insight.
- A Knowledge may have multiple revisions.
- Every revision addresses the same underlying organizational insight.
- The `KnowledgeId` remains unchanged across revisions.
- A revision must not materially redefine the original Knowledge.
- A materially different claim requires a new Knowledge.

---

### Organization Boundary

- A Knowledge belongs to exactly one Organization.
- Every Evidence source belongs to the same Organization.
- Every Capability reference belongs to the same Organization.
- Every authoritative reviewer belongs to the same Organization.
- Cross-Organization Evidence is prohibited unless explicitly supported by a future governance model.
- A Knowledge cannot be transferred between Organizations.

---

### Revision Integrity

- Revision numbers begin at `1`.
- Revision numbers increase by exactly one.
- Revision numbers are never reused.
- Only one revision is current.
- Published revisions are immutable.
- Previous revisions cannot be deleted.
- Revision history is append-only.
- Every revision after revision `1` has a change summary.

---

### Publication Integrity

A Published Knowledge must always have:

- A title
- A reusable Knowledge statement
- Defined applicability
- Recorded limitations
- At least one eligible Evidence reference
- A confirmed Confidence score
- A human publisher
- A publication timestamp

Only a human Member may publish Knowledge.

---

### Evidence Integrity

- Published Knowledge contains at least one Evidence reference.
- Initial Evidence sources are Approved Memories only.
- Rejected Memories cannot be Evidence.
- Duplicate Evidence references within one revision are prohibited.
- Evidence references remain permanently traceable.
- Published Evidence associations are immutable.
- Contradictory Evidence must not be concealed.
- Archiving a Memory must not invalidate historical Evidence references.

---

### Confidence Integrity

- Confidence is between `0` and `100`.
- Confidence includes a rationale.
- Published Confidence is human-confirmed.
- Confidence applies to one specific Knowledge revision.
- Confidence changes to published Knowledge require a new revision.
- AI recommendations must not silently replace the authoritative Confidence value.

---

### Lifecycle Integrity

- Status transitions follow the Knowledge State Machine.
- Draft Knowledge is not authoritative organizational guidance.
- Published Knowledge is the only active authoritative state.
- Deprecated Knowledge must be marked as no longer recommended.
- Archived Knowledge is read-only.
- Archived Knowledge cannot return to an active state in the initial implementation.

---

### Historical Integrity

- Published Knowledge content is immutable.
- Review records are append-only.
- Secretary contributions are append-only.
- Evidence references for published revisions are immutable.
- Actor identity and timestamps are immutable.
- Deprecation and archival reasons are preserved.
- Audit history cannot be deleted through the Knowledge Aggregate.

---

### AI Authority

- AI may propose Knowledge but cannot publish it.
- AI may recommend Confidence but cannot confirm it.
- AI may identify Evidence but cannot make unsupported Evidence eligible.
- AI may recommend revision, deprecation, or archival but cannot perform them.
- AI must not treat Draft Knowledge as established organizational guidance.
- Human authority is required for all lifecycle decisions.

---

### Knowledge–Memory Boundary

- Memory records what happened.
- Knowledge describes reusable organizational understanding.
- Memory never becomes Knowledge.
- Knowledge never modifies Memory.
- Knowledge references Memory through Evidence.
- Removing or changing Knowledge never rewrites historical Memory.

---

## Domain Events

The Knowledge Aggregate may emit:

```text
KnowledgeDraftCreated
KnowledgeDraftUpdated
KnowledgeEvidenceAdded
KnowledgeDraftEvidenceRemoved
KnowledgeConfidenceSet
KnowledgeCapabilityAssociated
KnowledgeCapabilityAssociationRemoved
KnowledgeSecretaryContributionRecorded
KnowledgePublished
KnowledgeRevisionCreated
KnowledgeRevisionDraftUpdated
KnowledgeRevisionPublished
KnowledgeDeprecated
KnowledgeArchived
```

Potential recommendation events generated outside the Aggregate may include:

```text
KnowledgeCandidateIdentified
KnowledgeRevisionRecommended
KnowledgeDeprecationRecommended
ContradictoryEvidenceDetected
```

Recommendation events do not change authoritative Aggregate state.

---

## Event Responsibilities

### KnowledgeDraftCreated

Indicates that reusable organizational Knowledge is being prepared.

Potential consumers:

- Review workflow
- Activity feed
- Audit log
- Notification service

---

### KnowledgeEvidenceAdded

Indicates that a source has been associated with the current Draft revision.

Potential consumers:

- Confidence recommendation service
- Contradiction analysis
- Review workflow
- Audit log

---

### KnowledgePublished

Indicates that a human reviewer has approved revision `1` as active organizational Knowledge.

Potential consumers:

- AI retrieval index
- Organization Brain
- Search index
- Capability catalog
- Notification service
- Audit log

---

### KnowledgeRevisionPublished

Indicates that a new revision has replaced the previous revision as the current guidance.

Potential consumers:

- AI retrieval index
- Search index
- Cache invalidation
- Related Knowledge analysis
- Notification service
- Audit log

---

### KnowledgeDeprecated

Indicates that the Knowledge should no longer be treated as recommended guidance.

Potential consumers:

- AI retrieval index
- Search index
- Related Knowledge analysis
- Notification service
- Audit log

AI retrieval must stop prioritizing the deprecated Knowledge.

---

### KnowledgeArchived

Indicates that the Knowledge has left the ordinary organizational reference lifecycle.

Potential consumers:

- AI retrieval index
- Search index
- Retention processes
- Audit log

---

## Transaction Boundary

A single Knowledge Aggregate transaction may modify:

- Draft content
- Current revision number
- Evidence associations for a Draft revision
- Confidence for a Draft revision
- Capability references
- Knowledge status
- Review history
- Secretary contributions
- Publication, deprecation, and archival metadata

The transaction must not directly modify:

- Memory Aggregate state
- Work Aggregate state
- Decision Aggregate state
- Capability definition
- Organization state
- Member state
- External documents or references

Cross-Aggregate coordination must occur through:

- Application services
- Domain events
- Event handlers
- Explicit source-validation services

---

## Authorization Boundary

The Knowledge Aggregate enforces domain-level authority rules.

Examples:

- Only human Members publish Knowledge
- Only authorized Members deprecate or archive Knowledge
- AI cannot confirm Confidence
- Published revisions cannot be edited
- Evidence must satisfy eligibility rules

Organization-wide authorization is evaluated before invoking the Aggregate.

Organization-level policy may define:

- Who may create Drafts
- Who may publish
- Whether multiple reviewers are required
- Whether self-publication is allowed
- Required Capability owners
- Minimum Evidence count
- Minimum Confidence
- Review expiration rules
- Separation of duties

The Aggregate must protect its invariants even when application-level authorization has already succeeded.

---

## Consistency Model

The internal state of one Knowledge Aggregate is strongly consistent within one transaction.

Relationships with independent Aggregates may be eventually consistent.

Examples:

- AI retrieval index updates
- Search indexing
- Capability catalog updates
- Related Knowledge discovery
- Notification delivery
- Candidate generation from newly approved Memory
- Confidence recommendations
- Contradiction detection

Evidence eligibility must be validated before the Knowledge transaction is committed.

Published Evidence references must not depend solely on an eventually consistent read model.

---

## Repository Interface

A conceptual repository interface may be defined as:

```text
KnowledgeRepository
- findById(knowledgeId): Knowledge?
- save(knowledge): void
- exists(knowledgeId): boolean
- findPublishedByOrganizationId(organizationId): Knowledge[]
- findByCapabilityId(capabilityId): Knowledge[]
- findByEvidenceSource(sourceType, sourceId): Knowledge[]
```

Repository implementation belongs to the infrastructure layer.

The domain model must not depend on:

- Database technology
- ORM models
- Vector databases
- Search engines
- LLM providers
- Transport protocols
- Framework-specific types

Semantic retrieval indexes are projections, not the source of truth.

---

## Application Service Responsibilities

The application layer coordinates Knowledge with independent Aggregates.

### Creating a Knowledge Draft from Memory

```text
1. Validate Organization membership and permission
2. Load candidate Memories
3. Confirm each Memory is Approved
4. Confirm all Memories belong to the same Organization
5. Create Knowledge Draft
6. Add Evidence references
7. Record Secretary contribution when AI assisted
8. Save Knowledge
```

---

### Publishing Knowledge

```text
1. Validate publisher permission
2. Load Knowledge
3. Validate current Draft revision
4. Revalidate Evidence eligibility
5. Confirm Confidence and rationale
6. Publish Knowledge
7. Save Knowledge
8. Update AI retrieval and search projections asynchronously
```

---

### Adding New Evidence to Published Knowledge

```text
1. Validate Member permission
2. Load Published Knowledge
3. Load and validate new Approved Memory
4. Create a new Knowledge revision
5. Add the new Evidence to the revision Draft
6. Reassess statement, applicability, limitations, and Confidence
7. Obtain human review
8. Publish the new revision
```

Published Evidence must not be mutated in place.

---

### Handling Contradictory Evidence

```text
1. Identify an Approved Memory that contradicts Published Knowledge
2. Load Knowledge
3. Create a revision Draft
4. Add the contradictory Evidence
5. Reassess Confidence
6. Narrow applicability or revise limitations when appropriate
7. Publish the revision or deprecate the Knowledge
```

The system must preserve both the original revision and the contradictory Evidence.

---

## Concurrency Requirements

Concurrent actions must not produce conflicting Knowledge states.

Examples:

- Two Members publishing different Draft contents
- Evidence added while publication occurs
- One Member deprecating while another creates a revision
- Two revisions created from the same current revision
- Confidence changed during publication review

The implementation should use optimistic concurrency control.

Suggested concept:

```text
aggregateVersion
```

Commands based on a stale Aggregate version must be rejected.

Only one publication or lifecycle transition may succeed for a given Aggregate version.

---

## Idempotency Requirements

Knowledge commands and event handlers should support idempotent execution where practical.

Examples:

- Retrying Draft creation must not create duplicate Knowledge
- Reprocessing Evidence addition must not create duplicate references
- Reprocessing `KnowledgePublished` must not duplicate search records
- Reprocessing `KnowledgeRevisionPublished` must not publish twice
- Reprocessing Secretary contributions must not duplicate entries

Infrastructure mechanisms may use:

```text
CommandId
EventId
IdempotencyKey
```

These mechanisms must not alter the domain meaning of Knowledge.

---

## Retrieval and AI Usage Rules

Only current Published Knowledge is treated as active organizational guidance.

AI retrieval should consider:

- Confidence
- Applicability
- Limitations
- Recency
- Capability association
- Evidence relevance
- Contradictory Evidence
- Knowledge status

AI responses using Knowledge should be able to identify:

- Which Knowledge was used
- Which revision was used
- The Confidence score
- Relevant limitations
- Supporting Evidence when explanation is requested

Deprecated Knowledge may be retrieved only when historical context or comparison is useful.

Archived Knowledge must be excluded from normal AI retrieval.

Retrieval ranking is an application concern and does not modify Knowledge truth.

---

## Open Questions

The following items may be refined before Blueprint v1.0.0 or the Knowledge implementation phase:

- Whether one Evidence source is sufficient for publication by default
- Whether minimum Confidence thresholds should exist
- Whether publication requires one or multiple reviewers
- Whether the creator may publish their own Knowledge
- Whether Confidence should be entirely human-assessed or formula-assisted
- How Evidence quality and diversity are formally scored
- Whether Published Knowledge requires periodic review
- Whether Knowledge can expire automatically
- Whether Deprecated Knowledge may ever return to Published
- Whether Archived Knowledge may be restored
- Whether Capability association is optional or mandatory
- Whether related Knowledge references belong inside this Aggregate
- Whether replacement Knowledge should be formally linked during deprecation
- When additional `KnowledgeSourceType` values should be introduced
- Whether policy and regulatory sources require a separate Aggregate
- How Organization-wide Knowledge access restrictions should be represented
- Whether contradictory contexts should create revisions or separate Knowledge
- Whether localization and translated Knowledge share one identity

These questions do not change the primary Aggregate boundary.

---

## Related Documents

- `docs/product/mvp.md`
- `docs/product/roadmap.md`
- `docs/architecture/aggregates/work.md`
- `docs/architecture/aggregates/decision.md`
- `docs/architecture/aggregates/memory.md`
- `docs/architecture/state-machines/knowledge.md`
- `docs/architecture/state-machines/memory.md`
- `docs/architecture/authorization.md`
- `docs/glossary.md`