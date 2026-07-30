# ADR-0013: Govern Coordinated Aggregate Transactions

> **Status:** Accepted  
> **Date:** 2026-07-30  
> **Blueprint version:** 0.2.1

## Context

AIOS normally changes one Aggregate per command and coordinates cross-Aggregate consequences through committed Integration Events. A small number of MVP use cases establish invariants that must be visible atomically while the participating Aggregates are co-located in one implementation module and one authoritative PostgreSQL database.

Allowing an Application Service to inject several Repositories without a closed exception registry would turn the Modular Monolith into a shared-database service locator. Conversely, forcing every local invariant through eventual consistency would introduce orphaned bootstrap state, dangling blocking-Decision references, invitation-consumption races, or temporary zero-Owner Organizations without product value.

This decision defines the complete MVP exception registry, transaction ownership, lock order, retry rules, and extraction constraints. It does not merge Aggregate boundaries or authorize distributed transactions.

## Decision

### Default rule

One state-changing command normally mutates one Aggregate Root. Cross-Aggregate consequences occur through a target module Application interface or a committed, versioned Integration Event.

Only an Application Service named in the registry below may coordinate more than one Aggregate mutation. A generic Unit of Work MUST NOT expose every Repository, and an approved coordinator MUST receive only its registered Repository and narrow Platform Runtime ports.

### MVP exception registry

| Coordinator | Atomic invariant | Mutated Aggregates | Read or locked preconditions | Required technical records |
|---|---|---|---|---|
| `CreateOrganizationService` | An Active Organization is never visible without its creator's active Owner Membership and Owner assignment. | Organization; creator Membership | Active creator Human Identity | Domain and Integration Events, processed command, required authorization audit |
| `AcceptInvitationService` when identity creation is required | Token consumption, Human Identity creation or authentication-subject linkage, and Membership activation become visible together. | Human Identity when created or linked; invited Membership | Organization state; invitation and recipient evidence | Domain and Integration Events, consumed invitation, processed command, required audit |
| `TransferOrganizationOwnershipService` | The committed result retains at least one active Human Owner and applies target assignment and optional source revocation atomically. | Source and target Memberships and their owned role assignments | Organization and active Human Identity facts | Ownership-transfer events, processed command, required authorization audit |
| `RequestBlockingDecisionService` | Work's Pending gate and one immutable submitted blocking Decision revision become visible together with identical reference fields. | Work; Decision | Current Human Membership and authorization | Work and Decision events, mapped Integration Events, processed command, required authorization audit |

No other MVP use case may mutate multiple Aggregate Roots in one transaction. Adding an exception requires an accepted ADR that updates this registry and documents why a single-Aggregate command plus durable event is insufficient.

Transactional Outbox, processed-command, invitation-consumption, and required audit rows are technical participants, not additional business Aggregates. Their inclusion does not grant Platform Runtime authority over domain transitions.

### Transaction protocol

Every registered coordinator follows this protocol:

```text
Resolve one immutable command identity and Organization scope
Check or create the processed-command claim
Authenticate and authorize from current facts
Acquire the registered locks in canonical order
Reload and recheck all authoritative preconditions
Load Aggregate Roots with expected versions
Execute commands through each Aggregate Root
Persist each mutated Root through its owning Repository
Append every required Domain and Integration Event to Outbox
Persist processed-command result and required audit
Commit once or roll back everything
```

No external provider call, message publication, email delivery, Identity Provider mutation, notification, telemetry export, or unbounded query may occur while the transaction is open.

### Canonical lock order

Locks are acquired only when a database uniqueness constraint and optimistic version checks cannot protect the invariant by themselves. A coordinator MUST NOT invent a different order at runtime.

| Coordinator | Canonical lock order |
|---|---|
| `CreateOrganizationService` | command identity; creator Human Identity row; new Organization and Membership identifiers require no existing-row lock |
| `AcceptInvitationService` | command identity; hashed invitation-identity advisory lock; invitation row; Organization row; existing Human Identity or authentication-subject mapping when present; invited Membership row |
| `TransferOrganizationOwnershipService` | command identity; Organization-owner advisory transaction lock; Organization row; source and target Membership rows sorted by `membershipId`; corresponding active Owner role rows in the same Membership order |
| `RequestBlockingDecisionService` | command identity; Work row; existing Decision row when reused; submitted revision child rows are locked through their Root and inserted after Root validation |

The same logical invariant uses the same advisory-lock namespace in every command that can affect it. In particular, assigning, revoking, suspending, leaving, disabling, transferring, or archiving in a way that affects active Ownership uses the Organization-owner lock.

All lock acquisition and SQL statements use bounded `lock_timeout` and `statement_timeout`. A transaction never waits for user interaction or an external system.

