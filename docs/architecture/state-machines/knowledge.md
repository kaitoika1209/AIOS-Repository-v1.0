# Knowledge State Machine

## Purpose

The Knowledge State Machine defines the lifecycle of organizational Knowledge.

Unlike Memory, which records historical facts, Knowledge represents reusable organizational understanding that evolves over time.

The purpose of this state machine is to ensure that organizational Knowledge:

- is reviewed before publication,
- remains traceable to supporting Evidence,
- evolves through controlled revisions,
- preserves historical integrity,
- and is never silently rewritten.

---

# Lifecycle Overview

```text
                    Create Draft
                         │
                         ▼
                    +-----------+
                    |   Draft   |
                    +-----------+
                         │
          Publish         │
        (Human Review)    │
                         ▼
                  +---------------+
                  |  Published    |
                  +---------------+
                    │         │
      Create        │         │ Deprecate
      Revision      │         ▼
          │         │   +---------------+
          │         └──►|  Deprecated   |
          │             +---------------+
          │                     │
          ▼                     │ Archive
 +----------------+             ▼
 | Revision Draft |       +-------------+
 +----------------+       |  Archived   |
          │               +-------------+
          │ Publish
          ▼
     Published
```

---

# States

## Draft

The initial state of a newly created Knowledge.

Characteristics:

- Editable
- Not authoritative
- May change freely
- May add or remove Evidence
- May update Confidence
- May update applicability
- May update limitations

AI may assist.

Only human Members may publish.

---

## Published

Published Knowledge is the current authoritative organizational guidance.

Characteristics:

- Immutable
- Searchable
- Available to AI retrieval
- Referenced by Capabilities
- Has confirmed Confidence
- Has approved Evidence

Published Knowledge cannot be edited directly.

Any change requires a new Revision Draft.

---

## Revision Draft

Represents a proposed update to an existing Published Knowledge.

Characteristics:

- Inherits previous revision
- Editable
- Not authoritative
- May revise Evidence
- May revise Confidence
- May narrow applicability
- May refine wording
- May add limitations

The previous Published revision remains active until the Revision Draft is published.

---

## Deprecated

Knowledge that is no longer recommended.

Reasons include:

- Better Knowledge exists
- Contradictory Evidence
- Organizational change
- Policy changes
- Technology changes

Deprecated Knowledge:

- remains searchable
- remains auditable
- should not be recommended by AI
- cannot be edited

A new Knowledge should normally replace deprecated Knowledge.

---

## Archived

Represents permanently inactive Knowledge.

Archived Knowledge:

- remains immutable
- remains searchable for audit
- is excluded from AI retrieval
- preserves complete history

Archive is the terminal state in Blueprint v0.2.0.

---

# Allowed Transitions

## Draft → Published

Requirements:

- Human approval
- Evidence exists
- Confidence confirmed
- Applicability defined
- Limitations documented

Event:

```text
KnowledgePublished
```

---

## Published → Revision Draft

Requirements:

- New Evidence
- Confidence change
- Applicability change
- Organizational learning
- Human request

Event:

```text
KnowledgeRevisionCreated
```

---

## Revision Draft → Published

Requirements:

Same publication requirements as the initial publication.

Event:

```text
KnowledgeRevisionPublished
```

The new revision replaces the previous Published revision.

---

## Published → Deprecated

Requirements:

- Human decision
- Deprecation reason

Event:

```text
KnowledgeDeprecated
```

---

## Deprecated → Archived

Requirements:

- Human decision
- Archive reason

Event:

```text
KnowledgeArchived
```

---

# Forbidden Transitions

The following transitions are not permitted:

```text
Published → Draft

Published → Published
(with direct modification)

Draft → Archived

Revision Draft → Archived

Archived → Published

Archived → Draft

Archived → Revision Draft

Deprecated → Published

Deprecated → Revision Draft
```

Changes to Published Knowledge always require a new Revision Draft.

Archived Knowledge cannot be restored in Blueprint v0.2.0.

---

# Human Authority

Only human Members may:

- Publish Knowledge
- Publish Revisions
- Deprecate Knowledge
- Archive Knowledge
- Confirm Confidence

---

# AI Authority

The Secretary may:

- Create Draft proposals
- Recommend revisions
- Recommend Confidence
- Suggest Evidence
- Suggest applicability
- Detect contradictory Evidence
- Recommend deprecation

The Secretary must never:

- Publish
- Deprecate
- Archive
- Confirm Confidence
- Modify Published Knowledge

---

# Invariants

The following conditions must always hold:

- Exactly one current Published revision may exist.
- Published Knowledge is immutable.
- Every Published revision has at least one eligible Evidence reference.
- Every Published revision has a confirmed Confidence score.
- Every revision preserves the same Knowledge identity.
- Every revision maintains complete traceability.
- Historical revisions are never deleted.
- AI cannot authoritatively change lifecycle state.

---

# Domain Events

The following events are emitted during lifecycle transitions:

```text
KnowledgeDraftCreated

KnowledgePublished

KnowledgeRevisionCreated

KnowledgeRevisionPublished

KnowledgeDeprecated

KnowledgeArchived
```

Recommendation events generated outside the Aggregate include:

```text
KnowledgeCandidateIdentified

KnowledgeRevisionRecommended

KnowledgeDeprecationRecommended

ContradictoryEvidenceDetected
```

These recommendation events never change lifecycle state directly.

---

# Relationship to Memory

Memory and Knowledge have different lifecycles.

Memory records history.

Knowledge represents reusable understanding.

```text
Completed Work
      │
      ▼
 Approved Memory
      │
      │ Evidence
      ▼
 Knowledge Draft
      ▼
 Published Knowledge
      ▼
 Revision Draft
      ▼
 Published Revision
```

Memory never becomes Knowledge.

Knowledge always references Memory through Evidence.

---

# Blueprint Notes

Blueprint v0.2.0 intentionally limits the lifecycle to a conservative governance model.

Future versions may introduce:

- Scheduled review
- Automatic review reminders
- Expiration
- Reactivation
- Multiple reviewer workflows
- Approval quorum
- Policy-based publication rules

These extensions should not change the core lifecycle defined in this document.