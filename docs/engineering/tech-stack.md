# Technology Stack

> **Document status:** Normative for the MVP under ADR-0017  
> **Blueprint version:** 0.2.1

## Purpose

This document defines the technologies used to build AIOS.

Technology choices are made to maximize maintainability, scalability, and developer productivity.

Changes to this document should be recorded through an Architecture Decision Record (ADR).

---

# Architecture

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

# Frontend

## Framework

- Next.js (App Router)

### Why

- Server Components
- Excellent TypeScript support
- Mature ecosystem
- Production ready
- SEO support when required

---

## Language

- TypeScript

### Why

- Strong typing
- Better refactoring
- Shared models
- Improved developer experience

---

## UI

- Tailwind CSS
- shadcn/ui

### Why

- Consistent design
- Accessibility
- Fast development
- Easy customization

---

# Backend

## Framework

- NestJS

### Why

- Modular architecture
- Dependency Injection
- Excellent TypeScript support
- Fits Domain Driven Design

---

# Database

## Primary Database

- PostgreSQL

### Why

- Reliability
- Transactions
- JSON support
- Excellent ecosystem

---

## ORM

- Prisma

### Why

- Type safety
- Migration management
- Excellent developer experience

Prisma is a mapping and query tool, not the authoritative migration specification. Reviewed PostgreSQL SQL migrations, constraints, grants, triggers, validation phases, and schema fingerprints follow ADR-0014. Generated ORM metadata must mirror that schema.

---

# AI

## Runtime

- Context-owned Secretary assistance ports
- Provider adapter with durable generation operation

LangGraph and multi-agent orchestration are outside the MVP. They require a later ADR based on a measured orchestration need.

---

## Model Provider

- OpenAI

The model provider may change in the future.

The application should remain provider-agnostic.

---

# Authentication

- Clerk

### Why

- Fast implementation
- Secure authentication
- Organization support

Clerk is an Identity Provider only. AIOS PostgreSQL Organization, Membership, role, permission, and policy data remains authoritative. Provider Organization or role claims never grant business authority by themselves.

---

# Infrastructure

## Hosting

AWS

Initial services include:

- ECS
- RDS
- S3
- CloudFront

Infrastructure may evolve as the product grows.

---

# Package Management

- pnpm

---

# Monorepo

- Turborepo

---

# Testing

- Vitest
- Playwright

---

# Code Quality

- ESLint
- Prettier

---

# Guiding Principles

Technology should support the product.

Frameworks may change.

The domain model should not.
