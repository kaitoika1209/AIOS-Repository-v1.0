# Release Readiness

## Purpose

This document sequences the work between the build as it stands and an AIOS MVP
operated in production for real Organizations.

It is not the product roadmap. [`docs/product/roadmap.md`](../product/roadmap.md) describes
which capabilities arrive in which phase and says outright that it "does not approve code,
schema, events, interfaces, infrastructure, or deployment dependencies". This document is
about the other axis: what has to be true before Phase 1 — already built — can carry a
customer's data.

The authority for that question is not this document either. It is the **MVP Production
Baseline** in [`observability-and-operations.md`](../architecture/observability-and-operations.md),
which states the gate plainly:

> An MVP release is not accepted for production when any item in this baseline is absent
> unless the architecture owner records a time-bounded risk acceptance.

What follows is that baseline assessed against the code, plus the product and delivery
work the baseline does not cover.

---

## Where the build stands

Every one of the 34 Release Acceptance Criteria in `docs/product/mvp.md` is demonstrable,
and demonstrated: `apps/api/src/acceptance.e2e.test.ts` runs each one against a real
PostgreSQL schema built from the documented DDL, starting from an empty database and
driving the whole loop over HTTP.

| | |
|---|---|
| Release Acceptance Criteria | 33 executable tests, all passing |
| Test suite | 873 passing (types 11, domain 170, application 295, persistence 89, api 308) |
| Routed permissions enforced | 47 / 47 |
| Documentation checks | 65 files |
| Accepted and proposed ADRs | 24 |

The domain loop is complete. Work → Decision → completion → generated Memory → human
review → immutable approved Memory works end to end, with Organization isolation, an
eight-step authorization model, a transactional Outbox with typed recovery, and an
authorization audit that records denials as well as approvals.

**What is missing is almost entirely operational.** That is the honest shape of the
remaining work, and it is why the stages below are ordered the way they are.

---

## The gate: MVP Production Baseline

Thirteen items. Assessed against the code as it stands.

| # | Baseline requirement (MUST) | Status |
|---|---|---|
| 1 | Structured JSON logs with a stable base envelope and redaction | **Done** — version-3 envelope, key-based redaction, allowlisted error fields, JSON to stdout |
| 2 | Bounded telemetry exporters with queue limits, timeouts, retry ceilings, loss counters, shutdown deadlines | **Done** — every bound built and tested against a backend that misbehaves (ADR-0024) |
| 3 | Server-owned request and workflow correlation | **Done** — one identifier spans the response, the audit rows, and the Outbox |
| 4 | Error capture for unhandled application and Worker failures | **Done** — `uncaughtException` and `unhandledRejection` captured in both processes |
| 5 | RED metrics for HTTP traffic | **Done** — `http_server_requests_total` and `_duration_seconds`, recorded in middleware so guard refusals are counted |
| 6 | PostgreSQL, Outbox, Worker, queue-age, and Work-to-Memory workflow metrics | **Done** — sampled levels, no Organization dimension |
| 7 | Durable audit for Human-authoritative transitions and privileged operational actions | **Done** — `authorization_audit_records`, edge and use-case halves |
| 8 | HTTP and Worker liveness/readiness, asynchronous workflow health, restricted admin diagnostics | **Done** — four process probes, the rebuildable health projection with freshness, and the Owner-only diagnostic surface (ADR-0023) |
| 9 | Bounded retry, idempotency, retry-exhaustion visibility, dead-letter handling, typed Operations commands for Worker pause/resume, replay, dead-letter retry/skip | **Done** — pause and resume land as ADR-0022, alongside replay and dead-letter retry/skip |
| 10 | Continuous WAL archiving, base backup ≥ every 24h, 14-day PITR, monthly verified restore test, approved RPO and RTO | **Absent** — the restore *procedure* is proven by an executable drill; no production storage, schedule, or retention exists |
| 11 | Actionable alerts for database unavailability, authoritative-write failure, Outbox or Worker stoppage, Memory-generation failure, Organization-isolation violation | **Absent** — the series the rules attach to now exist; the rules need a backend to evaluate them |
| 12 | The six MVP runbooks | **Partial** — all six written, plus two for Worker containment, and all executed; runbooks 1–5 against a live local environment rather than staging |
| 13 | Separate Worker process | **Done** — `apps/api/src/worker.ts`; `chooseWorkerMode` refuses in-process draining outside development |

