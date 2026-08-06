# Runbooks

## Purpose

The MVP Production Baseline requires six executable runbooks, and the architecture says what
each must contain:

> detection signals, safe containment, prohibited actions, recovery steps, validation,
> required authorization, and audit evidence

Runbooks 1 to 5 are here. Runbook 6 — PostgreSQL backup or WAL failure and point-in-time
recovery — is in [`backup-and-recovery.md`](backup-and-recovery.md), beside the drill that
rehearses it. Runbooks 7 and 8, Worker containment, are in
[`worker-containment.md`](worker-containment.md); they are not part of the required six but
runbooks 2 and 3 reach for them, so they are written and executable.

---

## What is not yet true

These runbooks name detection signals that **exist today**, and they say so where a signal
does not.

The metrics of baseline items 5 and 6 now exist, and item 2's exporter carries them — but
**item 11 is still absent and that is what decides how detection works today.** There is no
metric backend to evaluate an alarm and no SNS topic to deliver one, so nothing here pages
anyone. A metric that nobody is watching is not a detection signal.

Until an alarm exists, detection means an operator looking, using:

| Surface | What it answers |
|---|---|
| `GET /health/live`, `/health/ready` on `:3011` (API) and `:3012` (Worker) | Is the process alive, and can it work? |
| `GET /admin/workflow-health` | Is this Organization's committed work progressing, and is the answer current? |
| `GET /admin/diagnostics` | Why not — Outbox, deliveries, dead letters, generation, pauses, schema, correlated |
| Structured JSON logs on stdout | Everything else, correlated by `correlationId` |
| `authorization_audit_records` | Who did what, including denials |

Where a step below names a metric that does not exist yet, it says so and gives the query or
endpoint that answers the same question now. A runbook that cited a metric nobody emits
would read as complete and fail on the day.

**Read `freshness.ageSeconds` before concluding anything from a health read.** The projection
reconciles on a schedule, so a fresh answer can still be up to one interval behind — during
runbook 3's execution the health report said `Healthy` for a workflow that was already
`Blocked`, because the answer was twenty-eight seconds old. `stale: false` means the answer
is trustworthy, not that it is instantaneous. When a state has just changed, wait a reconcile
interval before believing a health read that disagrees with `GET /admin/diagnostics`, which
reads the source tables directly.

## How they were exercised

**All five have now been executed**, against a live local environment rather than a staging
one, by inducing each failure for real: PostgreSQL stopped under a running API, the database
made read-only, a migration withheld, the Worker stopped with committed work waiting, a
poison event dead-lettered with its ordering key blocked, and a recovery driven through to a
resolved dead letter and an unblocked key.

It was worth doing: **executing them found three defects**, which is what a runbook is for.

| Found by | Defect |
|---|---|
| Runbook 1 | An authoritative command during a database outage returned `500 INTERNAL_ERROR`. A client will not retry that, and an operator reading logs sees `http.unhandled_error` rather than an outage. Now `503` with `Retry-After`. |
| Runbook 1 | A read-only database can refuse the very command that reverses it — `ALTER DATABASE ... RESET` fails inside a read-only transaction. The escape is recorded in the runbook. |
| Runbook 2 | A reprocess re-queued the delivery and the drain re-attempted it, but nothing closed the loop: the replay stayed `Running` for ever and the dead letter stayed `ReadyForReplay` whether the retry succeeded or failed. |

Runbooks 6, 7, and 8 are exercised mechanically — 6 by `scripts/restore_drill.sh`, 7 and 8
by the test suite on every build.

### And again, with more than one of everything

That first pass had no load balancer, no replica, and one of each process, so every step
depending on plurality was reasoning rather than evidence. `scripts/staging.sh` removes that
assumption — two API replicas behind a readiness-routing ingress, two Workers, and a real
streaming standby — and runbooks 1, 3, 5 and 8 were executed against it on 2026-08-06.
[`staging-rehearsal.md`](staging-rehearsal.md) records the whole exercise; the part that
belongs here is what it found and what it confirmed.

