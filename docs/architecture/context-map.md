# Context Map

## Purpose

This document defines the high-level bounded contexts of AIOS and the relationships between them.

The Context Map provides a conceptual view of how major business capabilities are separated while still collaborating through well-defined interfaces and domain events.

It complements the Aggregate design by describing the responsibilities and interactions of larger domain boundaries.

The Context Map is implementation-independent.

It does not prescribe deployment, database boundaries, or microservice architecture.

---

# Design Principles

The AIOS Context Map follows these principles:

- Each bounded context owns a distinct business capability.
- Each context defines its own ubiquitous language.
- Aggregates never span multiple bounded contexts.
- Cross-context communication occurs through references, application services, or domain events.
- Historical traceability is preserved across contexts.
- AI assistance never bypasses context boundaries.

---

# Context Overview

```text
                   +----------------------+
                   |   Organization       |
                   |  Identity & Access   |
                   +----------+-----------+
                              │
                              │
      +-----------------------+-----------------------+
      │                                               │
      ▼                                               ▼
+-------------------+                     +----------------------+
| Work Management   |-------------------->| Decision Management  |
+-------------------+     Decision        +----------------------+
          │
          │ WorkCompleted
          ▼
+------------------------+
| Organizational Memory  |
+------------------------+
          │
          │ Approved Memory
          ▼
+------------------------+
| Knowledge Management   |
+------------------------+
          │
          │ Published Knowledge
          ▼
+------------------------+
| Capability Management  |
+------------------------+

                 ▲
                 │
        AI Secretary (Cross-cutting)
```

---

# Bounded Contexts

## Organization Context

### Purpose

Defines organizational identity and security boundaries.

### Responsibilities

- Organization lifecycle
- Member management
- Authentication
- Authorization
- Roles
- Permissions
- Secretary registration
- Organization policies

### Owns

- Organization
- Member
- Secretary

### Publishes Events

Examples:

```text
MemberInvited
MemberActivated
MemberSuspended
OrganizationCreated
SecretaryRegistered
```

---

## Work Management Context

### Purpose

Represents organizational activity.

### Responsibilities

- Work lifecycle
- Participants
- Ownership
- Progress
- Completion

### Owns

- Work Aggregate

### Publishes Events

```text
WorkCreated
WorkStarted
WorkCompleted
WorkArchived
```

### Consumes

- Member information
- Organization information

---

## Decision Management Context

### Purpose

Represents organizational judgment.

### Responsibilities

- Decision lifecycle
- Decision revisions
- Options
- Approval
- Blocking Decisions

### Owns

- Decision Aggregate

### Publishes Events

```text
DecisionProposed
DecisionApproved
DecisionRejected
DecisionRevised
```

### Consumes

- Work references
- Member information

---

## Organizational Memory Context

### Purpose

Preserves organizational experience.

### Responsibilities

- Memory generation
- Review
- Approval
- Historical preservation
- Secretary contributions

### Owns

- Memory Aggregate

### Publishes Events

```text
MemoryGenerated
MemoryApproved
MemoryRejected
KnowledgePromotionRequested
```

### Consumes

- WorkCompleted
- Decision summaries

---

## Knowledge Management Context

### Purpose

Transforms organizational experience into reusable Knowledge.

### Responsibilities

- Knowledge lifecycle
- Evidence
- Confidence
- Revision history
- Publication
- Deprecation

### Owns

- Knowledge Aggregate

### Publishes Events

```text
KnowledgePublished
KnowledgeRevisionPublished
KnowledgeDeprecated
KnowledgeArchived
```

### Consumes

- Approved Memory
- Knowledge promotion requests

---

## Capability Management Context

### Purpose

Organizes reusable Knowledge into organizational capabilities.

### Responsibilities

- Capability catalog
- Capability ownership
- Knowledge association
- Organizational competency analysis

### Owns

- Capability Aggregate (future)

### Publishes Events

```text
CapabilityCreated
CapabilityUpdated
CapabilityStrengthened
```

