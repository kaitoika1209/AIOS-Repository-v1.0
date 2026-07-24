# Authorization Architecture

**Status:** Draft  
**Phase:** MVP  
**Architecture:** Modular Monolith  
**Security Model:** Organization-Scoped Human Authority

---

# Purpose

This document defines the authorization model for AIOS.

Authorization determines whether an authenticated actor may execute a specific application command against a specific resource.

The model preserves explicit Human authority while allowing the Secretary and System actors to perform limited advisory and operational actions.

Authorization is enforced before Aggregate commands are executed.

Business invariants remain enforced inside Aggregates.

---

# Goals

The authorization architecture must ensure that:

- only authorized actors execute commands
- Organization boundaries are never crossed
- Human authority remains explicit
- Secretary capabilities remain advisory
- System capabilities remain operational
- authorization rules are consistent across all Application Services
- denied operations produce no domain mutation
- every authoritative action is attributable to a Human Member
- future roles can be introduced without weakening MVP authority boundaries

---

# Non-Goals

This document does not define:

- authentication protocols
- password management
- session storage
- identity provider configuration
- OAuth implementation
- cryptographic key management
- network perimeter security
- database encryption
- external identity federation
- Knowledge access policies
- marketplace authorization
- AI Employee autonomy

Those concerns belong to separate security or future-phase designs.

---

# Security Model

AIOS uses an Organization-scoped authorization model.

Every protected operation is evaluated using:

```text
Actor

Organization

Command

Resource

Policy
```

Authorization succeeds only when all required conditions are satisfied.

---

# Core Authorization Question

Every command evaluation answers:

> May this actor perform this command on this resource within this Organization?

The result is always explicit:

```text
Allowed

Denied
```

No implicit fallback grants authority.

---

# Authentication and Authorization

Authentication and authorization are separate concerns.

---

## Authentication

Authentication establishes actor identity.

It answers:

> Who is making this request?

Authentication may provide:

```text
principalId
principalType
organizationId
sessionId
authenticationMethod
authenticatedAt
```

---

## Authorization

Authorization evaluates permission.

It answers:

> Is this authenticated actor allowed to perform this operation?

Authentication alone never grants business authority.

---

# Architectural Position

```text
Incoming Request
        │
        ▼
Authentication
        │
        ▼
Principal Resolution
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

Authorization occurs before the Aggregate command.

The Aggregate still validates business invariants after authorization succeeds.

---

# Responsibility Separation

## Authentication Layer

Responsible for:

- verifying identity
- validating credentials or tokens
- resolving authenticated principal
- rejecting unauthenticated requests

---

## Authorization Layer

Responsible for:

- evaluating permissions
- checking Organization membership
- evaluating resource scope
- validating role and capability requirements
- returning Allow or Deny
- producing authorization audit information

---

## Application Layer

Responsible for:

- requesting authorization evaluation
- passing command and resource context
- rejecting denied commands
- supplying ActorReference to the Aggregate
- preserving correlation metadata

---

## Domain Layer

Responsible for:

- business invariants
- lifecycle rules
- state transition validation
- Human authority invariants where domain-significant
- recording authoritative actors

The Domain Layer does not query permission stores.

---

## Infrastructure Layer

Responsible for:

- permission persistence
- membership lookup
- policy data access
- identity provider integration
- security logging
- audit storage

Infrastructure does not decide business meaning.

---

# Principal Types

The MVP recognizes three principal types:

```text
HumanMember

Secretary

System
```

Every command must be associated with exactly one principal.

---

# Human Member Principal

A Human Member represents an authenticated person who belongs to an Organization.

Human Members are the only principals with business authority.

A Human Member may perform authoritative actions when authorized by policy.

Examples include:

- creating Work
- starting Work
- completing Work
- submitting Decisions
- approving Decisions
- rejecting Decisions
- withdrawing Decisions
- submitting Memory
- approving Memory
- rejecting Memory

---

# Human Authority Principle

All final business decisions require explicit Human action.

The following transitions must always be attributable to a Human Member:

```text
Work -> Completed

Decision -> InReview

Decision -> Approved

Decision -> Rejected

Decision -> Withdrawn

Memory -> InReview

Memory -> Approved

Memory -> Rejected
```

Neither Secretary nor System may originate these transitions.

---

# Secretary Principal

The Secretary represents an AI-assisted advisory actor.

The Secretary may:

- generate draft content
- summarize information
- propose revisions
- suggest rationale
- organize content
- prepare Memory candidates
- produce non-authoritative recommendations

The Secretary has no business authority.

---

# Secretary Prohibitions

The Secretary may never:

- complete Work
- cancel Work
- submit Decisions
- approve Decisions
- reject Decisions
- withdraw Decisions
- submit Memory for review
- approve Memory
- reject Memory
- promote Memory to Knowledge
- grant permissions
- change Organization membership
- impersonate a Human Member

---

# Advisory-Only Rule

Secretary output remains advisory until a Human Member explicitly incorporates or accepts it.

Example:

```text
Secretary generates Decision draft
        │
        ▼
Secretary Contribution recorded
        │
        ▼
Human reviews suggestion
        │
        ▼
Human executes EditDraft
```

The Secretary contribution does not become authoritative content automatically.

---

# System Principal

The System principal represents trusted internal automation.

The System may perform operational actions such as:

- publishing Outbox events
- invoking event handlers
- scheduling retries
- generating Memory candidates
- executing reconciliation checks
- recording processing outcomes
- maintaining operational metadata

The System has no business authority.

---

# System Prohibitions

The System may never:

- approve a Decision
- reject a Decision
- complete Work
- approve Memory
- reject Memory
- promote Memory to Knowledge
- create Human authorization decisions
- impersonate a Human Member
- bypass Aggregate commands

---

# Operational Authority

System authority is limited to actions required for reliable execution.

Examples:

```text
Publish DecisionApproved event

Record processed event

Invoke GenerateMemory handler

Retry failed Outbox publication
```

These actions execute previously authorized or domain-generated intent.

They do not create new business intent.

---

# Principal Identity

Every principal has a stable identifier.

Recommended representation:

```text
PrincipalReference
- principalId
- principalType
- organizationId
```

Principal identifiers must remain auditable over time.

---

# Actor Reference

Aggregate commands receive an ActorReference representing the actor responsible for the operation.

Example:

```text
ActorReference
- actorId
- actorType
- organizationId
```

The ActorReference is stored in domain history where attribution is required.

---

# Principal and Actor Distinction

A Principal represents the authenticated execution identity.

An ActorReference represents the identity recorded in domain history.

In most Human commands:

```text
Principal = Human Member

ActorReference = same Human Member
```

For asynchronous processing:

```text
Principal = System

Causation = prior Human-authorized event
```

The original Human authority remains traceable through correlation and causation metadata.

---

# No Anonymous Authority

Anonymous principals may access only explicitly public or unauthenticated endpoints.

Anonymous principals may never execute authoritative domain commands.

---

# No Shared Human Identity

Shared Human accounts are prohibited.

Every Human-authoritative action must be attributable to one identifiable person.

Generic identities such as:

```text
admin

team-user

shared-account
```

must not be used for business approval or completion.

---

# Organization Membership

A Human Member must belong to the Organization containing the target resource.

Example:

```text
Human Organization = org-A

Work Organization = org-A

Result = eligible for policy evaluation
```

Cross-Organization access is denied by default.

---

# Organization Boundary

Every protected resource belongs to exactly one Organization.

Examples:

- Work
- Decision
- Memory
- Member assignment
- Secretary Contribution

Authorization never permits a command to cross Organization boundaries.

---

# Default Deny

AIOS uses a default-deny model.

If no policy explicitly allows an operation:

```text
Denied
```

Missing policy data never results in permission.

---

# Least Privilege

Principals receive only the minimum permissions required for their responsibilities.

Examples:

- a reviewer may approve Decisions but not manage Organization membership
- a contributor may edit Drafts but not approve them
- the Secretary may record suggestions but not submit them
- the System may process events but not complete Work

---

# Explicit Authority

Authority must be explicit.

The system must not infer permission from:

- content authorship alone
- assignment alone
- prior participation alone
- Secretary recommendation
- event delivery
- administrative convenience

Each authoritative command requires a matching policy decision.

---

# Separation of Advisory and Authoritative Actions

AIOS distinguishes two action categories.

---

## Advisory Actions

Examples:

- generate draft
- summarize
- suggest changes
- provide recommendation
- record Secretary Contribution

These may be performed by Secretary or Human Members.

---

## Authoritative Actions

Examples:

- submit
- approve
- reject
- withdraw
- complete
- cancel

These require Human Member authority.

---

# Authority Cannot Be Delegated to AI

A Human Member cannot delegate final business authority to the Secretary or System.

The following configuration is invalid:

```text
Secretary may auto-approve Decisions
```

The following configuration is also invalid:

```text
System completes Work after Decision approval
```

Human authority is a domain constraint, not an optional preference.

---

# Policy Inputs

Authorization policies may evaluate:

```text
principalType
principalId
organizationId
roleAssignments
commandType
resourceType
resourceId
resourceOrganizationId
resourceRelationship
resourceState
requestedAt
```

Policies should use only data required for the decision.

---

# Resource State Usage

Authorization may consider resource state when access meaning changes.

Example:

- a Draft Decision may be editable
- an Approved Decision is not editable

However, business lifecycle validity remains enforced by the Aggregate.

Authorization must not duplicate Aggregate state-transition logic.

---

# Authorization Versus Business Validation

Example:

```text
Human has ApproveDecision permission
```

Authorization result:

```text
Allowed
```

But if the Decision is still Draft, the Aggregate rejects approval.

Authorization answers:

> May this Human attempt approval?

The Aggregate answers:

> Is approval valid in the current domain state?

Both checks are required.

---

# Policy Decision

A policy evaluation returns a structured result.

Example:

```text
AuthorizationDecision
- outcome
- policyId
- reasonCode
- evaluatedAt
```

Possible outcomes:

```text
Allow