| Found by | Defect |
|---|---|
| Runbook 3 | **A working Worker was indistinguishable from a stopped one.** The drain logged only when `applied`, `failed`, or `notified` was non-zero, so two Workers publishing 120 messages left no record of any of them — every event reached the `notifications` consumer, which correctly produced nothing because a Member who assigns Work to themselves is not notified about it. That is this runbook's premise arriving through the evidence used to disprove it. Now gated on `claimed`, with a regression test. |
| Runbook 1 | **`pg_ctl promote` produces split brain in one command.** Both clusters reported `pg_is_in_recovery() = false` immediately afterwards. The runbook said "resolve the failover" and said nothing about fencing; it now carries fencing as a prohibited action and the check that catches it. |

Confirmed rather than found — each previously an assertion in a comment:

- a real promotion returns readiness to `Ready` within one probe interval, on the **same
  process and the same pool**, with no restart;
- two Workers divide a queue (61 and 59 of 120) rather than duplicating it, with 120
  deliveries over 120 distinct events;
- code deployed ahead of its migration takes the **whole fleet** out of rotation with
  `MIGRATIONS_PENDING` rather than serving errors, and `GET /admin/diagnostics` reports the
  ledger head that reveals it;
- a paused Worker claims nothing while its sibling carries the queue;
- readiness gates the **ingress**, not the process: a write sent directly to an `Unready`
  replica still succeeds.

---

## Ownership

The architecture asks every runbook to carry `owner`, `reviewDate`, `lastTestedAt`,
`applicableVersion`, and `severity`. They apply to all five:

| Field | Value |
|---|---|
| `owner` | Platform Operations |
| `reviewDate` | On the first production incident, or at the next baseline review |
| `lastTestedAt` | 2026-08-06, runbooks 1, 3, 5 and 8 against a **staging-shaped** environment — two API replicas behind a readiness-routing ingress, two Workers, and a real streaming standby promoted with `pg_ctl` ([`staging-rehearsal.md`](staging-rehearsal.md)). 2026-08-05 for runbooks 1–5 against a single live local process |
| `applicableVersion` | Blueprint 0.2.0; schema at migration `0003_organization_workflow_health` |
| `severity` | Stated per runbook |

---

## Runbook 1: Application or database unavailable

**Severity: Critical.** Authoritative writes are unavailable or unsafe.

### Detection signals

- `GET /health/ready` on the API returns `503`. The `reasonCode` names which check failed:
  `DATABASE_UNAVAILABLE`, `DATABASE_READ_ONLY`, `MIGRATIONS_PENDING`, or `PROBE_TIMEOUT`.
- `GET /health/live` returns `200` while readiness returns `503` — the ordinary shape of a
  dependency outage, and the reason liveness deliberately checks nothing a restart cannot
  repair. Both red means the process itself is gone.
- `http.unhandled_error` or `service.start_failed` in the logs.
- `DATABASE_READ_ONLY` specifically means the process reached a replica or a cluster in
  recovery. Reads work; every authoritative write will fail.

*Available but not yet alerting:* `http_server_requests_total{outcome_class="5xx"}` rises
during this, and `METRICS_SINK` has to be configured for anything to receive it. The alarm
that would page someone is baseline item 11, which is absent.

### Safe containment

The architecture's constraints, and none of them is optional:

- do not accept authoritative writes;
- do not bypass durable audit;
- do not use an in-memory fallback as authority;
- do not continue state-changing Workers.

The first three are already structural — the readiness check fails before the load balancer
routes to a process that cannot write, and there is no fallback path to bypass. The fourth
is the operator's:

```bash
# Stop the Worker from claiming while the database is unsafe (runbook 8).
WORKER_PAUSED_TYPES=OutboxPublication  # then restart the Worker
```

Stopping the Worker process outright works too and is faster; the pause exists so that
readiness reports `ADMINISTRATIVELY_PAUSED` rather than the process simply being absent.

### Prohibited actions

- Restarting the API to "clear" a database outage. Liveness is green because a restart
  cannot help; restarting every replica at once turns a thirty-second blip into an outage.
- Applying migrations to resolve `MIGRATIONS_PENDING` without checking which version the
  other replicas are on. Mixed incompatible versions is runbook 5's failure.
- Pointing the application at a replica to restore reads. It will accept the connection and
  fail every write, and `DATABASE_READ_ONLY` is the readiness check that already refuses
  this on the application's behalf.
