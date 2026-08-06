# Staging Rehearsal

## Why this exists

Item 12 has been *Partial* for one reason, stated in
[`release-readiness.md`](release-readiness.md): every runbook was written and
executed, but executed against **one** process, **one** database, and no
ingress. Every step that depends on there being *two* of something —
a load balancer with replicas behind it, a real replica to promote, two Workers
dividing a queue, a fleet caught mid-deploy — was reasoning rather than
evidence.

This records what happened when that assumption was removed on one machine.

**It is not staging.** There is no object store, no real provider, no TLS, no
CloudFront, no network partition, no AZ, and the load balancer is a hundred
lines of Node rather than an ALB. What it buys is plurality, and plurality is
where every finding below came from.

---

## The shape

`scripts/staging.sh up` brings up:

```
PostgreSQL primary   :54340   streaming, with a replication slot and archiving
PostgreSQL standby   :54341   a real replica, promotable with pg_ctl
API replica A        :3101    probe :3111   SERVICE_VERSION=staging-a
API replica B        :3102    probe :3112   SERVICE_VERSION=staging-b
Worker 1                      probe :3121
Worker 2                      probe :3122
Readiness proxy      :3100    routes on /health/ready
```

Both API replicas run with `WORKER_IN_PROCESS=false`, which is production shape
and worth stating plainly: under `NODE_ENV=development` the API drains the
Outbox itself. The first attempt at the Worker exercise below measured a fleet
in which **the API was quietly doing the Worker's job**, which would have made
the result meaningless.

`scripts/staging_proxy.mjs` is a stand-in for the target group, not an
imitation of one. It implements the two rules the deployment actually depends
on — route on `/health/ready`, and use hysteresis rather than a hair trigger
(two successes in, three failures out) — and nothing else. When it has no
target it answers `NO_HEALTHY_TARGET`, deliberately **distinguishable from the
application's own `SERVICE_UNAVAILABLE`**: during an outage the first question
runbook 1 asks is whether the ingress lost the replicas or the replicas refused
to serve, and a proxy that echoed the application's body would make that
unanswerable.

---

## What it found

### 1. A working Worker was indistinguishable from a stopped one — *fixed*

The Worker logged `worker.drain_completed` only when `applied`, `failed`, or
`notified` was non-zero. Two Workers drained **120 messages** in this rehearsal
and left **no record of any of them**.

The combination is ordinary rather than exotic. Every one of those events
reached the `notifications` consumer, and the consumer did exactly the right
thing and produced nothing, because "the actor is excluded from their own
notifications" — a Member who assigns Work to themselves is not told about it.
So `applied`, `failed`, and `notified` were all zero while the queue drained
perfectly.

That is [runbook 3](runbooks.md)'s premise — *"Worker readiness does not prove
progress"* — arriving through the evidence an operator reaches for to disprove
it. Readiness said `Ready`, the queue was moving, and the log said nothing at
all; a Worker that had stopped would have looked identical.

Fixed by gating on `claimed`, in `isDrainWorthLogging`, with a regression test
that fails against the old condition. An empty drain still says nothing: the
loop polls every 500ms and an idle queue is not an event.

**Only plurality surfaced it.** In every earlier single-process rehearsal the
events happened to be ones that applied a decision or produced a notification.

### 2. Promotion recovers without a restart — *confirmed, and measured*

A real streaming standby, promoted with `pg_ctl promote`:

| | |
|---|---|
| Readiness against the standby | `503 DATABASE_READ_ONLY` |
| Liveness against the standby | `200 OK` — a restart cannot help |
| A read | `200` — a replica serves reads happily |
| An authoritative write | `503 SERVICE_UNAVAILABLE`, `Retry-After: 5`, SQLSTATE `25006` |
| After `pg_ctl promote` | `Ready` **within one probe interval** |
| The API process | **the same pid**, uptime spanning the whole exercise |

Until now this path had only been exercised by setting
`default_transaction_read_only` on a database — a session-level simulation. The
pooled connections became writable in place against a genuine promotion, and
the next write returned `201` from the same process.

### 3. Promoting produces split brain in one command — *runbook 1 corrected*

Immediately after the promotion, **both** clusters reported
`pg_is_in_recovery() = false`. Two writable primaries, from one command, with
nothing in the runbook warning about it.

Runbook 1 said only *"Resolve the failover; do not work around it."* It now
carries fencing as a prohibited action and the two-line check that catches it.

### 4. Two Workers divide the queue rather than duplicating it — *confirmed*

120 events, two Worker processes:

```
worker-1  61 messages across 5 drains
worker-2  59 messages across 4 drains
processed_events: 120 deliveries, 120 distinct events
```

`FOR UPDATE SKIP LOCKED` plus per-consumer delivery records, asserted with real
concurrency for the first time. The header comment in `worker.ts` has claimed
this since it was written.

### 5. Code ahead of its migration takes the whole fleet out of rotation — *confirmed*

Rolling the ledger back to `0004` (dropping the table and its ledger row, which
is what "deployed the code, did not run the migration" looks like):

- both replicas reported `MIGRATIONS_PENDING` and left rotation after 6s;
- the ingress answered `NO_HEALTHY_TARGET` naming the reason;
- `GET /admin/diagnostics` reported `schemaVersion = 0004_audit_failed_outcome`,
  which is exactly how [runbook 5](runbooks.md) says a mixed fleet is caught;