Ten done, one partial, two absent. What remains needs infrastructure this
repository does not have: a metrics backend to evaluate alert rules against, an
object store to hold backups in, and a staging environment to rehearse the
runbooks in.

Item 12 stays Partial for a narrower reason than before: every runbook has now been
executed, but runbooks 1–5 were executed against a **live local environment**, not a staging
one. There is no load balancer, no replica set, no object store, no second application
replica, and no real provider, so every step depending on those is still unrehearsed.

Executing them was not a formality. It found three defects — see
[`runbooks.md`](runbooks.md) — one of which was a recovery command that appeared to work and
did not.

---

## Stage A — Make the product reachable by a real person

Nothing here is exotic; all of it is load-bearing for a first customer, and none of it is
covered by the operational baseline.

### A1. Sign-in

`ClerkAuthAdapter` is implemented and unit-tested, and `chooseAuth` refuses to fall back to
the development stub outside `development` and `test`. It has **never been verified against
a live Clerk instance**, and the web application has no sign-in at all — it carries an
identity switcher that sets `x-dev-subject`.

- Configure a Clerk instance; verify token verification both networkless (`CLERK_JWT_KEY`)
  and via JWKS.
- Replace the development switcher with a real session in `apps/web`.
- Decide whether the profile webhook `CLERK_WEBHOOK_SIGNING_SECRET` anticipates is in
  scope. It is in `.env.example` with no endpoint behind it, which is a loose end either
  way — implement it or remove the variable.

### A2. More than one Organization — done

`GET /organizations` returns the Organizations the caller holds an Active Membership in,
and the web client selects among them. The environment variable is gone.

The API gap came first and carried a decision, recorded in ADR-0014 as its fourth
exemption: listing your own Memberships cannot require an Organization to already be
selected, because that is circular. Two properties make the exemption safe and both are
structural rather than checked — the route takes no parameters at all, so there is nothing
to probe with, and the result is derived from the authenticated subject, so a wider answer
would need a defect in the query rather than a missing guard.

One interaction was easy to miss and would have been a real defect: **the list includes
Suspended Organizations.** Reactivation is exempt from the Organization status check
precisely so an Owner can recover a suspended Organization — but an Owner who cannot *find*
it has no route to that exemption, and filtering the list to Active would have quietly made
the documented recovery path unreachable from any client. There is a test that suspends an
Organization, finds it in the list, and reactivates it from there.

In the client, the selected Organization is a cookie, and the cookie is a *preference*
rather than an authority: it is validated against the caller's real Memberships on every
read, and a value naming an Organization they do not belong to is discarded rather than
sent. The API would refuse it anyway with a `404`, but a client that forwards an
unvalidated tenant identifier is one line away from being the thing that leaks. Verified by
forging one.

A person who belongs to no Organization now gets an offer rather than an error — create one
and become its first Owner, or accept an invitation. That state is ordinary for someone who
has just signed in, and it is exactly the state a real first user arrives in.

### A3. Verify the model provider for real

`AnthropicMemoryGenerator` and the groundedness evaluation harness exist. Generation has
only ever run against `DeterministicMemoryGenerator` here, because `ANTHROPIC_API_KEY` is
unset.

**The harness can now answer all three questions; only the credential is missing.** It
previously could not: the generator discarded the provider's `usage`, so a live run would
have produced drafts and no cost. It now reports tokens, cost, and the rate-limit headers
the provider actually sent — collected by pattern rather than by a fixed list of names, so
the run reports the limits that exist rather than the ones someone anticipated.

```
4 provider call(s): 4800 input, 3200 output tokens
  of the output, 2000 tokens (63%) were internal reasoning
Cost: $0.1040 total, $0.0260 per generation  (at $5/$25 per Mtok)
```

That figure is from a stub, not the provider — the reporting path is tested against a local
HTTP server (`anthropic-memory-generator.test.ts`) so it runs on a machine with no
credential. What the stub cannot tell us is what the real numbers are.

One thing to look at in the first live run: **the pinned model thinks by default.** The
generation policy sets no `thinking` parameter, so reasoning tokens are billed as output
and are invisible in the draft. If the live run shows a share anything like the stub's, the
cost per Memory is dominated by reasoning on a task the policy describes as "not
intelligence-limited" — which would make `thinking: {type: "disabled"}` at the current
`effort: "medium"` worth measuring. That is a policy-version change (ADR-0016), not a tuning
knob, so it needs the numbers first.

