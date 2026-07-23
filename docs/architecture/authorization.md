# Authorization Model

## Purpose

This document defines the authorization model for AIOS.

Authorization determines whether an Actor may perform a specific Action on a specific Resource within an Organization.

The purpose of this model is to ensure that:

- organizational boundaries are preserved,
- human authority remains explicit,
- AI assistance never becomes implicit authority,
- lifecycle transitions are performed only by permitted Actors,
- Aggregate invariants remain protected,
- and authorization decisions remain explainable and auditable.

Authorization is distinct from authentication.

Authentication answers:

> Who is the Actor?

Authorization answers:

> Is this Actor allowed to perform this Action on this Resource in this context?

---

## Core Principles

AIOS authorization follows these principles:

1. Every authoritative action is performed within an Organization boundary.
2. Human Members and AI Secretaries have different authority.
3. AI may assist, recommend, draft, summarize, and analyze.
4. AI must not perform authoritative human approval actions.
5. Application-level permission checks do not replace Aggregate invariants.
6. Aggregate invariants do not replace Organization-level permission checks.
7. Authorization must be evaluated at command execution time.
8. Authorization decisions should be auditable.
9. Published or approved historical records must not be silently rewritten.
10. The least-privilege principle applies by default.

---

## Authorization Layers

Authorization is evaluated across multiple layers.

```text
Authentication
      │
      ▼
Organization Boundary
      │
      ▼
Membership Status
      │
      ▼
Role / Permission Policy
      │
      ▼
Resource Context
      │
      ▼
Aggregate Invariants
      │
      ▼
Command Execution
```

Each layer has a separate responsibility.

---

## Authentication Layer

The authentication layer confirms the identity of an Actor.

Possible Actor types:

```text
Member
Secretary
System
```

Authentication is responsible for:

- validating credentials,
- identifying the Actor,
- issuing a trusted Actor identity,
- identifying the active Organization context,
- and rejecting unauthenticated requests.

Authentication does not determine whether the Actor may perform a domain action.

---

## Organization Boundary

Every domain Resource belongs to exactly one Organization unless explicitly defined otherwise.

Examples:

- Work
- Decision
- Memory
- Knowledge
- Capability
- Secretary
- Member

An Actor may act only within an Organization in which the Actor has an active and authorized relationship.

Cross-Organization access is prohibited by default.

```text
Actor OrganizationId
        =
Resource OrganizationId
```

This boundary must be enforced before invoking the Aggregate.

The Aggregate must also reject cross-Organization references when necessary to preserve invariants.

---

## Actor Types

### Member

A Member is a human participant in an Organization.

A Member may perform authoritative actions when permitted by Organization policy.

Examples:

- Create Work
- Start Work
- Complete Work
- Propose Decision
- Approve Decision
- Review Memory
- Approve Memory
- Publish Knowledge
- Deprecate Knowledge

A Member's authority depends on:

- Membership status
- Assigned roles
- Explicit permissions
- Resource relationship
- Organization policy
- Lifecycle state

---

### Secretary

A Secretary is an AI Actor that assists an Organization.

The Secretary may:

- summarize information,
- draft content,
- identify patterns,
- recommend actions,
- suggest Evidence,
- recommend Confidence,
- record contributions,
- and retrieve permitted organizational context.

The Secretary must never:

- approve a Decision,
- reject a Decision,
- approve a Memory,
- reject a Memory,
- publish Knowledge,
- deprecate Knowledge,
- archive Knowledge,
- confirm Confidence authoritatively,
- alter approved or published historical records,
- or grant permissions.

The Secretary is not treated as a Member.

AI assistance must remain distinguishable from human authority.

---

### System

The System Actor represents trusted automated processes.

Examples:

- generating Memory after `WorkCompleted`,
- delivering notifications,
- updating search projections,
- building retrieval indexes,
- processing domain events,
- applying retention policies approved by governance.

The System Actor may perform only explicitly defined automated actions.

System authority must not be interpreted as unrestricted authority.

A System action must have:

- a defined trigger,
- a defined scope,
- an idempotency mechanism,
- an auditable execution record,
- and a documented ownership boundary.

---

## Membership Status

A Member may have one of the following statuses:

```text
Invited
Active
Suspended
Deactivated
```

Only `Active` Members may perform ordinary domain actions.

### Invited