- **Promoting a standby without fencing the old primary.** `pg_ctl promote` returns
  success in under a second and leaves *both* clusters reporting
  `pg_is_in_recovery() = false` — two writable primaries, from one command. Rehearsed, and
  it happened on the first attempt. Stop or isolate the old primary before or immediately
  after promoting, and confirm:

  ```sql
  -- Must be exactly one 'f'. Two means every write is landing in one of two
  -- databases that will never reconcile.
  SELECT pg_is_in_recovery();   -- on each cluster
  ```

  On a managed provider the failover does this for you; on anything you promote by hand it
  is yours.
- Editing rows to unstick a workflow. Every durable transition has a typed command.

### Recovery steps

1. **Establish which layer is down.** `curl -s localhost:3011/health/ready` on one instance,
   directly, bypassing the load balancer. A `200` here with a failing service means the
   ingress, not the application.
2. **If `DATABASE_UNAVAILABLE`:** confirm the database and its failover status directly.
   `psql "$DATABASE_URL" -c 'select 1'` from the application's network position, because the
   answer from elsewhere is a different question.
3. **If `MIGRATIONS_PENDING`:** `pnpm --filter @aios/api migrate -- --status` names what is
   unapplied. Apply it only when every replica can run the new schema — see runbook 5.
4. **If `DATABASE_READ_ONLY`:** the process is talking to a replica or a cluster still in
   recovery. Resolve the failover; do not work around it.

   One trap, found by executing this runbook: if the cause is a database-level
   `default_transaction_read_only`, the command that reverses it is itself refused —
   `ALTER DATABASE` cannot run in a read-only transaction, and a session-level `SET` in the
   same implicit transaction does not help. The escape is an explicitly read-write
   transaction:

   ```sql
   START TRANSACTION READ WRITE;
   ALTER DATABASE aios RESET default_transaction_read_only;
   COMMIT;
   ```

   No restart is needed afterwards: pooled connections pick the change up, and readiness
   returns to `Ready` within one probe interval. That was verified, not assumed.

   The same holds for a **real promotion**, which has now been rehearsed against a genuine
   streaming standby rather than a session setting
   ([`staging-rehearsal.md`](staging-rehearsal.md)):

   ```
   against the standby   readiness 503 DATABASE_READ_ONLY, liveness 200, reads 200,
                         writes 503 SERVICE_UNAVAILABLE (SQLSTATE 25006, Retry-After: 5)
   pg_ctl promote        readiness Ready within one probe interval
                         same process id, same pool, next write 201
   ```

   So the answer to "do we need to restart the API after a failover" is no, and it is now
   measured. What *does* need doing is fencing the old primary — see the prohibited actions
   above.
5. **Pause the Worker** if the database is recovering, so no claim lands mid-failover.
6. **Restore the database**, or fail over. If the database is lost rather than unreachable,
   this becomes runbook 6.
7. **Validate before resuming**, below.
8. **Resume Workers in controlled order:** `OutboxPublication` first — everything else is
   downstream of it — then `MemoryGeneration`.

### Validation

```bash
curl -s localhost:3011/health/ready          # {"status":"Ready","reasonCode":"OK"}
curl -s localhost:3012/health/ready          # the Worker, same
```

Then an authoritative command test, because readiness proves the process can write and not
that a write succeeds end to end:

```bash
# As a real Member of a real Organization. Creating and cancelling a Work exercises
# the aggregate, the audit row, and the Outbox insert in one transaction.
curl -sX POST -H "X-Organization-Id: $ORG" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"probe","description":"post-incident"}' \
  "$API/works"
```

Then confirm the backlog is draining rather than merely present:

```bash
curl -s -H "X-Organization-Id: $ORG" -H "Authorization: Bearer $TOKEN" \
  "$API/admin/workflow-health" | jq '.freshness, .status'
```

`freshness.stale` must be `false`. A `Healthy` read from a stale projection is the one answer
that means nothing, which is why the field exists.

### Required authorization