Remaining, all requiring the key:

- Run `evaluate-generation` against the live API and record the result.
- Record the real cost per generation and the rate limits that apply.
- Confirm the groundedness validator's behaviour on real output, not synthetic.

**Stage A is done when** a person with no prior account can sign in, create an
Organization, invite a colleague, and complete the loop through a real model — with no
`x-dev-subject` header anywhere.

---

## Stage B — The operational baseline

This is items 1–13 above, and it is the largest stage. It divides cleanly into work that
belongs in the codebase and work that belongs in infrastructure.

### B1. Telemetry ports and structured logging (items 1–4)

The architecture is explicit that "Application code depends on AIOS telemetry ports and the
versioned operational log schema. AWS SDKs, CloudWatch namespaces, and exporter
configuration remain Infrastructure Layer details." The port is built; the binding to
CloudWatch is Stage D.

**Item 3 is done, and it was the one that was quietly false.** `correlation_id` existed on
Outbox and audit rows, which read as partial credit — but the edge audit, the use-case
audit, and the Outbox each called `randomUUID()` independently. One HTTP request therefore
wrote **three unrelated correlation identifiers**, and no workflow could be followed from
the command that started it to the event it produced. The column was populated and the
field was useless.

Correlation is now request-scoped through `AsyncLocalStorage`, established by middleware
rather than an interceptor — Nest runs middleware before guards, and the guard writes the
audit rows for the refusals it makes, so an interceptor would have left exactly the refused
requests uncorrelated. Verified end to end: one request's response header, audit row, and
Outbox event carry the same identifier, and two requests carry different ones.

The trust boundary is implemented as written. A caller's `X-External-Correlation-Id` is
retained only after bounded validation, kept under a name that cannot be mistaken for the
server's, and is never promoted — the architecture forbids it from affecting "authorization,
tenant selection, ownership checks, idempotency, uniqueness, database joins, routing,
rate-limit identity, or workflow state changes."

**Item 1 is partial.** The version-3 base envelope, its redaction, and a JSON stdout sink
exist and are tested. What remains is call-site migration: most of the codebase still uses
`console.log`, and each one is a record with no envelope, no class, and no correlation.
Redaction is applied inside the logger rather than trusted to callers, because a rule every
call site must remember is a rule that holds until the first person in a hurry — and a
secret in a log is in every replica of that log permanently.

**Items 1 and 4 are done too.** Every `console.log` and `console.error` in the API, the
Worker, and the two libraries now goes through the port, and both processes capture
`uncaughtException` and `unhandledRejection` — a process that dies to one used to leave
nothing but whatever Node printed to stderr, which in a container is often the last thing
before the log stream ends.

Migrating the call sites turned up a leak worth recording, because it was not hypothetical:

```
console.error("Audit write failed", { entry, error });
```

A PostgreSQL error carries `detail`, and on a unique violation `detail` contains the
conflicting value:

```
Key (primary_email_normalized)=(alice.private@example.test) already exists.
```

Duplicate invitations and duplicate Memberships are ordinary traffic, so that line put real
email addresses into the logs as routine behaviour — along with `where`, `internalQuery`,
`table`, and `column`. Reproduced against a live database before the fix was written.

`describeError` therefore **allowlists** — type, bounded message, bounded code, bounded
stack — and drops everything else. A field the driver adds tomorrow is excluded by default,
which is the only safe direction: a denylist of known-dangerous fields fails open the day
the driver changes.

Remaining:

- Bounded exporters with queue limits, timeouts, retry ceilings, loss counters, and
  shutdown deadlines (item 2). None of that is meaningful until there is a remote sink,
  which is Stage D.

### B2. Health and metrics (items 5, 6, 8)

**The four process probes are done.** `GET /health/live` and `GET /health/ready` on both
the API (`:3011`) and the Worker (`:3012`), on a probe listener separate from the
application — the Worker has no HTTP application to host routes on, and keeping the probes
off the API means `RequestContextGuard` still has no unauthenticated path through it, so
"no route can be reached without a resolved principal" stays true as written.

Readiness checks database reachability, that the database will accept writes, and that the
migration chain is fully applied — the last is answerable only because C1 built the ledger,
and it is what stops a process that shipped ahead of its migrations from joining the load
balancer. Worker liveness is the drain loop's heartbeat rather than mere process existence,
so a loop that stops turning is visible without waiting for the queue to back up.

