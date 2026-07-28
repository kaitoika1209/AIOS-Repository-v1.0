# Architecture Decision Records

This directory records the architectural decisions made for AIOS.

An ADR captures a decision, the context that forced it, the alternatives rejected, and
the consequences accepted. ADRs are immutable once accepted: a decision that no longer
holds is **superseded** by a new ADR, never edited in place or deleted.

Per [ADR-0010](0010-classify-blueprint-scope-and-implementation-authority.md), an accepted
ADR is the **only** mechanism that can promote a Future Hypothesis into implementable
scope. Accepted ADRs are the highest authority in this repository — see
[Document Governance](../document-governance.md).

---

## Index

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-adopt-domain-driven-design.md) | Adopt Domain-Driven Design | Accepted | 2026-07-26 |
| [0002](0002-memory-vs-knowledge.md) | Separate Memory and Knowledge | Accepted | 2026-07-26 |
| [0003](0003-select-mvp-observability-stack.md) | Select the MVP Observability and Operations Stack | Accepted | 2026-07-26 |
| [0004](0004-separate-external-computation-and-business-effects.md) | Separate External Computation from External Business Effects | Accepted | 2026-07-26 |
| [0005](0005-adopt-boundary-enforced-modular-monolith.md) | Adopt a Boundary-Enforced Modular Monolith for the MVP | Accepted | 2026-07-26 |
| [0006](0006-use-postgresql-transactional-outbox.md) | Use a PostgreSQL Transactional Outbox with Durable Local Consumer Handoff | Accepted | 2026-07-26 |
| [0007](0007-coordinate-work-and-blocking-decisions.md) | Coordinate Work and Blocking Decisions with Atomic Activation and Asynchronous Outcomes | Accepted | 2026-07-26 |
| [0008](0008-define-work-to-memory-generation-process.md) | Define Work-to-Memory Generation as a Durable Process | Accepted | 2026-07-26 |
| [0009](0009-assign-rule-enforcement-responsibilities.md) | Assign Each Rule to an Explicit Enforcement Owner | Accepted | 2026-07-26 |
| [0010](0010-classify-blueprint-scope-and-implementation-authority.md) | Classify Blueprint Scope and Implementation Authority | Accepted | 2026-07-26 |
| [0011](0011-bound-secretary-to-context-owned-assistance-ports.md) | Bind the Secretary to Context-Owned AI Assistance Ports | Accepted | 2026-07-26 |
| [0012](0012-define-memory-source-snapshot-and-data-governance.md) | Define Memory Source Snapshot and Data-Governance Semantics | Accepted | 2026-07-26 |
| [0013](0013-bind-clerk-as-authentication-provider.md) | Bind Clerk as an Authentication Provider Without Ceding Identity Ownership | Proposed | 2026-07-28 |
| [0014](0014-adopt-rest-with-explicit-command-sub-resources.md) | Adopt REST with Explicit Command Sub-Resources and Header-Scoped Tenancy | Proposed | 2026-07-28 |

---

## Reading Order

New to the architecture? Read in this order:

1. **0001** — why the domain model is the source of truth.
2. **0005** — why one deployable unit with enforced module boundaries.
3. **0002** — the Memory / Knowledge distinction that shapes the whole product.
4. **0010** — what is actually approved for implementation versus explored on paper.
5. **0006**, **0004** — how events and external calls stay reliable.
6. **0007**, **0008**, **0009**, **0011**, **0012** — specific mechanisms.
7. **0013**, **0014** — how requests enter the system: authentication and the API surface.

---

## Status Values

| Status | Meaning |
|---|---|
| `Proposed` | Under discussion. Carries no authority. |
| `Accepted` | In force. Binding on implementation. |
| `Superseded by ADR-XXXX` | Replaced. Retained for history. |
| `Rejected` | Considered and declined. Retained to prevent re-litigation. |

---

## Writing a New ADR

Copy the structure below. Number sequentially; do not reuse a number.

Filename: `NNNN-short-kebab-case-title.md`

```markdown
# ADR-NNNN: Title in Imperative Mood

**Status:** Proposed
**Date:** YYYY-MM-DD
**Blueprint Version:** X.Y.Z

## Context

What forces this decision? What constraints apply? Avoid stating the decision here.

## Decision

What is being decided, stated actively: "AIOS adopts…", "The MVP uses…".

## Alternatives considered

What else was evaluated, and the specific reason each was rejected.

## Consequences

Benefits and costs. Costs are required — an ADR with no costs is under-analyzed.

## Related documents

Relative Markdown links, not bare paths.
```

The metadata block and `Status` value are verified in CI
(`.github/workflows/docs.yml`).