Restoring infrastructure is a deployment-operator action and needs no Organization
permission. Anything Organization-scoped — pausing, resuming, reading health or diagnostics —
requires a Membership in that Organization holding the permission. **Infrastructure access
is not Organization authority**, and a deployment operator restoring the database does not
thereby gain the ability to authorize a replay or a skip.

### Audit evidence

- The `authorization_audit_records` rows for any command issued during the incident,
  including denials.
- Pause and resume leave Class B rows carrying the acting Membership and the reason.
- The structured logs, correlated by `correlationId`, which spans the response, the audit
  rows, and the Outbox record for one request.
- Deployment and migration identifiers: `GET /admin/diagnostics` reports `schemaVersion`, so
  two replicas that disagree can be caught rather than inferred.

---

## Runbook 2: Outbox or Worker processing stalled

**Severity: High**, rising to Critical when a dead letter exists or the oldest pending item
passes the blocked threshold.

The failure this runbook exists for is the one every probe misses. Both processes can be
green while nothing has moved for an hour — "Worker readiness does not prove progress."

### Detection signals

- `GET /admin/workflow-health` reports `Degraded` (oldest pending ≥ 300s) or `Blocked`
  (≥ 1800s, or any unresolved failure) for `OutboxPublication` or `ConsumerDelivery`.
- `paused: true` on a workflow — somebody's containment, not a new fault. Find out whose
  before adding another.
- `freshness.stale: true` — the projection stopped refreshing, which usually means the
  Worker loop stopped, because the reconcile runs in it. **Treat a stale projection as a
  stalled Worker until proven otherwise**; the two have the same cause more often than not.
- Worker `GET /health/live` returning `LOOP_STALLED`.
- `worker.drain_failed` in the logs, repeating.

### Safe containment

The queue is the safe state. Outbox rows accumulate durably and nothing is lost by leaving
them; the risk is downstream, in whatever the consumer does.

If the consumer is producing bad effects rather than merely failing, pause it for the
affected Organization before diagnosing (runbook 7). "Queue growth is preferable to
corrupted state" is the architecture's own test for when to pause.

### Prohibited actions

- `UPDATE outbox_messages SET status = 'Pending'` to retry by hand. Publication retry is
  `POST /admin/events/{eventId}/retry`, which is authorized, audited, and fenced.
- Marking a dead letter resolved in the database. "Do not use a database update, process
  restart, lease expiry, feature flag, or successful `ValidateOnly` to mark a dead letter
  resolved or unblock ordering."
- Skipping a dead letter to clear a backlog. A skip asserts something about what the original
  delivery did, and it is terminal.
- Deleting Outbox rows.
- Adding Worker replicas while an ordering key is blocked. The block is per key; more
  workers will not pass it, and the extra concurrency makes the diagnosis noisier.

### Recovery steps

1. **Read the correlated view first.** This is what it is for:

   ```bash
   curl -s -H "X-Organization-Id: $ORG" -H "Authorization: Bearer $TOKEN" \
     "$API/admin/diagnostics" | jq
   ```

   Six fields decide the branch:

   | Field | Meaning |
   |---|---|
   | `projection.stale` | The Worker loop is not running. Start there. |
   | `outbox.claimExpired` | Rows claimed by a Worker that died. Not `Pending`, so nothing claims them; not `Published`, so nothing finished them. |
   | `deliveries.blockedOrderingKeys` | One poison event is holding a stream. Every later event on that key waits. |
   | `deadLettersByStatus` | Deliveries awaiting a human decision. |
   | `pauses` | Somebody already contained this. |
   | `outbox.errorCodes` | What is failing, as bounded codes. |

2. **If the Worker is not running**, start it, and confirm `worker.started` in the logs and
   `GET /health/ready` on `:3012`.
3. **If claims have expired**, they are recovered by the claim lease rather than by hand.
   Confirm the count falls after a drain; if it does not, the Worker is claiming and dying,
   and `worker.drain_failed` says why.
