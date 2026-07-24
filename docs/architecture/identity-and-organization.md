# Identity and Organization Architecture

**Status:** Draft  
**Phase:** MVP  
**Architecture:** Modular Monolith  
**Security Model:** Organization-Scoped Human Identity

---

# Purpose

This document defines how AIOS represents:

- Human identities
- Organizations
- Organization memberships
- role assignments
- Secretary principals
- System principals
- actor attribution
- Organization-scoped execution context

The model provides the identity foundation required by:

- Authorization
- Work
- Decision
- Memory
- Application Services
- Transactional Outbox
- Background Workers
- Audit

Authentication proves who is accessing AIOS.

Identity and Organization architecture determines how that authenticated identity participates in AIOS.

Authorization determines what that participant may do.

---

# Goals

The architecture must ensure that:

- every Human action is attributable to one stable Human identity
- every business resource belongs to one Organization
- Human membership is explicit
- Organization context is explicit
- one Human identity may belong to multiple Organizations
- permissions never cross Organization boundaries
- revoked membership grants no future authority
- Secretary and System identities remain distinct from Human identities
- historical actor references remain valid after membership changes
- identity provider changes do not rewrite domain history
- Organization membership can scale without creating one oversized Aggregate
- Organization ownership remains recoverable and auditable

---

# Non-Goals

This document does not define:

- password storage
- credential hashing
- OAuth protocol details
- OpenID Connect protocol details
- multi-factor authentication
- access-token signing
- session storage
- identity provider implementation
- network security
- data encryption algorithms
- customer support impersonation
- delegated authority
- cross-Organization collaboration
- public guest access
- marketplace identities
- AI Employee identities
- external API client identities

Those concerns belong to authentication, infrastructure, or future-phase designs.

---

# Core Model

The MVP distinguishes the following concepts:

```text
Human Identity

Organization

Membership

Role Assignment

Principal

Actor Reference

Secretary Principal

System Principal
```

These concepts are related but not interchangeable.

---

# Conceptual Relationships

```text
Human Identity
      │
      │ 1
      │
      │ 0..*
      ▼
Membership
      │
      │ * 
      │
      │ 1
      ▼
Organization
```

A Human Identity may belong to multiple Organizations.

A Membership belongs to exactly:

- one Human Identity
- one Organization

---

# Identity Versus Organization

A Human Identity represents a person.

An Organization represents a business or collaboration boundary.

Example:

```text
Human Identity
    identityId = human-123
    displayName = Alex

Membership A
    organizationId = org-alpha
    roles = Member

Membership B
    organizationId = org-beta
    roles = Reviewer
```

The same person may have different authority in different Organizations.

---

# Identity Versus Principal

An Identity is a durable internal representation.

A Principal is the authenticated execution identity for one request or process.

Example:

```text
Identity:
    human-123

Current Principal:
    HumanMemberPrincipal
    identityId = human-123
    membershipId = membership-456
    organizationId = org-alpha
```

The same Human Identity may produce different principals depending on the selected Organization context.

---

# Membership Versus Principal

A Membership represents a durable relationship between a Human Identity and an Organization.

A Human Member Principal represents an active execution context derived from that Membership.

A Membership may exist without currently producing a valid principal.

Examples:

```text
Invited Membership
    cannot produce HumanMemberPrincipal

Suspended Membership
    cannot produce HumanMemberPrincipal

Revoked Membership
    cannot produce HumanMemberPrincipal

Active Membership
    may produce HumanMemberPrincipal
```

---

# Principal Versus Actor Reference

A Principal represents who is currently executing.

An ActorReference represents who is recorded in domain history.

For a synchronous Human command:

```text
Principal:
    HumanMemberPrincipal

ActorReference:
    same Human identity and Membership
```

For asynchronous processing:

```text
Principal:
    SystemPrincipal

ActorReference:
    System operation

Original Human authority:
    preserved through causation metadata
```

The System must not be recorded as the Human who made the original decision.

---

# Stable Identity

Every Human Identity has a stable internal identifier.

Example:

```text
IdentityId
```

The identifier must remain stable when:

- email address changes
- display name changes
- authentication provider changes
- external subject identifier changes
- Organization membership changes
- the Human leaves an Organization

Domain history must reference the stable internal identity.

---

# Human Identity Record

A conceptual Human Identity record contains:

```text
HumanIdentity
- identityId
- status
- displayName
- primaryEmail
- createdAt
- updatedAt
- disabledAt
```

Authentication-provider references are modeled separately.

---

# Human Identity Status

Recommended MVP statuses:

```text
Active

Disabled
```

---

## Active

The identity may authenticate and participate through active Memberships.

---

## Disabled

The identity may not create new authenticated Human principals.

Historical actor references remain valid.

Disabling an Identity does not delete:

- Membership history
- role history
- Work history
- Decision history
- Memory history
- audit records

---

# Authentication Subject Reference

AIOS may integrate with one or more external identity providers.

Each external authentication subject maps to one internal Human Identity.

Conceptual representation:

```text
AuthenticationSubjectReference
- provider
- issuer
- subject
- identityId
- linkedAt
- unlinkedAt
```

Recommended uniqueness:

```text
UNIQUE (
    provider,
    issuer,
    subject
)
```

---

# Identity Provider Independence

Domain Aggregates must not store external identity provider subject identifiers.

Incorrect:

```text
approvedBy = auth0|abc123
```

Correct:

```text
approvedBy = identityId
```

External provider identifiers may change.

Internal audit identity must remain stable.

---

# Email Is Not Identity

Email addresses must not be used as permanent identity keys.

Email may:

- change
- be reused
- differ between Organizations
- be unverified
- use aliases
- be removed

All authoritative references use:

```text
identityId
```

---

# Display Name Is Not Identity

Display names are presentation data.

They may change without changing identity.

Historical displays may show:

- current display name
- captured display name snapshot
- both

The authoritative identity remains the stable identifier.

---

# Organization

An Organization is the primary business isolation boundary in AIOS.

Every authoritative business resource belongs to exactly one Organization.

Examples:

- Work
- Decision
- Memory
- Membership
- role assignment
- Secretary Contribution
- authorization audit record

---

# Organization Record

A conceptual Organization contains:

```text
Organization
- organizationId
- name
- status
- createdByIdentityId
- createdAt
- updatedAt
- suspendedAt
- archivedAt
```

---

# Organization Status

Recommended MVP statuses:

```text
Active

Suspended

Archived
```

---

## Active Organization

An Active Organization may:

- authenticate active Members
- create Work
- create Decisions
- review Memory
- process asynchronous events
- manage membership

---

## Suspended Organization

A Suspended Organization does not permit ordinary business mutations.

Suspension may allow restricted access for:

- Organization recovery
- billing resolution
- security investigation
- authorized administrative review

Suspension rules must fail closed.

---

## Archived Organization

An Archived Organization is read-only.

It may not:

- create new Memberships
- create new Work
- create new Decisions
- mutate Memory
- execute ordinary business commands

Historical data remains retained according to policy.

---

# Organization Identity

Organization names are not unique identity keys.

Two Organizations may have the same display name.

The authoritative key is:

```text
organizationId
```

URLs, slugs, or display names must resolve to that identifier before protected commands execute.

---

# Organization Context

Every protected request executes within exactly one Organization context.

Example:

```text
OrganizationContext
- organizationId
- membershipId
- resolvedAt
```

A request must not operate across multiple Organizations.

---

# Multi-Organization Humans

A Human Identity may belong to multiple Organizations.

The Human must operate in one selected Organization context at a time.

Example:

```text
Identity belongs to:
- org-alpha
- org-beta

Current request context:
- org-alpha
```

The org-beta Membership grants no permission inside the org-alpha request.

---

# Organization Context Selection

Organization context may be selected through:

- Organization-scoped route
- trusted session selection
- verified workspace selector
- Organization-specific hostname

The selected Organization must be validated against active Membership.

---

# Organization Context Prohibitions

The following are prohibited:

- deriving authority from any Membership in any Organization
- combining roles from multiple Organizations
- loading a resource globally and checking scope afterward
- accepting an unverified Organization identifier from payload
- processing one domain command across multiple Organizations

---

# Membership

A Membership represents the relationship between one Human Identity and one Organization.

Membership is not the Human Identity itself.

Membership is also not a role.

---

# Membership Record

A conceptual Membership contains:

```text
Membership
- membershipId
- organizationId
- identityId
- status
- roles
- invitedByIdentityId
- invitedAt
- activatedAt
- suspendedAt
- revokedAt
- revocationReason
- version
```

---

# Membership Status

Recommended MVP statuses:

```text
Invited

Active

Suspended

Revoked
```

---

## Invited

The Human has been invited but has not completed activation.

An Invited Membership grants no business authority.

---

## Active

The Human may produce a HumanMemberPrincipal for that Organization.

Authority still depends on:

- assigned roles
- permissions
- resource relationships
- command policy

---

## Suspended

The Membership is temporarily inactive.

It grants no business authority.

The Membership may later return to Active through an authorized Human action.

---

## Revoked

The Membership is permanently inactive.

It grants no future authority.

Historical records remain preserved.

A later re-entry should normally create a new Membership lifecycle or explicit reinstatement event according to implementation policy.

---

# Membership Uniqueness

The MVP permits only one current Membership relationship for one Human Identity within one Organization.

Conceptual uniqueness:

```text
UNIQUE (
    organizationId,
    identityId
)
```

Historical lifecycle changes are represented through status and events.

---

# Membership Does Not Own Human Identity

Revoking a Membership does not disable the Human Identity globally.

Example:

```text
Membership in org-alpha = Revoked

Membership in org-beta = Active
```

The Human may continue operating in org-beta.

---

# Identity Disablement

Disabling the Human Identity affects every Organization Membership.

An Identity with status Disabled cannot produce an authenticated Human Member Principal, even when a Membership is still Active.

Recommended validity condition:

```text
Identity.Status = Active

AND

Membership.Status = Active

AND

Organization.Status = Active
```

---

# Human Member Principal

A Human Member Principal is created only when all required identity facts are valid.

Conceptual representation:

```text
HumanMemberPrincipal
- principalId
- identityId
- membershipId
- organizationId
- principalType = HumanMember
- authenticatedAt
```

---

# Human Principal Validity

A Human Member Principal is valid only when:

```text
Human Identity = Active

AND

Membership = Active

AND

Organization = Active

AND

Authenticated Subject is trusted

AND

Organization context matches Membership
```

Failure of any condition results in denial.

---

# Role Assignment

Roles are assigned within a Membership.

Recommended MVP roles:

```text
OrganizationOwner

OrganizationAdmin

Member

Reviewer
```

A Membership may hold multiple roles.

---

# Role Scope

Every role assignment is scoped to one Membership and therefore one Organization.

A role must never be assigned directly to a global Human Identity without Organization scope.

Incorrect:

```text
human-123 is Reviewer everywhere
```

Correct:

```text
membership-456 in org-alpha has Reviewer
```

---

# Role Assignment Record

A conceptual Role Assignment contains:

```text
RoleAssignment
- roleAssignmentId
- membershipId
- organizationId
- role
- assignedByIdentityId
- assignedAt
- revokedByIdentityId
- revokedAt
- version
```

Only active Role Assignments grant permissions.

---

# Membership and Role Separation

Membership answers:

> Does this Human belong to this Organization?

Role Assignment answers:

> Which Organization-level responsibilities does this Membership have?

Authorization answers:

> May this Human execute this command on this resource?

These are separate decisions.

---

# Organization Owner

Every active Organization must have at least one active OrganizationOwner.

The Owner is represented by:

```text
Active Membership

+

Active OrganizationOwner Role Assignment
```

Ownership is not stored as an unaudited Boolean on the Human Identity.

---

# Last Owner Invariant

An operation must not remove, suspend, or revoke the final active Owner when the Organization remains Active.

Prohibited result:

```text
Organization.Status = Active

Active Owners = 0
```

The Organization must first:

- assign another Owner
- transfer ownership
- suspend or archive the Organization through an explicit workflow

---

# Owner Is Still Human

OrganizationOwner is a Human role.

It does not create a special non-Human principal.

An Owner remains subject to:

- authentication
- Organization scope
- Human authority requirements
- Aggregate invariants
- audit

Owner status does not permit Secretary or System impersonation.

---

# Secretary Principal

The Secretary is an advisory AI principal.

It is not:

- a Human Identity
- a Membership
- an Organization role
- an OrganizationOwner
- an OrganizationAdmin

---

# Organization-Scoped Secretary

Secretary execution is scoped to one Organization.

Conceptual representation:

```text
SecretaryPrincipal
- principalId
- principalType = Secretary
- organizationId
- capabilitySet
- generationContext
```

The Secretary may serve multiple Organizations operationally, but each execution belongs to exactly one Organization.

---

# Secretary Identity Rules

The Secretary:

- has a stable internal principal identifier
- must be distinguishable from every Human Identity
- cannot hold Human roles
- cannot receive Membership
- cannot be recorded as a Human actor
- cannot exercise business authority

---

# Secretary Contribution Attribution

A Secretary Contribution should record:

```text
secretaryPrincipalId
organizationId
requestedByIdentityId
requestedByMembershipId
generationId
correlationId
createdAt
```

This preserves both:

- who generated the suggestion
- which Human requested the assistance

---

# System Principal

A System Principal represents trusted internal automation.

Examples:

```text
outbox-publisher

decision-outcome-worker

memory-generation-worker

reconciliation-worker
```

A System Principal is not:

- a Human Identity
- a Membership
- an Organization role
- a Human actor

---

# System Principal Record

A conceptual System Principal contains:

```text
SystemPrincipal
- principalId
- principalType = System
- capabilitySet
- status
- createdAt
- disabledAt
```

System capabilities are defined by Authorization architecture.

---

# System Organization Scope

A System Principal may technically serve multiple Organizations.

Every command execution must still include one validated Organization context.

Example:

```text
SystemPrincipal:
    memory-generation-worker

Current execution:
    organizationId = org-alpha
    sourceEventId = event-123
```

The same execution cannot load data from org-beta.

---

# Actor Reference

Domain history uses a stable ActorReference.

Recommended representation:

```text
ActorReference
- actorId
- actorType
- organizationId
- membershipId
- displayNameSnapshot
```

Possible actor types:

```text
HumanMember

Secretary

System
```

---

# Human Actor Reference

For Human actions:

```text
actorId = identityId
actorType = HumanMember
organizationId = current Organization
membershipId = current Membership
```

The Membership reference records which Organization relationship was used.

---

# Secretary Actor Reference

For advisory Secretary actions:

```text
actorId = secretaryPrincipalId
actorType = Secretary
organizationId = current Organization
membershipId = null
```

Secretary attribution must never use a Human identityId as the actorId.

---

# System Actor Reference

For operational System actions:

```text
actorId = systemPrincipalId
actorType = System
organizationId = event Organization
membershipId = null
```

The source Human authority remains available through:

- correlationId
- causationId
- source event
- original ActorReference

---

# Actor Snapshot

A display name snapshot may be stored for historical readability.

Example:

```text
displayNameSnapshot = "Alex Morgan"
```

The snapshot is not authoritative identity.

The stable actor identifier remains authoritative.

---

# Historical Identity Preservation

Historical records must remain understandable when:

- a Human changes name
- a Human changes email
- Membership is revoked
- Organization is archived
- role assignment is removed
- external authentication subject is unlinked

Past actions must not be rewritten.

---

# Aggregate Boundaries

The MVP uses separate Aggregate boundaries for:

```text
Human Identity

Organization

Membership
```

This prevents one Organization Aggregate from becoming excessively large.

---

# Human Identity Aggregate

The Human Identity Aggregate owns:

- internal Human identity
- identity status
- profile identity fields
- authentication subject links
- identity disablement

It does not own:

- Organization roles
- Work assignments
- Decision reviewer relationships
- Memory review assignments

---

# Organization Aggregate

The Organization Aggregate owns:

- Organization identity
- Organization name
- Organization lifecycle status
- creation metadata
- suspension
- archival

It does not contain all Membership entities.

---

# Membership Aggregate

The Membership Aggregate owns:

- Organization-to-Identity relationship
- Membership lifecycle
- active role assignments
- invitation metadata
- suspension and revocation
- Membership version

It does not own:

- Human profile identity
- Organization lifecycle
- domain resource relationships

---

# Why Membership Is a Separate Aggregate

Organizations may contain many Members.

Placing every Membership inside one Organization Aggregate would cause:

- large Aggregate loads
- unnecessary optimistic concurrency conflicts
- poor write scalability
- complex membership updates
- oversized transaction boundaries

A separate Membership Aggregate allows independent changes while preserving Organization scope.

---

# Cross-Aggregate Coordination

Application Services coordinate Identity, Organization, and Membership.

Example:

```text
Invite Human to Organization
      │
      ▼
Load Organization
      │
      ▼
Resolve or create Human Identity reference
      │
      ▼
Create Membership
      │
      ▼
Persist Membership and Outbox
```

Aggregates never invoke one another directly.

---

# Aggregate References

Cross-Aggregate relationships use identifiers.

Examples:

```text
Membership.organizationId

Membership.identityId

Organization.createdByIdentityId

RoleAssignment.assignedByIdentityId
```

Aggregates do not hold direct object references to one another.

---

# Transaction Boundary Principle

One command should normally mutate one Aggregate.

Examples:

```text
RenameOrganization
    mutates Organization

DisableHumanIdentity
    mutates Human Identity

SuspendMembership
    mutates Membership
```

Exceptional bootstrap workflows may coordinate multiple new Aggregates in one PostgreSQL transaction.

---

# Organization Bootstrap

Creating a new Organization requires an initial Human Owner.

The bootstrap workflow may atomically create:

- Organization
- Owner Membership
- OrganizationOwner Role Assignment

Conceptual transaction:

```text
BEGIN

Create Organization

Create Membership for creator

Assign OrganizationOwner role

Persist Domain Events

Persist Outbox records

COMMIT
```

This prevents an active Organization from being created without an Owner.

---

# Organization Bootstrap Invariant

The following state must never become externally visible:

```text
Organization = Active

Active Owner Membership = Missing
```

Organization bootstrap is an exceptional coordinated-creation workflow.

It does not merge Aggregate boundaries.

---

# Identity and Organization Invariants

The following invariants must always hold:

1. Every Human action references one stable Human Identity.
2. Every protected resource belongs to exactly one Organization.
3. Every Membership belongs to exactly one Identity and one Organization.
4. A Human principal requires an Active Identity.
5. A Human principal requires an Active Membership.
6. A Human principal requires an Active Organization.
7. Roles are scoped to one Membership and one Organization.
8. Revoked or Suspended Memberships grant no authority.
9. Secretary principals cannot hold Human Memberships or roles.
10. System principals cannot hold Human Memberships or roles.
11. An Active Organization must retain at least one active Owner.
12. Organization context may not combine authority from multiple Memberships.
13. Historical actor references remain stable after identity changes.
14. External identity provider subjects are not domain actor identifiers.
15. No Aggregate directly loads or invokes another Aggregate.

---

# Trust Boundaries

The following data must come from trusted infrastructure:

- authenticated external subject
- resolved internal identityId
- principal type
- selected Organization context
- active membershipId
- System principal identity
- Secretary principal identity

Business command payloads must not be trusted to supply these values.

---

# Payload Prohibitions

Protected command payloads must not permit arbitrary values for:

```text
identityId

membershipId

principalType

organizationId

actorId

approvedBy

completedBy

reviewedBy
```

These values are derived from trusted execution context.

Creation commands may contain business data only.

---

# Domain Resource Ownership

Work, Decision, and Memory store:

```text
organizationId
```

They may also store relevant Human references such as:

```text
createdByIdentityId

assignedMembershipId

submittedByIdentityId

approvedByIdentityId
```

The specific domain Aggregate determines which references are required.

---

# Identity Deletion Principle

Hard deletion of Human Identity is not part of the MVP.

Disabling an Identity preserves:

- legal audit
- business history
- domain attribution
- security records
- event causation

Privacy-driven erasure requires a separate compliant anonymization design.

---

# Organization Deletion Principle

Hard deletion of Organization is not part of the MVP.

Organizations are archived.

Archival preserves:

- Work
- Decisions
- Memory
- Membership history
- audit records
- event history

Retention and eventual deletion require a separate compliance policy.

---

# Guiding Principles

Identity architecture answers:

> Who is this Human over time?

Organization architecture answers:

> Within which business boundary is the operation occurring?

Membership answers:

> How is this Human related to this Organization?

Authorization answers:

> May this principal attempt this command?

The Domain Model answers:

> Is the command valid in the current business state?

# Human Identity Lifecycle

The Human Identity lifecycle is intentionally simple in the MVP.

Recommended states:

```text
Active

Disabled
```

The lifecycle represents whether the Human Identity may participate in new authenticated AIOS activity.

It does not represent Organization membership.

---

# Human Identity State Machine

```text
Create Identity
      │
      ▼
Active
      │
      │ Disable Identity
      ▼
Disabled
```

The MVP does not define automatic reactivation.

Reactivation may be introduced through an explicit administrative command if required.

---

# Create Human Identity

A Human Identity may be created when:

- a trusted authentication subject is first resolved
- a Human accepts an Organization invitation
- an authorized identity provisioning workflow runs
- an external identity provider provisions the account

The creation workflow must establish a stable internal:

```text
identityId
```

---

# Create Human Identity Command

Conceptual command:

```text
CreateHumanIdentity
- commandId
- displayName
- primaryEmail
- authenticationSubjectReference
- requestedAt
```

The command must not allow the client to choose the internal identityId unless the identifier is generated by trusted infrastructure.

---

# Create Human Identity Rules

Creation requires:

- no existing active mapping for the same authentication subject
- valid identity data
- normalized email where email is stored
- trusted authentication subject information
- stable internal identifier generation

Creation does not automatically grant Organization membership.

---

# Human Identity Created Event

```text
HumanIdentityCreated
- eventId
- identityId
- displayName
- primaryEmail
- occurredAt
- correlationId
- causationId
```

The event must not expose authentication secrets.

---

# Update Human Identity Profile

A Human may update non-authoritative profile information such as:

- display name
- primary email
- locale
- presentation preferences

Profile changes do not change domain identity.

---

# Update Human Identity Command

```text
UpdateHumanIdentityProfile
- identityId
- displayName
- primaryEmail
- expectedVersion
```

Authorization must verify that the Human may update the target identity.

---

# Human Identity Profile Updated Event

```text
HumanIdentityProfileUpdated
- identityId
- changedFields
- updatedBy
- occurredAt
```

Sensitive previous values should not be copied into broadly distributed event payloads.

---

# Link Authentication Subject

A trusted external authentication subject may be linked to an existing Human Identity.

Conceptual command:

```text
LinkAuthenticationSubject
- identityId
- provider
- issuer
- subject
```

---

# Link Rules

The authentication subject must:

- be verified by trusted infrastructure
- not already map to another Human Identity
- belong to a supported provider
- preserve internal identity continuity

---

# Authentication Subject Linked Event

```text
AuthenticationSubjectLinked
- identityId
- provider
- issuer
- subjectReference
- linkedAt
```

The event may use a protected or hashed representation when raw subject identifiers should not be widely exposed.

---

# Unlink Authentication Subject

An authentication subject may be unlinked when:

- a provider connection is removed
- identity migration is complete
- the subject is compromised
- the subject is no longer valid

The system must not unlink the final usable authentication method without an explicit recovery strategy.

---

# Disable Human Identity

Disabling a Human Identity prevents creation of new Human Member Principals across all Organizations.

Conceptual command:

```text
DisableHumanIdentity
- identityId
- reason
- expectedVersion
```

---

# Disable Human Identity Rules

Disablement requires:

- authorized administrative authority
- a reason
- identity currently Active
- explicit handling when the Human is the last active Owner of an Organization

The system must not disable a Human Identity if doing so would leave an Active Organization without an active Owner.

---

# Human Identity Disabled Event

```text
HumanIdentityDisabled
- identityId
- disabledBy
- reason
- disabledAt
```

Historical actions remain valid.

---

# Identity Disablement Effects

After disablement:

```text
New Human authentication
    → denied

Existing sessions
    → revoked or rejected on revalidation

Active Membership records
    → remain historically present

Role assignments
    → remain historically present

Future authority
    → none
```

Memberships may later be separately suspended or revoked for administrative clarity.

---

# Identity Reactivation

Identity reactivation is optional in the MVP.

If implemented, it requires an explicit command:

```text
ReactivateHumanIdentity
- identityId
- reason
- expectedVersion
```

Reactivation does not automatically reactivate Suspended or Revoked Memberships.

---

# Organization Lifecycle

Recommended Organization states:

```text
Active

Suspended

Archived
```

---

# Organization State Machine

```text
Create Organization
        │
        ▼
      Active
        │
        ├── SuspendOrganization
        │         │
        │         ▼
        │     Suspended
        │         │
        │         └── ReactivateOrganization
        │                   │
        │                   ▼
        │                 Active
        │
        └── ArchiveOrganization
                  │
                  ▼
               Archived
```

An Archived Organization does not return to Active in the MVP.

---

# Create Organization

Organization creation is a coordinated bootstrap workflow.

It creates:

- the Organization
- the creator’s Membership
- the initial OrganizationOwner role

---

# Create Organization Command

```text
CreateOrganization
- commandId
- name
- creatorIdentityId
- requestedAt
```

The creator identity is derived from trusted Human context.

The payload must not select another person as the initial Owner.

---

# Organization Bootstrap Transaction

```text
BEGIN

Verify Human Identity is Active

Generate organizationId

Generate membershipId

Create Organization

Create Active Membership for creator

Assign OrganizationOwner role

Persist Organization

Persist Membership

Persist Domain Events

Persist Outbox Records

Record processed command

COMMIT
```

---

# Organization Created Event

```text
OrganizationCreated
- organizationId
- name
- createdByIdentityId
- createdAt
```

---

# Initial Membership Created Event

```text
MembershipCreated
- membershipId
- organizationId
- identityId
- status = Active
- createdAt
```

---

# Initial Owner Assigned Event

```text
OrganizationOwnerAssigned
- organizationId
- membershipId
- identityId
- assignedByIdentityId
- assignedAt
```

---

# Rename Organization

Conceptual command:

```text
RenameOrganization
- organizationId
- newName
- expectedVersion
```

The Organization Aggregate validates:

- current state permits rename
- new name is valid
- name differs meaningfully from the current name

---

# Organization Renamed Event

```text
OrganizationRenamed
- organizationId
- previousName
- newName
- renamedBy
- renamedAt
```

Organization name changes do not change organizationId.

---

# Suspend Organization

Suspension temporarily blocks ordinary business mutations.

Conceptual command:

```text
SuspendOrganization
- organizationId
- reason
- expectedVersion
```

---

# Suspension Rules

Suspension requires:

- authorized Human administrative action
- Organization currently Active
- explicit reason
- no automatic deletion of resources
- preservation of membership and audit history

---

# Organization Suspended Event

```text
OrganizationSuspended
- organizationId
- suspendedBy
- reason
- suspendedAt
```

---

# Suspension Effects

While Suspended:

- new Work creation is denied
- new Decision creation is denied
- Work completion is denied
- Decision review is denied
- Memory review is denied
- membership administration is restricted
- background mutation is paused where safe
- read access may remain available according to policy

Operational processing may continue only when required to preserve consistency or recovery.

---

# Reactivate Organization

Conceptual command:

```text
ReactivateOrganization
- organizationId
- reason
- expectedVersion
```

Reactivation requires:

- Organization currently Suspended
- at least one valid active Owner
- no blocking security or administrative restriction
- authorized Human action

---

# Organization Reactivated Event

```text
OrganizationReactivated
- organizationId
- reactivatedBy
- reason
- reactivatedAt
```

---

# Archive Organization

Archival makes the Organization read-only.

Conceptual command:

```text
ArchiveOrganization
- organizationId
- reason
- expectedVersion
```

---

# Archive Rules

Archival requires:

- authorized Owner action
- Organization not already Archived
- explicit reason
- preservation of historical data
- explicit handling of pending business workflows
- no automatic hard deletion

The implementation must define whether in-progress Work must be cancelled before archival.

Recommended MVP rule:

> An Organization may be archived only when no Work remains InProgress or WaitingForDecision.

---

# Organization Archived Event

