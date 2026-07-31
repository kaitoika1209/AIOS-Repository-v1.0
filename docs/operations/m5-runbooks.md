# M5 Operational Runbooks

> **Status:** Implementation baseline · **Profile:** `mvp-worker-v1`

These procedures operate on PostgreSQL-authoritative state. Missing telemetry is `Unknown`, never healthy. Every production execution requires a named Human incident owner, a change or incident identifier, and preserved evidence. Commands shown as queries are diagnostic unless a procedure explicitly identifies an authorized mutation.

## Readiness and ownership gate

Production deployment is blocked until the release record contains verified SNS destinations and named primary and secondary Human responders. A successful test notification, acknowledgement time, CloudWatch alarm ARN, SNS topic ARN, profile version, schema fingerprint, and evidence timestamp must be attached to the release. Placeholder addresses, unacknowledged messages, or evidence older than 30 days fail the gate.

Worker readiness is independent by role. A role is unready when configuration validation fails, its PostgreSQL acquisition budget is exhausted, its required registration is incompatible, or shutdown has begun. Telemetry exporter failure degrades observability but cannot reverse a committed business outcome.

## Backlog and noisy-neighbor recovery

1. Declare the incident owner and record `mvp-worker-v1`, deployment fingerprint, schema fingerprint, and database connection utilization.
2. Compare count and oldest age for Outbox, Worker deliveries, Memory operations, dead letters, and blocked ordering keys. A count without age is insufficient.
3. Confirm HTTP has at least 40%, Workers use at most 40%, and Operations/recovery retain at least 20% of the application pool.
4. Confirm claims are oldest-eligible and limited per Organization. Never export `organization_id` as a metric dimension; use the authorized query below.
5. Stop increasing concurrency if database wait time, HTTP reserve, or recovery reserve approaches its limit. Prefer draining with the existing deterministic retry schedule.
6. Resolve permanent failures through reconciliation or one-delivery replay. Do not reset attempt counts or bulk-replay.

```sql
SELECT organization_id,status,count(*) AS delivery_count,min(first_eligible_at) AS oldest
FROM worker_deliveries
WHERE status NOT IN ('Processed','Failed','Skipped')
GROUP BY organization_id,status
ORDER BY oldest;
```

## Expired claims and stale Workers

Recovery runs every five seconds and updates only a complete expired claim tuple. It increments `claim_version`, preserves `attempt_count`, records bounded code `LeaseExpired`, clears the owner, and schedules the owning retry policy. A stale Worker result must match Organization, record identity, `Processing`/`Generating`, `locked_by`, `claim_version`, and an unexpired database-time lease; otherwise discard it without business effects.

Two consecutive Memory heartbeat failures cancel local waiting when possible. Never clear a newer owner's claim or accept a provider result after lease loss.

## Poison events and dead letters

`PermanentContract`, `PermanentSecurity`, `PermanentDomain`, and `Configuration` do not retry automatically. Commit the failed delivery, dead letter, ordering decision, bounded error code, and reconciliation finding atomically. Payloads, SQL parameters, secrets, stack traces, and tenant content are prohibited in the persisted error and metric dimensions.

Security failures page the verified security responder immediately. An ordered key blocked for 15 minutes is Critical. Other Organizations and independent ordering keys must continue.

## Provider outage

Memory generation uses `memory-generation-v1`: five attempts, 30-second base delay, 15-minute cap, 24-hour elapsed limit, deterministic full jitter. The provider call occurs outside PostgreSQL transactions. Do not rebuild source input, change policy versions, or create another operation. When the provider recovers, existing `RetryPending` operations resume from stored `next_attempt_at`.

If a provider credential is suspected compromised, disable claiming, rotate the secret reference, verify least privilege, deploy, and use individually authorized replay only after the incident owner confirms the new configuration. Never put credentials in replay reasons or logs.

## Single-delivery replay

Replay targets exactly `(organization_id, consumer_name, event_id)` in `Failed`. The Human request requires active membership, permission, reason, idempotency key, and mode. `ValidateOnly` has no business effect. `RetryOriginal` and `ReprocessWithCurrentHandler` must revalidate contract compatibility, ordering impact, current authorization, and business idempotency. `Processed` and `Skipped` are never reset.

## Graceful shutdown

Mark role readiness false and stop claiming immediately. Complete short local transactions. Continue a Memory heartbeat only if completion is expected within the remaining 30-second termination budget; otherwise stop heartbeat and let the lease expire. Flush bounded telemetry only. Never mark unfinished work successful.

## Backup, PITR, and isolated restore

1. Record backup identifier, target recovery time, release artifact fingerprint, and schema fingerprint.
2. Restore to an isolated account/network with production egress disabled and access limited to the recovery team.
3. Measure RPO from the latest authoritative committed transaction and RTO from declaration to verified availability.
4. Apply integrity checks: foreign keys, duplicate Work/Memory checks, approved Memory immutability, tenant-scoped references, Human authority records, outbox/delivery fencing, and source-snapshot hashes.
5. Run reconciliation for expired claims, terminal deliveries without outcomes, generated operations without Memory, completed Work without Memory, open deletion requests, and blocked ordering keys.
6. Replay governed deletion/anonymization work that committed after the restored recovery point before any service exposure.
7. Persist `RestoreTest` and `PostRestoreReconciliation` rows in `recovery_evidence`. A failed or unmeasured restore blocks production approval.

## Data retention and Organization deletion

Approved Memory immutability blocks ordinary edits; it does not override a legally authorized deletion. The governed workflow requires separate authorization, exact Organization scope, reason, idempotency, legal-hold check, audit, backup-expiry tracking, downstream purge/reindex tasks, and reconciliation. Delete or irreversibly anonymize Memory, snapshots, generation inputs, derived indexes, and pending work as one Organization-scoped process. No record may become ownerless or move across tenants.

After PITR, replay all deletion commands newer than the recovery point before reopening access. Record `DeletionReplay` evidence and reconcile every target.

## Required dashboards and alarms

Dashboards pair count, oldest age, rate, and collection-health for Outbox publication, local delivery, retry, expired claims, dead letters, ordering blocks, Memory generation stages, completed Work without Memory, reconciliation, replay, backup, and restore evidence. Metric dimensions are limited to Worker role, consumer name, event type, status, failure category, policy version, and configured provider.

Alerts use the normative thresholds in `docs/architecture/worker-runtime-profile.md`. Alarm delivery failure or missing collection opens an operational finding; it is not interpreted as zero. Monthly review records ingestion volume, active time-series count, alarm ownership, query cost, and acknowledgement tests.

## Verification cadence

- Every deployment: configuration validation, schema fingerprint, Worker readiness, and synthetic alert routing.
- Weekly: dead letters, ordering blocks, missing Memories, retry age, and deletion backlog.
- Monthly: restore exercise evidence, cardinality/cost review, responder acknowledgement, and SLO sufficient-volume assessment.
- After incidents or restores: idempotency, fencing, tenant isolation, Human authority, immutable approval, deletion replay, and reconciliation evidence.