4. **If an ordering key is blocked**, that key is the incident. `GET /admin/events/dead-letters`
   names the delivery, and the Dead-Letter Event runbook in
   `observability-and-operations.md` is authoritative for the recovery-mode choice.

   That runbook says to "use `ValidateOnly` first when handler compatibility, current
   authorization, idempotency, or ordering impact is uncertain". **`ValidateOnly` is not
   reachable in this release.** `POST /admin/events/dead-letters/{id}/reprocess` is
   `ReprocessWithCurrentHandler` and takes no mode, so the dry run the architecture asks for
   cannot be requested. Until it exists, the substitute is to establish the cause from
   `GET /admin/diagnostics` and the logs *before* issuing the command, and to accept that a
   reprocess is a real attempt with real effects.

   **Fix the cause before reprocessing.** A reprocess without a fix fails again, and the
   dead letter returns to `Open` with its version bumped — visible, recoverable, and a wasted
   attempt on the retry counters an operator is trying to read.
5. **If publication is failing**, `POST /admin/events/{eventId}/retry` after fixing the cause.
   Retrying before fixing produces a second identical failure and a worse `attempt_count`.
6. **If the workflow was paused**, resume it (runbook 7) once the cause is resolved.

### Validation

After a reprocess, the terminal transaction is what says whether it worked, and the three
records must agree:

```sql
SELECT status, result_code, last_error_code FROM event_replays ORDER BY created_at DESC LIMIT 1;
SELECT status, resolution_type FROM dead_letter_events WHERE dead_letter_id = :id;
SELECT status FROM consumer_ordering_state WHERE ordering_key = :key;
```

| Outcome | replay | dead letter | ordering |
|---|---|---|---|
| The retry succeeded | `Completed` / `ReplaySucceeded` | `Resolved` / `ReplaySucceeded` | `Active` |
| The retry failed again | `Failed` with the error code | `Open` | `Blocked` |

A replay still `Running` after a drain means the loop did not close — that was a real defect
before these runbooks were executed, and it is worth checking rather than assuming.

- `oldestPendingSeconds` falls, on successive reads. Falling matters more than the absolute
  number: a large backlog that is draining is fine, and a small one that is not is the
  incident.
- `deliveries.blockedOrderingKeys` reaches `0`.
- `freshness.stale` is `false`, so the numbers being read are current.
- Redelivery stays idempotent: the duplicate-safe paths are tested, and a Work that leaves
  `WaitingForDecision` twice would show as an `alreadyApplied` count rather than an error.

### Required authorization

- Reading health: `operations.read_workflow_health` (Owner or Admin).
- Reading diagnostics: `operations.read_diagnostics` (Owner only).
- Publication retry: `events.retry`. Dead-letter reprocess: `events.replay_domain_consumer`
  (Owner; Admin denied by default). Skip: `events.skip`, and for a Domain Coordination or
  irreversible Integration consumer the default is deny — the Owner's command plus registered
  safety evidence is required.
- Pause and resume: `operations.pause_worker` / `operations.resume_worker`.

An Organization-scoped recovery requires an authenticated Active Human Member **in the source
event's Organization**. Infrastructure access does not substitute.

### Audit evidence

Every recovery command is a routed permission and writes an audit row; the privileged reads
do too (ADR-0022). The durable replay record carries the requester's Membership, the reason
code, the reason, and the expected versions the command was fenced on — evidence that the
operator acted on the failure they had looked at rather than whatever it had become.

---

## Runbook 3: Memory generation failure or retry exhaustion

**Severity: Medium**, rising to High when generation is blocked for an Organization long
enough to breach the Work-to-Memory threshold.

Memory generation is `ExternalComputation`, not an external business effect. A provider
timeout with no usable candidate reuses the same operation and source snapshot under bounded
retry, and **does not** use the External Effect Outcome Unknown runbook.

### Detection signals

- `GET /admin/workflow-health` reports `MemoryGeneration` as `Degraded` or `Blocked`.
- `GET /admin/diagnostics` → `generation`:
  - `byStatus.Failed` — terminal. Generation bounds retries by making `Failed` terminal
    rather than by counting attempts, so this *is* the exhausted set.
  - `leaseExpired` — operations claimed by a Worker that died. Invisible to any count that
    looks at status alone, and the honest answer to "why is nothing generating".
  - `errorCodes` — what the provider or the validator objected to, as bounded codes.
- `ai.generator_selected` at startup says which generator is running. If it reports the
  deterministic one, `ANTHROPIC_API_KEY` is unset and no provider is being called at all.

