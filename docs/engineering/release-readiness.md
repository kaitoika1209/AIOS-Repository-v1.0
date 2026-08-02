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
| Test suite | 640 passing (types 11, domain 170, application 190, persistence 57, api 222) |
| Routed permissions enforced | 43 / 43 |
| Documentation checks | 56 files |
| Accepted and proposed ADRs | 19 |

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
| 8 | HTTP and Worker liveness/readiness, asynchronous workflow health, restricted admin diagnostics | **Absent** — no health endpoints of any kind |
| 9 | Bounded retry, idempotency, retry-exhaustion visibility, dead-letter handling, typed Operations commands for Worker pause/resume, replay, dead-letter retry/skip | **Partial** — everything except Worker pause/resume |
| 10 | Continuous WAL archiving, base backup ≥ every 24h, 14-day PITR, monthly verified restore test, approved RPO and RTO | **Absent** |
| 11 | Actionable alerts for database unavailability, authoritative-write failure, Outbox or Worker stoppage, Memory-generation failure, Organization-isolation violation | **Absent** |
| 12 | The six MVP runbooks | **Absent** |
| 13 | Separate Worker process | **Absent** — the Outbox worker runs in-process (`buildDevApp`) |

One done, three partial, nine absent. None of it is domain work.

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

- Run `evaluate-generation` against the live API and record the result.
- Establish cost per generation and the provider rate limits that apply.
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

- Separate liveness and readiness for the HTTP process and for the Worker.
- Asynchronous workflow health: Outbox depth, queue age, dead-letter count.
- RED metrics for HTTP; the PostgreSQL, Outbox, Worker, and Work-to-Memory metrics the
  baseline names.
- Restricted administrative diagnostics — note that these need a permission, and adding one
  is an ADR-0010 promotion, not an editing decision.

### B3. Worker as its own process, with pause and resume (items 9, 13)

`startOutboxWorker` runs inside the API process today, which is correct for development and
wrong for production. The baseline also requires typed Operations commands for Worker
pause and resume; the replay and dead-letter commands are already built and routed.

Pause and resume need permissions and routes, so this carries an ADR under ADR-0010 and
ADR-0014 — the same promotion path the `events.*` recovery commands followed.

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

### C1. Schema migration has no path

This is the item most easily missed, because everything works today.

`scripts/extract_schema.py` reads the DDL out of `persistence-and-data-model.md` and emits
`build/schema.sql`, which the test suites apply to a fresh schema. That is exactly right for
ADR-0015's "documented DDL stays authoritative", and it works because every database it has
ever been applied to was empty.

The moment real data exists, a schema change needs a migration, and there is **no migration
tooling, no migration history, and no ADR selecting an approach**. The generated
`schema.sql` cannot help: it describes the destination, not the path.

This needs a decision before the first production write, not after. Options worth
evaluating are a conventional migration tool, or generated migrations diffed against the
documented DDL so the documents stay authoritative — the second preserves ADR-0015's
property and is more work. Either way it is an ADR.

The "Migration failure" runbook is listed under Production Hardening SHOULD, which is
consistent only if migrations exist to fail.

### C2. Backup and recovery (item 10)

Continuous WAL archiving, a physical base backup at least every 24 hours, a 14-day PITR
window, a monthly verified restore test, and approved RPO and RTO figures. The RPO and RTO
need an owner's decision; the rest is infrastructure configuration plus a scheduled drill.

The restore test is the part that tends to be deferred and is the only one that proves the
other four.

---

## Stage D — Deployment

The repository has no Dockerfile, no infrastructure-as-code, and no deployment pipeline.
ADR-0003 names the target: AWS, region `ap-northeast-1`, CloudWatch Logs and Metrics,
CloudWatch Alarms, SNS to verified operator email, CloudTrail for telemetry control-plane
changes.

- Build artifacts for the API process, the Worker process, and the web application.
- Infrastructure as code for those, PostgreSQL, and the telemetry resources.
- A rollback procedure — the baseline requires only the minimum one; automation beyond it
  is Production Hardening.
- CI already runs the documentation and route checks; extend it to build and deploy.

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

The single item that can start immediately and blocks the most downstream work is **C1,
the migration decision** — because every day of production data makes it more expensive,
and because it is an ADR rather than an implementation, so it can proceed alongside
Stage A.

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
| Schema migration approach | ADR-0015 makes the documented DDL authoritative; a migration tool introduces a second source unless the relationship is decided |
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
