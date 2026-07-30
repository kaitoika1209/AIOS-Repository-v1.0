# MVP Worker Runtime Profile

> **Document status:** Normative  
> **Blueprint version:** 0.2.1  
> **Applies to:** PostgreSQL Outbox, local consumers, Memory generation, recovery, and replay

## Purpose

This document supplies the initial deployable values for the correctness model in ADR-0006 and ADR-0015. Values are starting limits, not capacity promises. Environment overrides must remain inside documented bounds and must not weaken fencing, authority, tenant isolation, ordering, or idempotency.

## Worker role matrix

| Role | Batch | Concurrency | Poll interval | Lease | Execution timeout |
|---|---:|---:|---:|---:|---:|
| Outbox Publisher | 50 | 4 | 250 ms idle, immediate while backlog exists | 30 s | 10 s per local handoff transaction |
| Local Consumer | 25 claims | 16 global, max 2 per Organization | 250 ms idle | 30 s | 10 s for PostgreSQL-local handler transaction |
| Memory Generation | 5 claims | 4 global, max 1 per Organization | 1 s idle | 180 s | 120 s provider call; 10 s final transaction |
| Lease Recovery | 100 | 1 leader per recovery type | 5 s | transaction only | 10 s transaction |
| Replay | 1 | 2 global, max 1 per Organization | 1 s idle | owning handler profile | owning handler profile |

`LISTEN/NOTIFY` may wake a loop early. The periodic poll remains mandatory.

Startup validation rejects zero/negative values, lease shorter than execution timeout plus safety margin, unbounded concurrency, Organization limit above global concurrency, and a database-pool allocation that leaves no capacity for HTTP or recovery traffic.

## Database pool budget

Worker concurrency is bounded by a dedicated Worker-pool allowance. The initial production rule is:

```text
HTTP reserved connections >= 40% of application pool
Worker connections <= 40%
Operations and recovery reserve >= 20%
```

A Worker stops claiming before it exhausts its allowance. Waiting in the process for a connection while holding a claim is prohibited beyond the configured short acquisition timeout.

## Outbox publication protocol

Claim transaction:

```sql
WITH candidates AS (
    SELECT outbox_id
    FROM outbox_messages
    WHERE status = 'Pending'
      AND next_attempt_at <= transaction_timestamp()
    ORDER BY recorded_at, outbox_id
    FOR UPDATE SKIP LOCKED
    LIMIT :batch_size
)
UPDATE outbox_messages AS o
SET status = 'Claimed',
    attempt_count = o.attempt_count + 1,
    claim_version = o.claim_version + 1,
    locked_by = :worker_id,
    locked_until = transaction_timestamp() + :lease,
    updated_at = transaction_timestamp()
FROM candidates
WHERE o.outbox_id = candidates.outbox_id
RETURNING o.*;
```

The physical Outbox schema therefore includes `claim_version`, `locked_by`, `locked_until`, and `updated_at`. Publication finalization matches Outbox id, `Claimed`, Worker id, claim version, and unexpired lease.

For `local-consumer-bus`, one short final transaction resolves the registered consumer-set snapshot, inserts every target `Pending` processed-event row conflict-safely, verifies the target count, and sets Outbox `Published`. Zero consumers for a required contract is `Configuration`, never successful publication.

The Publisher does not invoke handlers. `target_count = 0` is valid only for a contract explicitly registered as optional with an empty compatible target set.

## Consumer claim protocol

Eligible selection includes `Pending`, due `RetryPending`, and explicitly unblocked `Blocked`. It excludes a later sequence when durable ordering state identifies an earlier non-terminal delivery for the same consumer and key.

One claim increments `attempt_count` and `claim_version` exactly once. The Worker invokes only the rows returned by the claim update. It does not separately select and later update eligibility.

The final transaction starts by locking and fencing the processed-event row. It then revalidates registration version, Organization, System capability, ordering state, current Aggregate version, and business idempotency before mutation.

