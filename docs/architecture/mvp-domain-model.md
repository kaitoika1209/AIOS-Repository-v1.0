# MVP Domain Model

> **Document status:** Proposed  
> **Phase:** MVP  
> **Scope classification:** MVP Normative  
> **Blueprint version:** 0.2.1  
> **Architecture:** Modular Monolith

---

## Purpose

This document provides a compact implementation map of the AIOS MVP domain.

It identifies the MVP Aggregate boundaries, principal types, relationships, lifecycle summaries, and cross-Aggregate coordination rules. It does not redefine detailed business rules that already have an authoritative document.

The authoritative MVP product scope remains:

- `docs/product/mvp.md`

---

## Document Authority

When documents differ, use the following source for the relevant concern:

| Concern | Authoritative document |
|---|---|
| MVP inclusion and exclusion | `docs/product/mvp.md` |
| Identity, Organization, and Membership boundaries | `docs/architecture/identity-and-organization.md` |
| Authorization and Human-only authority | `docs/architecture/authorization.md` |
| Aggregate-owned state and local invariants | `docs/architecture/aggregates/*.md` |
| Lifecycle transitions and forbidden transitions | `docs/architecture/state-machines/*.md` |
| Application orchestration and transaction ownership | `docs/architecture/application-services.md` |
| Durable asynchronous delivery | `docs/architecture/events-and-outbox.md` |
| Persistence constraints and tenant isolation | `docs/architecture/persistence-and-data-model.md` |

This document summarizes those decisions and must not become a competing source of truth.

---

## MVP Domain Boundary

The MVP implements the following product loop:

```text
Human Member performs Work
        │
        ▼
Human Member records and reviews Decisions
        │
        ▼
Human Member explicitly completes Work
        │
        ▼
WorkCompleted is delivered asynchronously
        │
        ▼
System processing creates a Generated Memory
        │
        ▼
Human Member reviews the Memory
        │
        ▼
Approved Memory becomes immutable organizational history
```

The MVP ends at Approved Memory.

Knowledge, Evidence, Capability, AI Employees, external Knowledge Sources, and semantic search are outside the MVP implementation boundary.

---

## Principal Model

```text
Principal
├── Human Member Principal
├── AI Principal
│   └── Secretary
└── System Principal
```

- A Human Member Principal is derived from an active Human Identity and an active Membership in the selected Organization.
- Human Members are the only principals with business approval authority.
- The Secretary is an advisory AI Principal and is not a Member.
- A System Principal performs explicitly permitted technical processing.
- Secretary and System Principals cannot hold Human Memberships or Human roles.
- Event causation never grants new Human authority.

Future AI Employees are AI Principals, not Members.

---

## Aggregate Boundaries

| Aggregate Root | Owns | Does not own |
|---|---|---|
| Human Identity | Stable internal human identity and identity lifecycle | Organization roles, Work, or external provider identity as a domain key |
| Organization | Organization identity, lifecycle, and organization-level policy references | All Membership entities or business Aggregate state |
| Membership | One Human Identity–Organization relationship, membership lifecycle, and Organization-scoped role assignments | Human Identity lifecycle or Organization lifecycle |
| Work | Work lifecycle, assignments, participants, progress, blocking Decision gate, recorded Decision outcomes, and completion history | Decision or Memory Aggregate state |
| Decision | Decision lifecycle, revisions, submitted snapshots, review outcomes, and Decision history | Work lifecycle or completion |
| Memory | One completed Work's generated draft, submitted snapshots, review records, provenance, and approved history | Work, Decision, or future Knowledge state |

Each Aggregate Root is an independent local consistency boundary.

Organization is the tenant, ownership, authorization, and data-isolation boundary. It is not a single transactional consistency boundary.

---

## Aggregate Relationships

```text
Human Identity
      │
      │ Membership
      ▼
Organization
      │
      ├── Work ─────reference────► Decision
      │     │
      │     │ WorkCompleted
      │     ▼
      └── Memory
```

Rules:

- Every Organization-owned business Aggregate belongs to exactly one Organization.
- Cross-Organization references are prohibited.
- Aggregates reference one another by identifiers, not direct object references.
- Decision remains authoritative for Decision state.
- Work stores only the local blocking gate and committed Decision outcome facts required for its own lifecycle.
- Memory stores immutable source references and provenance; it does not own Work or Decision.
- Approved Memory is not Knowledge.

---

## Lifecycle Summary

