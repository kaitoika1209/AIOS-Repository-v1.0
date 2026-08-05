# ADR-0022: Promote Worker pause and resume

**Status:** Accepted
**Date:** 2026-08-05
**Blueprint Version:** 0.2.0
**Decision Owner:** Platform Operations
**Review Trigger:** when a Worker type runs in its own process, when a cross-Organization
operator identity is designed, or when a pause needs to expire on its own

---

## Context

The MVP Production Baseline requires, as item 9, "bounded retry, idempotency,
retry-exhaustion visibility, dead-letter handling, and **typed Operations Application
Service commands for Worker pause/resume**, replay, and dead-letter retry/skip". Replay and
dead-letter retry/skip are built. Pause and resume are not, and `release-readiness.md`
records what that costs today:

> Until it exists, stopping the Worker means stopping the process.

That is not a small inconvenience. Every operational containment procedure in
`observability-and-operations.md` begins by pausing something — "pause mutation Workers"
in the incident runbook, "pause Organization-scoped Worker processing" under
Organization-specific containment, "pause defective Worker or feature if required" during a
bad deployment. With no pause, each of those becomes `SIGTERM`, which stops the affected
Organization *and every other one*, and cannot be narrowed.

The absence is also visible from the other side. Worker readiness "MUST verify ... the
Worker type is not administratively paused", and the probe cannot: there is no
administrative pause for it to read. `health.ts` records that as a gap rather than
pretending the check passes.

### The obstacle is authorization, not mechanism

Stopping a claim loop is easy. Deciding who may ask for it is not, and that is why this
sat unbuilt after the `events.*` recovery commands were promoted.

A Worker type is a process-wide thing. Pausing "the Memory Worker" stops Memory generation
for every Organization the process serves. The permission that authorized it would be held
through a Membership in one Organization — so an Owner of one tenant would halt the others.
`authorization.md` forbids exactly this, and forbids the obvious escape hatch too:

> The MVP does not model a cross-Organization Human PlatformOperator principal. Deployment
> or database operators may pause Workers, preserve evidence, and restore infrastructure
> under the Operations controls, but they cannot use that access to authorize
> Organization-scoped replay or skip.
>
> Cross-Organization replay, support impersonation, and break-glass recovery require a
> separate future identity, approval, customer-visibility, and audit design.

So there is no principal in the MVP who may pause a Worker type globally through the API,
and inventing one is explicitly a separate design. The same sentence, read the other way,
says who *may* do it: deployment operators, through the Operations controls — that is,
through the deployment, not through a route.

---

## Decision

Pause and resume are built as two mechanisms, split along the authority boundary that
sentence draws. Neither is a subset of the other, and neither can substitute for the other.

### 1. Organization-scoped pause, as typed Operations commands

Two permissions are promoted from unlisted to catalogued:

```text
operations.pause_worker
operations.resume_worker
```

Both are granted to `OrganizationOwner` and `OrganizationAdmin`, matching the `events.*`
recovery family and `operations.read_workflow_health`: the people who act on a stalled or
misbehaving workflow are the people who need to stop it.

Two routes, per ADR-0014's one-route-one-permission rule:

```text
POST /admin/workers/{workerType}/pause
POST /admin/workers/{workerType}/resume
```

Both are ordinary Organization-scoped routes. They require `X-Organization-Id`, an Active
Membership, and the permission; they claim no exemption. A pause taken by one Organization
suspends processing for **that Organization only**, which is what makes the permission
holdable at all — and it is precisely the containment action the architecture names:

> Possible actions: block Organization mutations, **pause Organization-scoped Worker
> processing**, disable Organization invitations, prevent replay for the Organization,
> preserve read-only access.

### 2. Deployment-scoped pause, as process configuration

A global pause is configuration read at startup, not a route:

```text
WORKER_PAUSED_TYPES=OutboxPublication,MemoryGeneration
```

It has no permission and no endpoint because it has no Human principal — it is the
"deployment or database operators may pause Workers" case, exercised the way deployment
operators exercise everything else, by changing the deployment. It is what an operator
reaches for when the Worker itself is defective rather than one tenant's work.