Deny
```

The MVP does not use indeterminate authorization outcomes.

Infrastructure errors result in denial.

---

# Deny on Failure

If authorization data cannot be loaded or evaluated safely:

```text
Denied
```

Examples:

- membership lookup failure
- missing Organization context
- invalid role assignment
- corrupted permission record

Security-critical failures must never fail open.

---

# Policy Reason Codes

Recommended denial reason codes include:

```text
Unauthenticated

PrincipalTypeNotAllowed

OrganizationMismatch

MembershipInactive

PermissionMissing

ResourceNotAccessible

RoleNotAllowed

HumanAuthorityRequired

PolicyDataUnavailable
```

External responses may expose a reduced message.

Detailed reason codes belong in secure audit logs.

---

# Human Presence Requirement

Authoritative commands require a directly authenticated Human Member.

A System event cannot substitute for Human presence.

Example:

```text
DecisionApproved event
```

proves that approval previously occurred.

It does not authorize a new Human-only command such as Work completion.

---

# Causation Does Not Grant Authority

An authoritative event may trigger operational follow-up.

Example:

```text
Human approves Decision

↓

System records Decision outcome in Work
```

The System may perform the operational command because that command records an already authoritative fact.

The same event cannot authorize:

```text
System completes Work
```

because Work completion requires new Human intent.

---

# Authority Preservation Across Events

Asynchronous handlers must preserve:

```text
original actor
correlationId
causationId
source eventId
```

The handler principal remains System.

The original Human actor remains part of the audit chain.

The System must never record itself as the Human decision maker.

---

# Authorization Invariants

The following rules must always hold:

1. Every authoritative command is associated with one Human Member.
2. Every protected command executes within one Organization.
3. Cross-Organization access is denied.
4. Secretary actions remain advisory.
5. System actions remain operational.
6. No principal may impersonate another principal.
7. Denied commands produce no Aggregate mutation.
8. Infrastructure failures never grant access.
9. Authorization success never bypasses Aggregate validation.
10. Domain events do not create new Human authority.

---

# Guiding Principle

The authorization architecture answers:

> Who is allowed to request this operation?

The Domain Model answers:

> Is this operation valid?

The Application Layer coordinates both answers before committing any state change.

# Authorization Model

AIOS uses a hybrid authorization model combining:

- Organization roles
- command permissions
- resource relationships
- principal-type restrictions
- explicit Human-authority requirements

A role alone does not guarantee authorization.

The complete policy must evaluate the actor, command, Organization, and target resource.

---

# Organization Roles

The MVP defines four Human Member roles:

```text
OrganizationOwner
OrganizationAdmin
Member
Reviewer
```

One Human Member may hold multiple roles within the same Organization.

Roles never cross Organization boundaries.

---

## OrganizationOwner

The OrganizationOwner has the highest administrative authority within one Organization.

The Owner may:

- manage Organization membership
- assign and revoke Organization roles
- access all Organization resources
- perform business commands when the relevant command policy permits
- review security and authorization audit records

Ownership does not bypass Aggregate invariants.

The Owner cannot delegate Human-only authority to the Secretary or System.

---

## OrganizationAdmin

An OrganizationAdmin manages day-to-day access and Organization resources.

An Admin may:

- manage eligible Member roles
- access Organization resources
- create and coordinate Work
- manage assignments
- perform review actions when granted review permission

An Admin cannot redefine Human-authority invariants.

---

## Member

A Member performs ordinary organizational work.

A Member may, subject to resource relationships:

- create Work
- edit Work
- start Work
- record progress
- request Decisions
- create and edit Decision Drafts
- submit Decision Drafts
- edit Generated Memory
- submit Memory for review
- explicitly complete assigned Work

A Member does not receive approval authority automatically.

---

## Reviewer

A Reviewer is authorized to perform Human review actions.

A Reviewer may, subject to resource scope:

- approve Decisions
- reject Decisions
- withdraw eligible Decisions
- approve Memory
- reject Memory

Reviewer authority remains Organization-scoped.

---

# Role Assignment Rules

Role assignments must contain:

```text
roleAssignmentId
organizationId
memberId
role
assignedBy
assignedAt
revokedAt
```

Only active assignments grant permission.

Revoked assignments remain available for audit.

---

# Role Assignment Authority

Recommended MVP rules:

| Operation | Owner | Admin | Member | Reviewer |
|---|---:|---:|---:|---:|
| Assign Owner | Yes | No | No | No |
| Assign Admin | Yes | No | No | No |
| Assign Member | Yes | Yes | No | No |
| Assign Reviewer | Yes | Yes | No | No |
| Revoke Admin | Yes | No | No | No |
| Revoke Member | Yes | Yes | No | No |
| Revoke Reviewer | Yes | Yes | No | No |

An actor may not elevate their own authority unless an explicit policy allows it.

The final Organization membership design may live in a separate Organization Aggregate.

---

# Permission Model

Roles are mapped to named permissions.

Application Services evaluate permissions rather than hard-coding role names wherever possible.

Example permissions:

```text
work.create
work.edit
work.assign
work.start
work.record_progress
work.request_decision
work.complete
work.cancel

decision.create
decision.edit_draft
decision.record_secretary_contribution
decision.submit
decision.approve
decision.reject
decision.withdraw
decision.start_revision

memory.edit_generated
memory.record_secretary_contribution
memory.submit
memory.approve
memory.reject
memory.reopen

organization.manage_members
organization.manage_roles
authorization.read_audit
```

---

# Permission Assignment

Recommended MVP mapping:

| Permission Category | Owner | Admin | Member | Reviewer |
|---|---:|---:|---:|---:|
| Organization administration | Full | Limited | None | None |
| Work creation and editing | Yes | Yes | Yes | No by default |
| Work assignment | Yes | Yes | Limited | No |
| Work completion | Yes | Yes | Related Work only | No by default |
| Decision drafting | Yes | Yes | Yes | Optional |
| Decision submission | Yes | Yes | Related Decision | Optional |
| Decision review | Yes | Optional | No | Yes |
| Memory editing | Yes | Yes | Related Memory | Optional |
| Memory review | Yes | Optional | No | Yes |
| Authorization audit | Yes | Optional | No | No |

“Related” means the required resource relationship must also be satisfied.

---

# Resource Relationships

Role permissions are narrowed by relationships between the Human Member and the target resource.

Supported MVP relationships include:

```text
OrganizationMember
WorkCreator
WorkAssignee
WorkParticipant
DecisionCreator
DecisionContributor
DecisionReviewer
MemoryEditor
MemoryReviewer
OrganizationAdministrator
```

---

# Relationship-Based Authorization

Example:

```text
Member has work.complete permission
        │
        ▼
Member is WorkAssignee
        │
        ▼
Work belongs to same Organization
        │
        ▼
Authorization Allowed
```

Without the required relationship, the same command may be denied.

---

# Administrative Override

Owner and Admin roles may receive broader resource access.

Administrative access must still:

- remain inside the Organization
- satisfy principal-type restrictions
- preserve Human-authority rules
- preserve Aggregate invariants
- be recorded in authorization audit history

Administrative authority is not a domain-state override.

---

# Resource Scope

Every authorization request identifies the target scope.

Example:

```text
AuthorizationRequest
- principal
- organizationId
- commandType
- resourceType
- resourceId
- resourceOrganizationId
- relationships
```

For creation commands without an existing resource, the Organization is the primary scope.

---

# Policy Evaluation Order

Policies should be evaluated in the following order:

```text
1. Authentication
2. Principal-type restriction
3. Organization match
4. Active membership
5. Required permission
6. Required resource relationship
7. Additional command policy
8. Allow
```

A failure at any step results in Deny.

---

# Policy Evaluation Algorithm

```text
Authorize(request):

    require authenticated principal

    require principal type allowed for command

    require request Organization matches principal scope

    require active Organization membership when Human

    require permission assigned

    require resource relationship when applicable

    require command-specific policy conditions

    return Allow
