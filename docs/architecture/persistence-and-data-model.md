# Persistence and Data Model Architecture

**Status:** Draft  
**Phase:** MVP  
**Architecture:** Modular Monolith  
**Primary Database:** PostgreSQL  
**Persistence Model:** Aggregate-Oriented Relational Persistence  
**Concurrency Model:** Optimistic Concurrency  
**Event Delivery:** Transactional Outbox  
**Cross-Aggregate Consistency:** Eventual

---

# Purpose

This document defines how AIOS domain state is persisted in PostgreSQL.

It translates the previously defined architecture into:

- relational tables
- Aggregate persistence boundaries
- identifiers
- constraints
- foreign keys
- indexes
- transaction rules
- concurrency controls
- retention strategies
- migration practices

The persistence model must support:

- Work
- Decision
- Memory
- Human Identity
- Organization
- Membership
- Authorization
- Transactional Outbox
- Background Workers
- consumer idempotency
- auditability
- Organization isolation

---

# Goals

The persistence architecture must ensure that:

- every Aggregate is persisted consistently
- Aggregate boundaries remain explicit
- business invariants are protected by both domain code and database constraints
- every Organization-owned record is Organization-scoped
- cross-Organization associations are prevented
- optimistic concurrency is enforced
- Aggregate state and Outbox events commit atomically
- asynchronous processing is idempotent
- submitted Decision revisions remain immutable
- Approved Memory remains immutable
- one active Memory exists per completed Work
- historical actor attribution remains stable
- schema changes are controlled and reversible
- operational queries remain efficient
- the MVP remains simple enough to implement and operate

---

# Non-Goals

This document does not define:

- event sourcing
- Aggregate reconstruction from events
- distributed SQL
- multi-region active-active persistence
- polyglot persistence
- document database adoption
- data warehouse architecture
- streaming analytics storage
- customer-managed databases
- cross-Organization shared resources
- public reporting schemas
- Knowledge persistence
- Evidence persistence
- Capability marketplace persistence
- AI Employee persistence
- long-term legal retention durations

Those concerns require separate future architecture.

---

# Persistence Principles

AIOS persistence follows these principles:

```text
Aggregate-Oriented Writes

Relational Integrity

Organization Isolation

Short Transactions

Optimistic Concurrency

Transactional Outbox

Explicit Schema Ownership

Default Data Preservation

Controlled Migration
```

---

# Principle 1: Aggregate-Oriented Persistence

Repositories persist Aggregate Roots.

Application Services do not update domain tables directly.

Every authoritative state change follows:

```text
Load Aggregate

↓

Execute Aggregate Command

↓

Persist Aggregate

↓

Persist Domain Events

↓

Commit
```

---

# Principle 2: Database Constraints Are Defense in Depth

Business rules remain inside Aggregates.

PostgreSQL constraints reinforce structural invariants.

Examples:

```text
Aggregate:
    decides whether Decision may be approved
```

```text
Database:
    constrains Decision status to supported values
```

The database does not replace the Domain Model.

---

# Principle 3: Organization Scope Is Persisted Explicitly

Every Organization-owned table includes:

```text
organization_id
```

This includes:

- Work
- Decision
- Decision revision
- Memory
- Membership
- role assignment
- review assignment
- Secretary contribution
- authorization audit
- reconciliation finding
- Organization-scoped event records

Organization scope must not be inferred indirectly when it can be stored explicitly.

---

# Principle 4: Cross-Organization Relationships Are Prohibited

An Organization-owned record may reference only records belonging to the same Organization.

Example:

```text
Work.organization_id = org-alpha

Decision.organization_id = org-alpha
```

A Work in org-alpha must never reference a Decision in org-beta.

Database constraints should enforce this where practical.

---

# Principle 5: Aggregate Boundaries Control Transactions

One command normally mutates one Aggregate.

Exceptional coordinated workflows may mutate multiple Aggregates in one local PostgreSQL transaction.

Examples:

```text
Create Organization
    -> Organization + Owner Membership
```

```text
Request Blocking Decision
    -> Work + Decision
```

```text
Transfer Ownership
    -> Source Membership + Target Membership
```

These exceptions do not merge Aggregate boundaries.

---

# Principle 6: No Event Sourcing

PostgreSQL Aggregate tables store current authoritative state.

Domain Events support:

- asynchronous coordination
- audit correlation
- read-model updates
- operational recovery

Aggregates are not reconstructed by replaying all events.

---

# Principle 7: Domain History Is Modeled Explicitly

Where the domain requires history, dedicated tables are used.

Examples:

```text
Decision revisions

Decision submitted snapshots

Memory revisions

role assignment history

Membership lifecycle timestamps
```

Historical requirements must not rely solely on generic database audit logs.

---

# Principle 8: Immutable Records Remain Immutable

The following records are immutable after their locking transition:

```text
Submitted Decision revision

Approved Decision outcome

Approved Memory content

Published Domain Event payload

Processed command identity

Historical role assignment record
```

Corrections are represented through new records or new revisions.

---

# Principle 9: Long-Running Work Stays Outside Transactions

Database transactions must not remain open during:

- AI generation
- email delivery
- external API calls
- large exports
- report generation
- notification delivery
- broad reconciliation scans

Only short, authoritative persistence work belongs inside the transaction.

---

# Principle 10: Deletion Is Conservative

The MVP prefers:

```text
Status transition

Archival

Revocation

Soft retention state
```

over hard deletion.

Hard deletion is not the ordinary lifecycle mechanism for:

- Human Identity
- Organization
- Membership
- Work
- Decision
- Memory
- Domain Events
- audit records

---

# PostgreSQL as Primary Store

PostgreSQL is the authoritative persistence engine for the MVP.

It stores:

```text
Domain Aggregate state

Aggregate history and revisions

Identity and Organization data

Authorization data

Transactional Outbox

Processed event state

Idempotency records

Operational findings

Audit metadata
```

---

# Why PostgreSQL

PostgreSQL provides:

- ACID transactions
- foreign keys
- unique constraints
- check constraints
- partial indexes
- JSONB
- row-level locking
- advisory locks
- `FOR UPDATE SKIP LOCKED`
- transactional Outbox support
- point-in-time recovery
- mature operational tooling

These capabilities support the Modular Monolith without requiring distributed infrastructure.

---

# Persistence Architecture

```text
Application Service
        │
        ▼
Repository Interface
        │
        ▼
PostgreSQL Repository
        │
        ├── Aggregate Tables
        ├── Child Entity Tables
        ├── Revision Tables
        ├── Outbox Tables
        ├── Idempotency Tables
        └── Audit Tables
```

---

# Module Ownership

Each module owns its persistence schema and migrations.

Recommended ownership:

```text
Work Module
    Work tables

Decision Module
    Decision and revision tables

Memory Module
    Memory and review tables

Identity Module
    Human identity and authentication-subject tables

Organization Module
    Organization tables

Membership Module
    Membership and role-assignment tables

Authorization Module
    policy and authorization-audit tables

Events Module
    Outbox, processed-event, replay, and dead-letter tables
```

---

# Schema Organization

The MVP may use one PostgreSQL database.

Two schema strategies are acceptable.

---

## Strategy A: One Shared Database Schema

Example:

```text
public.work_items

public.decisions

public.memories

public.memberships

public.outbox_messages
```

Benefits:

- simple migrations
- simple tooling
- straightforward foreign keys
- low operational overhead

This is acceptable for the MVP.

---

## Strategy B: Module-Specific PostgreSQL Schemas

Example:

```text
work.work_items

decision.decisions

memory.memories

identity.human_identities

organization.organizations

events.outbox_messages
```

Benefits:

- clearer ownership
- reduced accidental table access
- easier future extraction
- module-level permissions

This is also acceptable when team tooling supports it.

---

# Recommended MVP Schema Strategy

Use module-specific logical ownership.

Physical PostgreSQL schemas may be introduced when they do not increase deployment complexity significantly.

At minimum:

- table names must reveal module ownership
- repositories must access only owned tables
- migrations must be grouped by module
- cross-module writes must occur only through Application Services

---

# Repository Isolation

A repository may write only tables owned by its Aggregate or module.

Example:

```text
WorkRepository
    may write Work tables
```

It must not directly update:

```text
Decision tables

Memory tables

Membership tables
```

Cross-module coordination belongs to Application Services.

---

# Read Access Across Modules

A module may use query interfaces to read cross-module facts.

Example:

```text
Decision outcome handler

↓

WorkAssociationQuery
```

The query may resolve:

```text
decisionId -> workId
```

It must not mutate either Aggregate.

---

# Aggregate Persistence Model

Each Aggregate Root has:

```text
primary identifier

organization identifier when applicable

lifecycle status

optimistic concurrency version

creation timestamp

update timestamp

domain-specific state
```

---

# Aggregate Root Table Pattern

Recommended pattern:

```text
aggregate_table
- aggregate_id
- organization_id
- status
- version
- created_at
- updated_at
- domain fields
```

Not every Aggregate requires every field, but the pattern should remain consistent.

---

# Optimistic Concurrency Version

Every mutable Aggregate Root has:

```text
version bigint NOT NULL
```

Initial version may be:

```text
1
```

Each successful mutation increments version by one.

---

# Version Update Pattern

```sql
UPDATE aggregate_table
SET
    ...,
    version = version + 1,
    updated_at = now()
WHERE aggregate_id = :aggregate_id
  AND version = :expected_version;
```

If zero rows are updated:

```text
ConcurrencyConflict
```

---

# Version Ownership

Aggregate version belongs to the Aggregate Root.

Child table changes must be committed with the Root version update.

A child entity must not mutate independently without updating the Aggregate Root version.

---

# Child Entity Persistence

Child entities may use separate relational tables.

Examples:

```text
Decision revisions

Decision options

Memory source references

Work participants

Role assignments
```

They remain owned by the Aggregate Root.

---

# Child Entity Mutation Rule

A child entity table must not have a public repository that permits independent domain mutation.

Example:

```text
DecisionRevisionRepository.Save(...)
```

is prohibited as an ordinary application dependency.

The correct interface is:

```text
DecisionRepository.Save(decisionAggregate)
```

---

# Aggregate Hydration

Repositories must load all state required for Aggregate invariants.

They must avoid hidden lazy loading during command execution.

Example:

```text
Decision Aggregate requires:
- current status
- active Draft revision
- submitted snapshot
- review outcome
```

All required state must be available before the command runs.

---

# Large Child Collections

Large unbounded collections should not be loaded into Aggregates unnecessarily.

The design should distinguish:

```text
Aggregate-owned invariant state

Query-only history

External read-model collections
```

Only state required to enforce invariants belongs inside the loaded Aggregate.

---

# Revision Tables

Revision-based Aggregates use append-oriented child tables.

Examples:

```text
decision_revisions

memory_revisions
```

Revision rows receive stable revision identifiers and sequence numbers.

---

# Revision Number

Recommended revision key:

```text
aggregate_id + revision_number
```

Example:

```text
decision_id = decision-123

revision_number = 2
```

Recommended uniqueness:

```text
UNIQUE (
    decision_id,
    revision_number
)
```

---

# Revision Status

A revision may have a status distinct from the Aggregate lifecycle.

Example Decision revision statuses:

```text
Draft

Submitted

Rejected

Withdrawn

Approved
```

The exact representation must remain aligned with the Decision Aggregate.

---

# Submitted Snapshot

When a Decision is submitted:

- the Draft revision becomes immutable
- submitted content remains available
- later revision starts as a new row
- previous content is never overwritten

---

# Snapshot Storage Strategy

A submitted snapshot may be represented by:

1. the revision row becoming immutable, or
2. a dedicated submitted-snapshot table.

The MVP should prefer immutable revision rows unless a separate snapshot has a clear operational benefit.

---

# Memory Revision Persistence

Memory lifecycle:

```text
Generated

InReview

Rejected

Approved
```

A Memory may preserve revisions when content changes after rejection.

Approved content must remain immutable.

---

# One Active Revision

For revision-based Aggregates, only one current editable revision may exist.

Recommended enforcement:

```text
partial unique index
```

or:

```text
Aggregate Root current_revision_id
```

The selected strategy must prevent two concurrent active Drafts.

---

# Aggregate Root Current Revision

Recommended root fields:

```text
current_revision_id

current_revision_number
```

This allows efficient loading of the active revision.

Historical revisions remain append-only.

---

# Status Representation

Statuses should be stored as bounded text values.

Example:

```text
status text NOT NULL
```

with:

```text
CHECK (
    status IN (...)
)
```

PostgreSQL enum types may be used, but text plus check constraints often provides easier migration.

---

# Recommended Status Strategy

Use:

```text
text + CHECK constraint
```

for MVP lifecycle states.

Benefits:

- easier schema evolution
- explicit migration control
- readable database values
- fewer enum migration complications

---

# Timestamp Strategy

All stored timestamps use:

```text
timestamptz
```

Application and database timestamps are represented in UTC.

---

# Common Timestamps

Recommended fields:

```text
created_at

updated_at

submitted_at

approved_at

rejected_at

completed_at

cancelled_at

archived_at

revoked_at
```

A lifecycle timestamp should be nullable until the corresponding transition occurs.

---

# Clock Source

The Application Layer may use an injected clock for domain timestamps.

Database operational timestamps may use:

```sql
now()
```

The architecture must define which clock owns each field.

---

# Domain Timestamp Versus Persistence Timestamp

Example:

```text
completed_at
    domain fact timestamp

updated_at
    persistence metadata timestamp
```

These may be equal but represent different meanings.

---

# Identifier Strategy

AIOS uses stable opaque identifiers.

Recommended type:

```text
UUID
```

or another collision-resistant opaque identifier.

---

# Identifier Rules

Identifiers must:

- be generated by trusted infrastructure
- remain stable
- avoid business meaning
- avoid sequential public enumeration where possible
- serialize consistently
- be unique within their domain scope

---

# Identifier Types

Recommended identifiers include:

```text
identity_id

organization_id

membership_id

work_id

decision_id

decision_revision_id

memory_id

memory_revision_id

event_id

outbox_id

command_id

correlation_id

replay_id

finding_id
```

---

# Domain-Typed Identifiers

Application code should use typed identifier wrappers where supported.

Preferred:

```text
WorkId

DecisionId

MemoryId
```

Avoid passing untyped generic strings throughout the Domain Layer.

---

# Database Identifier Type

UUID-backed identifiers should use:

```text
uuid
```

rather than generic text where practical.

External identifiers that do not use UUID format may use bounded text.

---

# Business Keys

Business keys may supplement primary identifiers.

Examples:

```text
organization slug

human primary email

invitation token hash

event stream position
```

Business keys must not replace stable internal identifiers.

---

# Email as Lookup Key

Email may be indexed for:

- invitation matching
- profile lookup
- identity-provider support

It must not be the foreign key used by domain resources.

---

# Naming Conventions

Recommended database naming style:

```text
snake_case
```

Examples:

```text
work_items

decision_revisions

organization_id

created_at
```

---

# Table Naming

Use plural table names consistently.

Examples:

```text
organizations

memberships

work_items

decisions

decision_revisions

memories

outbox_messages
```

---

# Primary Key Naming

Recommended:

```text
<table_singular>_id
```

Examples:

```text
work_id

decision_id

memory_id
```

---

# Foreign Key Naming

Foreign key columns use the referenced identifier name.

Example:

```text
organization_id

membership_id

decision_id
```

---

# Constraint Naming

Recommended pattern:

```text
pk_<table>

fk_<table>_<referenced_table>

uq_<table>_<columns>

ck_<table>_<rule>

ix_<table>_<purpose>
```

---

# Example Constraint Names

```text
pk_work_items

fk_work_items_organizations

uq_decision_revisions_number

ck_memories_status

ix_outbox_messages_pending
```

---

# Boolean Fields

Boolean fields should describe positive meaning.

Preferred:

```text
is_active

is_locked
```

Avoid ambiguous negatives such as:

```text
is_not_disabled
```

Where lifecycle state exists, prefer status over overlapping Boolean flags.

---

# Nullability

Nullability must represent domain meaning explicitly.

Example:

```text
approved_at IS NULL
```

means approval has not occurred.

Required identifiers and current lifecycle state must be non-null.

---

# Nullable Foreign Keys

Nullable foreign keys are permitted only when the domain allows absence.

Example:

```text
Memory may not yet have reviewed_by_identity_id
```

A nullable foreign key must not be used to avoid modeling a required relationship.

---

# JSONB Usage

JSONB is permitted for:

- event payloads
- event headers
- bounded audit metadata
- flexible non-authoritative operational data
- structured optional content that does not participate in core relational invariants

---

# JSONB Prohibitions

JSONB should not replace relational modeling for:

- Aggregate lifecycle status
- Organization ownership
- Membership roles
- Decision revision identity
- Memory approval state
- Work Completion Gate
- foreign-key relationships
- uniqueness rules
- concurrency version

---

# JSONB Validation

JSONB content should use:

- application schema validation
- bounded size
- explicit schema version where applicable
- privacy classification
- stable field names

Database JSON checks may supplement critical structural validation.

---

# Text Content Storage

Large user-authored content may use:

```text
text
```

Examples:

- Work description
- Decision rationale
- Memory content
- review notes

Maximum lengths should be enforced at the Domain or Application boundary.

Database checks may enforce hard safety limits.

---

# Large Binary Data

Large binary files must not be stored directly in core Aggregate tables.

Future attachment storage should use:

- object storage
- file metadata table
- authorized content reference
- checksum
- retention policy

Binary attachment architecture is outside the MVP unless explicitly required.

---

# Normalization Strategy

The MVP should use a normalized relational model for authoritative data.

Normalization is preferred when it supports:

- foreign keys
- uniqueness
- partial indexes
- lifecycle queries
- concurrency
- auditability

---

# Denormalization

Denormalization is acceptable for:

- read models
- projections
- operational dashboards
- immutable event metadata
- Organization-scoped lookup optimization

Denormalized fields must have a defined source of truth.

---

# Read Models

Read models may use dedicated tables optimized for queries.

Examples:

```text
decision_review_queue

completed_work_view

organization_member_directory

memory_review_queue
```

Read models are eventually consistent.

They must not become authoritative write models.

---

# Read Model Rebuildability

A read model should be rebuildable from:

- authoritative Aggregate tables
- Domain Events
- or both

The rebuild strategy must be documented per projection.

---

# Query Separation

