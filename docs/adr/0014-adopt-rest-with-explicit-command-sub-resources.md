# ADR-0014: Adopt REST with Explicit Command Sub-Resources and Header-Scoped Tenancy

**Status:** Proposed  
**Date:** 2026-07-28  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** before exposing a public API (Phase 5), before adding a second API style, or when a command is added to the authorization catalog without a corresponding route

## Context

No API contract exists. `docs/api/` was referenced by the README and folder structure but
never created, and the repository contains three mutually inconsistent URL examples:

| Document | Example | Implied convention |
|---|---|---|
| `engineering/naming.md` | `POST /works` | flat, plural, noun-only |
| `architecture/identity-and-organization.md` | `POST /organizations/{organizationId}/work` | nested under Organization, singular |
| `architecture/authorization.md` | `POST /decisions/{id}/approve` | verb sub-resource |

These are not three styles competing on taste. Each captures a real constraint:

- **Nouns and plurals** are the stated naming convention.
- **Organization scoping must be explicit and verified.** The identity document is clear
  that a route-supplied Organization identifier is a *requested* value which the
  Application Layer must still validate against Membership and against the resource's own
  Organization.
- **Commands are first-class.** [Authorization](../architecture/authorization.md) defines
  twenty-five discrete permissions — `work.complete`, `decision.approve`,
  `memory.reject` — not CRUD verbs.
  [Observability](../architecture/observability-and-operations.md) requires a
  server-owned `operation` value drawn from a version-controlled registry, naming
  `work.complete` and `decision.approve` as examples. The state machines define commands
  with distinct preconditions, distinct failure modes, and distinct audit records.

A conventional `PATCH /decisions/{id}` carrying `{"status": "Approved"}` cannot satisfy
this. It collapses `decision.approve`, `decision.reject`, and `decision.withdraw` into
one route with one permission check, makes the audit record depend on payload
inspection, and turns an invalid transition into a validation error rather than a
rejected command.

`application-services.md` lists GraphQL alongside HTTP and CLI as presentation-layer
concerns. That is an enumeration of what the layer may handle, not a selection.

## Decision

### REST over HTTP/JSON

The MVP exposes a REST API over HTTP with JSON payloads. GraphQL is not used.

The API is internal to the MVP application. A public, versioned, externally supported API
remains a Phase 5 concern; nothing here creates that commitment.

### Resource routes are flat and plural

Resource paths do not embed the Organization:

```text
POST   /works
GET    /works
GET    /works/{workId}
PATCH  /works/{workId}
```

Nesting expresses composition owned by the parent, not tenancy:

```text
GET    /works/{workId}/decisions
GET    /decisions/{decisionId}/revisions
```

### Tenancy comes from a verified context header, not the path

Every request carries the acting Organization in a header:

```text
X-Organization-Id: <organizationId>
```

The edge resolves and verifies it before any handler runs, following ADR-0013:

1. the Organization exists and is `Active`;
2. the authenticated identity has an `Active` Membership in it; and
3. every resource touched by the request belongs to that same Organization.

Failing any check yields `404` for a cross-tenant resource — never `403`, which would
confirm existence. The header is a *requested* value with no authority of its own; it
selects among the caller's Memberships and nothing more.

Organization administration is the one place Organization appears in the path, because
there the Organization *is* the resource:

```text
GET    /organizations/{organizationId}/members
POST   /organizations/{organizationId}/members
```

### Three routes have no Organization context

```text
POST /invitations/accept
```

Accepting an invitation is the act of *becoming* a Member. The caller is authenticated
but has no Membership in the target Organization, so the resolution chain in step 2 above
cannot succeed and `X-Organization-Id` has nothing to select among. Requiring the header
here would make the flow unreachable.

The route is therefore exempt from Organization resolution, and **only** from that. It
still requires authentication, and it is not permission-gated at all: authority comes
from the invitation token, which names the Organization. The route accepts no
`organizationId` parameter of any kind — a caller cannot choose which Organization to
join.

### Organization creation is the other

```text
POST /organizations
```

The same structure, one step earlier. Creating an Organization is the act of bringing
one into existence, so the caller cannot hold a Membership in it and
`X-Organization-Id` has nothing to name.

It is exempt from Organization resolution and, unlike every command route, carries **no
permission at all**. There is no principal for one to attach to: permissions are held
through a Membership, evaluated within one Organization, and neither exists yet.
Authority is being an authenticated, Active Human Identity — which the bootstrap verifies
before it writes anything.

The route accepts no `organizationId`: the identifier is server-generated, so a caller
cannot choose it or collide with an existing tenant.

### Listing your own Memberships is the third

```text
GET /organizations
```

