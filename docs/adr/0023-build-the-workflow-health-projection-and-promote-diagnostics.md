# ADR-0023: Build the workflow-health projection and promote administrative diagnostics

**Status:** Accepted
**Date:** 2026-08-05
**Blueprint Version:** 0.2.0
**Decision Owner:** Platform Operations
**Review Trigger:** when a cross-Organization operator identity is designed, when per-transition projection updates are needed because reconciliation cannot keep up, or when a fifth workflow type appears

---

## Context

Baseline item 8 has four parts — HTTP and Worker liveness/readiness, asynchronous workflow
health, and restricted administrative diagnostics. The probes are built.
[ADR-0021](0021-promote-asynchronous-workflow-health.md) built workflow health as a live
query and said plainly what it left out:

> **Left out: the `organization_workflow_health` projection.** … So **baseline item 8
> remains Partial after this ADR**, and `release-readiness.md` says so.

Both omissions are documented MUSTs. This ADR closes them, and it has to resolve a
vocabulary conflict to do it.

### The conflict ADR-0021 created without noticing

`observability-and-operations.md` defines the projection's status values:

```text
Healthy   Degraded   Blocked   Stale   NoData
```

ADR-0021 defined a different set for the live query:

```text
Healthy   Degraded   Critical   Unknown
```

`Critical` and `Blocked` are the same condition under two names. `Unknown` is a real
outcome the architecture names elsewhere — "`Unknown` and `Stale` are explicit outcomes" —
but it is absent from the projection's list, and `Stale` and `NoData` are absent from
ADR-0021's.

By document rank an Accepted ADR outranks an architecture document, so `Critical` would
win. That reasoning proves too much: it would let any ADR rename architecture vocabulary by
accident, which is what happened. ADR-0021 was not deciding against the architecture — it
never addressed the projection's status set at all. So this is an unresolved conflict rather
than a resolved one, and this is where it gets resolved.

---

## Decision

### 1. One status vocabulary, the architecture's, plus `Unknown`

```text
Healthy   Degraded   Blocked   Stale   NoData   Unknown
```

`Critical` is renamed to `Blocked`. Six values, each meaning exactly one thing:

| Status | Means |
|---|---|
| `Healthy` | No overdue pending item and no unresolved terminal failure |
| `Degraded` | Warning-age pending work, or repeated recoverable failure |
| `Blocked` | Terminal failure, ordering block, or hard-age threshold prevents progress |
| `Stale` | The projection has not refreshed within its required interval |
| `NoData` | The Organization has no observation for that workflow |
| `Unknown` | The question could not be answered at all |

The architecture's set wins over ADR-0021's because item 11's alerts are written against it
— "a new **Blocked** transition creates a High alert", "any **Stale** projection beyond two
refresh intervals creates a High alert" — and the metric series is
`organization_workflow_health_transition_total{workflow_type,from_status,to_status}`.
Keeping `Critical` would force every alert rule to translate a name, and a translation layer
between an alert and the status it fires on is where alerts silently stop firing.

`Unknown` is kept because the other five cannot express it. `Stale` says the projection is
behind; `NoData` says there is nothing to report; neither says *the query did not run*.
Collapsing that into any of them would present a failure to measure as a measurement.

This is a breaking rename of a response field shipped one day ago, with no external
consumer. Renaming it now costs a line; leaving two names for one condition costs every
future reader.

### 2. The projection is built, and the route reads it

`organization_workflow_health`, keyed `(organization_id, workflow_type)`, with the columns
the architecture lists — including `source_high_water_mark`, `projection_version`, and
`updated_at`, which are what make freshness answerable.

`GET /admin/workflow-health` now reads the projection rather than deriving live, and reports
its freshness alongside the statuses.

**It does not fall back to a live query when the projection is stale.** That is the whole
point of the field. The architecture: "When the projection becomes `Stale`, operators must
not infer that Organizations are `Healthy`." A fallback would hide exactly the failure the
freshness field exists to expose, and would do it most reliably at the moment it mattered
most — an operator would see fresh-looking numbers and never learn the projection had
stopped.

### 3. Reconciliation is the update path, and it is the rebuild

The architecture says the projection "SHOULD update after each committed workflow
transition and MUST be reconciled on a schedule". This slice implements the MUST and not
the SHOULD.

Reconciliation recomputes every row for an Organization from the source tables and upserts
the result. That single mechanism satisfies three separate requirements at once:

- It is the **scheduled reconciliation**, run from the Worker loop.
- It is the **rebuild**: "The projection MUST be rebuildable. Rebuilding or deleting it does
  not change the underlying business or delivery truth." Deleting every row and running a
  reconcile reproduces the projection exactly, and there is a test that does precisely that.
- It is the **drift detector**. Reconciliation "MUST detect: pending source records absent
  from the health projection, terminal failures reported as Healthy, a source high-water
  mark that stops advancing, duplicate rows or cross-Organization references, projection
  freshness beyond the Stale threshold."

That last one deserves stating carefully, because a recompute-and-upsert cannot *drift* —
so a check that merely re-derived the answer and compared it to itself would be a check that
cannot fail. Instead, **reconciliation reports what it changed**: rows inserted, rows whose
status changed, and rows deleted because their Organization no longer exists. A non-zero
correction count is the finding. If the projection was already correct, the reconcile
corrects nothing and says so.

Per-transition updates are deliberately not built. They are a `SHOULD`, they double the
number of places that write the projection, and the reconcile is an aggregate over indexed
columns at MVP volumes. The Review Trigger above names the condition that would change
that: reconciliation failing to keep up, observed rather than assumed.