## Retry profiles

| Profile | Maximum attempts | Maximum elapsed | Base delay | Maximum delay | Retryable categories |
|---|---:|---:|---:|---:|---|
| `outbox-local-v1` | 10 | 15 min | 500 ms | 30 s | transient infrastructure, transient concurrency, unknown for first 3 attempts |
| `postgres-local-v1` | 8 | 15 min | 500 ms | 30 s | transient infrastructure, transient concurrency, unknown for first 3 attempts |
| `projection-v1` | 8 | 10 min | 250 ms | 15 s | transient infrastructure, concurrency; projection gap follows rebuild policy |
| `memory-generation-v1` | 5 | 24 h | 30 s | 15 min | transient infrastructure, provider timeout, throttling, lease loss |

Every retry uses deterministic full jitter from ADR-0015 and stores `next_attempt_at` using database time. `Retry-After` may raise the delay but never exceed the profile's maximum elapsed deadline without moving the operation to `Failed`.

Retry budget exhaustion atomically creates or updates dead-letter/reconciliation evidence and applies ordering continuation. Attempt counts never reset during automatic retry or authorized replay.

## Failure decision table

| Category | Automatic action | Alert class | Ordering default |
|---|---|---|---|
| `TransientInfrastructure` | retry within profile | warning on age/budget burn | preserve key position |
| `TransientConcurrency` | reload and retry | no per-attempt alert | preserve key position |
| `TransientExternalDependency` | dependency profile retry | warning on sustained failure | preserve key position |
| `PermanentContract` | fail immediately | Major | block ordered key |
| `PermanentSecurity` | fail immediately, preserve evidence | Critical | block ordered key |
| `PermanentDomain` | fail and create reconciliation finding | Major | block ordered key |
| `Configuration` | fail until corrected and authorized replayed | Major | block ordered key |
| `Unknown` | at most 3 automatic attempts, then fail | Major | block ordered key |

Raw exception classes and provider messages are mapped to bounded codes before persistence or telemetry export. Payloads, secrets, tenant content, stack traces, and SQL parameters are not stored in `last_error_message`.

## Lease renewal and recovery

PostgreSQL-local handlers do not heartbeat; they must complete inside the 10-second transaction timeout and 30-second lease.

Memory generation heartbeats every 30 seconds only while the provider call is active. Renewal extends to 180 seconds from database time and compare-and-sets operation id, Organization, status, Worker, and claim version. Two consecutive renewal failures cancel local waiting when possible and discard any later result.

Recovery scans expired claims every 5 seconds. It compare-and-sets the complete expired claim, increments `claim_version`, preserves `attempt_count`, records `LeaseExpired`, and schedules retry with the owning profile. Recovery is idempotent and never performs business effects.

## Ordering and fairness

`None` permits parallel claims. `PerAggregateStream` and `PerBusinessKey` serialize only one consumer/key pair; there is no Organization-wide or platform-wide implicit order.

The default for Domain Coordination is `BlockOrderingKey`. A failed key cannot block other Organizations or independent keys. Claims use oldest eligible time, then stable identity. The max-per-Organization execution cap is enforced before claim or with durable capacity tokens; acquiring work and then waiting behind a tenant semaphore is prohibited.

`ContinueIndependent` requires a registered proof that later effects remain valid and a reconciliation path for the missing effect.

## Graceful shutdown

The default termination budget is 30 seconds.

1. Mark Worker readiness false and stop claiming.
2. Complete short local transactions already executing.
3. Continue a Memory-generation heartbeat only when completion is expected inside the remaining budget.
4. Stop heartbeat otherwise and let fenced recovery reclaim after expiry.
5. Flush only bounded telemetry; telemetry failure never changes durable outcome.

The Worker never clears another owner's claim or converts cancellation directly to success.

## Dead letter and replay

