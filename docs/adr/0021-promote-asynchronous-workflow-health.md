# ADR-0021: Promote asynchronous workflow health

**Status:** Accepted
**Date:** 2026-08-04
**Blueprint Version:** 0.2.0
**Decision Owner:** Platform Operations
**Review Trigger:** when the `organization_workflow_health` projection is built, when a second workflow type is added, or when the health query's cost becomes visible in database metrics

---

## Context

The MVP Production Baseline requires, as item 8, "HTTP and Worker liveness/readiness,
**asynchronous workflow health**, and restricted administrative diagnostics". The four
process probes are built. Asynchronous workflow health is not, and its absence leaves a
specific hole that the probes themselves make visible.

`observability-and-operations.md` states it directly:

> Worker readiness does not prove progress. A Worker can be ready yet make no useful
> progress because of poison events, lock contention, repeated retries, or per-Organization
> ordering blocks.

So today an operator can see that both processes are alive and ready, and cannot see that
nothing has moved for an hour. The Outbox can be backed up, a consumer can be failing every
delivery, dead letters can be accumulating, and Memory generation can be exhausting its
retries — with every probe green. Those are the conditions the alerts of baseline item 11
must fire on, and none of them is observable.

The signals themselves already exist as durable facts. `outbox_messages`,
`processed_events`, `dead_letter_events`, and `memory_generation_operations` each carry a
status and timestamps, and each carries `organization_id`. What is missing is a permission,
a route, and a definition of what the facts mean together.

---

## Decision

Promote one permission from unlisted to catalogued:

```text
operations.read_workflow_health
```

It is granted to `OrganizationOwner` and `OrganizationAdmin`, matching the `events.*`
recovery family it sits beside — the same people who act on a stalled workflow are the ones
who need to see it.

One route, per ADR-0014's one-route-one-permission rule:

```text
GET /admin/workflow-health
```

It is an ordinary Organization-scoped route. It requires `X-Organization-Id`, an Active
Membership, and the permission; it claims no exemption of any kind. That matters because
the answer is Organization-specific and the architecture is explicit that "Global metrics
can remain healthy while one Organization is permanently blocked" — a route that reported
across tenants would be the isolation violation the same document lists as an alertable
security event.

### What it reports

Four workflow types, each with a status, derived live from the durable facts:

| Workflow type | Derived from |
|---|---|
| `OutboxPublication` | `outbox_messages` not yet `Published` |
| `ConsumerDelivery` | `processed_events` not yet `Processed` or `Skipped` |
| `DeadLetter` | `dead_letter_events` not `Resolved` or `Skipped` |
| `MemoryGeneration` | `memory_generation_operations` not `Generated`, `Failed`, or `Abandoned` |

Each reports a bounded status — `Healthy`, `Degraded`, `Critical`, or `Unknown` — plus the
count of pending items and the age of the oldest. Age rather than count is what determines
status, because the architecture requires it:

> A quiet Organization MUST NOT become Degraded only because it has no recent success.
> Pending age, unresolved failure, ordering state, and projection freshness determine
> health.

An Organization with a hundred items processed promptly is Healthy. An Organization with
one item stuck for two hours is not, and a count-based rule would report the opposite of
both.

### What it does not do

It does not affect readiness. The architecture: queue lag, terminal failure, and lack of
progress "MUST NOT directly change HTTP load-balancer readiness". Taking the API out of
rotation because the Outbox is behind would deny reads and writes that are still perfectly
safe.

---

## The smallest useful vertical slice

ADR-0010 requires promotion to identify one, and this ADR must be equally clear about what
the slice leaves out, because one omission is a documented MUST.

**Left out: the `organization_workflow_health` projection.** The architecture requires that
"The MVP MUST maintain a rebuildable PostgreSQL projection for Organization-specific
asynchronous workflow health", updated after each committed transition and reconciled on a
schedule, with its own freshness that can go `Stale`. This slice derives health live from
the source tables instead.

That is a smaller thing, and it is deliberately first rather than instead:

- **Live derivation is correct now and cheap now.** The source tables are indexed by
  `organization_id` and the queries are aggregates over small working sets. At MVP volumes
  a projection would be an optimisation of a query nobody has measured.
- **A projection cannot be designed before its query exists.** The projection's whole
  purpose is to precompute what this route asks for; building it first would be guessing at
  the shape, and a projection with the wrong columns is worse than none because it looks
  authoritative.
- **The projection adds a failure mode this slice does not have.** A projection can be
  stale, which is why the architecture requires freshness tracking and says that "When the
  projection becomes Stale, operators must not infer that Organizations are Healthy." A
  live query is either answered or not answered.

So **baseline item 8 remains Partial after this ADR**, and `release-readiness.md` says so.
This slice makes the workflows observable; it does not deliver the projection, and the
restricted administrative diagnostic surface is untouched.

### Also left out: administrative diagnostics

A different surface with different rules — it correlates evidence across components for
incident investigation, requires an explicit operational role, and must audit privileged
and cross-Organization access separately. Bundling it here would have put two authorization
shapes behind one permission.

---

## Consequences

An operator can now see that committed work is not progressing, per Organization and per
workflow type, which is the observable baseline item 11's alerts will attach to.

The health query runs against the source tables. If it becomes expensive — visible as
database load rather than guessed at — that is the trigger to build the projection, and the
Review Trigger above says so.

Reads are audited like every other routed permission, so a privileged operational read
leaves the same trace as a privileged operational write. The architecture requires exactly
this for the diagnostic surface and it costs nothing to apply here.

`Unknown` is a real outcome and is reported as one. A workflow type whose query fails is
not Healthy, and the route says `Unknown` rather than omitting it — "Missing evidence MUST
NOT be presented as `Healthy`."

---

## Alternatives considered

**Reuse `events.inspect_failed`.** It already exists, is granted to the same roles, and
concerns failed events. Rejected because ADR-0014 gives each permission exactly one route,
and because the permission is named for inspecting failures while most of what this reports
is healthy work in flight. The name would have had to lie for the shortcut to work.

**Report health without authorization, on the probe port.** The probes are already
unauthenticated and already serve operational data. Rejected because this answer is
Organization-scoped: an unauthenticated endpoint returning per-Organization state is a
tenant-isolation break, and the architecture keeps Organization identifiers out of exactly
the surfaces that have no authorization to scope them.

**Wait and build the projection first.** Rejected on the ordering argument above — and
because the gap being closed is that nobody can see a stalled workflow at all. That is
worth closing before it is worth optimising.