This ADR says of `X-Organization-Id` that "it selects among the caller's Memberships and
nothing more". That sentence assumes the caller knows what there is to select among, and
until this route nothing told them: `mvp.md` states twice that a person may belong to more
than one Organization, and no route returned the set. The web client's single
environment-variable Organization was the consequence, not the cause.

Requiring the header here would be circular — the caller would have to name an
Organization in order to ask which Organizations they may name. So the route is exempt from
Organization resolution, and like `POST /organizations` it carries **no permission**:
permissions are held through a Membership and evaluated within one Organization, and this
route spans Memberships and precedes the choice of one. Authority is being an
authenticated, Active Human Identity.

Two properties make the exemption safe, and both are structural rather than checked:

- **The route takes no parameters at all.** There is no identifier to supply and therefore
  nothing to probe with. Compare `POST /invitations/accept`, whose safety rests on a token,
  and `POST /organizations`, whose safety rests on generating the identifier server-side.
  This one has no input to abuse.
- **The result is derived from the authenticated subject.** It returns exactly the
  Organizations in which that subject holds an `Active` Membership. A caller cannot widen
  it, and a wider result would require a defect in the query rather than a missing check.

**It returns Suspended Organizations, and this is deliberate.** Reactivation is exempt from
the Organization status check precisely so an Owner can recover a suspended Organization —
but an Owner who cannot *find* it has no route to that exemption, and the recovery path
documented above would be unreachable from any client. The response carries the
Organization's status so a client can show why one cannot be worked in and offer the Owner
the one command that still applies. `Archived` is returned for the same reason of honesty
and is terminal: nothing acts on it.

Membership status is not treated the same way. Only `Active` Memberships are listed,
because a Suspended or Revoked Member holds no authority in that Organization and listing
it would offer a choice that every subsequent request refuses.

### Reactivation is exempt from the Organization *status* check

```text
POST /organizations/{organizationId}/reactivate
```

Unlike the two above, this route resolves the Organization normally. It requires an
authenticated subject, a resolvable Active Membership, and `organization.reactivate`,
which only an Owner holds. It is exempt from one thing only: the rule that the resolved
Organization must be `Active`.

Without the exemption the route could not be called. `PrincipalResolver` refuses every
request whose Organization is not `Active`, and the guard reports that as `404` before any
handler runs — so a suspended Organization would have no way back that did not involve
editing the database.
[ADR-0017](0017-promote-the-organization-lifecycle.md) records the reasoning, and
`identity-and-organization.md` anticipates it: "Suspension may allow restricted access
for: Organization recovery."

The exemption covers `Suspended` and not `Archived`. Archival is terminal.

These are the only four exemptions. Any further route that claims one is a defect until
this ADR is amended.

Three of the four are the same shape and it is worth naming: each is a step at which a
Membership does not yet exist to resolve — becoming a Member, creating the Organization
that will hold the first Membership, and choosing which Membership to act under. The
fourth, reactivation, is different in kind: the Membership resolves normally and only the
Organization's status is waived.

### State transitions are explicit command sub-resources

Every command in the authorization catalog maps to exactly one `POST` route, named for
the command:

```text
POST /works/{workId}/start
POST /works/{workId}/complete
POST /decisions/{decisionId}/approve
POST /memories/{memoryId}/reject
```

The rule is one-to-one and enforced in review: **every permission has exactly one route,
and every command route has exactly one permission.** A command route never accepts a
target state as a parameter.

`PATCH` is reserved for content edits that carry no lifecycle meaning
(`work.edit`, `decision.edit_draft`, `memory.edit_generated`).

#### Atomic activation is the one route that carries two permissions

```text
POST /decisions/{decisionId}/submit
```

ADR-0007 makes `RequestBlockingDecision` "the only approved MVP use case that mutates
both Work and Decision in one transaction", and requires that `Decision.SubmitForReview`
and `Work.RequestBlockingDecision` commit together or not at all. Two HTTP requests
cannot share one transaction, so the two commands cannot have two routes: splitting them
is not a routing preference this ADR is free to express, it is a durability property
ADR-0007 already decided.

This route therefore checks `decision.submit` **and** `work.request_decision`, and a
caller holding only one of them is refused. The one-to-one rule holds in the direction
that matters for the audit — each permission still has exactly one route, so a permission
identifier still names a single place — and it is the reverse direction that bends here.

There is no `POST /works/{workId}/request-decision`. A route that placed Work in
`WaitingForDecision` on its own would create exactly the state ADR-0007 forbids: "A Draft
Decision never places Work in `WaitingForDecision`."

This is the only route with two permissions. Any further one is a defect until this ADR
is amended.

### Route catalogue

