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

### Invitation acceptance is the one route without an Organization context

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

This is the only exemption. Any future route that claims one is a defect until this ADR
is amended.

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

### Route catalogue

| Permission | Route |
|---|---|
| `work.create` | `POST /works` |
| `work.edit` | `PATCH /works/{workId}` |
| `work.start` | `POST /works/{workId}/start` |
| `work.assign` | `POST /works/{workId}/assign` |
| `work.record_progress` | `POST /works/{workId}/progress` |
| `work.request_decision` | `POST /works/{workId}/request-decision` |
| `work.complete` | `POST /works/{workId}/complete` |
| `work.cancel` | `POST /works/{workId}/cancel` |
| `decision.create` | `POST /decisions` |
| `decision.edit_draft` | `PATCH /decisions/{decisionId}` |
| `decision.submit` | `POST /decisions/{decisionId}/submit` |
| `decision.approve` | `POST /decisions/{decisionId}/approve` |
| `decision.reject` | `POST /decisions/{decisionId}/reject` |
| `decision.withdraw` | `POST /decisions/{decisionId}/withdraw` |
| `decision.start_revision` | `POST /decisions/{decisionId}/revisions` |
| `memory.edit_generated` | `PATCH /memories/{memoryId}` |
| `memory.submit` | `POST /memories/{memoryId}/submit` |
| `memory.approve` | `POST /memories/{memoryId}/approve` |
| `memory.reject` | `POST /memories/{memoryId}/reject` |
| `memory.reopen` | `POST /memories/{memoryId}/reopen` |
| `organization.read_members` | `GET /organizations/{organizationId}/members` |
| `organization.invite_member` | `POST /organizations/{organizationId}/members` |
| `organization.resend_invitation` | `POST /organizations/{organizationId}/members/{membershipId}/resend-invitation` |
| `organization.revoke_invitation` | `POST /organizations/{organizationId}/members/{membershipId}/revoke-invitation` |
| `events.inspect_failed` | `GET /admin/events/failed` |
| `events.retry` | `POST /admin/events/{eventId}/retry` |
| `events.skip` | `POST /admin/events/{eventId}/skip` |
| `events.replay_domain_consumer` | `POST /admin/events/replay/consumer` |
| `events.replay_projection` | `POST /admin/events/replay/projection` |

The `operation` value recorded for observability is the permission identifier, so
`POST /works/{workId}/complete` reports `work.complete`. Route and telemetry cannot
drift apart.

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