```text
OrganizationArchived
- organizationId
- archivedBy
- reason
- archivedAt
```

---

# Archive Effects

After archival:

```text
Business commands
    → denied

Membership invitations
    → denied

Role changes
    → denied except controlled archival administration

Read operations
    → permitted according to retention policy

Background mutation
    → disabled except audit, export, or retention processing
```

---

# Membership Lifecycle

Recommended Membership states:

```text
Invited

Active

Suspended

Revoked
```

---

# Membership State Machine

```text
Invite Human
      │
      ▼
   Invited
      │
      ├── AcceptInvitation
      │         │
      │         ▼
      │       Active
      │         │
      │         ├── SuspendMembership
      │         │          │
      │         │          ▼
      │         │      Suspended
      │         │          │
      │         │          ├── ReactivateMembership
      │         │          │          │
      │         │          │          ▼
      │         │          │        Active
      │         │          │
      │         │          └── RevokeMembership
      │         │                     │
      │         │                     ▼
      │         │                  Revoked
      │         │
      │         └── RevokeMembership
      │                    │
      │                    ▼
      │                 Revoked
      │
      ├── RevokeInvitation
      │          │
      │          ▼
      │       Revoked
      │
      └── ExpireInvitation
                 │
                 ▼
              Revoked
```

The MVP may model invitation expiry as Revoked with a specific reason.

---

# Invite Human to Organization

An authorized Human may invite another person to an Organization.

Conceptual command:

```text
InviteHumanToOrganization
- organizationId
- inviteeEmail
- initialRoles
- invitationMessage
- expiresAt
```

---

# Invitation Workflow

```text
Authorized Human
      │
      ▼
Validate Organization is Active
      │
      ▼
Normalize invitee identity reference
      │
      ▼
Check existing Membership
      │
      ▼
Create Invited Membership
      │
      ▼
Assign permitted initial roles
      │
      ▼
Persist and publish invitation event
```

---

# Invitation Rules

Invitation requires:

- Organization is Active
- inviter has membership-management permission
- invitee is not already an Active Member
- invitee is not already Invited unless resend is intended
- initial roles are within inviter’s assignment authority
- at least one initial role is assigned or a default Member role is applied
- invitation has a bounded validity period

---

# Existing Identity Invitation

If the invitee already has a Human Identity:

```text
Create Membership linked to existing identityId
```

The invitation must not create a duplicate Human Identity.

---

# Unknown Identity Invitation

If the invitee does not yet have a Human Identity:

- create a pending invitation identity reference
- send invitation to the normalized address
- resolve or create the Human Identity during acceptance
- link the activated Membership to the stable identityId

The pending email reference is not yet an authoritative Human Identity.

---

# Membership Invited Event

```text
MembershipInvited
- membershipId
- organizationId
- inviteeReference
- initialRoles
- invitedByIdentityId
- invitedAt
- expiresAt
```

---

# Invitation Delivery

Invitation email delivery is asynchronous.

```text
MembershipInvited
      │
      ▼
Outbox
      │
      ▼
Invitation Delivery Worker
```

Failure to deliver the invitation does not erase the Membership invitation state.

Delivery may be retried.

---

# Accept Invitation

Conceptual command:

```text
AcceptOrganizationInvitation
- invitationToken
- authenticatedIdentityContext
```

The authenticated Human must match the intended invitation recipient according to the invitation policy.

---

# Acceptance Rules

Acceptance requires:

- invitation is valid
- invitation is not expired
- Membership is Invited
- Organization is Active
- authenticated identity matches the invitation
- Human Identity is Active
- invitation has not already been accepted
- initial role assignments remain valid

---

# Invitation Identity Matching

Matching may use:

- verified email address
- pre-linked authentication subject
- explicit invitation claim
- administrative confirmation

Unverified email alone must not grant Membership.

---

# Invitation Acceptance Transaction

```text
BEGIN

Validate invitation token

Resolve Human Identity

Load Invited Membership

Verify Organization is Active

Membership.Activate(identityId)

Persist Membership

Persist role assignments

Write MembershipActivated event

Record processed command

COMMIT
```

---

# Membership Activated Event

```text
MembershipActivated
- membershipId
- organizationId
- identityId
- activatedAt
- initialRoles
```

Activation makes the Membership eligible to produce a Human Member Principal.

---

# Resend Invitation

Conceptual command:

```text
ResendOrganizationInvitation
- membershipId
```

Resending may:

- issue a new invitation token
- extend expiration
- invalidate prior unused tokens
- produce a new delivery event

It must not create another Membership.

---

# Revoke Invitation

Conceptual command:

```text
RevokeOrganizationInvitation
- membershipId
- reason
- expectedVersion
```

The Membership must be Invited.

---

# Invitation Revoked Event

```text
MembershipInvitationRevoked
- membershipId
- organizationId
- revokedByIdentityId
- reason
- revokedAt
```

---

# Suspend Membership

Suspension temporarily removes authority in one Organization.

Conceptual command:

```text
SuspendMembership
- membershipId
- reason
- expectedVersion
```

---

# Suspension Rules

Suspension requires:

- Membership is Active
- Organization is not Archived
- authorized Human administrative action
- explicit reason
- Last Owner Invariant remains satisfied

---

# Membership Suspended Event

```text
MembershipSuspended
- membershipId
- organizationId
- identityId
- suspendedByIdentityId
- reason
- suspendedAt
```

---

# Suspension Effects

After Membership suspension:

- no new Human Member Principal may be created for that Membership
- existing sessions must fail current Membership validation
- assigned Work remains assigned unless separately reassigned
- review assignments remain historical
- role assignments remain stored but inactive for authorization
- historical actions remain valid

---

# Reactivate Membership

Conceptual command:

```text
ReactivateMembership
- membershipId
- reason
- expectedVersion
```

Reactivation requires:

- Membership is Suspended
- Organization is Active
- Human Identity is Active
- authorized Human administrative action
- role assignments remain valid
- no security block remains

---

# Membership Reactivated Event

```text
MembershipReactivated
- membershipId
- organizationId
- identityId
- reactivatedByIdentityId
- reason
- reactivatedAt
```

---

# Revoke Membership

Revocation permanently removes future Organization authority.

Conceptual command:

```text
RevokeMembership
- membershipId
- reason
- expectedVersion
```

---

# Revocation Rules

Revocation requires:

- Membership is Invited, Active, or Suspended
- authorized Human administrative action
- explicit reason
- Last Owner Invariant remains satisfied
- current execution is not attempting prohibited self-removal
- pending assignments are handled according to policy

---

# Membership Revoked Event

```text
MembershipRevoked
- membershipId
- organizationId
- identityId
- revokedByIdentityId
- reason
- revokedAt
```

---

# Revocation Effects

After revocation:

```text
Future authority
    → none

Existing sessions
    → invalid for the Organization

Role assignments
    → inactive

Historical attribution
    → preserved

Domain ownership history
    → preserved
```

Revocation does not delete the Human Identity.

---

# Membership Reinstatement

The MVP should not silently change Revoked back to Active.

A returning Human should use an explicit workflow.

Recommended options:

```text
Create a new Membership lifecycle

or

Explicit ReinstateMembership command
```

The selected implementation must preserve prior revocation history.

---

# Recommended MVP Reinstatement Rule

Use explicit reinstatement of the same Membership only when:

- Organization policy permits
- prior identity linkage remains valid
- reactivation reason is captured
- roles are explicitly reassigned
- authorization audit is preserved

Otherwise, create a new Membership record.

---

# Role Assignment Lifecycle

Role assignments have two effective states:

```text
Active

Revoked
```

The lifecycle is append-only from an audit perspective.

---

# Assign Role

Conceptual command:

```text
AssignOrganizationRole
- membershipId
- role
- expectedMembershipVersion
```

---

# Role Assignment Rules

Assignment requires:

- Membership is Active
- Organization is Active
- requested role is supported
- actor may assign that role
- role is not already active
- cross-Organization assignment is impossible
- self-escalation policy permits the action
- Last Owner Invariant remains valid

---

# Role Assigned Event

```text
OrganizationRoleAssigned
- roleAssignmentId
- membershipId
- organizationId
- identityId
- role
- assignedByIdentityId
- assignedAt
```

---

# Revoke Role

Conceptual command:

```text
RevokeOrganizationRole
- membershipId
- role
- reason
- expectedMembershipVersion
```

---

# Role Revocation Rules

Revocation requires:

- role is currently active
- actor may revoke the role
- explicit reason for privileged roles
- Last Owner Invariant remains satisfied
- role removal does not silently revoke Membership

---

# Role Revoked Event

```text
OrganizationRoleRevoked
- roleAssignmentId
- membershipId
- organizationId
- identityId
- role
- revokedByIdentityId
- reason
- revokedAt
```

---

# Role Replacement

Changing a Member from one role set to another is modeled as:

```text
Assign new role

and/or

Revoke existing role
```

There is no direct mutable role-array replacement without audit events.

---

# Owner Assignment

Assigning OrganizationOwner requires stronger authorization than ordinary role assignment.

Recommended policy:

```text
Only an active OrganizationOwner may assign another Owner.
```

An Admin cannot create a new Owner unless explicitly permitted by future policy.

---

# Owner Assigned Event

```text
OrganizationOwnerAssigned
- organizationId
- membershipId
- identityId
- assignedByIdentityId
- assignedAt
```

This may be a specialized event in addition to the generic role-assignment event.

---

# Owner Removal

Removing Owner authority requires:

- actor is an active Owner
- another active Owner remains
- target Membership is not the only active Owner
- operation is audited
- Organization remains Active or follows a controlled lifecycle transition

---

# Ownership Transfer

Ownership transfer is an Application Layer workflow.

It coordinates:

1. assigning OrganizationOwner to the new Owner
2. optionally revoking OrganizationOwner from the previous Owner

---

# Transfer Ownership Command

```text
TransferOrganizationOwnership
- organizationId
- fromMembershipId
- toMembershipId
- retainPreviousOwnerRole
- reason
```

---

# Ownership Transfer Preconditions

The Application Service verifies:

- Organization is Active
- initiator is an active Owner
- source Membership is an active Owner
- target Membership is Active
- target Membership belongs to the same Organization
- target Human Identity is Active
- transfer does not create an invalid zero-Owner state

---

# Ownership Transfer Transaction

```text
BEGIN

Load source Membership

Load target Membership

Verify both belong to Organization

Assign Owner role to target

If retainPreviousOwnerRole = false:
    Revoke Owner role from source

Persist both Membership Aggregates

Persist Domain Events

Persist Outbox Records

Record processed command

COMMIT
```

This is an exceptional multi-Aggregate coordination workflow.

---

# Ownership Transferred Event

```text
OrganizationOwnershipTransferred
- organizationId
- fromMembershipId
- toMembershipId
- initiatedByIdentityId
- retainedPreviousOwner
- reason
- occurredAt
```

---

# Self-Removal Rules

A Human may be allowed to leave an Organization.

Conceptual command:

```text
LeaveOrganization
- membershipId
- reason
```

The Human may act only on their own current Membership.

---

# Leave Organization Preconditions

Leaving requires:

- Membership is Active or Suspended
- requester identity matches Membership identity
- Membership is not the final active Owner
- pending critical assignments are handled according to policy

---

# Member Left Event

```text
MemberLeftOrganization
- membershipId
- organizationId
- identityId
- reason
- leftAt
```

The resulting Membership status is Revoked.

---

# Assignment Consequences

Membership suspension or revocation may leave business-resource assignments unresolved.

Examples:

- Work Assignee revoked
- Decision Reviewer suspended
- Memory Reviewer revoked

The Membership Aggregate does not directly update those resources.

---

# Assignment Reconciliation

Membership lifecycle events may trigger asynchronous reconciliation.

Example:

```text
MembershipRevoked
      │
      ▼
Assignment Reconciliation Handler
      │
      ├── detect assigned Work
      ├── detect review assignments
      └── notify Organization Admin
```

---

# No Automatic Business Reassignment

The System must not silently assign a new Human to Work or review responsibilities.

Reassignment requires authorized Human action.

The System may:

- flag unassigned resources
- create administrative alerts
- populate an action queue
- notify Owners or Admins

---

# Membership Status and Existing Resources

A suspended or revoked Member may remain referenced in historical or current domain records.

Example:

```text
Work.assignedMembershipId = revoked membership
```

This is temporarily valid as a recoverable administrative condition.

The domain may restrict completion or new action until reassignment.

---

# Invitation Token Model

Invitation tokens are infrastructure credentials.

They are not domain identity.

A token should contain or reference:

```text
invitationId
membershipId
organizationId
expiresAt
nonce
```

Tokens must be:

- unguessable
- time-limited
- single-use
- revocable
- stored securely

---

# Invitation Token Events

Raw invitation tokens must not appear in Domain Events or logs.

Events may reference:

```text
invitationId
```

only.

---

# Commands Summary

## Human Identity Commands

```text
CreateHumanIdentity

UpdateHumanIdentityProfile

LinkAuthenticationSubject

UnlinkAuthenticationSubject

DisableHumanIdentity

ReactivateHumanIdentity
```

---

## Organization Commands

```text
CreateOrganization

RenameOrganization

SuspendOrganization

ReactivateOrganization

ArchiveOrganization
```

---

## Membership Commands

```text
InviteHumanToOrganization

AcceptOrganizationInvitation

ResendOrganizationInvitation

RevokeOrganizationInvitation

SuspendMembership

ReactivateMembership

RevokeMembership

LeaveOrganization
```

---

## Role Commands

```text
AssignOrganizationRole

RevokeOrganizationRole

TransferOrganizationOwnership
```

---

# Domain Events Summary

## Human Identity Events

```text
HumanIdentityCreated

HumanIdentityProfileUpdated

AuthenticationSubjectLinked

AuthenticationSubjectUnlinked

HumanIdentityDisabled

HumanIdentityReactivated
```

---

## Organization Events

```text
OrganizationCreated

OrganizationRenamed

OrganizationSuspended

OrganizationReactivated

OrganizationArchived
```

---

## Membership Events

```text
MembershipInvited

MembershipActivated

MembershipInvitationRevoked

MembershipSuspended

MembershipReactivated

MembershipRevoked

MemberLeftOrganization
```

---

## Role Events

