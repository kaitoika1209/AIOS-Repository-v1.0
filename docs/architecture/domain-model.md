# Domain Model

> **Document scope:** Complete AIOS Blueprint  
> **MVP implementation boundary:** Human-approved Memory  
> **Scope classification:** Mixed — MVP Normative concepts and Future Hypotheses  
> **Future Hypotheses:** Evidence, Knowledge, Capability, AI Employees, External Knowledge Sources, and Semantic Search  
> **Implementation authority:** Future sections have none until promoted under ADR-0010

The conceptual learning cycle in this document describes the long-term target domain. The MVP implements Organization, Human Membership, Secretary assistance, Work, Decision, and Human-reviewed Memory, and stops at Approved Memory.

The presence of a future concept in this document is not authorization to implement it in the MVP. Normative wording inside a Future Hypothesis describes a condition for later design approval, not a current code, schema, event, interface, or deployment obligation.

No placeholder implementation is required for future concepts. Promotion requires an accepted implementation ADR and an update to the authoritative release-scope document as defined by [ADR-0010](../adr/0010-classify-blueprint-scope-and-implementation-authority.md).

---

## Purpose

This document defines the conceptual domain model of AIOS.

Its purpose is to establish a shared understanding of the core business concepts, their responsibilities, and their relationships.

The domain model is intentionally independent of:

- databases,
- APIs,
- frameworks,
- user interfaces,
- infrastructure,
- implementation language.

It represents the ubiquitous language of AIOS.

---

# Core Philosophy

AIOS is an organizational operating system.

Organizations perform Work.

Work produces Decisions.

Completed Work becomes organizational Memory.

Approved Memory provides Evidence.

Evidence supports reusable Knowledge.

Knowledge strengthens organizational Capability.

This continuous learning cycle enables organizations to improve over time while preserving complete historical traceability.

---

# Conceptual Flow

```text
Organization
      │
      ▼
   Members
      │
      ▼
      Work
      │
      ▼
   Decisions
      │
      ▼
Completed Work
      │
      ▼
    Memory
      │
      │ Evidence
      ▼
   Knowledge
      │
      ▼
  Capability
```

This flow represents organizational learning.

Each concept has a distinct responsibility and lifecycle.

---

# Core Domain Concepts

## Organization

Represents the tenant, business-ownership, authorization, and data-isolation boundary.

Every Organization-scoped business resource belongs to exactly one Organization.

Examples:

- Memberships
- Work
- Decisions
- Memory
- Knowledge
- Capabilities
- Secretary registration

Business ownership does not imply one transactional boundary.

The Organization does not contain all Organization-scoped resources inside the Organization Aggregate. Human Identity, Membership, Work, Decision, Memory, Knowledge, and Capability preserve their separately defined Aggregate boundaries.

Organization is not a single transactional consistency boundary. Each Aggregate Root remains its own local consistency boundary.

---

## Member

Represents a human participant.

Members perform authoritative business actions.

Examples:

- complete Work
- approve Decisions
- review Memory
- publish Knowledge

Members are responsible for organizational judgment.

---

## Secretary

Represents an AI participant.

The Secretary assists Members by:

- summarizing
- drafting
- recommending
- analyzing
- retrieving organizational context

The Secretary never replaces human authority.

---

## Work

Represents organizational activity.

Examples:

- Projects
- Tasks
- Investigations
- Meetings
- Campaigns

Work is the source of organizational experience.

Completed Work generates Memory.

---

## Decision

Represents an organizational question together with its answer.

Examples:

- Vendor selection
- Product direction
- Budget approval
- Technical choice

A Decision belongs to one Work.

Multiple Decisions may exist within one Work.

---

## Memory

Represents verified historical experience.

Memory records:

- what happened
- outcomes
- lessons learned
- Decision summaries
- Secretary contributions

Memory is immutable after approval.

Memory is not reusable Knowledge.

---

## Evidence (Future — Outside MVP)

Represents traceable support for Knowledge.

Evidence is not an MVP domain object. It is introduced with future Knowledge promotion after the MVP can produce Approved Memory.

Evidence links:

```text
Approved Memory
        │
        ▼
   Knowledge
```

Evidence ensures explainability.

Knowledge always remains connected to organizational history.

---

## Knowledge (Future — Outside MVP)

Represents reusable organizational understanding.

Knowledge is created separately through explicit Human-authorized promotion and publication. Approved Memory may provide Evidence, but no Memory state transition creates Knowledge automatically.

Examples:

- Best practices
- Recommended approaches
- Organizational guidance
- Operational heuristics

Knowledge evolves through revisions.

Knowledge is never silently rewritten.

