# Git Workflow

## Purpose

This document defines the Git workflow used by AIOS.

The workflow is designed to keep development simple, predictable, and easy to review.

---

# Branch Strategy

AIOS follows a lightweight Git workflow.

```text
main
└── feature/<feature-name>
```

The `main` branch always represents the latest stable version of the project.

All development should be performed in feature branches.

---

# Branch Naming

Use lowercase with hyphens.

Examples:

```text
feature/work-creation
feature/authentication
feature/home-dashboard
feature/secretary-ai
```

---

# Commit Messages

Follow the Conventional Commits specification.

Examples:

```text
feat(work): add work creation

fix(auth): resolve session refresh issue

docs: add domain model

refactor(work): simplify aggregate

test(work): add unit tests

chore: update dependencies
```

---

# Commit Guidelines

Each commit should represent a single logical change.

Avoid mixing unrelated changes in the same commit.

---

# Merging

Merge through Pull Requests.

Do not commit directly to `main`.

---

# Versioning

AIOS follows Semantic Versioning.

Examples:

```text
v0.1.0
v0.2.0
v1.0.0
v1.1.0
v1.1.1
```