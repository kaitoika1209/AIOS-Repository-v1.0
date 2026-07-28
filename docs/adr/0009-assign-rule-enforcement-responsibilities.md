# ADR-0009: Assign Each Rule to an Explicit Enforcement Owner

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1

## Context

AIOS uses DDD, Clean Architecture, a boundary-enforced Modular Monolith, PostgreSQL, Transactional Outbox processing, and Organization-scoped authorization. Rules therefore exist at several different boundaries.

The statement “all business rules belong inside Aggregates” is too broad. Some rules can be proved from one Aggregate's loaded state, while others require current Membership, multiple Aggregates, cross-context references, uniqueness under concurrency, asynchronous process state, or external authorization facts. Forcing all of them into an Aggregate would require repository access, hidden service calls, oversized Aggregate boundaries, or stale duplicated state.

The opposite extreme is also unsafe: moving lifecycle decisions into Application Services, SQL, Workers, or controllers would produce an anemic domain model and inconsistent behavior across entry points.

Implementation needs one classification that identifies the semantic owner of each rule and the mechanisms that enforce or reinforce it.

## Decision

### Rule ownership is explicit

Every implementation-relevant rule must be classified by its primary enforcement owner. A supporting mechanism may provide defense in depth, but it does not silently become the semantic owner.

The canonical classifications are:

| Rule class | Primary owner | Permitted inputs | Examples |
|---|---|---|---|
| Aggregate-local invariant | Owning Aggregate | Loaded Aggregate state, command values, actor category, deterministic Value Objects | Valid lifecycle transition; Approved Memory immutability; one review outcome per submitted snapshot |
| Domain Policy or Specification | Owning Bounded Context's Domain Layer | Explicit domain facts or Value Objects supplied by the Application Layer; no repository or infrastructure access | Policy combining several domain concepts where no single Aggregate owns the meaning |
| Authorization policy | Authorization capability | Authenticated Principal, Organization, command, resource scope, current Membership, roles and capabilities | Whether a Member may complete Work; whether a System Principal has the registered handler capability |
| Application precondition and orchestration | Owning Application Service | Authorized request context, scoped repository results, policy results, expected versions | Same-Organization reference validation; selecting the transaction pattern; coordinating Work and Decision |
| Structural data integrity | PostgreSQL schema and scoped repository | Keys, Organization identifiers, versions and persisted structural values | Foreign keys; unique Memory per Work; tenant-scoped uniqueness; valid status-field combinations |
| Durable process rule | Owning process handler or process manager | Registered event contract, durable process state, idempotency and fencing records | Generation retry budget; processed-event state; per-stream ordering and recovery |
| Technical delivery and operations | Platform Runtime | Outbox, claims, leases, registrations, telemetry and typed operational commands | At-least-once delivery; claim recovery; health detection; replay transport |

### Aggregate-local invariant test

A rule belongs inside an Aggregate when all of the following are true:

1. the rule protects the consistency of that Aggregate's business concept;
2. it can be decided synchronously from the fully loaded Aggregate, command input, deterministic Value Objects, and domain-significant actor category;
3. evaluation requires no repository, database query, clock hidden behind infrastructure, remote call, authorization store, projection, or another Aggregate; and
4. a successful command leaves the Aggregate internally valid regardless of later asynchronous effects.

Aggregate commands always revalidate their local invariants even after authorization and Application preconditions succeed.

Examples:

- only `InProgress` Work with a satisfied local Completion Gate may complete;
- only an `InReview` Decision may be approved;
- an Approved Memory cannot be edited; and
- one Decision submitted snapshot receives one immutable review outcome.

### Domain Policy and Specification

A Domain Policy or Specification is used when a rule expresses domain meaning across multiple facts but is not naturally owned by one Aggregate.

It must be:

- deterministic for its explicit inputs;
- owned and named by one Bounded Context;
- free of repositories, ORM entities, network clients, authorization stores, and transaction control;
- invoked by an Application Service with already-loaded or immutable facts; and
- covered by domain-level tests.

A Domain Policy does not become a generic “business-rules service.” If one Aggregate can own the rule without importing external state, the rule remains in that Aggregate.

### Authorization is permission, not domain validity

Authorization answers whether a Principal may attempt a command on a resource in an Organization. It owns current Membership, role, capability, suspension, and resource-scope checks.

Authorization success never proves that the command is a valid business transition. Authorization denial prevents the Aggregate command from running but does not mutate domain state.

Human authority may appear in two complementary forms:

- Authorization Policy verifies that the current Principal is an allowed Human Member for the use case; and
- the Aggregate verifies a domain-significant actor category when the business record itself must prove that only a Human can perform the transition.

This is deliberate defense in depth, not duplicate role-policy implementation inside the Aggregate.

### Application Services own external preconditions and orchestration

Application Services may enforce rules that require scoped repositories, policies, several Aggregate identities, transaction selection, or durable workflow coordination. This is application logic with business relevance; it is not Aggregate-local state-transition logic.

Examples include:

- verifying that referenced resources exist in the same Organization;
- loading current Membership facts for authorization;
- proving that the Decision and Work references agree before an approved coordinated transaction;
- checking idempotency and expected versions;
- choosing a documented multi-Aggregate transaction or eventual event flow; and
- mapping committed Domain Events to Integration Events.

Application Services must not set Aggregate-owned fields directly, recreate state-transition rules, or turn repository existence checks into hidden lifecycle decisions.

