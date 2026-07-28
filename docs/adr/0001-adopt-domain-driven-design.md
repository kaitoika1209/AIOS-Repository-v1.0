# ADR-0001: Adopt Domain-Driven Design

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1

## Context

AIOS is centered around business concepts such as Work, Decision, Memory, and Knowledge.

The project requires a modeling approach that reflects the language and processes of organizations rather than technical implementation details.

---

## Decision

AIOS adopts Domain-Driven Design (DDD) as its primary architectural approach.

The domain model is the source of truth for the application.

Business rules belong in the domain layer.

Infrastructure and frameworks must support the domain rather than define it.

---

## Consequences

### Positive

- Shared business language.
- Clear separation of responsibilities.
- Easier long-term maintenance.
- Better alignment between business and implementation.

### Negative

- Higher initial learning curve.
- More upfront design effort.

---

## Related Documents

- [Domain Model](../architecture/domain-model.md)
- [Architecture Overview](../architecture/overview.md)
- [Coding Standards](../engineering/coding-standards.md)