Repositories support Aggregate loading and persistence.

Query Services support:

- list screens
- dashboards
- search
- reporting
- review queues
- operational views

Query Services may use optimized SQL and projections.

---

# Command-Query Separation

The MVP does not require full CQRS infrastructure.

It does require conceptual separation:

```text
Command path
    uses Aggregates and Repositories
```

```text
Query path
    uses Query Services and Read Models
```

---

# Data Ownership

Each authoritative field has one owner.

Examples:

```text
Work.status
    owned by Work Aggregate
```

```text
Decision.status
    owned by Decision Aggregate
```

```text
Memory.status
    owned by Memory Aggregate
```

```text
Membership.status
    owned by Membership Aggregate
```

No other module may update these fields directly.

---

# Cross-Aggregate References

Cross-Aggregate references use identifiers.

Examples:

```text
Work.blocking_decision_id

Decision.related_work_id

Memory.source_work_id
```

The design must choose one authoritative relationship owner where possible.

---

# Relationship Ownership

For a blocking Decision workflow:

```text
Work
    owns Completion Gate and blocking Decision reference
```

Decision may store:

```text
related_work_id
```

for lookup and audit.

The duplicate relationship must be validated transactionally when created.

---

# Relationship Duplication

Duplicating identifiers across Aggregates is acceptable when:

- each copy has a clear purpose
- creation is coordinated
- Organization scope matches
- later mutation is restricted
- reconciliation can detect inconsistency

---

# Completion Gate Persistence

Work Completion Gate is a Value Object.

Conceptual fields:

```text
completion_gate_type

completion_gate_decision_id

completion_gate_outcome
```

or an equivalent normalized representation.

---

# Completion Gate Values

Supported conceptual states:

```text
NotRequired

Pending(decisionId)

Satisfied(decisionId)

Unsatisfied(decisionId)
```

Database constraints must prevent invalid field combinations.

---

# Completion Gate Constraint Principle

Examples:

```text
NotRequired
    -> decision_id must be null
```

```text
Pending
    -> decision_id must be non-null
```

```text
Satisfied
    -> decision_id must be non-null
```

```text
Unsatisfied
    -> decision_id must be non-null
```

---

# Decision Outcome Persistence

Decision outcome fields may include:

```text
outcome

decided_by_identity_id

decided_by_membership_id

decided_at

decision_revision_id

review_rationale
```

Outcome values:

```text
Approved

Rejected

Withdrawn
```

Draft and InReview are lifecycle states, not outcomes.

---

# Memory Source Persistence

Memory should reference its source Work:

```text
source_work_id
```

The system guarantees one active Memory per Work.

The database must reinforce this with a uniqueness strategy.

---

# One Active Memory Constraint

Recommended partial unique index:

```sql
CREATE UNIQUE INDEX uq_memories_active_source_work
ON memories (
    organization_id,
    source_work_id
)
WHERE is_active = true;
```

An equivalent lifecycle-based condition is acceptable.

---

# Active Memory Meaning

The MVP normally has only one Memory Aggregate per Work.

If future supersession is introduced:

```text
old Memory = inactive or superseded

new Memory = active
```

The MVP should avoid adding supersession complexity unless required.

---

# Actor Reference Persistence

Domain records should persist stable attribution fields.

Recommended Human attribution:

```text
actor_identity_id

actor_membership_id

actor_type

actor_display_name_snapshot
```

---

# Actor Type Constraint

Supported values:

```text
HumanMember

Secretary

System
```

Unknown actor types must not be interpreted as Human.

---

# Human Authority Database Checks

Database constraints may ensure that authority-sensitive records use:

```text
actor_type = HumanMember
```

Examples:

- Decision approval record
- Work completion record
- Memory approval record

Application and Domain rules remain primary.

---

# Historical Membership References

Historical actor references may point to Memberships that later become:

- Suspended
- Revoked
- deleted from active projections

The foreign key should preserve the historical Membership row.

Membership hard deletion is therefore prohibited in ordinary operation.

---

# Soft Lifecycle Persistence

Lifecycle changes update status and timestamps.

Example:

```text
Membership:
    status = Revoked
    revoked_at = ...
```

The row remains available for audit and foreign-key integrity.

---

# Hard Delete Policy

Ordinary repositories should not expose hard-delete methods for authoritative Aggregate Roots.

Examples of discouraged interfaces:

```text
WorkRepository.Delete(workId)

DecisionRepository.Delete(decisionId)

MembershipRepository.Delete(membershipId)
```

Cancellation, revocation, disablement, or archival should be used instead.

---

# Technical Cleanup

Technical cleanup may hard-delete:

- expired temporary locks
- old non-authoritative cache rows
- transient staging records
- old Published Outbox rows after retention
- old read-model rebuild artifacts

Cleanup must not delete authoritative domain history unintentionally.

---

# Referential Integrity

Foreign keys should be used wherever they preserve valid ownership and lifecycle relationships.

Examples:

```text
work_items.organization_id
    -> organizations.organization_id
```

```text
decision_revisions.decision_id
    -> decisions.decision_id
```

```text
memories.source_work_id
    -> work_items.work_id
```

---

# Composite Organization Foreign Keys

To prevent cross-Organization relationships, tables may use composite keys.

Example parent uniqueness:

```text
UNIQUE (
    organization_id,
    work_id
)
```

Child foreign key:

```text
FOREIGN KEY (
    organization_id,
    source_work_id
)
REFERENCES work_items (
    organization_id,
    work_id
)
```

---

# Composite Key Strategy

Primary keys may remain single-column UUIDs.

Additional Organization composite unique constraints support safe foreign keys.

Example:

```text
PRIMARY KEY (work_id)

UNIQUE (organization_id, work_id)
```

---

# Foreign Key Delete Behavior

Recommended default:

```text
ON DELETE RESTRICT
```

or:

```text
NO ACTION
```

Cascade deletion should be limited to true Aggregate-owned child rows.

---

# Allowed Cascade Delete

Cascade may be appropriate for:

- temporary child rows
- uncommitted staging data
- Aggregate-owned draft details when the Aggregate itself is being permanently removed before publication
- test fixtures

Hard deletion of committed Aggregate Roots is not ordinary MVP behavior.

---

# Child Cascade Principle

If a child entity has no meaning outside its Aggregate and the Aggregate Root is legally removed through controlled tooling, cascade may be used.

Ordinary business lifecycle must not rely on cascade deletion.

---

# Unique Constraints

Unique constraints should protect:

- authentication subject mapping
- Organization Membership uniqueness
- active role assignment uniqueness
- Decision revision number
- Memory revision number
- eventId
- processed-event consumer key
- command idempotency key
- active Memory per Work
- event stream position

---

# Check Constraints

Check constraints should protect:

- supported statuses
- non-negative versions
- valid attempt counts
- timestamp combinations
- Completion Gate field combinations
- authority-sensitive actor types
- positive revision numbers
- schema versions greater than zero

---

# Database Defaults

Defaults may be used for technical fields such as:

```text
created_at = now()

version = 1

attempt_count = 0
```

Business-significant defaults should remain explicit in Aggregate creation.

---

# Default Status

Aggregate creation should explicitly supply initial status.

The database may reinforce the value but should not silently choose business lifecycle state when domain code omits it.

---

# Core Data Invariants

The persistence model must preserve the following invariants:

1. Every Aggregate Root has one stable identifier.
2. Every mutable Aggregate Root has one optimistic concurrency version.
3. Every Organization-owned Aggregate stores organization_id.
4. Cross-Organization foreign-key relationships are prohibited.
5. Aggregate-owned child rows cannot mutate independently.
6. Decision submitted revisions are immutable.
7. Decision approval never updates Work to Completed directly.
8. Work completion requires Human actor attribution.
9. Memory generation starts only after committed WorkCompleted processing.
10. Only one active Memory exists per Work.
11. Approved Memory content is immutable.
12. Approved Memory is not Knowledge.
13. Membership and roles remain Organization-scoped.
14. Secretary and System principals cannot be persisted as Human actors.
15. Aggregate state and Outbox records commit atomically.
16. Event payloads remain immutable after commit.
17. Consumer effects and processed-event records commit atomically.
18. Historical actor and Membership references remain stable.
19. Ordinary lifecycle uses status transitions rather than hard deletion.
20. Database constraints reinforce, but do not replace, domain invariants.

---

# Part 1 Design Summary

The AIOS persistence model uses PostgreSQL as a relational, transactional foundation for the Modular Monolith.

The design is organized around:

```text
Aggregate Roots

Owned Child Entities

Immutable Revisions

Organization-Scoped Relationships

Optimistic Concurrency

Transactional Outbox

Explicit Historical Attribution
```

Authoritative writes remain Aggregate-driven.

Relational constraints protect structural integrity.

Cross-Aggregate consequences remain asynchronous unless a narrowly defined coordinated transaction is required.

# Work Persistence Model

The Work Aggregate owns:

- Work identity
- Organization scope
- lifecycle status
- title and description
- assignment
- Completion Gate
- blocking Decision reference
- completion metadata
- cancellation metadata
- optimistic concurrency version
- Work-owned relationships required by invariants

---

# Work Root Table

Recommended table:

```text
work_items
```

Conceptual structure:

```text
work_items
- work_id
- organization_id
- title
- description
- status
- completion_gate_type
- blocking_decision_id
- decision_outcome
- created_by_identity_id
- created_by_membership_id
- started_by_identity_id
- started_at
- completed_by_identity_id
- completed_by_membership_id
- completion_summary
- completed_at
- cancelled_by_identity_id
- cancelled_by_membership_id
- cancellation_reason
- cancelled_at
- version
- created_at
- updated_at
```

---

# Work Status Values

Supported values:

```text
Draft

InProgress

WaitingForDecision

Completed

Cancelled
```

Recommended database constraint:

```sql
ALTER TABLE work_items
ADD CONSTRAINT ck_work_items_status
CHECK (
    status IN (
        'Draft',
        'InProgress',
        'WaitingForDecision',
        'Completed',
        'Cancelled'
    )
);
```

---

# Completion Gate Persistence

Recommended values:

```text
NotRequired

Pending

Satisfied

Unsatisfied
```

Conceptual fields:

```text
completion_gate_type
blocking_decision_id
decision_outcome
```

Recommended `decision_outcome` values:

```text
Approved

Rejected

Withdrawn
```

or:

```text
NULL
```

when no final Decision outcome has been recorded.

---

# Completion Gate Constraints

Recommended constraint:

```sql
ALTER TABLE work_items
ADD CONSTRAINT ck_work_items_completion_gate
CHECK (
    (
        completion_gate_type = 'NotRequired'
        AND blocking_decision_id IS NULL
        AND decision_outcome IS NULL
    )
    OR
    (
        completion_gate_type = 'Pending'
        AND blocking_decision_id IS NOT NULL
        AND decision_outcome IS NULL
    )
    OR
    (
        completion_gate_type = 'Satisfied'
        AND blocking_decision_id IS NOT NULL
        AND decision_outcome = 'Approved'
    )
    OR
    (
        completion_gate_type = 'Unsatisfied'
        AND blocking_decision_id IS NOT NULL
        AND decision_outcome IN (
            'Rejected',
            'Withdrawn'
        )
    )
);
```

The Work Aggregate remains responsible for deciding which Decision outcomes produce each gate state.

The database prevents structurally impossible combinations.

---

# Work Terminal-State Constraints

Recommended completion constraint:

```sql
ALTER TABLE work_items
ADD CONSTRAINT ck_work_items_completed_fields
CHECK (
    (
        status = 'Completed'
        AND completed_by_identity_id IS NOT NULL
        AND completed_by_membership_id IS NOT NULL
        AND completed_at IS NOT NULL
    )
    OR
    (
        status <> 'Completed'
        AND completed_at IS NULL
    )
);
```

Recommended cancellation constraint:

```sql
ALTER TABLE work_items
ADD CONSTRAINT ck_work_items_cancelled_fields
CHECK (
    (
        status = 'Cancelled'
        AND cancelled_by_identity_id IS NOT NULL
        AND cancelled_by_membership_id IS NOT NULL
        AND cancelled_at IS NOT NULL
        AND cancellation_reason IS NOT NULL
    )
    OR
    (
        status <> 'Cancelled'
        AND cancelled_at IS NULL
    )
);
```

These constraints do not validate the full lifecycle transition.

The Work Aggregate remains authoritative for state transitions.

---

# Work Human Authority

The completion fields must reference a Human Member.

Recommended persistence approach:

```text
completed_by_identity_id

completed_by_membership_id
```

The Application and Domain Layers ensure:

```text
actorType = HumanMember
```

A dedicated completion-history table may additionally store actor type if a uniform ActorReference model is used.

---

# Work Creation Attribution

Recommended fields:

```text
created_by_identity_id
created_by_membership_id
```

These references identify the Human who created the Work.

Secretary and System principals may contribute content but do not create Human-authoritative Work under the MVP policy.

---

# Work Assignment Tables

If Work supports one primary assignee, the root may store:

```text
assigned_membership_id
```

If Work supports multiple participants, use an owned child table:

```text
work_participants
- work_participant_id
- organization_id
- work_id
- membership_id
- relationship_type
- added_by_identity_id
- added_at
- removed_by_identity_id
- removed_at
```

---

# Work Participant Relationship Types

Recommended values:

```text
Assignee

Participant

Observer
```

Only active rows grant current relationship.

Recommended active uniqueness:

```sql
CREATE UNIQUE INDEX uq_work_participants_active_relationship
ON work_participants (
    work_id,
    membership_id,
    relationship_type
)
WHERE removed_at IS NULL;
```

---

# Work Participant Organization Constraint

Recommended composite foreign keys:

```sql
FOREIGN KEY (
    organization_id,
    work_id
)
REFERENCES work_items (
    organization_id,
    work_id
);
```

```sql
FOREIGN KEY (
    organization_id,
    membership_id
)
REFERENCES memberships (
    organization_id,
    membership_id
);
```

This prevents assigning a Member from another Organization.

---

# Work Decision Association

The blocking Decision association should be immutable after establishment except through explicit Work Aggregate behavior.

Recommended fields:

```text
blocking_decision_id
```

Recommended composite foreign key:

```sql
FOREIGN KEY (
    organization_id,
    blocking_decision_id
)
REFERENCES decisions (
    organization_id,
    decision_id
);
```

Because Work and Decision may be inserted within the same transaction, the foreign key may be:

```text
DEFERRABLE INITIALLY DEFERRED
```

when repository insertion order requires it.

---

# Work Indexes

Recommended indexes:

```sql
CREATE INDEX ix_work_items_organization_status
ON work_items (
    organization_id,
    status
);
```

```sql
CREATE INDEX ix_work_items_blocking_decision
ON work_items (
    organization_id,
    blocking_decision_id
)
WHERE blocking_decision_id IS NOT NULL;
```

```sql
CREATE INDEX ix_work_items_completed_at
ON work_items (
    organization_id,
    completed_at
)
WHERE status = 'Completed';
```

```sql
CREATE INDEX ix_work_participants_membership
ON work_participants (
    organization_id,
    membership_id
)
WHERE removed_at IS NULL;
```

---

# Work Table Conceptual DDL

```sql
CREATE TABLE work_items (
    work_id                     uuid PRIMARY KEY,
    organization_id             uuid NOT NULL,
    title                        text NOT NULL,
    description                  text NULL,
    status                       text NOT NULL,
    completion_gate_type         text NOT NULL,
    blocking_decision_id         uuid NULL,
    decision_outcome             text NULL,

    created_by_identity_id       uuid NOT NULL,
    created_by_membership_id     uuid NOT NULL,

    started_by_identity_id       uuid NULL,
    started_at                   timestamptz NULL,

    completed_by_identity_id     uuid NULL,
    completed_by_membership_id   uuid NULL,
    completion_summary           text NULL,
    completed_at                 timestamptz NULL,

    cancelled_by_identity_id     uuid NULL,
    cancelled_by_membership_id   uuid NULL,
    cancellation_reason          text NULL,
    cancelled_at                 timestamptz NULL,

    version                      bigint NOT NULL,
    created_at                   timestamptz NOT NULL,
    updated_at                   timestamptz NOT NULL,

    CONSTRAINT uq_work_items_organization_work
        UNIQUE (
            organization_id,
            work_id
        ),

    CONSTRAINT fk_work_items_organization
        FOREIGN KEY (
            organization_id
        )
        REFERENCES organizations (
            organization_id
        ),

    CONSTRAINT ck_work_items_version
        CHECK (
            version > 0
        )
);
```

Additional constraints from this document should be applied through migrations.

---

# Decision Persistence Model

The Decision Aggregate owns:

- Decision identity
- Organization scope
- related Work reference
- lifecycle status
- active revision
- immutable submitted revisions
- approval, rejection, or withdrawal outcome
- reviewer attribution
- revision sequence
- optimistic concurrency version

---

# Decision Root Table

Recommended table:

```text
decisions
```

Conceptual structure:

```text
decisions
- decision_id
- organization_id
- related_work_id
- status
- current_revision_id
- current_revision_number
- created_by_identity_id
- created_by_membership_id
- submitted_revision_id
- submitted_by_identity_id
- submitted_by_membership_id
- submitted_at
- decided_revision_id
- outcome
- decided_by_identity_id
- decided_by_membership_id
- review_rationale
- decided_at
- version
- created_at
- updated_at
```

---

# Decision Status Values

Supported values:

```text
Draft

InReview

Approved

Rejected

Withdrawn
```

Recommended constraint:

```sql
ALTER TABLE decisions
ADD CONSTRAINT ck_decisions_status
CHECK (
    status IN (
        'Draft',
        'InReview',
        'Approved',
        'Rejected',
        'Withdrawn'
    )
);
```

---

# Decision Outcome Values

Recommended values:

```text
Approved

Rejected

Withdrawn
```

The `outcome` field remains null in:

```text
Draft

InReview
```

---

# Decision State Constraints

Conceptual constraint:

```sql
ALTER TABLE decisions
ADD CONSTRAINT ck_decisions_outcome_state
CHECK (
    (
        status IN (
            'Draft',
            'InReview'
        )
        AND outcome IS NULL
    )
    OR
    (
        status = 'Approved'
        AND outcome = 'Approved'
    )
    OR
    (
        status = 'Rejected'
        AND outcome = 'Rejected'
    )
    OR
    (
        status = 'Withdrawn'
        AND outcome = 'Withdrawn'
    )
);
```

