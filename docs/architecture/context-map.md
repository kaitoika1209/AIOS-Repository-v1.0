# Context Map

> **Scope classification:** Mixed — MVP Normative boundaries and Future Hypothesis contexts  
> **MVP implementation authority:** Yes for sections labelled MVP Normative  
> **Promotion requirement:** Accepted implementation ADR and scope-document update  
> **Authority rank:** see [Document Governance](../document-governance.md)

> **Document status:** Proposed  
> **Blueprint version:** 0.2.1  
> **MVP architecture:** Modular Monolith

## Purpose

This document defines the business-language boundaries of AIOS and the relationships between them.

A Bounded Context is a DDD semantic boundary. It owns a domain model, Ubiquitous Language, and business rules.

A Bounded Context is not automatically:

- a deployable service;
- a PostgreSQL schema;
- a code repository;
- an infrastructure component; or
- one Aggregate.

The MVP deploys multiple Bounded Contexts together in one Modular Monolith and one authoritative PostgreSQL database.

---

## Boundary Classification

AIOS uses three distinct architectural classifications.

| Classification | Purpose | MVP examples |
|---|---|---|
| Domain Bounded Context | Owns business language and domain rules | Identity & Organization, Work Management, Decision Management, Organizational Memory |
| Implementation Module | Groups code and persistence ownership inside the Modular Monolith | Organization and Access, Work and Decision, Organizational Learning |
| Technical Platform Capability | Provides cross-cutting execution or infrastructure without owning business language | Transactional Outbox, Worker Runtime, Observability, Persistence adapters |

These classifications must not be used interchangeably.

Authorization is an explicit Application and Security capability. It evaluates whether a Principal may attempt a command. It does not own the lifecycle or invariants of Work, Decision, Memory, Organization, or Membership.

Transactional Outbox, processed-event handling, Workers, replay, reconciliation, telemetry, and database adapters are technical platform capabilities. They are not Domain Bounded Contexts.

---

## Domain Bounded Contexts

### Identity & Organization Context

**Classification:** Supporting Domain  
**MVP:** Implemented

#### Purpose

Defines durable Human identity, Organization tenancy, Membership, and Organization-scoped participation.

#### Owns

- Human Identity Aggregate;
- Organization Aggregate;
- Membership Aggregate;
- authentication-subject associations;
- Organization-scoped role assignments; and
- Secretary assignment or registration metadata required by the MVP.

A Human Identity is global and may participate in multiple Organizations through separate Memberships.

An Organization is the tenant, ownership, authorization-scope, and data-isolation boundary. It is not a transaction boundary containing all Organization-owned Aggregates.

#### Publishes representative facts

- `HumanIdentityCreated`
- `HumanIdentityDisabled`
- `OrganizationCreated`
- `OrganizationSuspended`
- `MembershipInvited`
- `MembershipActivated`
- `MembershipSuspended`
- `MembershipRevoked`

#### Does not own

- Work, Decision, or Memory lifecycle;
- authorization decisions for every use case;
- AI-generated business content; or
- technical Outbox and Worker state.

Authorization policies consume current Identity, Membership, role, Organization, Principal, and resource facts but remain an Application and Security capability.

---

### Work Management Context

**Classification:** Core Domain  
**MVP:** Implemented

#### Purpose

Represents organizational activity and explicit Human-controlled completion.

#### Owns

- Work Aggregate;
- Work lifecycle;
- assignments and participants;
- attributable progress;
- Work-local completion gate;
- recorded Decision outcome snapshots; and
- completion or cancellation history.

#### Publishes representative facts

- `WorkCreated`
- `WorkStarted`
- `WorkDecisionRequested`
- `WorkDecisionOutcomeRecorded`
- `WorkCompleted`
- `WorkCancelled`

Decision approval never completes Work. Work completion is an explicit Human-authorized command.

---

### Decision Management Context

**Classification:** Core Domain  
**MVP:** Implemented

#### Purpose

Represents an explicit organizational question, stable review snapshot, and Human resolution.

#### Owns

- Decision Aggregate;
- Decision revisions;
- submitted snapshots;
- options;
- review history;
- approval, rejection, withdrawal, and revision behavior; and
- blocking designation.

#### Publishes representative facts

- `DecisionCreated`
- `DecisionDraftEdited`
- `DecisionSubmitted`
- `DecisionApproved`
- `DecisionRejected`
- `DecisionWithdrawn`
- `DecisionRevisionStarted`

The Decision Context does not modify Work directly. The Work Context records authoritative Decision outcomes through an idempotent Application handler.

---

### Organizational Memory Context

**Classification:** Core Domain  
**MVP:** Implemented

#### Purpose

Creates one Human-reviewable historical record from one completed Work and preserves the approved result as immutable organizational history.

#### Owns

- Memory Aggregate;
- editable generated draft;
- immutable submitted snapshots;
- Human review lifecycle;
- generation and edit provenance;
- immutable source-snapshot references; and
- approval or rejection history.