### Safe containment

If the provider is returning unusable or unsafe candidates, pause `MemoryGeneration` for the
affected Organization (runbook 7). It is the narrowest containment available: Decision
outcomes and notifications keep flowing, and only generation stops.

Nothing is lost. The `WorkCompleted` rows stay `Pending` and generate on resume.

### Prohibited actions

- Approving a generated Memory to clear the queue. **The Secretary may generate a draft; the
  Secretary must not approve the Memory.** Approval is Human-only authority, and an operator
  approving on the AI's behalf is the violation runbook 4 exists for.
- Inserting a Memory row directly. A Memory exists only after local validation of untrusted
  provider output (ADR-0004), and a hand-inserted row has been validated by nobody.
- Creating a second generation operation for the same Work to "try again". The operation
  identity and the source snapshot are what make a retry a retry rather than a duplicate.
- Editing `generation_policy_version` or `prompt_template_version` on an existing row.
  Provenance records what actually produced the draft.
- Raising the lease to stop reclaims. An expired lease means a Worker died; extending it
  hides that.

### Recovery steps

1. **Establish the source state.** The Work must be `Completed` and the `WorkCompleted`
   Outbox row must exist. If it does not, this is runbook 2, not this one.
2. **Check the provider.** `ai.usage_observer_failed` and the rate-limit headers reported by
   the generator distinguish "the provider refused" from "we never called it".
3. **Distinguish failure from exhaustion.** `byStatus.Failed` is terminal and needs the typed
   retry command; a `Generating` row with an expired lease needs no command at all and is
   reclaimed by the next drain.
4. **Fix the cause** — provider configuration, credentials, or a validation rule the output
   legitimately fails.
5. **Retry using the same generation identity.** Same operation, same source snapshot, same
   input hash: that is what makes the attempt idempotent and the provenance true.
6. **Recheck no active Memory exists** for the Work before a new draft is created. The unique
   index enforces it; checking first turns a constraint violation into a decision.

### Validation

- `generation.byStatus` shows `Generated` rising and `Failed` not.
- `generation.leaseExpired` is `0`.
- `GET /memories/by-work/{workId}` returns exactly one active Memory, `Generated`, authored
  `AI`, with provenance naming the policy version that produced it.
- The Memory is still `Generated` and not `Approved`. Recovery produces a draft; a human
  reviews it.

### Required authorization

Retry and containment are Organization-scoped operational commands: `events.retry`,
`operations.pause_worker`, `operations.resume_worker`. Reading diagnostics is Owner-only.

Nothing in this runbook authorizes approving a Memory. `memory.approve` is Human-only and is
held by Reviewers and Owners as ordinary business authority, not as an operational action.

### Audit evidence

The generation operation row is the durable evidence of what was attempted: attempt count,
lease holder, policy and prompt-template versions, last error code, and the linked Memory.
It is the recovery store for this consumer by registration — "its recovery store is the typed
Memory-generation operation, not the generic ledger" — so the operation row and the audit row
together are the record, and neither alone is.

---

## Runbook 4: Organization isolation or Human authority violation

**Severity: SEV-1.** Classify as a security incident first and downgrade later if the
evidence supports it, never the other way round.

These are two violations in one runbook because they share a response: both mean the
authorization model did not hold, both require establishing whether anything committed, and
both are answered from the same audit table.

**Neither has a consumable error budget.** "Security isolation, Human authority, immutable
approval, exactly-one Memory, and other domain invariants have no consumable error budget.
Any violation is a correctness or security incident."

### Detection signals

- An `authorization_audit_records` row with `outcome = 'Deny'` and `reason_code` of
  `CROSS_ORGANIZATION` or `HUMAN_AUTHORITY_REQUIRED`.
- A repeated denial pattern for one principal — one denial is the system working; a hundred
  is somebody probing.
- Any response that returned another Organization's data. A cross-tenant resource must return
  `404`, never `403`, because `403` confirms existence.
- An approval, rejection, or completion attributed to a non-Human principal.

*Not yet available:* the isolation alert of baseline item 11. Detection today is reading the
audit table.

### Safe containment

