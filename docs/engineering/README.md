# Engineering Handbook

Welcome to the AIOS Engineering Handbook.

This directory contains the engineering standards used throughout the project.

The goal is to ensure consistency, maintainability, and high code quality as AIOS evolves.

## Documents

| Document | Purpose |
|----------|---------|
| [tech-stack.md](tech-stack.md) | Technology choices |
| [folder-structure.md](folder-structure.md) | Repository layout |
| [coding-standards.md](coding-standards.md) | Coding conventions |
| [naming.md](naming.md) | Naming rules |
| [git-workflow.md](git-workflow.md) | Git workflow |
| [pull-request.md](pull-request.md) | Pull request guidelines |
| [review-checklist.md](review-checklist.md) | Review checklist, including ADR-0010 scope verification |
| [release-readiness.md](release-readiness.md) | What remains between the build and production, against the MVP Production Baseline |
| [backup-and-recovery.md](backup-and-recovery.md) | What recovery is proven, what is not, and runbook 6 |
| [worker-containment.md](worker-containment.md) | Pausing and resuming asynchronous processing — runbooks 7 and 8 |

## Related

| Document | Purpose |
|----------|---------|
| [../document-governance.md](../document-governance.md) | Which document wins when documents disagree |
| [../adr/README.md](../adr/README.md) | Architecture Decision Record index |
| [../glossary.md](../glossary.md) | Canonical domain vocabulary |

## Principles

- Keep the domain independent.
- Prefer clarity over cleverness.
- Favor consistency over personal preference.
- Document architectural decisions through ADRs.
- Never let a document contradict a higher-ranked one — fix the contradiction, don't work around it.