```

Aggregate lifecycle validation occurs after this evaluation.

---

# Command Policy Types

Authorization policies fall into three categories.

## Organization-Scoped Policy

Used when no resource exists yet.

Examples:

- CreateWork
- CreateDecision
- invite Member

## Resource-Scoped Policy

Used when operating on an existing Aggregate.

Examples:

- EditDraft
- StartWork
- EditGeneratedMemory

## Human-Authority Policy

Used for authoritative lifecycle transitions.

Examples:

- CompleteWork
- ApproveDecision
- RejectDecision
- ApproveMemory

Human-authority policies always require:

```text
principalType = HumanMember
```

---

# Work Authorization Matrix

| Command | Human Required | Typical Permission | Required Relationship |
|---|---:|---|---|
| CreateWork | Yes | `work.create` | Active Organization Member |
| UpdateWorkDetails | Yes | `work.edit` | Creator, Assignee, or Admin |
| AssignMember | Yes | `work.assign` | Creator, Admin, or Owner |
| UnassignMember | Yes | `work.assign` | Creator, Admin, or Owner |
| AddParticipant | Yes | `work.assign` | Creator, Assignee, or Admin |
| RemoveParticipant | Yes | `work.assign` | Creator, Assignee, or Admin |
| RecordProgress | Yes | `work.record_progress` | Assignee or Participant |
| RecordSecretaryContribution | Human or Secretary | advisory permission | Related Work |
| StartWork | Yes | `work.start` | Assignee, Creator, or Admin |
| RequestBlockingDecision | Yes | `work.request_decision` | Assignee, Creator, or Admin |
| RecordDecisionOutcome | System | operational permission | Valid source event |
| CompleteWork | Yes | `work.complete` | Assignee, Creator, or Admin |
| CancelWork | Yes | `work.cancel` | Creator, Admin, or Owner |

The System may record a committed Decision outcome.

The System may not complete or cancel Work.

---

# Decision Authorization Matrix

| Command | Human Required | Typical Permission | Required Relationship |
|---|---:|---|---|
| CreateDecision | Yes | `decision.create` | Active Organization Member |
| EditDraft | Yes | `decision.edit_draft` | Creator, Contributor, or Admin |
| RecordSecretaryContribution | Human or Secretary | advisory permission | Related Decision |
| SubmitForReview | Yes | `decision.submit` | Creator, Contributor, or Admin |
| ApproveDecision | Yes | `decision.approve` | Reviewer, Admin, or Owner |
| RejectDecision | Yes | `decision.reject` | Reviewer, Admin, or Owner |
| WithdrawDecision | Yes | `decision.withdraw` | Submitter, Reviewer, Admin, or Owner |
| StartRevision | Yes | `decision.start_revision` | Creator, Contributor, or Admin |

Secretary and System principals are denied all review outcomes.

---

# Memory Authorization Matrix

| Command | Human Required | Typical Permission | Required Relationship |
|---|---:|---|---|
| CreateGeneratedMemory | No | System operational permission | Valid WorkCompleted event |
| EditGeneratedMemory | Yes | `memory.edit_generated` | Editor, related Work Member, or Admin |
| RecordSecretaryContribution | Human or Secretary | advisory permission | Related Memory |
| SubmitMemoryForReview | Yes | `memory.submit` | Editor, related Work Member, or Admin |
| ApproveMemory | Yes | `memory.approve` | Reviewer, Admin, or Owner |
| RejectMemory | Yes | `memory.reject` | Reviewer, Admin, or Owner |
| ReopenRejectedMemory | Yes | `memory.reopen` | Editor, related Work Member, or Admin |

Memory generation by the System creates only a Generated candidate.

It does not approve Memory.

---

# Secretary Authorization Matrix

| Operation | Secretary |
|---|---:|
| Generate Work suggestion | Allowed |
| Generate Decision Draft suggestion | Allowed |
| Summarize Decision | Allowed |
| Suggest rationale | Allowed |
| Generate Memory candidate | Allowed through System workflow |
| Record advisory contribution | Allowed |
| Edit authoritative Draft directly | Denied |
| Submit Decision | Denied |
| Approve or reject Decision | Denied |
| Complete Work | Denied |
| Submit Memory | Denied |
| Approve or reject Memory | Denied |
| Manage roles or permissions | Denied |

---

# System Authorization Matrix

| Operation | System |
|---|---:|
| Publish Outbox event | Allowed |
| Dispatch event handler | Allowed |
| Record processed event | Allowed |
| Record Decision outcome in Work | Allowed from valid event |
| Create Generated Memory | Allowed from valid WorkCompleted event |
| Schedule retry | Allowed |
| Run reconciliation | Allowed |
| Complete Work | Denied |
| Approve Decision | Denied |
| Reject Decision | Denied |
| Approve Memory | Denied |
| Promote Knowledge | Denied |
| Grant roles | Denied |

---

# Source Event Authorization

Operational System commands require a trusted source event.

Example:

```text
RecordDecisionOutcome
```

requires:

- authenticated internal System principal
- valid Decision outcome event
- matching Organization
- valid event schema
- unprocessed event identity
- related Work reference

The System cannot invoke the command without causation.

---

# Self-Review Policy

The MVP does not require universal separation between author and reviewer.

An Organization may allow a Human with review permission to review their own submission.

A stricter four-eyes policy may later require:

```text
reviewerId != submitterId
```

Such a rule must be explicit and consistently enforced.

It must not be assumed silently.

---

# Multiple Reviewer Roles

The MVP records one authoritative review outcome per submitted revision.

It does not require:

- quorum
- voting
- multiple approvals
- ordered approval stages
- consensus rules

A later phase may extend the policy model without changing Human-authority principles.

---

# Permission Revocation

Permission changes affect future commands.

Revocation does not rewrite historical actions.

Example:

```text
Member approves Decision at 10:00

Reviewer role revoked at 11:00
```

The approval remains valid because the Member was authorized when the command executed.

---

# Time-of-Check Rule

Authorization is evaluated immediately before command execution.

For a state-changing transaction, critical authorization data should remain stable through the transaction.

Where required, the implementation may use:

- transactionally read role assignments
- versioned policy data
- short-lived authorization decisions
- revalidation before commit

Long-lived authorization tokens must not substitute for current permission checks.

---

# Authorization Decision Caching

Caching is optional.

Cached decisions must be:

- short-lived
- Organization-scoped
- principal-scoped
- command-scoped
- invalidated after role or membership changes

Human-authority commands should prefer current policy evaluation.

---

# Policy Version

Authorization decisions should record the policy version used.

Example:

```text
policyId
policyVersion
```

This supports later audit and investigation.

---

# Command Authorization Summary

A command is authorized only when:

```text
Principal type is permitted
AND
Organization matches
AND
Membership is active
AND
Required permission exists
AND
Required relationship exists
AND
Command-specific policy allows it
```

Authorization success permits the command attempt.

The Aggregate still decides whether the requested state transition is valid.

# Authorization Execution Flow

Authorization is evaluated for every protected Application Service command.

The standard execution flow is:

```text
Receive Command
      │
      ▼
Resolve Request Context
      │
      ▼
Authenticate Principal
      │
      ▼
Resolve Organization Scope
      │
      ▼
Load Authorization Context
      │
      ▼
Evaluate Authorization Policy
      │
      ├── Deny → Return Failure
      │
      ▼
Load Aggregate
      │
      ▼
Execute Aggregate Command
      │
      ▼
Persist Aggregate and Outbox
      │
      ▼
Commit
```

Authorization must succeed before the Aggregate command is invoked.

---

# Request Context Resolution

Every protected command requires a trusted request context.

Recommended structure:

```text
RequestContext
- requestId
- commandId
- correlationId
- causationId
- principal
- organizationId
- requestedAt
- authenticationContext
```

The Application Service must not accept principal identity from untrusted command payload fields.

---

# Trusted Identity Source

The principal must be resolved from trusted authentication infrastructure.

Examples:

- validated session
- verified access token
- internal service identity
- signed worker execution context

The following is prohibited:

```text
POST /decisions/{id}/approve

{
    "approvedBy": "member-123"
}
```

The caller must not choose the authoritative actor identity.

The correct actor is resolved from the authenticated request context.

---

# Resource Identification

The command identifies the target resource.

Example:

```text
ApproveDecisionCommand
- decisionId
- rationale
- expectedVersion
```

The Application Service derives:

```text
principalId
organizationId
actorReference
```

from trusted context.

---

# Authorization Context

An Authorization Context contains the data needed to evaluate one policy.

Example:

```text
AuthorizationContext
- principal
- organizationId
- commandType
- resourceType
- resourceId
- resourceOrganizationId
- activeRoles
- permissions
- relationships
- policyVersion
```

Only required data should be loaded.

---

# Authorization Before Resource Loading

Where possible, Organization scope should be included in repository queries.

Example:

```text
DecisionRepository.Get(
    organizationId,
    decisionId
)
```

This prevents accidental cross-Organization resource exposure.

The implementation must not:

1. load a resource globally
2. reveal its existence
3. check Organization afterward

---

# Safe Resource Lookup

Recommended result behavior:

```text
Resource exists in Organization
    → continue

Resource does not exist in Organization
    → NotFound or generic denial