And it is the half that closes the readiness requirement: a Worker paused by configuration
reports `Unready` with reason `ADMINISTRATIVELY_PAUSED`, so "the Worker type is not
administratively paused" is verified rather than assumed.

---

## What can be paused

Two Worker types, named for the workflows they advance so the vocabulary matches
[ADR-0021](0021-promote-asynchronous-workflow-health.md)'s health report:

| Worker type | Pausing it stops |
|---|---|
| `OutboxPublication` | claiming any Outbox row — every consumer downstream of it |
| `MemoryGeneration` | claiming `WorkCompleted` rows, which only the `memory-generation` consumer serves |

`ConsumerDelivery` and `DeadLetter` are in the health vocabulary but are not pausable, and
that is a statement about this deployment rather than a policy. Consumer delivery has no
claim loop of its own — it happens inside the publication drain — so `OutboxPublication`
already is its pause. A dead letter is a durable record awaiting a decision, not a Worker.

Pausing `OutboxPublication` therefore halts all asynchronous processing for one
Organization. That is `pause-all-domain-workers` from the architecture's kill-switch list,
narrowed to a tenant; `MemoryGeneration` is `pause-memory-generation`, the same list's
other entry. Those two levers exist because they are the two that get used.

### Pausing means not claiming

The whole mechanism is one predicate on the Outbox claim. Nothing is begun and abandoned,
no delivery is recorded as attempted, no attempt counter moves, no lease is taken. Rows
stay `Pending` and are claimed on the first drain after the resume.

This is deliberate and it is the reason the feature is small. The alternative — checking
the pause inside each consumer, after the row is claimed — would mark deliveries attempted
that were never attempted, corrupting the retry counts and the workflow-health ages that
baseline items 9 and 11 depend on. A pause that damages the evidence operators use to
decide when to resume is worse than no pause.

One consequence follows and is accepted: a drain already in flight when the pause commits
runs to completion. Pause is not a kill; it stops the *next* claim. Stopping work already
claimed is what `SIGTERM` and the graceful drain are for.

---

## Durable state

A row per paused pair, in a new table:

```text
worker_pauses (organization_id, worker_type)
```

Presence is the pause. Resume deletes the row rather than setting a flag, because a
two-state column invites the question "paused = false, or never paused?" — and the durable
history of who paused what and when is the audit record, which is insert-only and cannot be
edited by a resume.

The row carries who paused it, when, and why. The reason is required, not optional: the
same rule `events.skip` follows, for the same reason. A pause with no stated cause is a
pause nobody can safely lift, and pauses are lifted by someone other than the person who
took them often enough that this matters.

---

## Audit

Pause and resume are Class B — Durable Independent, which the architecture names directly:
"privileged operational actions ... Worker pause or resume". "Pausing must emit an
operational audit event."

The rule that Class B "MUST NOT execute until its intent audit is durable" is satisfied in
the stronger form available here: the intent and the effect are the same transaction. There
is no execution phase to precede, because the durable row *is* the action, so there is no
window in which the pause is in force but unattributed. That is not available to replay,
where the intent must survive a process that dies mid-execution, and the rule is written
for that case.

The operational log names are `worker.paused` and `worker.resumed`. The architecture lists
`WorkerPaused` and `WorkerResumed` among its "additional privileged action examples"; this
repository names every operational log lowercase-dotted, and one pair spelled differently
from the other sixteen would be a naming inconsistency rather than a fidelity improvement.
The durable audit's `commandType` records the route, which is unambiguous either way.

### A correction this ADR carries

ADR-0021 states that the workflow-health read is "audited like every other routed
permission". It was not: the audit interceptor skips `GET`, deliberately, because "a row
per list request would bury the ones that matter". That reasoning is right for
`GET /notifications` and wrong for `GET /admin/workflow-health` — the architecture requires
the diagnostic surface to "audit privileged or cross-Organization access", and an
operational read of an Organization's failures is a privileged access whether or not it
changes anything.

The interceptor now audits `GET` for the `events.*` and `operations.*` families only, which
makes ADR-0021's sentence true and leaves ordinary reads unaudited. `GET /admin/events/failed`
gains the same trace, which it should always have had.