### PostgreSQL reinforces structural guarantees

PostgreSQL owns race-safe structural integrity that cannot be guaranteed by a prior read followed by a write.

Required examples include:

- unique Organization-scoped identities;
- composite foreign keys that preserve tenant ownership;
- one Memory for `(organizationId, sourceWorkId)`;
- one unresolved submitted blocking Decision per Organization and Work;
- optimistic version updates; and
- valid combinations of status, terminal attribution, Completion Gate, and outcome fields.

Database constraints reinforce domain and application decisions. SQL, triggers, or repositories must not independently decide whether a Human should approve, complete, reject, or publish a domain object.

### Durable processes own temporal and delivery rules

Rules involving elapsed time, retry, event ordering, delivery state, leases, recovery, or several transactions belong to an explicitly owned process handler or process manager.

The process may invoke an Aggregate command after validating its registered input contract. It must not mutate Aggregate tables directly or treat technical success as Human business authority.

Examples include:

- Decision outcome propagation into Work;
- Work-to-Memory generation operation state;
- per-Aggregate stream-head blocking;
- Membership revocation reconciliation; and
- projection rebuild progress.

### Rule declaration format

Every Aggregate, use case, or process document that defines a nontrivial rule should identify:

```text
Rule name
Primary owner
Authoritative inputs
Synchronous or eventual enforcement
Supporting database constraint or process control
Failure result
Audit requirement
Recovery owner where applicable
```

Documentation may group simple local invariants, but cross-Aggregate and authority-sensitive rules must not leave ownership implicit.

### Failure semantics remain distinct

The architecture uses stable failure categories:

- `Unauthorized` or `Forbidden`: Authorization Policy denied the attempt;
- `ValidationFailed`: command values or Value Objects are invalid;
- `InvalidState`: an Aggregate-local lifecycle rule rejected the command;
- `PreconditionFailed`: an external or cross-Aggregate application precondition is not satisfied;
- `Conflict` or `ConcurrencyConflict`: a uniqueness, version, or concurrent-state guarantee rejected the write;
- `Blocked` or `RetryPending`: a durable process cannot safely continue yet; and
- `InfrastructureFailure`: a required technical dependency failed before commit.

These categories must not expose the existence of another Organization's resource.

### Testing by owner

- Aggregate tests verify local lifecycle and invariant behavior without repositories.
- Domain Policy tests verify deterministic multi-fact business meaning.
- Authorization tests verify Principal, Membership, role, capability, Organization, and resource-scope matrices.
- Application Service tests verify enforcement order, scoped loading, coordination, transaction rollback, and result translation.
- Persistence tests verify constraints under concurrency and tenant mismatch.
- Process tests verify idempotency, ordering, leases, retries, recovery, and terminal outcomes.
- End-to-end tests verify that supporting layers cannot bypass the primary owner.

## Alternatives considered

### Put every business-relevant rule inside an Aggregate

Rejected because current Membership, cross-Aggregate uniqueness, same-Organization references, and temporal process rules cannot be proved by one Aggregate without hidden dependencies or oversized boundaries.

### Put cross-Aggregate rules in a generic Domain Service

Rejected because a generic service would become an unbounded coordinator with repository and transaction dependencies. Domain Policies remain context-owned and deterministic; orchestration remains in Application Services.

### Let Application Services own all validation

Rejected because alternate entry points, Workers, and future interfaces could bypass lifecycle decisions, producing an anemic domain model.

### Rely on database constraints as the domain model

Rejected because constraints cannot express Human judgment or rich lifecycle semantics, and database errors alone do not provide stable domain behavior.

### Duplicate every rule in every layer

Rejected because duplicated semantic ownership drifts. Defense in depth is required only where each layer has a distinct role: permission, domain validity, structural integrity, or delivery safety.

## Consequences

Positive consequences:

- Aggregate boundaries remain small and testable;
- Application Services can enforce legitimate cross-context preconditions without being mislabeled as domain violations;
- authorization does not leak into domain repositories;
- PostgreSQL closes concurrency and tenant-isolation races;
- Workers own temporal process behavior without acquiring Human authority; and
- errors, tests, and documentation map to a clear owner.

Costs and constraints:

- designers must classify rules rather than using one universal slogan;
- some critical guarantees intentionally use complementary checks across layers;
- Domain Policies require careful ownership and must not become service locators; and
- review must reject both fat Application Services and infrastructure-dependent Aggregates.

## Required verification before implementation approval

Before a use case is approved for implementation, verify that:

- every lifecycle rule has one owning Aggregate;
- every external precondition has an owning Application Service or Authorization Policy;
- every cross-Aggregate uniqueness rule has a race-safe persistence or coordination mechanism;
- no Aggregate loads another Aggregate or calls a repository;
- no Application Service writes Aggregate-owned fields directly;
- no database trigger originates Human-authoritative domain behavior;
- no Worker bypasses the owning module's command interface;
- same-Organization checks fail closed without resource-existence leakage; and
- tests exist at the layer that owns each rule.

## Related documents

- [Architecture Overview](../architecture/overview.md)
- [Context Map](../architecture/context-map.md)
- [Application Services](../architecture/application-services.md)
- [Authorization](../architecture/authorization.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [ADR-0006](0006-use-postgresql-transactional-outbox.md)
- [ADR-0007](0007-coordinate-work-and-blocking-decisions.md)
- [ADR-0008](0008-define-work-to-memory-generation-process.md)