| Permission | Route |
|---|---|
| `work.create` | `POST /works` |
| `work.edit` | `PATCH /works/{workId}` |
| `work.start` | `POST /works/{workId}/start` |
| `work.assign` | `POST /works/{workId}/assign` |
| `work.record_progress` | `POST /works/{workId}/progress` |
| `work.request_decision` | `POST /decisions/{decisionId}/submit` |
| `work.complete` | `POST /works/{workId}/complete` |
| `work.cancel` | `POST /works/{workId}/cancel` |
| `decision.create` | `POST /decisions` |
| `decision.edit_draft` | `PATCH /decisions/{decisionId}` |
| `decision.submit` | `POST /decisions/{decisionId}/submit` |
| `decision.approve` | `POST /decisions/{decisionId}/approve` |
| `decision.reject` | `POST /decisions/{decisionId}/reject` |
| `decision.withdraw` | `POST /decisions/{decisionId}/withdraw` |
| `decision.start_revision` | `POST /decisions/{decisionId}/revisions` |
| `decision.record_secretary_contribution` | `POST /decisions/{decisionId}/assistance` |
| `memory.edit_generated` | `PATCH /memories/{memoryId}` |
| `memory.submit` | `POST /memories/{memoryId}/submit` |
| `memory.approve` | `POST /memories/{memoryId}/approve` |
| `memory.reject` | `POST /memories/{memoryId}/reject` |
| `memory.reopen` | `POST /memories/{memoryId}/reopen` |
| `notification.read` | `GET /notifications` |
| `notification.acknowledge` | `POST /notifications/{notificationId}/acknowledge` |
| `organization.rename` | `PATCH /organizations/{organizationId}` |
| `organization.suspend` | `POST /organizations/{organizationId}/suspend` |
| `organization.reactivate` | `POST /organizations/{organizationId}/reactivate` |
| `organization.archive` | `POST /organizations/{organizationId}/archive` |
| `organization.read_members` | `GET /organizations/{organizationId}/members` |
| `organization.invite_member` | `POST /organizations/{organizationId}/members` |
| `organization.resend_invitation` | `POST /organizations/{organizationId}/members/{membershipId}/resend-invitation` |
| `organization.revoke_invitation` | `POST /organizations/{organizationId}/members/{membershipId}/revoke-invitation` |
| `organization.suspend_member` | `POST /organizations/{organizationId}/members/{membershipId}/suspend` |
| `organization.reactivate_member` | `POST /organizations/{organizationId}/members/{membershipId}/reactivate` |
| `organization.revoke_member` | `POST /organizations/{organizationId}/members/{membershipId}/revoke` |
| `organization.assign_role` | `POST /organizations/{organizationId}/members/{membershipId}/assign-role` |
| `organization.revoke_role` | `POST /organizations/{organizationId}/members/{membershipId}/revoke-role` |
| `organization.grant_assistance` | `POST /organizations/{organizationId}/assistance-grants` |
| `organization.revoke_assistance` | `POST /organizations/{organizationId}/assistance-grants/revoke` |
| `operations.read_workflow_health` | `GET /admin/workflow-health` |
| `operations.pause_worker` | `POST /admin/workers/{workerType}/pause` |
| `operations.resume_worker` | `POST /admin/workers/{workerType}/resume` |
| `operations.read_diagnostics` | `GET /admin/diagnostics` |
| `events.inspect_failed` | `GET /admin/events/failed` |
| `events.retry` | `POST /admin/events/{eventId}/retry` |
| `events.skip` | `POST /admin/events/dead-letters/{deadLetterId}/skip` |
| `events.replay_domain_consumer` | `POST /admin/events/dead-letters/{deadLetterId}/reprocess` |
| `events.replay_projection` | `POST /admin/events/replay/projection` |

Three routes are absent from this table because they hold no permission, and the reasoning
for each is above: `POST /invitations/accept`, `POST /organizations`, and
`GET /organizations`. A permission is held through a Membership and evaluated within one
Organization; none of the three has one to evaluate against.

The `operation` value recorded for observability is the permission identifier, so
`POST /works/{workId}/complete` reports `work.complete`. Route and telemetry cannot
drift apart.

### Recovery routes are addressed by what they recover

`events.retry` acts on publication and is keyed by `eventId`, because an Outbox row
is one event published once. The other three act on *consumption* — one named
consumer's handling of one event — and are keyed by `deadLetterId`, which identifies
that pair.

Keying them by `eventId` would be ambiguous the moment a second consumer registers
for the same event type: two deliveries can fail independently, and skipping "the
event" would not say which result is being discarded. The dead letter is the thing
an operator inspects, so it is the thing the command names.

### `{workerType}` is a closed vocabulary, not an identifier

Every other path parameter in this table is an identifier of a stored row. `workerType` is
not: it is one of a fixed set of names, and the route rejects anything outside it before the
handler runs ([ADR-0022](0022-promote-worker-pause-and-resume.md)).

