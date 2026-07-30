# MVP Security and Production Readiness

> **Document status:** Normative  
> **Blueprint version:** 0.2.1  
> **Applies to:** MVP release candidates and production environments

## Purpose

This document is the final implementation approval gate for the MVP architecture. It composes existing Domain, authorization, persistence, event, Worker, data-governance, and operations rules into evidence that a named Human release authority can use for a go/no-go decision. It does not transfer invariants to an operations checklist and does not authorize the Secretary to make release decisions.

## Gate record

Every gate result records:

```text
gateId, controlVersion, result
environmentId, releaseArtifactDigest, schemaFingerprint
evidenceReferences, executedAt, expiresAtOrNextTestAt
humanOwner, humanApprover, exceptionReference?
```

Evidence must come from the release candidate or a production-equivalent environment. Screenshots and prose assertions may supplement, but cannot replace, reproducible commands, tests, deployment records, immutable logs, or provider evidence.

## Security and tenant trust model

### Trusted context

- Authentication maps the provider assertion to a stable Principal identity.
- The server derives active Membership and `organizationId`; a body, header, route, event payload, AI output, or cached session cannot grant membership.
- Authorization is evaluated at execution time. Revoked membership or disabled identity fails closed.
- Cookie-based authentication uses secure, HTTP-only, same-site cookies and CSRF protection. Tokens have bounded lifetime, audience and issuer validation, and no sensitive content in browser storage.
- Error responses and resource lookup do not disclose foreign-Organization existence.

### Organization isolation

Every authoritative and read path must preserve Organization scope:

- Application Service commands carry a trusted actor and Organization context.
- Organization-owned repository methods require `organizationId`; unscoped generic access is not exposed to runtime code.
- Relationships use same-Organization composite keys or an equally strong structural constraint.
- events, Outbox rows, processed-event state, idempotency keys, ordering keys, caches, object keys, search documents, exports, logs, and reconciliation findings retain Organization scope;
- Workers validate event Organization against registration, source, target, and current capability before mutation; and
- support, migration, backup, and recovery access cannot impersonate a Member or create Human intent.

The initial schema does not enable RLS under ADR-0014. Before production, the access-path inventory and tests must prove that all runtime SQL is reached through scoped repositories, all runtime roles lack superuser, schema-owner, replication, trigger-disable, truncate, and `BYPASSRLS` authority, and connection reuse cannot preserve another Organization's context.

RLS reconsideration is mandatory before any of the following ships:

- direct tenant or analyst SQL against the authoritative database;
- shared ad-hoc reporting outside scoped repositories;
- a runtime repository or query facility that cannot require Organization scope;
- a new administrative integration with broad row access; or
- isolation evidence that depends primarily on code review rather than executable tests.

### AI and external providers

- Only a versioned, allowlisted, minimum-necessary snapshot may leave the platform.
- Secrets, credentials, hidden authorization context, unrelated tenant content, and unapproved personal data are excluded.
- Provider, model, region, retention/training setting, purpose, prompt/template version, and response provenance are recorded according to ADR-0012 without logging full Restricted content.
- Provider output is untrusted input: it cannot supply identity, Organization, permission, Domain truth, approval, Work completion, or Memory approval.
- Prompt injection and tool-output text cannot broaden capabilities. External side effects require a separately registered and reviewed contract.
- Provider timeout, ambiguity, or refusal leaves authoritative business state valid and recoverable.

### Secrets, cryptography, and network

- Production secrets come from an approved managed store, are distinct by environment and role, never committed, and never appear in logs, traces, errors, support bundles, or AI prompts.
- Rotation is tested; suspected exposure triggers immediate revocation, replacement, evidence preservation, and dependent-service verification.
- TLS is required in transit. PostgreSQL storage, durable payloads, exports, and backups are encrypted at rest with access to backup keys separated from application credentials.
- Inbound and outbound connectivity is allowlisted to the minimum required paths. Administrative access is strongly authenticated, time-bounded where possible, and audited.

### Audit and data governance

- Authoritative Human actions, denied sensitive actions, policy and role changes, support/break-glass access, replay/skip, migration, backup/restore, secret operations, and release approval are auditable.
- Audit records use stable identities, Organization, policy/contract version, correlation and causation, reason code, outcome, and safe before/after references or hashes; they do not duplicate secrets or Restricted content unnecessarily.
- Ordinary runtime roles cannot update or delete audit history. Retention, legal hold, Organization deletion, personal-data correction/erasure, backup expiry, and post-restore deletion replay follow ADR-0012 and approved policy.

## Required production gates