The Member has been invited but has not completed activation.

An Invited Member may not perform domain actions.

### Active

The Member may act according to assigned authorization policy.

### Suspended

The Member temporarily loses domain action authority.

Existing historical records remain attributed to the Member.

### Deactivated

The Member no longer has active access.

Deactivation must not delete:

- authorship history,
- approval history,
- review records,
- audit records,
- or domain event attribution.

---

## Role Model

AIOS may use roles as permission groupings.

Suggested Organization roles:

```text
OrganizationOwner
Administrator
Contributor
Reviewer
KnowledgePublisher
Viewer
```

Roles are not domain concepts unless Organization governance requires them to be.

They are authorization policy constructs.

A Member may have multiple roles.

Role names alone must not be used inside Aggregates.

Aggregates should receive domain-relevant authorization facts rather than infrastructure-specific role names.

Example:

```text
canApproveMemory = true
```

instead of:

```text
role == "Administrator"
```

---

## Suggested Role Responsibilities

### OrganizationOwner

May manage Organization-level governance.

Possible permissions:

- Manage Members
- Assign Roles
- Configure authorization policy
- Configure Secretary access
- Create and archive Organization resources
- View all audit records
- Delegate administrative authority

Organization ownership does not automatically override Aggregate invariants.

---

### Administrator

May manage operational settings and Members according to delegated policy.

Possible permissions:

- Invite Members
- Suspend Members
- Assign permitted roles
- Manage Organization settings
- Archive eligible resources
- Configure review policies

An Administrator must not automatically gain approval authority unless explicitly granted.

---

### Contributor

May participate in organizational Work.

Possible permissions:

- Create Work
- Update Work
- Participate in Work
- Propose Decisions
- Add Decision options
- Request reviews
- Draft Knowledge
- Add Draft Evidence

Contributor authority does not include authoritative approval by default.

---

### Reviewer

May perform defined human review actions.

Possible permissions:

- Approve or reject Decisions
- Review Memory
- Approve or reject Memory
- Request revisions
- Record review comments

Review authority may be resource-specific or Capability-specific.

---

### KnowledgePublisher

May perform authoritative Knowledge actions.

Possible permissions:

- Publish Knowledge
- Publish Knowledge revisions
- Confirm Confidence
- Deprecate Knowledge
- Recommend archival
- Review Evidence eligibility

Knowledge publication authority should be separated from ordinary contribution authority when governance requires it.

---

### Viewer

May read Resources within permitted scope.

Possible permissions:

- View Work
- View Decisions
- View approved Memory
- View Published Knowledge
- Search organizational information

Viewer access must respect Resource visibility and confidentiality rules.

---

## Permission Model

Authorization should be represented as explicit Actions.

Suggested permission naming convention:

```text
<Resource>.<Action>
```

Examples:

```text
Work.Create
Work.View
Work.Update
Work.Start
Work.Complete
Work.Archive

Decision.Create
Decision.View
Decision.Update
Decision.Propose
Decision.Approve
Decision.Reject
Decision.Revise
Decision.Withdraw

Memory.View
Memory.StartReview
Memory.Approve
Memory.Reject
Memory.Archive
Memory.RequestKnowledgePromotion

Knowledge.CreateDraft
Knowledge.ViewDraft
Knowledge.UpdateDraft
Knowledge.AddEvidence
Knowledge.RemoveDraftEvidence
Knowledge.SetConfidence
Knowledge.Publish
Knowledge.CreateRevision
Knowledge.PublishRevision
Knowledge.Deprecate
Knowledge.Archive

Capability.View
Capability.Manage

Member.Invite
Member.Suspend
Member.Deactivate
Member.AssignRole

Organization.ManagePolicy
Organization.ViewAudit
```

Permissions should be scoped to one Organization.

Some permissions may also be scoped to:

- specific Work,
- specific Capability,
- specific team,
- ownership,
- participant relationship,
- or Resource visibility.

---

## Resource Context

Authorization is not determined by role alone.

The application layer must evaluate Resource context.

Examples:

- Is the Member a participant in the Work?
- Is the Member the Decision proposer?
- Is self-approval allowed?
- Is the reviewer independent from the author?
- Does the Member own the relevant Capability?
- Is the Resource archived?
- Is the Member acting within the same Organization?
- Does the Resource contain restricted information?
- Has a required separation-of-duties rule been satisfied?