---

# Decision Review Attribution Constraint

Recommended constraint:

```sql
ALTER TABLE decisions
ADD CONSTRAINT ck_decisions_decided_fields
CHECK (
    (
        status IN (
            'Approved',
            'Rejected',
            'Withdrawn'
        )
        AND decided_revision_id IS NOT NULL
        AND decided_by_identity_id IS NOT NULL
        AND decided_by_membership_id IS NOT NULL
        AND decided_at IS NOT NULL
    )
    OR
    (
        status IN (
            'Draft',
            'InReview'
        )
        AND decided_at IS NULL
    )
);
```

---

# Decision Revision Table

Recommended table:

```text
decision_revisions
```

Conceptual structure:

```text
decision_revisions
- decision_revision_id
- organization_id
- decision_id
- revision_number
- revision_status
- title
- question
- context
- proposed_option
- rationale
- created_by_identity_id
- created_by_membership_id
- created_at
- updated_at
- submitted_at
- locked_at
- source_revision_id
- content_hash
```

The exact business fields may vary according to the Decision Aggregate.

---

# Decision Revision Status Values

Recommended values:

```text
Draft

Submitted

Approved

Rejected

Withdrawn
```

A revision becomes immutable when it leaves Draft.

---

# Decision Revision Immutability

The repository must not issue content updates when:

```text
revision_status <> Draft
```

A database trigger may provide defense in depth.

Conceptual trigger behavior:

```text
IF OLD.revision_status <> 'Draft'
AND content fields changed
THEN
    reject update
```

---

# Decision Revision Number Constraint

```sql
ALTER TABLE decision_revisions
ADD CONSTRAINT ck_decision_revisions_number
CHECK (
    revision_number > 0
);
```

Recommended uniqueness:

```sql
ALTER TABLE decision_revisions
ADD CONSTRAINT uq_decision_revisions_number
UNIQUE (
    decision_id,
    revision_number
);
```

---

# One Draft Revision Constraint

Recommended partial unique index:

```sql
CREATE UNIQUE INDEX uq_decision_revisions_one_draft
ON decision_revisions (
    decision_id
)
WHERE revision_status = 'Draft';
```

This prevents two concurrent editable revisions.

---

# Current Revision Reference

The Decision Root stores:

```text
current_revision_id
```

Recommended foreign key:

```sql
FOREIGN KEY (
    current_revision_id
)
REFERENCES decision_revisions (
    decision_revision_id
);
```

The repository must also verify that the revision belongs to the same Decision and Organization.

A composite foreign key may enforce this more strongly.

---

# Submitted Revision Reference

When status is InReview:

```text
submitted_revision_id
```

must identify the immutable submitted revision.

Recommended constraint:

```text
status = InReview
    -> submitted_revision_id is not null
```

When Approved, Rejected, or Withdrawn:

```text
decided_revision_id
```

must equal the revision that was reviewed.

---

# Decision Related Work Constraint

Recommended composite foreign key:

```sql
FOREIGN KEY (
    organization_id,
    related_work_id
)
REFERENCES work_items (
    organization_id,
    work_id
);
```

The relationship may be non-null when every MVP Decision is created for Work.

If standalone Decisions are supported later, it may remain nullable.

---

# Decision Options

If a Decision supports multiple structured options, use:

```text
decision_revision_options
- decision_option_id
- organization_id
- decision_revision_id
- option_order
- label
- description
- advantages
- disadvantages
```

These rows are owned by the Decision revision.

They are immutable once the revision is submitted.

---

# Decision Secretary Contributions

Recommended table:

```text
decision_secretary_contributions
- contribution_id
- organization_id
- decision_id
- decision_revision_id
- secretary_principal_id
- requested_by_identity_id
- requested_by_membership_id
- contribution_type
- content
- generation_id
- created_at
- adopted_at
- adopted_by_identity_id
```

Secretary Contributions remain separate from authoritative Draft content.

---

# Decision Contribution Adoption

Adoption does not update the contribution into an authoritative state automatically.

The Human executes a Decision Aggregate edit command.

The contribution may record:

```text
adopted_at

adopted_by_identity_id
```

for traceability.

---

# Decision Indexes

Recommended indexes:

```sql
CREATE INDEX ix_decisions_organization_status
ON decisions (
    organization_id,
    status
);
```

```sql
CREATE INDEX ix_decisions_related_work
ON decisions (
    organization_id,
    related_work_id
);
```

```sql
CREATE INDEX ix_decision_revisions_decision_number
ON decision_revisions (
    decision_id,
    revision_number DESC
);
```

```sql
CREATE INDEX ix_decisions_in_review
ON decisions (
    organization_id,
    submitted_at
)
WHERE status = 'InReview';
```

---

# Decision Root Conceptual DDL

```sql
CREATE TABLE decisions (
    decision_id                  uuid PRIMARY KEY,
    organization_id              uuid NOT NULL,
    related_work_id              uuid NOT NULL,
    status                        text NOT NULL,

    current_revision_id           uuid NULL,
    current_revision_number       integer NOT NULL,

    created_by_identity_id        uuid NOT NULL,
    created_by_membership_id      uuid NOT NULL,

    submitted_revision_id         uuid NULL,
    submitted_by_identity_id      uuid NULL,
    submitted_by_membership_id    uuid NULL,
    submitted_at                  timestamptz NULL,

    decided_revision_id           uuid NULL,
    outcome                       text NULL,
    decided_by_identity_id        uuid NULL,
    decided_by_membership_id      uuid NULL,
    review_rationale              text NULL,
    decided_at                    timestamptz NULL,

    version                       bigint NOT NULL,
    created_at                    timestamptz NOT NULL,
    updated_at                    timestamptz NOT NULL,

    CONSTRAINT uq_decisions_organization_decision
        UNIQUE (
            organization_id,
            decision_id
        ),

    CONSTRAINT ck_decisions_version
        CHECK (
            version > 0
        ),

    CONSTRAINT ck_decisions_revision_number
        CHECK (
            current_revision_number > 0
        )
);
```

---

# Memory Persistence Model

The Memory Aggregate owns:

- Memory identity
- Organization scope
- source Work reference
- lifecycle status
- current content revision
- review state
- Human approval or rejection
- source metadata
- generation metadata
- optimistic concurrency version

---

# Memory Root Table

Recommended table:

```text
memories
```

Conceptual structure:

```text
memories
- memory_id
- organization_id
- source_work_id
- status
- is_active
- current_revision_id
- current_revision_number
- generation_policy_version
- generated_by_system_principal_id
- generated_at
- submitted_revision_id
- submitted_by_identity_id
- submitted_by_membership_id
- submitted_at
- reviewed_revision_id
- reviewed_by_identity_id
- reviewed_by_membership_id
- review_note
- reviewed_at
- version
- created_at
- updated_at
```

---

# Memory Status Values

Supported values:

```text
Generated

InReview

Rejected

Approved
```

Recommended constraint:

```sql
ALTER TABLE memories
ADD CONSTRAINT ck_memories_status
CHECK (
    status IN (
        'Generated',
        'InReview',
        'Rejected',
        'Approved'
    )
);
```

---

# Memory Active Flag

The MVP normally keeps one active Memory per Work.

Recommended:

```text
is_active = true
```

for the current Memory.

A partial unique index protects the invariant:

```sql
CREATE UNIQUE INDEX uq_memories_active_work
ON memories (
    organization_id,
    source_work_id
)
WHERE is_active = true;
```

---

# Memory Source Work Constraint

Recommended composite foreign key:

```sql
FOREIGN KEY (
    organization_id,
    source_work_id
)
REFERENCES work_items (
    organization_id,
    work_id
);
```

The Memory generation handler must additionally verify that the Work is Completed.

A foreign key alone cannot validate Work lifecycle state.

---

# Memory Revision Table

Recommended table:

```text
memory_revisions
```

Conceptual structure:

```text
memory_revisions
- memory_revision_id
- organization_id
- memory_id
- revision_number
- revision_status
- title
- summary
- content
- source_references
- created_by_actor_type
- created_by_actor_id
- created_by_membership_id
- created_at
- updated_at
- locked_at
- content_hash
- source_revision_id
```

---

# Memory Revision Status Values

Recommended values:

```text
Generated

Submitted

Rejected

Approved
```

A revision is editable only when the Memory state permits Generated content editing.

---

# One Editable Memory Revision

Recommended partial unique index:

```sql
CREATE UNIQUE INDEX uq_memory_revisions_one_generated
ON memory_revisions (
    memory_id
)
WHERE revision_status = 'Generated';
```

The exact condition must align with the Aggregate revision model.

---

# Memory Revision Immutability

Once a revision becomes:

```text
Submitted

Approved
```

its content must not change.

Rejected revision content may remain immutable while a new Generated revision is created.

This provides stronger historical traceability than mutating the rejected revision.

---

# Approved Memory Constraint

Recommended conceptual constraint:

```text
status = Approved
    -> reviewed_revision_id is not null
    -> reviewed_by_identity_id is not null
    -> reviewed_by_membership_id is not null
    -> reviewed_at is not null
```

Approved content must reference an immutable Approved revision.

---

# Rejected Memory Constraint

Recommended conceptual constraint:

```text
status = Rejected
    -> reviewed_revision_id is not null
    -> reviewed_by_identity_id is not null
    -> reviewed_by_membership_id is not null
    -> reviewed_at is not null
```

A later Human command creates or reopens a Generated revision.

---

# Memory Generation Attribution

Generated Memory is created by the System.

Recommended fields:

```text
generated_by_system_principal_id

generation_policy_version

generated_at
```

The source WorkCompleted event preserves the Human completion actor.

---

# Memory Source References

If Memory content references multiple source items, use:

```text
memory_source_references
- memory_source_reference_id
- organization_id
- memory_id
- memory_revision_id
- source_type
- source_id
- source_version
- source_label
- created_at
```

Source reference rows are owned by the Memory Aggregate or revision.

---

# Source Reference Types

Recommended values:

```text
Work

Decision

WorkEvent

DecisionRevision

ExternalReference
```

External references should remain bounded and validated.

---

# Memory Secretary Contributions

Recommended table:

```text
memory_secretary_contributions
- contribution_id
- organization_id
- memory_id
- memory_revision_id
- secretary_principal_id
- requested_by_identity_id
- requested_by_membership_id
- contribution_type
- content
- generation_id
- created_at
- adopted_at
- adopted_by_identity_id
```

Secretary Contributions do not approve or submit Memory.

---

# Memory Indexes

Recommended indexes:

```sql
CREATE INDEX ix_memories_organization_status
ON memories (
    organization_id,
    status
);
```

```sql
CREATE INDEX ix_memories_source_work
ON memories (
    organization_id,
    source_work_id
);
```

```sql
CREATE INDEX ix_memories_in_review
ON memories (
    organization_id,
    submitted_at
)
WHERE status = 'InReview';
```

```sql
CREATE INDEX ix_memory_revisions_memory_number
ON memory_revisions (
    memory_id,
    revision_number DESC
);
```

---

# Memory Root Conceptual DDL

```sql
CREATE TABLE memories (
    memory_id                         uuid PRIMARY KEY,
    organization_id                   uuid NOT NULL,
    source_work_id                    uuid NOT NULL,
    status                            text NOT NULL,
    is_active                         boolean NOT NULL,

    current_revision_id               uuid NOT NULL,
    current_revision_number           integer NOT NULL,

    generation_policy_version         integer NOT NULL,
    generated_by_system_principal_id  text NOT NULL,
    generated_at                      timestamptz NOT NULL,

    submitted_revision_id             uuid NULL,
    submitted_by_identity_id          uuid NULL,
    submitted_by_membership_id        uuid NULL,
    submitted_at                      timestamptz NULL,

    reviewed_revision_id              uuid NULL,
    reviewed_by_identity_id           uuid NULL,
    reviewed_by_membership_id         uuid NULL,
    review_note                       text NULL,
    reviewed_at                       timestamptz NULL,

    version                           bigint NOT NULL,
    created_at                        timestamptz NOT NULL,
    updated_at                        timestamptz NOT NULL,

    CONSTRAINT uq_memories_organization_memory
        UNIQUE (
            organization_id,
            memory_id
        ),

    CONSTRAINT ck_memories_version
        CHECK (
            version > 0
        ),

    CONSTRAINT ck_memories_revision_number
        CHECK (
            current_revision_number > 0
        ),

    CONSTRAINT ck_memories_generation_policy
        CHECK (
            generation_policy_version > 0
        )
);
```

---

# Human Identity Persistence Model

The Human Identity Aggregate owns:

- stable internal identity
- lifecycle status
- profile identity fields
- authentication subject mappings
- optimistic concurrency version

---

# Human Identity Table

Recommended table:

```text
human_identities
```

Conceptual structure:

```text
human_identities
- identity_id
- status
- display_name
- primary_email
- locale
- version
- created_at
- updated_at
- disabled_at
```

---

# Human Identity Status Values

```text
Active

Disabled
```

Recommended constraint:

```sql
ALTER TABLE human_identities
ADD CONSTRAINT ck_human_identities_status
CHECK (
    status IN (
        'Active',
        'Disabled'
    )
);
```

---

# Primary Email

Recommended storage:

```text
primary_email

primary_email_normalized
```

Email is a lookup and communication field.

It is not the authoritative identity key.

---

# Email Uniqueness

Global email uniqueness is optional and depends on authentication policy.

The architecture must not assume:

```text
one email = one Human Identity
```

unless the identity provider and product policy explicitly guarantee it.

Authentication subject mapping remains authoritative for login resolution.

---

# Authentication Subject Table

Recommended table:

```text
authentication_subjects
```

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
- created_at
```

---

# Active Authentication Subject Uniqueness

Recommended index:

```sql
CREATE UNIQUE INDEX uq_authentication_subjects_active
ON authentication_subjects (
    provider,
    issuer,
    subject
)
WHERE unlinked_at IS NULL;
```

---

# Final Authentication Method

The database may not be able to enforce that an Active Human Identity retains at least one usable authentication method.

This is coordinated by the Application Layer and identity-provider integration.

---

# Human Identity Indexes

Recommended indexes:

```sql
CREATE INDEX ix_human_identities_status
ON human_identities (
    status
);
```

```sql
CREATE INDEX ix_human_identities_primary_email
ON human_identities (
    primary_email_normalized
);
```

```sql
CREATE INDEX ix_authentication_subjects_identity
ON authentication_subjects (
    identity_id
)
WHERE unlinked_at IS NULL;
```

---

# Organization Persistence Model

The Organization Aggregate owns:

- Organization identity
- display name
- lifecycle status
- creation attribution
- optimistic concurrency version

---

# Organization Table

Recommended table:

```text
organizations
```

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
- suspension_reason
- archived_at
- archive_reason
```

---

# Organization Status Values

```text
Active

Suspended

Archived
```

Recommended constraint:

```sql
ALTER TABLE organizations
ADD CONSTRAINT ck_organizations_status
CHECK (
    status IN (
        'Active',
        'Suspended',
        'Archived'
    )
);
```

---

# Organization Lifecycle Timestamp Constraints

Conceptual rules:

```text
Active
    -> archived_at is null

Suspended
    -> suspended_at is not null

Archived
    -> archived_at is not null
```

The Domain Aggregate owns transition validity.

---

# Organization Name

Organization name is not globally unique.

An optional Organization slug may use a separate uniqueness policy.

The slug must not replace:

```text
organization_id
```

as the authoritative identifier.

---

# Organization Indexes

Recommended:

```sql
CREATE INDEX ix_organizations_status
ON organizations (
    status
);
```

A name-search index may be added only when required by an authorized directory use case.

---

# Membership Persistence Model

The Membership Aggregate owns:

- Membership identity
- Organization-to-Human relationship
- lifecycle status
- invitation metadata
- role assignments
- suspension and revocation metadata
- optimistic concurrency version

---

# Membership Table

Recommended table:

```text
memberships
```

Conceptual structure:

```text
memberships
- membership_id
- organization_id
- identity_id
- pending_invitee_email
- pending_invitee_email_normalized
- status
- invited_by_identity_id
- invited_by_membership_id
- invited_at
- activated_at
- suspended_by_identity_id
- suspended_at
- suspension_reason
- revoked_by_identity_id
- revoked_at
- revocation_reason
- version
- created_at
- updated_at
```

---

# Membership Status Values

```text
Invited

Active

Suspended

Revoked
```

Recommended constraint:

```sql
ALTER TABLE memberships
ADD CONSTRAINT ck_memberships_status
CHECK (
    status IN (
        'Invited',
        'Active',
        'Suspended',
        'Revoked'
    )
);
```

---

# Membership Identity Constraint

An Invited Membership for an unknown Human may have:

```text
identity_id = NULL
```

and:

```text
pending_invitee_email_normalized IS NOT NULL
```

An Active, Suspended, or Revoked Membership must have:

```text
identity_id IS NOT NULL
```

Recommended check:

```sql
ALTER TABLE memberships
ADD CONSTRAINT ck_memberships_identity_state
CHECK (
    (
        status = 'Invited'
        AND (
            identity_id IS NOT NULL
            OR pending_invitee_email_normalized IS NOT NULL
        )
    )
    OR
    (
        status IN (
            'Active',
            'Suspended',
            'Revoked'
        )
        AND identity_id IS NOT NULL
    )
);
```

---

# Membership Uniqueness

For known Human Identities:

```sql
CREATE UNIQUE INDEX uq_memberships_organization_identity
ON memberships (
    organization_id,
    identity_id
)
WHERE identity_id IS NOT NULL;
```

For pending invitations:

```sql
CREATE UNIQUE INDEX uq_memberships_pending_invitation
ON memberships (
    organization_id,
    pending_invitee_email_normalized
)
WHERE status = 'Invited'
  AND identity_id IS NULL;
```

---

# Membership Composite Key

Recommended additional uniqueness:

```sql
ALTER TABLE memberships
ADD CONSTRAINT uq_memberships_organization_membership
UNIQUE (
    organization_id,
    membership_id
);
```

This supports safe composite foreign keys from Organization-owned resources.

---

# Membership Role Assignment Table

Recommended table:

```text
membership_role_assignments
```

Conceptual structure:

```text
membership_role_assignments
- role_assignment_id
- organization_id
- membership_id
- role
- assigned_by_identity_id
- assigned_by_membership_id
- assigned_at
- revoked_by_identity_id
- revoked_by_membership_id
- revoked_at
- revocation_reason
```

