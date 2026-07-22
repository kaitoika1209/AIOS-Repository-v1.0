# Architecture Overview

## Overview

AIOS is an operating system designed to help organizations manage work, make better decisions, and continuously improve through organizational learning.

The architecture is organized around a small set of core domains that represent how organizations operate.

Rather than centering the system around projects or tasks, AIOS is centered around **Work**.

Every completed work contributes to organizational memory, which can later evolve into reusable knowledge.

---

## Core Domains

The AIOS architecture consists of the following core domains.

| Domain | Responsibility |
|---------|----------------|
| Organization | Represents companies and teams |
| Member | Represents human users and AI employees |
| Work | The central business object |
| Decision | Human decisions made during work |
| Memory | Organizational experience generated from completed work |
| Knowledge | Validated experience reusable across the organization |
| Workflow | Defines how work progresses |
| Capability | Represents organizational skills and growth |

---

## Domain Relationships

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
    Decision
        │
        ▼
     Memory
        │
        ▼
    Knowledge
```

Knowledge generated from previous work is reused to improve future work.

---

## Architectural Principles

AIOS follows these architectural principles.

### Work-Centered

Work is the primary entity of the system.

Every meaningful action is associated with a piece of work.

---

### Human-in-the-Loop

AI assists.

Humans remain responsible for decisions.

---

### Learning by Doing

Every completed work has the potential to improve the organization.

Learning is a built-in capability rather than an additional feature.

---

### Modular Design

Each domain has a clear responsibility and evolves independently.

This allows the platform to scale without tightly coupling business logic.

---

## System Layers

```text
Presentation
        │
Application
        │
Domain
        │
Infrastructure
```

Business rules belong in the Domain layer.

External services, databases, and frameworks belong in the Infrastructure layer.

---

## Technology Direction

The initial implementation uses a modular monorepo architecture.

- Frontend: Next.js
- Backend: NestJS
- Database: PostgreSQL
- ORM: Prisma
- AI Runtime: LangGraph

Technology choices are documented separately in `docs/engineering/tech-stack.md`.

---

## Related Documents

- `docs/product/vision.md`
- `docs/product/mvp.md`
- `docs/product/roadmap.md`
- `docs/architecture/domain-model.md`
- `docs/engineering/tech-stack.md`