```

The API should not reveal whether a resource exists in another Organization.

---

# Application Service Integration

Every state-changing Application Service follows the same authorization pattern.

```text
Authorize

↓

Execute Domain Command

↓

Persist
```

Authorization must not be implemented inconsistently across individual services.

---

# Application Service Template

```text
Execute(command, requestContext):

    principal = requestContext.principal

    authorizationRequest =
        BuildAuthorizationRequest(
            principal,
            command,
            requestContext.organizationId
        )

    decision =
        authorizationService.Authorize(
            authorizationRequest
        )

    if decision is Deny:
        return AuthorizationFailure

    aggregate =
        repository.Get(
            requestContext.organizationId,
            command.aggregateId
        )

    aggregate.Execute(
        command,
        ActorReference.From(principal)
    )

    repository.Save(aggregate)

    outbox.Write(
        aggregate.ReleaseDomainEvents()
    )

    return Success
```

Transaction and idempotency behavior remain defined by the Application Services architecture.

---

# Authorization Service Interface

A conceptual interface may be defined as:

```text
AuthorizationService

Authorize(
    AuthorizationRequest
) -> AuthorizationDecision
```

Example request:

```text
AuthorizationRequest
- principal
- organizationId
- permission
- commandType
- resource
- relationships
- requestedAt
```

Example decision:

```text
AuthorizationDecision
- outcome
- policyId
- policyVersion
- reasonCode
- evaluatedAt
```

---

# Policy Enforcement Point

The Application Service is the primary Policy Enforcement Point.

It is responsible for:

- submitting authorization requests
- stopping denied commands
- preventing repository writes
- preventing Aggregate command invocation
- returning stable application errors
- recording security-relevant metadata

---

# Policy Decision Point

The Authorization Service is the Policy Decision Point.

It evaluates:

- principal type
- Organization membership
- roles
- permissions
- resource relationships
- command-specific conditions

The Authorization Service must not mutate domain state.

---

# Policy Information Point

Authorization data may be supplied by:

- Organization membership repository
- role assignment repository
- resource relationship queries
- principal directory
- policy configuration

These sources provide facts.

They do not make the final authorization decision independently.

---

# Work Application Service Example

```text
CompleteWorkService.Execute(command, context):

    require context.principal is authenticated

    work =
        workRepository.Get(
            context.organizationId,
            command.workId
        )

    relationship =
        workRelationshipResolver.Resolve(
            context.principal.id,
            work
        )

    authorization =
        authorizationService.Authorize(
            principal = context.principal,
            organizationId = context.organizationId,
            permission = work.complete,
            commandType = CompleteWork,
            resource = work.Reference,
            relationships = relationship
        )

    require authorization is Allow

    actor =
        ActorReference.FromHuman(
            context.principal
        )

    work.CompleteWork(
        actor,
        command.completionSummary
    )

    save work and events
```

The Application Service verifies authority.

The Work Aggregate verifies completion validity.

---

# Decision Application Service Example

```text
ApproveDecisionService.Execute(command, context):

    decision =
        decisionRepository.Get(
            context.organizationId,
            command.decisionId
        )

    authorization =
        authorizationService.Authorize(
            principal = context.principal,
            organizationId = context.organizationId,
            permission = decision.approve,
            commandType = ApproveDecision,
            resource = decision.Reference,
            relationships =
                DecisionReviewerRelationship
        )

    require authorization is Allow

    actor =
        ActorReference.FromHuman(
            context.principal
        )

    decision.ApproveDecision(
        actor,
        command.rationale
    )

    save decision and events
```

The Application Service must not set:

```text
decision.status = Approved
```

directly.

---

# Memory Application Service Example

```text
ApproveMemoryService.Execute(command, context):

    memory =
        memoryRepository.Get(
            context.organizationId,
            command.memoryId
        )

    authorization =
        authorizationService.Authorize(
            principal = context.principal,
            organizationId = context.organizationId,
            permission = memory.approve,
            commandType = ApproveMemory,
            resource = memory.Reference,
            relationships =
                MemoryReviewerRelationship
        )

    require authorization is Allow

    actor =
        ActorReference.FromHuman(
            context.principal
        )

    memory.ApproveMemory(
        actor,
        command.reviewNote
    )

    save memory and events
```

Memory approval remains a Human-authoritative action.

---

# Creation Command Authorization

Creation commands have no existing Aggregate to load.

Examples:

- CreateWork
- CreateDecision

The policy is evaluated against the Organization.

```text
CreateWorkService.Execute(command, context):

    authorization =
        authorizationService.Authorize(
            principal = context.principal,
            organizationId = context.organizationId,
            permission = work.create,
            commandType = CreateWork,
            resource = OrganizationReference
        )

    require authorization is Allow

    work =
        Work.Create(
            organizationId = context.organizationId,
            creator = ActorReference.FromHuman(
                context.principal
            ),
            ...
        )

    save work and events
```

The command must not supply a different Organization identifier than the trusted context.

---

# Coordinated Application Service Authorization

A use case may coordinate multiple Aggregates.

Example:

```text
RequestBlockingDecision
```

Authorization must cover the entire use case.

Required checks may include:

- permission to request a Decision for the Work
- relationship to the Work
- permission to create a Decision
- same Organization for both Aggregates

---

# Coordinated Authorization Flow

```text
Human Command
      │
      ▼
Authorize Work operation
      │
      ▼
Authorize Decision creation
      │
      ▼
Load Work
      │
      ▼
Create Decision
      │
      ▼
Execute Aggregate commands
      │
      ▼
Commit both changes
```

A partial authorization result must not lead to a partial domain change.

---

# Transactional Authorization Considerations

Authorization should be evaluated close to the state-changing transaction.

For high-authority commands, recommended execution is:

```text
BEGIN

Load current membership and role data

Evaluate policy

Load Aggregate

Execute command

Persist Aggregate and Outbox

COMMIT
```

This reduces the gap between authorization evaluation and state mutation.

---

# Authorization Data Consistency

The MVP may use the same PostgreSQL database for:

- membership
- roles
- permissions
- Aggregates
- audit metadata

This permits consistent authorization reads within the same transaction where required.

---

# Authorization Race Conditions

A role may be revoked while a command is executing.

Example:

```text
10:00:00 Authorization check succeeds
10:00:01 Reviewer role revoked
10:00:02 Decision approval commits
```

The implementation must define a consistent rule.

Recommended MVP rule:

> Authorization is valid when evaluated inside the successful command transaction against the current committed role data visible to that transaction.

Stronger locking may be introduced for highly sensitive operations.

---

# Expected Version and Authorization

Optimistic concurrency and authorization solve different problems.

```text
Authorization

Determines who may attempt the command
```

```text
Expected Version

Determines whether the Aggregate changed since the caller read it
```

Both checks are required where applicable.

---

# Read Authorization

Read operations must also be Organization-scoped.

Examples:

- view Work
- view Decision
- view Memory
- list review queue
- inspect audit records

Read permission categories may include:

```text
work.read
decision.read
memory.read
authorization.read_audit
```

The MVP may grant broad read access within an Organization, but this must be explicit.

---

# Read Model Filtering

List queries must apply authorization filtering before returning results.

Incorrect:

```text
Load all Decisions

↓

Filter unauthorized Decisions in application memory
```

Correct:

```text
Query only Decisions visible to principal
```

Authorization-aware query services may use:

- Organization scope
- role scope
- assignment scope
- review assignment
- resource relationship filters

---

# Field-Level Authorization

Field-level authorization is not required for most MVP domain content.

The MVP should prefer resource-level policies.

Field-level restrictions may be used for sensitive administrative data such as:

- role assignments
- security audit metadata
- authentication identifiers

Complex field-level business authorization is outside the MVP.

---

# Secretary Invocation Flow

A Human Member may request Secretary assistance.

```text
Human Member
      │
      │ Request suggestion
      ▼
Authorize Human request
      │
      ▼
Invoke Secretary
      │
      ▼
Generate advisory output
      │
      ▼
Record Secretary Contribution
```

The Human request authorizes generation of advisory content.

It does not pre-authorize later authoritative use.

---

# Secretary Principal Resolution

When the Secretary records an advisory contribution:

```text
principalType = Secretary
actorType = Secretary
```

The contribution should also preserve:

```text
requestedByHumanMemberId
requestCommandId
correlationId
generationId
```

The Secretary must not be recorded as a Human Member.

---

# Secretary Contribution Authorization

A Secretary contribution may be accepted only when:

- the Secretary identity is trusted
- the source Organization matches
- the related resource exists
- the resource permits advisory contributions
- a valid Human or System request caused the generation
- the content passes validation

The contribution remains non-authoritative.

---

# Secretary Output Adoption

A Human Member adopts Secretary output through a separate Human command.

Example:

```text
SecretaryContributionCreated
      │
      ▼
Human reviews contribution
      │
      ▼
Human invokes EditDecisionDraft
```

The audit trail records:

- Secretary as generator
- Human Member as adopting editor

---

# No Implicit Adoption

The following is prohibited:

```text
Secretary generates draft