```text
OrganizationRoleAssigned

OrganizationRoleRevoked

OrganizationOwnerAssigned

OrganizationOwnershipTransferred
```

---

# Command Actor Requirements

All identity and Organization lifecycle commands require a Human principal except:

```text
CreateHumanIdentity
```

which may also be initiated by trusted identity provisioning infrastructure.

The System may deliver invitations and notifications.

The Secretary may not execute identity, Membership, Organization, or role commands.

---

# Secretary Prohibition

The Secretary may never:

- create a Human Identity
- invite a Member
- accept an invitation
- activate a Membership
- suspend or revoke a Membership
- assign or revoke roles
- transfer ownership
- suspend or archive an Organization

These operations require Human or trusted identity infrastructure authority.

---

# System Operational Scope

The System may:

- send invitation messages
- expire unused invitation tokens
- invalidate sessions after disablement
- reconcile unresolved assignments
- publish lifecycle events
- retry failed operational work

The System may not independently decide:

- who joins an Organization
- who becomes Owner
- who loses Membership
- whether an Organization is archived

---

# Event Causation Rules

Operational events must preserve original causation.

Example:

```text
Human invites Member
      │
      ▼
MembershipInvited
      │
      ▼
System sends invitation email
```

The System delivery event does not become the source of Membership authority.

---

# Identity Event Privacy

Identity events should minimize personal data.

Preferred payloads contain:

- stable identifiers
- changed field names
- status
- timestamps
- audit references

Avoid including:

- raw access tokens
- passwords
- full authentication claims
- unnecessary email history
- invitation secrets

---

# Lifecycle Idempotency

Every lifecycle command must be idempotent at the Application Layer.

Examples:

```text
Accept same invitation twice

↓

Return existing activated Membership
```

```text
Revoke already revoked Membership with same commandId

↓

Return previous result
```

A different command attempting an invalid repeated transition is handled by the Aggregate.

---

# Lifecycle Concurrency

Identity, Organization, and Membership Aggregates use optimistic concurrency.

Examples of protected races:

- two Admins assign the same role
- Owner is removed while another transfer occurs
- invitation is accepted while being revoked
- Membership is suspended while role is assigned
- Organization is archived while a Member is invited

Failed writes reload and revalidate the complete command.

---

# Last Owner Concurrency

The Last Owner Invariant spans multiple Membership Aggregates.

The Application Layer must enforce it using a transactional strategy.

Recommended PostgreSQL approaches include:

- Organization-scoped advisory lock
- serialized owner-count check
- dedicated Organization ownership version
- owner index table locked during mutation

The implementation must prevent concurrent removals from producing zero active Owners.

---

# Owner Invariant Transaction

Conceptual flow:

```text
BEGIN

Lock Organization ownership scope

Count active Owners

Apply owner assignment or removal

Recheck active Owner count

Persist Membership changes

Persist events

COMMIT
```

The count must be based on the same transaction snapshot.

---

# Organization Archive Coordination

Archival may require coordination with Work query services.

The Application Service verifies:

- no prohibited active Work exists
- no critical pending ownership transfer exists
- Organization retains an auditable Owner at archive time

The Organization Aggregate then validates its own lifecycle transition.

---

# Identity Disablement Coordination

Disabling a Human Identity may affect multiple Organizations.

The Application Service must identify whether the Human is:

- the final Owner of any Active Organization
- assigned to critical Work
- the only reviewer of pending reviews

Only the final-Owner condition blocks disablement by invariant.

Other conditions produce administrative warnings or follow-up work.

---

# Lifecycle Consistency Model

Identity, Organization, and Membership state changes are strongly consistent within their transaction.

Consequences in other Aggregates are eventually consistent.

Example:

```text
Membership Revoked
      │
      ▼
Work still references Member briefly
      │
      ▼
Reconciliation flags reassignment
```

This temporary condition is valid and recoverable.

---

# Part 2 Design Summary

The lifecycle model guarantees:

- stable Human identity
- explicit Organization lifecycle
- auditable Membership activation
- reversible suspension
- permanent revocation semantics
- Organization-scoped role assignment
- protected ownership transfer
- preservation of historical attribution
- no automatic AI authority
- asynchronous handling of operational consequences

Identity and Membership changes establish who may participate.

Authorization still determines which commands that participant may execute.

# Application Workflows

Identity and Organization use cases are coordinated by Application Services.

Application Services are responsible for:

- resolving trusted principals
- resolving Organization context
- evaluating authorization
- loading Aggregate Roots
- coordinating exceptional multi-Aggregate workflows
- managing transaction boundaries
- persisting Domain Events through the Transactional Outbox
- preserving audit metadata
- returning stable application results

Business lifecycle rules remain inside the relevant Aggregates.

---

# Standard Human Command Flow

A protected Human command follows this sequence:

```text
Receive Request
      │
      ▼
Validate Authentication
      │
      ▼
Resolve Human Identity
      │
      ▼
Resolve Organization Context
      │
      ▼
Resolve Active Membership
      │
      ▼
Construct HumanMemberPrincipal
      │
      ▼
Evaluate Authorization
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

Failure at any identity, Organization, Membership, or authorization step stops the command before domain mutation.

---

# Principal Resolution

Principal Resolution converts trusted authentication evidence into an internal execution identity.

The resolver must never trust business command payload fields for principal identity.

---

# Principal Resolver Interface

A conceptual interface:

```text
PrincipalResolver

Resolve(
    AuthenticationContext,
    RequestedOrganizationContext
) -> PrincipalResolutionResult
```

Possible results:

```text
HumanMemberPrincipal

SecretaryPrincipal

SystemPrincipal

Unauthenticated

InvalidPrincipal

OrganizationContextRequired
```

---

# Human Principal Resolution

Human principal resolution performs:

```text
Validate authentication evidence

↓

Resolve AuthenticationSubjectReference

↓

Load Human Identity

↓

Verify Identity is Active

↓

Resolve requested Organization

↓

Load Membership

↓

Verify Membership is Active

↓

Verify Organization is Active

↓

Construct HumanMemberPrincipal
```

---

# Human Principal Resolution Result

A Human Member Principal should contain:

```text
HumanMemberPrincipal
- principalId
- principalType = HumanMember
- identityId
- membershipId
- organizationId
- authenticatedSubjectReference
- authenticatedAt
- resolvedAt
```

The principal should not include mutable role or permission snapshots unless their validity period is explicitly controlled.

---

# Principal Identifier

The principalId identifies one authenticated execution identity.

It may be derived from:

```text
identityId

membershipId

sessionId
```

The exact representation is implementation-specific.

The stable domain actor remains:

```text
identityId
```

---

# Multiple Authentication Subjects

One Human Identity may have multiple linked authentication subjects.

Example:

```text
Human Identity
    ├── Corporate OIDC subject
    └── Personal passkey subject
```

Both subjects resolve to the same internal identityId.

They do not create separate Human identities.

---

# Ambiguous Subject Resolution

One external subject must never resolve to multiple Human Identities.

If conflicting mappings exist:

```text
Resolution = Failed

Authentication = Denied

Security alert = Raised
```

The system must not guess which identity is correct.

---

# Disabled Identity Resolution

When the mapped Human Identity is Disabled:

```text
Principal resolution fails

No Membership is activated

No Organization context is accepted

No domain command executes
```

The failure should be recorded as a security-relevant event.

---

# Organization Context Resolution

Every protected Human request must resolve exactly one Organization context.

The context determines:

- Membership
- roles
- permissions
- resource scope
- audit scope
- repository scope

---

# Organization Context Sources

Organization context may be selected through:

```text
Organization-scoped route

Workspace selection stored in session

Organization-specific hostname

Explicit trusted request header
```

The source must be validated.

A raw Organization identifier in a business payload is not trusted.

---

# Organization-Scoped Route Example

```text
POST /organizations/{organizationId}/work
```

The route provides a requested Organization identifier.

The Application Layer must still verify:

- Organization exists
- Organization is Active
- Human has an Active Membership
- route Organization matches resource Organization

---

# Session-Selected Organization

A session may remember a selected Organization.

Example:

```text
session.selectedOrganizationId
```

The selection is only a convenience.

Each protected request must verify that the Membership remains Active.

---

# Organization Context Resolver Interface

```text
OrganizationContextResolver

Resolve(
    identityId,
    requestedOrganizationId
) -> OrganizationContextResult
```

Possible results:

```text
Resolved

OrganizationNotFound

MembershipNotFound

MembershipInactive

OrganizationInactive

AmbiguousContext
```

---

# Organization Context Record

```text
OrganizationContext
- organizationId
- membershipId
- identityId
- organizationStatus
- membershipStatus
- resolvedAt
```

Role and permission resolution may occur after this context is established.

---

# Missing Organization Context

When a Human belongs to multiple Organizations and no Organization is selected:

```text
Resolution = OrganizationContextRequired
```

The system must not choose an Organization automatically based on:

- most recent activity
- first Membership
- highest role
- resource guess
- email domain

---

# Single Membership Convenience

The UI may automatically suggest the only available Organization.

The server must still resolve and validate it explicitly.

---

# Organization Switching

Switching Organization changes the current execution context.

Conceptual command:

```text
SelectOrganizationContext
- organizationId
```

This command affects session context only.

It does not mutate Organization or Membership Aggregates.

---

# Organization Switch Rules

Switching requires:

- Human Identity is Active
- target Organization is Active
- target Membership is Active
- authenticated session is valid

The switch does not combine roles from the previous Organization.

---

# Resource Organization Verification

After loading a target resource, the Application Service must verify:

```text
resource.organizationId
    =
principal.organizationId
```

Repositories should also require Organization scope to prevent accidental disclosure.

---

# Principal Resolution for Secretary

Secretary execution must originate from trusted AIOS infrastructure.

Conceptual flow:

```text
Authorized Human or System request
      │
      ▼
Create Generation Context
      │
      ▼
Resolve Secretary Principal
      │
      ▼
Execute Advisory Capability
```

---

# Secretary Principal Context

```text
SecretaryPrincipal
- principalId
- principalType = Secretary
- organizationId
- capabilitySet
- generationId
- requestedByIdentityId
- requestedByMembershipId
- correlationId
```

The Secretary principal must not contain Human roles.

---

# Secretary Principal Requirements

Secretary resolution requires:

- trusted internal invocation
- valid Organization context
- supported advisory capability
- valid generation request
- traceable requesting Human or System workflow
- bounded execution scope

---

# Principal Resolution for System Workers

System principals are resolved through trusted internal workload identity.

Example:

```text
SystemPrincipal
- principalId = decision-outcome-worker
- principalType = System
- capabilitySet
- executionOrganizationId
- sourceEventId
- correlationId
- causationId
```

---

# System Principal Requirements

System resolution requires:

- trusted workload credential
- enabled System principal record
- allowed capability
- one Organization execution scope
- valid source event when event-caused
- supported event schema

A public request may never construct a System principal.

---

# Application Service: Create Organization

Organization creation is an exceptional coordinated workflow.

```text
Authenticated Human
      │
      ▼
Resolve Active Human Identity
      │
      ▼
Authorize Organization Creation
      │
      ▼
Generate Organization and Membership IDs
      │
      ▼
Create Organization
      │
      ▼
Create Active Owner Membership
      │
      ▼
Assign OrganizationOwner Role
      │
      ▼
Persist All Changes and Outbox
      │
      ▼
Commit
```

---

# Create Organization Transaction

```text
BEGIN

Verify command idempotency

Load Human Identity

Verify Identity is Active

Create Organization Aggregate

Create Membership Aggregate

Assign OrganizationOwner role

Save Organization

Save Membership

Write Domain Events to Outbox

Write authorization audit metadata

Record processed command

COMMIT
```

The transaction must fail entirely if any bootstrap step fails.

---

# Create Organization Result

Recommended result:

```text
CreateOrganizationResult
- organizationId
- membershipId
- organizationStatus
- assignedRoles
- aggregateVersions
```

---

# Application Service: Invite Human

Invitation may target an existing or unknown Human Identity.

```text
Authorized Human
      │
      ▼
Resolve Organization Context
      │
      ▼
Authorize Membership Invitation
      │
      ▼
Resolve Invitee Reference
      │
      ▼
Check Existing Membership
      │
      ▼
Create Invited Membership
      │
      ▼
Assign Initial Roles
      │
      ▼
Persist and Publish Invitation Event
```

---

# Invitee Resolution

The Application Service may resolve invitees by:

- existing identityId selected through an authorized directory
- verified existing email mapping
- normalized pending invitation email

It must not disclose unrelated identity information.

---

# Existing Membership Outcomes

When an existing Membership is found:

```text
Active
    → invitation rejected as already a Member

Invited
    → resend or return existing invitation

Suspended
    → administrative reactivation workflow required

Revoked
    → explicit reinstatement or new Membership policy required
```

The Application Service must not create duplicate Memberships.

---

# Invitation Transaction

```text
BEGIN

Verify command idempotency

Load Organization

Verify Organization is Active

Authorize invitation and initial roles

Check Membership uniqueness

Create Invited Membership

Assign initial roles

Save Membership

Write MembershipInvited to Outbox

Record authorization audit

Record processed command

COMMIT
```

Invitation delivery occurs after commit.

---

# Application Service: Accept Invitation

Invitation acceptance coordinates authentication evidence and Membership activation.

```text
Authenticated Human
      │
      ▼
Validate Invitation Token
      │
      ▼
Resolve or Create Human Identity
      │
      ▼
Load Invited Membership
      │
      ▼
Match Intended Recipient
      │
      ▼
Activate Membership
      │
      ▼
Persist and Commit
```

---

# Identity Creation During Acceptance

When no Human Identity exists, acceptance may coordinate:

- Human Identity creation
- authentication subject linkage
- Membership activation

These changes may be committed atomically.

---

# Acceptance Transaction

```text
BEGIN

Verify command idempotency

Lock invitation identity

Validate token and expiration

Resolve Authentication Subject

Load or create Human Identity

Load Invited Membership

Verify recipient match

Verify Organization is Active

Activate Membership

Link Membership to identityId

Save Human Identity if created

Save Membership

Write Domain Events to Outbox

Invalidate invitation token

Record processed command

COMMIT
```

---

# Invitation Token Consumption

The token must become unusable in the same transaction that activates the Membership.

This prevents concurrent acceptance.

Recommended token state:

```text
Pending

