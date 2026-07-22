# Contributing to AIOS

Thank you for your interest in contributing to AIOS.

This document explains how to contribute to the project and where to find the engineering standards used throughout development.

---

# Before You Start

Please read the following documents before making any changes.

| Document | Purpose |
|----------|---------|
| README.md | Project overview |
| docs/product/mvp.md | Current product scope |
| docs/architecture/domain-model.md | Core business model |
| docs/engineering/README.md | Engineering handbook |

Understanding these documents will help ensure that new contributions remain consistent with the architecture of AIOS.

---

# Development Workflow

1. Create a feature branch.
2. Implement a single logical change.
3. Write or update tests where appropriate.
4. Update documentation if necessary.
5. Open a Pull Request.

Please follow the Git workflow described in:

`docs/engineering/git-workflow.md`

---

# Coding Standards

All contributions should follow the project's coding standards.

See:

- docs/engineering/coding-standards.md
- docs/engineering/naming.md

---

# Architecture Changes

Changes that affect architecture should be documented using an Architecture Decision Record (ADR).

Before introducing new architectural patterns, create or update an ADR in:

`docs/adr/`

---

# Pull Requests

Before submitting a Pull Request, ensure that:

- The project builds successfully.
- Tests pass.
- Documentation has been updated where necessary.
- The change has a clear and focused purpose.

Refer to:

- docs/engineering/pull-request.md
- docs/engineering/review-checklist.md

---

# Reporting Issues

When reporting bugs or requesting features, include as much relevant information as possible.

Useful information includes:

- Expected behavior
- Actual behavior
- Steps to reproduce
- Environment details
- Screenshots (if applicable)

---

# Questions

If you are unsure about a design or implementation decision, discuss it before writing code.

Architecture decisions are easier to change before implementation than after deployment.

---

# Our Philosophy

AIOS is built around a simple principle:

> Build software that helps organizations become smarter over time.

Every contribution should move the product closer to that goal.