| Gate | Required evidence | Blocking conditions | Human owner |
|---|---|---|---|
| Domain authority | State-machine, Aggregate, command, and negative-principal tests | any path where Decision completes Work, non-Human completes Work/approves Memory, or Approved Memory mutates | Product/Domain owner |
| Tenant isolation | access-path inventory; foreign-ID tests for commands, queries, events, Workers, caches and exports; real connection-pool tests; composite-FK verification | any cross-tenant read/write/reference, unscoped runtime repository, privileged runtime DB role, or unexplained Organization mismatch | Security owner |
| Identity and authorization | IdP configuration; revocation/session tests; policy-version evidence; CSRF/token tests; support-access test | stale authority restored, fail-open behavior, impersonation, shared Human identity, or unaudited privileged access | Security owner |
| Data protection | data-flow and classification inventory; provider settings; secret scan/rotation test; TLS/encryption evidence; retention approval | exposed secret, unapproved provider use/retention/region, plaintext Restricted data, or missing destructive-data policy | Security and Data owners |
| Database and migration | migration rehearsal; schema fingerprint; least-privilege grants; constraint and rollback/forward-fix evidence; lock/duration result | drift, failed invariant, unsafe destructive migration, no recovery point, or runtime schema ownership | Database owner |
| Async correctness | Outbox/consumer/Memory crash, duplicate, fencing, ordering, retry, dead-letter and replay tests; runtime-profile dashboards | lost required delivery, stale claim completion, retry storm, cross-tenant processing, unauthorized replay, or unbounded backlog | Worker owner |
| Recovery | successful isolated PITR exercise; measured RPO/RTO; integrity, authority, tenant, Outbox, audit and deletion-replay validation | no recoverable complete boundary, missed objective, partial restore, or unresolved external-effect ambiguity | Database and Operations owners |
| Observability and incident response | live dashboards; synthetic alert delivery; named on-call/escalation; exercised security, tenant, data-integrity and Worker runbooks | missing owner/destination, missing-data shown healthy, secrets/tenant IDs in metrics, or no containment path | Operations owner |
| Release safety | immutable artifact and SBOM/dependency evidence; vulnerability result; migration order; smoke test; rollback/forward-fix and maintenance procedure | unknown artifact, unresolved critical vulnerability, incompatible contract/schema, or no safe containment | Release owner |
| Capacity and dependencies | representative load/backlog recovery; connection budget; tenant fairness; provider outage/throttle tests | pool exhaustion removes operational reserve, one tenant starves others, or dependency failure corrupts/authorizes state | Operations owner |

## Test scenarios that must fail closed

At minimum, automated or exercised tests cover:

1. a valid Member requests another Organization's known and random identifiers;
2. a request claims an Organization different from the authenticated Membership;
3. a connection is reused after success, failure, rollback, timeout, and cancellation;
4. a forged or replayed event has mismatched Organization, causation, contract, or capability;
5. Secretary text asks a tool or handler to approve, complete, replay, or expose another tenant;
6. membership is revoked between request authentication and command execution;
7. duplicate delivery, Worker crash, lease expiry, and stale finalization race;
8. provider timeout and late response after lease loss;
9. secret rotation while HTTP and Worker processes are active;
10. backup restore followed by tenant, audit, Outbox, external-effect, and deletion reconciliation;
11. missing telemetry, broken alert delivery, and unavailable external dependency; and
12. a migration fails before, during, and after a transactionally irreversible step.

No test cleanup may hide a durable failure that production recovery would need to handle.

## Observability constraints

Dashboards and alerts must expose aggregate health without turning metrics into a tenant directory. Organization, Principal, Aggregate, event, operation, ordering key, prompt, payload, and secret values are prohibited as metric labels. Authorized logs and traces may carry safe opaque correlation identifiers, with Restricted payloads omitted.

Security, tenant-isolation, Human-authority, immutable-approval, data-integrity, and backup-recoverability failures page or escalate by severity and never consume an error budget. Missing collectors or absent expected series are `Unknown`, not healthy.

## Exception policy

Only a named Human authority can approve a time-bounded exception. The record includes the failed gate, affected environment/artifact, blast radius, reason, compensating control, detection, owner, remediation, expiry, and revalidation condition.

Exceptions are prohibited for an active or unexplained cross-Organization path, non-Human authoritative action, mutation of approved history, exposed production secret without completed containment, inability to restore the complete consistency boundary, or unexplained integrity loss.

Expired exceptions automatically fail the gate. The Secretary may summarize evidence but cannot approve an exception.

## Approval sequence

1. Engineering records the exact artifact, schema fingerprint, configuration and evidence set.
2. Each control owner signs only the gates they own.
3. Security reviews tenant, identity, data protection, provider, and exception evidence.
4. Operations verifies SLO, alert, runbook, capacity, deployment, incident, and recovery evidence.
5. Product/Domain confirms the Human-authority and lifecycle invariants.
6. The named Human release approver records `Approved` or `Rejected` with all gate results.
7. Deployment automation verifies the approval references the exact artifact and unexpired evidence before production promotion.

No single deployment account, Secretary, Worker, or migration role can manufacture the complete approval record.

## Post-release verification

Immediately after promotion, verify authentication, tenant-scoped read/write, authoritative command audit, Outbox publication, local consumer progress, Work-to-Memory generation, dashboards, alert delivery, schema fingerprint, backup/WAL continuity, and absence of cross-Organization or authority findings. A failed critical check enters the documented containment or rollback/forward-fix path; it is not dismissed as eventual consistency.

Restore exercises remain at least monthly. Access, secret, dependency, threat-model, and tenant-path reviews repeat after material change. Gate evidence expires according to the control, even when the application artifact is unchanged.

## MVP exclusions

The following are not automatically required for MVP approval: multi-region active-active, microservice extraction, a dedicated authorization service, customer-authored policy language, broad replay, direct tenant database access, a dedicated SIEM, or autonomous AI operations. A contract, regulation, material threat, or measured scale may promote one through a new ADR.

## Related documents

- [ADR-0016](../adr/0016-establish-mvp-security-and-production-readiness-gate.md)
- [Authorization](authorization.md)
- [Persistence](persistence-and-data-model.md)
- [MVP Database Migration Plan](mvp-database-migration-plan.md)
- [Worker Runtime Profile](worker-runtime-profile.md)
- [Events and Outbox](events-and-outbox.md)
- [Operations](../../observability-and-operations.md)

