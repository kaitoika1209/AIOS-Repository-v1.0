# ADR-0001: Separate Memory and Knowledge

- Status: Accepted
- Date: 2026-07-23
- Blueprint Version: v0.2.0

---

# Context

Early versions of the AIOS Blueprint treated organizational Memory and Knowledge as closely related concepts.

During architectural review, it became clear that this blurred two fundamentally different business responsibilities:

- preserving historical organizational experience, and
- managing reusable organizational understanding.

Mixing these responsibilities would make it difficult to:

- preserve historical integrity,
- evolve organizational knowledge,
- explain AI recommendations,
- support governance,
- maintain auditability.

The domain therefore required an explicit separation.

---

# Decision

AIOS separates **Memory** and **Knowledge** into independent Aggregates.

## Memory

Memory represents verified organizational history.

Memory records:

- what happened,
- outcomes,
- lessons learned,
- related Decisions,
- supporting context.

Once approved, Memory becomes immutable.

Memory is never edited or generalized.

Its purpose is historical preservation.

---

## Knowledge

Knowledge represents reusable organizational understanding.

Knowledge:

- is derived from one or more Approved Memories,
- is supported by Evidence,
- evolves through revisions,
- may increase or decrease in confidence,
- may eventually be deprecated.

Knowledge is not history.

Knowledge is organizational guidance.

---

## Evidence

Evidence provides the traceable relationship between Memory and Knowledge.

Evidence references Approved Memory.

Knowledge therefore remains explainable and auditable.

Knowledge never owns or modifies Memory.

---

# Consequences

This decision provides several architectural benefits.

## Historical Integrity

Historical facts remain unchanged after approval.

Knowledge evolves without rewriting history.

---

## Explainability

Every published Knowledge record can be traced back to supporting organizational experience.

AI recommendations therefore remain explainable.

---

## Governance

Memory approval and Knowledge publication become independent governance processes.

Organizations may evolve Knowledge without altering historical records.

---

## Separation of Responsibilities

The responsibilities become explicit.

| Aggregate | Responsibility |
|-----------|----------------|
| Memory | Historical organizational experience |
| Knowledge | Reusable organizational understanding |

This improves maintainability and reduces conceptual coupling.

---

## Future Evolution

Knowledge may later incorporate additional Evidence sources such as:

- Policies
- External references
- Technical documentation
- Standards

without changing the Memory Aggregate.

---

# Alternatives Considered

## Single Aggregate

Treat Memory and Knowledge as one Aggregate.

Rejected because:

- historical facts and reusable guidance have different lifecycles,
- different governance,
- different invariants,
- different revision models.

---

## Memory Becomes Knowledge

Allow approved Memory to transform into Knowledge.

Rejected because:

- history would lose its independent identity,
- Knowledge revisions would affect historical traceability,
- organizational experience and organizational guidance are different concepts.

---

# Rationale

Organizations learn by transforming experience into reusable understanding.

That transformation should be explicit.

The architectural boundary between Memory and Knowledge preserves:

- historical integrity,
- organizational learning,
- explainability,
- auditability,
- and long-term maintainability.

This boundary is one of the foundational design decisions of the AIOS Blueprint.