#### Publishes representative facts

- `MemoryGenerated`
- `MemoryEdited`
- `MemorySubmittedForReview`
- `MemoryApproved`
- `MemoryRejected`
- `MemoryReopened`

The MVP stops at Approved Memory.

The Memory Context does not emit Knowledge promotion or publication events in the MVP.

---

### Knowledge Management Context

**Domain classification:** Candidate Future Core Domain  
**Scope classification:** Future Hypothesis  
**MVP implementation authority:** None

#### Purpose

Will govern reusable organizational guidance, Evidence, publication, revision, supersession, and deprecation.

Approved Memory may provide Evidence, but Memory approval does not create Knowledge.

Before implementation, the Knowledge Aggregate, Evidence eligibility, Human publication authority, persistence model, event contracts, and ADRs must be reviewed together.

The detailed future model creates no reserved MVP port or module. Promotion requires an accepted implementation ADR and release-scope update under [ADR-0010](../adr/0010-classify-blueprint-scope-and-implementation-authority.md).

---

### Capability Management Context

**Domain classification:** Candidate Future Domain  
**Scope classification:** Future Hypothesis  
**MVP implementation authority:** None

#### Purpose

Will organize reusable Knowledge and measurable organizational competence.

Capability is not inferred from one Memory or one AI output.

No Capability module, table, event handler, or public interface is created in the MVP.

Capability is not a Reserved Extension Point. Promotion requires an accepted implementation ADR and release-scope update under ADR-0010.

---

## MVP Implementation Modules

The following modules are code and persistence ownership boundaries inside one deployable Modular Monolith.

| MVP implementation module | Contained domain boundaries | Owned persistence |
|---|---|---|
| Organization and Access | Identity & Organization; Authorization policies and Principal resolution | Human Identity, authentication subject, Organization, Membership, role assignment, authorization-audit tables |
| Work and Decision | Work Management; Decision Management | Work-owned tables and Decision-owned tables, kept behind separate repositories |
| Organizational Learning | Organizational Memory only in the MVP | Memory, Memory revision/review, generation source, and generation-operation tables |
| Platform Runtime | No Domain Bounded Context | Outbox, processed command/event, dead-letter, replay, Worker-claim, reconciliation, and projection infrastructure |

Knowledge Management and Capability Management remain documented future Bounded Contexts. The MVP must not create empty packages, tables, handlers, or ports for them.

One implementation module may contain more than one Bounded Context. This co-location does not merge their Aggregates, language, repositories, or invariants.

A coarse module may use internal packages such as:

```text
work-decision
├── work
└── decision
```

Cross-context writes occur only through an explicit Application Service or idempotent event handler. A repository writes only its owned Aggregate tables.

---

## Context Relationships

### Identity & Organization → Organization-Owned Contexts

Identity & Organization supplies trusted identity, active Membership, role, Organization status, and tenant-scope facts.

Work, Decision, and Memory remain authoritative for their own business state.

Every Organization-owned Aggregate contains exactly one `organizationId`. Human Identity remains global and does not become owned by one Organization.

Relationship type:

```text
Published Language / Application Policy Input
```

---

### Work Management ↔ Decision Management

A Decision belongs to one Work in the MVP.

Work requests or references a Decision. Decision owns review and resolution. Work owns its local completion gate and matches outcomes to an immutable `decisionId + revisionNumber + submittedSnapshotId` reference.

Authoritative Decision outcomes are applied to Work by an idempotent handler.

Relationship type:

```text
Explicit Application Coordination + Domain Events
```

The MVP commits submission of a blocking Decision revision and Work's matching transition to `WaitingForDecision` atomically because both contexts share one PostgreSQL database. A Draft Decision never blocks Work. This `RequestBlockingDecision` transaction is the only approved Work/Decision exception; outcome propagation is asynchronous and does not make the contexts one Aggregate.

---

### Work Management → Organizational Memory

Successful Human Work completion stores `WorkCompleted` in the Transactional Outbox.

The Memory-generation workflow uses the event to persist one immutable, Organization-scoped generation source snapshot before calling the external AI provider.

Relationship type:

```text
Durable Asynchronous Domain Event
```

Work does not own Memory. Generation failure does not reopen or roll back completed Work.

---

### Decision Management → Organizational Memory

Memory generation may use only immutable Decision submitted or resolved snapshots identified by revision or snapshot identity and content hash.

Relationship type:

```text
Versioned Immutable Reference
```

Memory does not depend on the current mutable Decision draft or a search projection.

---

### Organizational Memory → Knowledge Management

**Future relationship — not active in the MVP.**

Approved Memory may be selected as Evidence by an explicit Human-authorized Knowledge use case.

No Memory state transition automatically enters the Knowledge lifecycle.

---

### Knowledge Management → Capability Management

**Future relationship — not active in the MVP.**