↓

Decision Draft replaced automatically
```

The correct flow requires explicit Human action.

---

# Event Handler Authorization

Asynchronous event handlers execute as the System principal.

They do not use ordinary Human role permissions.

Instead, they require narrowly scoped operational policies.

---

# Operational Policy Inputs

An event-handler authorization request may include:

```text
systemPrincipalId
handlerName
eventType
eventId
organizationId
targetResourceType
targetResourceId
correlationId
causationId
```

---

# Event Handler Preconditions

Before executing an operational command, a handler verifies:

1. the System principal is trusted
2. the event type is supported
3. the event schema version is supported
4. the event belongs to one Organization
5. the target resource belongs to the same Organization
6. the event has not already been processed
7. the event is a valid cause for the operation
8. the System operation is explicitly permitted

---

# Decision Outcome Handler

The System may execute:

```text
RecordDecisionOutcome
```

only when caused by a committed event such as:

```text
DecisionApproved

DecisionRejected

DecisionWithdrawn
```

The handler cannot invent an outcome.

---

# Decision Outcome Authorization Flow

```text
Decision Outcome Event
      │
      ▼
Validate Event Contract
      │
      ▼
Authenticate Internal System Principal
      │
      ▼
Verify Organization Match
      │
      ▼
Authorize RecordDecisionOutcome
      │
      ▼
Load Work
      │
      ▼
Work.RecordDecisionOutcome(...)
      │
      ▼
Commit
```

---

# Work Completion Prohibition

A Decision outcome handler must never call:

```text
Work.CompleteWork(...)
```

Even when the Completion Gate becomes Satisfied.

Work completion requires a new Human-authoritative command.

---

# Memory Generation Handler

The System may execute:

```text
CreateGeneratedMemory
```

only when caused by a committed:

```text
WorkCompleted
```

event.

The resulting Memory state is:

```text
Generated
```

The handler may not submit or approve Memory.

---

# Memory Generation Authorization Flow

```text
WorkCompleted
      │
      ▼
Validate Source Event
      │
      ▼
Authorize System Generation
      │
      ▼
Generate Candidate
      │
      ▼
Create Memory in Generated State
      │
      ▼
Commit
```

---

# Reconciliation Authorization

Reconciliation jobs execute as the System principal.

They may:

- detect missing processing
- requeue an event
- request a supported operational command
- record operational findings

They may not:

- repair domain state through direct database updates
- approve business content
- complete Work
- create Human intent
- bypass handler authorization

---

# Retry Authorization

A retry does not require new Human authorization when it repeats the same already-authorized operation.

The retry must preserve:

```text
original commandId or eventId
original correlationId
original causationId
original actor attribution
policy context where required
```

A retry may not broaden the original scope.

---

# Stale Authorization on Retry

For Human commands, a delayed retry should not rely indefinitely on an old authorization decision.

Recommended rules:

- immediate technical retry may reuse the same transaction attempt semantics
- later resubmission must evaluate current Human authorization
- asynchronous System processing validates current operational policy
- original Human attribution remains unchanged

---

# Background Worker Identity

Each Worker instance should have a stable internal identity.

Example:

```text
SystemPrincipal
- principalId = worker-memory-generation
- principalType = System
- organizationScope = dynamic from event
- allowedCapabilities =
    memory.create_generated
```

A Worker must not possess permissions unrelated to its function.

---

# Worker Capability Separation

Recommended operational identities:

```text
outbox-publisher

decision-outcome-worker

memory-generation-worker

reconciliation-worker
```

Separating identities supports least privilege and clearer auditing.

A single physical process may host multiple logical System principals.

---

# Worker Organization Scope

A Worker may process events for multiple Organizations.

However, each handler execution must be scoped to exactly one Organization.

The Worker must never combine data from different Organizations in one domain command.

---

# Internal Service Authentication

System principals must be authenticated through trusted internal mechanisms.

Examples:

- workload identity
- signed internal token
- process-bound credential
- platform service account

A public client must never be able to claim:

```text
principalType = System
```

---

# Impersonation Prohibition

Impersonation is prohibited in the MVP.

No principal may act as another principal.

Examples of prohibited behavior:

```text
Admin acts as Reviewer Jane

Secretary acts as Human Member

System records approval as OrganizationOwner

Support operator completes Work as customer
```

---

# Actor Override Prohibition

Commands must not contain an arbitrary actor override.

Prohibited:

```text
ApproveDecisionCommand
- decisionId
- approvedByMemberId
```

Correct:

```text
ApproveDecisionCommand
- decisionId
- rationale
```

The actor is derived from trusted context.

---

# Administrative Operations

An Owner or Admin may perform an operation under their own identity when policy permits.

Example:

```text
Admin completes Work
```

The audit trail records the Admin.

It must not record the Work assignee as the actor unless that assignee executed the command.

---

# Support Access

Customer support impersonation is outside the MVP.

Future support-access features would require:

- explicit break-glass workflow
- customer-visible audit
- time-limited access
- reason capture
- strong authentication
- restricted capabilities

Such features must not be implemented as silent impersonation.

---

# Delegation

Business authority delegation is not included in the MVP.

The system does not support:

- delegated approval
- temporary proxy reviewer
- acting on behalf of another Member
- Secretary approval delegation

Future delegation must preserve the identities of:

- delegator
- delegate
- authority scope
- start and end time
- actual executing actor

---

# Authorization Audit

Every authoritative command must produce an auditable authorization record.

The audit record should capture:

```text
authorizationAuditId
requestId
commandId
correlationId
principalId
principalType
organizationId
commandType
resourceType
resourceId
permission
policyId
policyVersion
outcome
reasonCode
evaluatedAt
```

---

# Domain Audit and Security Audit

Domain audit and authorization audit serve different purposes.

---

## Domain Audit

Records what happened in the business domain.

Examples:

- Decision approved
- Work completed
- Memory rejected

---

## Authorization Audit

Records why the actor was permitted or denied.

Examples:

- Reviewer permission found
- Organization matched
- permission missing
- Human authority required

Both records may share correlation metadata.

---

# Allow Audit

Successful authoritative actions should record:

- Human actor
- permission evaluated
- policy version
- target resource
- Organization
- authorization time
- resulting domain event reference

This supports traceability from permission decision to state change.

---

# Deny Audit

Security-relevant denials should record:

- principal identity
- attempted command
- resource reference where safe
- Organization
- denial reason
- policy version
- request metadata

Repeated denials may indicate:

- client defects
- stale UI state
- role misconfiguration
- malicious activity

---

# Denial Privacy

External error messages should avoid leaking sensitive information.

Example external response:

```text
You are not authorized to perform this operation.
```

Secure internal audit may record:

```text
OrganizationMismatch
```

The external response should not reveal another Organization’s resource existence.

---

# Audit Transaction Boundary

For allowed state-changing commands, authorization metadata should be committed consistently with the domain operation where practical.

Recommended pattern:

```text
BEGIN

Evaluate authorization

Execute Aggregate command

Save Aggregate

Write Outbox

Write authorization audit reference

COMMIT
```

If the transaction rolls back, the system must not record the command as successfully authorized and executed.

---

# Denied Command Audit Boundary

Denied commands do not enter a domain mutation transaction.

Their audit records may be written separately.

Failure to write a denial audit record must not grant access.

---

# Audit Immutability

Authorization audit records are append-only.

They must not be edited to reflect later role changes.

Corrections should be represented by additional records.

---

# Audit Retention

Retention policy should account for:

- legal requirements
- security investigation
- Organization policy
- privacy obligations
- operational cost

The exact retention duration is an implementation and compliance decision.

---

# Sensitive Audit Data

Audit records should not store unnecessary business content.

Recommended:

```text
resourceId
commandType
reasonCode
```

Avoid storing:

- full Decision content
- full Memory content
- generated AI prompts
- authentication secrets
- raw access tokens

---

# Security Monitoring

Authorization events should support monitoring for:

- repeated denied approvals
- cross-Organization access attempts
- attempts to use Secretary for Human-only commands
- invalid System principal claims
- role escalation attempts
- revoked Member activity
- unusual administrative access

---

# Alerting

High-severity alerts should be considered for:

```text
principalType spoofing

cross-Organization mutation attempts

System identity misuse

Owner role escalation attempts

repeated Human-authority violations
```

Alerting is operational.

It must not alter Aggregate state automatically.

---

# Authorization Observability

Recommended metrics include:

```text
authorization_allow_total

authorization_deny_total

authorization_deny_by_reason

authorization_evaluation_duration

cross_organization_denial_total

human_authority_denial_total

system_policy_denial_total

secretary_authority_violation_total
```

Metrics should not include sensitive content.

---

# Correlation and Audit Trace

A complete authoritative workflow should be traceable.

Example:

```text
Human ApproveDecision Command
      │
      ├── Authorization Allow Record
      │
      ├── DecisionApproved Domain Event
      │
      ├── Outbox Record
      │
      └── System RecordDecisionOutcome Handler
              │
              ├── Operational Authorization Record
              └── WorkDecisionOutcomeRecorded Event
