# ADR-0018: Promote Role Assignment and Revocation, and Forbid Self-Assignment

**Status:** Proposed  
**Date:** 2026-07-30  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** before a custom-role or policy-editor feature is considered, when ownership transfer needs to be atomic rather than two commands, or when a role is added to the catalogue

**Scope classification:** MVP Normative

## Context

An Organization's roles are fixed at invitation time and can never change afterwards.
`inviteToOrganization` takes a role, `organization_invitations` carries it, acceptance
writes the assignment row — and nothing in the system writes another one. There is no
promotion, no demotion, and no correction of a mistaken invitation.

`docs/architecture/authorization.md` lists `organization.assign_role` and
`organization.revoke_role` as Reserved: "They have no route and no role grant. Adding one
is a scope change under ADR-0010, not an editing decision."

### The Last Owner Invariant already depends on a command that does not exist

This is not a missing convenience. The invariant is implemented, shipping, and reachable:

```
POST /organizations/{id}/members/{ownerMembershipId}/suspend
→ 409 {"code": "LAST_OWNER_REQUIRED",
       "message": "The Organization must keep at least one active Owner."}
```

`identity-and-organization.md` says what to do about that refusal — "The Organization must
first: assign another Owner; transfer ownership; suspend or archive the Organization
through an explicit workflow". [ADR-0017](0017-promote-the-organization-lifecycle.md)
delivered the third. The first two have no command at all, so an Organization created with
one Owner has exactly one Owner forever: that Membership can never be suspended, revoked,
or replaced while the Organization is Active.

An invariant whose documented remedy is unreachable is not protecting anything. It is a
dead end that the error message actively points callers toward.

### The schema already models the answer

`membership_role_assignments` carries `revoked_at`, `revoked_by_identity_id`,
`revoked_by_membership_id`, and `revocation_reason`; a partial unique index
`uq_membership_role_assignments_active` on `(membership_id, role) WHERE revoked_at IS NULL`
enforces one active assignment per role; and `ix_membership_roles_active_owners` exists to
make the Last Owner check cheap. The append-only lifecycle the document describes — "The
lifecycle is append-only from an audit perspective" — is already expressible. Only the
commands are missing.

## Decision

### Two commands, promoted to MVP Normative

```text
organization.assign_role
organization.revoke_role
```

Both are held by `OrganizationOwner` and `OrganizationAdmin`, the same pair that holds
every other membership-administration permission.

Assignment inserts a row. Revocation stamps `revoked_at` on the active row and leaves it
in place. Neither deletes anything: "There is no direct mutable role-array replacement
without audit events."

### Granting or removing `OrganizationOwner` requires an Owner

`identity-and-organization.md` states the policy — "Only an active OrganizationOwner may
assign another Owner" — and this ADR extends it to revocation for the same reason. An
Admin who could revoke Ownership could remove every Owner one at a time until only the
Last Owner Invariant stood between them and an Organization they controlled outright.

The permission is therefore necessary but not sufficient: the *target role* narrows who
may act. An Admin holding `organization.assign_role` may grant `Member`, `Reviewer`, or
`OrganizationAdmin`, and is refused on `OrganizationOwner`.

### Nobody may assign themselves a role

"Self-escalation policy permits the action" is a rule the documents require and do not
define. This ADR defines it in the strongest form that costs nothing:

> An actor may not assign any role to their own Membership.

Not "may not assign themselves a higher role", because that requires ranking roles, and
the catalogue is a set rather than a ladder — `Reviewer` is not above or below `Member`.
A flat prohibition needs no ranking and cannot be defeated by adding a role later.

The cost is that an Owner cannot grant themselves a role they lack. It is not a real cost:
`OrganizationOwner` already holds every permission any other role holds, so there is
nothing for an Owner to gain by self-assignment.

Revoking one's *own* role stays permitted. Stepping down is not escalation, and the Last
Owner Invariant already refuses the one case that matters — the final Owner removing their
own Ownership.

### Ownership transfer stays a Future Hypothesis

`OrganizationOwnershipTransferred` is a registered event name and is **not** promoted. Two
commands already achieve the outcome — assign the new Owner, then revoke the old one — and
in that order the Last Owner Invariant is satisfied at every step, so nothing is at risk
between them.

An atomic `TransferOwnership` would buy the guarantee that the two never come apart. That
is worth having when ownership transfer becomes a product flow with its own confirmation,
notification, and audit expectations. It is not worth inventing a third command now to
save a round trip.

## Alternatives considered

### Replace the role array in one command

Rejected. `identity-and-organization.md` forbids it outright — "There is no direct mutable
role-array replacement without audit events" — and the reason is visible in the schema: a
replacement cannot say who revoked what, or why, and `revocation_reason` would be
permanently null.

It would also make one route carry two permissions, which ADR-0014 allows only where a
transaction boundary forces it. Nothing forces it here.

### Let an Admin manage Ownership

Rejected. It makes `OrganizationAdmin` a strictly-more-powerful role than the one that
grants it, by way of a loop: an Admin could appoint themselves an accomplice Owner, or
strip the Owners in sequence. The Owner-only rule is what keeps the role hierarchy
acyclic.

### Rank roles and forbid upward self-assignment only

Rejected. The four roles are not a ladder. `Reviewer` and `Member` hold overlapping but
neither-contains-the-other permission sets, so a ranking would have to be invented, written
down, and kept correct as the catalogue changes. A flat self-assignment prohibition is
enforceable by inspection and survives a new role being added.

### Leave both Reserved

Rejected, and this is the alternative the repository has been living with. It is defensible
only while nothing depends on the commands, and something already does: the Last Owner
Invariant's own error message.

## Consequences

An Organization can change hands, correct a mis-scoped invitation, and demote a Member
without deleting and re-inviting them. The Last Owner Invariant becomes a rule with a
remedy rather than a trap.

`OrganizationOwner` becomes assignable after invitation. It stays absent from
`INVITABLE_ROLES` — an invitation is accepted by someone the Organization has not yet met,
and Ownership should be a deliberate second act rather than a property of the first email.

Two permissions now depend on a rule outside the permission catalogue: the target role. A
reader of the role-to-permission map alone will conclude an Admin can assign any role, and
be wrong. The refusal is a `403` that names neither the role nor the reason, consistent
with every other authorization denial, so the constraint has to be discoverable from
documentation rather than from probing.

Self-assignment being flatly forbidden means a single-Owner Organization cannot bootstrap a
second Owner from an Admin's account. Only the existing Owner can, which is the point, and
an Organization that loses its only Owner's access has no in-product recovery. That is the
same gap platform-operator identity would close, deferred by ADR-0017 and still deferred.

## Related documents

- [ADR-0010: Classify Blueprint Scope and Implementation Authority](0010-classify-blueprint-scope-and-implementation-authority.md)
- [ADR-0014: Adopt REST with Explicit Command Sub-Resources](0014-adopt-rest-with-explicit-command-sub-resources.md)
- [ADR-0017: Promote the Owner-Held Organization Lifecycle](0017-promote-the-organization-lifecycle.md)
- [Identity and Organization](../architecture/identity-and-organization.md)
- [Authorization](../architecture/authorization.md)
- [MVP Product Definition](../product/mvp.md)
