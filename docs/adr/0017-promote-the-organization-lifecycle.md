# ADR-0017: Promote the Owner-Held Organization Lifecycle and Defer Platform Suspension

**Status:** Proposed  
**Date:** 2026-07-30  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** before a platform-operator identity is introduced, when billing or abuse enforcement needs to suspend an Organization against its Owner's wishes, or when an Archived Organization must return to Active

**Scope classification:** MVP Normative

## Context

`docs/architecture/identity-and-organization.md` specifies a three-state Organization
lifecycle in full — `SuspendOrganization`, `ReactivateOrganization`, and
`ArchiveOrganization`, each with preconditions, an event, and effects — and
`docs/architecture/events-and-outbox.md` registers `OrganizationSuspended`,
`OrganizationReactivated`, and `OrganizationArchived`.

None of it is implementable today. `docs/product/mvp.md` lists what the MVP must support
for an Organization — creation, naming, basic settings, invitation, acceptance, Member
removal, viewing Members — and the lifecycle is not among them. `docs/architecture/authorization.md`
names no permission for any of the three, not even as Reserved. Under
[ADR-0010](0010-classify-blueprint-scope-and-implementation-authority.md) that makes the
lifecycle a Future Hypothesis: "Future commands, events, states, interfaces, schemas, and
provider choices are illustrative until" an accepted implementation ADR and a
scope-document update exist.

Half of it is nonetheless already built, and not by accident. The `organizations` table
carries `status`, `suspended_at`, and `archived_at`; `OrganizationStatus` admits all three
values; and `PrincipalResolver` refuses every request whose Organization is not `Active`.
The *effects* of suspension are enforced. Only the commands that would cause them are
missing, so the states are reachable today only by editing the database by hand.

### One structural fact decides the shape of this ADR

`PrincipalResolver` rejects a non-`Active` Organization with `organization_unavailable`,
which `RequestContextGuard` reports as `404`. The guard runs before every handler. So
while an Organization is `Suspended`, **every route authorized by Membership in it is
unreachable** — including any route that would reactivate it. This is not a detail of the
current implementation to be worked around; it is the documented behaviour of the
Organization state, verified end to end (`GET /works` against a Suspended Organization
returns `404`).

A `ReactivateOrganization` route authorized the ordinary way would therefore be dead code:
correct, tested against the Aggregate, and impossible to call. A `SuspendOrganization`
route shipped without a reachable reactivation is worse than dead — it is a one-way door
that leaves an Organization permanently inaccessible to everyone who owns it.

### Two different capabilities share one name

The documents describe suspension with two incompatible sets of reasons.

| | Who acts | Why | Reversible by the Owner |
|---|---|---|---|
| Organization-initiated | The Organization's Owner | pausing the Organization's own operations | Yes — the point of it |
| Platform-initiated | The operator running AIOS | "billing resolution", "security investigation" | No — "Suspension rules must fail closed" |

Only the first is expressible in the MVP's authority model. Permissions are "evaluated
within one Organization" and held through a Membership; the platform operator holds no
Membership in the tenant it is acting on. `docs/architecture/authorization.md` already
defers exactly this: "Cross-Organization replay, support impersonation, and break-glass
recovery require a separate future identity, approval, customer-visibility, and audit
design."

Archival has no such ambiguity. The document assigns it plainly: "Archival requires:
authorized **Owner** action".

## Decision

### The smallest useful vertical slice is the Owner-held lifecycle

AIOS promotes to MVP Normative exactly three commands, all held by the Organization's
Owner and no one else:

```text
organization.suspend
organization.reactivate
organization.archive
```

`OrganizationOwner` alone holds them. `OrganizationAdmin` does not: an Admin who could
suspend an Organization could lock its Owners out of the only route that recovers it,
which inverts the authority model the Owner role exists to express.

Every other part of the documented lifecycle stays a Future Hypothesis. In particular this
ADR does **not** promote per-status read policies, retention or export processing, or the
"restricted administrative review" access that the suspension section anticipates.

### Reactivation is exempt from the Organization-status check, and only from that

A fourth exemption joins the three [ADR-0014](0014-adopt-rest-with-explicit-command-sub-resources.md)
records, and it is the narrowest of them:

```text
POST /organizations/{organizationId}/reactivate
```

