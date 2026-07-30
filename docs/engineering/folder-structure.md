# Folder Structure

## Purpose

This document defines the standard directory structure of the AIOS monorepo.

A consistent structure improves maintainability, onboarding, and collaboration across the project.

All new modules should follow this structure unless an Architecture Decision Record (ADR) specifies otherwise.

---

# Repository Structure

```text
aios/
│
├── apps/
├── packages/
├── infra/
├── docs/
├── scripts/
├── .github/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

---

# apps/

Applications that are directly deployed.

```text
apps/
├── web/
├── api/
└── worker/                 # optional separate process entrypoint
```

### web

Next.js frontend application.

### api

NestJS backend application.

Its implementation is organized by owning module:

```text
src/modules/
├── identity-organization/
├── work/
├── decision/
├── memory/
├── secretary/
└── operations/
```

Each module owns its Domain, Application, Infrastructure adapters, contracts, and tests. Internal Domain types and ORM entities are not exported across module boundaries.

### worker

Optional runtime entrypoint for the Outbox, local consumer, Memory generation, recovery, and replay roles. It composes the same module-owned Application Services; it is not a separate Bounded Context or microservice.

---

# packages/

Reusable libraries shared across applications.

```text
packages/
├── ui/
├── config/
├── testing/
└── contracts/              # explicitly published transport contracts only
```

### ui

Reusable UI components.

### config

Shared configuration.

### testing

Test builders and infrastructure harnesses that do not contain business rules.

### contracts

Only stable transport schemas deliberately published between deployable entrypoints. Commands, Aggregates, repositories, ORM entities, and generic internal event types do not belong here.

---

# infra/

Infrastructure configuration.

Examples:

- Docker
- Terraform
- AWS

---

# docs/

Project documentation.

```text
docs/
├── product/
├── architecture/
├── engineering/
├── api/
└── adr/
```

---

# scripts/

Development and maintenance scripts.

Examples:

- Seed database
- Generate types
- Development helpers

---

# .github/

GitHub configuration.

Examples:

- Actions
- Issue Templates
- Pull Request Templates

---

# Guiding Principles

## Separate Applications from Libraries

Applications should contain application logic.

Reusable code belongs in packages.

---

## Keep the Domain Independent

Business rules must not depend on frameworks.

The domain layer should remain portable and testable.

---

## Prefer Small Packages

Create focused packages with clear responsibilities.

Avoid large utility packages with unrelated functionality.

---

## Documentation Lives with the Project

Documentation is part of the product.

Keep documentation updated alongside implementation.
