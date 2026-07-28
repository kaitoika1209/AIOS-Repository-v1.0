# ADR-0013: Bind Clerk as an Authentication Provider Without Ceding Identity Ownership

**Status:** Proposed  
**Date:** 2026-07-28  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** before adding a second identity provider, before enabling Clerk Organizations for any purpose, when Clerk changes its session or webhook contract, or when SCIM or enterprise SSO enters scope

## Context

`docs/engineering/tech-stack.md` selects Clerk for authentication, citing organization
support among its benefits. Clerk models Organizations, memberships, roles, and
invitations natively, so a naive integration would let Clerk own those concepts.

The architecture already forbids that outcome, but never named Clerk:

- [Identity and Organization](../architecture/identity-and-organization.md) defines an
  Organization Aggregate, a Membership Aggregate with an `Invited → Active → Suspended →
  Revoked` lifecycle, and `membership_role_assignments` with revocation history.
- The same document states that domain Aggregates **must not** store external identity
  provider subject identifiers, and that external subjects are not domain actor
  identifiers.
- [Authorization](../architecture/authorization.md) defines four Organization roles and
  twenty-five permissions narrowed by resource relationships.
- [Persistence and Data Model](../architecture/persistence-and-data-model.md) makes
  `organization_id` the tenant-isolation column enforced in PostgreSQL, and states that
  AIOS should not store passwords when authentication is delegated.
- [ADR-0001](0001-adopt-domain-driven-design.md) makes the domain model the source of
  truth and requires frameworks to support the domain rather than define it.

Two questions remain open in practice, and both are answered the same way:

1. Does Clerk or AIOS own Organization, Membership, and role state?
2. How does a Clerk session become an AIOS actor identifier?

Left unstated, an implementer will reach for Clerk Organizations because it is the
faster path, and will discover only later that the role model, membership lifecycle,
tenant isolation, and audit requirements cannot be expressed there.

## Decision

### Clerk authenticates. AIOS owns identity, Organization, and authority.

Clerk is an authentication provider only. It answers exactly one question: *which
external subject is making this request?*

Clerk is **not** the source of truth for:

- Organization existence, status, or lifecycle;
- Membership existence, status, or lifecycle;
- roles or permissions;
- invitations that carry business meaning; or
- any value used in an authorization decision.

### Clerk Organizations are not used

The MVP does not enable Clerk Organizations, Clerk organization roles, Clerk
organization invitations, or Clerk permissions.

The Organization Aggregate, Membership Aggregate, and `membership_role_assignments`
remain the only authority. Enabling Clerk Organizations later requires a new ADR,
because it would create a second source of truth for the tenant boundary.

### Subject mapping is the only integration point

A Clerk subject reaches the domain through the existing
`AuthenticationSubjectReference` contract, resolved once per request at the edge:

```text
Clerk session
      ↓  verify token
provider = "clerk", issuer, subject
      ↓  authentication_subject_references lookup
identityId                       (fails closed if absent)
      ↓  memberships lookup, scoped by organizationId
membershipId + status
      ↓  membership_role_assignments (revoked_at IS NULL)
roles
      ↓
HumanMemberPrincipal { identityId, membershipId, organizationId, roles }
```

`HumanMemberPrincipal` is what the Application Layer receives. No layer below the edge
sees a Clerk token, session, user object, or subject string.

### Domain rules that follow

1. `provider`, `issuer`, and `subject` are stored **only** in
   `authentication_subject_references`. No Aggregate, projection, event payload, Outbox
   message, or audit record stores them.
2. Every actor field — `created_by_identity_id`, `approved_by_identity_id`,
   `completed_by_identity_id`, and equivalents — stores an AIOS `identityId`.
3. An unmapped Clerk subject is **not** implicitly provisioned into an Organization.
   It may create a Human Identity, but Membership is granted only through the AIOS
   invitation flow.
4. Resolution fails closed. A missing identity, a non-`Active` identity, a missing
   Membership, a non-`Active` Membership, or a non-`Active` Organization yields no
   principal and therefore no authority.
5. Clerk metadata is never read for authorization. Roles come from
   `membership_role_assignments` only.
6. Disabling an identity in AIOS revokes authority regardless of Clerk state. Clerk
   remains able to authenticate; AIOS declines to issue a principal.

### Email is provider data, not identity

`human_identities.primary_email` and `display_name` are AIOS-owned profile values,
synchronizable from Clerk but never used as a join key. Identity is keyed by
`identity_id`; the subject tuple is the only external key.

### Webhooks are advisory

Clerk webhooks may update profile fields and may mark an identity `Disabled`. They must
not create Organizations, create Memberships, assign roles, or alter any Aggregate
state that carries business authority. Webhook payloads are untrusted input and are
verified before use.

## Alternatives considered

### Use Clerk Organizations as the tenant boundary

Rejected. Clerk cannot express the four-role model narrowed by resource relationships,
the `Invited → Active → Suspended → Revoked` Membership lifecycle with revocation
reasons and history, or the `Suspended`/`Archived` Organization states. Tenant isolation
must be enforceable in PostgreSQL alongside the data it protects; an external service
cannot participate in that transaction. It would also make the domain depend on a
framework, contradicting ADR-0001.

### Store the Clerk subject on Aggregates for convenience

Rejected. `identity-and-organization.md` forbids it explicitly. It would couple every
historical record to one vendor, break the actor model if a subject is re-issued or a
provider is replaced, and make provider migration a data migration across every
Aggregate.

### Mirror Clerk Organizations into AIOS by webhook

Rejected. Two writable sources of truth for the tenant boundary, reconciled
asynchronously, with authorization depending on the result. Any drift is a
cross-tenant access defect.

### Defer the decision until authentication is implemented

Rejected. The mapping determines the identity schema, the request pipeline, and every
actor column. Deciding it after those exist is a rewrite.

## Consequences

Benefits:

- the tenant boundary, role model, and audit trail stay inside PostgreSQL where they can
  be enforced transactionally;
- Clerk is replaceable by adding a row type to
  `authentication_subject_references`, with no Aggregate migration;
- the domain remains framework-independent as ADR-0001 requires; and
- authorization has exactly one source, so drift cannot become a cross-tenant defect.

Costs:

- invitation, membership, and role management must be built in AIOS rather than adopted
  from Clerk, which is real MVP scope;
- profile data is duplicated between Clerk and `human_identities` and needs a
  synchronization path; and
- one extra lookup per request to resolve subject → identity → membership → roles, which
  should be cached per request.

## Related documents

- [Identity and Organization](../architecture/identity-and-organization.md)
- [Authorization](../architecture/authorization.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [ADR-0001](0001-adopt-domain-driven-design.md)
- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [Technology Stack](../engineering/tech-stack.md)
- [MVP Scope](../product/mvp.md)