1. **Stop the affected mutation path.** If a Worker is producing the violation, pause it for
   the affected Organization (runbook 7); if a route is, the containment is a deployment.
2. **Preserve evidence before changing anything.** Audit rows are insert-only and safe, but
   Outbox rows, processed-event rows, and ordering state are all mutated by ordinary
   operation. A pause holds them still.
3. **Establish whether exposure occurred or only a rejected attempt.** These are different
   incidents with different obligations, and the audit `outcome` column distinguishes them
   directly.

### Prohibited actions

- **Disclosing one Organization's identifiers to another.** This constrains the incident
  response itself, including notifications, tickets, and status pages.
- Deleting or editing audit rows. They are insert-only by design and carry no foreign keys
  precisely so a row outlives whatever it refers to.
- Widening a permission to "unblock" a caller. If the denial was correct, the caller has no
  authority; if it was wrong, the fix is the policy, and it is a code change with a test.
- Re-running a denied command as a different principal to see whether it works.
- Treating a denial as noise because the request failed. A denial that should have been
  impossible is the finding.

### Recovery steps

1. **Verify whether the attempt was denied.**

   `Deny` means the system refused. `Failed` means the caller was allowed through
   and something after that broke — a different incident, and deliberately a
   different value. Writing this runbook is what found them conflated: an internal
   error had been recorded as a denial, which would have produced a false finding
   here every time a route threw.

   ```sql
   SELECT evaluated_at, permission, outcome, reason_code,
          principal_type, identity_id, membership_id, organization_id,
          resource_type, resource_id
     FROM authorization_audit_records
    WHERE outcome = 'Deny'
      AND evaluated_at > now() - interval '24 hours'
    ORDER BY evaluated_at DESC;
   ```

   Run the same query for `outcome = 'Failed'` separately. Those are defects
   rather than violations, and mixing them is how a real signal becomes noise.

2. **Identify the principal type.** `HumanMember`, `AI`, `System`, or `AuthenticatedSubject`.
   An AI or System principal attempting a Human-only permission is a defect in a caller, not
   an attack.
3. **Verify no authoritative transition committed.** The audit's `previous_state` and
   `next_state` are written by the use case, which is the only layer that knows both. A
   denial with no state change is the model holding.
4. **Inspect the authorization policy version** the decision was made under, and the command
   path.
5. **For an isolation finding, identify every affected Organization** — and record them in
   the incident without exposing either to the other.
6. **Correct the policy or the implementation**, and **add a regression test**. This is a
   step, not an afterthought: the eight-step policy evaluation algorithm is enforced in one
   place, and a violation means a case that place does not cover.
7. **Reconcile affected Aggregates** if anything committed.
8. **Record a security review.**

Two related findings have their own runbooks in `observability-and-operations.md` and should
be followed there: *Last Owner Finding* — an Organization with no Active Owner, where "a
Secretary or System principal must not be assigned as Human Owner" — and *Human Authority
Violation*.

### Validation

- The regression test fails against the unfixed code and passes against the fix. A test that
  passes both ways has proven nothing.
- `python3 scripts/check_routes.py` still reports every routed permission enforced.
- No further denials of the same shape.
- For an isolation finding: a direct query confirming the boundary now holds, run per
  Organization rather than globally.

### Required authorization

Investigation reads the audit table, which is infrastructure access rather than Organization
authority. That distinction matters here more than anywhere: an operator with database access
can *read* the evidence and cannot *authorize* an Organization-scoped repair. Repair through
the typed commands requires a Human Member of that Organization holding the permission.

### Audit evidence

The audit table is the evidence, and its properties are what make it usable: insert-only,
carrying denials as well as approvals, holding no payload content, and written by the
interceptor for every command plus by the guard for refusals that never reach a handler.

Privileged operational reads during the investigation are themselves audited (ADR-0022), so
the investigation leaves the same trace it examines.

---

## Runbook 5: Deployment rollback

**Severity: High.** A bad version is serving.

### The constraint that shapes everything here

**There are no `down` migrations** (ADR-0020). "Reversing a deployment means restoring from
point-in-time recovery, or writing a new forward migration."

So "roll back" means one of three different things, and choosing the wrong one is the way
this runbook fails:

| The bad deploy… | Rollback is |
|---|---|
| Changed no schema | Redeploy the previous image. Ordinary and safe. |
| Added schema, compatible both ways | Redeploy the previous image; leave the schema. Expand-and-contract exists for this. |
| Changed schema incompatibly, or corrupted data | A **new forward migration**, or point-in-time recovery (runbook 6). Never a reversed migration. |

### Detection signals

- Error rate or readiness failures rising after a deploy — today, `http.unhandled_error` in
  the logs and `GET /health/ready`.
- `MIGRATIONS_PENDING` on some replicas and not others: a partial rollout with mixed schema
  expectations.
- `GET /admin/diagnostics` → `schemaVersion` differing between replicas. This is the field's
  reason for existing; two replicas disagreeing about the schema explains a class of symptoms
  that otherwise look like data corruption.
- A workflow that was `Healthy` before the deploy and is `Blocked` after.

### Safe containment

1. **Stop deployment progression.** Halt the rollout before it reaches more replicas.
2. **Prevent mixed incompatible application versions.** Either all replicas run the old
   version or all run the new one; a mix is its own incident.
3. **Pause Workers** if the defect is in a consumer (runbook 7), so the bad version stops
   producing effects while the rollback is decided.

### Prohibited actions

- **Editing an applied migration.** The runner records a checksum and refuses to proceed when
  one changes — because an edited migration means some databases hold one schema and some
  another. The refusal is the safety property, not an obstacle.
- Writing a `down` migration. There are none, deliberately.
- Dropping a column to reverse a schema change. That is data loss presented as a rollback,
  and the expand-and-contract path exists so it is never necessary.
- Rolling back the application while leaving an incompatible schema applied, without
  confirming the old version tolerates it.
- Resuming Workers before validating the schema and the authoritative state.

### Recovery steps

1. **Identify the migration.**

   ```bash
   pnpm --filter @aios/api migrate -- --status
   ```

2. **Determine whether the schema is backward-compatible** with the previous application
   version. Additive changes — a new table, a nullable column — usually are. A narrowed
   constraint, a dropped column, or a changed type is not.
3. **Decide: rollback or forward fix.** Additive schema plus a bad application is the easy
   case and is a redeploy. Incompatible schema, or committed data the new version wrote
   wrongly, is a forward fix — and if the data cannot be repaired forward, runbook 6.
4. **If rolling back the application:** redeploy the previous image, confirm every replica is
   on it, and confirm `schemaVersion` is consistent across them.
5. **If fixing forward:** write a new numbered migration, edit
   `docs/architecture/persistence-and-data-model.md` first — it is the authority on what the
   schema *is* — and let `migrations.test.ts` verify the two agree. The three-step process in
   [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md) is not optional under incident pressure;
   it is the only thing keeping the documented and deployed schemas from diverging at the
   moment they are hardest to reconcile.
6. **Validate before resuming**, below.
7. **Resume Workers in dependency order:** `OutboxPublication`, then `MemoryGeneration`.

### Validation

```bash
pnpm --filter @aios/api migrate -- --status   # nothing pending
curl -s localhost:3011/health/ready           # Ready on every replica
```

Then, per replica, `GET /admin/diagnostics | jq .schemaVersion` — every one the same.

Then an authoritative command test (runbook 1's), and finally:

```bash
curl -s -H "X-Organization-Id: $ORG" -H "Authorization: Bearer $TOKEN" \
  "$API/admin/workflow-health" | jq '.freshness, .status'
```

Fresh, and progressing. A deploy that leaves the projection stale left the Worker down.

### Required authorization

Deployment and migration are deployment-operator actions. Resuming Organization-scoped
processing afterwards requires `operations.resume_worker` held through a Membership —
the same boundary as everywhere else, and the reason a global pause is configuration while a
per-Organization one is a command.

The architecture requires that deployment resume "only after approval". The MVP does not
model an approval workflow, so this is a human agreement recorded in the incident, not a
control the system enforces.

### Audit evidence

- The migration ledger: which migration, its checksum, and when it was applied.
- `schemaVersion` from the diagnostic surface, per replica, before and after.
- Pause and resume audit rows spanning the rollback window.
- The correlated logs for the failing requests that triggered it.