| Aggregate | MVP states |
|---|---|
| Human Identity | Active, Disabled |
| Organization | Active, Suspended, Archived |
| Membership | Invited, Active, Suspended, Revoked |
| Work | Draft, InProgress, WaitingForDecision, Completed, Cancelled |
| Decision | Draft, InReview, Approved, Rejected, Withdrawn |
| Memory | Generated, InReview, Rejected, Approved |

The State Machine documents define the allowed and forbidden transitions. This table is only a navigation summary.

---

## Core MVP Invariants

### Human Authority

- Only an authorized Human Member may complete or cancel Work.
- Only an authorized Human Member may submit, approve, reject, or withdraw a Decision.
- Only an authorized Human Member may submit, approve, reject, or reopen Memory.
- Secretary output remains advisory until explicitly adopted through a Human-authorized command.
- A System Principal cannot create new business intent.

### Work and Decision

- Decision approval never completes Work.
- A committed Decision outcome may update Work's local completion gate.
- Work completion always requires a separate, explicit Human-authorized Work command.
- Completed and Cancelled Work are terminal for business data.

### Memory

- Memory generation begins only after a committed `WorkCompleted` event.
- Memory generation failure never rolls back completed Work.
- Repeated event delivery must not create duplicate Memory.
- The MVP maintains at most one active Memory Aggregate for each completed Work.
- Generated Memory is non-authoritative until Human review.
- Approved Memory is immutable.
- Approved Memory remains historical truth and does not automatically become Knowledge.

### Organization Isolation

- Every protected command executes in exactly one Organization context.
- Human authority requires an active Membership in that Organization.
- Repository access must require Organization scope.
- Composite Organization constraints must prevent cross-Organization relationships.
- Missing or inconsistent tenant context fails closed.

---

## Coordination and Transaction Boundaries

The Application Layer owns transactions and cross-Aggregate coordination.

Default command transaction:

```text
Load one Aggregate
Execute one command
Persist Aggregate
Persist Outbox events
Record idempotency result
Commit
```

Permitted MVP coordination patterns:

1. **Exceptional atomic creation**  
   Organization bootstrap, invitation acceptance requiring new identity state, ownership transfer, and blocking Decision creation may coordinate a bounded set of Aggregates in one PostgreSQL transaction when the architecture document explicitly defines the invariant.

2. **Asynchronous reaction**  
   Decision outcomes update Work, and `WorkCompleted` initiates Memory generation through the Transactional Outbox and idempotent background handlers.

A multi-Aggregate transaction is an explicit exception. It must not become the default application pattern or merge Aggregate boundaries.

---

## MVP Event Flow

```text
Human command
    │
    ▼
Aggregate state change + Outbox write
    │
    ▼
Commit
    │
    ▼
Background delivery
    │
    ▼
Idempotent consumer
    │
    ▼
Target Aggregate state change + new Outbox write
```

Required guarantees:

- Aggregate state and its Outbox messages commit atomically.
- Consumers assume at-least-once delivery.
- Consumer effects and processed-event records commit atomically.
- Original Human actor, System handler, correlation, and causation remain distinguishable.
- Event delivery may record an authoritative fact but cannot authorize a new Human-only command.

---

## MVP Scope Summary

| Concept | Scope classification |
|---|---|
| Human Identity, Organization, Membership | MVP Normative |
| Human Member | MVP Normative |
| Secretary AI Principal | MVP Normative |
| System Principal | MVP Normative for technical processing |
| Work | MVP Normative |
| Decision | MVP Normative |
| Generated and Human-reviewed Memory | MVP Normative |
| Knowledge and Evidence | Future Hypothesis; Explicitly Out of Scope |
| Capability | Future Hypothesis; Explicitly Out of Scope |
| AI Employees | Future Hypothesis; Explicitly Out of Scope |
| External Knowledge Sources | Future Hypothesis; Explicitly Out of Scope |
| Semantic or vector search | Future Hypothesis; Explicitly Out of Scope |
| Independent microservices | Explicitly Out of Scope |

---

## Implementation Rule

Implementation must follow the MVP Normative documents referenced above. Future Hypothesis documents have no MVP implementation authority under [ADR-0010](../adr/0010-classify-blueprint-scope-and-implementation-authority.md).

If implementation requires behavior not defined by an existing Aggregate, State Machine, authorization policy, or Application Service workflow, update the relevant authoritative architecture document before adding the behavior to code.