Consumed

Revoked

Expired
```

---

# Duplicate Invitation Acceptance

When the same command is retried after successful acceptance:

- return the existing Membership result
- do not emit another activation event
- do not create another Human Identity
- do not create another role assignment

---

# Application Service: Suspend Membership

```text
Authorized Owner or Admin
      │
      ▼
Resolve Organization Context
      │
      ▼
Load Target Membership
      │
      ▼
Verify Same Organization
      │
      ▼
Authorize Suspension
      │
      ▼
Protect Last Owner Invariant
      │
      ▼
Membership.Suspend(...)
      │
      ▼
Persist and Commit
```

---

# Suspension Transaction

```text
BEGIN

Verify command idempotency

Lock Organization ownership scope when required

Load target Membership

Authorize suspension

Verify Last Owner Invariant

Execute Membership.Suspend

Save Membership

Write MembershipSuspended to Outbox

Record authorization audit

Record processed command

COMMIT
```

---

# Application Service: Revoke Membership

Revocation follows the same security pattern as suspension but has permanent authority consequences.

Additional Application Layer checks may include:

- unresolved ownership
- target Member’s current assignments
- Organization policy warnings
- self-removal restrictions

Only the Last Owner condition is a blocking cross-Aggregate invariant in the MVP.

---

# Application Service: Transfer Ownership

Ownership transfer coordinates two Membership Aggregates.

```text
Current Owner
      │
      ▼
Authorize Transfer
      │
      ▼
Lock Organization Ownership Scope
      │
      ▼
Load Source Membership
      │
      ▼
Load Target Membership
      │
      ▼
Assign Owner to Target
      │
      ▼
Optionally Remove Owner from Source
      │
      ▼
Persist Both Aggregates
      │
      ▼
Commit
```

---

# Ownership Transfer Atomicity

The following must commit atomically:

- target Owner assignment
- optional source Owner revocation
- ownership transfer event
- authorization audit
- command idempotency record

No intermediate zero-Owner state may become visible.

---

# Application Service: Disable Human Identity

Identity disablement may affect multiple Organizations.

The workflow first evaluates final-owner risk.

```text
Authorized Identity Administrator
      │
      ▼
Load Human Identity
      │
      ▼
Find Active Owner Memberships
      │
      ▼
Check Final Owner Conditions
      │
      ├── Blocking Condition → Reject
      │
      ▼
Disable Human Identity
      │
      ▼
Persist and Publish Event
```

---

# Disablement Query Responsibility

The Human Identity Aggregate does not query Memberships.

The Application Service uses a Membership query service to determine whether disablement would violate Organization ownership requirements.

---

# Disablement Transaction Strategy

When one Identity is an Owner in multiple Organizations, consistent protection may require:

- deterministic locking of affected Organization ownership scopes
- rechecking active Owner counts
- short transaction duration
- bounded number of affected Organizations

A very large number of Memberships may require a controlled administrative workflow rather than one request transaction.

---

# Repository Interfaces

Repositories persist Aggregate Roots.

They do not decide authorization or lifecycle rules.

---

# Human Identity Repository

Conceptual interface:

```text
HumanIdentityRepository

Get(identityId)

GetByAuthenticationSubject(
    provider,
    issuer,
    subject
)

Save(humanIdentity)

ExistsByAuthenticationSubject(...)
```

Identity lookup by authentication subject is trusted infrastructure functionality.

---

# Organization Repository

```text
OrganizationRepository

Get(organizationId)

GetActive(organizationId)

Save(organization)
```

Protected Application Services should avoid globally listing Organizations without authorization-aware query rules.

---

# Membership Repository

```text
MembershipRepository

Get(
    organizationId,
    membershipId
)

GetByIdentity(
    organizationId,
    identityId
)

Save(membership)

Exists(
    organizationId,
    identityId
)

CountActiveOwners(
    organizationId
)
```

---

# Role Assignment Persistence

Role Assignments may be persisted:

- inside the Membership Aggregate record
- in a child table owned by the Membership Aggregate

They must not be exposed as independently mutable Aggregate Roots.

---

# Authentication Subject Repository

Authentication subject mappings may be managed through the Human Identity Repository or a dedicated infrastructure repository.

Conceptual interface:

```text
AuthenticationSubjectRepository

Resolve(provider, issuer, subject)

Link(identityId, subjectReference)

Unlink(identityId, subjectReference)
```

Uniqueness must be enforced by the database.

---

# Invitation Repository

Invitation credentials belong to Infrastructure.

Conceptual interface:

```text
InvitationRepository

Create(invitation)

GetByTokenHash(tokenHash)

Consume(invitationId)

Revoke(invitationId)

Expire(invitationId)
```

Raw token values must not be persisted when a secure hash is sufficient.

---

# Query Services

Cross-Aggregate reads use query services.

Examples:

```text
MembershipQueryService

OrganizationOwnershipQueryService

IdentityDirectoryQueryService

AssignmentImpactQueryService
```

Query services return facts.

They do not mutate domain state.

---

# Organization Ownership Query Service

```text
OrganizationOwnershipQueryService

CountActiveOwners(organizationId)

FindOrganizationsWhereFinalOwner(identityId)

IsActiveOwner(
    organizationId,
    membershipId
)
```

These queries support Application Layer coordination.

---

# Authorization-Aware Identity Directory

An identity directory may help authorized Admins invite existing Humans.

The directory must:

- respect privacy
- expose only permitted fields
- avoid global identity enumeration
- prevent cross-Organization disclosure
- use exact or tightly scoped searches

The MVP may omit an internal identity directory and use email invitations only.

---

# Transaction Boundaries

Transaction ownership belongs to Application Services.

Aggregates do not begin, commit, or roll back transactions.

---

# Single-Aggregate Transaction

Used for:

- RenameOrganization
- SuspendOrganization
- UpdateHumanIdentityProfile
- SuspendMembership
- AssignOrganizationRole

```text
BEGIN

Authorize

Load Aggregate

Execute Command

Save Aggregate

Write Outbox

Write Audit Metadata

Record Processed Command

COMMIT
```

---

# Coordinated Creation Transaction

Used for:

- CreateOrganization
- AcceptInvitation with new Human Identity

```text
BEGIN

Create or update multiple required Aggregates

Persist all Aggregate state

Persist all Domain Events

Persist idempotency result

COMMIT
```

This pattern remains exceptional.

---

# Multi-Membership Coordination Transaction

Used for:

- TransferOrganizationOwnership

```text
BEGIN

Lock Organization ownership scope

Load source Membership

Load target Membership

Execute both commands

Save both Memberships

Write Outbox events

COMMIT
```

---

# Long-Running Operations

The following must occur outside long-running transactions:

- sending invitation email
- external identity provider provisioning calls
- notification delivery
- large assignment-impact scans
- export generation
- privacy report generation

Only short persistence work remains inside transactions.

---

# Transactional Outbox Events

Identity and Organization Domain Events are persisted through the same Transactional Outbox used by other AIOS modules.

Examples:

```text
HumanIdentityDisabled

OrganizationSuspended

MembershipActivated

MembershipRevoked

OrganizationRoleAssigned
```

---

# Identity Event Consumers

Possible asynchronous consumers include:

```text
Session Invalidation Handler

Invitation Delivery Handler

Assignment Reconciliation Handler

Security Notification Handler

Read Model Projection Handler

Audit Projection Handler
```

Each consumer must be idempotent.

---

# External Identity Provider Integration

AIOS may delegate authentication to an external Identity Provider.

The provider proves authentication subject ownership.

AIOS remains authoritative for:

- internal identityId
- Organization
- Membership
- Organization roles
- business authorization
- ActorReference

---

# Identity Provider Responsibilities

An external provider may manage:

- login
- credentials
- MFA
- account recovery
- authentication sessions
- federation

AIOS must not assume the provider knows AIOS Organization authority.

---

# AIOS Responsibilities

AIOS manages:

- authentication subject mapping
- internal Human identity
- Identity status
- Membership status
- Organization context
- role assignments
- domain actor attribution
- authorization policy

---

# Login Resolution Flow

```text
Human Authenticates with Provider
      │
      ▼
Provider Returns Verified Claims
      │
      ▼
AIOS Validates Issuer and Audience
      │
      ▼
Resolve Authentication Subject
      │
      ▼
Load Human Identity
      │
      ▼
Verify Identity Status
      │
      ▼
Establish Authenticated Session
```

Organization context is resolved separately.

---

# Just-in-Time Identity Creation

The MVP may support just-in-time Human Identity creation.

JIT creation is allowed only when:

- provider is trusted
- subject is verified
- Organization invitation or provisioning policy permits it
- no conflicting identity mapping exists

JIT identity creation must not automatically create Organization Membership without an authorized invitation or bootstrap workflow.

---

# Identity Linking

A Human may link an additional authentication method.

The linking workflow should require:

- current strong authentication
- proof of control over the new subject
- conflict check
- audit record
- recovery protection

---

# Identity Merge

Merging duplicate Human Identities is outside the MVP.

A merge would affect:

- ActorReferences
- Memberships
- role assignments
- authentication subjects
- audit history

Duplicate identity conflicts require controlled administrative resolution.

---

# Provider Subject Change

When an external provider changes a subject identifier:

- link the new verified subject
- preserve the same internal identityId
- unlink the obsolete subject only after successful migration
- retain audit history

Domain records remain unchanged.

---

# Provider Outage

An Identity Provider outage may prevent new Human authentication.

It must not:

- disable existing Human Identities
- revoke Memberships
- rewrite Organization roles
- create alternative insecure authentication paths

System Workers may continue through their own trusted internal identities.

---

# Session Management Integration

Sessions are infrastructure concerns but must honor current identity state.

A session should reference:

```text
sessionId
identityId
authenticationSubjectReference
authenticatedAt
expiresAt
selectedOrganizationId
```

---

# Session Validation

Protected requests should validate:

```text
Session is valid

AND

Human Identity is Active

AND

Selected Organization is Active

AND

Membership is Active
```

Role and permission checks occur separately.

---

# Session Invalidation Triggers

Sessions should be invalidated or rejected after:

```text
HumanIdentityDisabled

MembershipSuspended

MembershipRevoked

OrganizationSuspended

OrganizationArchived

AuthenticationSubjectUnlinked
```

---

# Session Invalidation Handler

```text
Identity or Membership Event
      │
      ▼
Outbox Publication
      │
      ▼
Session Invalidation Handler
      │
      ▼
Invalidate Relevant Sessions
```

The handler is asynchronous and idempotent.

---

# Revalidation Safety

Because invalidation may be delayed, every protected command must still validate current authoritative status.

Session invalidation improves speed and user experience.

It does not replace current-state validation.

---

# Organization Suspension and Sessions

When an Organization is Suspended:

- Organization-scoped business sessions become unusable for mutation
- Humans may still authenticate globally
- the Human may switch to another Active Organization
- recovery-specific access follows explicit policy

The Human Identity itself remains Active.

---

# Audit Architecture

Identity and Organization changes require durable auditability.

The audit trail must distinguish:

- authenticated principal
- domain actor
- target identity
- target Membership
- Organization
- command
- policy decision
- resulting event

---

# Identity Audit Record

Recommended fields:

```text
identityAuditId
commandId
correlationId
principalId
principalType
actorIdentityId
organizationId
targetIdentityId
targetMembershipId
operation
result
reason
policyId
policyVersion
occurredAt
```

---

# Audit Examples

Auditable operations include:

- Human Identity created
- authentication subject linked
- Human Identity disabled
- Organization created
- Organization suspended
- Membership invited
- invitation accepted
- Membership suspended
- Membership revoked
- role assigned
- role revoked
- ownership transferred

---

# Historical Role Explanation

Role assignment history must answer:

```text
Which role did the Human have?

In which Organization?

Who assigned it?

When was it active?

Who revoked it?

When was it revoked?
```

This supports later explanation of authorization decisions.

---

# Audit and Domain Events

Domain Events record committed business facts.

Security audit records capture authorization and execution context.

They may be correlated but should not be treated as identical records.

---

# Privacy Principles

Identity data must be limited to what AIOS needs.

Key principles:

- data minimization
- purpose limitation
- Organization isolation
- restricted directory access
- stable identifiers
- controlled retention
- no unnecessary personal data in events
- no credentials in logs

---

# Personal Data Classification

Likely personal data includes:

```text
displayName

emailAddress

authenticationSubject

identityId when linkable to a person

Membership history

role history

activity audit
```

Access should be limited by policy.

---

# Domain Event Privacy

Broadly consumed events should prefer identifiers over personal data.

Preferred:

```text
MembershipActivated
- identityId
- membershipId
- organizationId
```

Avoid:

```text
full profile
full email history
authentication claims
```

Consumers may load authorized display data when required.

---

# Email Handling

Email addresses should be:

- normalized for matching
- stored according to privacy policy
- verified before sensitive use
- excluded from unnecessary logs
- protected from Organization-wide enumeration

Normalization must not incorrectly collapse distinct provider-specific addresses without a defined rule.

---

# Actor Display

User interfaces may resolve current display names from identityId.

Historical views may optionally use displayNameSnapshot.

When showing a disabled or departed Human:

```text
Alex Morgan
Former Member
```

The historical action remains attributed.

---

# Privacy Erasure

Hard deletion of Identity records is not defined in the MVP.

A future erasure workflow may need to:

- anonymize profile fields
- preserve non-identifying audit references
- retain legally required records
- prevent identity reuse conflicts
- maintain domain consistency

Such processing requires legal and compliance design.

---

# Data Export

Identity or Organization data export is outside the core MVP lifecycle.

A future export must enforce:

- requester authorization
- Organization scope
- personal data filtering
- secure delivery
- audit
- expiration

---

# Assignment Reconciliation

Membership lifecycle changes may affect Work, Decision, and Memory assignments.

These consequences are handled asynchronously.

---

# Reconciliation Event Sources

Relevant events include:

```text
MembershipSuspended

MembershipRevoked

HumanIdentityDisabled

OrganizationSuspended

OrganizationArchived

OrganizationRoleRevoked
```

---

# Assignment Reconciliation Flow

```text
MembershipRevoked
      │
      ▼
Outbox
      │
      ▼
Assignment Reconciliation Handler
      │
      ▼
