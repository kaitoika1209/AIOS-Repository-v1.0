# MVP Implementation Plan

> **Document status:** Normative  
> **Blueprint version:** 0.2.1  
> **Applies to:** Phase 1 MVP implementation

## Purpose

This document converts the accepted architecture into an ordered implementation backlog. It does not add product scope. A milestone is complete only when its vertical behavior, database rules, negative tests, telemetry, and operating evidence are present in the same release candidate.

## Global definition of done

Every implemented use case must have:

- one owning module and Application Service;
- typed command/query and stable error contract;
- trusted Principal and Organization context resolved server-side;
- explicit transaction boundary and idempotency rule;
- Aggregate tests for local invariants;
- authorization and foreign-Organization negative tests;
- repository integration tests against PostgreSQL;
- event/Outbox contract tests where events are emitted;
- bounded logs, metrics and traces without prohibited data;
- migration and rollback/forward-fix classification; and
- documentation updated when the executable contract changes.

The following fail the definition of done: direct controller-to-ORM business mutation, shared mutable ORM entities, a Worker bypassing an owning Application Service, authorization derived from request claims alone, or a required invariant protected only by reconciliation.

## Milestone dependency map

```text
M0 Repository and architecture guardrails
  -> M1 PostgreSQL, Identity, Organization and authorization
      -> M2 Work vertical slice
          -> M3 Decision and blocking coordination
              -> M4 Memory generation and Human review
                  -> M5 Operational hardening and recovery
                      -> M6 Production readiness approval
```

Later milestone scaffolding may be prepared earlier, but authoritative behavior cannot bypass an incomplete dependency gate.

## M0 — Repository and architecture guardrails

Deliver:

- pnpm/Turborepo workspace with `apps/web`, `apps/api`, optional `apps/worker`, and approved packages;
- TypeScript strict configuration, formatting, linting, unit/integration/e2e test commands;
- module skeletons for Identity & Organization, Work, Decision, Memory, Secretary, and Operations;
- composition roots for HTTP and each Worker role;
- dependency-boundary checks that reject cross-module Domain/internal imports and framework imports in Domain code;
- configuration schema, secret references, correlation context, clock/id factories, and safe error mapping; and
- CI for build, static checks, tests, migration-from-empty, secret scanning, dependency review, and architecture checks.

Exit evidence:

- clean checkout produces the same lockfile-backed build;
- one health endpoint and one PostgreSQL integration test run in CI;
- deliberate forbidden imports fail the architecture test; and
- no production credential or placeholder owner is required for local tests.

## M1 — PostgreSQL, Identity, Organization and authorization

Deliver:

- ADR-0014 migration sequence through roles, Organizations, Identities, Memberships, command idempotency, audit, and Outbox foundations;
- server-side IdP assertion mapping without provider-owned business authority;
- Organization creation, invite/activation/deactivation, role changes, and last-Owner protection;
- request context, policy decision, same-Organization repositories, safe not-found behavior, and transactional authorization recheck; and
- runtime, Worker, migration, read-only operations, and backup database grants.

Exit evidence:

- foreign-Organization tests cover known/random identifiers, reads, writes, relationships, list filtering, cache keys, and pooled-connection reuse;
- revocation and concurrent last-Owner tests fail closed;
- runtime roles cannot mutate schema, bypass audit, truncate, disable triggers, or access unscoped rows through an exposed repository; and
- schema fingerprint and constraint inventory match the reviewed baseline.

## M2 — Work vertical slice

Deliver:

- Work Aggregate, repository mapper, create/update/assign/start/cancel/complete commands, queries, audit, and UI/API slice;
- expected-version concurrency and command idempotency;
- `WorkCompleted` Outbox insertion in the same completion transaction; and
- explicit Human-only completion with no Decision or Secretary completion path.

Exit evidence:

- lifecycle transition table is executable as tests;
- duplicate, concurrent, stale-version and cross-Organization commands are covered;
- `WorkCompleted` commits exactly once with the authoritative completion; and
- no handler exists yet that fabricates Memory before M4.