### 4. Administrative diagnostics, promoted

One permission:

```text
operations.read_diagnostics
```

Routed as `GET /admin/diagnostics`. Granted to `OrganizationOwner` **only** — not
`OrganizationAdmin`, and this is the narrowest the MVP can express.

The architecture requires the diagnostic surface to "require an authenticated operator with
an explicit operational role". The MVP models four roles and none of them is an operational
role; introducing one is an identity, assignment, and role-matrix change, not a permission
grant. Owner-only is the honest approximation: it is the narrowest existing role, it is
already where the asymmetric recovery authority sits — `events.replay_domain_consumer` is
Owner-only for the same reason — and it does not pretend a role exists that does not.

The surface correlates evidence across components in one response, which is what
distinguishes it from workflow health:

| Section | Answers |
|---|---|
| `projection` | Is the health projection fresh, and how far behind is it? |
| `workflows` | Per workflow type: status, pending, oldest age, failures |
| `outbox` | Pending, failed, claimed-but-expired, oldest ages |
| `deliveries` | Blocked ordering keys, dead letters by status |
| `generation` | Memory-generation operations by status, retry exhaustion |
| `pauses` | What is administratively paused, since when, and why |
| `schema` | The applied migration the process is running against |

Every rule the architecture attaches to it is enforced rather than assumed:

- **Organization scope, default-deny cross-Organization.** It is an ordinary
  Organization-scoped route. There is no parameter that selects another Organization,
  because there is no principal who could be authorized for one.
- **No raw error text, prompts, or business content.** Failures are reported as counts by
  bounded `errorCode`, never as messages. `describeError` is not used here at all — the
  diagnostic response is assembled from columns, not from exceptions.
- **Bounded reason codes rather than unbounded error text**, throughout.
- **Audited.** `GET` is audited for the `operations.*` family (ADR-0022), so a privileged
  diagnostic read leaves the same trace as a privileged write.
- **Time-bounded and paginated.** A `since` window, clamped to 7 days, and every list capped.
- **Not a probe.** It is on the authenticated API, not the probe port, and cannot be
  configured as a load-balancer or restart check.

---

## The smallest useful vertical slice

**Left out: cross-Organization diagnostics.** The architecture describes a Platform Operator
querying across Organizations "through a restricted Operations Application Service", with "a
typed capability, operator identity, reason, and durable audit". Every one of those depends
on the cross-Organization principal `authorization.md` defers, for the third ADR running.
Building the query without the identity would mean inventing the authorization, which is the
one thing the deferral exists to prevent.

**Left out: per-transition projection updates**, for the reasons above.

**Left out: the projection's metric series.** `organization_workflow_health_organizations`,
`_projection_age_seconds`, and `_transition_total` are metrics, and there is no metric
backend — that is baseline items 2, 5, and 6, and item 11's alerts sit on top of them. What
this ADR delivers is the durable state those series will be computed from, with the status
names they will be labelled by. It does not deliver the series.

**Left out: `Projection` and `Reconciliation` as workflow types.** The architecture lists
four — `OutboxRelay`, `MemoryGeneration`, `Projection`, `Reconciliation` — and introduces
them with "MVP workflow types **include**", an open list. This build's four are
`OutboxPublication` (the architecture's `OutboxRelay`, under ADR-0021's name),
`ConsumerDelivery`, `DeadLetter`, and `MemoryGeneration`. Each maps to exactly one durable
table. `Projection` and `Reconciliation` are not workflows here: the notification projection
has no claim loop of its own, and reconciliation is this ADR's own scheduled job rather than
tenant work that can back up. A status for a workflow that does not exist would always read
`NoData`, which is noise that looks like information.

With those out, **baseline item 8 is complete**.

---

## Consequences

Workflow health is now answered from a projection whose freshness is part of the answer, so
"the numbers look fine" and "the numbers are current" are distinguishable. They were not
before: a live query is always current, which sounds better and is why the failure mode it
lacks — nothing at all — was invisible.

Health answers can be up to one refresh interval old. That is the trade the architecture
asks for, and the freshness field is what makes it safe: an operator can see the age rather
than assume it.

Reconciliation reports its corrections, so a projection that keeps needing them is visible
as a defect in whatever should have kept it current. If per-transition updates are added
later, a correction count that stays at zero is the evidence they work.

`Critical` no longer exists in any response. Item 11's alert rules can be written against
the architecture's names directly.

The diagnostic surface is Owner-only and Organization-scoped, so it is genuinely restricted
— and it is honest about being a narrower thing than the architecture describes, rather than
claiming an operational role the MVP does not have.

---

## Alternatives considered

**Keep the live query and add the projection beside it, with the route choosing.** Rejected:
two sources for one answer, and the choosing logic would be where they diverge. Worse, the
natural rule — "use the projection unless it is stale" — is precisely the fallback that
hides staleness.

**Keep `Critical` and map it to `Blocked` at the metric boundary.** Rejected above. The
mapping layer is invisible, untested by anything that fires, and exactly where an alert stops
matching without anyone noticing.

**Grant `operations.read_diagnostics` to Admin as well, like the rest of the family.**
Rejected because the architecture asks for "an explicit operational role" for this surface
specifically, and it is the only surface in the family it asks that of. Owner-only is the
narrowest the MVP can express; widening it later needs only a grant, while narrowing it
after Admins depend on it needs a migration of expectations.

**Update the projection inside each committed transition.** Rejected as the *first* step,
not on principle. It is a `SHOULD`, and the reconcile has to exist regardless — the
architecture requires it — so building the optional half first would mean shipping the
mechanism that can drift before the mechanism that detects drift.
