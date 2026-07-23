# AIOS Architecture Overview

## Purpose

This document provides the architectural overview of AIOS.

It introduces the core architectural concepts, explains how the domain is organized, distinguishes the long-term Blueprint from the initial MVP implementation, and serves as the recommended starting point for understanding the AIOS architecture.

The AIOS Blueprint is primarily implementation-independent.

It defines:

- the business architecture,
- the domain language,
- the principal domain boundaries,
- the authority model,
- the learning lifecycle,
- and the intended direction of future evolution.

The Blueprint does not require every modeled capability to be implemented in the MVP.

Where an implementation decision is necessary for the initial product, this document identifies it explicitly.

---

# Vision

AIOS is an organizational operating system.

Organizations do not improve simply by completing work.

They improve by:

- learning from experience,
- preserving organizational memory,
- developing reusable knowledge,
- and continuously strengthening organizational capability.

AIOS provides the domain model, governance, and AI collaboration needed to support that continuous learning process.

Human judgment remains authoritative.

AI accelerates organizational learning without replacing human decision-making.

---

# Guiding Principle

AIOS is designed around a single architectural idea:

> Organizations improve by transforming experience into reusable organizational knowledge.

Every major architectural decision in the Blueprint supports this learning cycle while preserving:

- human authority,
- historical integrity,
- explainability,
- organizational isolation,
- and operational trust.

---

# Core Learning Model

The central learning model of AIOS is:

```text
Work
   │
   ▼
Decision
   │
   ▼
Memory
   │
 Evidence
   ▼
Knowledge
   │
   ▼
Capability
```

Each concept represents a distinct business responsibility.

| Concept | Responsibility |
|---|---|
| Work | Organizational activity performed toward an intended outcome |
| Decision | An authoritative organizational judgment related to Work |
| Memory | A reviewed historical record of organizational experience |
| Evidence | Traceable support connecting a Knowledge claim to a source |
| Knowledge | Reusable organizational understanding |
| Capability | A representation of what the Organization can repeatedly perform |

The complete learning model belongs to the Blueprint.

The MVP implements only the earliest part of this cycle:

```text
Work
   │
   ▼
Decision
   │
   ▼
Memory
```

Knowledge promotion and Capability management are not part of the MVP.

---

# Blueprint and MVP Separation

The Blueprint and the MVP serve different purposes.

## Blueprint

The Blueprint describes the intended business architecture of AIOS.

It includes concepts that may not be implemented immediately, including:

- Knowledge,
- Evidence,
- Capability,
- AI Employees,
- External Knowledge Sources,
- Semantic Retrieval,
- organizational sharing,
- and advanced governance.

These concepts are retained in the architecture because they influence terminology, ownership, traceability, and future boundaries.

Their presence in the Blueprint does not place them in the MVP implementation scope.

## MVP

The MVP is the smallest implementation that can validate the core product hypothesis.

The MVP focuses on:

- Organization,
- human Members,
- one Secretary,
- Work,
- Decision,
- Memory generation,
- and minimum human Memory review.

The MVP validates whether an Organization can:

1. perform and track Work,
2. record meaningful Decisions,
3. receive assistance from one AI Secretary,
4. generate a structured Memory from completed Work,
5. correct that generated Memory,
6. and approve or reject the resulting historical record.

The MVP does not implement:

- Knowledge promotion,
- Knowledge publication,
- Capability measurement,
- multiple AI Employees,
- autonomous AI execution,
- external Evidence Sources,
- semantic retrieval,
- cross-Organization collaboration,
- or advanced authorization governance.

---

# MVP Memory Boundary

Memory review is part of the MVP.

This is necessary because generated Memory is produced by AI and may be:

- incomplete,
- inaccurate,
- misleading,
- or missing important context.

A generated Memory is therefore not authoritative by default.

The minimum MVP review flow is:

```text
Generated
   │
   ▼
InReview
   │
   ├──► Approved
   │
   └──► Rejected
```

Before approval, authorized human reviewers may correct the generated content.

The MVP does not require a separate `MemoryRevision` model.

Instead:

- `Generated` and `InReview` Memory content may be edited,
- approval captures the authoritative snapshot,
- and Approved Memory becomes immutable.

Knowledge promotion remains outside the MVP.

A Memory may therefore be approved as a historical organizational record without becoming reusable Knowledge.

---

# Architectural Principles

## Domain-Driven Design

Business concepts are modeled explicitly.

Aggregates protect invariants that can be guaranteed within their own consistency boundaries.