The route resolves the Organization and the Membership exactly as every other route does.
It requires an authenticated subject, an Active Membership, and the `organization.reactivate`
permission, which only an Owner holds. It differs in one respect: it tolerates a
`Suspended` Organization where every other route refuses one.

`identity-and-organization.md` anticipates this rather than merely permitting it —
"Suspension may allow restricted access for: Organization recovery" — and recovery by the
Organization's own Owner is the narrowest reading of that sentence.

The exemption does not extend to `Archived`. Archival is terminal: "An Archived
Organization does not return to Active in the MVP."

### Platform-initiated suspension is deferred, explicitly

Suspension for billing resolution or security investigation is **not** promoted. It
requires a principal that holds authority over an Organization without a Membership in it,
which is the future identity design `authorization.md` already defers, and it requires
suspension to be irreversible by the Owner — the opposite of what this slice ships.

Building the Owner's pause button now does not prejudge that design. A platform-initiated
suspension will need to record *who* suspended and refuse Owner reactivation on that
basis; that is a new field and a new rule on an Aggregate that will already exist, not a
rewrite.

### Archival is refused while Work is live

The document offers the rule as a recommendation — "An Organization may be archived only
when no Work remains InProgress or WaitingForDecision" — and this ADR adopts it as
normative. Archival makes an Organization read-only; a Work left `InProgress` in a
read-only Organization can never be completed or cancelled, so archival would manufacture
records that no command can ever resolve.

The check spans Aggregates, so the Application Layer enforces it, exactly as it enforces
the Last Owner Invariant. Suspension carries no such rule: it is reversible, so a Work
paused by it can still be finished afterwards.

## Alternatives considered

### Implement the lifecycle without a reactivation route

Rejected. It is the one-way door described above. An Organization suspended by its Owner
would be recoverable only by an operator with database access, which converts a product
capability into a support ticket.

### Authorize reactivation with a token, as invitation acceptance is

Rejected. It solves a problem that does not exist here. The invitation token exists
because the caller has no Membership yet; a suspended Organization's Owner has an Active
Membership and a resolvable principal. Introducing a second credential type to work around
a status check would add a token to mint, deliver, store, and expire — and a new way to
lose an Organization.

### Promote the full documented lifecycle, including platform suspension

Rejected under ADR-0010's promotion rule: "Promotion must identify the smallest useful
vertical slice. It must not activate every concept described in the future model by
default." Platform suspension additionally depends on an identity model that no accepted
ADR provides.

### Leave the lifecycle unimplemented

Rejected, but it was the status quo for a reason and the cost of changing it is real. The
counter-argument is that `Suspended` and `Archived` are already reachable states with
already-enforced effects — the schema stores them and the resolver acts on them. A state a
system can be in, but has no command to enter or leave, is not out of scope; it is a gap
that only manual database edits can fill.

## Consequences

The Organization gains a reversible pause and a terminal archive, both reachable by the
Owner, and the `Suspended` state stops being a condition only a DBA can produce.

`RequestContextGuard` gains a second exemption mechanism, and it is a mechanism worth
watching: a route marked recoverable-while-suspended bypasses the check that makes
suspension mean anything. One route carries the mark today. Any second one is a defect
until this ADR is amended, and `scripts/check_routes.py` cannot detect the difference —
review must.

Suspension is not an enforcement tool in this release. An operator who needs to suspend an
Organization against its Owner's wishes still cannot, and should not be told otherwise by
the presence of these commands.

Archival can be refused for a reason the caller cannot see in the request: live Work
elsewhere in the Organization. The refusal names the count rather than the Work, since a
caller entitled to archive is entitled to know how much is outstanding, and an Owner holds
no relationship to every Work by default.

## Related documents

- [ADR-0010: Classify Blueprint Scope and Implementation Authority](0010-classify-blueprint-scope-and-implementation-authority.md)
- [ADR-0013: Bind Clerk as the Authentication Provider](0013-bind-clerk-as-authentication-provider.md)
- [ADR-0014: Adopt REST with Explicit Command Sub-Resources](0014-adopt-rest-with-explicit-command-sub-resources.md)
- [Identity and Organization](../architecture/identity-and-organization.md)
- [Authorization](../architecture/authorization.md)
- [MVP Product Definition](../product/mvp.md)
- [Document Governance](../document-governance.md)
