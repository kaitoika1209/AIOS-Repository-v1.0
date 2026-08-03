# Contributing to AIOS

Thank you for your interest in contributing to AIOS.

This document explains how to contribute to the project and where to find the engineering standards used throughout development.

---

## Before You Start

Please read the following documents before making any changes.

| Document | Purpose |
|----------|---------|
| [README.md](README.md) | Project overview |
| [docs/product/mvp.md](docs/product/mvp.md) | Current product scope — authoritative |
| [docs/document-governance.md](docs/document-governance.md) | Which document wins when documents disagree |
| [docs/architecture/domain-model.md](docs/architecture/domain-model.md) | Core business model |
| [docs/engineering/README.md](docs/engineering/README.md) | Engineering handbook |

Understanding these documents will help ensure that new contributions remain consistent with the architecture of AIOS.

## Scope discipline

AIOS documents a long-term vision far beyond what the MVP implements. Before building
anything, confirm it is classified **MVP Normative** in
[docs/product/mvp.md](docs/product/mvp.md).

A detailed design document does **not** mean the feature is approved. Per
[ADR-0010](docs/adr/0010-classify-blueprint-scope-and-implementation-authority.md), a
`MUST` inside a Future Hypothesis document means "required *if* this is later adopted",
not "required now". Knowledge, Evidence, Capability, and AI Employees are all documented
but explicitly out of MVP scope.

---

## Development Workflow

1. Create a feature branch.
2. Implement a single logical change.
3. Write or update tests where appropriate.
4. Update documentation if necessary.
5. Open a Pull Request.

Please follow the Git workflow described in:

[docs/engineering/git-workflow.md](docs/engineering/git-workflow.md)

---

## Coding Standards

All contributions should follow the project's coding standards.

See:

- [docs/engineering/coding-standards.md](docs/engineering/coding-standards.md)
- [docs/engineering/naming.md](docs/engineering/naming.md)

---

## Architecture Changes

Changes that affect architecture should be documented using an Architecture Decision Record (ADR).

Before introducing new architectural patterns, create or update an ADR in:

[docs/adr/](docs/adr/)

---

## Schema Changes

The schema has one authority and one path to it, and both are checked mechanically
([ADR-0015](docs/adr/0015-use-documented-ddl-and-direct-sql-for-persistence.md),
[ADR-0020](docs/adr/0020-adopt-forward-only-migrations-checked-against-the-documented-ddl.md)).

A schema change is three steps, in this order:

1. **Edit the document.** `docs/architecture/persistence-and-data-model.md` is the authority
   on what the schema *is*. `python3 scripts/extract_schema.py` regenerates
   `build/schema.sql` from it.
2. **Write the migration.** A new numbered file in `migrations/`, describing how a database
   that already holds rows reaches the new shape. Never edit an applied migration — the
   runner records a checksum and refuses to proceed when one changes, because an edited
   migration means some databases hold one schema and some another.
3. **Run the check.** `packages/persistence` tests compare the migration chain against the
   documented DDL and fail on any difference, in either direction. A migration with no
   documentation edit fails; so does a documentation edit with no migration.

There are no `down` migrations. Reversing a deployment means restoring from
point-in-time recovery, or writing a new forward migration.

```bash
python3 scripts/extract_schema.py            # documents → build/schema.sql
pnpm --filter @aios/api migrate -- --status  # what would be applied
pnpm --filter @aios/api migrate              # apply
```

---

## Pull Requests

Before submitting a Pull Request, ensure that:

- The project builds successfully.
- Tests pass.
- Documentation has been updated where necessary.
- The change has a clear and focused purpose.

Refer to:

- [docs/engineering/pull-request.md](docs/engineering/pull-request.md)
- [docs/engineering/review-checklist.md](docs/engineering/review-checklist.md)

---

## Reporting Issues

When reporting bugs or requesting features, include as much relevant information as possible.

Useful information includes:

- Expected behavior
- Actual behavior
- Steps to reproduce
- Environment details
- Screenshots (if applicable)

---

## Questions

If you are unsure about a design or implementation decision, discuss it before writing code.

Architecture decisions are easier to change before implementation than after deployment.

---

## Our Philosophy

AIOS is built around a simple principle:

> Build software that helps organizations become smarter over time.

Every contribution should move the product closer to that goal.