Knowledge always references Evidence.

---

## Capability (Future — Outside MVP)

Represents organizational competence.

Capability is introduced only after reusable Knowledge and measurable organizational performance exist.

Capabilities are strengthened through accumulated Knowledge.

Examples:

- Sales
- Engineering
- Marketing
- Customer Success

Capabilities provide a way to organize organizational Knowledge.

---

# Aggregate Relationships

The following conceptual relationships exist.

```text
Organization

├── Members

├── Secretary

├── Work
│      │
│      └── Decisions
│
├── Memory
│
├── Knowledge
│
└── Capability
```

Cross-Aggregate communication occurs through references and Domain Events.

Aggregates never directly modify one another.

---

# Learning Model

The organizational learning cycle is:

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

The meaning of each transition is:

Work

↓

Experience

Decision

↓

Organizational judgment

Memory

↓

Verified historical record

Knowledge

↓

Reusable understanding

Capability

↓

Improved organizational performance

---

# Traceability

AIOS preserves complete traceability.

```text
Knowledge
     │
Evidence
     │
Memory
     │
Work
```

Every published Knowledge record can be traced back to the organizational experiences that support it.

Traceability enables:

- Explainability
- Auditability
- Trust
- Governance

---

# AI Participation

The Secretary participates throughout the organizational lifecycle.

```text
Work
  │
  ├── summarize
  ├── identify risks
  ├── recommend Decisions
  │
Decision
  │
  ├── draft rationale
  ├── compare options
  │
Memory
  │
  ├── summarize
  ├── identify lessons
  │
Knowledge
  │
  ├── identify patterns
  ├── recommend revisions
  ├── suggest Evidence
  ├── recommend Confidence
```

Human Members remain responsible for authoritative decisions.

---

# Domain Boundaries

Each Aggregate has a single responsibility.

| Aggregate | Primary Responsibility |
|------------|------------------------|
| Work | Organizational activity |
| Decision | Organizational judgment |
| Memory | Historical experience |
| Knowledge | Reusable organizational understanding |
| Capability | Organizational competence |

No Aggregate assumes another Aggregate's responsibility.

---

# Domain Events

The canonical MVP learning facts are:

```text
WorkCompleted

↓

MemoryGenerated

↓

MemorySubmittedForReview

↓

MemoryApproved | MemoryRejected
```

`WorkCompleted` is delivered through the Transactional Outbox to the durable Memory-generation process. Generation scheduling and failure use generation-operation state, not additional `MemoryGenerationRequested` or `MemoryGenerationFailed` Domain Events.

The future learning hypothesis continues conceptually from Approved Memory to Human-selected Evidence, Published Knowledge, and Capability measurement. Names such as `KnowledgeCandidateIdentified`, `KnowledgePublished`, and `CapabilityStrengthened` are illustrative until their future Bounded Contexts, event contracts, authorization rules, and implementation ADRs are accepted. They are not registered MVP events.

Events coordinate implemented Aggregates while preserving independence.

---

# Design Principles

The AIOS domain model follows these principles.

## Single Responsibility

Each Aggregate owns one business concept.

---

## Explicit Authority

Human authority is never implicit.

AI recommendations never become authoritative automatically.

---

## Historical Integrity

Historical records are preserved.

Approved Memory and Published Knowledge are immutable.

---

## Explainability

Knowledge is supported by traceable Evidence.

Every recommendation can be explained.

---

## Organizational Learning

Organizations continuously improve by converting experience into reusable Knowledge.

---

## Evolution without Rewriting

Knowledge evolves through revisions.

Historical revisions remain preserved.

---

## Organization Isolation

Every Organization-owned business Aggregate belongs to exactly one Organization and preserves its Organization identity.

Human Identity is not Organization-owned. Membership links one Human Identity to one Organization and scopes Human authority within that Organization.

Cross-Organization references, reads, and modifications are denied by default unless a future explicit sharing model grants access without changing ownership.

---

# Future Extensions

The domain model intentionally supports future concepts such as:

- External Knowledge Sources
- Organization Policies
- Skills
- Competencies
- AI Employees
- Multi-Organization Collaboration
- Knowledge Graphs
- Semantic Retrieval
- Automated Knowledge Discovery

These extensions should preserve the existing Aggregate boundaries.

---

# Related Documents

- `docs/architecture/overview.md`
- `docs/architecture/authorization.md`
- `docs/architecture/aggregates/work.md`
- `docs/architecture/aggregates/decision.md`
- `docs/architecture/aggregates/memory.md`
- `docs/architecture/aggregates/knowledge.md`
- `docs/glossary.md`
