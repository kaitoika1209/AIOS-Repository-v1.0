# ADR-0016: Establish the MVP Security and Production Readiness Gate

> **Status:** Accepted  
> **Date:** 2026-07-30  
> **Blueprint version:** 0.2.1

## Context

AIOS already defines Human authority, Organization-scoped authorization, PostgreSQL persistence, Transactional Outbox delivery, Worker recovery, audit, backup, and observability. Those controls are distributed across architecture documents. Implementation needs one release decision that identifies non-waivable invariants, required evidence, accountable Human owners, and the conditions under which production traffic may begin.

A checklist made only of component deployment success would not prove tenant isolation, restore safety, authority preservation, or asynchronous recovery. Conversely, requiring a mature distributed security platform, multi-region failover, or a dedicated SIEM before the MVP has validated its workload would add operational ownership without protecting a defined MVP risk.

## Decision

### One evidence-based gate

The normative gate is [MVP Security and Production Readiness](../architecture/security-and-production-readiness.md). Production approval requires evidence from the release candidate and production-equivalent controls, not document completion or owner assertion alone.

Every gate has one named Human owner, dated evidence, environment and artifact identity, result, and expiry or next-test date. A failed mandatory gate blocks production.

### Non-waivable correctness boundaries

No risk acceptance may waive:

- cross-Organization isolation;
- Human-only authoritative actions;
- Secretary advisory-only behavior;
- Decision approval not completing Work;
- explicit Human Work completion;
- approved Memory immutability;
- one-Memory-per-Work and source-snapshot integrity;
- required audit durability; or
- recoverability of the complete PostgreSQL consistency boundary.

Security and correctness invariants have no error budget.

### Tenant isolation without initial RLS

ADR-0014 remains authoritative: the MVP baseline does not enable PostgreSQL Row-Level Security. This is an explicit, testable tradeoff, not an assertion that application authorization is sufficient in every future deployment.

Production approval therefore requires scoped repository APIs, Organization-derived request context, composite Organization foreign keys, least-privilege database roles, adversarial integration tests using real pooling behavior, and an inventory proving there is no unscoped runtime data path.

RLS must be reconsidered before adding direct tenant SQL access, shared ad-hoc reporting, a runtime path that cannot structurally require Organization scope, or materially broader administrative/data integration access. Enabling it requires a reviewed migration and transaction-local context contract; it must never replace application authorization.

### Human approval and risk acceptance

Release approval belongs to named Human owners for Product/Domain, Security, Data/Database, and Operations. The Secretary may assemble evidence and recommend action but cannot approve a gate or accept risk.

A permitted exception must record scope, owner, reason, compensating control, expiry, and remediation. Critical invariant, active cross-tenant, authority, exposed-secret, unrecoverable-backup, or unexplained integrity failures cannot be accepted for production.

### MVP proportionality

The gate requires a threat model, least privilege, managed secrets, encryption, audit, isolation tests, restore proof, SLOs, alerts, runbooks, incident ownership, dependency-failure tests, and rollback/forward-fix readiness.

Multi-region active-active operation, microservice extraction, a dedicated policy service, customer-authored policy language, and a dedicated SIEM are not MVP prerequisites unless a contract, regulation, or measured threat requires them.

## Alternatives considered

### Enable RLS immediately

Deferred consistently with ADR-0014. Incomplete Worker, migration, recovery, and pooled-connection policies can create false assurance or privileged bypass. The chosen alternative makes the compensating controls and reconsideration triggers explicit.

### Treat deployment and smoke-test success as production readiness

Rejected because it does not prove isolation, authority, recovery, background progress, or incident response.

### Make every gate waivable by an operator

Rejected because operational access is not Organization business authority and because some violations invalidate the platform's trust model.

### Require enterprise security tooling before MVP

Rejected where a smaller managed control satisfies the same defined outcome. Tooling follows threats, obligations, evidence quality, and team ownership rather than product category.

## Consequences

Positive consequences:

- one auditable go/no-go decision across architecture domains;
- explicit ownership and expiry of evidence;
- visible acceptance criteria for the no-RLS MVP tradeoff;
- failures in asynchronous progress and recovery are release concerns; and
- future controls can be added without weakening Domain authority.

Costs and constraints:

- production-equivalent testing and restore exercises require time and isolated infrastructure;
- releases cannot proceed on undocumented exceptions;
- access-path and data-flow inventories must be maintained; and
- ownership gaps become launch blockers rather than latent operational debt.

## Related documents

- [MVP Security and Production Readiness](../architecture/security-and-production-readiness.md)
- [ADR-0014](0014-establish-mvp-database-migration-baseline.md)
- [ADR-0015](0015-fix-mvp-worker-runtime-profile.md)
- [Authorization](../architecture/authorization.md)
- [Persistence](../architecture/persistence-and-data-model.md)
- [Operations](../../observability-and-operations.md)

