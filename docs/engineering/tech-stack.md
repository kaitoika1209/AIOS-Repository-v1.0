# Technology Stack

## Purpose

This document defines the technologies used to build AIOS.

Technology choices are made to maximize maintainability, scalability, and developer productivity.

Changes to this document should be recorded through an Architecture Decision Record (ADR).

---

## Architecture

AIOS follows a modular monorepo architecture.

```text
Frontend
        │
Backend API
        │
Domain
        │
Database
```

---

## Frontend

### Framework

- Next.js (App Router)

#### Why

- Server Components
- Excellent TypeScript support
- Mature ecosystem
- Production ready
- SEO support when required

---

### Language

- TypeScript

#### Why

- Strong typing
- Better refactoring
- Shared models
- Improved developer experience

---

### UI

- Tailwind CSS
- shadcn/ui

#### Why

- Consistent design
- Accessibility
- Fast development
- Easy customization

---

## Backend

### Framework

- NestJS

#### Why

- Modular architecture
- Dependency Injection
- Excellent TypeScript support
- Fits Domain Driven Design

---

## Database

### Primary Database

- PostgreSQL

#### Why

- Reliability
- Transactions
- JSON support
- Excellent ecosystem

---

### Database Access

- `pg` (the PostgreSQL driver) with hand-written SQL

#### Why

- The documented DDL stays the single schema source, verified in CI
- Optimistic concurrency, tenant scoping, and Outbox claims stay explicit
- CHECK constraints, composite foreign keys, and partial unique indexes remain
  fully expressed

Prisma was previously listed here. It is **not** used in the MVP — see
[ADR-0015](../adr/0015-use-documented-ddl-and-direct-sql-for-persistence.md),
which resolves this against the persistence architecture's SQL-first guidance.

---

## AI

### Runtime

- LangGraph

#### Why

- Stateful workflows
- Multi-agent orchestration
- Human-in-the-loop support

---

### Model Provider

- OpenAI

The model provider may change in the future.

The application should remain provider-agnostic.

---

## Authentication

- Clerk

### Why

- Fast implementation
- Secure authentication
- Organization support

---

## Infrastructure

### Hosting

AWS

Initial services include:

- ECS
- RDS
- S3
- CloudFront

Infrastructure may evolve as the product grows.

---

## Package Management

- pnpm

---

## Monorepo

- Turborepo

---

## Testing

- Vitest
- Playwright

---

## Code Quality

- ESLint
- Prettier

---

## Guiding Principles

Technology should support the product.

Frameworks may change.

The domain model should not.
