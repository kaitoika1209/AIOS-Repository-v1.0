# ADR-0024: Bound metrics at the call site, and the export queue at the process edge

**Status:** Accepted
**Date:** 2026-08-05
**Blueprint Version:** 0.2.0
**Decision Owner:** Platform Operations
**Review Trigger:** when the CloudWatch transport is built, when the catalogue approaches ADR-0003's hundred-series budget, or when a second signal (traces, logs) joins the same exporter

---

## Context

Baseline items 2, 5, and 6 are three requirements with one shape:

- item 2 — "bounded telemetry exporters with queue limits, timeouts, retry ceilings, loss counters, shutdown deadlines"
- item 5 — "RED metrics for HTTP traffic"
- item 6 — "PostgreSQL, Outbox, Worker, queue-age, and Work-to-Memory workflow metrics"

[ADR-0003](0003-select-mvp-observability-stack.md) already chose the destination — CloudWatch —
and attached two limits that decide almost everything about how the metrics are
produced:

> no more than 100 active AIOS custom metric time series without review
>
> no Organization, Aggregate, request, trace, or principal identifiers in metric
> dimensions

The second is not a style rule. ADR-0003 says why:

> This permits provider-managed metric rollups to exist beyond the active 30-day
> AIOS query window without becoming a hidden tenant-data retention path.

Rollups outlive the query window. An identifier that reaches a dimension is
therefore not deletable by anything AIOS controls — it is a tenant-data retention
path that no deletion request can reach, created by a line of instrumentation
nobody thought was a data-handling decision.

---

## Decision

### 1. The rules are enforced in code, not in review

A closed **catalogue** of metric names and a closed **allowlist** of dimension
names, both checked on every sample. A name outside either is refused.

An allowlist rather than a denylist of forbidden names, because a denylist is a
list of the mistakes somebody already made — `organizationId` would be on it and
`org_id` would not. Every allowed name is server-derived and bounded by
construction: a route template comes from the route table, an outcome class has
five values, a workflow type has four.

Values are bounded too. A bounded name carrying an unbounded value is still
unbounded, and the realistic way one arrives is a route template that failed to
match and fell back to a request path.

### 2. A refused sample is dropped, never thrown

The check runs at the call site, and failing it drops the sample with a loud
`ERROR` log naming the reason code. It does not throw.

That asymmetry is deliberate. Telemetry must not be able to fail a request —
"drop additional diagnostic detail rather than block an authoritative transaction
or Worker lease" — so a metric bug must be survivable. But a silent drop is how a
metric goes missing for a quarter, so the drop is as loud as an exception without
being one.

**Export limits are the exception and do throw**, at startup. "Limits are
configuration validated at startup. A missing or unlimited value is invalid in
production." That runs once, before the process serves anything, and a process
configured to buffer telemetry without limit should not start.

### 3. RED is middleware, not an interceptor

This was wrong twice, and both times it took issuing real requests to see it.

**An interceptor cannot see the status.** Nest runs interceptors *before*
exception filters, so on the error path `response.statusCode` is still the
default `200`. Every refusal and every failure was recorded as `2xx` — the errors
half of RED silently zero, which is worse than no metric because it looks like
good news.

**An interceptor cannot see a guard's refusal at all.** Guards run before
interceptors, so a request rejected for failed authentication or a missing
Membership never reaches one. Those are the most security-relevant denials there
are.

Middleware runs before guards, and `response.on("finish")` fires after the filter
has written the status. It sees every request exactly once, with its real
outcome, including the ones nothing else in the pipeline observes.

### 4. The exporter is bounded at every edge, and reports on itself

A fixed queue with a non-blocking admission policy, a per-request deadline, a
retry ceiling with jittered backoff, and a shutdown deadline. On saturation the
queue evicts by priority and **does not grow** — a higher priority changes what
is dropped, never how much is held. There is no second overflow queue, which the
architecture forbids by name.

The failure this prevents is specific: an unbounded exporter does not merely lose
telemetry when its backend is slow, it grows until the process that was working
fine dies of it. Observing the system becomes what takes the system down, during
the incident the telemetry was meant to explain.

The exporter publishes its own `telemetry_export_*` series. Without them a
saturated exporter is invisible to exactly the system that would have reported
it.

### 5. Gauges are sampled, and carry no Organization

The item 6 levels — Outbox depth, queue age, consumer backlog, generation
backlog, pool saturation — are sampled on a schedule rather than incremented at a
call site, because each is a *level* rather than an event. A counter held in
memory would drift from the table the first time a process restarted or a second
replica appeared.

None carries an Organization dimension. The architecture states the split
directly: "Metric backends receive only bounded aggregate status counts;
Organization identifiers remain in PostgreSQL, logs, traces, and authorized
diagnostic results." The per-Organization answer is `GET /admin/workflow-health`,
which is authorized and audited; the metric backend gets the deployment-wide sum.

---

## The smallest useful vertical slice

**Left out: the CloudWatch transport.** ADR-0003 chose it and it is not built —
reaching it needs an AWS SDK, credentials, and a Region, none of which this
repository has. `METRICS_SINK=cloudwatch` is accepted and *says so in the startup
log* rather than silently discarding, because an operator who configured it and
got nothing deserves to be told why rather than discover it from an empty
dashboard mid-incident.

What is built is the part that had to be right first: every bound between the
call site and the network. A transport is an afternoon; the bounds are the
feature.

**Left out: traces.** ADR-0003 retains OpenTelemetry propagation and defers
remote traces. The exporter's `signal` dimension exists so a second signal can
join without reshaping the series.

**Left out: alerts (item 11).** Alert rules need a backend to evaluate them. What
this delivers is the series they will attach to, under the status names ADR-0023
settled on, so the rules can be written against names that already exist.

**Left out: the full metric vocabulary.** The observability architecture names
roughly seventy series. The catalogue here holds the ones items 5 and 6 require,
because ADR-0003 budgets a hundred *time series* — and one metric with four
dimension values is four of them. Adding the rest without measuring the
multiplication would blow the budget the first time it was reviewed.

---

## Consequences

An instrumentation call cannot leak a tenant identifier into a provider's
rollups. That was previously a review property and is now a code property, with a
test that names the identifiers it refuses.

RED reports refusals, including the ones the guard makes. A service whose
authorization is failing shows a rising `4xx` rate rather than falling traffic.

A telemetry backend that hangs cannot slow a request, grow the heap, or hold a
deploy past its termination grace period. Each of those is a separate test
against a transport that misbehaves on purpose.

Metrics are silent unless configured, and which sink is running is a fact in the
startup log rather than something inferred from what is missing.

---

## Alternatives considered

**Let call sites pass arbitrary dimensions and review them.** Rejected: the cost
of a missed review is a retention path nobody can delete, discovered in an audit
rather than in a diff.

**Throw on a forbidden dimension, so it cannot be ignored.** Tempting, and
rejected because it makes a telemetry bug an availability bug. The loud log plus
a dropped sample gives the same visibility without the outage; the tests are what
stop it being ignored.

**Increment counters at the call site for the item 6 levels.** Rejected above —
levels are properties of the table, not of this process, and an in-memory counter
disagrees with the table after the first restart.

**Requeue a failed batch indefinitely rather than discarding at the ceiling.**
Rejected: that is the same unbounded growth under a different name, and a backlog
of stale samples is worth less than the memory it occupies.