The same Member may be authorized for one Resource and unauthorized for another.

---

## Ownership and Participation

Ownership and participation may affect access but do not automatically grant all authority.

Examples:

- A Work owner may edit the Work.
- A Work participant may view the Work.
- A Decision proposer may revise the Decision.
- A Decision proposer may not approve their own Decision if self-approval is disabled.
- A Memory reviewer may approve Memory only when explicitly authorized.
- A Knowledge creator may not publish their own Knowledge if separation of duties is required.

Ownership is one authorization input, not a universal permission.

---

## Self-Approval

Self-approval is an Organization policy.

Blueprint v0.2.0 allows self-approval for Decision in the MVP unless stricter policy is configured.

Possible policy values:

```text
Allowed
Forbidden
AllowedBelowRiskThreshold
RequiresAdditionalReviewer
```

Self-approval rules may differ by Resource type.

Examples:

```text
Decision:
Allowed in MVP

Memory:
Configurable

Knowledge:
Prefer separation of duties
```

An Aggregate should receive the resolved authorization decision.

It should not directly query Organization policy.

---

## Separation of Duties

Organizations may require different Members to perform different stages.

Example:

```text
Knowledge Draft Author
        ≠
Knowledge Publisher
```

Possible separation rules:

- Creator cannot approve
- Proposer cannot reject
- Memory generator cannot review
- Knowledge author cannot publish
- Administrator cannot assign themselves elevated authority
- One Member cannot satisfy multiple required review slots

Separation of duties belongs primarily to Organization authorization policy and application workflow.

The Aggregate protects any invariant that is necessary for domain correctness.

---

## Human Authority Matrix

The following matrix represents default domain authority.

| Action | Member | Secretary | System |
|---|---:|---:|---:|
| Create Work | Yes, with permission | No | No |
| Update Work | Yes, with permission | Suggest only | Defined automation only |
| Complete Work | Yes, with permission | No | No |
| Propose Decision | Yes | Draft only | No |
| Approve Decision | Yes, with permission | No | No |
| Reject Decision | Yes, with permission | No | No |
| Generate Memory | No direct command | Draft contribution | Yes, after Work completion |
| Approve Memory | Yes, with permission | No | No |
| Reject Memory | Yes, with permission | No | No |
| Create Knowledge Draft | Yes, with permission | Propose only | Defined workflow only |
| Publish Knowledge | Yes, with permission | No | No |
| Confirm Confidence | Yes, with permission | Recommend only | No |
| Deprecate Knowledge | Yes, with permission | Recommend only | No |
| Archive Knowledge | Yes, with permission | No | Policy-driven only if explicitly defined |
| Grant permissions | Authorized Member only | No | No |

`Yes` always assumes Organization and Resource policy validation.

---

## Aggregate Authorization Responsibilities

Each Aggregate enforces domain-specific authority constraints.

The Aggregate must not depend on a full role engine.

Instead, the application layer provides validated Actor and authorization context.

Suggested command context:

```text
CommandContext
- actor
- organizationId
- permissions
- authorizationFacts
- correlationId
- commandId
- timestamp
```

Example authorization facts:

```text
isActiveMember
isWorkParticipant
isWorkOwner
isDecisionProposer
canSelfApprove
isIndependentReviewer
canPublishKnowledge
canArchiveResource
```

The Aggregate uses only facts required to protect domain rules.

---

## Application Layer Responsibilities

The application layer is responsible for:

- Authenticating the Actor
- Resolving active Organization context
- Loading Membership
- Evaluating roles and permissions
- Loading Resource authorization context
- Evaluating Organization policy
- Evaluating ownership and participation
- Evaluating separation-of-duties rules
- Producing authorization facts
- Rejecting unauthorized commands
- Recording the authorization decision
- Invoking the Aggregate only after successful authorization

The application layer must not bypass Aggregate invariants.

---

## Infrastructure Responsibilities

Infrastructure may provide:

- Identity provider integration
- Session management
- Token validation
- Role storage
- Permission storage
- Policy evaluation engine
- Audit log persistence
- Access-control projections
- Caching
- Organization context resolution

Infrastructure must not define domain meaning.

Infrastructure failures must fail closed for authoritative actions.

---

## Work Authorization

### Create Work

Requirements:

- Actor is an Active Member
- Actor belongs to the Organization
- Actor has `Work.Create`