---

## The smallest useful vertical slice

ADR-0010 requires promotion to name one, and to be equally clear about what it leaves out.

**Left out: expiry.** A pause stays until someone lifts it. An operator who pauses a
workflow during an incident and forgets is left with a silently accumulating backlog. That
backlog is visible — `GET /admin/workflow-health` reports the growing age, and this ADR
adds a `paused` flag to the report so the operator sees *why* — but nothing lifts it
automatically. A time-bounded pause needs a scheduler to expire it, which is a second
durable mechanism, and guessing at a default duration before anyone has run an incident
with this would be inventing the number.

**Left out: per-Organization readiness.** The Organization-scoped pause deliberately does
**not** change Worker readiness. The probe answers for a process, and the process is still
perfectly able to claim and process work — for every Organization that is not paused.
Reporting `Unready` because one tenant is paused would be the "global metrics can remain
healthy while one Organization is permanently blocked" failure inverted: one Organization's
containment presented as a platform fault. The Organization-scoped answer belongs in the
Organization-scoped surface, which is why it goes in the health report instead.

**Left out: pausing a Worker type globally through the API.** The reason is the whole
Context section. It needs a principal the MVP does not model, and the architecture defers
that identity, approval, customer-visibility, and audit design in one sentence. The
deployment-scoped pause is the operator's lever until it exists.

**Left out: separate processes per Worker type.** The architecture wants "one Worker type
becoming unready MUST NOT make unrelated Worker types ... unready". This deployment runs
both types in one loop, so a deployment-scoped pause of either makes the one process report
`Unready`. Splitting them is a deployment-topology change with its own probe ports and its
own operational cost, and it is not what item 9 asks for.

With those out, **baseline item 9 is complete**: the typed commands exist, they are
authorized by principals who may hold them, they are durable, they are audited, and the
readiness check the architecture requires now reads real state.

---

## Consequences

An Organization can be contained without stopping the platform, which is the difference
between a targeted response and an outage. The blast radius of pausing a misbehaving
tenant's Memory generation is now that tenant's Memory generation.

A paused workflow is reported as paused and still reported as degrading. The status keeps
its meaning — "is committed work progressing within policy" — and the answer for a paused
workflow is honestly no. The `paused` flag says the degradation is deliberate. Item 11's
alerts will have to decide whether a deliberate backlog pages someone; this ADR gives them
both facts rather than deciding for them.

Resume does not replay. It stops excluding rows from the claim, and the backlog drains in
`recorded_at` order like any other backlog. Nothing about a pause creates work to recover.

A pause taken in one Organization is invisible to another, including in the health report,
because the report is Organization-scoped. There is no surface on which one tenant can
observe another's containment.

---

## Alternatives considered

**One permission, `operations.pause_worker`, for both commands.** Rejected by ADR-0014's
one-route-one-permission rule, and the rule earns its keep here: pausing and resuming are
not the same authority. Pausing is conservative — it stops work — while resuming asserts
the condition that caused the pause is over. A future policy that lets an Admin pause and
requires an Owner to resume is expressible only if the permissions are separate.

**A `paused` column on `organizations`.** Rejected because the pause is per Worker type,
so it would be a column per type and a schema change per new type. It would also put
operational state on an aggregate table, where it would be read and written by a different
authority than everything else in the row.

**Honour the pause inside each consumer instead of at the claim.** Rejected above: it
records delivery attempts that never happened and corrupts the retry counts and pending
ages that the rest of baseline items 9 and 11 are built on.

**Environment configuration only, with no routes.** It closes the readiness requirement and
needs no promotion at all — genuinely tempting. Rejected because item 9 asks for "typed
Operations Application Service commands", and a redeploy is neither typed nor a command:
it cannot be authorized per Organization, cannot be audited against a Membership, and
cannot narrow to one tenant. It would have satisfied the probe and left the containment
procedures no better off than `SIGTERM`.

**Routes only, with no configuration.** Rejected because it leaves the readiness MUST
unimplemented and gives an operator no way to stop a Worker that is defective for everyone
— the case where the fault is in the code, not in one tenant's data.