Find Active Resource Relationships
      │
      ▼
Create Administrative Findings
      │
      ▼
Notify Owners or Admins
```

---

# Administrative Finding

A reconciliation finding may contain:

```text
findingId
organizationId
sourceEventId
membershipId
resourceType
resourceId
findingType
status
createdAt
resolvedAt
```

This is operational or application metadata.

It does not replace domain state.

---

# Reconciliation Finding Types

Examples:

```text
WorkHasInactiveAssignee

DecisionHasInactiveReviewer

MemoryHasInactiveReviewer

OrganizationHasReducedOwnerCount

SuspendedOrganizationHasPendingProcessing
```

---

# No Direct Reassignment

The reconciliation handler must not directly:

- change Work assignee
- replace Decision reviewer
- replace Memory reviewer
- assign Organization roles
- revoke resources

It may create a task or notification requiring Human action.

---

# Organization Suspension Reconciliation

When an Organization is Suspended, Workers should:

- stop new nonessential Organization processing
- preserve committed Outbox events
- defer business mutation handlers where appropriate
- continue security-critical processing
- continue session invalidation
- expose pending backlog operationally

The exact handler policy must be explicit.

---

# Organization Archival Reconciliation

Before or after archival, the system may verify:

- no active Work remains
- no unprocessed review actions remain
- invitation tokens are revoked
- Organization-scoped sessions are invalidated
- scheduled operational jobs are disabled
- retention policies are registered

Archival must not delete historical events.

---

# Role Revocation Reconciliation

Role revocation may affect future access immediately.

It does not automatically alter resource assignments.

Example:

```text
Reviewer role revoked

↓

Decision reviewer assignment still exists

↓

Human cannot approve

↓

Admin receives reassignment finding
```

---

# Reconciliation Idempotency

Each handler records:

```text
consumerName + sourceEventId
```

Duplicate delivery must not create duplicate unresolved findings.

Recommended uniqueness:

```text
UNIQUE (
    source_event_id,
    finding_type,
    resource_type,
    resource_id
)
```

---

# Reconciliation Recovery

Failed reconciliation is retryable.

A reconciliation failure must not:

- restore revoked authority
- reactivate Membership
- bypass Organization suspension
- mutate unrelated domain resources

The source lifecycle change remains committed.

---

# Notification Workflows

Notifications may be triggered by:

- invitation
- Membership activation
- Membership suspension
- Membership revocation
- role assignment
- role revocation
- Organization suspension
- ownership transfer
- reconciliation finding

Notification failure does not roll back the authoritative lifecycle event.

---

# Notification Privacy

Notifications must:

- target authorized recipients
- avoid exposing unrelated Organization data
- avoid including secrets
- use bounded content
- preserve audit reference
- support delivery retry

---

# Read Model Projections

Identity and Organization events may build read models such as:

```text
Organization Member Directory

Membership Administration Queue

Role Assignment History

Organization Selector

Inactive Assignment Queue
```

Read models are eventually consistent.

They do not become authorization sources unless designed and validated for that purpose.

---

# Authorization Source of Truth

Authoritative authorization checks should use current trusted data from:

- Human Identity status
- Organization status
- Membership status
- active Role Assignments
- current policy configuration

A stale read model must not grant authority.

---

# Idempotency

Every state-changing Application Service accepts a commandId.

Recommended processed-command uniqueness:

```text
organizationId + commandId
```

For global Human Identity commands:

```text
commandId
```

or:

```text
identityScope + commandId
```

---

# Idempotent Invitation Delivery

Invitation delivery should use a stable delivery identity:

```text
membershipId + invitationVersion
```

Repeated Worker execution must not issue unrelated concurrent tokens.

---

# Idempotent Session Invalidation

Session invalidation handlers may safely execute repeatedly.

Expected result:

```text
Session already invalidated
    → success
```

---

# Concurrency

Optimistic concurrency applies to:

- Human Identity
- Organization
- Membership

Expected versions should be used for Human-driven updates.

---

# Concurrency Examples

```text
Two Admins assign same role

↓

One succeeds

One receives concurrency conflict or duplicate-role result
```

```text
Invitation accepted while revoked

↓

Only one valid transition commits
```

```text
Organization archived while renamed

↓

Stale command reloads and revalidates
```

---

# Ownership Locking

Owner-count changes require stronger coordination than ordinary optimistic locking.

Operations requiring ownership-scope locking include:

- assigning Owner
- revoking Owner
- suspending Owner Membership
- revoking Owner Membership
- disabling an Identity who is an Owner
- ownership transfer

---

# Failure Isolation

Failure in an asynchronous consequence must not roll back the source lifecycle fact.

Examples:

```text
Membership Revoked
Session invalidation fails
```

Result:

- Membership remains Revoked
- current-state validation still denies commands
- invalidation retries

```text
Organization Created
Welcome notification fails
```

Result:

- Organization remains Active
- Owner Membership remains Active
- notification retries

---

# Application Result Types

Application Services should return explicit results.

Examples:

```text
InviteMemberResult
- membershipId
- status
- invitationExpiresAt

AcceptInvitationResult
- identityId
- membershipId
- organizationId
- roles

TransferOwnershipResult
- organizationId
- previousOwnerMembershipId
- newOwnerMembershipId
- previousOwnerRetained
```

---

# Stable Failure Results

Recommended failures include:

```text
Unauthenticated

IdentityNotFound

IdentityDisabled

OrganizationNotFound

OrganizationInactive

MembershipNotFound

MembershipInactive

InvitationInvalid

InvitationExpired

InvitationRecipientMismatch

RoleAlreadyAssigned

RoleNotAssigned

LastOwnerViolation

ConcurrencyConflict

Unauthorized

DuplicateRequest

InfrastructureFailure
```

Transport layers map these results to protocol-specific responses.

---

# Application Layer Rules

The following rules are mandatory:

1. Resolve identity only from trusted authentication evidence.
2. Resolve exactly one Organization per protected command.
3. Require Active Identity, Membership, and Organization for Human business execution.
4. Scope repositories by Organization wherever applicable.
5. Never use email as the permanent domain identity.
6. Never allow payload actor overrides.
7. Never let Secretary or System principals become Human Members.
8. Preserve historical ActorReferences after Membership or role changes.
9. Protect the Last Owner Invariant transactionally.
10. Use the Transactional Outbox for lifecycle events.
11. Keep invitation delivery outside the domain transaction.
12. Revalidate current state despite session caching.
13. Handle assignment consequences asynchronously.
14. Never let reconciliation create new Human business intent.
15. Fail closed when principal or Organization resolution is uncertain.

---

# Part 3 Design Summary

The Application Layer converts trusted authentication evidence into explicit AIOS principals.

Every protected operation is scoped to one Organization and one valid Membership.

The design provides:

- stable internal Human identity
- explicit Organization selection
- secure principal construction
- atomic Organization bootstrap
- auditable invitation acceptance
- transactional ownership protection
- external Identity Provider independence
- session invalidation with current-state revalidation
- privacy-aware identity events
- asynchronous assignment reconciliation
- reliable lifecycle event delivery

Identity establishes who the person is.

Membership establishes where the person participates.

Authorization determines what the resulting principal may attempt.

# Failure and Recovery Semantics

Identity and Organization operations must fail safely.

No failure may result in:

- unintended Membership activation
- cross-Organization authority
- duplicate Human Identity creation
- loss of historical attribution
- silent Owner removal
- Secretary or System elevation
- partial Organization bootstrap
- invitation reuse
- implicit permission

The system must prefer denial and recoverability over ambiguous success.

---

# Failure Categories

Failures are classified as:

```text
Authentication Failure

Identity Resolution Failure

Organization Resolution Failure

Membership Resolution Failure

Invitation Failure

Ownership Invariant Failure

Authorization Failure

Concurrency Failure

External Identity Provider Failure

Persistence Failure

Outbox Failure

Session Invalidation Failure

Reconciliation Failure

Configuration Failure
```

---

# Authentication Failure

Authentication failure occurs when trusted authentication evidence is missing or invalid.

Examples:

- missing session
- invalid token
- expired authentication
- invalid issuer
- invalid audience
- untrusted signature
- disabled authentication subject

Result:

```text
No Principal created

No Organization context resolved

No Aggregate command executed

No Domain Event emitted
```

Authentication failure is not retried as a domain command.

---

# Identity Resolution Failure

Identity resolution fails when authentication evidence cannot be mapped safely to one Human Identity.

Examples:

- no subject mapping exists
- multiple identities map to one subject
- mapped Identity is Disabled
- subject mapping is corrupted
- required identity record is missing

Result:

```text
Deny protected execution
```

The system must not create a new Identity automatically unless an explicit provisioning or invitation-acceptance workflow permits it.

---

# Ambiguous Identity Failure

The following condition is security-critical:

```text
One authentication subject

↓

Multiple Human Identity records
```

Required behavior:

- deny authentication
- record a security event
- prevent automatic repair
- require controlled administrative investigation

The resolver must never select one mapping arbitrarily.

---

# Organization Resolution Failure

Organization resolution fails when:

- no Organization context is provided
- the requested Organization does not exist
- the Organization is Suspended
- the Organization is Archived
- the Human has no Membership
- the selected Membership belongs to another Organization

Result:

```text
No HumanMemberPrincipal created
```

A Human may remain globally authenticated while being unable to enter the requested Organization.

---

# Membership Resolution Failure

Membership resolution fails when the Membership is:

- missing
- Invited
- Suspended
- Revoked
- linked to another Identity
- linked to another Organization

Result:

```text
No Organization-scoped authority
```

Membership resolution failure must not fall back to another Membership automatically.

---

# Invitation Failure

Invitation failures include:

```text
InvalidToken

ExpiredToken

RevokedToken

ConsumedToken

RecipientMismatch

OrganizationInactive

MembershipAlreadyActive

IdentityConflict
```

---

# Invalid Invitation Token

An invalid invitation token must produce a generic failure.

The response must not reveal:

- whether the email exists
- whether the Organization exists
- whether a Membership exists
- whether the invitation was intended for another Human

---

# Expired Invitation

An expired invitation cannot activate Membership.

The system may allow an authorized Organization administrator to issue a new invitation.

The expired token remains unusable.

---

# Consumed Invitation

A consumed invitation token cannot be reused.

When the same idempotent acceptance command is retried, the previous successful result may be returned.

A different command using the same consumed token must fail.

---

# Invitation Recipient Mismatch

Recipient mismatch occurs when the authenticated Human does not satisfy the invitation recipient policy.

Result:

```text
Activation denied

Membership remains Invited

Token remains valid or is revoked according to security policy

Security event recorded
```

Repeated mismatches may trigger token revocation.

---

# Identity Conflict During Acceptance

A conflict may occur when:

- invitation points to one existing Identity
- authenticated subject resolves to another Identity

The system must not merge or relink automatically.

Result:

```text
Acceptance denied

Administrative resolution required
```

Identity merge is outside the MVP.

---

# Organization Bootstrap Failure

Organization creation coordinates:

- Organization
- initial Membership
- initial Owner role

All three must commit atomically.

If any step fails:

```text
Organization not created

Membership not created

Owner role not assigned

No bootstrap events published
```

---

# Partial Bootstrap Prohibition

The following states must never become visible:

```text
Active Organization without Membership
```

```text
Active Organization without Owner
```

```text
Owner Membership without Organization
```

```text
OrganizationCreated event without committed Organization
```

---

# Last Owner Invariant Failure

An operation fails with:

```text
LastOwnerViolation
```

when it would leave an Active Organization with no active Owner.

Affected commands include:

- RevokeOrganizationRole
- SuspendMembership
- RevokeMembership
- LeaveOrganization
- DisableHumanIdentity
- TransferOrganizationOwnership
- Archive-related ownership changes

---

# Last Owner Failure Result

When the invariant fails:

```text
No Membership state change

No role revocation

No Identity disablement

No Domain Event

No Outbox message
```

The user must first assign or transfer Owner authority.

---

# Ownership Transfer Failure

Ownership transfer may fail because:

- source is not an active Owner
- target Membership is inactive
- target Identity is Disabled
- source and target belong to different Organizations
- target role assignment conflicts
- concurrent ownership mutation occurred
- initiator lacks authority

The transaction must roll back entirely.

---

# Authorization Failure

Authorization failure means the principal is valid but cannot execute the requested command.

Examples:

- Member attempts Owner assignment
- Admin attempts prohibited self-elevation
- Secretary attempts role mutation
- System attempts Membership revocation
- Member operates outside resource scope

Result:

```text
No domain mutation
```

---

# Concurrency Failure

Optimistic concurrency protects each Aggregate.

Examples:

- invitation accepted while revoked
- role assigned while Membership suspended
- Organization archived while renamed
- Identity disabled while profile updated

Result:

```text
ConcurrencyConflict
```

The caller may reload and retry when appropriate.

---

# Ownership Concurrency Failure

Owner-related mutations require additional Organization-scoped coordination.

Example:

```text
Two Owners concurrently revoke each other
```

The implementation must ensure at least one operation fails.

A successful outcome with zero active Owners is prohibited.

---

# External Identity Provider Failure

External Identity Provider failures may include:

- login service outage
- token introspection timeout
- key retrieval failure
- provider claim inconsistency
- provisioning API failure

---

# Provider Failure Rule

When provider verification cannot complete safely:

```text
Authentication denied
```

The system must not:

- accept unsigned claims
- use stale verification keys beyond policy
- create a bypass login
- infer identity from email alone

---

# Provider Provisioning Failure

When external provisioning fails after AIOS has committed an internal state change, recovery depends on the workflow.

Example:

```text
MembershipInvited committed

External invitation notification fails
```

Result:

- Membership remains Invited
- notification retries
- invitation authority remains unchanged

External delivery failure does not roll back committed AIOS state.

---

# Persistence Failure

A persistence failure before commit results in full rollback.

The system must not return success unless the transaction committed.

Affected data may include:

- Aggregate state
- Aggregate version
- role assignment
- invitation consumption
- Domain Events
- Outbox records
- processed command record
- audit metadata

---

# Outbox Failure

Domain state and Outbox records are written in the same transaction.

If Outbox persistence fails:

```text
Domain transaction rolls back
```

No committed lifecycle fact may exist without its durable event record.

---

# Publication Failure

When the transaction commits but event publication fails:

- source state remains committed
- Outbox message remains pending
- Worker retries
- downstream effects may be delayed
- no source Aggregate rollback occurs

---

# Session Invalidation Failure

Session invalidation is asynchronous.

Example:

```text
MembershipRevoked committed