```

All records share the same correlationId.

---

# Policy Change Audit

Role and permission changes must also be audited.

Recommended fields:

```text
changeId
organizationId
changedBy
targetMemberId
previousRoles
newRoles
reason
changedAt
correlationId
```

Policy changes affect future authorization decisions only.

---

# Authorization Failure Semantics

Authorization failures must produce no domain mutation.

The following must not occur after Deny:

- Aggregate command execution
- Aggregate version change
- Domain Event creation
- Outbox message creation
- state history entry

---

# Stable Application Errors

Recommended application-level authorization errors:

```text
Unauthenticated

Forbidden

OrganizationAccessDenied

HumanAuthorityRequired

OperationalAuthorityDenied
```

Detailed internal reason codes remain in secure logs and audit records.

---

# HTTP Mapping Guidance

A transport layer may map errors as follows:

```text
Unauthenticated
    → HTTP 401

Forbidden
    → HTTP 403

OrganizationAccessDenied
    → HTTP 404 or 403 according to disclosure policy

HumanAuthorityRequired
    → HTTP 403

OperationalAuthorityDenied
    → HTTP 403
```

Transport mapping is outside the Domain Layer.

---

# Authorization Rules for Events

An event is evidence of a committed fact.

It is not a reusable permission token.

An event handler may execute only the operational follow-up explicitly associated with that event type.

Example:

```text
WorkCompleted
```

may authorize:

```text
CreateGeneratedMemory
```

It does not authorize:

```text
ApproveMemory
```

---

# Capability Whitelisting

Each System handler should use an explicit capability whitelist.

Example:

```text
DecisionOutcomeWorker
- work.record_decision_outcome
```

It must not receive:

```text
work.complete
decision.approve
memory.approve
```

---

# Authorization Enforcement Rules

The following rules are mandatory:

1. Resolve principals only from trusted authentication context.
2. Scope every command and query to one Organization.
3. Use default deny.
4. Evaluate Human authority explicitly.
5. Never allow command payloads to choose the authoritative actor.
6. Never allow Secretary or System to impersonate a Human.
7. Restrict System handlers to event-caused operational commands.
8. Audit authoritative Allow decisions.
9. Audit security-relevant Deny decisions.
10. Preserve actor, correlation, and causation through asynchronous workflows.
11. Do not expose cross-Organization resource existence.
12. Do not treat events as general-purpose authority.
13. Do not retry later Human commands without current authorization.
14. Do not permit authorization failure to produce domain state changes.
15. Do not duplicate Aggregate lifecycle rules inside authorization policies.

# Failure and Recovery Semantics

Authorization failures and authorization infrastructure failures must be handled explicitly.

No failure mode may result in implicit permission.

The default response is always:

```text
Deny
```

---

# Failure Categories

Authorization failures are classified as:

```text
Authentication Failure

Authorization Denial

Policy Data Failure

Policy Evaluation Failure

Organization Scope Failure

Audit Persistence Failure

Concurrency Failure

Configuration Failure
```

Each category has different operational handling.

---

# Authentication Failure

Authentication failure means the request has no trusted principal.

Examples:

- missing session
- expired access token
- invalid signature
- disabled identity
- unsupported authentication method

Result:

```text
Command rejected

No Aggregate loaded for mutation

No Domain Event emitted

No Outbox message created
```

---

# Authorization Denial

Authorization denial means the principal is authenticated but lacks permission.

Examples:

- missing required permission
- inactive Organization membership
- missing resource relationship
- principal type prohibited
- Human authority required
- Organization mismatch

Result:

```text
Command rejected

No domain mutation

Denial optionally audited
```

Authorization denial is not retried automatically.

---

# Policy Data Failure

Policy data failure occurs when required authorization facts cannot be loaded safely.

Examples:

- role repository unavailable
- membership record corrupted
- policy version missing
- relationship lookup timeout

Result:

```text
Deny
```

The system must not infer permission from cached or incomplete data unless the cache is explicitly valid for that command.

---

# Policy Evaluation Failure

Policy evaluation failure occurs when the policy engine cannot produce a reliable result.

Examples:

- unexpected policy exception
- invalid policy configuration
- unsupported command mapping
- malformed authorization request

Result:

```text
Deny

Record operational failure

Alert where appropriate
```

---

# Organization Scope Failure

Organization scope failure occurs when:

- request Organization is missing
- principal Organization scope is invalid
- target resource belongs to another Organization
- event and target resource Organizations differ

Result:

```text
Deny

Do not disclose foreign resource details

Record security-relevant audit event
```

---

# Audit Persistence Failure

Authorization audit persistence failure must not change the authorization outcome.

For denied commands:

```text
Audit write fails

↓

Command remains denied
```

For allowed state-changing commands, two strategies are acceptable.

---

## Strategy A: Transactional Audit

Authorization audit metadata is written in the same transaction as the domain change.

```text
BEGIN

Authorize

Execute Aggregate command

Save Aggregate

Write Outbox

Write Authorization Audit

COMMIT
```

If the audit write fails:

```text
Entire transaction rolls back
```

This provides the strongest consistency.

---

## Strategy B: Reliable Asynchronous Audit

The domain transaction stores a durable audit event in the Transactional Outbox.

```text
BEGIN

Authorize

Execute Aggregate command

Save Aggregate

Write Domain Events

Write AuthorizationEvaluated Event

COMMIT
```

A Worker persists the final security audit record asynchronously.

The audit event must be durable and retryable.

---

# Recommended MVP Audit Strategy

For authoritative state-changing commands, use one of:

- transactional audit record
- transactional Outbox audit event

The final choice should be consistent across the system.

Silent loss of successful authorization evidence is prohibited.

---

# Concurrency Failure

Authorization and domain concurrency may fail independently.

Example:

```text
Reviewer permission is valid

Decision version is stale
```

Result:

```text
Authorization = Allow

Domain execution = ConcurrencyConflict
```

The command must not be represented as successfully completed.

A retry must re-evaluate current authorization.

---

# Configuration Failure

Configuration failure includes:

- unknown permission name
- command without policy mapping
- duplicate conflicting policies
- invalid role mapping
- unsupported principal type

Result:

```text
Deny

Record high-severity operational error
```

Missing policy configuration must never fall back to broad access.

---

# Recovery Principles

Authorization recovery follows these principles:

1. Never recover by bypassing authorization.
2. Never edit domain state directly.
3. Never grant temporary broad access to clear a backlog.
4. Re-evaluate current policy before replaying Human commands.
5. Preserve original actor attribution.
6. Preserve Organization scope.
7. Audit administrative recovery actions.
8. Keep Secretary and System authority restrictions unchanged.

---

# Human Command Recovery

A failed Human command may be resubmitted.

The resubmitted command must evaluate:

- current authentication
- current membership
- current roles
- current permissions
- current resource relationships
- current Aggregate version

A previous Allow decision is not a permanent authorization token.

---

# System Handler Recovery

A failed System handler may retry the same operational action when:

- the original event remains valid
- the handler capability remains permitted
- Organization scope still matches
- the event has not already been processed
- the Aggregate can still accept the operation

The retry preserves the original causation chain.

---

# Authorization Replay

Authorization audit records may be replayed for reporting or analysis.

They must not be replayed as commands.

An old authorization record proves only:

> A decision was evaluated at that time under that policy version.

It does not grant present authority.

---

# Break-Glass Access

Break-glass administrative access is outside the MVP.

No hidden override should exist.

Examples of prohibited MVP mechanisms:

```text
superuser bypass

skipAuthorization flag

forceApprove endpoint

support impersonation token
```

Emergency access requires a separate future design.

---

# Authorization Testing Strategy

Authorization tests must verify both permission success and permission failure.

Testing should cover:

- principal-type restrictions
- Organization isolation
- role permissions
- resource relationships
- Human-authority requirements
- System operational capabilities
- Secretary advisory boundaries
- audit behavior
- failure semantics

---

# Test Layers

Authorization is tested at four layers:

```text
Policy Unit Tests

Application Service Tests

Integration Tests

End-to-End Security Tests
```

---

# Policy Unit Tests

Policy unit tests verify authorization decisions from controlled inputs.

Example:

```text
Given:
    principalType = HumanMember
    role = Reviewer
    permission = decision.approve
    same Organization
    reviewer relationship exists

When:
    ApproveDecision policy is evaluated

Then:
    Allow
```

---

## Policy Denial Test

```text
Given:
    principalType = Secretary
    permission request = decision.approve

When:
    ApproveDecision policy is evaluated

Then:
    Deny
    reasonCode = HumanAuthorityRequired
```

---

# Role Mapping Tests

Role mapping tests verify:

- Owner permission set
- Admin permission set
- Member permission set
- Reviewer permission set
- revoked roles grant nothing
- role assignments remain Organization-scoped
- one Organization’s role does not apply to another

---

# Relationship Tests

Resource relationship tests verify:

- Work Assignee may perform permitted Work actions
- unrelated Member is denied restricted Work actions
- Decision Reviewer may review assigned Decisions
- Decision Contributor may edit Drafts but not approve
- Memory Editor may edit Generated Memory
- unrelated Reviewer cannot review outside assigned scope when assignments are required

---

# Human Authority Tests

Mandatory tests include:

```text
Secretary cannot CompleteWork