### View Work

Requirements may include:

- Organization-wide visibility
- Work ownership
- Work participation
- Explicit access grant
- Administrative access

### Update Work

Requirements:

- Work is editable
- Actor has `Work.Update`
- Actor satisfies ownership or participation policy

### Start Work

Requirements:

- Actor has `Work.Start`
- Work is in a startable state
- Actor belongs to the same Organization

### Complete Work

Requirements:

- Actor has `Work.Complete`
- Work satisfies completion invariants
- Actor belongs to the same Organization

### Archive Work

Requirements:

- Actor has `Work.Archive`
- Work is in an archivable state
- Historical integrity is preserved

---

## Decision Authorization

### Create or Propose Decision

Requirements:

- Actor is an Active Member
- Actor has `Decision.Create` or `Decision.Propose`
- Related Work belongs to the same Organization
- Actor has access to the related Work

### Update Decision Draft

Requirements:

- Actor has `Decision.Update`
- Decision is editable
- Actor satisfies proposer, owner, or delegated-editor policy

### Approve Decision

Requirements:

- Actor is an Active human Member
- Actor has `Decision.Approve`
- Decision is in an approvable state
- Blocking Decisions are resolved
- Self-approval policy is satisfied
- Organization boundary is satisfied

Secretary and System Actors cannot approve Decisions.

### Reject Decision

Requirements:

- Actor is an Active human Member
- Actor has `Decision.Reject`
- Decision is in a rejectable state
- Rejection reason is provided

### Revise Decision

Requirements:

- Actor has `Decision.Revise`
- Decision revision rules are satisfied
- The organizational question remains unchanged

### Withdraw Decision

Requirements:

- Actor has `Decision.Withdraw`
- Actor satisfies proposer or delegated-authority policy
- Decision is in a withdrawable state

---

## Memory Authorization

### View Memory

Requirements depend on:

- Organization membership
- Memory status
- Source Work access
- Confidentiality policy
- Reviewer assignment
- Administrative access

Approved Memory may be more broadly discoverable than Draft or In Review Memory.

### Start Memory Review

Requirements:

- Actor is an Active human Member
- Actor has `Memory.StartReview`
- Memory is in `Generated`
- Actor may access the source Work context

### Approve Memory

Requirements:

- Actor is an Active human Member
- Actor has `Memory.Approve`
- Memory is in `InReview`
- Human review requirements are satisfied
- Separation-of-duties policy is satisfied when configured

The Secretary cannot approve Memory.

### Reject Memory

Requirements:

- Actor is an Active human Member
- Actor has `Memory.Reject`
- Memory is in `InReview`
- Rejection reason is provided

### Archive Memory

Requirements:

- Actor has `Memory.Archive`
- Memory is in an archivable state
- Evidence traceability will not be broken

### Request Knowledge Promotion

Requirements:

- Actor has `Memory.RequestKnowledgePromotion`
- Memory is `Approved`
- The request does not create Knowledge directly
- Knowledge governance remains separate

The Secretary may recommend promotion but cannot authorize it.

---

## Knowledge Authorization

### Create Knowledge Draft

Requirements:

- Actor is an Active human Member
- Actor has `Knowledge.CreateDraft`
- Candidate Evidence belongs to the same Organization
- Candidate Evidence is accessible to the Actor
- At least one Approved Memory is identified before publication

The Secretary may propose a candidate but does not perform authoritative creation without a defined human-accepted workflow.

### View Knowledge Draft

Requirements:

- Actor has `Knowledge.ViewDraft`
- Actor belongs to the Organization
- Draft visibility policy permits access

Published Knowledge may have broader visibility than Draft Knowledge.

### Update Knowledge Draft

Requirements:

- Actor has `Knowledge.UpdateDraft`
- Current revision is editable
- Actor satisfies author, editor, or delegated-owner policy

### Add Evidence

Requirements:

- Actor has `Knowledge.AddEvidence`
- Source Memory is `Approved`
- Source Memory belongs to the same Organization
- Actor may access the source Memory
- Duplicate Evidence is not created

### Remove Draft Evidence

Requirements:

- Actor has `Knowledge.RemoveDraftEvidence`
- Revision is still Draft
- Publication invariants remain satisfiable

Published Evidence cannot be removed.

### Set Confidence

Requirements:

- Actor is an Active human Member
- Actor has `Knowledge.SetConfidence`
- Revision is Draft
- Rationale is provided

The Secretary may recommend Confidence but cannot confirm it.

### Publish Knowledge

Requirements:

- Actor is an Active human Member
- Actor has `Knowledge.Publish`
- Publication invariants are satisfied
- Review requirements are satisfied
- Separation-of-duties policy is satisfied
- Evidence has been revalidated
- Confidence has been human-confirmed

### Create Knowledge Revision

Requirements:

- Actor has `Knowledge.CreateRevision`
- Knowledge is `Published`
- Actor belongs to the same Organization
- Revision reason is recorded

### Publish Knowledge Revision

Requirements:

- Actor has `Knowledge.PublishRevision`
- All publication requirements are satisfied
- Revision identity remains valid
- Previous revision remains preserved

### Deprecate Knowledge

Requirements:

- Actor is an Active human Member
- Actor has `Knowledge.Deprecate`
- Knowledge is `Published`
- Deprecation reason is recorded
- Replacement Knowledge is recorded when applicable

### Archive Knowledge

Requirements:

- Actor is an Active human Member
- Actor has `Knowledge.Archive`
- Knowledge is in an archivable state
- Archive reason is recorded
- Historical traceability is preserved

---

## Capability-Scoped Authorization

Organizations may scope Knowledge authority by Capability.

Example:

```text
Member A
- KnowledgePublisher for Sales

Member B
- KnowledgePublisher for Engineering
```

Member A may publish Sales Knowledge but not Engineering Knowledge.

Capability-scoped authorization may apply to:

- Draft creation
- Review
- Publication
- Deprecation
- Archival
- Discovery
- AI retrieval access

Capability scope is evaluated by the application layer.

The Knowledge Aggregate stores Capability references but does not resolve Member Capability authority.

---

## Confidentiality and Visibility

Authorization should support Resource visibility.

Suggested visibility values:

```text
Private
Restricted
Organization
```

### Private

Visible only to:

- Resource owner
- Explicitly authorized Members
- Administrators with permitted access

### Restricted

Visible to:

- Explicit teams
- Capabilities
- participants
- reviewers
- or permission groups

### Organization

Visible to all Active Members in the Organization.

Visibility does not override lifecycle restrictions.

For example:

- Draft Knowledge may remain restricted even when future Published Knowledge will be Organization-visible.
- Archived Resources remain hidden from ordinary discovery even when historically Organization-visible.

---

## AI Retrieval Authorization

The Secretary must retrieve only information the requesting Member is authorized to access.

AI retrieval must evaluate:

- Member identity
- Organization
- Resource visibility
- lifecycle state
- Capability scope
- confidentiality
- source permissions
- current request context

The Secretary must not expose restricted source content through a generated summary.

```text
Unauthorized Source
        │
        ├── must not be quoted
        ├── must not be summarized
        ├── must not influence visible output
        └── must not be revealed indirectly
```

Retrieval indexes must preserve authorization metadata.

A semantic search match does not grant access.

---

## Secretary Scope

Each Secretary belongs to exactly one Organization.

A Secretary may be granted access scopes such as:

```text
Work.Read
Decision.Read
Memory.ReadApproved
Knowledge.ReadPublished
Knowledge.DraftAssist
```

A Secretary must not receive broader access than necessary.

Secretary access should be configurable by:

- Resource type
- lifecycle state
- Capability
- team
- visibility
- purpose

Secretary access must be auditable.

---

## Delegation

A Member may delegate limited authority when Organization policy permits it.

Delegation must specify:

```text
Delegation
- delegatorId
- delegateId
- organizationId
- permissions
- resourceScope
- validFrom
- validUntil
- reason
- createdAt
- revokedAt
```

Delegation must:

- be explicit,
- be time-bound when possible,
- not exceed the delegator's own authority,
- remain auditable,
- and be revocable.

AI Secretaries cannot receive delegated human approval authority.

---

## Temporary Access

Temporary access may be granted for:

- review,
- incident response,
- external audit,
- project participation,
- or limited operational support.

Temporary access must have:

- explicit scope,
- expiration,
- granting Member,
- reason,
- and audit history.

Expiration must automatically remove effective permission.

Historical attribution remains unchanged.

---

## Authorization Decision

A conceptual authorization decision may contain:

```text
AuthorizationDecision
- decision: Allow | Deny
- actorId
- actorType
- organizationId
- action
- resourceType
- resourceId
- evaluatedPolicies
- reason
- evaluatedAt
- correlationId
```

Denied actions should provide a safe, non-sensitive reason.

Examples:

```text
Member is not active.

Resource belongs to another Organization.

Required permission is missing.

Self-approval is not permitted.

Knowledge Evidence is not eligible.

Resource state does not permit this action.
```

Error messages must not reveal inaccessible Resource details.

---

## Audit Requirements

Authoritative authorization-sensitive actions must be auditable.

Audit records should include:

```text
AuditRecord
- actor
- organizationId
- action
- resourceType
- resourceId
- authorizationResult
- policyVersion
- commandId
- correlationId
- timestamp
- relevant authorization facts
```

Audit records are append-only.

Audit records must not contain:

- raw credentials,
- access tokens,
- unnecessary personal information,
- or confidential content unrelated to the authorization decision.

---

## Policy Versioning

Authorization policy may change over time.

Each authoritative action should be traceable to the policy version used at execution.

```text
AuthorizationPolicyVersion
```

Policy changes apply prospectively.

Changing a policy must not rewrite the validity of historical actions that were authorized under an earlier policy.

Historical actions remain evaluated according to the policy in effect at execution time.

---

## Default-Deny Policy

AIOS uses default deny.

```text
No explicit permission
        =
Access denied
```

An action is permitted only when:

- the Actor is authenticated,
- the Organization boundary matches,
- Membership is active when required,
- permission is granted,
- contextual policy is satisfied,
- and Aggregate invariants permit the action.

Unknown or incomplete authorization information results in denial for authoritative actions.

---

## Fail-Closed Behavior

When authorization infrastructure is unavailable:

- authoritative writes must fail,
- approval actions must fail,
- publication actions must fail,
- permission changes must fail,
- restricted reads must fail.

Read-only access to safely cached public Organization content may be allowed only when explicitly designed and documented.

---

## Consistency Model

Authorization for authoritative commands must use sufficiently current data.

Strong or transactional consistency is preferred for:

- Membership status
- Permission assignment
- role changes
- suspension
- deactivation
- Organization boundary
- self-approval policy
- separation-of-duties policy

Eventually consistent projections may support:

- navigation
- search filtering
- UI hints
- non-authoritative access previews

The server must re-evaluate authorization when executing a command.

UI visibility is not authorization enforcement.

---

## Caching

Authorization results may be cached only when:

- the cache scope is explicit,
- Organization and Actor are part of the cache key,
- policy version is included,
- expiration is short,
- revocation behavior is defined,
- and authoritative commands are revalidated when necessary.

Suggested cache key:

```text
ActorId
OrganizationId
Action
ResourceId
PolicyVersion
MembershipVersion
```

Role or Membership changes must invalidate relevant caches.

---

## Authorization and Domain Events

Domain events must preserve Actor attribution when the event represents a human action.

Example:

```text
KnowledgePublished
- knowledgeId
- revisionNumber
- organizationId
- publishedBy
- occurredAt
```

System-generated events should identify:

- originating event,
- system handler,
- correlation ID,
- causation ID.

Consumers of domain events must not assume that event possession grants Resource access.

Event payloads should contain only the information required by consumers.

---

## Authorization and APIs

Every command endpoint must:

1. Authenticate the Actor
2. Resolve Organization context
3. Load the relevant Resource
4. Evaluate authorization
5. Validate request intent
6. Invoke the Aggregate
7. Persist changes
8. Record audit information
9. Publish domain events

Resource identifiers must not be treated as proof of access.

Mass assignment of role, status, ownership, or Organization identifiers must be prohibited.

---

## Authorization and Background Jobs

Background jobs act as the System Actor.

Each job must have:

- one documented purpose,
- one permission scope,
- explicit Resource boundaries,
- idempotency,
- audit logging,
- retry behavior,
- and failure handling.

A background job must not bypass lifecycle or Organization invariants.

Example:

```text
WorkCompleted
      │
      ▼
GenerateInitialMemoryJob
      │
      ├── validates Work organization
      ├── checks Memory does not already exist
      ├── creates Generated Memory
      └── records causation
```

The job may generate Memory because this authority is explicitly defined.

It may not approve the generated Memory.