- applying the migration returned both replicas to rotation in 4s.

This is the correct behaviour and it is also a **total outage rather than a
degradation**. That makes the ordering in `deploy.yml` — migration task first,
exit code checked, services rolled only after — load-bearing rather than tidy.

### 6. Readiness gates the ingress, not the process — *worth stating*

A write sent **directly** to an `Unready` replica, bypassing the proxy, returned
`201` and was published normally. Readiness is a routing signal; it does not
refuse traffic that reaches the process another way. Anything that bypasses the
load balancer — a debug session, a port-forward, a misconfigured internal
caller — is not covered by it.

### 7. Recovery from a database outage, through an ingress, with two replicas — *confirmed*

| | |
|---|---|
| Primary stopped | both replicas out of rotation after 6s (3 failures × 2s) |
| Ingress answer | `503 NO_HEALTHY_TARGET`, naming `DATABASE_UNAVAILABLE` per target |
| Direct probe | `503 DATABASE_UNAVAILABLE` — runbook 1 step 1 |
| Liveness | `200` on both throughout |
| Primary restarted | both back in rotation after 4s |
| Restarts | **none** — both pids spanned the outage |

The `pg.Pool` crash-loop fix holds under a real outage with more than one
replica.

### 8. A paused Worker contains itself and only itself — *confirmed*

`WORKER_PAUSED_TYPES=OutboxPublication` on Worker 2 only:

```
worker-2  Unready, ADMINISTRATIVELY_PAUSED   (liveness Ready — a pause is not a fault)
worker-1  Ready
30 new events → worker-1 claimed 60 messages, worker-2 claimed 0
```

The queue kept draining. [Runbook 8](worker-containment.md) says a pause claims
nothing and rows drain after it is lifted; with one Worker that is unfalsifiable,
because there is nothing to distinguish "paused" from "stopped".

---

## And two tests that only passed in one environment

Running the existing suite against the staging primary — an archiving cluster
under load from two Workers — failed twice where the default cluster passed.
Neither was a product defect; both were tests that quietly described their
environment instead of the code.

**A test that required a cluster with no recovery window.**
`reports no WAL archive lag on a cluster that has never archived` asserted
`null`. That is true where `archive_mode` is off, and false on any cluster
configured the way [`backup-and-recovery.md`](backup-and-recovery.md) requires —
so the test passed only on databases that would fail the baseline. It now
compares against `pg_stat_archiver` directly and asserts the *mapping*: never
archived → withheld, archived → an age. It passes on both.

**A correlation assertion that raced.** `ties the audit row and the Outbox event
to one identifier` read `ORDER BY created_at DESC LIMIT 1` over every
`work.create` audit row. Test files run in parallel against one schema, so the
newest row can belong to another file's request. It had passed for months and
failed the first time the suite ran against a database that was also busy. Now
scoped to the Work under test. The flake was made visible, not introduced.

Both are the same lesson as finding 1, one level up: **a check that has only run
in one environment has only been checked in one environment.**

---

## Three self-inflicted failures worth recording

They are not application defects, but each cost time and each is a trap the
runbooks can hit.

**`pkill -f <pattern>` killed the rehearsal three times.** `-f` matches the full
command line of every process, *including the shell running the script* — whose
command line contains the pattern, because the pattern is written in it. Each
time it looked like the thing under test had crashed. `staging.sh down` now
finds processes by reading `PROBE_PORT` out of `/proc/*/environ`. This is the
same trap as a `pgrep -f` liveness check that matches itself and reports a
healthy process dead, which an earlier session already hit once.

**`set -o pipefail` plus `grep -c` killed `staging.sh up` after it had
succeeded.** `grep -c` exits 1 when the count is zero; `pipefail` promotes that
to the pipeline's status; `set -e` then ended the script on the first poll,
before either replica was healthy. The environment was up and running the whole
time. It looked exactly like a start-up failure.

**Zero notifications is the correct answer.** The first Worker exercise produced
120 deliveries and 0 notification rows, which read as a bug for several minutes.
It is the documented behaviour — the actor is excluded from their own
notifications — and chasing it is what uncovered finding 1.

---

## What is still unrehearsed

| Step | Needs |
|---|---|
| Runbook 6's real RTO | An object store. The measured figure remains a floor: a local restore of a small cluster, excluding fetch, provisioning, and pre-cutover validation |
| Multi-AZ failover as AWS performs it | An AWS account. What was rehearsed is `pg_ctl promote`, which is the same *application* path and a different *provider* path |
| Deletion-resistant backups, encryption, key custody | Phase 2 applied |
| Any alarm firing | A metric backend. The transport publishes; nothing has evaluated a rule |
| The real model provider | `ANTHROPIC_API_KEY`. Every generation so far is the deterministic generator |
| TLS, CloudFront, real DNS | Phase 3 applied, and A1 for the web client |
| Network partition, AZ loss, slow disk | Not reproducible here in any honest form |

The load balancer's own behaviour is also unrehearsed, and deliberately so:
connection draining, TLS termination, idle timeouts, and target
deregistration under load are claims about AWS. What was tested is the
application's half of the contract.

---

## Running it

```bash
sudo ./scripts/staging.sh up       # ~90s
./scripts/staging.sh status
sudo ./scripts/staging.sh down
```

It creates its own clusters under `/tmp/aios-staging` and touches no existing
database. `down` removes nothing else.
