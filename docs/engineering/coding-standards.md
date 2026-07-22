# Coding Standards

## Purpose

This document defines the coding standards used throughout AIOS.

The goal is to ensure that every part of the system is consistent, maintainable, and aligned with the architecture of the product.

These standards apply to all source code in the repository.

---

# Philosophy

Code is read far more often than it is written.

Favor clarity over cleverness.

Favor consistency over personal preference.

Business rules should be easy to discover, understand, and modify.

---

# General Principles

## Keep Business Logic in the Domain

Business rules belong in the domain layer.

Controllers, application services, and infrastructure should coordinate behavior rather than implement business logic.

### Good

```typescript
work.complete()
```

### Bad

```typescript
work.status = "completed"
```

---

## Prefer Behavior over State Mutation

Expose business actions instead of public state changes.

### Good

```typescript
decision.approve()
```

### Bad

```typescript
decision.status = "approved"
```

---

## One Responsibility per Class

Each class should have a single, well-defined responsibility.

Avoid classes that coordinate unrelated concerns.

---

## Keep Methods Small

Methods should perform one logical operation.

If a method requires extensive comments to explain its behavior, consider extracting additional methods or classes.

---

## Avoid Deep Nesting

Return early whenever possible.

### Good

```typescript
if (!work.canComplete()) {
    return;
}

work.complete();
```

### Bad

```typescript
if (work.canComplete()) {
    if (user.hasPermission()) {
        if (!work.isArchived()) {
            work.complete();
        }
    }
}
```

---

# Layer Responsibilities

## Presentation Layer

Responsible for:

- HTTP
- Validation
- Authentication
- Response formatting

Should not contain business rules.

---

## Application Layer

Responsible for:

- Use cases
- Transactions
- Coordination between domain objects

Should not contain business rules.

---

## Domain Layer

Responsible for:

- Business rules
- Domain entities
- Value objects
- Domain services
- Domain events

The domain layer must not depend on frameworks.

---

## Infrastructure Layer

Responsible for:

- Database access
- External APIs
- AI providers
- Messaging
- Storage

Infrastructure should depend on the domain, never the opposite.

---

# Error Handling

Use exceptions only for exceptional situations.

Business validation should be represented explicitly whenever possible.

Error messages should be clear and actionable.

---

# Logging

Log meaningful events.

Avoid excessive logging.

Never log secrets or sensitive information.

---

# Comments

Write self-explanatory code.

Comments should explain **why**, not **what**.

### Good

```typescript
// Retry because the external provider may be temporarily unavailable.
```

### Bad

```typescript
// Increment i.
i++;
```

---

# Code Reuse

Avoid duplication.

Extract shared behavior only when it represents a meaningful abstraction.

Do not create utility classes prematurely.

---

# Dependencies

Depend on abstractions rather than concrete implementations.

Keep dependencies pointing inward toward the domain.

---

# Testing

Every business rule should be testable.

Prefer unit tests for domain logic.

Use integration tests for infrastructure.

Use end-to-end tests to validate user workflows.

---

# Refactoring

Leave the codebase in a better state than you found it.

Small, continuous improvements are preferred over large rewrites.

---

# AI-Generated Code

AI-generated code must be reviewed before merging.

Generated code should follow the same standards as manually written code.

Never merge code simply because it compiles.

---

# Definition of Done

A change is considered complete when:

- Business requirements are satisfied.
- Tests pass.
- Code follows these standards.
- Documentation is updated when necessary.
- No unnecessary complexity has been introduced.