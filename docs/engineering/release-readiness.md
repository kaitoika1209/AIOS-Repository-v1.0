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
| Test suite | 649 passing (types 11, domain 170, application 190, persistence 66, api 222) |
| Routed permissions enforced | 43 / 43 |
| Documentation checks | 58 files |
| Accepted and proposed ADRs | 20 |

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
| 1 | Structured JSON logs with a stable base envelope and redaction | **Absent** — `console.log` only |
| 2 | Bounded telemetry exporters with queue limits, timeouts, retry ceilings, loss counters, shutdown deadlines | **Absent** |
| 3 | Server-owned request and workflow correlation | **Partial** — `correlation_id` on Outbox and audit rows; not request-scoped end to end |
| 4 | Error capture for unhandled application and Worker failures | **Partial** — errors are mapped to status codes; nothing captures or reports them |
| 5 | RED metrics for HTTP traffic | **Absent** |
| 6 | PostgreSQL, Outbox, Worker, queue-age, and Work-to-Memory workflow metrics | **Absent** |
| 7 | Durable audit for Human-authoritative transitions and privileged operational actions | **Done** — `authorization_audit_records`, edge and use-case halves |
| 8 | HTTP and Worker liveness/readiness, asynchronous workflow health, restricted admin diagnostics | **Partial** — all four process probes serve; workflow health and admin diagnostics remain |
| 9 | Bounded retry, idempotency, retry-exhaustion visibility, dead-letter handling, typed Operations commands for Worker pause/resume, replay, dead-letter retry/skip | **Partial** — everything except Worker pause/resume |
| 10 | Continuous WAL archiving, base backup ≥ every 24h, 14-day PITR, monthly verified restore test, approved RPO and RTO | **Absent** |
| 11 | Actionable alerts for database unavailability, authoritative-write failure, Outbox or Worker stoppage, Memory-generation failure, Organization-isolation violation | **Absent** |
| 12 | The six MVP runbooks | **Absent** |
| 13 | Separate Worker process | **Done** — `apps/api/src/worker.ts`; `chooseWorkerMode` refuses in-process draining outside development |

Two done, four partial, seven absent. None of it is domain work.

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

### A2. More than one Organization

`apps/web/src/lib/api.ts` pins a single `ORGANIZATION_ID` from an environment variable.
`mvp.md` states that "A person may belong to more than one Organization", and the API
already supports it fully — `X-Organization-Id` selects among the caller's Memberships and
every route is scoped by it. The gap is entirely in the client.

- Organization selection driven by the caller's Memberships.
- A create-Organization flow in the UI. `POST /organizations` exists and has no UI.

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
configuration remain Infrastructure Layer details." Build the ports first; bind them to
CloudWatch afterwards.

- A logging port emitting the documented base envelope, with redaction.
- Request-scoped correlation established at the edge and carried into the Outbox, the
  Worker, and the audit — the interceptor and `PostgresOutbox` already mint identifiers,
  so this is mostly wiring rather than new machinery.
- Unhandled-failure capture in both the HTTP process and the Worker.

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

Remaining:

- Asynchronous workflow health: Outbox depth, queue age, dead-letter count. Derived from
  durable facts and scoped by Organization, so it belongs on the authenticated API rather
  than the probe port.
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

### C1. Schema migration — **done**

Resolved by [ADR-0020](../adr/0020-adopt-forward-only-migrations-checked-against-the-documented-ddl.md).

Migrations are hand-written, numbered, and forward-only, in `migrations/`. Each is applied
inside one transaction with its ledger row. `pnpm --filter @aios/api migrate` is the
deployment command; `--status` reports without changing anything.

The property that keeps ADR-0015 intact is
`packages/persistence/src/migrations.test.ts`: it builds one schema from the migration
chain and one from the documented DDL, then compares columns, constraints, and indexes.
The documents remain the authority on what the schema is; the migrations on how an existing
database reaches it, and neither can drift because a divergent pair fails the check in
either direction.

Forward-only, with restore as the rollback path — the "Deployment rollback" runbook must
say that a released migration is not un-released.

The "Migration failure" runbook, listed under Production Hardening SHOULD, now has
something to describe.

### C2. Backup and recovery (item 10)

Continuous WAL archiving, a physical base backup at least every 24 hours, a 14-day PITR
window, a monthly verified restore test, and approved RPO and RTO figures. The RPO and RTO
need an owner's decision; the rest is infrastructure configuration plus a scheduled drill.

The restore test is the part that tends to be deferred and is the only one that proves the
other four.

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