Verified by causing the failures rather than by reading the code: migrations withheld,
database made read-only, database stopped under both running processes. That last one
**found a defect that would have crash-looped production** — see the note below.

**Asynchronous workflow health is done**, as ADR-0021's promotion of
`operations.read_workflow_health`. `GET /admin/workflow-health` reports four workflow types
— Outbox publication, consumer delivery, dead letters, and Memory generation — each with a
status, a pending count, the age of the oldest pending item, and a bounded reason code.

It closes the gap the probes themselves opened: both processes can be green while nothing
has moved for an hour, because "Worker readiness does not prove progress". Status is decided
by **age, not count**, which the architecture requires and which matters in both directions
— an Organization processing thousands of items promptly is healthy, and one with a single
item stuck for two hours is not.

`Unknown` is reported rather than omitted when a query cannot answer. An operator reading
three healthy workflows would reasonably conclude the fourth was fine, so a workflow that
failed to measure appears and says so.

**The projection and the diagnostic surface are done** (ADR-0023), which completes item 8.

`GET /admin/workflow-health` now reads the rebuildable `organization_workflow_health`
projection rather than deriving live, and the answer carries the projection's own freshness.
That is a smaller-sounding change than it is. A live query is always current, which sounds
like an advantage and is exactly why the failure it lacks — no answer at all — was
invisible. Now "the numbers look fine" and "the numbers are current" are two facts an
operator can read separately.

**There is deliberately no fallback to a live query when the projection is stale.** The
architecture: "When the projection becomes `Stale`, operators must not infer that
Organizations are `Healthy`." A fallback would hide the exact failure the freshness field
exists to expose, and would hide it most reliably at the moment it mattered most. There is a
test that makes the source tables and a frozen projection disagree and asserts the answer is
`Stale` rather than either.

Reconciliation is one mechanism doing three jobs, which is why it was worth building before
the optional per-transition update: it is the scheduled reconcile the architecture requires,
it is the rebuild ("Rebuilding or deleting it does not change the underlying business or
delivery truth" — there is a test that deletes every row and asserts byte-identical
recovery), and it is the drift detector. A recompute cannot drift from its own source, so
rather than a check that cannot fail, the reconcile **reports what it corrected**. Zero is
what "already correct" looks like.