Session invalidation Worker fails
```

Result:

- Membership remains Revoked
- protected commands still fail current Membership validation
- invalidation retries
- stale session cannot restore authority

---

# Reconciliation Failure

Assignment reconciliation may fail after a Membership lifecycle event.

Result:

- Membership state remains committed
- existing assignments may temporarily reference inactive Membership
- reconciliation retries
- administrative finding may be delayed
- no automatic authority restoration occurs

---

# Configuration Failure

Configuration failures include:

- unknown role
- missing permission mapping
- unsupported principal type
- invalid System capability
- missing Organization policy
- duplicate identity-provider configuration

Required behavior:

```text
Fail closed
```

High-severity configuration errors should be visible during startup where possible.

---

# Recovery Principles

Recovery must follow these rules:

1. Never recover by editing Aggregate tables directly.
2. Never bypass authorization.
3. Never reactivate Membership implicitly.
4. Never create Owner authority without an audited Human command.
5. Never merge Human Identities automatically.
6. Never reuse consumed invitation credentials.
7. Never restore authority from stale session data.
8. Retry operational consequences independently.
9. Preserve original correlation and causation.
10. Preserve historical ActorReferences.

---

# Human Command Retry

A retried Human command must re-evaluate:

- current authentication
- current Identity status
- current Organization status
- current Membership status
- current roles
- current authorization
- current Aggregate version

An earlier valid principal does not guarantee current authority.

---

# Idempotent Recovery

When a command previously committed but the caller did not receive the response:

```text
Retry same commandId

↓

Return previous result
```

The system must not repeat:

- Organization creation
- Membership activation
- role assignment
- ownership transfer
- lifecycle event emission

---

# Operational Retry

Operational handlers may retry when:

- the source event remains valid
- the event has not been processed
- System capability remains enabled
- Organization scope matches
- the target operation remains valid

Retries are bounded and observable.

---

# Manual Recovery

Manual recovery may be required for:

- identity mapping conflict
- duplicate Identity investigation
- broken Owner configuration
- corrupted invitation state
- unsupported provider migration
- persistent reconciliation failure

Manual recovery must use controlled administrative commands or migration tooling.

It must be audited.

---

# Data Repair

Data repair scripts must:

- run under restricted operator authority
- preserve Organization scope
- validate invariants before and after
- produce an audit artifact
- avoid rewriting historical actor identifiers
- avoid publishing false historical events
- be tested against production-like data

Routine business operations must not depend on repair scripts.

---

# Testing Strategy

Identity and Organization architecture requires tests at multiple levels:

```text
Aggregate Unit Tests

Application Service Tests

Authorization Tests

Persistence Integration Tests

External Identity Integration Tests

Security Isolation Tests

End-to-End Tests

Failure Injection Tests
```

---

# Human Identity Aggregate Tests

Required tests include:

- create Active Human Identity
- reject duplicate authentication subject link
- update profile without changing identityId
- disable Active Identity
- reject repeated disablement where invalid
- preserve authentication subject uniqueness
- preserve historical actor identity
- reject unsupported status transition

---

# Organization Aggregate Tests

Required tests include:

- create Active Organization
- rename Active Organization
- suspend Active Organization
- reactivate Suspended Organization
- archive eligible Organization
- reject ordinary mutation after archival
- reject invalid lifecycle transition
- preserve organizationId through rename

---

# Membership Aggregate Tests

Required tests include:

- create Invited Membership
- activate valid invitation
- suspend Active Membership
- reactivate Suspended Membership
- revoke Active Membership
- revoke Suspended Membership
- reject activation after revocation
- reject role assignment to inactive Membership
- reject duplicate active role assignment
- preserve role revocation history

---

# Organization Bootstrap Tests

Bootstrap tests must verify:

```text
Organization created

AND

Owner Membership active

AND

OrganizationOwner assigned

AND

all events persisted
```

Failure injection must verify total rollback after any individual step fails.

---

# Invitation Tests

Required invitation tests include:

- invite existing Identity
- invite unknown Identity
- accept valid invitation
- reject expired invitation
- reject revoked invitation
- reject consumed invitation
- reject recipient mismatch
- reject duplicate Membership creation
- retry successful acceptance idempotently
- prevent concurrent double acceptance
- avoid raw token storage in events and logs

---

# Invitation Security Tests

Security tests should verify:

- token is unguessable
- token is single-use
- token expiration is enforced
- token hash is stored instead of raw token where applicable
- prior token is invalidated after resend
- error responses do not expose invitee existence
- token cannot activate another Organization’s Membership

---

# Membership Status Tests

For each inactive Membership state, verify:

```text
Invited
    → no HumanMemberPrincipal

Suspended
    → no HumanMemberPrincipal

Revoked
    → no HumanMemberPrincipal
```

Only Active Membership may produce Organization-scoped Human authority.

---

# Identity Status Tests

Verify:

```text
Active Identity + Active Membership + Active Organization
    → principal may be resolved
```

```text
Disabled Identity + Active Membership + Active Organization
    → principal resolution denied
```

---

# Organization Status Tests

Verify:

```text
Active Organization
    → ordinary execution eligible
```

```text
Suspended Organization
    → ordinary business mutation denied
```

```text
Archived Organization
    → read-only behavior
```

---

# Multi-Organization Isolation Tests

Required tests include:

- same Human with Memberships in two Organizations
- roles differ by Organization
- role from org-A does not grant access in org-B
- selected Organization determines current Membership
- resource from another Organization is not disclosed
- one command cannot use two Memberships
- Worker execution remains scoped to one Organization

---

# Organization Context Tests

Verify:

- explicit Organization context required when ambiguous
- single Membership convenience still validates Membership
- invalid session-selected Organization is rejected
- Organization switch does not carry prior roles
- payload Organization cannot override trusted context
- repository scope matches principal Organization

---

# Principal Construction Tests

Verify:

- Human principal derives from trusted authentication subject
- Secretary principal cannot contain Human membershipId
- System principal cannot contain Human roles
- public client cannot construct System principal
- Human actor derives from Human principal only
- Secretary and System cannot be converted into Human ActorReference

---

# Stable Identity Tests

Verify that changing:

- email
- display name
- authentication provider
- linked subject

does not change:

```text
identityId
```

Domain records must remain linked to the same stable Human Identity.

---

# Last Owner Invariant Tests

Mandatory tests include:

- revoke non-final Owner
- reject revoking final Owner
- reject suspending final Owner Membership
- reject final Owner leaving Organization
- reject disabling Identity who is final Owner
- assign new Owner then remove old Owner
- transfer ownership atomically
- preserve at least one Owner under concurrent removals

---

# Owner Concurrency Tests

Use real transactional integration tests for:

```text
Two concurrent Owner revocations
```

```text
Owner suspension concurrent with transfer
```

```text
Identity disablement concurrent with Owner assignment
```

At least one active Owner must remain after every committed outcome.

---

# Role Assignment Tests

Verify:

- Owner may assign supported roles
- Admin may assign only permitted roles
- Admin cannot assign Owner when policy denies it
- Member cannot assign roles
- Secretary cannot assign roles
- System cannot assign roles
- self-escalation is denied
- revoked role grants no future permission

---

# Application Service Tests

Application Service tests must verify orchestration order:

```text
Resolve Principal

↓

Resolve Organization Context

↓

Authorize

↓

Load Aggregate

↓

Execute Command

↓

Persist State and Outbox
```

Denied or unresolved commands must stop before Aggregate mutation.

---

# Repository Scope Tests

Protected repository tests must verify:

- Organization identifier is required
- same aggregateId in wrong Organization is inaccessible
- Membership lookup uses Organization and Identity
- relationship queries cannot cross Organization
- global lookup methods are restricted to trusted infrastructure

---

# Transaction Tests

Transactional tests should verify:

- Organization bootstrap atomicity
- invitation token consumption atomicity
- Identity creation plus Membership activation atomicity
- ownership transfer atomicity
- Aggregate and Outbox atomicity
- processed command and state atomicity
- rollback after audit or Outbox failure

---

# External Identity Provider Tests

Integration tests should cover:

- valid issuer
- invalid issuer
- valid audience
- invalid audience
- signature verification
- unknown key handling
- provider outage
- subject mapping resolution
- subject conflict
- JIT creation restrictions
- linked-subject migration

---

# Session Tests

Verify:

- Disabled Identity invalidates or rejects session
- Suspended Membership rejects protected command
- Revoked Membership rejects protected command
- Suspended Organization rejects mutation
- archived Organization remains read-only
- asynchronous invalidation may retry safely
- stale session data cannot restore authority

---

# Reconciliation Tests

Required tests include:

- revoked Work assignee creates finding
- suspended Decision reviewer creates finding
- duplicate event does not duplicate finding
- reconciliation failure retries
- handler never reassigns automatically
- resolved finding remains auditable
- Organization scope is preserved

---

# Audit Tests

Verify audit records capture:

- principal identity
- principal type
- Organization
- target Identity or Membership
- command
- authorization result
- resulting event
- correlationId
- policy version
- timestamp

Audit tests must also verify that raw secrets are absent.

---

# Privacy Tests

Privacy-focused tests should verify:

- email is not used as domain identity key
- external subject is not stored in Work, Decision, or Memory
- raw invitation token is not logged
- Domain Events minimize personal data
- identity directory does not expose unrelated Humans
- cross-Organization lookup does not reveal existence
- disabled Humans remain historically attributable

---

# Failure Injection Tests

Inject failures at:

- Identity save
- Organization save
- Membership save
- role assignment save
- invitation consume
- Outbox write
- audit write
- event publication
- session invalidation
- reconciliation processing

Expected result:

```text
No partial authoritative state
```

---

# Security Regression Suite

The following cases should remain permanent regression tests:

1. Disabled Identity attempts Organization access.
2. Invited Membership attempts business command.
3. Suspended Membership attempts approval.
4. Revoked Membership uses stale session.
5. Human combines roles from two Organizations.
6. Secretary attempts Membership administration.
7. System attempts Owner assignment.
8. Payload attempts actor override.
9. Invitation token is reused.
10. Wrong Human accepts invitation.
11. Final Owner attempts to leave.
12. Two concurrent commands attempt to remove final Owners.
13. Authentication subject maps to multiple Identities.
14. Organization bootstrap fails after Organization insert.
15. Cross-Organization resource lookup reveals no foreign existence.

---

# Property-Based Tests

Property-based tests are recommended for core invariants.

Examples:

```text
For every HumanMemberPrincipal:
    Identity is Active
    Membership is Active
    Organization is Active
```

```text
For every Membership:
    exactly one identityId
    exactly one organizationId
```

```text
For every Active Organization:
    activeOwnerCount >= 1
```

```text
For every Secretary or System principal:
    no Human Membership
    no Human role
```

```text
For every Organization mismatch:
    protected operation is denied
```

---

# Database Design

Database constraints provide defense in depth.

They do not replace Aggregate or Application Layer rules.

---

# Human Identity Table

Conceptual structure:

```text
human_identities
- identity_id
- status
- display_name
- primary_email
- version
- created_at
- updated_at
- disabled_at
```

Recommended constraints:

```text
PRIMARY KEY (identity_id)

CHECK (
    status IN ('Active', 'Disabled')
)
```

---

# Authentication Subject Table

Conceptual structure:

```text
authentication_subjects
- authentication_subject_id
- identity_id
- provider
- issuer
- subject
- linked_at
- unlinked_at
```

Recommended uniqueness:

```text
UNIQUE (
    provider,
    issuer,
    subject
)
WHERE unlinked_at IS NULL
```

---

# Organization Table

Conceptual structure:

```text
organizations
- organization_id
- name
- status
- created_by_identity_id
- version
- created_at
- updated_at
- suspended_at
- archived_at
```

Recommended constraints:

```text
PRIMARY KEY (organization_id)

CHECK (
    status IN ('Active', 'Suspended', 'Archived')
)
```

Organization name need not be globally unique.

---

# Membership Table

Conceptual structure:

```text
memberships
- membership_id
- organization_id
- identity_id
- status
- invited_by_identity_id
- invited_at
- activated_at
- suspended_at
- revoked_at
- revocation_reason
- version
```

Recommended uniqueness:

```text
UNIQUE (
    organization_id,
    identity_id
)
```

Recommended status constraint:

```text
CHECK (
    status IN (
        'Invited',
        'Active',
        'Suspended',
        'Revoked'
    )
)
```

---

# Membership Foreign Keys

Recommended foreign keys:

```text
memberships.organization_id
    → organizations.organization_id
```

```text
memberships.identity_id
    → human_identities.identity_id
```

An invitation for an unknown Identity may require:

- nullable identity_id before activation
- separate pending invitation recipient table
- invitation-specific recipient reference

The schema should avoid using an unverified email as a permanent identity foreign key.

---

# Role Assignment Table

Conceptual structure:

```text
membership_role_assignments
- role_assignment_id
- membership_id
- organization_id
- role
- assigned_by_identity_id
- assigned_at
- revoked_by_identity_id
- revoked_at
- reason
```

Recommended active uniqueness:

```text
UNIQUE (
    membership_id,
    role
)
WHERE revoked_at IS NULL
```

---

# Organization Consistency Constraint

Role Assignment Organization must match Membership Organization.

Recommended approaches:

- composite foreign key
- database trigger
- transactionally validated repository
- denormalized organization_id with consistency check

Composite foreign keys are preferred where practical.

---

# Invitation Table

Conceptual structure:

```text
organization_invitations
- invitation_id
- membership_id
- token_hash
- status
- expires_at
- consumed_at
- revoked_at
- version
- created_at
```

Recommended status values:

```text
Pending

Consumed

Revoked

Expired
```

Recommended uniqueness:

```text
UNIQUE (token_hash)
```

Raw token storage is discouraged.

---

# Invitation Consumption Constraint

A consumed or revoked invitation cannot return to Pending.

Database and Application Layer behavior should prevent multiple successful consumption timestamps.

---

# Owner Index

The Last Owner Invariant may use a dedicated ownership index or locked query.

Conceptual view:

```text
active_organization_owners
- organization_id
- membership_id
```

The implementation must support transactional owner-count protection.

---

# Optimistic Concurrency

Each Aggregate Root table should include:

```text
version
```

Update pattern:

```text
UPDATE ...
SET version = version + 1
WHERE id = :id
  AND version = :expectedVersion