Published Knowledge may later support Capability classification or measurement. Capability does not own or rewrite Knowledge.

---

## Secretary

The Secretary is an Organization-scoped AI Principal and cross-cutting participant. It is not a Bounded Context, Aggregate, cross-context Domain Service, or domain-owning central service.

The Secretary Runtime is an Application/Infrastructure adapter. It calls only narrow, context-owned AI Assistance Application Ports such as `WorkAiAssistancePort`, `DecisionAiAssistancePort`, or `MemoryAiAssistancePort`. Each owning context defines the typed request, bounded source snapshot, validation, provenance, failure result, and optional command that records an advisory contribution.

Secretary-facing ports never expose repositories, mutable Aggregates, database access, unrestricted queries, generic command dispatch, or Human-only commands. The runtime must not depend on a context's internal tables or Repository implementation.

The Secretary may:

- summarize Work;
- prepare Decision drafts;
- generate or suggest Memory draft content; and
- provide future Knowledge recommendations when that phase is implemented.

The Secretary must not:

- call repositories owned by another context directly;
- approve Decisions or Memory;
- complete Work;
- publish Knowledge;
- grant authority;
- bypass authorization; or
- turn advisory output into an authoritative transition automatically.

Every Secretary request is bound to one Organization, one authorized initiating Human or permitted System workflow, an allowlisted capability, bounded source data, and attributable provenance.

The allowlist key is `organizationId + secretaryPrincipalId + contextKey + assistanceOperation + portContractVersion`. This is an AI-assistance permission, not the future Capability domain concept. Unknown or revoked operations fail closed before provider invocation.

Generation authorizes only a proposal or attributable advisory contribution. A later Human command through the ordinary owning Application Service is required to adopt it and re-evaluates current authorization and Aggregate rules. The complete boundary is defined by [ADR-0011](../adr/0011-bound-secretary-to-context-owned-assistance-ports.md).

---

## Integration Rules

Contexts collaborate through:

- typed Application Service commands;
- immutable identity or revision references;
- Domain Events persisted through the Transactional Outbox;
- idempotent event handlers; and
- authorization-aware query interfaces.

Contexts do not collaborate through:

- shared mutable domain objects;
- direct cross-context repository writes;
- mutable foreign objects loaded inside Aggregates;
- telemetry or projections treated as source of truth; or
- synchronous network calls between MVP modules.

Within the Modular Monolith, in-process calls are permitted only through explicit module interfaces.

---

## Consistency and Transaction Boundaries

An Aggregate protects only invariants provable from its own state and command input.

A coordinated Application Service may use one PostgreSQL transaction across multiple Aggregates only when the use case explicitly requires atomicity and the participating Aggregate commands remain independently valid.

Required asynchronous follow-up uses Transactional Outbox delivery and eventual consistency.

The following distinctions are mandatory:

| Concern | Owner |
|---|---|
| Aggregate lifecycle and local invariants | Owning Aggregate |
| Context-wide deterministic rule with no natural Aggregate owner | Owning Bounded Context's Domain Policy or Specification |
| Cross-context use-case orchestration | Application Service |
| External or cross-Aggregate precondition | Application Service using Organization-scoped facts |
| Principal permission | Authorization policy |
| Structural and race-safe integrity | PostgreSQL constraint; it reinforces but does not define lifecycle meaning |
| Long-running temporal or completion rule | Durable process handler or process manager |
| Durable asynchronous delivery | Platform Runtime |
| Operational detection and recovery | Platform Runtime plus owning module command |

Every rule has one primary enforcement owner, failure outcome, and test boundary as defined by [ADR-0009](../adr/0009-assign-rule-enforcement-responsibilities.md). Coordination may invoke several owners but must not duplicate their semantics.

---

## Evolution Rules

A Bounded Context becomes an independently deployed service only when a demonstrated need exists, such as independent scale, deployment, operational isolation, stable external contract, or team ownership.

Future extraction must preserve:

- Organization isolation;
- Human authority;
- Aggregate ownership;
- event compatibility;
- idempotency;
- source provenance; and
- explicit failure recovery.

Microservice extraction is not an MVP objective.

---

## Canonical Document Responsibilities

| Concern | Canonical document |
|---|---|
| Ubiquitous Language and Principal terms | `docs/glossary.md` |
| Bounded Context classification and relationships | This Context Map |
| MVP implementation-module mapping | This Context Map and `docs/architecture/overview.md` |
| Aggregate ownership and invariants | `docs/architecture/aggregates/*` |
| Lifecycle transitions | `docs/architecture/state-machines/*` |
| Cross-Aggregate orchestration | `docs/architecture/application-services.md` |
| Authorization and Human/AI/System authority | `docs/architecture/authorization.md` |
| Event delivery and Worker semantics | `docs/architecture/events-and-outbox.md` |
| Table and migration ownership | `docs/architecture/persistence-and-data-model.md` |
| MVP delivery scope | `docs/product/mvp.md` |
