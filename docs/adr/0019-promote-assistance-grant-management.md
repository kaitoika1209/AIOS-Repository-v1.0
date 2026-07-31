# ADR-0019: Promote Assistance Grant Management and Enable the Secretary at Bootstrap

**Status:** Proposed  
**Date:** 2026-07-31  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** when a second assistance context or operation is added, when a port contract version changes, or when an Organization needs to see which grants it currently holds

**Scope classification:** MVP Normative

## Context

`docs/product/mvp.md` states two things that cannot both be true of the system as
built:

- "The MVP supports one Secretary for each Organization", which may "prepare Decision
  material" among other advisory work; and
- "Every invocation requires an active Organization-, Secretary-, context-, operation-,
  and port-version-specific assistance grant."

Nothing creates a grant. `secretary_assistance_grants` is written by the development seed
and by test fixtures, and by nothing else. An Organization created through
`POST /organizations` therefore has a Secretary that refuses every request it is asked to
perform, with `ASSISTANCE_NOT_GRANTED`, permanently.

[ADR-0011](0011-bound-secretary-to-context-owned-assistance-ports.md) requires the grant
and describes its five identity fields, but does not say who issues one.
`docs/architecture/authorization.md` has no permission for the act. Under
[ADR-0010](0010-classify-blueprint-scope-and-implementation-authority.md) that leaves grant
management unimplementable: a capability rank 2 requires, with no rank 3 name and no
route.

This was found by the Release Acceptance Criteria suite, which had to write a grant
directly to demonstrate anything about the Secretary at all.

### The Secretary must not grant itself anything

`mvp.md` lists what the Secretary must never do, and "grant or change permissions" is on
it. Whatever issues a grant is a Human command. The schema already agrees:
`granted_by_membership_id` is `NOT NULL` with a composite foreign key into `memberships`,
so every grant is attributable to a Member of the same Organization. There is no shape in
which the platform grants on an Organization's behalf without inventing a Membership.

## Decision

### Two commands, promoted to MVP Normative

```text
organization.grant_assistance
organization.revoke_assistance
```

Held by `OrganizationOwner` and `OrganizationAdmin`, the pair that holds every other
administrative permission. Enabling advisory drafting is administration, not ownership:
the Secretary gains no authority to approve, complete, or decide anything, and revocation
is always available to the same roles.

A grant names an **operation**. Its context and port contract version are not caller
input — they come from the code-declared registry that ADR-0011 requires
(`ASSISTANCE_OPERATIONS`, `DECISION_PORT_CONTRACT_VERSION`). An operation the build does
not declare is refused at the edge, so "unknown contexts, operations, versions, tools,
models, or source types fail closed" holds at the granting boundary as well as at the
invocation boundary.

Revocation stamps `revoked_at` on the active row and leaves it there, as role revocation
does. A grant that once existed is part of what an auditor needs.

### Organization bootstrap grants the baseline operations

Creating an Organization grants every operation in the registry, attributed to the founding
Owner's Membership.

This is not the platform granting on the Organization's behalf. The founding Owner is the
actor, their Membership is created in the same transaction, and the grant carries their
identifier — which is exactly what `granted_by_membership_id` demands. What the bootstrap
does is spare every new Organization a mandatory second step to reach the state `mvp.md`
describes as the default: an Organization with a working Secretary.

Deny-by-default is unaffected. It is a property of the invocation check, which still
requires an active grant for the exact five-field identity, and still fails closed for
anything the registry does not declare. What changes is who has to perform the first
grant, not whether one is required.

Bootstrap alone would be a dead end of a familiar kind — an Organization that revoked a
grant could never restore it, and an Organization that predates a newly added operation
could never enable it. The two commands are what prevent that, which is why this ADR
promotes both rather than only provisioning at creation.

### Reading the current grants is not promoted

There is no `GET` route and no `organization.read_assistance_grants` permission.

ADR-0010 warns against "generic abstractions without an MVP caller and test", and nothing
consumes such a route: there is no settings UI, the operation registry is a short
code-declared list a reader can consult directly, and both commands are idempotent on the
natural key — granting what is already granted, or revoking what is not, is answered
without first reading. The authorization audit records every grant and revocation.

When an Organization-settings surface exists, it will need the read, and that is the
moment to add it.

## Alternatives considered

### Grant at bootstrap only

Rejected. It makes the common case work and leaves two dead ends: a revoked grant could
never be restored, and an Organization created before a new operation was added could
never enable it. Both would be reachable only by editing the database.

### Routes only, with no bootstrap provisioning

Rejected, though it is the more literal reading of deny-by-default. Every new Organization
would start with a Secretary that refuses everything until an Owner performs a step no
part of the product tells them about. `mvp.md` presents one Secretary per Organization as
a property of an Organization, not as an opt-in.

The cost of choosing otherwise is real and worth stating: an Organization that wants no
Secretary must revoke rather than decline. Revocation is one command, held by the same
roles, and the audit records it.

### Let the caller supply the context key and contract version

Rejected. It would make the grant's identity partly caller-controlled, and a caller that
can name a context can name one the ports do not own. The registry is the allowlist
ADR-0011 requires; the request names an operation and the server resolves the rest.

### Treat grants as deployment configuration

Rejected. `granted_by_membership_id` is `NOT NULL` and references a Membership in the same
Organization, so configuration has nobody to attribute a grant to. It is also the wrong
model: which Organizations have enabled their Secretary is tenant state, not a property of
the deployment.

## Consequences

A newly created Organization can use its Secretary immediately, and can turn it off. The
acceptance suite no longer has to write a grant row to demonstrate anything about the
Secretary.

Two permissions govern an AI Principal's authority, which makes the role-to-permission map
slightly less complete as a description of who can do what to whom: an Admin holding
`organization.grant_assistance` is granting capability to something that is not a Member.
The permission name says `assistance` rather than `role` for that reason.

Nobody can ask the system what its Secretary is currently allowed to do. That is a real
limitation of this slice, chosen over building a route with no consumer, and it becomes a
gap worth closing as soon as an Organization-settings surface exists.

## Related documents

- [ADR-0010: Classify Blueprint Scope and Implementation Authority](0010-classify-blueprint-scope-and-implementation-authority.md)
- [ADR-0011: Bind the Secretary to Context-Owned AI Assistance Ports](0011-bound-secretary-to-context-owned-assistance-ports.md)
- [ADR-0014: Adopt REST with Explicit Command Sub-Resources](0014-adopt-rest-with-explicit-command-sub-resources.md)
- [ADR-0018: Promote Role Assignment and Revocation](0018-promote-role-assignment.md)
- [Authorization](../architecture/authorization.md)
- [MVP Product Definition](../product/mvp.md)
