# Memory Aggregate

## Purpose

The Memory Aggregate represents the historical record of a completed Work.

A Memory captures what actually happened during organizational activity, including important events, Decisions, outcomes, lessons learned, and AI contributions.

A Memory is an immutable record of experience.

Its responsibility is to preserve organizational history accurately.

A Memory is **not** organizational Knowledge.

Knowledge may later be created from one or more approved Memories through a separate business process.

---

# Aggregate Root

```text
Memory
```

`Memory` is the Aggregate Root.

All Memory modifications must occur through the Memory Aggregate.

---

# Identity

Each Memory has a globally unique identifier.

```text
MemoryId
```

A Memory belongs to:

- exactly one Organization
- exactly one completed Work

The identity of a Memory never changes.

Exactly one initial Memory may be generated from a completed Work.

---

# Responsibilities

The Memory Aggregate is responsible for:

- Preserving historical facts
- Recording Work outcomes
- Recording related Decisions
- Recording Secretary contributions
- Managing the Memory review lifecycle
- Preserving review history
- Serving as evidence for future Knowledge
- Emitting Memory-related domain events

The Memory Aggregate is **not** responsible for:

- Managing Work
- Managing Decisions
- Creating Knowledge
- Updating Knowledge
- Managing Organization Members
- Executing AI workflows

---

# Entities

## Memory

Aggregate Root.

Suggested attributes

```text
Memory
- id
- organizationId
- workId
- status
- title
- summary
- lessonsLearned
- outcome
- workSnapshot
- decisionReferences
- secretaryContributions
- reviewHistory
- createdAt
- approvedAt
- archivedAt
```

---

## MemoryReviewRecord

Represents a review action performed by a Member.

```text
MemoryReviewRecord
- reviewerId
- action
- comment
- createdAt
```

Review records are append-only.

---

## MemorySecretaryContribution

Represents AI-generated content that contributed to the Memory.

Examples:

- Summary
- Timeline
- Lessons Learned
- Risks
- Action Items

Every contribution records:

- model version
- prompt version
- timestamp

Secretary contributions become permanent historical evidence.

---

# Value Objects

## MemoryStatus

Possible values

```text
Generated
InReview
Approved
Rejected
Archived
```

Transitions are defined in

```text
docs/architecture/state-machines/memory.md
```

---

## LessonsLearned

Represents important experience extracted from the Work.

Rules

- may contain multiple lessons
- preserves wording used during review
- becomes immutable after approval

---

## Outcome

Represents the result of the Work.

Examples

- Success
- Partial Success
- Failure
- Cancelled

Outcome is historical information.

It must never be modified after approval.

---

# Relationships

## Organization

Every Memory belongs to exactly one Organization.

---

## Work

Every Memory belongs to exactly one completed Work.

```text
Work
    │
    └── generates
            ▼
        Memory
```

The Work Aggregate does not own the Memory.

Memory is created after the `WorkCompleted` domain event.

---

## Decision

A Memory references every relevant Decision associated with its Work.

Decision history remains immutable.

Memory stores only Decision identifiers and summarized outcomes.

---

## Secretary

The Secretary generates the initial Memory.

The Secretary may

- summarize the Work
- summarize Decisions
- identify lessons learned
- organize the timeline

The Secretary must never

- approve Memory
- reject Memory
- modify approved Memory

---

## Knowledge

Knowledge is **not** owned by the Memory Aggregate.

Knowledge references Memory.

```text
Memory
      ▲
      │ Evidence
Knowledge
```

A Memory may support:

- zero Knowledge
- one Knowledge
- many Knowledge

Knowledge never changes the original Memory.

---

# Commands

The Memory Aggregate supports

```text
StartMemoryReview

ApproveMemory

RejectMemory

ArchiveMemory
```

Memory creation itself occurs automatically after Work completion.

There is intentionally no

```text
CreateMemory
```

command.

---

# Business Rules

## Memory Generation

A Memory is automatically generated when:

- WorkCompleted occurs

Generation includes:

- Work summary
- Decisions
- Timeline
- Participants
- Secretary contributions
- Lessons Learned draft

Exactly one initial Memory is generated.

---

## Review

Only active Members may review.

AI cannot review.

Review actions become permanent history.

---

## Approval

Approval means

> This Memory accurately represents what happened.

Approval does **not** mean

> This is reusable organizational knowledge.

Approved Memories become immutable.

---

## Rejection

Rejected Memories remain historical records.

Rejection requires a reason.

Rejected Memories cannot become direct evidence until corrected through the review process defined by the application.

---

## Archival

Archived Memories remain searchable.

Historical audit information is never deleted.

---

# Invariants

## Identity

A Memory represents exactly one completed Work.

A Memory must never represent multiple Works.

The Memory identity never changes.

---

## Organization Boundary

- one Organization
- one completed Work
- same Organization as the Work
- same Organization as referenced Decisions

---

## Historical Integrity

Approved historical information is immutable.

Review history is append-only.

Secretary contributions are append-only.

Audit timestamps are immutable.

---

## Review Integrity

Only human Members approve.

Only human Members reject.

AI has no review authority.

---

## Knowledge Boundary

A Memory is not Knowledge.

A Memory does not become Knowledge.

A Memory may serve as evidence for one or more Knowledge records.

Knowledge must preserve a permanent reference to its source Memories.

---

# Domain Events

The Memory Aggregate may emit

```text
MemoryGenerated

MemoryReviewStarted

MemoryApproved

MemoryRejected

MemoryArchived

KnowledgePromotionRequested
```

Knowledge creation belongs to the Knowledge domain.

---

# Transaction Boundary

The Memory Aggregate may modify

- review state
- review history
- archive state

The Memory Aggregate must never modify

- Work
- Decision
- Knowledge
- Organization

---

# Authorization Boundary

The Aggregate enforces

- only Members review
- only authorized Members archive

Organization-wide permission evaluation belongs to the application layer.

---

# Consistency Model

Memory remains strongly consistent inside the Aggregate.

Knowledge creation occurs asynchronously through domain events.

---

# Repository Interface

```text
MemoryRepository

findById()

findByWorkId()

save()

exists()
```

Repository implementation belongs to the infrastructure layer.

---

# Open Questions

The following items remain open before Blueprint v1.0.0

- Should rejected Memories support revision?
- Should multiple reviewers be supported?
- Should approval require consensus?
- Should review deadlines exist?
- Should archived Memories ever return to active review?

---

# Related Documents

- docs/architecture/aggregates/work.md
- docs/architecture/aggregates/decision.md
- docs/architecture/aggregates/knowledge.md
- docs/architecture/state-machines/memory.md
- docs/product/mvp.md