**The status vocabulary changed**, and ADR-0023 explains why at length. ADR-0021 had used
`Critical` for what the architecture calls `Blocked`, and had no `Stale` or `NoData` — a
conflict it created without noticing, because it never addressed the projection's status
set. The architecture's names win: item 11's alerts are written against them ("a new
**Blocked** transition creates a High alert"), and a translation layer between an alert rule
and the status it fires on is where alerts silently stop matching. `Unknown` is kept, because
`Stale` says the projection is behind and `NoData` says there is nothing to report, and
neither says *the query did not run*.

**`GET /admin/diagnostics` is Owner-only**, and that is a narrowing recorded as one. The
architecture asks this surface — and only this surface — for "an authenticated operator with
an explicit operational role". The MVP models four roles and none is operational; inventing
one is an identity and role-matrix change, not a permission grant. So it goes to the
narrowest role that exists rather than to a role that does not.

It correlates the projection's freshness, the four workflows, the Outbox, consumer
deliveries and dead letters, generation operations, administrative pauses, and the applied
migration in one response. Every rule attached to it is structural rather than remembered:
the SQL never selects a message column, so there is nothing to redact; the window is clamped
to seven days and every list capped; and it is on the authenticated API rather than the probe
port, so an orchestrator has no credential to misconfigure it with.

Remaining for the observability stages:

- RED metrics for HTTP; the PostgreSQL, Outbox, Worker, and Work-to-Memory metrics the
  baseline names. The projection's own series —
  `organization_workflow_health_organizations`, `_projection_age_seconds`, and
  `_transition_total` — are among them: ADR-0023 delivers the durable state they will be
  computed from and the status names they will be labelled by, not the series.
- Cross-Organization diagnostics, which need the same deferred principal as a global Worker
  pause — the third ADR running to hit that wall.
Worker readiness now reports `ADMINISTRATIVELY_PAUSED`, which it could not before pause
existed. The remaining probe gap is a different one: both Worker types share a process, so a
deployment pause of either makes that process unready, while the architecture asks that "one
Worker type becoming unready MUST NOT make unrelated Worker types ... unready". Separating
them is a deployment-topology change, not a probe change.

#### The defect that stopping the database found

Every `pg.Pool` was constructed without an `error` listener. `pg` emits that event when an
**idle** connection dies — a PostgreSQL restart, a failover, a proxy idle-timeout,
`pg_terminate_backend` — and in Node an `'error'` event with no listener is rethrown and
ends the process.

So a routine database restart killed the API and the Worker outright. Not degraded: gone,
before either probe could answer. That is the precise failure the liveness surface exists to
prevent — "a transient dependency outage must not cause a restart loop" — and no amount of
correct probe logic would have helped, because the process being probed no longer existed.

`createPool` in `@aios/persistence` now attaches the listener, and every entry point uses
it. The handler only logs: `pg` has already discarded the broken client and the next
checkout opens a fresh connection, so the pool heals by itself. All that was ever missing
was someone listening.

Worth noting for its own sake: this was invisible to the whole test suite, to typechecking,
and to reading. It appeared the first time something stopped the database under a running
process.

### B3. Worker as its own process, with pause and resume (items 9, 13)

**Item 13 is done.** `apps/api/src/worker.ts` is the Worker's own entry point, and
`chooseWorkerMode` decides who drains: in-process under `development` and `test`, a separate
process otherwise, with `WORKER_IN_PROCESS` overriding either way and the reason logged at
startup rather than inferred from behaviour. Verified by running it — with the API started
at `WORKER_IN_PROCESS=false`, completing a Work produced no Memory until the Worker process
was started, at which point it drained and generated one. SIGTERM finishes the batch in
flight before exiting, so a deploy hands claimed messages back rather than leaving them to
their lease timeout.

Running several is safe: the Outbox claim uses `FOR UPDATE SKIP LOCKED` and each consumer
records its own delivery, so replicas divide the queue instead of duplicating it.

**Item 9 is done**, and one part of it only became true when the runbooks were executed.
`POST /admin/events/dead-letters/{id}/reprocess` re-queued the delivery and the drain did
re-attempt it — but nothing closed the loop afterwards. The replay stayed `Running` for ever
and the dead letter stayed `ReadyForReplay` whether the retry succeeded or failed again, so
an operator could not tell those two apart, and `ReadyForReplay` reads as "queued and fine".

The terminal transaction the events architecture requires now runs: on success the dead
letter becomes `Resolved` / `ReplaySucceeded`, the replay `Completed`, and the ordering key
`Recovering -> Active`; on failure the replay is `Failed` with its error code and the dead
letter returns to `Open`, which is the documented transition. Attribution comes from the
Human who authorized the replay rather than from the Worker, which holds no Membership and
could not satisfy `ck_dead_letter_resolution` if it tried.

One gap in this area is recorded rather than closed: **`ValidateOnly` is not reachable.** The
events architecture asks an operator to use it first when handler compatibility or ordering
impact is uncertain, and no route accepts a replay mode. Runbook 2 says so and gives the
substitute.

Pause and resume land as
[ADR-0022](../adr/0022-promote-worker-pause-and-resume.md), the same promotion path the
`events.*` recovery commands followed. Stopping the Worker no longer means stopping the
process.

What made this the last piece of item 9 was not the mechanism but the authority. A Worker
type is process-wide; a permission is held through a Membership in one Organization. An
Owner of one tenant pausing "the Memory Worker" would halt every other tenant, and
`authorization.md` forbids that and forbids the escape hatch: "The MVP does not model a
cross-Organization Human PlatformOperator principal ... Cross-Organization replay, support
impersonation, and break-glass recovery require a separate future identity, approval,
customer-visibility, and audit design."

So it ships as two controls split along that boundary:

- **`operations.pause_worker` / `operations.resume_worker`**, routed as
  `POST /admin/workers/{workerType}/pause` and `/resume`, granted to Owner and Admin. A
  pause suspends claiming for **that Organization only** — the "pause Organization-scoped
  Worker processing" action the architecture lists under Organization-specific containment.
- **`WORKER_PAUSED_TYPES`**, deployment configuration with no route and no permission,
  because it has no principal. It is the "deployment or database operators may pause
  Workers" case, and it is what closes the readiness requirement: a Worker paused this way
  reports `Unready` with `ADMINISTRATIVELY_PAUSED`.

Two Worker types are pausable — `OutboxPublication` and `MemoryGeneration` — sharing names
with ADR-0021's health vocabulary. `ConsumerDelivery` has no claim loop of its own, so
`OutboxPublication` already is its pause, and a dead letter is a record awaiting a decision
rather than a Worker; the command rejects both rather than recording a pause that stops
nothing.

**Pausing means not claiming.** The entire mechanism is one predicate on the Outbox claim,
which is what makes it safe: nothing is begun and abandoned, no delivery is recorded as
attempted, no attempt counter moves. Rows stay `Pending` and drain in order after the
resume, so resuming needs no repair and no replay. Checking the pause inside a consumer
instead would mark deliveries attempted that never were, corrupting the retry counts and
pending ages the rest of items 9 and 11 read.

Verified against a real database and a real drain, and by deliberately removing each half of
the predicate to confirm the tests fail: with the Organization-scoped half gone, four tests
break; with the deployment-scoped half gone, one does. The composite foreign key on the
pause row was checked the same way — PostgreSQL refuses a Membership from another
Organization, independently of the permission check.

**What it does not do.** A pause does not expire; nothing lifts it but a person. The health
report makes a forgotten one visible — it reports `paused: true` beside a status that keeps
climbing — but a scheduled expiry needs a second durable mechanism and a default duration
nobody has yet earned by running an incident with this. Runbook 7 says so, and says to put
the reversal in the incident record.

**A correction ADR-0022 carries.** ADR-0021 claimed the workflow-health read was "audited
like every other routed permission". It was not — the audit interceptor skips `GET`, on
purpose, because "a row per list request would bury the ones that matter". That reasoning is
right for `GET /notifications` and wrong for a privileged operational read, which the
architecture requires to be audited. The interceptor now audits `GET` for the `events.*` and
`operations.*` families only, `check_audit.py` enforces the rule in both directions, and
`GET /admin/events/failed` gained the trace it should always have had.

### B5. Telemetry, metrics, and the exporter (items 2, 5, 6) — done

Three baseline items with one shape, and ADR-0003 had already decided the
destination and attached the two limits that decide everything else: a hundred
active time series, and no tenant identifier in a dimension.

**The cardinality rule is enforced in code** (ADR-0024). A closed catalogue of
metric names and a closed allowlist of dimension names, both checked on every
sample. That is not fastidiousness — ADR-0003 explains that provider rollups
outlive the 30-day query window, so an identifier reaching a dimension is a
tenant-data retention path *no deletion request can reach*, created by a line of
instrumentation nobody thought was a data-handling decision. A review cannot be
the only thing standing between a call site and that.

A refused sample is **dropped loudly, never thrown**: telemetry must not be able
to fail a request. Export limits are the exception and throw at startup, because
a process configured to buffer without limit should not start.

**RED is middleware, and getting there took two live failures.** As an
interceptor it recorded every refusal as `2xx` — Nest runs interceptors before
exception filters, so the status was still the default when the sample was taken.
And it never saw a guard's refusal at all, because guards run before
interceptors. Those are the most security-relevant denials there are.
`response.on("finish")` in middleware sees every request once, with its real
outcome, including the ones nothing else in the pipeline observes. Verified by
issuing a success, a 400, a 404, a guard denial, and an unmatched path, and
reading what came out.

**The exporter is bounded at every edge**, and each bound is tested against a
transport that misbehaves on purpose: a queue that cannot grow, an admission
policy that evicts by priority without growing, a per-request deadline that
aborts, a retry ceiling that discards rather than requeuing, and a shutdown that
returns `false` rather than hanging. That last one was wrong when written —
`shutdown` reported success because the queue had emptied, while the batch was
still in flight to a backend that never answered — and the test is what found it.

Item 6's levels are sampled rather than counted, and carry **no Organization
dimension**: "Metric backends receive only bounded aggregate status counts;
Organization identifiers remain in PostgreSQL, logs, traces, and authorized
diagnostic results." The per-Organization answer is the authorized health route.

Not built, and named rather than implied: **the CloudWatch transport**.
`METRICS_SINK=cloudwatch` is accepted and says so in the startup log rather than
discarding silently, because an operator who configured it and got nothing should
be told why rather than find out from an empty dashboard mid-incident.

### B4. Alerts and runbooks (items 11, 12)

Six runbooks, each of which the architecture requires to identify "detection signals, safe
containment, prohibited actions, recovery steps, validation, required authorization, and
audit evidence":

1. Application or database unavailable
2. Outbox or Worker processing stalled
3. Memory generation failure or retry exhaustion
4. Organization isolation or Human authority violation
5. Deployment rollback
6. PostgreSQL backup or WAL failure and point-in-time recovery — written, in
   [`backup-and-recovery.md`](backup-and-recovery.md), and executable as
   `scripts/restore_drill.sh`

Two more exist beyond that list, both in
[`worker-containment.md`](worker-containment.md), because pause and resume made them
possible: **runbook 7**, containing one Organization's asynchronous processing, and
**runbook 8**, stopping a Worker type for every Organization. Runbook 7 is the safe
containment step that runbooks 2 and 3 have to reach for, so those two can now be written
against something that exists.

A runbook that has never been executed is a draft. Each should be exercised once against a
staging environment before launch, which is what makes runbooks 5 and 6 depend on Stage C
and Stage D existing first. Runbooks 7 and 8 have been exercised in the test suite rather
than by hand — the pause, the drain that claims nothing, the resume, and the drain that
clears the backlog all run against a real database on every build.

---

## Stage C — Data durability, and the sharpest gap

**C1 is done** (ADR-0020, the migration ledger).

### C2. Backup and recovery (item 10)

Full detail in [`backup-and-recovery.md`](backup-and-recovery.md). The short version is a
split worth keeping visible:

**The recovery procedure is proven.** `scripts/restore_drill.sh` performs a real
point-in-time recovery against a throwaway cluster and asserts the point was honoured —
rows before the target present, rows after it **absent**, deleted rows recovered. The middle
assertion is the one that matters: without it, "the data came back" is satisfied by a
restore that replayed the whole WAL, which is exactly the restore that does not help when
the thing being recovered from is a mistaken deletion. Confirmed by removing
`recovery_target_time` and watching the drill fail.

**Nothing about production storage exists.** No durable archive destination, no backup
schedule, no retention, no deletion-resistant tier, no encryption or key custody, nothing
scheduling the drill, and none of the nine recovery metrics. All Stage D infrastructure.

So item 10 stays **Absent**, deliberately. A correct procedure with nothing to restore from
recovers nothing, and marking it Partial on the strength of a working drill would be the
same error the architecture warns about one line earlier — treating a green job as proof of
recoverability.

The measured `restore_test_rto_seconds: 2` is a floor and is labelled as one: a 39 MB local
cluster, excluding object-store fetch, provisioning, and the pre-cutover validation the
architecture requires. Quoting it as an achieved RTO would be dishonest in exactly the way
this stage exists to prevent.

Runbook 6 of the six is written, in `backup-and-recovery.md`. It is the only one of the six
that has a rehearsal behind it.

---

## Stage D — Deployment

ADR-0003 names the target: AWS, region `ap-northeast-1`, CloudWatch Logs and Metrics,
CloudWatch Alarms, SNS to verified operator email, CloudTrail for telemetry control-plane
changes.

**Build artifacts: written, not built.** `Dockerfile` has three targets — `api`, `worker`,
`web` — sharing one workspace build. It has never been through `docker build`, because it
was written where no container registry was reachable, and the file says so at the top
rather than implying otherwise.

What *is* verified is the part that was actually broken. Each image's command was run as
plain `node` against PostgreSQL, outside any container:

| Command | Result |
|---|---|
| `node dist/migrate.js` | Took an empty database to the documented schema; `applied 0001_baseline` |
| `node dist/main.js` | Started under `NODE_ENV=production` with Clerk selected, refused in-process draining, served `401` unauthenticated |
| `node dist/worker.js` | Started, drained, and shut down on SIGTERM after finishing the batch in flight |

Two defects surfaced from running them, both of which would have failed only in a container:

- Workspace packages resolved to TypeScript source, which plain `node` cannot load. They
  now export `development` (source) and `default` (build) conditions, and every runtime
  that should read source asks for it by name. See "Source or Build" in `CONTRIBUTING.md`.
- `pnpm exec node …` as a container command puts the package manager at PID 1, so the
  orchestrator's SIGTERM never reaches Node and the Worker's shutdown handler never runs.
  The `CMD`s exec `node` directly.

Remaining:

- Actually build the three images, which is where the layer copy, `pnpm install
  --frozen-lockfile` under `node:22-slim`, and dev-dependency pruning get tested.
- Infrastructure as code for those, PostgreSQL, and the telemetry resources.
- A rollback procedure — the baseline requires only the minimum one; automation beyond it
  is Production Hardening.
- CI already runs the documentation and route checks; extend it to build and deploy.

A smaller thing to fix while doing it: `tsc --build` emits the test files into `dist/`, so
the images carry compiled test code. Harmless, but it is dead weight in a production image
and separating the build and typecheck configurations is the fix.

---

## Stage E — Pre-launch verification

Everything here is verification of work already done, and none of it should be the first
time a thing is tried.

- **Run the acceptance suite against the deployed system**, not only against a local
  database. It starts from an empty schema and drives HTTP, so it transfers with little
  change — that was a deliberate property of how it was written.
- Security review, with attention to the boundaries this build already defends: tenant
  isolation returning `404` rather than `403`, invitation tokens hashed at rest and never
  logged, approved Memory immutable at the database and not only in the UI.
- Load characteristics, particularly Outbox drain rate against expected Work completion
  volume.
- A restore drill from a real backup into a real environment.
- Confirm the audit records what the launch expects it to, on the deployed system.

---

## Sequencing

```text
A — reachable by a real person
      ↓                    (A2 and A3 are independent of each other)
B — operational baseline
      ↓                    (B4 runbooks 5 and 6 need C and D to exist)
C — data durability  ─┐
                      ├→  E — pre-launch verification  →  launch
D — deployment       ─┘
```

A before B is deliberate: telemetry designed around an application nobody can sign into
measures the wrong things. C and D are largely parallel, and both must precede the runbooks
that exercise them.

**C1 is done.** It was the item that could start immediately and blocked the most
downstream work, because every day of production data would have made it more expensive.
With the migration path settled, Stage A is the next thing to start, and C2 (backup and
recovery) is the remaining half of Stage C.

---

## Not on this path

These are named so their absence is a decision rather than an oversight.

**Production Hardening (SHOULD)** — distributed traces, reconciliation dashboards,
automated restore validation, security alert routing, Organization containment, deployment
automation beyond rollback, the five additional runbooks. The architecture permits deferral
but requires "a named owner and an explicit trigger for implementation, such as traffic
volume, incident history, or customer requirement." Deferring these without recording an
owner is not deferral; it is forgetting.

**Reserved permissions** — `memory.record_secretary_contribution` and
`authorization.read_audit` remain Reserved. Neither is required by any acceptance criterion.
`authorization.read_audit` is worth revisiting when an operator first needs to read the
audit trail without database access; note that `persistence-and-data-model.md` currently
requires the audit repository to expose Insert only, so promoting it means resolving that
first.

**Platform-operator identity** — deferred by ADR-0017 and ADR-0019. Until it exists there is
no way to suspend an Organization against its Owner's wishes, and no in-product recovery for
an Organization that loses access to its only Owner. Both are acceptable for a first
release to known customers and are not acceptable indefinitely.

**Public API, SDK, `docs/api/`** — Phase 5, per the README and ADR-0014. The API is internal
to the MVP application; no external compatibility commitment exists.

---

## Open decisions requiring an ADR

| Decision | Why it needs one |
|---|---|
| Restricted administrative diagnostics | Same: a new permission is a scope change |
| The status of ADRs 0017, 0018, and 0019 | They promote permissions that are catalogued and implemented, and each still reads `Proposed`. ADR-0010's rule is that promotion requires an **accepted** ADR *and* a scope-document update — so either the status is stale or the implementation went ahead of the decision. Only the architecture owner can say which |
| RPO and RTO | Named figures the baseline requires an owner to approve |
| Clerk profile webhook | In scope or out; `.env.example` currently implies in |

---

## Related documents

- [MVP Product Definition](../product/mvp.md) — the release acceptance criteria this build satisfies
- [Product Roadmap](../product/roadmap.md) — capability sequencing across phases
- [Observability and Operations](../architecture/observability-and-operations.md) — the production baseline and runbook requirements
- [ADR-0003: Select the MVP Observability Stack](../adr/0003-select-mvp-observability-stack.md)
- [ADR-0010: Classify Blueprint Scope and Implementation Authority](../adr/0010-classify-blueprint-scope-and-implementation-authority.md)
- [ADR-0013: Bind Clerk as an Authentication Provider](../adr/0013-bind-clerk-as-authentication-provider.md)
- [ADR-0015: Keep the Documented DDL Authoritative](../adr/0015-use-documented-ddl-and-direct-sql-for-persistence.md)
- [ADR-0016: Bind Anthropic as the Model Provider](../adr/0016-bind-anthropic-as-the-model-provider.md)