## M3 — Decision and blocking coordination

Deliver:

- immutable Decision revisions and create/edit/submit/approve/reject/withdraw flows;
- Human reviewer authorization and exact submitted-snapshot binding;
- coordinated blocking-Decision Application Service from ADR-0013;
- idempotent Decision-outcome consumer that updates the Work Completion Gate; and
- visible failure/reconciliation for mismatched, stale, duplicate, out-of-order, and poison outcomes.

Exit evidence:

- rollback is tested at every partial coordinated-transaction failure point;
- concurrent requests prove one unresolved blocking Decision per Work;
- approval never completes Work and completion remains a separate Human command; and
- cancellation/outcome and completion/outcome races have deterministic terminal results.

## M4 — Memory generation and Human review

Deliver:

- canonical source snapshot transaction from ADR-0012;
- durable generation operation, allowlisted provider request, timeout, fencing, retry, failure, abandonment, and reconciliation;
- Memory Aggregate and generated/edit/submit/reject/reopen/approve flows;
- one-Memory-per-Work database guarantee and exact reviewed-revision approval binding; and
- Secretary/provider provenance without granting authoritative actor status.

Exit evidence:

- provider call occurs outside PostgreSQL transactions;
- crash and duplicate tests cover every boundary before/after request and finalization;
- late result after lease loss cannot commit;
- a Human can correct and review generated content; and
- Approved Memory is immutable and is not Knowledge.

## M5 — Operational hardening and recovery

Deliver:

- all ADR-0015 Worker roles, retry profiles, fencing, fairness, shutdown, dead letter and single-delivery replay;
- dashboards, alerts, SLO calculations, missing-data behavior and bounded telemetry;
- migration, backlog, poison event, provider outage, secret rotation, incident, backup/PITR, restore and reconciliation runbooks;
- load and backlog-recovery tests using the production connection budget; and
- data retention/deletion workflow and post-restore deletion replay required by ADR-0012.

Exit evidence:

- failure-injection suite proves at-least-once correctness without duplicate business effect;
- one Organization cannot starve another;
- isolated restore meets measured RPO/RTO and passes integrity/isolation/authority checks; and
- alert delivery reaches named Human responders.

## M6 — Production readiness approval

Execute every mandatory gate in `security-and-production-readiness.md` against the exact release artifact and schema fingerprint. Record named Product/Domain, Security, Database/Data, Operations, and Release approvals.

Production remains blocked by expired evidence, placeholder owners, non-waivable invariant failure, unresolved critical vulnerability, untested restore, unscoped runtime data path, or incompatible contract/schema.

## Initial implementation backlog

Backlog items are created in this order inside each milestone:

1. executable contract and failure cases;
2. migration/constraint and repository adapter;
3. Domain behavior;
4. Application Service transaction and authorization;
5. event/Worker behavior;
6. API and presentation;
7. telemetry and runbook;
8. acceptance and failure-injection evidence.

Each backlog item references its owning architecture section and acceptance test. Generic tasks such as “implement backend,” “add security,” or “handle errors” are not implementation-ready.

## Decisions deferred without blocking M0

Exact supported dependency versions, AWS account identifiers, DNS names, Clerk tenant identifiers, OpenAI model/provider configuration, alert destinations, capacity values adjusted within ADR-0015 bounds, and jurisdiction-specific retention durations are environment or policy inputs. They must be fixed before the milestone that consumes them and before production evidence is collected.

They may not change Domain meaning, Human authority, Organization ownership, transaction boundaries, event identity, or immutable history. If they do, an ADR is required.

## Related documents

- [ADR-0017](../adr/0017-fix-mvp-implementation-baseline.md)
- [MVP](../product/mvp.md)
- [Architecture Overview](../architecture/overview.md)
- [MVP Database Migration Plan](../architecture/mvp-database-migration-plan.md)
- [Worker Runtime Profile](../architecture/worker-runtime-profile.md)
- [Security and Production Readiness](../architecture/security-and-production-readiness.md)