Secretary cannot SubmitDecisionForReview

Secretary cannot ApproveDecision

Secretary cannot RejectDecision

Secretary cannot SubmitMemoryForReview

Secretary cannot ApproveMemory

System cannot CompleteWork

System cannot ApproveDecision

System cannot RejectDecision

System cannot ApproveMemory
```

These tests protect the central authority model.

---

# Organization Isolation Tests

Every protected command should have a cross-Organization denial test.

Example:

```text
Given:
    Human belongs to org-A
    Decision belongs to org-B

When:
    Human requests ApproveDecision

Then:
    resource is not exposed
    command is denied
    Decision remains unchanged
    no Domain Event is emitted
```

---

# Creation Scope Tests

Creation tests must verify:

- resource Organization comes from trusted context
- payload cannot select another Organization
- Human must have creation permission in the current Organization
- Secretary cannot create authoritative resources unless explicitly represented as advisory content
- System cannot create Human intent

---

# Actor Attribution Tests

Tests must verify that:

- actor identity comes from authenticated context
- payload actor fields are ignored or rejected
- Admin actions are recorded as Admin actions
- Secretary contributions are recorded as Secretary contributions
- System handler actions are recorded as System operations
- original Human causation remains traceable

---

# Event Handler Authorization Tests

Example:

```text
Given:
    valid DecisionApproved event
    trusted decision-outcome-worker
    matching Organization
    event not yet processed

When:
    RecordDecisionOutcome handler runs

Then:
    operational authorization succeeds
    Work command executes
```

---

## Invalid Source Event Test

```text
Given:
    memory-generation-worker
    unsupported event type
    event requests ApproveMemory

When:
    handler authorization is evaluated

Then:
    Deny
    no Memory approval occurs
```

---

# Event Causation Tests

Tests must verify:

- DecisionApproved can cause RecordDecisionOutcome
- DecisionApproved cannot cause CompleteWork
- WorkCompleted can cause CreateGeneratedMemory
- WorkCompleted cannot cause ApproveMemory
- retry preserves source event identity
- unrelated events do not grant capability

---

# Application Service Tests

Application Service tests verify the enforcement sequence.

Required order:

```text
Resolve principal

↓

Resolve Organization

↓

Authorize

↓

Execute Aggregate command

↓

Persist
```

A denied authorization must stop execution before mutation.

---

# Denied Command Side-Effect Tests

For every denial scenario, verify:

```text
Aggregate command not called

Repository save not called

Outbox write not called

Aggregate version unchanged

No Domain Event emitted
```

---

# Aggregate Validation After Authorization

Tests must verify that authorization success does not bypass domain validation.

Example:

```text
Reviewer has decision.approve permission

Decision is Draft

Authorization = Allow

Aggregate = Reject invalid state
```

No approval event is emitted.

---

# Authorization Infrastructure Tests

Integration tests should use real persistence for:

- memberships
- role assignments
- permission mappings
- resource relationships
- audit records
- policy versions

The tests should verify Organization-scoped indexes and constraints.

---

# Transaction Tests

Transactional tests should verify:

- authorization audit and domain mutation commit together when configured
- rollback removes domain mutation and success audit
- denied commands produce no Outbox event
- authorization data is read consistently
- concurrency conflicts do not create successful execution records

---

# Cache Tests

Where authorization caching is implemented, verify:

- cache key includes Organization
- cache key includes principal
- cache key includes permission or command
- role revocation invalidates or expires cache
- cached decisions cannot cross Organization boundaries
- Human-authority restrictions are never bypassed

---

# Failure Injection Tests

Failure injection should cover:

- membership repository unavailable
- permission repository timeout
- audit database failure
- policy engine exception
- malformed System principal
- unsupported event schema
- role revoked during execution

Expected result:

```text
No unauthorized mutation
```

---

# Security Regression Suite

The following cases should be permanent regression tests:

1. Secretary attempts to approve Decision.
2. System attempts to complete Work.
3. Member from Organization A accesses Organization B.
4. Command payload attempts actor override.
5. Public client claims System principal.
6. Revoked Reviewer attempts approval.
7. Event handler uses unsupported source event.
8. Administrative role attempts to bypass Aggregate state.
9. Retry uses stale Human authorization.
10. Missing policy mapping fails closed.

---

# Property-Based Tests

Property-based tests are recommended for core invariants.

Examples:

```text
For every non-Human principal:
    authoritative commands are denied
```

```text
For every Organization mismatch:
    protected resource command is denied
```

```text
For every authorization Deny:
    domain state remains unchanged
```

---

# Implementation Guidance

Authorization should be implemented as an explicit application capability.

It should not be scattered across:

- controllers
- repositories
- UI components
- Aggregate field setters
- background job code

---

# Recommended Package Structure

```text
authorization/

    application/
        AuthorizationService
        AuthorizationRequest
        AuthorizationDecision
        PolicyEvaluator

    domain/
        Principal
        PrincipalType
        Permission
        Role
        RoleAssignment
        PolicyReference
        DenialReason

    infrastructure/
        MembershipRepository
        RoleAssignmentRepository
        PermissionRepository
        RelationshipResolver
        AuthorizationAuditRepository

    policies/
        WorkPolicies
        DecisionPolicies
        MemoryPolicies
        OrganizationPolicies
        SystemPolicies
        SecretaryPolicies
```

The exact language-specific structure may differ.

The responsibility boundaries should remain equivalent.

---

# Permission Constants

Permission names should be centrally defined.

Example:

```text
WorkPermissions.Create
WorkPermissions.Complete

DecisionPermissions.Submit
DecisionPermissions.Approve

MemoryPermissions.Submit
MemoryPermissions.Approve
```

String literals distributed across services should be avoided.

---

# Command-to-Policy Registry

Every protected command should have an explicit policy registration.

Example:

```text
CreateWork
    -> WorkCreatePolicy

CompleteWork
    -> WorkCompletePolicy

ApproveDecision
    -> DecisionApprovePolicy

CreateGeneratedMemory
    -> SystemMemoryGenerationPolicy
```

Startup validation should fail when a protected command has no policy mapping.

---

# Typed Principal Model

Principal types should use explicit types or discriminated representations.

Preferred:

```text
HumanMemberPrincipal

SecretaryPrincipal

SystemPrincipal
```

Avoid relying only on arbitrary strings such as:

```text
"type": "human"
```

Runtime validation remains required at trust boundaries.

---

# Human Actor Construction

Human ActorReference should be constructed only from a trusted Human principal.

Example:

```text
ActorReference.FromHuman(principal)
```

This constructor must reject:

- Secretary principal
- System principal
- anonymous principal
- missing Organization identity

---

# System Actor Construction

System ActorReference should preserve:

```text
systemPrincipalId
handlerName
organizationId
sourceEventId
correlationId
causationId
```

It must not create a Human actor representation.

---

# Repository Scoping

Protected repositories should require Organization scope.

Preferred interface:

```text
Get(
    organizationId,
    aggregateId
)
```

Avoid:

```text
GetById(
    aggregateId
)
```

unless the repository is used only after a verified globally trusted lookup.

---

# Relationship Resolver

Resource relationships should be resolved through explicit interfaces.

Example:

```text
WorkRelationshipResolver.Resolve(
    memberId,
    workId
)
```

Possible outputs:

```text
Creator

Assignee

Participant

Administrator

None
```

The resolver provides facts.

The policy determines whether those facts grant permission.

---

# Policy Composition

Policies may be composed from reusable predicates.

Example:

```text
ApproveDecisionPolicy =
    IsHumanMember
    AND SameOrganization
    AND ActiveMembership
    AND HasPermission(decision.approve)
    AND HasReviewerRelationship
```

Composition must remain readable and auditable.

---

# Avoid Role Checks in Application Services

Avoid:

```text
if user.role == "Reviewer":
    approve()
```

Prefer:

```text
authorizationService.Authorize(
    permission = decision.approve,
    ...
)
```

This supports role evolution without rewriting each service.

---

# Policy Data Versioning

Role and permission configuration should have explicit versions where practical.

An authorization audit record may store:

```text
roleAssignmentVersion
permissionModelVersion
policyVersion
```

This improves historical explainability.

---

# Database Constraints

Database constraints provide defense in depth.

They do not replace authorization policies.

---

# Organization Membership Constraint

Recommended uniqueness:

```text
UNIQUE (
    organization_id,
    member_id
)
```

Where membership history requires multiple records, use an active-record uniqueness strategy.

---

# Active Role Assignment Constraint

Recommended uniqueness:

```text
UNIQUE (
    organization_id,
    member_id,
    role
)
WHERE revoked_at IS NULL
```

This prevents duplicate active assignments.

---

# Principal Type Constraint

Persisted principal types should be constrained to supported values:

```text
HumanMember

Secretary