### Concurrency and retry

Optimistic versions remain mandatory even when a coordinator uses row or advisory locks. Locks serialize a narrow shared invariant; they do not turn stale client intent into current intent.

The Application Layer may automatically retry a serialization failure or deadlock only when all of the following are true:

- the same `commandId` and byte-equivalent command intent are reused;
- no external side effect occurred;
- the prior transaction is known not to have committed, or the processed-command result is checked first;
- authentication, authorization, Aggregate state, and all preconditions are reloaded;
- the retry count and total elapsed time are bounded; and
- the command's registered policy permits automatic retry.

An optimistic version conflict for Human approval, completion, ownership transfer, invitation acceptance with changed recipient facts, or blocking-Decision activation is not silently retried as a new mutation. The service returns `ConcurrencyConflict` or the already committed idempotent result. The Human reloads current state when intent could have changed.

After an ambiguous client or connection failure, the caller checks the processed-command result using the same command identity before attempting execution again. Absence of an HTTP response is never evidence that the transaction rolled back.

Stable failure outcomes are:

```text
ConcurrencyConflict
ResourceBusy
TransactionTimeout
InvariantConflict
PersistenceUnavailable
```

External responses remain tenant-safe and do not reveal whether a conflicting identifier belongs to another Organization.

### Failure semantics

- Validation, authorization, constraint, persistence, Outbox, processed-command, or required-audit failure rolls back every participant.
- Publication failure after commit does not roll back domain state; the durable Outbox record remains retryable.
- A coordinator never compensates for a transaction that PostgreSQL rolled back atomically.
- Repeated deadlocks, timeouts, invariant conflicts, or ambiguous commit outcomes emit bounded operational evidence and become actionable after the registered threshold.
- Reconciliation may invoke the same typed Application command or create a finding. It MUST NOT repair Aggregate tables directly.

### Boundary and extraction rules

The registry is an implementation-local optimization backed by one PostgreSQL authority. Aggregate models, repositories, and events remain independently owned and testable. One Aggregate never invokes another Aggregate or Repository.

A future module or service extraction that breaks a registered local transaction requires a superseding ADR defining:

- durable orchestration ownership;
- externally visible pending states;
- idempotency and ordering;
- compensation or abandonment semantics;
- equivalent tenant and invariant protection; and
- migration from existing atomic behavior without dual authority.

Two-phase commit across services is not the default replacement.

## Alternatives considered

### Permit any same-database transaction

Rejected because physical co-location is not semantic ownership. It would create hidden coupling and make later extraction unpredictable.

### Require eventual consistency for every Aggregate interaction

Rejected because the four registered workflows establish small local invariants for which temporary partial state has no useful business meaning and would require unnecessary compensation.

### Merge the participating Aggregates

Rejected because their lifecycle, concurrency, authorization, and future extraction boundaries remain independent outside the narrow coordinated command.

### Use database triggers as transaction coordinators

Rejected because triggers cannot own Human authorization or invoke Aggregate behavior and would hide business orchestration below the Application Layer.

## Consequences

Positive consequences:

- exceptional atomic workflows are explicit and reviewable;
- lock order and retry behavior are deterministic;
- Repository access does not expand into a service locator;
- Human intent is not silently reinterpreted after concurrency; and
- later service extraction has a documented compatibility boundary.

Costs and constraints:

- each exception requires integration, concurrency, deadlock, and rollback tests;
- coordinators require narrow transaction-context plumbing; and
- changing module placement may require replacing an atomic guarantee with a visible durable process.

## Required verification before implementation approval

Tests must prove:

- failure at every persistence step leaves no partial Aggregate, Outbox, idempotency, invitation, or audit state;
- concurrent Organization creation cannot expose an ownerless Active Organization;
- concurrent invitation acceptance consumes one token, creates at most one identity mapping, and activates one Membership;
- every Ownership-affecting command uses the same advisory-lock namespace and preserves one active Owner;
- concurrent blocking-Decision requests produce one matching Work gate and submitted revision;
- reversed or ad hoc lock acquisition is rejected by architecture tests or transaction helpers;
- ambiguous commit retry returns the stored processed-command result;
- stale Human intent produces `ConcurrencyConflict` rather than silent automatic mutation; and
- Outbox publication failure after commit remains recoverable without reversing domain state.

## Related documents

- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [ADR-0006](0006-use-postgresql-transactional-outbox.md)
- [ADR-0007](0007-coordinate-work-and-blocking-decisions.md)
- [ADR-0009](0009-assign-rule-enforcement-responsibilities.md)
- [Application Services](../architecture/application-services.md)
- [Identity and Organization](../architecture/identity-and-organization.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