A consumer `Failed` transition and its dead-letter state commit together. Outbox `Failed` remains publication failure and is not a consumer dead letter.

The MVP replay scope is exactly one `(organizationId, consumerName, eventId)` failed delivery. Request, validation, execution claim, outcome, dead-letter transition, ordering decision, and Human authority remain durable and auditable.

`ValidateOnly` has no business effect. `RetryOriginal` and `ReprocessWithCurrentHandler` require compatible contract, handler, current authorization, ordering impact, and idempotency. Replay cannot target `Processed` or `Skipped`, change event payload, fabricate Human intent, or broaden to a range.

## Required metrics and alerts

Metric labels use only registered bounded values: Worker role, consumer name, event type, status, failure category, policy version, and configured provider. Organization, event, Aggregate, operation, ordering key, Worker id, and claim version are never metric labels.

| Signal | Warning | Critical |
|---|---:|---:|
| oldest publishable Outbox age | > 60 s for 5 min | > 120 s |
| oldest local consumer Pending age | > 60 s for 5 min | > 5 min |
| expired claims | >= 3 in 15 min per Worker role | sustained increase for 15 min |
| RetryPending oldest age | > profile maximum delay × 2 | > profile maximum elapsed |
| open dead letters | any new item | any security failure or ordered key > 15 min |
| blocked ordering key age | > 5 min | > 30 min |
| Memory without draft | > 5 min | > 15 min |
| reconciliation finding | any Major | any Critical or unresolved > 24 h |

Required dashboards pair count with oldest age and rate. A zero time series with missing collection is `Unknown`, not healthy.

The initial SLOs remain:

- 99.9% of Outbox records handed off within 30 seconds over 30 days at sufficient volume;
- 99.0% of completed Work producing a reviewable Memory within 5 minutes over 30 days at sufficient volume; and
- 99.0% logical Worker terminal success over 30 days at sufficient volume.

SLI accounting is operation-based:

- Outbox latency starts at `recorded_at` and ends at the first committed `published_at`; every durable destination record contributes once, and a terminal publication failure is unsuccessful.
- Work-to-Memory latency starts at the committed Work completion timestamp and ends at the first committed matching Memory; retries do not add observations, and `Failed` or `Abandoned` without Memory is unsuccessful.
- Worker terminal success uses one logical `(consumerName, eventId)` observation. `Processed`, including a proved no-op, is successful. `Failed` and `Skipped` are unsuccessful. Pending, Processing, RetryPending, and Blocked remain non-terminal and are represented by age signals rather than prematurely entering the ratio.
- Operator-approved maintenance exclusions require a durable deployment or incident reference and never exclude security, tenant-isolation, Human-authority, or data-integrity violations.

An observation is attributed to the contract and policy version captured when its durable record was created. A configuration deployment cannot retroactively move historical failures to a more favorable policy.

Security, tenant isolation, Human authority, immutable approval, and one-Memory-per-Work invariants have no error budget.

## Required tests

- crash before and after claim commit;
- crash before and after local handoff commit;
- duplicate publisher and consumer execution;
- lease expiry racing renewal and finalization;
- stale Worker attempt after a newer claim;
- retry schedule determinism and jitter distribution;
- retry budget and elapsed deadline;
- permanent/security/configuration failure without retry storm;
- ordered-key block with unrelated-key progress;
- per-Organization concurrency fairness;
- shutdown during local transaction and provider call;
- replay authorization revocation and concurrent replay;
- restoration followed by claim, ordering, and idempotency reconciliation; and
- metrics missing-data behavior and prohibited-label checks.

## Related documents

- [ADR-0015](../adr/0015-fix-mvp-worker-runtime-profile.md)
- [ADR-0006](../adr/0006-use-postgresql-transactional-outbox.md)
- [Events and Outbox](events-and-outbox.md)
- [Application Services](application-services.md)
- [Persistence](persistence-and-data-model.md)
- [Operations](../../observability-and-operations.md)
