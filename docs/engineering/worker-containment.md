# Worker Containment

## Purpose

How to stop asynchronous processing when it is doing damage, and how to start it again.

This is the operable form of the architecture's Worker Containment section, which lists
when a Worker may be paused:

> - it produces repeated invalid effects
> - event contract interpretation is defective
> - an external dependency is unsafe
> - duplicate processing risk is high
> - queue growth is preferable to corrupted state

Every one of those is a case where **a growing backlog is the better outcome**. Pausing
does not lose work; it stops claiming it. Rows stay `Pending` and drain in `recorded_at`
order after the resume, with no replay and no repair
([ADR-0022](../adr/0022-promote-worker-pause-and-resume.md)).

---

## Choose the scope first

There are two controls and they are not interchangeable. Picking the wrong one either fails
to contain the problem or contains far more than the problem.

| The fault is in… | Use | Effect |
|---|---|---|
| One Organization's data or workload | `POST /admin/workers/{workerType}/pause` | That Organization only |
| The Worker itself — a defective handler, an unsafe provider, a bad deploy | `WORKER_PAUSED_TYPES` | Every Organization, on restart |

The routed command is authorized by a Membership and **cannot reach another tenant**. The
environment variable has no route and no permission, because the MVP models no Human
principal with authority across Organizations — it is the deployment operator's control,
exercised the way deployment controls are.

If you are reaching for the environment variable to stop one noisy tenant, stop: you are
about to take an outage for everyone else.

---

## What each Worker type stops

| Worker type | Pausing it stops |
|---|---|
| `OutboxPublication` | Claiming any Outbox row — every consumer downstream of it |
| `MemoryGeneration` | Claiming `WorkCompleted` rows, which only the Memory generator serves |

`OutboxPublication` is the whole-Organization stop: Decision outcomes stop reaching Work
completion gates, notifications stop, Memory generation stops. Reach for `MemoryGeneration`
first when the fault is the AI provider or the generated content, because it leaves
Decision coordination working.

`ConsumerDelivery` and `DeadLetter` appear in the workflow-health report but are **not**
pausable, and the command rejects them with `400`. Consumer delivery has no claim loop of
its own — pausing `OutboxPublication` already stops it — and a dead letter is a record
awaiting a decision, not a Worker.

---

## Runbook 7: contain one Organization's asynchronous processing

**Preconditions.** You hold `operations.pause_worker` in the affected Organization —
`OrganizationOwner` or `OrganizationAdmin`. You know which workflow is misbehaving; if you
do not, `GET /admin/workflow-health` is where to start.

1. **Establish what is actually stuck.**

   ```bash
   curl -s -H "X-Organization-Id: $ORG" -H "Authorization: Bearer $TOKEN" \
     "$API/admin/workflow-health" | jq
   ```

   Read `status`, `pending`, `oldestPendingSeconds`, and `paused` per workflow. A `Critical`
   with `paused: true` is somebody's existing containment, not a new incident — find out
   whose before adding another.

2. **Pause, with a reason someone else can act on.** The reason is required, and it is what
   whoever lifts this will read. "Provider returning malformed candidates, see INC-241" is
   useful; "broken" is not.

   ```bash
   curl -sX POST -H "X-Organization-Id: $ORG" -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"reasonCode":"PROVIDER_UNSAFE","reason":"Malformed candidates, INC-241"}' \
     "$API/admin/workers/MemoryGeneration/pause"
   ```

   The response is the pause **in force**, which may not be the one you just sent: pausing
   an already-paused Worker keeps the first reason. If the reason that comes back is not
   yours, someone else contained this before you.

3. **Confirm claiming has stopped.** Watch `pending` climb and `oldestPendingSeconds` grow
   in the health report. That is the pause working, not a new failure — the backlog is the
   accepted cost.

4. **Preserve evidence before changing anything.** The architecture's incident-evidence list
   applies: logs, Outbox rows, processed-event rows, deployment and migration identifiers,
   operator actions. A pause holds the queue still, which is the best moment to capture it.

5. **Fix the cause.** The pause buys time; it is not a fix, and it does not expire on its
   own. Nothing lifts it but a person.

6. **Resume.**

   ```bash
   curl -sX POST -H "X-Organization-Id: $ORG" -H "Authorization: Bearer $TOKEN" \
     "$API/admin/workers/MemoryGeneration/resume"
   ```

   `{"resumed": false}` means there was no pause to lift. That is reported rather than
   refused, so a second operator restoring service does not have to work out whether the
   first already did it.

7. **Watch the drain.** `pending` should fall and `oldestPendingSeconds` should drop as the
   backlog clears. If `status` stays `Critical` with `paused: false`, the fault was not the
   one you paused for.

**Audit.** Both commands write a Class B durable audit row — the privileged operational
action's record — carrying the acting Membership, the Organization, and the Worker type.
The intent and the effect commit together, so there is no moment in which a pause is in
force but unattributed.

---

## Runbook 8: stop a Worker type for every Organization

Use this when the Worker itself is unsafe: a handler that corrupts state, an event contract
misread, a provider that must not be called at all. It is a deploy, not an API call.

1. Set `WORKER_PAUSED_TYPES` in the Worker's environment — comma-separated, from
   `OutboxPublication` and `MemoryGeneration`.
2. Restart the Worker process. The value is read once at startup, deliberately: a pause that
   could change under a running loop would let the readiness answer and the claim behaviour
   disagree for as long as the process lived.
3. Confirm on the probe port. Worker readiness reports:

   ```json
   { "status": "Unready", "reasonCode": "ADMINISTRATIVELY_PAUSED" }
   ```

   This is the architecture's "the Worker type is not administratively paused" check, and it
   is the difference between a Worker that is stopped and one that merely looks idle.
4. Check the startup log for `worker.pause_unrecognised`. A misspelled name pauses
   **nothing** and the process starts normally — the failure mode of a control whose whole
   purpose is to stop something. The log line is how you find out.
5. To resume, clear the variable and restart.

---

## What this does not do

**A pause does not expire.** An operator who pauses during an incident and forgets is left
with a silently growing backlog. It is visible — the health report shows the age climbing
and says `paused: true` — but nothing lifts it. Until a scheduled expiry exists, the pause
belongs in the incident record as an action to reverse.

**A pause does not stop work already claimed.** A drain in flight when the pause commits
runs to completion. Pause stops the *next* claim; stopping work already claimed is what
`SIGTERM` and the graceful drain are for.

**An Organization-scoped pause does not change Worker readiness.** The probe answers for a
process, and a process with one tenant paused can still serve every other one. Reporting
`Unready` for it would present one Organization's containment as a platform fault. The
Organization-scoped answer is in `GET /admin/workflow-health`.

**Both Worker types share one process.** So a deployment pause of either makes the one
process report `Unready`, even though the other type could still work. The architecture asks
for per-type isolation; that needs separate processes, and this deployment does not have
them. `release-readiness.md` records it.
