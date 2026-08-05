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
| Test suite | 731 passing (types 11, domain 170, application 227, persistence 67, api 256) |
| Routed permissions enforced | 44 / 44 |
| Documentation checks | 60 files |
| Accepted and proposed ADRs | 21 |

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
| 2 | Bounded telemetry exporters with queue limits, timeouts, retry ceilings, loss counters, shutdown deadlines | **Absent** |
| 3 | Server-owned request and workflow correlation | **Done** — one identifier spans the response, the audit rows, and the Outbox |
| 4 | Error capture for unhandled application and Worker failures | **Done** — `uncaughtException` and `unhandledRejection` captured in both processes |
| 5 | RED metrics for HTTP traffic | **Absent** |
| 6 | PostgreSQL, Outbox, Worker, queue-age, and Work-to-Memory workflow metrics | **Absent** |
| 7 | Durable audit for Human-authoritative transitions and privileged operational actions | **Done** — `authorization_audit_records`, edge and use-case halves |
| 8 | HTTP and Worker liveness/readiness, asynchronous workflow health, restricted admin diagnostics | **Partial** — four process probes and asynchronous workflow health serve; the health projection and admin diagnostics remain |
| 9 | Bounded retry, idempotency, retry-exhaustion visibility, dead-letter handling, typed Operations commands for Worker pause/resume, replay, dead-letter retry/skip | **Partial** — everything except Worker pause/resume |
| 10 | Continuous WAL archiving, base backup ≥ every 24h, 14-day PITR, monthly verified restore test, approved RPO and RTO | **Absent** — the restore *procedure* is proven by an executable drill; no production storage, schedule, or retention exists |
| 11 | Actionable alerts for database unavailability, authoritative-write failure, Outbox or Worker stoppage, Memory-generation failure, Organization-isolation violation | **Absent** |
| 12 | The six MVP runbooks | **Absent** |
| 13 | Separate Worker process | **Done** — `apps/api/src/worker.ts`; `chooseWorkerMode` refuses in-process draining outside development |

Five done, three partial, five absent. None of it is domain work.

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

Remaining:

- The `organization_workflow_health` projection. The architecture requires a rebuildable
  projection with its own freshness; health is derived live from the source tables instead.
  ADR-0021 records why live derivation came first — a projection cannot be designed before
  the query it precomputes exists — and that this is why item 8 is still Partial.
- Restricted administrative diagnostics. A different surface with different rules: it
  correlates evidence across components, needs an explicit operational role, and audits
  cross-Organization access separately.
- RED metrics for HTTP; the PostgreSQL, Outbox, Worker, and Work-to-Memory metrics the
  baseline names.
- Restricted administrative diagnostics — note that these need a permission, and adding one
  is an ADR-0010 promotion, not an editing decision.
- Worker readiness cannot yet report "administratively paused", because pause and resume do
  not exist. That is B3's remaining half, and the probe does not pretend otherwise.

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

**Item 9's remaining half is pause and resume**, which need permissions and routes, so that
part carries an ADR under ADR-0010 and ADR-0014 — the same promotion path the `events.*`
recovery commands followed. Until it exists, stopping the Worker means stopping the process.

### B4. Alerts and runbooks (items 11, 12)

Six runbooks, each of which the architecture requires to identify "detection signals, safe
containment, prohibited actions, recovery steps, validation, required authorization, and
audit evidence":

1. Application or database unavailable
2. Outbox or Worker processing stalled
3. Memory generation failure or retry exhaustion
4. Organization isolation or Human authority violation
5. Deployment rollback
6. PostgreSQL backup or WAL failure and point-in-time recovery

A runbook that has never been executed is a draft. Each should be exercised once against a
staging environment before launch, which is what makes runbooks 5 and 6 depend on Stage C
and Stage D existing first.

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
| Worker pause and resume | New permissions and routes — ADR-0010 promotion and an ADR-0014 route entry |
| Restricted administrative diagnostics | Same: a new permission is a scope change |
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
