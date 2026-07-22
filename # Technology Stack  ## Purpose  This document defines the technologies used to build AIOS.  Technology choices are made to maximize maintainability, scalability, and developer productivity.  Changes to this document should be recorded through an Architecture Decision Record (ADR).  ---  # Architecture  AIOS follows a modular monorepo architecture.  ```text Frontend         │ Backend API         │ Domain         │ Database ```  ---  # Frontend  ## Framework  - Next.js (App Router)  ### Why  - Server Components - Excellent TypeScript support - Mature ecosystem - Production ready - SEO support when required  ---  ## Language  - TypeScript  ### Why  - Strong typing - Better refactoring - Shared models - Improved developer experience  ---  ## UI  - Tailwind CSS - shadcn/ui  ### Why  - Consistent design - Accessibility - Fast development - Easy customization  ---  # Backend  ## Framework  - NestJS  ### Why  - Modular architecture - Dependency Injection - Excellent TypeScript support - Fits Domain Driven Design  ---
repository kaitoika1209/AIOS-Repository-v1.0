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
├── services/
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
└── api/
```

### web

Next.js frontend application.

### api

NestJS backend application.

---

# packages/

Reusable libraries shared across applications.

```text
packages/
├── domain/
├── ui/
├── shared/
├── config/
└── types/
```

### domain

Business rules and domain models.

### ui

Reusable UI components.

### shared

Common utilities.

### config

Shared configuration.

### types

Shared TypeScript types.

---

# services/

Standalone services.

Examples:

- AI Worker
- Notification Worker
- Scheduler

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