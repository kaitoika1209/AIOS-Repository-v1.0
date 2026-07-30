# ADR-0017: Fix the MVP Implementation Baseline

> **Status:** Accepted  
> **Date:** 2026-07-30  
> **Blueprint version:** 0.2.1

## Context

The Domain and production-readiness architecture is sufficiently defined to begin implementation, but the earlier engineering guidance still permits structures that would undermine it: a shared Domain package, standalone services by default, ORM-owned migrations, an autonomous AI workflow runtime, and authentication-provider Organization state treated as business authority.

Implementation also needs one dependency order and one definition of done. Starting controllers, UI screens, Workers, and provider integration in parallel without a walking skeleton would delay discovery of transaction, isolation, and recovery failures until late in delivery.

## Decision

### Runtime and repository shape

The MVP is one modular-monolith codebase in a pnpm/Turborepo monorepo:

- `apps/web`: Next.js presentation application;
- `apps/api`: NestJS HTTP API and module-owned runtime composition;
- `apps/worker`: optional separate process entrypoint built from the same module code and release artifact family; and
- `packages`: UI, configuration, test utilities, and explicitly published transport contracts only.

Domain models, repositories, commands, and internal events remain inside their owning backend module. There is no shared cross-module Domain package, generic repository package, unrestricted database package, or `services/` microservice boundary in the MVP.

### Technology constraints

The implementation baseline uses TypeScript, Next.js, NestJS, PostgreSQL, Prisma where it is a useful mapping/query tool, pnpm, Turborepo, Vitest, Playwright, and AWS managed infrastructure.

Reviewed SQL migrations are authoritative under ADR-0014. Prisma schema and generated types must mirror the database; Prisma migration generation cannot replace required SQL constraints, grants, triggers, partial indexes, validation phases, or schema fingerprints.

Authentication may use Clerk, but only as an Identity Provider. AIOS PostgreSQL Identity, Membership, Organization, role, permission, and policy state remains authoritative. Provider Organization or role claims cannot grant AIOS authority without server-side mapping and current Membership evaluation.

The MVP Secretary uses a narrow provider adapter behind context-owned assistance ports from ADR-0011. LangGraph and multi-agent orchestration are not part of the MVP baseline. They require a later decision only when a measured workflow need cannot be met by the bounded generation operation.

### Delivery order

Implementation follows the vertical milestones in [MVP Implementation Plan](../engineering/mvp-implementation-plan.md): foundation and architecture tests; database/identity isolation; Work; Decision coordination; Memory generation/review; operational hardening; then production gate.

Each milestone must produce a runnable vertical slice, migration evidence, owned tests, telemetry, and updated contracts. UI completion cannot substitute for authoritative use-case tests.

### Change control

Dependency versions are locked in the repository and selected during bootstrap using supported releases. A framework or provider change may be made without redefining the Domain, but a change affecting transaction semantics, module boundaries, identity authority, event contracts, data residency, or production gates requires an ADR update.

## Alternatives considered

### Shared `packages/domain`

Rejected because it encourages modules to share Aggregates and Ubiquitous Language. Reusable primitives are copied or promoted only after a stable, non-domain contract is demonstrated.

### Standalone service per Worker or Bounded Context

Rejected for MVP because it would replace local transactions with distributed coordination without an operational need. Separate process entrypoints are allowed for resource isolation while using the same modular code and database contracts.

### Prisma-generated schema as authority

Rejected consistently with ADR-0014 because the required PostgreSQL safety model exceeds portable ORM metadata.

### LangGraph from the first Secretary feature

Rejected as premature orchestration. One bounded advisory generation operation needs a provider port, durable operation state, fencing, and Human review—not a multi-agent graph.

### Implement all layers horizontally

Rejected because it postpones proof of the highest-risk transactions and asynchronous recovery. Vertical milestones demonstrate executable behavior earlier.

## Consequences

Positive consequences:

- engineering structure matches the accepted modular-monolith architecture;
- Identity Provider and AI provider integrations cannot become authority owners;
- PostgreSQL invariants remain enforceable despite ORM use;
- delivery exposes transaction and recovery risk early; and
- later extraction remains possible through owned module contracts.

Costs and constraints:

- module code may contain deliberate local duplication;
- generated ORM migrations require review or replacement by SQL;
- Worker deployment composition needs explicit bootstrap wiring; and
- teams cannot create convenience shared packages without dependency review.

## Related documents

- [MVP Implementation Plan](../engineering/mvp-implementation-plan.md)
- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [ADR-0011](0011-bound-secretary-to-context-owned-assistance-ports.md)
- [ADR-0014](0014-establish-mvp-database-migration-baseline.md)
- [ADR-0016](0016-establish-mvp-security-and-production-readiness-gate.md)
- [Technology Stack](../engineering/tech-stack.md)
- [Folder Structure](../engineering/folder-structure.md)