Bounded Contexts separate distinct business responsibilities and language.

Domain Events communicate completed domain facts.

Cross-Aggregate rules are not automatically Aggregate invariants.

Depending on the rule, they may instead be enforced by:

- Application Services,
- Domain Policies,
- database constraints,
- idempotent event handlers,
- or process coordination.

---

## Explicit Human Authority

Human Members remain responsible for authoritative business actions.

AI Principals, including the Secretary, may:

- summarize,
- draft,
- classify,
- recommend,
- and prepare proposed actions.

AI Principals may not independently:

- approve Decisions,
- approve Memory,
- publish Knowledge,
- grant authority,
- or bypass authorization.

Human authority must remain explicit in both the domain model and the application flow.

---

## Historical Integrity

AIOS distinguishes draft content from authoritative history.

Generated Memory may be corrected before approval.

Approved Memory is immutable.

Published Knowledge is not silently overwritten.

Knowledge evolves through revisions.

Historical records remain traceable even when later Decisions or Knowledge supersede earlier conclusions.

---

## Explainability

Every authoritative AI-assisted result must preserve sufficient provenance to explain:

- what was generated,
- what source information was used,
- which human approved it,
- and which model or prompt version contributed where applicable.

Every published Knowledge record must eventually be supported by traceable Evidence.

Semantic indexes and generated summaries are projections or assistance mechanisms.

They are not the source of truth.

---

## Organization Isolation

Every primary Aggregate belongs to exactly one owning Organization.

The Organization is:

- the tenant boundary,
- the ownership boundary,
- and the principal authorization scope.

The Organization is not a single transactional consistency boundary.

Work, Decision, Memory, and Knowledge remain independent consistency boundaries.

Cross-Organization modification is prohibited unless a future sharing or collaboration model explicitly grants access.

Future sharing must not require an Aggregate to be owned by multiple Organizations.

---

## AI Governance

AI participation is explicit and attributable.

Secretary contributions remain distinguishable from human actions.

AI recommendations never become authoritative automatically.

AI access must be limited by the same Organization, resource, and permission boundaries that apply to human access.

The Secretary remains a domain concept representing an organizational AI participant.

Its technical execution is coordinated through the Application Layer rather than by directly modifying unrelated Aggregates.

---

## Operational Reliability

Domain Events alone do not guarantee reliable processing.

Where an event triggers required follow-up work, the implementation must define:

- transactional event persistence,
- at-least-once delivery assumptions,
- idempotency,
- retry behavior,
- failure visibility,
- and manual recovery.

For the MVP, required event-driven processing should use the same PostgreSQL database with a Transactional Outbox and a background worker.

An external message broker is not required for the initial implementation.

The detailed decision belongs in an Architecture Decision Record.

---

# Domain Architecture

The principal domain concepts are:

```text
Organization
     │
     ├── Human Members
     │
     ├── AI Principals
     │      └── Secretary
     │
     ▼
    Work
     │
     ▼
 Decisions
     │
     ▼
   Memory
     │
  Evidence
     ▼
 Knowledge
     │
     ▼
 Capability
```

The Secretary participates across the domain while respecting:

- Application Layer boundaries,
- Aggregate boundaries,
- authorization rules,
- and human authority.

The Secretary is not an unrestricted cross-domain service.

It assists through explicit application use cases and ports.

---

# Actor Direction

The Blueprint uses `Actor` as the general term for an identity that performs or initiates an action.

The intended actor categories are:

```text
Actor
   ├── HumanMember
   ├── AIPrincipal
   │      └── Secretary
   └── SystemPrincipal
```

`Member` is reserved for a human member of an Organization.

An AI participant is not a Member.

Future AI Employees should be modeled as AI Principals rather than being added to the human Member model.

The detailed Actor model will be defined separately and applied consistently across:

- the Glossary,
- the Domain Model,
- Authorization,
- Aggregates,
- State Machines,
- and Domain Events.

Until that migration is complete, existing documents may still contain legacy terminology.

The Actor model document is authoritative once adopted.

---

# Bounded Context Direction

The Blueprint models distinct business responsibilities through Bounded Contexts.

The conceptual contexts include:

- Organization,
- Work Management,
- Decision Management,
- Organizational Memory,
- Knowledge Management,
- and Capability Management.

These conceptual boundaries may remain useful even when their initial implementation is deployed together.

The MVP must not implement each Bounded Context as an independently deployed service.

---

# Initial Implementation Architecture

The initial implementation is a Modular Monolith.

The expected implementation modules are approximately:

```text
Organization and Access

Work and Decision

Organizational Learning
```

These implementation modules may contain finer internal domain boundaries.

For example:

```text
Work and Decision
   ├── Work
   └── Decision

Organizational Learning
   ├── Memory
   ├── Knowledge
   └── Capability
```

Only the MVP portions of these modules are implemented initially.

This approach preserves domain boundaries without introducing premature distributed-system complexity.

The MVP should avoid:

- independent microservices,
- separate databases per Bounded Context,
- external event brokers without a demonstrated need,
- and network-based communication between internal modules.

Module boundaries should be protected through code structure and explicit interfaces.

A later architecture may extract a module only when there is a concrete reason, such as:

- independent scaling,
- independent deployment,
- different operational requirements,
- a stable integration contract,
- or clear team ownership.

---

# Architectural Layers

AIOS is described through complementary architectural views.

## Domain Model

Defines the core business concepts and their relationships.

```text
docs/architecture/domain-model.md
```

## Context Map

Defines conceptual Bounded Contexts and their relationships.

```text
docs/architecture/context-map.md
```

## Authorization

Defines organizational authority, access boundaries, and human-only actions.

```text
docs/architecture/authorization.md
```

## Aggregates

Define:

- Aggregate Roots,
- entities,
- value objects,
- locally enforceable invariants,
- domain behavior,
- and Domain Events.

Location:

```text
docs/architecture/aggregates/
```

## State Machines

Define Aggregate lifecycles and permitted transitions.

Location:

```text
docs/architecture/state-machines/
```

## Architecture Decision Records

Record significant architectural decisions, alternatives, and consequences.

Location:

```text
docs/adr/
```

## Product Documents

Define implementation scope and delivery sequencing.

Location:

```text
docs/product/
```

---

# Aggregate Overview

The Blueprint currently defines the following primary Aggregates.

| Aggregate | Responsibility | MVP |
|---|---|---|
| Work | Organizational activity | Yes |
| Decision | Organizational judgment | Yes |
| Memory | Historical organizational experience | Yes |
| Knowledge | Reusable organizational understanding | No |
| Capability | Organizational competence or classification | No |

Evidence is associated with Knowledge and requires further detailed modeling before Knowledge implementation begins.

Each Aggregate should own:

- one primary business concept,
- one identity,
- one local consistency boundary,
- and one set of locally enforceable invariants.

Aggregates communicate through:

- identity references,
- Domain Events,
- and coordinated Application Services.

An Aggregate must not directly mutate another Aggregate.

---

# Aggregate Invariants and External Consistency

An Aggregate invariant must be enforceable using the Aggregate's own state and command input.

Examples of valid local invariants include:

- a Work title must not be empty,
- a terminal Work cannot be reopened without an allowed transition,
- an Approved Memory cannot be edited,
- a rejected Decision cannot be approved without an allowed resubmission flow.

Rules requiring external state are not local Aggregate invariants.

Examples include:

- whether an owner is currently an active Organization Member,
- whether a referenced Decision belongs to the same Organization,
- whether a blocking Decision remains unresolved,
- whether a Memory already exists for a completed Work.

Such rules must be assigned explicitly to the appropriate mechanism.

Typical mechanisms include:

| Rule Type | Enforcement Mechanism |
|---|---|
| Current membership and permission | Application Service |
| Human-only authority | Application Policy and Domain Policy |
| Same-Organization reference | Application Service and persistence constraint where possible |
| One Memory per source Work | Unique database constraint and idempotent handler |
| Event-driven follow-up | Transactional Outbox and background worker |
| Multi-Aggregate workflow | Process coordinator or Application Service |

---

# State Machines

Each Aggregate owns its own lifecycle.

| Aggregate | Lifecycle |
|---|---|
| Work | Work execution and explicit completion |
| Decision | Proposal, review, approval, rejection, and later supersession |
| Memory | Generation, correction, review, approval, or rejection |
| Knowledge | Publication, revision, supersession, and deprecation |

State Machines must not assign two conflicting meanings to the same Domain Event.

In particular:

- Decision approval must not automatically complete Work.
- Decision approval may allow Work to continue or become eligible for completion.
- Work completion remains an explicit human-authorized action.
- Work completion triggers Memory generation through reliable asynchronous processing.

The detailed Work and Decision State Machines will define the exact MVP transition.

---

# Organizational Learning

The complete Blueprint learning flow is:

```text
WorkCompleted
      │
      ▼
MemoryGenerationRequested
      │
      ├──► MemoryGenerated
      │
      └──► MemoryGenerationFailed
                 │
                 └──► Retry or Manual Recovery

MemoryGenerated
      │
      ▼
MemoryReviewed
      │
      ├──► MemoryApproved
      │
      └──► MemoryRejected

MemoryApproved
      │
      ▼
KnowledgeCandidateIdentified
      │
      ▼
KnowledgePromotionRequested
      │
      ▼
KnowledgePublished
      │
      ▼
CapabilityStrengthened
```

The MVP stops at:

```text
MemoryApproved
```

The following events belong to later phases:

- `KnowledgeCandidateIdentified`
- `KnowledgePromotionRequested`
- `KnowledgePublished`
- `CapabilityStrengthened`

Event names represent completed facts unless explicitly named as requests.

Generation request, success, and failure must remain distinguishable where operational recovery depends on that distinction.

---

# AI Participation

The Secretary assists throughout supported use cases.

MVP examples include:

- summarizing Work discussions,
- drafting Work descriptions,
- drafting Decision proposals,
- organizing information,
- identifying missing context,
- generating Memory drafts,
- and suggesting corrections.

Future examples include:

- identifying reusable patterns,
- recommending Knowledge,
- suggesting Evidence,
- and recommending Confidence.

The Secretary never independently:

- approves Decisions,
- completes Work on behalf of a human authority,
- approves Memory,
- publishes Knowledge,
- confirms authoritative Confidence,
- grants access,
- or bypasses authorization.

The Secretary may prepare a proposed command.

A human-authorized application use case must perform authoritative commands.

---

# MVP Scope

The MVP includes:

## Organization and Access

- authentication,
- Organization creation,
- human Member invitation and membership,
- basic roles,
- Organization isolation,
- default-deny authorization,
- and human-only approval actions.

The MVP authorization model should remain limited to essential roles and permissions.

Advanced delegation, policy versioning, temporary access, and enterprise governance are future concerns.

## Work

- create Work,
- update Work,
- assign or identify responsible Members,
- track Work status,
- request Decisions,
- resume Work after a Decision is resolved,
- and explicitly complete Work.

## Decision

- create Decision proposals,
- review proposals,
- approve or reject Decisions,
- preserve Decision history,
- and associate Decisions with Work.

Advanced Decision supersession may be defined in the Blueprint before it is fully implemented.

## Secretary

- one AI assistant,
- no autonomous authority,
- explicit provenance for generated output,
- and access limited by Organization and resource scope.

## Memory

- request generation after Work completion,
- generate one Memory per source Work,
- detect and prevent duplicate generation,
- expose generation failure,
- allow correction before approval,
- allow human review,
- approve or reject Memory,
- and make Approved Memory immutable.

---

# MVP Out of Scope

The following capabilities are not part of the MVP:

- Knowledge promotion,
- Knowledge publication,
- Evidence management,
- Capability measurement,
- Capability strengthening events,
- multiple AI Employees,
- autonomous multi-agent collaboration,
- advanced workflow design,
- custom workflow engines,
- external Knowledge Sources,
- semantic retrieval,
- vector search as a user-facing knowledge system,
- cross-Organization sharing,
- marketplace,
- public API,
- SDK,
- plugin platform,
- enterprise compliance,
- policy versioning,
- temporary delegated authority,
- and advanced audit administration.

These exclusions do not remove the concepts from the Blueprint.

They only defer implementation.

---

# Roadmap Direction

Future phases may introduce:

## Workflow Expansion

- structured workflow templates,
- improved coordination,
- notifications,
- and activity projections.

## AI Organization

- AI Employees,
- specialized AI roles,
- multiple AI Principals,
- and controlled orchestration.

## Organizational Intelligence

- Knowledge promotion,
- Evidence management,
- Knowledge revision,
- organizational retrieval,
- external Knowledge Sources,
- and Knowledge reuse.

## Capability

- Capability taxonomy,
- Capability classification,
- and, only after a measurable model exists, organizational capability assessment.

## Platform

- public APIs,
- SDKs,
- plugins,
- marketplace capabilities,
- and third-party integrations.

The roadmap communicates direction rather than a fixed delivery commitment.

Future phases must not force premature complexity into the MVP.

---

# Open Question Classification

Open architectural questions must be classified by the point at which they require resolution.

## Before MVP Implementation

Questions that could cause conflicting implementation must be resolved before coding begins.

Examples:

- Work and Decision transition semantics,
- editable versus immutable Memory states,
- Actor terminology,
- Aggregate versus Application Service responsibilities,
- event delivery guarantees,
- duplicate Memory prevention,
- and MVP authorization scope.