System
```

Unknown types must not be treated as Human.

---

# Organization Foreign Keys

Organization-owned records should include:

```text
organization_id
```

Foreign keys and composite constraints should prevent invalid cross-Organization associations where possible.

Examples:

- Work assignment
- Decision reviewer assignment
- Memory reviewer assignment
- role assignment

---

# Cross-Organization Relationship Constraint

Where supported by schema design, relationship tables should use composite foreign keys.

Example:

```text
work_participants (
    organization_id,
    work_id,
    member_id
)
```

The referenced Work and membership must belong to the same Organization.

---

# Permission Mapping Constraint

Role-to-permission mappings should prevent duplicate entries.

Recommended uniqueness:

```text
UNIQUE (
    role,
    permission
)
```

Custom Organization permission models are outside the MVP unless explicitly introduced.

---

# Audit Append-Only Constraint

Authorization audit records should not be updated through ordinary application commands.

Recommended controls:

- repository exposes Insert only
- database account denies Update and Delete
- correction uses a new audit record
- archival follows controlled policy

---

# Processed Event Constraints

Operational System handlers should use uniqueness such as:

```text
UNIQUE (
    consumer_name,
    event_id
)
```

This supports idempotent authorization and execution.

---

# System Capability Constraints

System principal capability mappings should be explicit.

Example:

```text
system_principal_capabilities (
    system_principal_id,
    capability
)
```

Recommended uniqueness:

```text
UNIQUE (
    system_principal_id,
    capability
)
```

---

# Data Access Security

Application-level Organization scoping is mandatory.

PostgreSQL Row-Level Security may be added as defense in depth.

RLS is not required for the MVP if:

- repository scoping is mandatory
- integration tests verify isolation
- database access paths are controlled

---

# Row-Level Security Considerations

If RLS is used:

- Organization context must be set safely per transaction
- connection pooling must not leak context
- System Workers must still process one Organization at a time
- administrative database roles must be restricted
- tests must verify isolation under real pooling behavior

RLS must not replace application policy evaluation.

---

# Policy Storage

MVP policies should preferably be defined in version-controlled code.

Benefits include:

- reviewable changes
- deterministic deployment
- test coverage
- explicit versioning
- reduced runtime misconfiguration

Dynamic user-authored policies are outside the MVP.

---

# Feature Flags

Feature flags must not weaken authority invariants.

Invalid feature flags include:

```text
allowSecretaryApproval

autoCompleteWork

skipOrganizationCheck
```

Feature flags may enable optional non-authoritative functionality only.

---

# Administrative Interfaces

Role management interfaces must:

- display current Organization scope
- identify the Member receiving authority
- show the role being assigned
- require an authorized Human action
- produce an audit record
- prevent unsupported self-escalation

---

# User Interface Guidance

The UI should reflect authorization results but must not enforce security alone.

The UI may:

- hide unavailable actions
- disable buttons
- explain missing permissions
- show review assignments

The server must always re-evaluate authorization.

---

# Error Message Guidance

User-facing messages should be clear without exposing sensitive detail.

Examples:

```text
You do not have permission to approve this Decision.
```

```text
This action requires a Human reviewer.
```

```text
The requested resource is unavailable.
```

Detailed security reason codes remain internal.

---

# Logging Guidance

Authorization logs should use structured fields.

Example:

```text
authorization.outcome
authorization.permission
authorization.policy_id
authorization.policy_version
principal.id
principal.type
organization.id
resource.type
resource.id
command.type
correlation.id
```

Logs must not include credentials or full protected content.

---

# Performance Guidance

Authorization evaluation should remain predictable and bounded.

Recommended practices:

- indexed membership lookup
- indexed active role lookup
- bounded relationship queries
- no large resource scans
- no external network dependency for ordinary policy checks
- short-lived safe caching where justified

---

# MVP Exclusions

The following authorization capabilities are outside the MVP:

- custom role builders
- user-authored policies
- attribute-based policy language
- cross-Organization collaboration
- guest accounts
- external partner access
- delegated approval
- temporary proxy authority
- approval quorum
- multi-stage approval chains
- field-level business authorization
- support impersonation
- break-glass access
- anonymous domain commands
- marketplace permissions
- API client permission management
- Knowledge authorization
- Evidence authorization
- Capability authorization
- AI Employee authority
- autonomous Secretary approval
- automatic Work completion
- Memory-to-Knowledge promotion authority

These may be introduced only through explicit future architecture.

---

# Future Extension Principles

Future authorization extensions must preserve:

1. Human authority for final business decisions.
2. Organization isolation.
3. explicit principal identity.
4. default deny.
5. auditability.
6. no AI impersonation.
7. Aggregate invariant enforcement.
8. event causation boundaries.

New roles may expand Human permissions.

They must not silently grant Human authority to non-Human principals.

---

# AI Employee Future Phase

AI Employees are planned for a later roadmap phase.

Their authorization model is not defined by the MVP Secretary principal.

Future AI Employees may require:

- delegated capability scopes
- Human supervision
- action budgets
- approval checkpoints
- revocation
- enhanced audit
- policy-specific autonomy levels

They must not inherit unrestricted Human Member authority.

---

# Knowledge Future Phase

Knowledge promotion is outside the MVP.

Future authorization must separately define:

- who may propose promotion
- who may approve promotion
- whether multiple reviewers are required
- source Evidence requirements
- revocation and supersession
- access controls

Approved Memory must not be treated as authorized Knowledge in the MVP.

---

# Implementation Checklist

Before implementation is considered complete, verify:

- every protected command has a policy
- every policy defaults to Deny
- every authoritative command requires HumanMember
- every repository query is Organization-scoped
- every System handler has a capability whitelist
- Secretary cannot execute authoritative transitions
- actor identity comes from trusted context
- role changes are audited
- denied commands produce no mutation
- policy infrastructure fails closed
- cross-Organization tests pass
- authorization audit is durable
- current authorization is re-evaluated for Human retries
- events authorize only defined operational follow-up
- Aggregate business validation remains independent

---

# Design Summary

The AIOS authorization architecture uses:

```text
Organization-Scoped Authorization

Role-Based Permissions

Resource Relationships

Principal-Type Restrictions

Explicit Human Authority

System Capability Whitelisting

Secretary Advisory Boundaries

Default Deny

Auditable Policy Decisions
```

Authorization determines whether a principal may attempt a command.

The Domain Model determines whether that command is valid.

---

# Core Guarantees

The authorization model guarantees:

- only authenticated principals execute protected operations
- every operation belongs to one Organization
- cross-Organization access is denied
- only Human Members exercise business authority
- Secretary output remains advisory
- System actions remain operational
- actor identity cannot be overridden by payload
- event handlers cannot create new Human intent
- denied commands do not mutate domain state
- policy failures do not grant access
- authoritative actions remain auditable

---

# Architect Review

## Human Authority

**Rating: ★★★★★**

The model establishes a clear and enforceable distinction between Human, Secretary, and System principals.

Final business authority remains exclusively Human.

---

## Organization Isolation

**Rating: ★★★★★**

Organization scope is enforced across commands, queries, relationships, events, and repositories.

Cross-Organization access fails closed.

---

## Policy Clarity

**Rating: ★★★★★**

Roles, permissions, resource relationships, principal restrictions, and command policies are clearly separated.

This supports maintainable policy evolution.

---

## Secretary Safety

**Rating: ★★★★★**

The Secretary is structurally limited to advisory actions.

The design prevents submission, approval, rejection, completion, and promotion by AI assistance.

---

## System Safety

**Rating: ★★★★★**

System principals receive narrow operational capabilities tied to valid event causation.

System automation cannot create new Human business intent.

---

## Auditability

**Rating: ★★★★★**

Principal identity, policy version, Organization scope, command, resource, correlation, and causation are preserved.

Historical actions remain explainable after role changes.

---

## Failure Safety

**Rating: ★★★★★**

Authentication, policy data, evaluation, configuration, and infrastructure failures all fail closed.

No authorization failure path grants implicit permission.

---

## Testability

**Rating: ★★★★★**

The policy model supports focused unit tests, Application Service tests, integration tests, security regression tests, and property-based invariant testing.

---

## MVP Scope Discipline

**Rating: ★★★★★**

The design avoids premature complexity such as delegation, quorum approval, dynamic policies, impersonation, and cross-Organization collaboration.

Future extension points remain explicit.

---

## Final Assessment

```text
Architecture Quality:        ★★★★★
Human Authority:             ★★★★★
Organization Isolation:      ★★★★★
AI Safety Boundary:          ★★★★★
Operational Security:        ★★★★★
Auditability:                ★★★★★
Implementation Readiness:    ★★★★★
MVP Scope Discipline:        ★★★★★
```

The authorization architecture is ready for implementation within the AIOS Modular Monolith.

It is fully aligned with:

- Work Aggregate
- Decision Aggregate
- Memory Aggregate
- Application Services
- Transactional Outbox
- Background Workers
- Organization isolation
- explicit Human authority
- Secretary advisory behavior
- System operational behavior
- eventual cross-Aggregate consistency

**Architect Review Result: APPROVED**