# Production Readiness Evidence Record

> **Control version:** `mvp-production-gate-v1`  
> **Decision status:** Not approved — production-equivalent evidence and named Human signatures required

This record is the handoff from implementation verification to the Human production decision. It must be instantiated for one exact environment, immutable `sha256` artifact digest, schema fingerprint, and evidence-set digest. Repository tests demonstrate the gate mechanism; they are not production approval.

## Release identity

The release operator records:

- environment identifier and AWS account/Region;
- immutable image or artifact `sha256` digest;
- schema fingerprint produced by the reviewed migration set;
- dependency lockfile and SBOM digests;
- configuration/profile versions;
- deployment and migration identifiers; and
- evidence-set digest covering every referenced immutable artifact.

Any artifact, schema, contract, provider-policy, or security-relevant configuration change invalidates approvals and requires a new release candidate.

## Gate evidence matrix

| Gate | Repository evidence available | Production-equivalent evidence still required | Required Human owner |
|---|---|---|---|
| Domain authority | Work, Decision, Memory lifecycle and negative-authority tests | release-candidate smoke and authorization audit | Product/Domain |
| Tenant isolation | Organization-scoped APIs, composite keys, foreign-ID tests | real connection-pool reuse, cache/export inventory and adversarial test | Security |
| Identity and authorization | principal resolution, membership and permission tests | IdP issuer/audience, session revocation, CSRF and support-access exercise | Security |
| Data protection | provider provenance, bounded telemetry, role grants | approved provider region/retention settings, managed-secret rotation, TLS/encryption and retention evidence | Security and Data |
| Database and migration | ordered migrations, PostgreSQL constraints and schema fingerprint | production-equivalent rehearsal, lock/duration measurement, recovery point and forward-fix evidence | Database/Data |
| Async correctness | Outbox, Decision outcome, Memory fencing, deterministic retry and stale-worker tests | deployed Worker dashboards and failure injection under production profile | Operations/Worker |
| Recovery | recovery schema and isolated-restore runbook | successful isolated PITR with measured RPO/RTO, integrity checks and deletion replay | Database and Operations |
| Observability and incident response | bounded metric dimensions, missing-data behavior and runbooks | live dashboards, synthetic alarm delivery and named responder acknowledgement | Operations |
| Release safety | CI build, test and migration verification | exact artifact SBOM, vulnerability scan, smoke test and containment/forward-fix exercise | Release |
| Capacity and dependencies | connection-budget validation and tenant-fair scheduler tests | representative load/backlog recovery and provider outage/throttle exercise | Operations |

## Runtime data-path inventory

The MVP runtime paths are Organization-scoped Application Services and repositories; HTTP, Worker, Outbox, processed delivery, Decision coordination, Memory source snapshot, generation, replay, reconciliation, audit, export, cache, and support paths must appear in the instantiated inventory. Each entry records query/repository owner, trusted Organization source, database role, composite constraint, cache/object-key scope, test reference, and whether it triggers the RLS reconsideration rule.

Production is blocked if a runtime query can omit Organization scope, a role owns the schema or has superuser/replication/trigger-disable/truncate/`BYPASSRLS`, connection reuse preserves tenant context, or a new direct reporting/admin path has not reconsidered RLS.

## Required Human approval sequence

1. Product/Domain signs Human authority and lifecycle gates.
2. Security signs tenant, identity, provider and data-protection gates.
3. Database/Data signs schema, migration, recovery and retention evidence.
4. Operations signs Worker, capacity, dashboards, alert delivery, runbooks and restore evidence.
5. Release authority verifies the exact artifact, evidence-set digest, expiry dates, vulnerability result and prior signatures, then records `Approved` or `Rejected`.

The Secretary and AI-generated analysis may assemble or summarize evidence but cannot populate a Human approval identity or final decision.

## Non-waivable blockers

No exception may cover cross-Organization access, non-Human authoritative action, Decision approval completing Work, missing explicit Human Work completion, Approved Memory mutation, duplicate Memory for one Work, source-snapshot corruption, missing required audit, an exposed production secret without containment, unresolved integrity loss, or inability to restore the complete PostgreSQL consistency boundary.

Other exceptions require a named Human approver, blast radius, compensating control, detection, remediation, expiry, and revalidation condition. Expiry automatically blocks promotion.

## Evidence expiry and post-release checks

Deployment automation re-evaluates evidence immediately before promotion. After promotion it verifies authentication, tenant-scoped read/write, command audit, Outbox and consumer progress, Work-to-Memory generation, dashboards, alert delivery, schema fingerprint, backup/WAL continuity, and absence of critical findings. Monthly restore and responder tests remain required even when the artifact is unchanged.