### Consumes

- Published Knowledge

---

# AI Secretary

The Secretary is a cross-cutting AI participant rather than a bounded context.

The Secretary interacts with multiple contexts while respecting their ownership boundaries.

The Secretary may:

- summarize Work,
- assist Decisions,
- generate Memory drafts,
- identify Knowledge candidates,
- recommend Confidence,
- retrieve Published Knowledge.

The Secretary must not:

- approve Decisions,
- approve Memory,
- publish Knowledge,
- bypass authorization,
- modify published history.

The Secretary communicates through application services and domain events rather than directly modifying aggregates across contexts.

---

# Context Relationships

## Organization → All Contexts

Organization provides the shared identity and authorization boundary.

Every business context belongs to exactly one Organization.

---

## Work → Decision

Relationship:

```text
Customer / Supplier
```

Work provides organizational activity.

Decision depends on Work context.

---

## Work → Organizational Memory

Relationship:

```text
Domain Event
```

```text
WorkCompleted
        │
        ▼
MemoryGenerated
```

Memory owns the resulting historical record.

Work does not own Memory.

---

## Decision → Organizational Memory

Relationship:

```text
Reference
```

Memory stores Decision identifiers and summaries.

Decision remains the source of truth.

---

## Organizational Memory → Knowledge

Relationship:

```text
Upstream / Downstream
```

Approved Memory provides Evidence.

Knowledge never modifies Memory.

Memory remains the historical source.

---

## Knowledge → Capability

Relationship:

```text
Customer / Supplier
```

Capability organizes reusable Knowledge.

Knowledge remains authoritative.

Capability does not duplicate Knowledge.

---

## Organization → Secretary

The Secretary belongs to exactly one Organization.

Secretary permissions are governed by the Organization Context.

---

# Integration Patterns

Contexts communicate using:

- Domain Events
- Aggregate references
- Application Services

Contexts do not communicate through shared mutable state.

Examples:

```text
WorkCompleted
        │
        ▼
MemoryGenerated

MemoryApproved
        │
        ▼
KnowledgeCandidateIdentified

KnowledgePublished
        │
        ▼
CapabilityStrengthened
```

---

# Ubiquitous Language

Each context owns its own terminology.

| Context | Core Concepts |
|----------|---------------|
| Organization | Organization, Member, Secretary |
| Work | Work, Participant |
| Decision | Decision, Option, Revision |
| Memory | Memory, Review, Lessons Learned |
| Knowledge | Knowledge, Evidence, Confidence |
| Capability | Capability |

Concept meanings must remain consistent within their owning context.

---

# Context Boundaries

Each context owns its own:

- lifecycle,
- business rules,
- invariants,
- domain events,
- aggregate roots.

Contexts must not directly enforce another context's invariants.

---

# Evolution Strategy

The Context Map is intentionally designed for gradual evolution.

### MVP

Implemented:

- Organization
- Work
- Decision
- Memory

Knowledge and Capability remain future roadmap items.

### Future

Potential future contexts include:

- Policy Management
- AI Employee Management
- Skill Management
- External Knowledge Sources
- Analytics
- Semantic Search
- Notification
- Workflow
- Integration

These should integrate through existing context boundaries rather than expanding existing Aggregates.

---

# Architectural Benefits

This Context Map provides:

- Clear ownership boundaries
- Independent evolution of business capabilities
- Reduced coupling
- Strong traceability
- Consistent ubiquitous language
- AI governance boundaries
- Future microservice readiness
- Better maintainability

---

# Relationship to Other Documents

This document complements:

- `docs/architecture/domain-model.md`
- `docs/architecture/authorization.md`
- `docs/architecture/aggregates/*`
- `docs/architecture/state-machines/*`

The Domain Model defines **what** the core business concepts are.

The Aggregate documents define **how** each concept protects its invariants.

The State Machines define **how** those concepts evolve.

The Context Map defines **where** each responsibility belongs.

Together, these documents describe the complete domain architecture of AIOS Blueprint v0.2.0.