---

# Supported Role Values

```text
OrganizationOwner

OrganizationAdmin

Member

Reviewer
```

Recommended check:

```sql
ALTER TABLE membership_role_assignments
ADD CONSTRAINT ck_membership_role_assignments_role
CHECK (
    role IN (
        'OrganizationOwner',
        'OrganizationAdmin',
        'Member',
        'Reviewer'
    )
);
```

---

# Active Role Uniqueness

```sql
CREATE UNIQUE INDEX uq_membership_role_assignments_active
ON membership_role_assignments (
    membership_id,
    role
)
WHERE revoked_at IS NULL;
```

---

# Membership Role Organization Constraint

Recommended composite foreign key:

```sql
FOREIGN KEY (
    organization_id,
    membership_id
)
REFERENCES memberships (
    organization_id,
    membership_id
);
```

---

# Active Owner Query

Recommended index:

```sql
CREATE INDEX ix_membership_roles_active_owners
ON membership_role_assignments (
    organization_id,
    membership_id
)
WHERE role = 'OrganizationOwner'
  AND revoked_at IS NULL;
```

Membership status must also be Active for the Member to count as an active Owner.

---

# Last Owner Invariant

A standard foreign key or unique constraint cannot fully enforce:

```text
Active Organization must have at least one active Owner
```

The Application Layer must use:

- Organization-scoped advisory lock
- locked owner-count query
- transactional recheck
- atomic role mutation

A database trigger may supplement this rule, but the primary workflow remains explicit.

---

# Organization Invitation Table

Recommended table:

```text
organization_invitations
```

Conceptual structure:

```text
organization_invitations
- invitation_id
- organization_id
- membership_id
- invitation_version
- token_hash
- status
- expires_at
- consumed_at
- revoked_at
- created_at
- updated_at
```

---

# Invitation Status Values

```text
Pending

Consumed

Revoked

Expired
```

Recommended constraint:

```sql
ALTER TABLE organization_invitations
ADD CONSTRAINT ck_organization_invitations_status
CHECK (
    status IN (
        'Pending',
        'Consumed',
        'Revoked',
        'Expired'
    )
);
```

---

# Invitation Token Security

Store:

```text
token_hash
```

Do not store the raw token.

Recommended uniqueness:

```sql
ALTER TABLE organization_invitations
ADD CONSTRAINT uq_organization_invitations_token_hash
UNIQUE (
    token_hash
);
```

---

# Invitation Version

When an invitation is resent:

```text
invitation_version
```

increments.

Only the current Pending invitation credential remains usable.

Recommended uniqueness:

```sql
ALTER TABLE organization_invitations
ADD CONSTRAINT uq_organization_invitations_membership_version
UNIQUE (
    membership_id,
    invitation_version
);
```

---

# Membership Indexes

Recommended:

```sql
CREATE INDEX ix_memberships_organization_status
ON memberships (
    organization_id,
    status
);
```

```sql
CREATE INDEX ix_memberships_identity
ON memberships (
    identity_id
)
WHERE identity_id IS NOT NULL;
```

```sql
CREATE INDEX ix_memberships_pending_email
ON memberships (
    organization_id,
    pending_invitee_email_normalized
)
WHERE status = 'Invited';
```

---

# Authorization Persistence Model

Authorization uses:

- active Membership status
- active Role Assignments
- version-controlled permission mappings
- resource relationships
- authorization audit records
- System principal capability mappings

---

# Permission Definition Table

Recommended table:

```text
permission_definitions
```

Conceptual structure:

```text
permission_definitions
- permission_name
- description
- category
- introduced_in_version
- deprecated_at
```

Example permission names:

```text
work.create

work.complete

decision.approve

memory.approve

organization.manage_members
```

---

# Role Permission Mapping Table

Recommended table:

```text
role_permission_mappings
```

Conceptual structure:

```text
role_permission_mappings
- role
- permission_name
- permission_model_version
- enabled
- created_at
- deprecated_at
```

Recommended uniqueness:

```sql
ALTER TABLE role_permission_mappings
ADD CONSTRAINT uq_role_permission_mapping
UNIQUE (
    role,
    permission_name,
    permission_model_version
);
```

---

# Policy Version Table

Recommended table:

```text
authorization_policy_versions
```

Conceptual structure:

```text
authorization_policy_versions
- policy_version
- status
- activated_at
- retired_at
- description
```

MVP policy definitions may remain in code.

The table records deployed or active versions for auditability.

---

# System Principal Table

Recommended table:

```text
system_principals
```

Conceptual structure:

```text
system_principals
- system_principal_id
- status
- description
- created_at
- disabled_at
```

Supported status values:

```text
Active

Disabled
```

---

# System Principal Capability Table

Recommended table:

```text
system_principal_capabilities
```

Conceptual structure:

```text
system_principal_capabilities
- system_principal_id
- capability
- granted_at
- revoked_at
```

Recommended active uniqueness:

```sql
CREATE UNIQUE INDEX uq_system_principal_capabilities_active
ON system_principal_capabilities (
    system_principal_id,
    capability
)
WHERE revoked_at IS NULL;
```

---

# Secretary Principal Table

If Secretary identities require persistence, use:

```text
secretary_principals
- secretary_principal_id
- status
- capability_set_version
- created_at
- disabled_at
```

Secretary principals must not be linked to:

```text
memberships

membership_role_assignments
```

---

# Authorization Audit Table

Recommended table:

```text
authorization_audit_records
```

Conceptual structure:

```text
authorization_audit_records
- authorization_audit_id
- request_id
- command_id
- correlation_id
- principal_id
- principal_type
- identity_id
- membership_id
- organization_id
- command_type
- permission
- resource_type
- resource_id
- policy_id
- policy_version
- outcome
- reason_code
- evaluated_at
- resulting_event_id
- created_at
```

---

# Authorization Audit Outcome

Supported values:

```text
Allow

Deny
```

Recommended constraint:

```sql
ALTER TABLE authorization_audit_records
ADD CONSTRAINT ck_authorization_audit_outcome
CHECK (
    outcome IN (
        'Allow',
        'Deny'
    )
);
```

---

# Authorization Audit Immutability

The audit repository should expose:

```text
Insert
```

only.

Database permissions should deny ordinary:

```text
UPDATE

DELETE
```

for the application role.

---

# Authorization Audit Indexes

Recommended:

```sql
CREATE INDEX ix_authorization_audit_correlation
ON authorization_audit_records (
    correlation_id
);
```

```sql
CREATE INDEX ix_authorization_audit_organization_time
ON authorization_audit_records (
    organization_id,
    evaluated_at DESC
);
```

```sql
CREATE INDEX ix_authorization_audit_principal_time
ON authorization_audit_records (
    principal_id,
    evaluated_at DESC
);
```

```sql
CREATE INDEX ix_authorization_audit_denials
ON authorization_audit_records (
    organization_id,
    reason_code,
    evaluated_at DESC
)
WHERE outcome = 'Deny';
```

---

# Command Idempotency Persistence

Every authoritative command carries:

```text
command_id
```

The system records completed command processing.

Recommended table:

```text
processed_commands
```

---

# Processed Command Table

Conceptual structure:

```text
processed_commands
- command_id
- command_type
- organization_id
- principal_id
- aggregate_type
- aggregate_id
- request_hash
- status
- result_payload
- correlation_id
- processed_at
- expires_at
```

---

# Processed Command Status

Recommended values:

```text
Processing

Completed

Failed
```

For the MVP, a simpler immutable Completed record may be used when commands are processed within one short transaction.

---

# Processed Command Uniqueness

Recommended primary key:

```text
command_id
```

If command identifiers are scoped per Organization:

```text
PRIMARY KEY (
    organization_id,
    command_id
)
```

Global command identifiers are simpler and preferred.

---

# Request Hash

The `request_hash` detects command identifier reuse with different intent.

When:

```text
same command_id

different request_hash
```

the request fails.

---

# Processed Command Result

`result_payload` stores a bounded application result required to answer duplicate requests.

It must not store:

- secrets
- large content
- unnecessary domain snapshots

---

# Processed Command Atomicity

The following must commit atomically:

```text
Aggregate change

Outbox events

Processed command record

Required authorization audit metadata
```

---

# Transactional Outbox Persistence

The primary Outbox table was defined in the Events and Transactional Outbox architecture.

Recommended table:

```text
outbox_messages
```

Required fields include:

```text
outbox_id
event_id
event_type
event_category
schema_version
aggregate_type
aggregate_id
aggregate_version
event_sequence
organization_id
payload
headers
occurred_at
recorded_at
correlation_id
causation_id
actor_reference
status
attempt_count
next_attempt_at
locked_by
locked_until
published_at
last_error_code
last_error_message
```

---

# Event Stream Position

Recommended uniqueness:

```sql
ALTER TABLE outbox_messages
ADD CONSTRAINT uq_outbox_stream_position
UNIQUE (
    aggregate_type,
    aggregate_id,
    aggregate_version,
    event_sequence
);
```

---

# Outbox Actor Reference

The ActorReference may be stored as:

```text
jsonb
```

or normalized columns:

```text
actor_type
actor_id
actor_membership_id
```

For authority-sensitive queries, normalized columns are easier to constrain and index.

---

# Recommended Outbox Actor Columns

Recommended normalized structure:

```text
actor_type
actor_id
actor_membership_id
actor_display_name_snapshot
```

A JSONB metadata field may supplement these columns.

---

# Processed Event Persistence

Recommended table:

```text
processed_events
```

Primary key:

```text
consumer_name + event_id
```

Required fields include:

```text
consumer_name
event_id
event_type
schema_version
organization_id
aggregate_type
aggregate_id
aggregate_version
correlation_id
status
attempt_count
processing_started_at
processed_at
handler_version
result_reference
last_error_code
last_error_message
locked_by
locked_until
claim_version
```

---

# Processed Event Constraints

Recommended status values:

```text
Processing

Processed

RetryPending

Failed

Skipped
```

Recommended attempt constraint:

```text
attempt_count >= 0
```

Recommended claim constraint:

```text
Processing
    -> locked_by is not null
    -> locked_until is not null
```

---

# Dead Letter Persistence

Recommended table:

```text
dead_letter_events
```

Conceptual structure:

```text
dead_letter_events
- dead_letter_id
- consumer_name
- event_id
- organization_id
- failure_category
- error_code
- error_reference
- status
- assigned_to_identity_id
- first_failed_at
- last_failed_at
- resolved_at
- resolution
- replay_id
- created_at
- updated_at
```

---

# Dead Letter Status Values

```text
Open

Investigating

ReadyForReplay

Resolved

Skipped
```

The original event remains in immutable event storage.

The dead-letter record stores processing failure metadata.

---

# Replay Persistence

Recommended table:

```text
event_replays
```

Conceptual structure:

```text
event_replays
- replay_id
- original_event_id
- consumer_name
- organization_id
- replay_mode
- requested_by_identity_id
- requested_by_membership_id
- reason
- status
- handler_version
- started_at
- completed_at
- result
- created_at
```

---

# Replay Status Values

```text
Requested

Validating

Running

Completed

Failed

Cancelled
```

---

# Replay Immutability

The replay record may transition operational status.

The original event fields must not be copied and edited as a replacement event.

---

# Reconciliation Finding Persistence

Recommended table:

```text
reconciliation_findings
```

Conceptual structure:

```text
reconciliation_findings
- finding_id
- finding_type
- severity
- organization_id
- source_event_id
- aggregate_type
- aggregate_id
- consumer_name
- membership_id
- resource_type
- resource_id
- status
- detected_at
- recovery_scheduled_at
- resolved_at
- resolution_reference
- created_at
- updated_at
```

---

# Reconciliation Finding Status Values

```text
Open

RecoveryScheduled

Resolved

AcceptedRisk

FalsePositive
```

---

# Reconciliation Finding Uniqueness

To prevent duplicate unresolved findings:

```sql
CREATE UNIQUE INDEX uq_reconciliation_findings_open
ON reconciliation_findings (
    organization_id,
    finding_type,
    source_event_id,
    resource_type,
    resource_id
)
WHERE status IN (
    'Open',
    'RecoveryScheduled'
);
```

The exact key may vary by finding type.

---

# Memory Generation Attempt Persistence

Recommended table:

```text
memory_generation_attempts
```

Conceptual structure:

```text
memory_generation_attempts
- generation_attempt_id
- organization_id
- work_id
- source_event_id
- generation_policy_version
- status
- attempt_count
- started_at
- completed_at
- model_reference
- prompt_template_version
- output_schema_version
- last_error_code
- last_error_message
- created_at
- updated_at
```

---

# Memory Generation Attempt Status

```text
Pending

Generating

Generated

Failed

Abandoned
```

This table is operational metadata.

It is not the Memory Aggregate.

---

# Generation Attempt Uniqueness

Recommended business key:

```sql
CREATE UNIQUE INDEX uq_memory_generation_attempt_identity
ON memory_generation_attempts (
    work_id,
    generation_policy_version
)
WHERE status IN (
    'Pending',
    'Generating',
    'Generated'
);
```

The exact retry model may preserve multiple attempt rows under one stable generation operation.

---

# Domain Event Audit Link

Aggregate tables may store the latest resulting event identifier only when operationally useful.

The authoritative event relation remains in the Outbox or event archive.

Avoid adding generic:

```text
last_event_id
```

to every Aggregate unless a concrete query requires it.

---

# Foreign Key Strategy

Foreign keys should protect structural relationships without creating unmanageable circular dependencies.

Recommended principles:

- use foreign keys for stable Aggregate identities
- use composite Organization foreign keys
- use `RESTRICT` for authoritative Roots
- use cascade only for true owned children
- use deferrable constraints for exceptional coordinated creation
- avoid foreign keys from permanent events to mutable operational tables when retention differs

---

# Event Foreign Keys

Outbox and event archive tables should not require foreign keys to Aggregate Root rows when Aggregate retention may differ.

Instead, store immutable identifiers.

This allows:

- archived event retention
- repair tooling
- future Aggregate archival
- independent Outbox cleanup

---

# Audit Foreign Keys

Audit records may use soft references rather than strict foreign keys for:

- principals
- resources
- deleted technical records

Historical audit must remain readable even when a referenced operational record is archived.

For durable Human Identity and Organization rows, foreign keys may still be appropriate.

---

# Actor Reference Foreign Keys

Human actor fields may reference:

```text
human_identities.identity_id

memberships.membership_id
```

Because ordinary hard deletion is prohibited, these references remain stable.

Secretary and System actor identifiers belong to separate tables.

A polymorphic ActorReference cannot be represented by one ordinary foreign key.

---

# Polymorphic Actor Persistence

Recommended approach:

```text
actor_type
human_identity_id
human_membership_id
secretary_principal_id
system_principal_id
```

with a check constraint ensuring only the relevant columns are populated.

---

# Actor Constraint Example

Conceptual rule:

```text
HumanMember
    -> human_identity_id is not null
    -> human_membership_id is not null
    -> secretary_principal_id is null
    -> system_principal_id is null
```

```text
Secretary
    -> secretary_principal_id is not null
    -> Human fields are null
```

```text
System
    -> system_principal_id is not null
    -> Human fields are null
```

---

# Review Record Tables

Review metadata may remain on Aggregate Root tables when one final review outcome exists.

Dedicated review-history tables are appropriate when the product later requires:

- multiple reviewers
- review comments
- voting
- staged approval
- review reassignment
- quorum

These are outside the MVP.

---

# Human Review Attribution

For the MVP, the following Root fields are sufficient:

```text
submitted_by_identity_id

submitted_by_membership_id

reviewed_by_identity_id

reviewed_by_membership_id

reviewed_at
```

The immutable revision identifies exactly what was reviewed.

---

# Database-Level Human Authority Constraints

Where practical, authoritative review tables should reference Human Identity and Membership directly.

This structurally prevents using a System or Secretary principal identifier in Human reviewer fields.

The Domain and Authorization Layers still validate actual permission.

---

# Read Model Tables

Possible MVP read-model tables include:

```text
decision_review_queue

memory_review_queue

completed_work_projection

organization_member_directory

inactive_assignment_queue
```

---

# Decision Review Queue

Conceptual structure:

```text
decision_review_queue
- organization_id
- decision_id
- submitted_revision_id
- submitted_at
- submitted_by_identity_id
- assigned_reviewer_membership_id
- priority
- projection_version
- updated_at
```

This table is eventually consistent.

It must not be used to approve a Decision directly.

---

# Memory Review Queue

Conceptual structure:

```text
memory_review_queue
- organization_id
- memory_id
- source_work_id
- submitted_revision_id
- submitted_at
- assigned_reviewer_membership_id
- projection_version
- updated_at
```

---

# Organization Member Directory

Conceptual structure:

```text
organization_member_directory
- organization_id
- membership_id
- identity_id
- display_name
- membership_status
- active_roles
- projection_version
- updated_at
```

This projection may be used for display and search.

Current authorization must still use authoritative Membership and role data.

---

# Read Model Constraints

Read models may use denormalized JSON or arrays.

They must:

- store source version
- be idempotently updated
- support rebuild
- remain Organization-scoped
- never become authoritative mutation targets

---

# Database Constraint Summary

Recommended key constraints include:

```text
Work status and Completion Gate consistency

Decision status and outcome consistency

One Draft Decision revision

Immutable submitted Decision revisions

Memory status and review consistency

One active Memory per Work

One editable Memory revision

Stable Human Identity

Unique active authentication subject mapping

Unique Membership per Organization and Identity

Unique active role assignment

Last Owner transactional protection

Unique commandId

Unique eventId

Unique event stream position

Unique consumerName and eventId

Unique active reconciliation finding
```

---

# Part 2 Data Ownership Summary

## Work Module

Owns:

```text
work_items

work_participants
```

---

## Decision Module

Owns:

```text
decisions

decision_revisions

decision_revision_options

decision_secretary_contributions
```

---

## Memory Module

Owns:

```text
memories

memory_revisions

memory_source_references

memory_secretary_contributions

memory_generation_attempts
```

---

## Identity Module

Owns:

```text
human_identities

authentication_subjects
```

---

## Organization Module

Owns:

```text
organizations
```

---

## Membership Module

Owns:

```text
memberships

membership_role_assignments

organization_invitations
```

---

## Authorization Module

Owns:

```text
permission_definitions

role_permission_mappings

authorization_policy_versions

authorization_audit_records

system_principals

system_principal_capabilities

secretary_principals
```

---

## Events Module

Owns:

```text
outbox_messages

processed_events

dead_letter_events

event_replays

reconciliation_findings
```

---

## Projection Module

May own:

```text
decision_review_queue

memory_review_queue

completed_work_projection

organization_member_directory

inactive_assignment_queue
```

---

# Part 2 Invariants

The concrete data model must preserve:

1. Work Completion Gate field combinations are structurally valid.
2. Completed Work contains explicit Human attribution.
3. Decision Draft revisions are editable.
4. Submitted Decision revisions are immutable.
5. Decision outcomes reference the reviewed revision.
6. Decision approval does not update Work directly.
7. Memory references one source Work.
8. Only one active Memory exists per Work.
9. Approved Memory references immutable approved content.
10. Secretary Contributions remain separate from authoritative content.
11. Human Identity remains stable across provider changes.
12. Membership is unique within an Organization.
13. Roles are Membership-scoped.
14. Active role assignments are unique.
15. Organization ownership remains Human and auditable.
16. Invitation tokens are hashed and single-use.
17. Authorization audit is append-only.
18. Commands are idempotent by commandId.
19. Events are unique and stream-positioned.
20. Consumer effects are idempotent by consumerName and eventId.
21. Reconciliation findings do not directly mutate domain state.
22. Organization composite foreign keys prevent tenant leakage.
23. System and Secretary principals cannot be stored as Human reviewers.
24. Ordinary lifecycle does not hard-delete authoritative history.
25. All mutable Aggregate Roots use optimistic concurrency versions.

---

# Part 2 Design Summary

The PostgreSQL model maps each Aggregate to a clear Root table and a bounded set of owned child tables.

The design uses:

```text
Relational Constraints

Composite Organization Foreign Keys

Immutable Revision Rows

Partial Unique Indexes

Stable Human References

Transactional Idempotency Records

Durable Event Processing Tables
```

The database protects structural consistency.

Aggregates remain responsible for business lifecycle decisions.

Application Services coordinate the few workflows that require atomic changes across Aggregate boundaries.

# Transaction Management

Application Services own database transaction boundaries.

Aggregates, repositories, controllers, Workers, and external adapters must not independently commit partial business operations.

A transaction represents one authoritative persistence unit.

---

# Transaction Principles

Every state-changing transaction must be:

- explicit
- short-lived
- bounded
- Organization-scoped where applicable
- retry-safe
- compatible with optimistic concurrency
- atomic with required Outbox and idempotency records

---

# Standard Command Transaction

A standard single-Aggregate command follows:

```text
BEGIN

Check command idempotency

Resolve current authorization

Load Aggregate

Verify expected version

Execute Aggregate command

Save Aggregate

Persist child changes

Persist Domain Events to Outbox

Persist authorization audit metadata

Persist processed command result

COMMIT
```

If any required step fails:

```text
ROLLBACK
```

---

# Transaction Ownership

The Application Service decides:

- when the transaction begins
- which repositories participate
- which consistency level is required
- when the transaction commits
- which failures require rollback
- whether a safe retry is permitted

Repositories participate in the current transaction.

They must not silently create independent nested commits.

---

# Transaction Manager Interface

Conceptual interface:

```text
TransactionManager

Execute(
    transactionOptions,
    operation
) -> result
```

Possible transaction options include:

```text
isolationLevel

commandTimeout

readOnly

retryPolicy
```

---

# Default Isolation Level

Recommended MVP default:

```text
READ COMMITTED
```

PostgreSQL `READ COMMITTED` is sufficient for most Aggregate-oriented commands when combined with:

- optimistic concurrency
- explicit row locks where required
- unique constraints
- Organization-scoped advisory locks
- transactional revalidation

---

# Stronger Isolation

Stronger isolation may be used selectively.

Examples:

```text
REPEATABLE READ

SERIALIZABLE
```

Possible use cases:

- complex ownership invariants
- sensitive administrative coordination
- multi-row uniqueness not covered by constraints
- consistency-sensitive reporting transactions

Stronger isolation should not be applied globally without demonstrated need.

---

# Serializable Retry

A `SERIALIZABLE` transaction may fail with a serialization error.

The Application Layer may retry when:

- the command is idempotent
- the retry count is bounded
- current authorization is re-evaluated
- Aggregate state is reloaded
- business rules are re-executed
- external side effects have not occurred inside the transaction

---

# No External Calls Inside Transactions

The following must remain outside an open transaction:

- AI generation
- email delivery
- webhook delivery
- identity-provider API calls
- object-storage uploads
- notification-provider calls
- large report generation
- long-running search
- user interaction

---

# External Preparation Pattern

When external preparation is required:

```text
Load immutable input

↓

End read transaction

↓

Call external dependency

↓

Validate result

↓

BEGIN short write transaction

↓

Recheck idempotency

Recheck current target state

Persist authoritative result

Write Outbox

COMMIT
```

Memory generation uses this pattern.

---

# Coordinated Multi-Aggregate Transactions

A small number of workflows require atomic changes across multiple Aggregates.

Supported MVP examples:

```text
CreateOrganization

RequestBlockingDecision

AcceptInvitation with new Human Identity

TransferOrganizationOwnership
```

These workflows remain exceptional.

---

# Create Organization Transaction

Atomic participants:

```text
Organization Aggregate

Owner Membership Aggregate

OrganizationOwner Role Assignment

Outbox Events

Processed Command

Authorization Audit
```

The transaction must not expose an Active Organization without an active Human Owner.

---

# Request Blocking Decision Transaction

Atomic participants:

```text
Work Aggregate

Decision Aggregate

WorkDecisionRequested Event

DecisionCreated Event

Processed Command
```

The transaction establishes:

- Work references the blocking Decision
- Decision exists
- both resources belong to the same Organization

---

# Ownership Transfer Transaction

Atomic participants:

```text
Source Membership Aggregate

Target Membership Aggregate

Owner Assignment

Optional Owner Revocation

Ownership Transfer Event

Processed Command
```

The transaction must preserve at least one active Owner throughout the committed result.

---

# Transaction Size

Transactions should touch the minimum number of rows required for the use case.

Avoid:

- loading entire Organization membership lists
- updating unrelated projections
- sending notifications
- processing multiple unrelated commands
- performing broad cleanup
- holding locks while waiting for external systems

---

# Transaction Timeout

Every write transaction should have a bounded timeout.

Timeouts should be shorter for:

- ordinary Work edits
- Decision review actions
- Membership role changes

Slightly longer limits may be required for:

- coordinated Organization bootstrap
- ownership transfer
- large Aggregate revision persistence

Timeouts must remain operational configuration, not domain behavior.

---

# Optimistic Concurrency

Every mutable Aggregate Root uses optimistic concurrency.

The caller may provide:

```text
expectedVersion
```

The repository verifies that the stored version still matches.

---

# Optimistic Update Pattern

```sql
UPDATE work_items
SET
    status = :status,
    completion_gate_type = :completion_gate_type,
    blocking_decision_id = :blocking_decision_id,
    decision_outcome = :decision_outcome,
    version = version + 1,
    updated_at = now()
WHERE organization_id = :organization_id
  AND work_id = :work_id
  AND version = :expected_version;
```

Expected result:

```text
rowsUpdated = 1
```

If:

```text
rowsUpdated = 0
```

the repository must distinguish where practical between:

- Aggregate not found
- Organization mismatch
- concurrency conflict

External responses must not reveal cross-Organization resource existence.

---

# Aggregate Version Increment

One successful Aggregate command increments the Aggregate Root version once.

Child row operations within the same command do not independently increment the Root multiple times.

Example:

```text
Decision EditDraft command

- updates revision content
- updates Decision root metadata

Result:
    Decision version 7 -> 8
```

---

# Multiple Domain Events per Version

One command may emit multiple Domain Events while producing one Aggregate version.

Ordering uses:

```text
aggregateVersion

eventSequence
```

Example:

```text
aggregateVersion = 5

eventSequence = 1
eventSequence = 2
```

---

# Concurrency Conflict Result

Recommended application result:

```text
ConcurrencyConflict
- aggregateType
- aggregateId
- expectedVersion
- currentVersion when safely available
```

The transport layer may return an HTTP conflict response.

---

# Human Command Retry

Human-facing clients should normally:

1. reload current state
2. show the updated state
3. ask the Human to confirm or repeat the action

Automatic retry is appropriate only when the command intent remains unquestionably unchanged.

Approval, rejection, completion, and ownership changes should not be silently reinterpreted after concurrent updates.

---

# Worker Concurrency Retry

Background handlers may automatically retry optimistic concurrency conflicts.

The handler must:

- reload the Aggregate
- re-evaluate event applicability
- invoke the Aggregate command again
- respect processed-event idempotency
- use a bounded retry count

---

# Revision Concurrency

Decision and Memory revision edits must protect against concurrent editing.

Recommended approach:

```text
Aggregate expectedVersion

+

Revision content hash or revision version
```

The Aggregate Root version is the primary concurrency control.

---

# Draft Edit Conflict

Example:

```text
Human A loads Decision version 4

Human B edits and saves version 5

Human A submits edit expecting version 4
```

Result:

```text
ConcurrencyConflict
```

Human A’s content must not overwrite Human B’s change silently.

---

# Immutable Revision Protection

Optimistic concurrency protects active editing.

Immutability protection prevents later edits to locked revisions.

Both are required.

---

# PostgreSQL Locking

Pessimistic locking is used only for invariants that cannot be protected sufficiently by Aggregate versioning and ordinary constraints.

Supported mechanisms include:

- row-level locks
- advisory transaction locks
- `FOR UPDATE`
- `FOR UPDATE SKIP LOCKED`
- deferrable constraints

---

# Row-Level Locking

Use row-level locks when coordinating a known set of records.

Example:

```sql
SELECT membership_id
FROM memberships
WHERE organization_id = :organization_id
  AND membership_id IN (
      :source_membership_id,
      :target_membership_id
  )
FOR UPDATE;
```

Locks must be acquired in deterministic order.

---

# Deterministic Lock Order

When locking multiple rows:

```text
sort by stable identifier

lock in ascending order
```

This reduces deadlock risk.

Example:

```text
membership-100

before

membership-200
```

---

# Advisory Locks

PostgreSQL advisory transaction locks are appropriate for logical scopes that do not map to one row.

Examples:

```text
Organization ownership scope

Aggregate event publication stream

Memory generation identity
```

---

# Transaction-Scoped Advisory Lock

Recommended form:

```sql
SELECT pg_advisory_xact_lock(:lock_key);
```

The lock is released automatically when the transaction ends.

Session-scoped locks should be avoided for ordinary application workflows.

---

# Advisory Lock Key

The lock key must be derived deterministically from the protected logical scope.

Examples:

```text
organization-owner:<organizationId>

event-stream:<aggregateType>:<aggregateId>

memory-generation:<organizationId>:<workId>
```

The hashing strategy must minimize collisions.

---

# Last Owner Lock

The Last Owner Invariant spans multiple Membership Aggregates.

Optimistic concurrency on one Membership is insufficient.

Recommended workflow:

```text
BEGIN

Acquire Organization ownership advisory lock

Load Organization

Verify Organization status

Load target Membership

Count active Owners

Evaluate requested change

Apply role or Membership mutation

Recount active Owners

Require activeOwnerCount >= 1
    when Organization remains Active

Persist changes and events

COMMIT
```

---

# Active Owner Definition

A Human counts as an active Owner only when all are true:

```text
Organization.status = Active

HumanIdentity.status = Active

Membership.status = Active

OrganizationOwner role assignment is active
```

A revoked role or inactive Membership does not count.

---

# Last Owner Query

Conceptual query:

```sql
SELECT COUNT(DISTINCT m.membership_id)
FROM memberships m
JOIN human_identities h
  ON h.identity_id = m.identity_id
JOIN membership_role_assignments r
  ON r.membership_id = m.membership_id
 AND r.organization_id = m.organization_id
WHERE m.organization_id = :organization_id
  AND m.status = 'Active'
  AND h.status = 'Active'
  AND r.role = 'OrganizationOwner'
  AND r.revoked_at IS NULL;
```

The query executes while the Organization ownership scope is locked.

---

# Owner Assignment Lock

The same ownership lock must be used for:

- assigning OrganizationOwner
- revoking OrganizationOwner
- suspending an Owner Membership
- revoking an Owner Membership
- Owner leaving the Organization
- disabling an Owner Identity
- ownership transfer
- relevant Organization archival operations

Using one lock scope prevents incompatible concurrent workflows.

---

# Last Owner Database Trigger

A database trigger may supplement Last Owner protection.

However, trigger-only enforcement is not preferred because:

- the rule spans multiple tables
- errors are harder to express
- lifecycle context may be unclear
- testing is more complex
- Application Services still need predictable behavior

The explicit transaction workflow remains authoritative.

---

# Deadlock Handling

PostgreSQL may detect and abort a transaction involved in a deadlock.

The Application Layer may retry when:

- the command is idempotent
- no external side effect occurred
- lock order has been reviewed
- retry count is bounded
- all state and authorization are reloaded

Repeated deadlocks require operational investigation.

---

# Lock Timeout

Configure a bounded lock timeout for interactive operations.

A command should fail rather than wait indefinitely.

Recommended failure result:

```text
ResourceBusy

or

ConcurrencyConflict
```

The exact external mapping may vary.

---

# Outbox Worker Claims

Outbox publication uses short claim transactions.

Recommended query:

```sql
SELECT outbox_id
FROM outbox_messages
WHERE status = 'Pending'
  AND next_attempt_at <= now()
ORDER BY recorded_at, outbox_id
FOR UPDATE SKIP LOCKED
LIMIT :batch_size;
```

---

# Outbox Claim Update

Within the claim transaction:

```sql
UPDATE outbox_messages
SET
    status = 'Claimed',
    locked_by = :worker_id,
    locked_until = now() + :lease_duration,
    attempt_count = attempt_count + 1,
    first_attempt_at =
        COALESCE(first_attempt_at, now()),
    last_attempt_at = now()
WHERE outbox_id = ANY(:claimed_ids);
```

Publication occurs after commit.

---

# Consumer Worker Claims

Processed-event consumers use equivalent lease-based claiming.

The uniqueness key remains:

```text
consumer_name + event_id
```

A consumer must not hold target Aggregate locks while waiting for external dependencies.

---

# Claim Version

Recommended field:

```text
claim_version
```

Every claim or reclaim increments it.

A Worker updates the final status only when:

```text
workerId matches

AND

claimVersion matches
```

This prevents stale Worker completion from overwriting a newer claim.

---

# Expired Claim Recovery

A recovery Worker identifies:

```text
status = Claimed or Processing

AND

locked_until < now()
```

It then:

- clears lock ownership
- preserves attempt count
- schedules the next attempt
- records claim expiration
- does not alter immutable event content

---

# Index Strategy

Indexes must support real command, query, Worker, and reconciliation patterns.

Indexes should not be added speculatively without a query purpose.

---

# Index Design Principles

Indexes should prioritize:

- Organization scoping
- lifecycle status filtering
- active partial-row lookup
- foreign-key joins
- review queues
- Outbox and Worker claims
- idempotency lookup
- reconciliation
- optimistic update targeting

---

# Organization-First Indexes

Most Organization-owned list queries should begin with:

```text
organization_id
```

Example:

```sql
CREATE INDEX ix_decisions_organization_status
ON decisions (
    organization_id,
    status,
    updated_at DESC
);
```

---

# Equality Before Range

For common composite indexes:

```text
equality filters first

range or sort field later
```

Example:

```text
organization_id = ?

status = ?

submitted_at range or ordering
```

Recommended index:

```text
organization_id, status, submitted_at
```

---

# Partial Indexes

Partial indexes are preferred for small active subsets.

Examples:

```text
InReview Decisions

InReview Memories

Pending Outbox messages

Active role assignments

Active Work participants

Open reconciliation findings
```

---

# Decision Review Queue Index

```sql
CREATE INDEX ix_decisions_review_queue
ON decisions (
    organization_id,
    submitted_at,
    decision_id
)
WHERE status = 'InReview';
```

---

# Memory Review Queue Index

```sql
CREATE INDEX ix_memories_review_queue
ON memories (
    organization_id,
    submitted_at,
    memory_id
)
WHERE status = 'InReview'
  AND is_active = true;
```

---

# Pending Outbox Index

```sql
CREATE INDEX ix_outbox_messages_pending
ON outbox_messages (
    next_attempt_at,
    recorded_at,
    outbox_id
)
WHERE status = 'Pending';
```

The index should align with the Worker claim query.

---

# Retry Pending Consumer Index

```sql
CREATE INDEX ix_processed_events_retry
ON processed_events (
    next_attempt_at,
    first_received_at
)
WHERE status = 'RetryPending';
```

If `next_attempt_at` is stored in a separate consumer-delivery table, index that table instead.

---

# Foreign-Key Indexes

PostgreSQL does not automatically create indexes on referencing foreign-key columns.

Indexes should be added for frequently joined or validated relationships.

Examples:

```text
decision_revisions.decision_id

memory_revisions.memory_id

work_participants.work_id

work_participants.membership_id

membership_role_assignments.membership_id
```

---

# Unique Index Cost

Every unique constraint adds write cost.

Unique indexes should protect actual invariants such as:

- one Draft revision
- one active Memory
- one active role assignment
- one Membership per Organization and Identity
- one consumer result per event

They should not be used merely for presentation preferences.

---

# Index Naming

Use descriptive names:

```text
ix_<table>_<query-purpose>

uq_<table>_<invariant>
```

Avoid generic names such as:

```text
index1

idx_status
```

---

# Covering Indexes

PostgreSQL `INCLUDE` columns may reduce heap access for high-volume read paths.

Example:

```sql
CREATE INDEX ix_decisions_review_queue_covering
ON decisions (
    organization_id,
    submitted_at,
    decision_id
)
INCLUDE (
    submitted_revision_id,
    submitted_by_identity_id
)
WHERE status = 'InReview';
```

Covering indexes should be added only after measuring query benefit.

---

# Index Review

Index effectiveness should be reviewed using:

```text
EXPLAIN

EXPLAIN ANALYZE

pg_stat_user_indexes

pg_stat_statements
```

Unused or duplicate indexes should be removed through controlled migration.

---

# Query Patterns

