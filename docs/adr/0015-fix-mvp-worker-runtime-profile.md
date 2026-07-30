# ADR-0015: Fix the MVP Worker Runtime Profile

> **Status:** Accepted  
> **Date:** 2026-07-30  
> **Blueprint version:** 0.2.1

## Context

ADR-0006 defines durable local handoff and at-least-once processing, while the Events, Application Services, Persistence, and Operations documents define correctness requirements. Implementation still needs one deployable baseline for polling, claims, leases, retry budgets, shutdown, concurrency, and alert thresholds.

Leaving every value to individual handlers creates incompatible recovery behavior, retry storms, lease races, noisy-neighbor risk, and dashboards that cannot distinguish delay from failure.

## Decision

### One versioned runtime profile

The baseline profile is defined in [MVP Worker Runtime Profile](../architecture/worker-runtime-profile.md). Configuration may override operational capacity values by environment, but every override is versioned, bounded, validated at startup, and observable. A handler cannot silently invent its own retry or ordering policy.

Correctness fields in ConsumerRegistration are version-controlled deployment configuration:

- contract and schema versions;
- handler version;
- side-effect class;
- ordering requirement and key strategy;
- failure-continuation and skip policy;
- retry policy reference;
- processing timeout and lease profile; and
- required System capability.

Changing these fields requires compatibility review. Capacity tuning does not change historical materialized delivery ownership.

### Worker separation

The MVP runs logically separate Worker roles:

- Outbox Publisher;
- PostgreSQL-local Consumer Worker;
- Memory Generation Worker;
- Lease Recovery and Reconciliation Worker; and
- authorized Replay Worker.

They may share one deployable initially, but use separate loops, concurrency pools, readiness, metrics, and database grants. A slow AI call cannot consume the local transaction-consumer pool.

### Polling and wake-up

PostgreSQL polling is authoritative. `LISTEN/NOTIFY` may reduce idle latency but is only a wake-up hint; notification loss never loses work. Every loop performs periodic polling and bounded batches using database time and `FOR UPDATE SKIP LOCKED` where specified.

### Claims and leases

Claims are committed before work begins and contain owner, expiration, and monotonically increasing fencing version. Renewal and outcome transitions compare the complete claim identity. Finalization requires an unexpired lease using `transaction_timestamp()`.

Lease recovery increments the fencing version before making work eligible again. Recovery does not count as an attempt. A stale Worker never releases, retries, fails, or completes a newer claim.

### Retry calculation

Retry uses capped exponential backoff with deterministic full jitter:

```text
cap = min(maximumDelay, baseDelay * 2^(attemptCount - 1))
delay = deterministicUniform(0, cap, operationIdentity + attemptCount + policyVersion)
nextAttemptAt = databaseNow + delay
```

The deterministic seed makes a committed schedule reproducible while distributing different operations. The stored `nextAttemptAt` is authoritative; Workers do not recalculate it while polling.

Security, contract, and deterministic domain failures do not retry automatically. Configuration failures remain failed until corrected and explicitly replayed. Unknown failures use a smaller bounded budget than known transient failures.

### Backpressure and fairness

Workers stop claiming when their execution pool or database-pool allowance is exhausted. They do not claim large batches into process memory. Organization-scoped concurrency limits prevent one tenant from occupying the entire pool, while oldest-eligible ordering prevents indefinite starvation.

No per-Organization identifier is exported as a metric label. Tenant-specific saturation remains available through authorized PostgreSQL operational queries.

### Shutdown

On termination, a Worker stops claiming immediately, continues heartbeats only for work it can finish within the shutdown budget, commits completed outcomes, and otherwise lets the lease expire. It never marks unfinished work successful and never clears a claim without a fenced transition.

### Replay boundary

Automatic retry reuses the existing processed-event or generation-operation identity. Human-authorized replay is a separate audited operation and may target only one failed consumer delivery in the MVP. `Processed` and `Skipped` deliveries are never reset.

### Operational gate

Production readiness requires dashboards and alerts for backlog age, claim expiry, retry age, terminal failure, ordering blocks, dead letters, Memory-generation stage latency, reconciliation findings, and replay outcomes. Queue length alone is insufficient.

## Alternatives considered

### Let every handler choose arbitrary values

Rejected because correctness and operational behavior would become invisible configuration distributed through business code.

### Use only `LISTEN/NOTIFY`

Rejected because notifications are not a durable queue and can be missed across disconnects or restarts.

### One generic Worker pool

Rejected because long-running external computation would starve short PostgreSQL-local coordination and obscure readiness.

### Immediate retry without jitter

Rejected because shared dependency recovery would cause synchronized retry storms.

### Generic broad replay

Rejected for the MVP because range replay needs batching, cancellation, rate limiting, blast-radius approval, and partial-failure semantics.

## Consequences

Positive consequences:

- repeatable Worker behavior and capacity planning;
- fenced recovery with no stale completion;
- bounded retry storms and tenant contention;
- independently observable Worker roles; and
- a narrow, auditable replay surface.

Costs and constraints:

- runtime configuration requires validation and versioning;
- more than one logical Worker pool must be operated;
- tenant fairness needs database-backed query discipline; and
- changing correctness-related registration fields needs review.

## Related documents

- [ADR-0004](0004-separate-external-computation-and-business-effects.md)
- [ADR-0006](0006-use-postgresql-transactional-outbox.md)
- [ADR-0008](0008-define-work-to-memory-generation-process.md)
- [ADR-0014](0014-establish-mvp-database-migration-baseline.md)
- [Worker Runtime Profile](../architecture/worker-runtime-profile.md)
- [Events and Outbox](../architecture/events-and-outbox.md)
- [Application Services](../architecture/application-services.md)
- [Operations](../../observability-and-operations.md)