---

## Security Invariants

The following authorization invariants must always hold:

### Organization Isolation

- An Actor cannot access another Organization's Resource by changing an identifier.
- Cross-Organization references are rejected.
- Search and AI retrieval preserve Organization isolation.
- Event consumers preserve Organization isolation.

### Human Approval

- Decision approval is performed only by an authorized human Member.
- Memory approval is performed only by an authorized human Member.
- Knowledge publication is performed only by an authorized human Member.
- Confidence confirmation is performed only by an authorized human Member.

### AI Limitation

- A Secretary cannot receive human approval authority.
- A Secretary cannot grant permissions.
- A Secretary cannot change Membership status.
- A Secretary cannot bypass Resource visibility.
- A Secretary cannot convert recommendations into authoritative state changes.

### Historical Attribution

- Deactivating a Member does not remove past authorship.
- Role changes do not rewrite historical authorization.
- Published approval records remain immutable.
- Audit history remains append-only.

### Default Deny

- Missing permission means denied.
- Unknown Membership state means denied.
- Unknown Organization context means denied.
- Failed policy evaluation means denied for authoritative actions.

---

## Recommended MVP Authorization Model

For the MVP, authorization should remain simple enough to implement safely.

Recommended roles:

```text
Owner
Member
Reviewer
Viewer
```

Recommended default permissions:

### Owner

- Full Organization administration
- All operational permissions
- Decision approval
- Memory approval
- Resource archival
- Audit access

### Member

- Create and participate in Work
- Propose and revise Decisions
- View permitted Resources
- Request reviews

### Reviewer

- Member permissions
- Approve or reject Decisions
- Approve or reject Memory

### Viewer

- Read permitted Resources only

Knowledge permissions may remain inactive until the Knowledge roadmap phase.

The domain restrictions for future Knowledge should still remain documented.

---

## Recommended MVP Policies

```text
Decision self-approval:
Allowed

Memory approval:
One authorized human reviewer

Knowledge publication:
Not implemented in MVP

Cross-Organization access:
Forbidden

Secretary approval authority:
Forbidden

Archived Resource restoration:
Forbidden

Default visibility:
Organization, unless explicitly restricted
```

These defaults may be strengthened in later versions without changing Aggregate identities.

---

## Future Extensions

Future versions may support:

- Attribute-based access control
- Policy-as-code
- Team-scoped permissions
- Capability-scoped permissions
- Risk-based approval
- Approval quorum
- Multi-stage review
- External guest access
- Legal hold
- Field-level confidentiality
- Regional data boundaries
- Regulatory policy packs
- Just-in-time elevation
- Emergency access
- Machine-to-machine identities
- Fine-grained AI retrieval controls

These extensions must preserve:

- Organization isolation,
- human authority,
- auditability,
- least privilege,
- and Aggregate invariants.

---

## Open Questions

The following questions remain open before Blueprint v1.0.0:

- Should roles be fixed or Organization-configurable?
- Should permissions support explicit deny rules?
- Should Decision self-approval remain enabled after the MVP?
- Should Memory approval require a reviewer different from the Work owner?
- Should Knowledge publication require two reviewers?
- Should Capability owners automatically receive publication authority?
- Should confidential Work automatically produce confidential Memory?
- Should Published Knowledge ever contain restricted Evidence?
- How should AI explain Knowledge without revealing restricted Evidence?
- Should Members be able to belong to multiple Organizations?
- How should temporary external reviewers be represented?
- Should delegation be included in v1.0.0?
- Which policy changes require elevated approval?
- How long should authorization audit records be retained?
- Should high-risk actions require recent re-authentication?
- Should access to archived Resources require a separate permission?
- How should emergency access be governed?
- Should System jobs use separate machine identities?
- How should authorization be tested against semantic search and vector indexes?

---

## Related Documents

- `docs/architecture/overview.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/aggregates/work.md`
- `docs/architecture/aggregates/decision.md`
- `docs/architecture/aggregates/memory.md`
- `docs/architecture/aggregates/knowledge.md`
- `docs/architecture/state-machines/work.md`
- `docs/architecture/state-machines/decision.md`
- `docs/architecture/state-machines/memory.md`
- `docs/architecture/state-machines/knowledge.md`
- `docs/product/mvp.md`
- `docs/product/roadmap.md`
- `docs/glossary.md`