The persistence model supports two primary query categories:

```text
Aggregate Commands

Read and Operational Queries
```

---

# Aggregate Command Queries

Aggregate loading queries should:

- require Organization scope
- load by Aggregate identifier
- load invariant-relevant child state
- avoid unrelated history
- return one Aggregate Root
- support optimistic concurrency

---

# Work Aggregate Load

Conceptual query flow:

```text
Load work_items row

Load active work_participants

Load invariant-relevant Decision association metadata

Hydrate Completion Gate

Construct Work Aggregate
```

Decision Aggregate state itself is not loaded into Work.

---

# Decision Aggregate Load

Conceptual query flow:

```text
Load decisions row

Load current revision

Load submitted or decided revision when required

Load Decision-owned options

Load invariant-relevant contribution metadata only when required

Construct Decision Aggregate
```

Large historical contribution lists should use Query Services instead.

---

# Memory Aggregate Load

Conceptual query flow:

```text
Load memories row

Load current revision

Load submitted or reviewed revision

Load source references required by invariants

Construct Memory Aggregate
```

The source Work Aggregate is not loaded into Memory.

---

# N+1 Query Avoidance

List screens must not load each Aggregate through its repository one at a time.

Incorrect:

```text
List 100 Decisions

↓

Load 100 Decision Aggregates individually
```

Correct:

```text
Use Decision Query Service

↓

Execute one bounded projection query
```

---

# Pagination

List queries must use bounded pagination.

Preferred for large datasets:

```text
keyset pagination
```

Example cursor:

```text
submitted_at + decision_id
```

Offset pagination may be acceptable for small administrative lists.

---

# Keyset Pagination Example

```sql
SELECT ...
FROM decisions
WHERE organization_id = :organization_id
  AND status = 'InReview'
  AND (
      submitted_at,
      decision_id
  ) > (
      :cursor_submitted_at,
      :cursor_decision_id
  )
ORDER BY
    submitted_at,
    decision_id
LIMIT :page_size;
```

---

# Search

The MVP may use PostgreSQL search capabilities for bounded domain text.

Possible approaches:

- `ILIKE` for small datasets
- trigram index
- full-text search
- dedicated projection table

Search must always apply Organization scope.

---

# Search Indexes

A trigram or full-text index should be introduced only for defined user-facing search requirements.

Search indexes must not include Restricted content unnecessarily.

---

# Count Queries

Exact counts over large datasets may be expensive.

Dashboards may use:

- bounded counts
- cached projections
- approximate operational metrics
- asynchronous summaries

Authorization-sensitive results must not rely on stale counts for permission.

---

# Query Timeouts

Interactive queries should have bounded statement timeouts.

Long analytical queries should run through:

- reporting jobs
- read replicas
- export workflows
- dedicated operational tooling

They must not block ordinary transactional workloads.

---

# Read Replicas

Read replicas are optional and outside the minimum MVP deployment.

When introduced, they may serve:

- dashboards
- exports
- audit browsing
- historical reporting

They must not serve current authorization or command preconditions when replication delay could grant invalid access.

---

# Authoritative Read Requirements

The following should use the primary authoritative database:

- Identity status
- Organization status
- Membership status
- active roles
- command idempotency
- Aggregate loading
- expected-version checks
- Last Owner checks
- active Memory uniqueness
- event-processing deduplication

---

# Data Retention

Retention periods must be defined per data category.

The architecture distinguishes:

```text
Authoritative Domain State

Domain Revision History

Security Audit

Event Delivery State

Processed Event State

Operational Failure Data

Read Models

Temporary Credentials
```

---

# Authoritative Domain Retention

The MVP preserves:

- Work
- Decision
- Memory
- Human Identity
- Organization
- Membership
- role history

through lifecycle state changes rather than ordinary hard deletion.

Final legal retention duration is product and compliance policy.

---

# Revision Retention

Decision and Memory revisions should be retained while their Aggregate is retained.

Submitted, reviewed, rejected, and approved revisions provide essential business history.

---

# Outbox Retention

Published Outbox rows may be removed or archived after:

- publication is confirmed
- replay requirements are satisfied
- consumer-redelivery window has passed
- audit requirements are satisfied
- event archive policy is confirmed

Pending, Claimed, or Failed rows must not be removed by routine cleanup.

---

# Processed Event Retention

Processed-event records must remain long enough to prevent duplicate effects from delayed redelivery or replay.

Deletion is safe only when:

- the source event cannot be redelivered
- broker retention has expired
- Outbox replay is unavailable
- business-level idempotency remains sufficient
- audit requirements are satisfied

---

# Processed Command Retention

Processed-command records should remain at least as long as clients may retry the command identifier.

High-authority commands may require longer retention.

Examples:

- Decision approval
- Work completion
- Membership revocation
- ownership transfer

---

# Invitation Retention

Raw invitation credentials are never retained.

Hashed invitation records may be retained for:

- replay protection
- abuse investigation
- invitation audit
- delivery troubleshooting

Expired and consumed records may later be archived.

---

# Authorization Audit Retention

Authorization audit typically requires longer retention than operational Worker state.

Retention must support:

- security investigation
- business accountability
- permission-history explanation
- compliance obligations

---

# Dead Letter Retention

Dead-letter records remain until:

- resolved
- replayed successfully
- explicitly skipped
- archived under an approved retention policy

Unresolved failures must not be automatically deleted.

---

# Read Model Retention

Read models are disposable when rebuildable.

They may be:

- truncated
- rebuilt
- replaced
- versioned

Rebuild must not affect authoritative tables.

---

# Archival

Archival moves infrequently accessed data out of hot operational paths while preserving required history.

Possible archival targets include:

- published Outbox messages
- processed-event history
- resolved reconciliation findings
- old authorization audit partitions
- archived Organization read models

---

# Organization Archival

Archiving an Organization changes the Organization lifecycle state.

It does not immediately move or delete all rows.

Operational consequences may include:

- blocking mutations
- revoking invitations
- invalidating sessions
- stopping scheduled jobs
- moving historical projections to cold storage later

---

# Archived Organization Queries

Archived data must remain Organization-scoped.

Archival must not merge data from multiple Organizations into an unscoped store.

---

# Table Partitioning

Partitioning is optional for the MVP.

Likely future partition candidates:

```text
outbox_messages

processed_events

authorization_audit_records

dead_letter_events

large operational history tables
```

---

# Partition Key

Time-based partitioning may use:

```text
recorded_at

processed_at

evaluated_at
```

Organization-based partitioning should be introduced only with clear operational justification.

---

# Partition Constraints

Partitioning must preserve:

- uniqueness strategy
- pending-row queries
- Organization isolation
- replay access
- migration safety
- backup and restore behavior

PostgreSQL uniqueness across partitions must be considered explicitly.

---

# Cleanup Jobs

Cleanup jobs must:

- process bounded batches
- use indexed predicates
- avoid long locks
- record progress
- be retryable
- preserve failed and pending data
- expose metrics

---

# Batched Cleanup Pattern

```sql
DELETE FROM outbox_messages
WHERE outbox_id IN (
    SELECT outbox_id
    FROM outbox_messages
    WHERE status = 'Published'
      AND published_at < :retention_cutoff
    ORDER BY published_at
    LIMIT :batch_size
);
```

The exact implementation may archive rows before deletion.

---

# Vacuum and Table Health

High-churn operational tables require monitoring of:

- dead tuples
- autovacuum activity
- table bloat
- index bloat
- transaction age
- lock contention

Likely high-churn tables include:

```text
outbox_messages

processed_events

memory_generation_attempts

reconciliation_findings
```

---

# Schema Migration Strategy

All schema changes are performed through version-controlled migrations.

Migrations must be:

- ordered
- repeatable in test environments
- forward-compatible during deployment
- observable
- reviewed by the owning module
- tested with production-like data volume

---

# Migration Ownership

Each module owns migrations for its tables.

Cross-module migrations require coordinated review.

Example:

```text
Work adds blocking_decision_id

Decision adds related_work_id
```

The migration plan must define safe deployment order and temporary compatibility.

---

# Migration Naming

Recommended naming:

```text
<sequence>_<module>_<description>
```

Example:

```text
0042_decision_add_revision_status.sql
```

Timestamp-based migration identifiers are also acceptable.

---

# Expand and Contract Pattern

Zero-downtime schema changes should use:

```text
Expand

Migrate

Switch

Contract
```

---

# Expand Phase

Add backward-compatible structures.

Examples:

- nullable column
- new table
- new index
- new event schema support
- dual-read capability

Old application versions must continue operating.

---

# Migrate Phase

Backfill or transform existing data.

The backfill must be:

- bounded
- resumable
- idempotent
- observable
- safe under concurrent writes

---

# Switch Phase

Deploy application code that uses the new structure.

Possible temporary behavior:

```text
dual write

read old with fallback

read new after validation
```

---

# Contract Phase

After all deployed code no longer depends on the old structure:

- remove obsolete columns
- remove old indexes
- remove temporary triggers
- stop dual writes
- tighten nullability
- add final constraints

Contract migrations must not occur prematurely.

---

# Adding a Required Column

Unsafe:

```sql
ALTER TABLE large_table
ADD COLUMN organization_id uuid NOT NULL;
```

when existing rows lack values.

Safer sequence:

1. add nullable column
2. deploy code writing the column
3. backfill existing rows
4. validate completeness
5. add foreign key as not valid where appropriate
6. validate foreign key
7. set `NOT NULL`

---

# PostgreSQL Constraint Validation

For large tables, a foreign key or check constraint may be added as:

```sql
NOT VALID
```

Then validated separately:

```sql
ALTER TABLE ...
VALIDATE CONSTRAINT ...;
```

This can reduce blocking during deployment.

The exact locking behavior must be tested.

---

# Index Creation

Large indexes should use:

```sql
CREATE INDEX CONCURRENTLY
```

where appropriate.

`CREATE INDEX CONCURRENTLY` cannot run inside an ordinary transaction block.

Migration tooling must support this explicitly.

---

# Unique Index Migration

Before creating a unique index:

- detect duplicates
- resolve conflicts
- prevent new duplicates
- backfill normalized values
- validate Organization scope

A failed unique-index build must not be ignored.

---

# Backfill Design

Every backfill requires:

```text
selection key

batch size

progress marker

retry strategy

concurrency behavior

validation query

rollback or remediation plan
```

---

# Backfill Batching

Use stable key ranges or keyset pagination.

Avoid one unbounded update transaction.

Example:

```text
Process 1,000 rows

Commit

Record cursor

Continue
```

---

# Backfill Idempotency

A backfill should safely run more than once.

Preferred update condition:

```text
WHERE new_column IS NULL
```

or equivalent state-based guard.

---

# Concurrent Write Safety

During backfill, new application writes must populate the new field.

Otherwise the backfill may never converge.

Possible strategies:

- application dual write
- temporary trigger
- database default
- write-path compatibility layer

---

# Backfill Validation

Validation should confirm:

- no missing required values
- no cross-Organization association
- no duplicate unique keys
- no invalid statuses
- no broken ActorReferences
- no orphaned child rows
- expected row counts
- Aggregate version consistency where relevant

---

# Data Migration and Domain Events

Schema backfills do not automatically represent business actions.

They should not emit false Domain Events.

Example:

```text
Populate organization_id from existing relationship
```

is a technical migration, not a new Organization assignment event.

---

# Business Migration Events

When migration intentionally changes business meaning, use a controlled domain migration plan.

It may require:

- explicit administrative command
- dedicated migration event
- audit record
- Human approval
- reconciliation

The distinction must be documented.

---

# Status Migration

When adding a new lifecycle state:

1. update Domain Model
2. update event contracts
3. update consumer compatibility
4. expand database check constraint
5. deploy compatible readers
6. deploy producers of the new state
7. test rollback limitations

---

# Check Constraint Migration

Changing a text-based status check often requires:

- dropping or replacing the old constraint
- adding a new compatible constraint
- validating existing rows

Deployment order must prevent old code from failing unexpectedly.

---

# Event Schema Migration

Event schema rollout follows:

```text
Consumers first

Producer second

Old schema support retained for replay
```

Database migrations must preserve immutable historical payloads.

---

# Aggregate Split Migration

Splitting one table into multiple Aggregate-owned tables is a major change.

It requires:

- new ownership definition
- dual-read or dual-write period
- backfill
- consistency validation
- cutover
- removal of old mutation path

Such a migration should not be undertaken casually during MVP.

---

# Migration Rollback

Not every migration is safely reversible.

The migration plan must classify:

```text
Fully Reversible

Application Rollback Compatible

Forward Fix Required
```

Dropping data or changing semantic meaning usually requires a forward fix rather than simple rollback.

---

# Deployment Compatibility Window

During rolling deployment, at least two adjacent application versions may run concurrently.

Schema changes must therefore support:

```text
old application version

new application version
```

for the defined deployment window.

---

# No Destructive Same-Release Change

Do not:

1. remove a column
2. deploy code that no longer uses it

in the same unsafe deployment step.

Deploy code compatibility before destructive contraction.

---

# Migration Testing

Migrations must be tested against:

- empty database
- current schema
- production-like row counts
- invalid historical edge cases
- rollback or forward-fix procedure
- concurrent application traffic where relevant
- backup restoration

---

# Schema Drift Detection

CI or deployment tooling should detect:

- unapplied migrations
- unexpected manual schema changes
- missing constraints
- missing indexes
- migration checksum changes
- module ownership violations

---

# Manual Database Changes

Untracked production schema changes are prohibited.

Emergency changes must be:

- approved
- recorded
- converted into version-controlled migration
- verified across environments
- audited

---

# Data Integrity Verification

Periodic integrity checks may verify:

```text
Active Organization has active Owner

Work and blocking Decision share Organization

Memory and source Work share Organization

Approved Memory references Approved revision

Decision outcome references reviewed revision

No duplicate active role assignments

No duplicate active Memory

No orphaned revision rows

No event stream-position duplicates
```

---

# Integrity Findings

Detected inconsistencies should create operational findings.

Repair must use:

- supported Application Services
- controlled migration tooling
- audited data-repair workflow

Routine Workers must not silently rewrite authoritative data.

---

# Part 3 Invariants

The persistence operation model must preserve:

1. Application Services own transaction boundaries.
2. Required writes commit atomically.
3. External calls do not hold open business transactions.
4. Mutable Aggregate Roots use optimistic concurrency.
5. Child changes increment the owning Root version.
6. Human authority commands are not silently retried after semantic conflict.
7. Last Owner operations use one Organization-scoped lock strategy.
8. Worker claims are leased and recoverable.
9. Stale Workers cannot overwrite newer claims.
10. Indexes correspond to real query and invariant requirements.
11. Organization scope leads common tenant queries.
12. Authoritative security reads use current primary data.
13. Pending and failed operational records are never removed by ordinary cleanup.
14. Backfills are bounded, resumable, and idempotent.
15. Schema deployment uses expand-and-contract where compatibility is required.
16. Technical migrations do not fabricate business Domain Events.
17. Destructive changes occur only after application compatibility.
18. Migration and repair operations remain auditable.

---

# Part 3 Design Summary

The PostgreSQL persistence layer combines:

```text
Short ACID Transactions

Optimistic Aggregate Concurrency

Selective Pessimistic Locking

Lease-Based Worker Claims

Organization-Scoped Indexes

Bounded Retention Jobs

Expand-and-Contract Migrations
```

Ordinary commands rely on Aggregate versions and relational constraints.

Cross-Aggregate invariants such as Organization ownership use explicit transactional locks.

Operational tables use recoverable leases rather than long-running transactions.

Schema changes preserve compatibility through staged deployment, resumable backfill, validation, and controlled contraction.

# Database Security

The persistence layer is part of the AIOS security boundary.

Database security must protect:

- Organization isolation
- Human Identity data
- Membership and role data
- authoritative domain state
- immutable revisions
- Outbox event content
- authorization audit history
- operational recovery metadata
- secrets and credentials

Security must be enforced through multiple layers.

---

# Defense in Depth

The persistence security model combines:

```text
Application Authorization

Organization-Scoped Repositories

Database Roles

Foreign Keys and Constraints

Optional Row-Level Security

Encryption

Audit Logging

Network Isolation

Backup Protection
```

No single layer is sufficient by itself.

---

# Database Access Principle

Application components receive only the database permissions required for their responsibilities.

The architecture must avoid:

```text
One unrestricted database superuser

used by every process
```

---

# Recommended Database Roles

Recommended logical roles:

```text
aios_migration

aios_application

aios_outbox_publisher

aios_domain_worker

aios_projection_worker

aios_operations_readonly

aios_backup
```

The exact physical role design may vary by deployment.

---

# Migration Role

The migration role may:

- create and alter owned schemas
- create and alter tables
- create indexes
- add constraints
- execute approved migrations
- grant controlled privileges

It must not be used by ordinary runtime processes.

---

# Application Role

The HTTP Application role may:

- read and write authoritative Aggregate tables
- insert Outbox records
- insert processed-command records
- insert authorization audit records
- read authoritative Identity, Membership, and role state

It should not:

- alter schemas
- update published event payloads
- delete audit history
- execute unrestricted administrative functions
- bypass Organization scoping

---

# Outbox Publisher Role

The Outbox Publisher role may:

- read eligible Outbox messages
- claim Outbox messages
- update publication metadata
- recover expired publication claims

It must not:

- update event payloads
- mutate domain Aggregate tables
- assign Human roles
- complete Work
- approve Decision
- approve Memory

---

# Domain Worker Role

A Domain Worker role may:

- read validated event data
- update processed-event records
- invoke persistence paths for explicitly supported target modules
- insert follow-up Outbox messages
- write operational findings

Its permissions should be narrowed by Worker responsibility where practical.

---

# Projection Worker Role

A Projection Worker may:

- read event data
- read authoritative source data when required
- update projection tables
- rebuild disposable read models

It must not mutate authoritative Aggregate state.

---

# Operations Read-Only Role

The Operations role may inspect:

- event status
- Worker backlog
- failed processing
- reconciliation findings
- migration status
- database health

Access to personal or Restricted payload data must be separately controlled.

---

# Backup Role

The Backup role may perform:

- approved logical backup
- physical backup integration
- replication access
- point-in-time recovery support

It must not be used for interactive application access.

---

# Schema Privileges

Runtime roles should receive privileges only on required schemas and tables.

Recommended default:

```text
REVOKE CREATE ON SCHEMA public FROM PUBLIC
```

Equivalent restrictions should be applied to module schemas.

---

# Table Ownership

Migration or schema-owner roles should own tables.

Runtime roles should receive:

```text
SELECT

INSERT

UPDATE
```

only where required.

Ordinary runtime roles should not own authoritative tables.

---

# Column-Level Restrictions

Column-level privileges may protect immutable fields.

Example:

```text
Outbox Publisher
    may update status and lease columns
```

but not:

```text
payload

event_type

organization_id

actor fields
```

When column privileges become operationally complex, use:

- restricted repository functions
- views
- dedicated update procedures
- separate delivery tables

---

# Stored Procedures

Stored procedures are optional.

They may be useful for:

- safe Worker claims
- ownership lock coordination
- bounded cleanup
- privileged operational recovery

Business lifecycle logic should remain in the Domain and Application Layers.

---

# Security Definer Functions

`SECURITY DEFINER` functions require special caution.

They must:

- have a fixed safe `search_path`
- validate Organization scope
- avoid dynamic SQL where possible
- expose one narrow operation
- be owned by a restricted role
- be covered by security tests
- never become a general authorization bypass

---

# Network Security

PostgreSQL should be accessible only from trusted application and operations networks.

Required controls include:

- private network placement
- firewall or security-group restrictions
- TLS
- credential rotation
- connection limits
- monitored administrative access

Public direct database exposure is prohibited.

---

# Connection Security

Database connections should require:

- TLS
- certificate or password-based authentication according to deployment policy
- strong credential storage
- bounded connection lifetime
- credential rotation
- application-name identification

---

# Connection Pooling

Connection pooling may use:

- application-native pool
- PgBouncer
- managed database proxy

Pooling configuration must preserve:

- transaction boundaries
- session-setting safety
- Row-Level Security context behavior
- advisory lock semantics
- prepared-statement compatibility

---

# Transaction Pooling Caution

When PgBouncer transaction pooling is used, session-scoped state is unsafe.

Avoid relying on:

- session-scoped advisory locks
- persistent temporary tables
- session variables that outlive one transaction
- session-level authorization state

Transaction-scoped mechanisms are preferred.

---

# Credential Storage

Database credentials must be stored in:

- secret manager
- managed runtime secret store
- protected deployment configuration

They must not be stored in:

- source control
- migration files
- event payloads
- application logs
- test fixtures committed to the repository

---

# Credential Rotation

Credential rotation must support:

- overlapping validity where necessary
- rolling deployment
- connection pool refresh
- revocation of old credentials
- audit of privileged changes

---

# Organization Isolation

Organization is the MVP business isolation boundary.

Every protected Organization-owned query must include:

```text
organization_id
```

This applies to:

- Aggregate loading
- command updates
- list queries
- relationship queries
- event processing
- reconciliation
- projections
- audits
- operational tooling

---

# Organization-Scoped Repository Rule

Repository interfaces should require Organization scope explicitly.

Preferred:

```text
WorkRepository.Get(
    organizationId,
    workId
)
```

Avoid:

```text
WorkRepository.Get(workId)
```

for Organization-owned resources.

---

# Organization-Scoped Update

Preferred update pattern:

```sql
UPDATE work_items
SET ...
WHERE organization_id = :organization_id
  AND work_id = :work_id
  AND version = :expected_version;
```

Organization scope is part of the mutation predicate.

---

# Cross-Organization Disclosure

When a resource identifier belongs to another Organization, the external response should not reveal that fact.

Preferred result:

```text
NotFound

or

UnauthorizedWithoutResourceDisclosure
```

The exact protocol response depends on API policy.

---

# Organization Composite Foreign Keys

Composite foreign keys should prevent invalid relationships.

Example:

```text
Decision.organization_id

Decision.related_work_id
```

must reference:

```text
Work.organization_id

Work.work_id
```

This prevents cross-Organization association even when application code contains a defect.

---

# Organization Scope in Operational Tables

Operational tables should also store Organization scope where applicable.

Examples:

- processed events
- dead letters
- replays
- reconciliation findings
- Memory generation attempts
- authorization audit

This supports:

- isolation
- filtering
- access control
- retention
- investigation

---

# Global Records

Some records are intentionally global.

Examples:

- Human Identity
- authentication subject mapping
- global System principal
- migration history

Global records require separate access policy.

They must not be treated as Organization-owned resources accidentally.

---

# Cross-Organization Human Identity

One Human Identity may belong to multiple Organizations.

The Human Identity row is global.

Authority remains scoped through separate Membership rows.

No Organization may infer another Organization’s Membership from the global Identity record.

---

# Identity Lookup Privacy

Global Identity lookup must be restricted.

Organization administrators should not receive unrestricted global search access.

Invitation workflows should expose only the minimum required matching behavior.

---

# Row-Level Security

PostgreSQL Row-Level Security is optional for the MVP.

It may provide additional defense in depth for Organization-owned tables.

---

# RLS Purpose

RLS can prevent accidental cross-Organization reads and writes when:

- application queries omit Organization filters
- a repository defect exists
- operations tooling uses broad SQL
- projection access requires constrained scope

RLS does not replace application authorization.

---

# RLS Context

A transaction may set a trusted Organization context.

Conceptual example:

```sql
SET LOCAL aios.organization_id = '...';
```

An RLS policy may compare:

```sql
organization_id =
current_setting(
    'aios.organization_id',
    true
)::uuid
```

---

# RLS Transaction Scope

Use:

```text
SET LOCAL
```

inside the current transaction.

Avoid persistent session settings when connection pooling may reuse sessions across requests.

---

# RLS Policy Example

Conceptual policy:

```sql
CREATE POLICY work_items_org_isolation
ON work_items
USING (
    organization_id =
    current_setting(
        'aios.organization_id',
        true
    )::uuid
)
WITH CHECK (
    organization_id =
    current_setting(
        'aios.organization_id',
        true
    )::uuid
);
```

---

# Missing RLS Context

When Organization context is absent:

```text
Access should be denied
```

The policy must not default to unrestricted access.

---

# Global Worker Access

Global Workers may require access across Organizations.

Preferred strategies:

- process one Organization per transaction
- set Organization context per transaction
- use a separate tightly restricted global role
- expose controlled database functions

A global Worker must not combine business effects across Organizations in one execution context unnecessarily.

---

# RLS Bypass

Roles with:

```text
BYPASSRLS
```

must be extremely restricted.

Ordinary application and Worker roles should not receive it.

Migration and backup roles may require special treatment according to deployment tooling.

---

# RLS Testing Requirement

When RLS is enabled, tests must verify:

- correct Organization may read
- foreign Organization cannot read
- foreign Organization cannot update
- missing context denies access
- connection-pool reuse does not leak context
- Worker context resets per transaction
- operational roles have only intended access

---

# RLS Adoption Decision

The MVP may begin without RLS when:

- repository scoping is consistent
- composite Organization foreign keys are implemented
- database roles are restricted
- isolation tests are comprehensive

RLS can be introduced later through controlled migration.

---

# Sensitive Data Classification

Database fields should be classified.

Recommended categories:

```text
PublicInternal

OrganizationConfidential

PersonalData

SecuritySensitive

Restricted
```

---

# Personal Data

Likely personal data includes:

- display name
- email address
- authentication subject
- Membership history
- role history
- actor attribution
- authorization audit
- review activity

---

# Security-Sensitive Data

Security-sensitive fields include:

- invitation token hash
- authentication provider identifiers
- session references
- failure diagnostics
- privileged operation audit
- replay requests
- credential metadata

---

# Restricted Data

Restricted data may include:

- Memory content
- Decision rationale
- Work descriptions
- confidential Organization content
- provider error payloads
- security investigation notes

Classification depends on product policy.

---

# Encryption in Transit

All database connections must use TLS.

Backup transport and replication connections must also be encrypted.

---

# Encryption at Rest

Production PostgreSQL storage and backups should use encryption at rest through:

- managed database encryption
- encrypted volumes
- encrypted backup storage
- protected key management

---

# Application-Level Encryption

Application-level field encryption may be introduced for especially sensitive fields.

Possible candidates:

- external credentials
- security investigation notes
- highly sensitive personal data

Core relational fields used for joins and authorization should not be encrypted in a way that prevents required constraints without a deliberate design.

---

# Searchable Sensitive Fields

Fields requiring equality lookup may store:

```text
normalized value

+

keyed hash
```

or use another approved privacy-preserving lookup design.

Example:

```text
invitation token hash
```

---

# Email Encryption Considerations

Email may be needed for:

- invitation delivery
- identity administration
- account recovery
- authorized search

If application-level encryption is used, the architecture must separately define:

- normalized lookup hash
- encryption key rotation
- index behavior
- redaction
- export handling

This is optional for the MVP.

---

# Cryptographic Key Management

Encryption keys must be stored outside PostgreSQL application tables.

Use:

- cloud KMS
- hardware-backed key service
- managed secret platform

Keys must support:

- rotation
- access audit
- environment separation
- recovery
- revocation

---

# Hashing

Hashes are appropriate for:

- invitation tokens
- request payload comparison
- content integrity
- deduplication support

Use a cryptographically appropriate algorithm and, where secrets are involved, a construction resistant to offline guessing.

---

# Invitation Token Hashing

Invitation tokens should have high entropy.

Store only:

```text
token_hash
```

The system should compare hashes in constant-time where practical.

---

# Password Storage

AIOS should not store passwords when authentication is delegated to an external Identity Provider.

If local credentials are introduced later, they require a separate credential-security architecture.

---

# Data Redaction

Administrative and operational interfaces should redact:

- emails where unnecessary
- authentication subjects
- event payload content
- Memory content
- security-sensitive error details
- token hashes

---

# Database Logging

PostgreSQL logs should not record sensitive bind parameter values unnecessarily.

Query logging configuration must balance:

- diagnostics
- performance
- privacy
- security

---

# Audit Log Protection

Authorization and security audit records should be append-oriented.

Runtime roles should not have ordinary update or delete access.

Tamper-evident export may be introduced later for stronger assurance.

---

# Backup Architecture

Backups must preserve the complete consistency boundary.

A recoverable backup includes:

- authoritative Aggregate tables
- revision tables
- Identity and Membership data
- role assignments
- authorization audit
- Outbox state
- processed commands
- processed events
- dead letters
- replay records
- reconciliation findings
- migration history

---

# Backup Types

Recommended backup strategy combines:

```text
Physical Base Backup

Continuous Write-Ahead Log Archiving

Periodic Logical Export for Validation
```

Managed PostgreSQL services may provide equivalent capabilities.

---

# Point-in-Time Recovery

Point-in-Time Recovery should allow restoration to a selected timestamp using:

```text
Base Backup

+

Write-Ahead Logs
```

PITR is the preferred recovery mechanism for major data loss or corruption.

---

# Recovery Point Objective

The MVP should define an initial:

```text
Recovery Point Objective
```

Example target:

```text
RPO <= 15 minutes
```

Managed continuous WAL archiving may support a lower RPO.

The final value is a product and operations decision.

---

# Recovery Time Objective

The MVP should also define:

```text
Recovery Time Objective
```

Example target:

```text
RTO <= 4 hours
```

The target must be validated through recovery exercises.

---

# Backup Frequency

A possible initial policy:

```text
Continuous WAL archive

Daily automated base backup

Periodic logical integrity export

Regular restore test
```

Exact frequency depends on environment and compliance requirements.

---

# Backup Encryption

Backups must be encrypted:

- at rest
- in transit
- during cross-region copy where used

Access must be limited to backup and recovery operators.

---

# Backup Retention

Backup retention must consider:

- accidental deletion window
- corruption discovery delay
- compliance obligations
- storage cost
- privacy deletion requirements
- Organization archival policy

Final durations are outside the architecture’s fixed MVP scope.

---

# Backup Immutability

At least one backup tier should resist accidental or malicious deletion.

Possible controls:

- object lock
- immutable snapshots
- separate backup account
- restricted deletion role
- multi-party approval

---

# Backup Access Audit

Backup creation, download, restore, and deletion should be audited.

Backup access may expose all Organizations and therefore requires platform-level authority.

---

# Restore Testing

A backup is not considered reliable until restore is tested.

Restore tests should verify:

- database starts successfully
- migrations are consistent
- Aggregate state loads
- foreign keys validate
- Outbox state is preserved
- processed-event state is preserved
- authorization checks work
- Organization isolation remains intact
- Workers recover safely

---

# Disaster Recovery

Disaster recovery restores both authoritative state and asynchronous processing safety.

---

# Recovery Sequence

Recommended recovery flow:

```text
Provision Recovery Database

↓

Restore Base Backup and WAL

↓

Verify Database Integrity

↓

Disable External Consumers Temporarily

↓

Start Application in Controlled Mode

↓

Recover Expired Claims

↓

Inspect Outbox and Consumer State

↓

Run Reconciliation

↓

Resume Workers

↓

Resume User Traffic
```

---

# Controlled Startup

After restore, Worker processing may initially remain paused.

This allows operators to inspect:

- restore point
- pending events
- claimed events
- processed-event history
- duplicate-delivery risk
- migration level
- Organization integrity

---

# Expired Claim Recovery After Restore

Any claim held by a Worker before failure may now be stale.

Recovery must reset expired:

- Outbox publication claims
- consumer processing claims
- Memory generation claims
- cleanup-job leases

---

# Duplicate Delivery After Restore

External brokers may redeliver messages already processed before the restored database point.

Consumers must rely on:

- processed-event records
- Aggregate business idempotency
- projection version checks
- external integration idempotency keys

---

# Restore Before Prior Publication

A restore point may contain:

```text
Outbox event = Pending
```

even when the event had been published before the disaster.

The event may publish again.

This is expected under at-least-once delivery.

---

# Restore After Aggregate Commit but Before Consequence

A restore may contain:

```text
Work = Completed

WorkCompleted Outbox = Pending
```

The Worker publishes after recovery and Memory generation continues.

---

# Restore Integrity Checks

Post-restore checks should verify:

- Active Organizations have active Owners
- Work and Decision relationships match Organization
- Memory and source Work relationships match Organization
- active Memory uniqueness
- revision references are valid
- event identifiers are unique
- event stream positions are unique
- processed-event uniqueness
- no unexpected schema drift

---

# Partial Restore Prohibition

Ordinary disaster recovery must not restore only selected authoritative tables.

Examples of unsafe partial restore:

```text
Restore Work without Outbox

Restore Membership without role history

Restore Memory without revisions

Restore Organizations without authorization audit
```

Selective data repair requires a separate controlled process.

---

# Regional Disaster Recovery

Cross-region recovery is optional for the MVP.

When introduced, it must define:

- encrypted backup replication
- database promotion
- DNS or service cutover
- identity-provider configuration
- secret availability
- Worker duplication prevention
- Recovery Point and Recovery Time objectives

---

# Disaster Recovery Exercises

Recovery procedures should be exercised regularly.

A recovery exercise should record:

- restore duration
- restored timestamp
- data loss interval
- integrity findings
- Worker recovery behavior
- duplicate event behavior
- operational gaps
- follow-up improvements

---

# Persistence Testing Strategy

The persistence architecture requires tests at several levels:

```text
Schema Tests

Repository Integration Tests

Transaction Tests

Constraint Tests

Concurrency Tests

Organization Isolation Tests

Migration Tests

Backup and Restore Tests

Performance Tests

Security Tests
```

---

# Schema Tests

Schema tests should verify:

- all expected tables exist
- expected columns exist
- data types are correct
- nullability matches the model
- check constraints exist
- unique constraints exist
- foreign keys exist
- indexes exist
- migration history is current

---

# Constraint Tests

Every critical constraint should have:

```text
valid insert test

invalid insert test

valid update test

invalid update test
```

---

# Work Constraint Tests

Verify:

- valid Work statuses
- invalid Work status rejected
- NotRequired gate has no Decision reference
- Pending gate requires Decision
- Satisfied requires Approved outcome
- Unsatisfied requires Rejected or Withdrawn
- Completed Work requires Human completion fields
- Cancelled Work requires cancellation fields

---

# Decision Constraint Tests

Verify:

- valid Decision statuses
- Draft and InReview have no outcome
- Approved uses Approved outcome
- Rejected uses Rejected outcome
- Withdrawn uses Withdrawn outcome
- only one Draft revision exists
- revision number is positive
- submitted revision content cannot be changed

---

# Memory Constraint Tests

Verify:

- valid Memory statuses
- one active Memory per Work
- one editable revision per Memory
- Approved requires Human review attribution
- Rejected requires Human review attribution
- Memory and source Work share Organization
- approved revision cannot be edited

---

# Identity and Membership Constraint Tests

Verify:

- authentication subject uniqueness
- one Membership per Organization and Identity
- pending invitation uniqueness
- active Membership requires Identity
- active role assignment uniqueness
- role values are bounded
- invitation token hash is unique

---

# Repository Integration Tests

Repositories should be tested against real PostgreSQL.

Tests must verify:

- full Aggregate hydration
- child entity persistence
- revision persistence
- version increment
- optimistic conflict
- Organization scope
- Domain Event extraction
- Outbox atomicity
- no unauthorized cross-module writes

---

# Aggregate Round-Trip Tests

For every Aggregate:

```text
Create Aggregate

↓

Persist

↓

Reload

↓

Compare invariant-relevant state
```

Round-trip tests should include all lifecycle states.

---

# Transaction Rollback Tests

Inject failures after:

- Root update
- child insertion
- revision insertion
- Outbox insertion
- processed-command insertion
- authorization-audit insertion

Expected result:

```text
No partial committed state
```

---

# Coordinated Transaction Tests

Required tests include:

- Organization bootstrap
- blocking Decision creation
- invitation acceptance with new Identity
- ownership transfer

Each test must inject failure at every intermediate persistence step.

---

# Optimistic Concurrency Tests

Simulate:

```text
Load same Aggregate twice

Persist first mutation

Persist second mutation with stale version
```

Expected result:

```text
second mutation fails
```

---

# Owner Lock Tests

Using real concurrent transactions, test:

- two Owners concurrently remove each other
- Owner suspension races with ownership transfer
- Identity disablement races with Owner assignment
- two Owner grants occur concurrently
- lock timeout returns safely

At least one active Owner must remain.

---

# Worker Claim Tests

Verify:

- one Outbox row claimed by one Worker
- multiple Workers process different rows
- expired claim is recovered
- stale claim version cannot update result
- `SKIP LOCKED` avoids duplicate active claim
- claim transaction remains short

---

# Organization Isolation Tests

Mandatory tests include:

1. org-A cannot load org-B Work.
2. org-A cannot update org-B Decision.
3. org-A cannot reference org-B Memory.
4. org-A cannot assign org-B Membership.
5. org-A event cannot mutate org-B Aggregate.
6. global Identity does not expose foreign Membership.
7. operational queries require Organization scope.
8. projections remain Organization-scoped.
9. RLS denies foreign access when enabled.
10. wrong Organization behaves as non-disclosed resource.

---

# Foreign-Key Tests

Verify cross-Organization foreign keys reject:

- Work participant from another Organization
- Decision linked to foreign Work
- Memory linked to foreign Work
- role assignment linked to foreign Membership
- replay linked to foreign event where constrained
- reconciliation finding linked to foreign resource where constrained

---

# Immutability Tests

Database-level or repository-level tests must verify:

- submitted Decision revision cannot change
- Approved Memory revision cannot change
- published Outbox payload cannot change
- authorization audit cannot update
- processed command identity cannot be reused with different request hash

---

# Migration Tests

Every migration path should be tested from:

- empty database
- previous production schema
- representative older schema where supported
- production-like data volume

---

# Expand-and-Contract Tests

Verify:

- old application works after Expand
- backfill is resumable
- new application works during mixed deployment
- validation succeeds before Contract
- Contract does not remove still-used fields

---

# Backfill Tests

Backfills must be tested for:

- idempotency
- batching
- restart after interruption
- concurrent writes
- validation
- unexpected historical values
- Organization mismatch detection

---

# Migration Performance Tests

Large migrations should measure:

- lock duration
- transaction duration
- table rewrite behavior
- replication lag
- index build time
- WAL volume
- application latency impact

---

# Security Tests

Database security tests should verify:

- runtime role cannot alter schema
- Publisher cannot mutate domain tables
- Projection Worker cannot mutate authoritative tables
- operations role cannot edit event payloads
- audit rows cannot be changed by runtime role
- secrets are not stored in plain text
- unauthorized schema access is denied
- missing RLS context denies access when enabled

---

# Backup Tests

Backup tests should verify:

- backup completes
- backup is encrypted
- retention policy applies
- backup access is audited
- restore uses expected credentials
- restored database passes integrity checks

---

# Point-in-Time Recovery Tests

PITR tests should simulate:

```text
Create Work

Complete Work

Generate Outbox event

Introduce corruption

Restore to point before corruption
```

Then verify event and Aggregate consistency.

---

# Disaster Recovery Tests

A full exercise should test:

- application shutdown
- database restore
- migration verification
- Worker pause
- expired claim recovery
- duplicate event delivery
- workflow reconciliation
- user traffic resumption

---

# Query Performance Tests

Performance tests should cover:

- Work list by Organization and status
- Decision review queue
- Memory review queue
- Membership directory
- active Owner count
- pending Outbox claim
- RetryPending consumer claim
- authorization audit search
- reconciliation backlog

---

# Query Plan Tests

Critical queries should be reviewed with:

```text
EXPLAIN ANALYZE
```

Tests should confirm expected index use under realistic data volume.

---

# Load Tests

Load testing should include:

- concurrent Work edits
- Decision review activity
- Memory generation completion writes
- Membership administration
- Outbox publication
- consumer processing
- projection updates

---

# Connection Pool Tests

Verify:

- no connection leakage
- bounded pool saturation
- transaction rollback on exception
- RLS context reset
- advisory lock release
- statement timeout behavior
- graceful shutdown

---

# Property-Based Persistence Tests

Recommended properties:

```text
For every committed Organization-owned relationship:
    source.organizationId = target.organizationId
```

```text
For every mutable Aggregate update:
    newVersion = oldVersion + 1
```

```text
For every Completed Work:
    completedByIdentityId is not null
```

```text
For every active Memory source Work:
    activeMemoryCount <= 1
```

```text
For every active Organization:
    activeOwnerCount >= 1
```

```text
For every committed Domain Event:
    matching immutable Outbox record exists
```

---

# Implementation Guidance

Persistence implementation should remain explicit and modular.

Recommended structure:

```text
persistence/

    migrations/
        work/
        decision/
        memory/
        identity/
        organization/
        membership/
        authorization/
        events/

    transaction/
        TransactionManager
        PostgreSqlTransactionManager

    security/
        DatabaseRoleConfiguration
        OrganizationContextSetter
        RowLevelSecuritySupport

    operations/
        BackupVerification
        IntegrityChecker
        RetentionWorker
        ClaimRecoveryWorker
```

---

# Module Repository Structure

Example:

```text
work/
    infrastructure/
        PostgreSqlWorkRepository
        WorkRowMapper
        WorkQueryService

decision/
    infrastructure/
        PostgreSqlDecisionRepository
        DecisionRevisionMapper
        DecisionQueryService

memory/
    infrastructure/
        PostgreSqlMemoryRepository
        MemoryRevisionMapper
        MemoryQueryService
```

---

# SQL Ownership

SQL should live with the module that owns the table or query.

Avoid one global persistence package containing unrestricted access to all tables.

---

# Repository Interface Design

Repository interfaces should express domain intent.

Preferred:

```text
Get(
    organizationId,
    aggregateId
)

Save(
    aggregate,
    expectedVersion
)
```

Avoid generic interfaces such as:

```text
Repository<T>.UpdateAny(...)
```

that hide Aggregate-specific persistence needs.

---

# Unit of Work

A generic Unit of Work is optional.

If used, it must:

- preserve explicit transaction ownership
- collect Aggregate changes
- collect Domain Events
- use one PostgreSQL transaction
- avoid implicit partial commits
- remain understandable during failure

---

# Object-Relational Mapping

An ORM may be used.

It must not obscure:

- Aggregate boundaries
- optimistic concurrency
- explicit SQL constraints
- Organization scoping
- child ownership
- Outbox atomicity
- lock acquisition
- migration behavior

---

# ORM Restrictions

Avoid:

- automatic lazy loading
- unrestricted cascade updates
- implicit global filters without tests
- entity sharing across Aggregates
- automatic schema generation in production
- silent retry of Human-authoritative commands
- ORM-driven deletion cascades on authoritative Roots

---

# SQL-First Operations

Direct SQL is appropriate for:

- Worker claims
- bounded cleanup
- partial indexes
- advisory locks
- migration backfills
- operational queries
- performance-sensitive projections

These operations must still respect module ownership.

---

# Mapping Layer

Database rows should map to persistence DTOs before constructing Domain objects.

Domain objects should not depend on:

- ORM annotations
- database connection types
- SQL result types
- JSONB driver objects

---

# Domain Hydration

Hydration should use dedicated constructors or factories that:

- trust validated persisted state
- restore Value Objects
- restore version
- restore lifecycle state
- do not emit new Domain Events

---

# Save Flow

Recommended repository save flow:

```text
Persist Root using expectedVersion

↓

Persist owned child inserts and updates

↓

Verify affected row counts

↓

Return new Aggregate version
```

Outbox persistence remains coordinated by the Application transaction.

---

# Event Collection

The Application Service should collect Domain Events after successful Aggregate command execution.

Events must be inserted before transaction commit.

They should be cleared from in-memory Aggregate state only after successful persistence or reconstructed safely after failure.

---

# Command Idempotency Order

Recommended order:

```text
Check existing processed command

↓

Verify request hash

↓

Execute command if new

↓

Persist result in same transaction
```

Duplicate requests return the original bounded result.

---

# Statement Timeouts

Recommended timeout classes:

```text
InteractiveCommandTimeout

WorkerTransactionTimeout

OperationalQueryTimeout

MigrationStatementTimeout
```

Timeout configuration should be explicit per workload.

---

# Connection Application Name

Each process should identify itself through PostgreSQL connection metadata.

Examples:

```text
aios-http

aios-outbox-publisher

aios-memory-worker

aios-projection-worker

aios-migration
```

This supports operational diagnosis.

---

# Database Time

Use database time for:

- Worker claim timestamps
- lease expiry
- publication metadata
- cleanup cutoff evaluation

Use the injected domain clock for business facts when domain semantics require it.

---

# Integrity Checker

A scheduled integrity checker may query critical invariants.

It must:

- be read-only
- create findings rather than silently repair
- use bounded scans
- preserve Organization scope
- expose metrics
- support resumption

---

# Data Repair Tooling

Controlled repair tooling should support:

- dry-run
- invariant validation
- Organization scope
- operator identity
- reason
- before-and-after evidence
- audit artifact
- rollback or forward-fix plan

It must not become a routine business interface.

---

# Development Environment

Local and test environments should use PostgreSQL behavior compatible with production.

SQLite or in-memory substitutes are insufficient for testing:

- partial indexes
- advisory locks
- RLS
- `SKIP LOCKED`
- deferrable constraints
- PostgreSQL transaction semantics

---

# Test Database Isolation

Automated tests may use:

- one database per test suite
- one schema per test
- transaction rollback
- containerized PostgreSQL

Tests involving concurrency or committed Worker visibility require real commits and separate connections.

---

# Seed Data

Seed data should be limited to:

- required System principals
- permission definitions
- role-permission mappings
- policy versions
- test-only fixtures in non-production environments

Production seed processes must be idempotent and version-controlled.

---

# Production Data Access

Direct production SQL access should be rare.

Required controls:

- least privilege
- approval
- time-bounded access
- query logging
- secure workstation
- no uncontrolled exports
- post-access review where appropriate

---

# Operational Documentation

The persistence implementation should include runbooks for:

```text
Migration failure

Database connection exhaustion

Lock contention

Deadlock surge

Outbox backlog

Index corruption or bloat

Backup failure

Point-in-time restore

Organization integrity finding

Emergency data repair
```

---

# Runbook: Migration Failure

Recommended actions:

1. stop further deployment
2. identify migration state
3. determine transaction status
4. verify application compatibility
5. apply rollback or forward fix
6. inspect schema drift
7. validate constraints
8. document resolution

---

# Runbook: Lock Contention

Recommended actions:

1. identify blocked query
2. identify blocking transaction
3. inspect application name
4. determine whether transaction is abandoned
5. cancel or terminate only with approval
6. review lock order
7. inspect query duration
8. add remediation and regression test

---

# Runbook: Backup Failure

Recommended actions:

1. determine last successful backup
2. verify WAL archive continuity
3. restore backup process
4. confirm encryption
5. execute validation backup
6. test restore if recovery window is at risk
7. alert stakeholders
8. document exposure against RPO

---

# Runbook: Integrity Finding

Recommended actions:

1. isolate affected Organization
2. identify violated invariant
3. preserve evidence
4. stop unsafe mutation path
5. determine source defect
6. prepare controlled repair
7. validate before and after
8. run reconciliation
9. add regression tests

---

# MVP Exclusions

The following persistence capabilities are outside the MVP:

- event-sourced Aggregate storage
- distributed database transactions
- multi-region active-active writes
- sharding by Organization
- customer-dedicated databases
- customer-managed encryption keys
- universal application-level field encryption
- automatic cross-region failover
- data warehouse
- lakehouse
- streaming analytics database
- public reporting replica
- Organization data export platform
- self-service backup restore
- cross-Organization resource sharing
- Organization hierarchy persistence
- custom role persistence
- dynamic policy editor
- Knowledge tables
- Evidence tables
- Capability marketplace tables
- AI Employee runtime state
- attachment binary storage
- full legal-hold system
- complete privacy-erasure engine
- database-level temporal tables for all entities
- permanent Outbox as legal audit archive

These require separate future design.

---

# Future Extension Principles

Future persistence changes must preserve:

1. Aggregate ownership.
2. stable identifiers.
3. Organization isolation.
4. Human authority attribution.
5. immutable submitted and approved revisions.
6. optimistic concurrency.
7. atomic Outbox persistence.
8. idempotent consumer state.
9. controlled schema migration.
10. recoverable backups.
11. restricted database privileges.
12. auditable administrative changes.

---

# Knowledge Persistence Future Phase

Future Knowledge persistence must remain separate from Approved Memory.

Potential concepts include:

```text
KnowledgeItem

KnowledgeRevision

PromotionDecision

EvidenceReference

KnowledgeStatus
```

Promotion must remain a Human-authoritative workflow.

---

# Evidence Persistence Future Phase

Evidence may require:

- provenance
- source integrity
- retention
- legal status
- confidence
- access classification
- content checksum
- immutable acquisition metadata

Evidence must not be added as unstructured JSON to Memory without a defined model.

---

# AI Employee Persistence Future Phase

AI Employee persistence may include:

- AI Employee identity
- granted capabilities
- operational scope
- budget
- execution history
- Human approval checkpoints
- revocation
- model configuration

AI Employees must not reuse Human Membership rows.

---

# Organization Sharding Future Phase

If Organization sharding is introduced, the design must preserve:

- stable global Organization identifiers
- routing
- migration between shards
- event ordering
- global Human Identity lookup
- cross-shard backup
- no cross-Organization joins in business transactions

Sharding is not justified for the MVP.

---

# Implementation Checklist

Before persistence implementation is considered complete, verify:

- PostgreSQL is the authoritative state store
- module table ownership is documented
- every mutable Aggregate Root has version
- Organization-owned tables store organization_id
- composite Organization foreign keys protect relationships
- Work Completion Gate constraints exist
- Decision revision immutability exists
- one Draft Decision revision is enforced
- one active Memory per Work is enforced
- Approved Memory content is immutable
- Human completion and approval attribution is structurally represented
- Membership uniqueness is enforced
- active role uniqueness is enforced
- Last Owner uses transactional locking
- invitation tokens are hashed
- authorization audit is append-oriented
- command idempotency is stored transactionally
- eventId and stream position are unique
- processed-event uniqueness is enforced
- Worker claims are leased and fenced
- runtime database roles use least privilege
- Organization-scoped repository methods are required
- RLS decision is documented
- database connections use TLS
- backups are encrypted
- PITR is configured
- restore tests are executed
- migrations use version control
- backfills are bounded and resumable
- destructive migrations use expand-and-contract
- critical queries have indexes
- integrity checks exist
- no ordinary repository hard-deletes authoritative history

---

# Design Summary

The AIOS persistence architecture uses PostgreSQL to provide:

```text
Aggregate-Oriented Relational State

Strong Structural Constraints

Organization Isolation

Optimistic Concurrency

Selective Transactional Locking

Transactional Outbox

Idempotent Worker State

Immutable Revision History

Controlled Migration

Recoverable Backup
```

The Domain Model remains authoritative for lifecycle rules.

The database reinforces invariants, protects relationships, and ensures atomic persistence.

---

# Core Guarantees

The persistence architecture guarantees:

- stable Aggregate identities
- explicit Organization ownership
- no valid cross-Organization association
- safe concurrent Aggregate updates
- atomic domain state and event persistence
- immutable submitted Decision revisions
- immutable Approved Memory content
- one active Memory per Work
- Human attribution for authoritative actions
- durable Membership and role history
- reliable command and event idempotency
- recoverable Worker claims
- controlled schema evolution
- complete backup consistency

---

# Architect Review

## Aggregate Mapping

**Rating: ★★★★★**

Each Aggregate maps to a clear Root table with bounded owned children.

The relational model preserves Domain boundaries rather than exposing generic table-driven mutation.

---

## Relational Integrity

**Rating: ★★★★★**

Foreign keys, composite Organization references, check constraints, partial unique indexes, and immutable revision rules provide strong structural protection.

---

## Organization Isolation

**Rating: ★★★★★**

Organization scope is persisted explicitly and included in relationships, queries, updates, events, audits, and operational records.

Optional Row-Level Security provides a clear defense-in-depth path.

---

## Concurrency

**Rating: ★★★★★**

Optimistic Aggregate versions handle ordinary concurrency.

Selective row and advisory locking protect cross-Aggregate invariants such as Last Owner.

---

## Human Authority

**Rating: ★★★★★**

Human completion, Decision outcome, Memory review, ownership, and role changes use stable Human Identity and Membership attribution.

Secretary and System principals cannot occupy Human reviewer fields.

---

## Revision Integrity

**Rating: ★★★★★**

Decision and Memory revisions are append-oriented and become immutable at the correct lifecycle boundaries.

Historical reviewed content remains explainable.

---

## Event Reliability

**Rating: ★★★★★**

Aggregate state, Domain Events, command idempotency, and required audit data commit atomically through PostgreSQL.

Consumer state supports effectively-once business outcomes.

---

## Security

**Rating: ★★★★★**

Least-privilege database roles, network isolation, TLS, encryption, restricted payload access, and optional RLS create layered protection.

---

## Migration Safety

**Rating: ★★★★★**

Version-controlled migrations, expand-and-contract deployment, resumable backfills, concurrent index creation, and compatibility windows support safe evolution.

---

## Backup and Recovery

**Rating: ★★★★★**

The design preserves the full consistency boundary through encrypted backups, WAL archiving, PITR, restore testing, claim recovery, and post-restore reconciliation.

---

## Operational Readiness

**Rating: ★★★★★**

The architecture includes indexing, query patterns, retention, cleanup, vacuum monitoring, integrity checks, runbooks, and disaster-recovery procedures.

---

## MVP Scope Discipline

**Rating: ★★★★★**

The design avoids premature sharding, event sourcing, multi-region writes, universal encryption complexity, and data-platform expansion.

Future extension points remain explicit.

---

## Final Assessment

```text
Architecture Quality:          ★★★★★
Aggregate Persistence:         ★★★★★
Relational Integrity:          ★★★★★
Organization Isolation:        ★★★★★
Concurrency Control:           ★★★★★
Human Authority Protection:    ★★★★★
Migration Safety:              ★★★★★
Backup and Recovery:           ★★★★★
Security:                      ★★★★★
Implementation Readiness:      ★★★★★
MVP Scope Discipline:          ★★★★★
```

The Persistence and Data Model architecture is ready for implementation within the AIOS Modular Monolith.

It is fully aligned with:

- Work Aggregate
- Decision Aggregate
- Memory Aggregate
- Identity and Organization
- Authorization
- Application Services
- Events and Transactional Outbox
- PostgreSQL
- Background Workers
- Human authority
- Secretary advisory boundaries
- System operational boundaries
- eventual cross-Aggregate consistency

**Architect Review Result: APPROVED**