It is still a path segment rather than a body field, because it identifies *what the command
acts on*. `POST /admin/workers/pause` with `{"workerType": "MemoryGeneration"}` would put the
target of a privileged operational command in the payload, where the route pattern — and
therefore the audit's `commandType` and the ingress metric's `route_template` — could not see
it. A pause of publication and a pause of Memory generation would be indistinguishable in
both.

### `work.assign` declares relationships rather than naming an operation

One permission covers four Aggregate commands. The Work Authorization Matrix gives
`work.assign` to `AssignMember`, `UnassignMember`, `AddParticipant`, and
`RemoveParticipant`, while the rule above allows the permission exactly one route.

`POST /works/{workId}/assign` therefore states the relationships the Work should have
when the request finishes:

```json
{ "assigneeMembershipId": "…", "participantMembershipIds": ["…"] }
```

An omitted field leaves that relationship alone; `assigneeMembershipId: null` clears the
assignment; the participant list replaces the set. The service computes the delta and
issues only the Aggregate commands it implies, so the four commands stay distinct in
the Aggregate, in the audit history, and in the event stream — `WorkAssignmentChanged`
and `WorkParticipantChanged` are still emitted separately.

This does not weaken "a command route never accepts a target state as a parameter".
That rule is about lifecycle status: it stops `PATCH /works/{id}` with
`{"status": "Completed"}` from bypassing a command's permission and preconditions.
A relationship set is not a lifecycle state, carries no status, and leaves the Work's
status untouched.

The alternative — a route per command — was rejected because it would require either
four routes sharing one permission, or three new permissions. The permission catalogue
is closed and derived from the authorization document, so inventing permissions to
satisfy a routing convention would put the code ahead of the document it implements.

### Optimistic concurrency is explicit

Aggregates carry a `version`. Every mutating request supplies the expected version via
`If-Match`, and a mismatch returns `409 Conflict`. Commands are not silently
last-write-wins.

### Idempotency

Mutating requests accept an `Idempotency-Key` header. Retries of a delivered command
return the original outcome rather than applying it twice, consistent with the
at-least-once posture in [ADR-0006](0006-use-postgresql-transactional-outbox.md).

### Errors

One error shape, with a stable machine-readable `code`:

```json
{
  "code": "WORK_INVALID_TRANSITION",
  "message": "Work cannot be completed from state Draft.",
  "details": {}
}
```

| Status | Meaning |
|---|---|
| `400` | malformed request |
| `401` | no valid authenticated subject |
| `403` | authenticated, Membership active, permission denied |
| `404` | not found, or outside the acting Organization |
| `409` | version conflict or invalid state transition |
| `422` | well-formed but violates a domain invariant |

Messages never disclose whether a resource exists in another Organization.

### Naming

Paths are lower-case kebab-case and plural. JSON fields are `camelCase`, matching the
TypeScript domain model. Identifiers are opaque strings.

## Alternatives considered

### GraphQL

Rejected for the MVP. The permission model is per-command and default-deny; GraphQL
would move authorization to field resolvers and lose the one-command/one-permission
correspondence that makes the catalogue reviewable. It also complicates the
server-owned `operation` registry, adds N+1 risk against the projection rules in the
persistence document, and offers little to a small first-party client.

### Pure noun REST with status in the payload

Rejected. It cannot express twenty-five distinct permissions, degrades audit to payload
inspection, and represents an invalid state machine transition as a field validation
error.

### Organization in every resource path

Rejected as the default. It duplicates tenancy in every route and creates a
route-versus-resource mismatch class that must be checked on every endpoint. Resolving
tenancy once at the edge removes that class. Nested Organization paths are retained only
where the Organization is genuinely the parent resource.

### RPC-style endpoints (`POST /completeWork`)

Rejected. `naming.md` prohibits verb-first paths, and RPC loses the resource identity
needed for `If-Match` and for consistent `404` behaviour.

## Consequences

Benefits:

- the route table is a direct projection of the permission catalogue, so a missing or
  extra route is visible in review and testable;
- telemetry `operation`, permission, and route share one identifier;
- tenant scoping is enforced once at the edge instead of per-endpoint; and
- the three conflicting URL examples are replaced by one convention.

Costs:

- command sub-resources are not conventional CRUD REST and will look unusual to
  contributors expecting `PATCH` with a status field;
- every new command requires a route, a permission, and a registry entry together; and
- the `X-Organization-Id` header must be supplied by every client, including
  development tooling.

## Related documents

- [ADR-0013](0013-bind-clerk-as-authentication-provider.md)
- [Authorization](../architecture/authorization.md)
- [Application Services](../architecture/application-services.md)
- [Observability and Operations](../architecture/observability-and-operations.md)
- [Naming Conventions](../engineering/naming.md)
- [Work State Machine](../architecture/state-machines/work.md)
- [Decision State Machine](../architecture/state-machines/decision.md)
- [Memory State Machine](../architecture/state-machines/memory.md)