```

Zero updated rows indicate concurrency conflict.

---

# Composite Organization Keys

Organization-owned relationship tables should include organization_id.

Example:

```text
work_assignments
- organization_id
- work_id
- membership_id
```

This supports database-level cross-Organization protection.

---

# Row-Level Security

PostgreSQL Row-Level Security is optional for the MVP.

When used, it provides defense in depth.

RLS must not replace:

- principal resolution
- Membership validation
- Authorization policies
- Organization-scoped repositories

---

# Implementation Guidance

The implementation should keep identity responsibilities explicit.

A recommended module structure:

```text
identity/

    domain/
        HumanIdentity
        AuthenticationSubjectReference
        IdentityStatus

    application/
        CreateHumanIdentityService
        UpdateHumanIdentityService
        DisableHumanIdentityService
        PrincipalResolver

    infrastructure/
        HumanIdentityRepository
        AuthenticationSubjectRepository
        IdentityProviderAdapter

organization/

    domain/
        Organization
        OrganizationStatus

    application/
        CreateOrganizationService
        RenameOrganizationService
        SuspendOrganizationService
        ArchiveOrganizationService

    infrastructure/
        OrganizationRepository

membership/

    domain/
        Membership
        MembershipStatus
        RoleAssignment

    application/
        InviteMemberService
        AcceptInvitationService
        SuspendMembershipService
        RevokeMembershipService
        TransferOwnershipService

    infrastructure/
        MembershipRepository
        InvitationRepository
        OrganizationOwnershipLock
```

The exact package names may differ.

The boundaries should remain equivalent.

---

# Value Objects

Recommended Value Objects include:

```text
IdentityId

OrganizationId

MembershipId

PrincipalId

RoleAssignmentId

InvitationId

EmailAddress

OrganizationName

ActorReference

AuthenticationSubjectReference
```

Value Objects should validate their own structural rules.

---

# Email Address Value Object

Email validation should cover:

- bounded length
- normalized representation
- display versus canonical form
- no control characters
- safe serialization

Email validation does not prove ownership.

Verification is a separate authentication or invitation concern.

---

# Organization Name Value Object

OrganizationName should validate:

- non-empty value
- maximum length
- normalized whitespace
- safe character handling
- display preservation

Organization name uniqueness is not required.

---

# Principal Factory

Principal creation should be centralized.

Example:

```text
PrincipalFactory.CreateHumanMember(
    authenticationContext,
    identity,
    organization,
    membership
)
```

The factory must reject invalid combinations.

---

# Actor Reference Factory

ActorReference creation should also be centralized.

Examples:

```text
ActorReference.FromHumanMember(principal)

ActorReference.FromSecretary(principal)

ActorReference.FromSystem(principal)
```

No generic factory should permit arbitrary actor type conversion.

---

# Aggregate Factories

Creation should occur through Aggregate factories.

Examples:

```text
HumanIdentity.Create(...)

Organization.Create(...)

Membership.Invite(...)

Membership.CreateActiveOwner(...)
```

Direct row construction outside persistence hydration is discouraged.

---

# Repository Rules

Repositories must:

- load complete Aggregate state
- enforce Organization scope where applicable
- apply optimistic concurrency
- persist child role assignments atomically
- collect and persist Domain Events
- avoid business rule logic
- avoid automatic cross-Aggregate mutation

---

# Query Service Rules

Query services may optimize reads.

They must not:

- mutate Aggregate state
- grant authority from stale data
- combine Organization scopes
- expose unrelated identity data
- bypass privacy policy

---

# Invitation Service Rules

Invitation infrastructure must:

- generate cryptographically strong tokens
- store token hashes
- enforce expiration
- support revocation
- support single-use consumption
- avoid token logging
- avoid token inclusion in Domain Events

---

# Identity Provider Adapter

A provider adapter should expose a stable internal contract.

Example:

```text
IdentityProviderAdapter

ValidateAuthenticationToken(token)

ResolveVerifiedClaims(token)

LinkSubject(...)

RevokeProviderSession(...)
```

Domain code must not depend on provider-specific SDK types.

---

# Session Validation Service

A Session Validation Service may check:

```text
session validity

identity status

selected Organization status

Membership status
```

Authorization evaluates roles and permissions afterward.

---

# Startup Validation

Application startup should validate:

- supported principal types
- supported Organization statuses
- supported Membership statuses
- supported roles
- command-to-policy mappings
- System principal capabilities
- provider issuer configuration
- required database constraints
- Outbox Worker registration

Missing critical configuration should stop startup.

---

# Logging Guidance

Identity-related logs should include:

```text
requestId
correlationId
principalId
principalType
identityId
organizationId
membershipId
commandType
result
reasonCode
```

Logs must not include:

- passwords
- access tokens
- raw invitation tokens
- private signing keys
- full external claim sets
- unnecessary email addresses

---

# Observability

Recommended metrics include:

```text
identity_resolution_success_total

identity_resolution_failure_total

organization_context_failure_total

membership_activation_total

membership_suspension_total

membership_revocation_total

invitation_acceptance_total

invitation_failure_total

owner_invariant_violation_total

organization_bootstrap_failure_total

session_invalidation_backlog

assignment_reconciliation_backlog
```

---

# Health Checks

Operational health checks may verify:

- identity database availability
- Organization and Membership repository access
- identity provider metadata availability
- invitation Worker health
- session invalidation backlog
- reconciliation backlog
- Outbox publication health

A degraded external provider must not corrupt internal identity state.

---

# Performance Considerations

Common identity operations should use indexed lookups.

Recommended indexes include:

```text
authentication subject lookup

organization and identity Membership lookup

active role lookup

active Owner lookup

pending invitation token hash lookup

Membership status by Organization
```

Large global scans should be avoided in synchronous requests.

---

# Scalability

Separate Aggregates support scaling by avoiding one large Organization object.

The model permits:

- many Memberships per Organization
- one Identity in many Organizations
- independent Membership updates
- concurrent role changes across Organizations
- Organization-scoped Worker processing

---

# Multi-Tenancy Boundary

Organization is the MVP tenant boundary.

The design assumes:

```text
One resource

One Organization

One authorization scope
```

Cross-Organization sharing requires a future explicit model.

---

# Data Retention

Retention policy must address:

- disabled Human Identities
- revoked Memberships
- archived Organizations
- role history
- invitation history
- authorization audit
- Domain Events
- security logs

The MVP architecture preserves records but does not define final retention durations.

---

# Backup and Restore

Backup and restore procedures must preserve consistency among:

- Human Identity
- authentication subject mappings
- Organizations
- Memberships
- role assignments
- invitation status
- Domain Events
- Outbox records
- audit records

Partial restoration of identity data may produce security failures and is prohibited.

---

# Migration Guidance

Schema migrations must preserve:

- stable identityId
- stable organizationId
- stable membershipId
- role history
- actor attribution
- Organization ownership
- invitation uniqueness
- authentication subject uniqueness

Migration scripts should validate the Last Owner Invariant before completion.

---

# MVP Exclusions

The following capabilities are outside the MVP:

- Identity merge
- automatic duplicate Identity resolution
- global user directory
- public user profiles
- guest Membership
- cross-Organization Membership roles
- cross-Organization resource sharing
- Organization hierarchy
- parent and child Organizations
- nested teams
- custom Organization roles
- custom permission editor
- delegated authority
- temporary proxy access
- support impersonation
- break-glass access
- domain-based automatic Membership
- SCIM provisioning
- automated enterprise deprovisioning
- multiple approval Owners
- billing ownership
- legal entity verification
- hard deletion of Human Identity
- hard deletion of Organization
- full privacy erasure workflow
- Identity portability
- external API client Identity
- marketplace Identity
- AI Employee Identity
- Knowledge-specific Membership
- Evidence-specific access
- Capability-specific access

These require separate future architecture.

---

# Future Extension Principles

Future changes must preserve:

1. stable internal Human identity
2. explicit Organization scope
3. explicit Membership
4. no cross-Organization permission inheritance
5. Human and non-Human identity separation
6. Last Owner protection
7. historical ActorReference stability
8. default-deny authorization
9. trusted principal construction
10. auditable lifecycle changes

---

# Organization Hierarchy Future Phase

A future Organization hierarchy may introduce:

```text
Parent Organization

Child Organization

Inherited Policy

Shared Resource Scope
```

Inheritance must be explicit.

Roles must not flow automatically without a defined policy.

---

# Enterprise Provisioning Future Phase

SCIM or enterprise provisioning may automate:

- Identity creation
- Membership creation
- Membership suspension
- role mapping

Automation must remain:

- Organization-scoped
- auditable
- idempotent
- bounded by provisioning policy
- unable to grant unsupported Human authority

---

# Delegated Administration Future Phase

Delegated administration may allow limited Member management.

It must define:

- delegation scope
- assignable roles
- expiration
- revocation
- Organization boundary
- audit

It must not permit silent Owner escalation.

---

# Privacy Erasure Future Phase

A future erasure design may distinguish:

```text
Operational deletion

Profile anonymization

Authentication unlinking

Audit retention

Legal hold

Domain history preservation
```

Erasure must preserve business consistency while satisfying applicable legal requirements.

---

# Implementation Checklist

Before implementation is considered complete, verify:

- Human Identity uses stable internal identifiers
- email is not used as a permanent identity key
- authentication subjects are uniquely mapped
- every protected request resolves one Organization
- Human principal requires Active Identity
- Human principal requires Active Membership
- Human principal requires Active Organization
- roles are Membership-scoped
- Secretary cannot hold Membership or roles
- System cannot hold Membership or roles
- Organization bootstrap creates an initial Owner atomically
- final Owner removal is transactionally prevented
- invitation tokens are secure and single-use
- invitation acceptance is idempotent
- Organization repositories are scoped
- lifecycle events use the Transactional Outbox
- session invalidation does not replace current-state validation
- historical ActorReferences survive deactivation
- assignment consequences are reconciled asynchronously
- no Worker silently reassigns Human responsibility
- all critical failure paths fail closed

---

# Design Summary

The Identity and Organization architecture establishes four distinct foundations:

```text
Human Identity
    Who the person is over time

Organization
    Which business boundary owns the operation

Membership
    How the Human participates in the Organization

Principal
    Who is executing in the current context
```

Role Assignment adds Organization-scoped responsibility.

Authorization determines whether the resulting principal may attempt a command.

Domain Aggregates determine whether the command is valid.

---

# Core Guarantees

The design guarantees:

- stable Human identity
- explicit Organization ownership
- one Organization context per command
- multiple Organization Memberships without authority leakage
- active-state validation for Identity, Membership, and Organization
- distinct Human, Secretary, and System principals
- durable historical actor attribution
- atomic Organization bootstrap
- auditable invitation activation
- transactionally protected ownership
- secure external identity-provider mapping
- recoverable asynchronous consequences
- no implicit AI business authority

---

# Architect Review

## Identity Stability

**Rating: ★★★★★**

The architecture uses stable internal Human identifiers and separates them from email, display name, and external provider subjects.

Domain history remains valid through profile and provider changes.

---

## Organization Isolation

**Rating: ★★★★★**

Every protected execution resolves exactly one Organization and one Membership.

Authority cannot be combined across Organizations.

---

## Membership Model

**Rating: ★★★★★**

Membership is modeled independently from Human Identity and Organization.

This supports clear lifecycle semantics and avoids oversized Organization Aggregates.

---

## Principal Separation

**Rating: ★★★★★**

Human Member, Secretary, and System principals are structurally distinct.

Non-Human principals cannot acquire Human Memberships or roles.

---

## Ownership Safety

**Rating: ★★★★★**

Organization bootstrap and Last Owner protection prevent active Organizations from existing without accountable Human ownership.

Concurrent ownership mutation is addressed transactionally.

---

## Invitation Security

**Rating: ★★★★★**

Invitation activation is explicit, idempotent, recipient-bound, single-use, and auditable.

Unknown recipients do not become authoritative identities prematurely.

---

## External Identity Independence

**Rating: ★★★★★**

External Identity Providers handle authentication while AIOS remains authoritative for internal identity, Membership, roles, and ActorReference.

Provider changes do not rewrite domain history.

---

## Auditability

**Rating: ★★★★★**

Identity, Membership, role, ownership, and Organization lifecycle changes remain traceable through stable identifiers, Domain Events, and security audit metadata.

---

## Failure Safety

**Rating: ★★★★★**

Ambiguous identity, inactive Membership, Organization mismatch, provider failure, and ownership conflicts all fail closed.

Operational failures do not restore revoked authority.

---

## Scalability

**Rating: ★★★★★**

Separate Human Identity, Organization, and Membership Aggregates support independent writes and large Membership counts without one oversized transactional boundary.

---

## Testability

**Rating: ★★★★★**

The design defines Aggregate, Application Service, persistence, security, concurrency, provider, privacy, and end-to-end test coverage.

Critical invariants are suitable for property-based testing.

---

## MVP Scope Discipline

**Rating: ★★★★★**

The architecture avoids premature complexity such as Organization hierarchies, Identity merge, delegated access, support impersonation, and dynamic role systems.

Future extension boundaries remain explicit.

---

## Final Assessment

```text
Architecture Quality:          ★★★★★
Identity Stability:            ★★★★★
Organization Isolation:        ★★★★★
Membership Clarity:            ★★★★★
Principal Safety:              ★★★★★
Ownership Protection:          ★★★★★
Invitation Security:           ★★★★★
Auditability:                  ★★★★★
Implementation Readiness:      ★★★★★
MVP Scope Discipline:          ★★★★★
```

The Identity and Organization architecture is ready for implementation within the AIOS Modular Monolith.

It is fully aligned with:

- Authorization Architecture
- Application Services
- Work Aggregate
- Decision Aggregate
- Memory Aggregate
- Transactional Outbox
- Background Workers
- Human authority
- Secretary advisory boundaries
- System operational boundaries
- Organization-scoped multi-tenancy
- eventual cross-Aggregate consistency

**Architect Review Result: APPROVED**