## Before Knowledge Implementation

Examples:

- Evidence entity structure,
- Knowledge and KnowledgeRevision state separation,
- external Evidence Sources,
- Confidence calculation,
- and Knowledge supersession.

## Before v1.0

Examples:

- Decision supersession behavior,
- advanced audit requirements,
- sharing grants,
- retention policies,
- and operational recovery tooling.

## Future Exploration

Examples:

- Capability measurement,
- cross-Organization collaboration,
- multi-agent orchestration,
- autonomous execution,
- and external platform ecosystems.

Every unresolved item that blocks implementation should have:

- an owner,
- a decision deadline,
- and a linked ADR or decision record.

---

# Architecture Decision Records

The ADR set should use unique, stable numbering.

The intended sequence is:

```text
ADR-0001 — Adoption of Domain-Driven Design

ADR-0002 — Separation of Memory and Knowledge

ADR-0003 — Modular Monolith for the Initial Implementation

ADR-0004 — Transactional Outbox and Event Delivery

ADR-0005 — Work and Decision Consistency

ADR-0006 — Actor Model
```

Additional ADRs should be added when their decisions become necessary.

Possible later ADRs include:

- Memory correction and versioning,
- Evidence modeling,
- Organization ownership and sharing,
- external Evidence Sources,
- and AI provenance.

An ADR number must identify exactly one architectural decision.

---

# Reading Guide

The recommended reading order is:

```text
1. docs/architecture/overview.md

2. docs/glossary.md

3. docs/architecture/domain-model.md

4. docs/architecture/context-map.md

5. docs/architecture/authorization.md

6. docs/architecture/aggregates/

7. docs/architecture/state-machines/

8. docs/adr/

9. docs/product/mvp.md

10. docs/product/roadmap.md
```

This order moves from:

- vision,
- to language,
- to domain structure,
- to authority,
- to detailed behavior,
- to architectural decisions,
- and finally to implementation scope.

---

# Relationship Between Documents

The documents complement one another.

| Document | Primary Purpose |
|---|---|
| `overview.md` | Introduces the architecture and separates Blueprint from MVP |
| `glossary.md` | Defines the Ubiquitous Language |
| `domain-model.md` | Defines business concepts and relationships |
| `context-map.md` | Defines conceptual Bounded Contexts and integrations |
| `authorization.md` | Defines authority, access, and security boundaries |
| `aggregates/*` | Defines Aggregate structure and local invariants |
| `state-machines/*` | Defines lifecycle behavior |
| `adr/*` | Records significant architectural decisions |
| `product/mvp.md` | Defines initial implementation scope |
| `product/roadmap.md` | Defines future delivery direction |

When documents conflict:

1. an Accepted ADR governs the architectural decision it records;
2. Aggregate and State Machine documents govern detailed domain behavior;
3. Product documents govern implementation scope;
4. this Overview governs the general interpretation of Blueprint versus MVP.

A conflict must be corrected rather than left to implementation interpretation.

---

# Blueprint Scope

Blueprint v0.2.1 defines the business architecture and the initial implementation direction.

It does not prescribe all technology details.

Except where an MVP architecture decision has been explicitly adopted, the Blueprint does not prescribe:

- programming languages,
- web frameworks,
- UI frameworks,
- cloud providers,
- API protocols,
- deployment platforms,
- or vendor-specific AI services.

For the initial implementation, the Blueprint does prescribe the following direction:

- Modular Monolith,
- PostgreSQL as the primary transactional store,
- Transactional Outbox for required event-driven processing,
- background workers for asynchronous handlers,
- and no mandatory external event broker.

These implementation decisions should be recorded in ADRs rather than expanded into vendor-specific design in domain documents.

---

# Current Revision Priorities

Before MVP implementation begins, the following items must be made consistent across the Blueprint:

1. Work and Decision State Machines
2. Editable generated Memory and immutable Approved Memory
3. Aggregate invariants versus external consistency checks
4. Actor terminology
5. Event delivery and failure handling
6. Unique ADR numbering
7. MVP Memory review scope

Knowledge, Evidence, Capability, external Knowledge Sources, and advanced governance may remain as future architecture until their implementation phase approaches.

---

# Related Documents

- `docs/glossary.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/context-map.md`
- `docs/architecture/authorization.md`
- `docs/architecture/aggregates/`
- `docs/architecture/state-machines/`
- `docs/adr/`
- `docs/product/mvp.md`
- `docs/product/roadmap.md`