# Observability and Operations Architecture

> **Scope classification:** Mixed — MVP Normative baseline, plus production-hardening and Future Hypothesis guidance  
> **MVP implementation authority:** Yes for the MVP baseline only  
> **Promotion requirement:** Accepted implementation ADR and scope-document update  
> **Authority rank:** see [Document Governance](../document-governance.md)

**Status:** Draft  
**Phase:** MVP Baseline with Production-Hardening and Future Guidance  
**Architecture:** Modular Monolith  
**Primary Database:** PostgreSQL  
**Event Delivery:** Transactional Outbox  
**Background Processing:** PostgreSQL-Backed Workers  
**Operational Model:** Observable, Recoverable, Human-Controlled

---

## Purpose

This document defines how AIOS is observed, operated, diagnosed, recovered, and safely changed in production.

It establishes the operational architecture for:

- structured logging
- distributed and local tracing
- correlation and causation
- metrics
- service-level indicators
- service-level objectives
- health checks
- dashboards
- alerting
- incident response
- deployment
- configuration
- secrets
- capacity planning
- operational automation
- recovery procedures

The objective is not merely to detect infrastructure failure.

AIOS observability must also make business workflow failures visible.

Examples include:

- Work remains blocked after a Decision outcome
- WorkCompleted is committed but Memory is not generated
- an Organization has no active Owner
- an event stream is blocked by a poison event
- a Worker repeatedly retries without progress
- a Human-authoritative command is attempted by a Secretary or System principal
- a submitted Decision revision is unexpectedly modified
- an Approved Memory becomes inconsistent with its reviewed revision
- a cross-Organization access attempt occurs

---

## Guarantee Ownership and Reconciliation Boundary

Observability detects evidence that an architectural guarantee failed. It does not own, define, or replace that guarantee.

The enforcement order is:

```text
Aggregate invariant or Domain Policy
    -> Application Service and authorization boundary
        -> PostgreSQL constraint or transaction rule where structurally enforceable
            -> reconciliation as independent detection
                -> recovery through the owning Application Service
```

A scheduled scan, alert, dashboard, or reconciliation Worker MUST NOT be the primary protection for a state that can be rejected synchronously by the owning Aggregate, Application Service, authorization policy, or database constraint.

Every reconciliation check MUST have a version-controlled catalog entry containing:

```text
findingType
guaranteeReference
owningModule
primaryPreventionLayer
databaseDefense
detectionSource
automaticRecoveryPolicy
humanInterventionPolicy
severityRule
validationQueryOrCommand
```

If `guaranteeReference`, `owningModule`, or `primaryPreventionLayer` is unknown, the check is not implementation-ready. A reconciliation finding is evidence of a failed or missing safeguard; it is not permission to accept invalid state as normal.

### MVP Integrity-Finding Classification

| Finding | Authoritative guarantee and prevention owner | Database defense | Reconciliation role | Recovery authority |
|---|---|---|---|---|
| `WorkGateOutcomeMissing` | Work owns its Completion Gate; the owning event handler applies a final Decision outcome through the Work Application Service. | Completion-gate state check and Organization-scoped Decision reference. | Detect a final Decision whose outcome is absent from the related Work after the delivery objective. | Replay the idempotent handler; otherwise a Human-approved Work repair command. |
| `MemoryGenerationMissing` | The Work-to-Memory use case starts only from committed `WorkCompleted`; the consumer and Memory module own idempotent generation. | Atomic processed-event, Memory, generation-outcome, and Outbox transaction; one active Memory per Work. | Detect a completed Work with no pending, generated, terminal-failure, or resolved generation record. | Automatic retry within policy; Human retry or abandonment after exhaustion. Work remains Completed. |
| `ActiveOrganizationWithoutOwner` | Organization/Membership Application Services preserve at least one active Human Owner under the Organization-scoped lock. | Locked owner-count transaction; optional database trigger as defense in depth. | Independently detect violation of the already-required invariant. | Human-only administrative recovery; never automatic assignment and never Secretary or System assignment. |
| `DecisionRevisionMutatedAfterSubmission` | Decision owns revision lifecycle; submitted and decided revisions are immutable. | Repository update prohibition, revision ownership constraints, and optional immutability trigger. | Compare immutable revision identity or content hash only to detect safeguard failure. | Contain writes and require Human-led integrity repair; do not overwrite audit evidence. |
| `ApprovedMemoryRevisionMismatch` | Memory owns review state; approval binds to the exact immutable reviewed revision. | Review-field checks, Organization-scoped revision ownership, and immutable submitted/approved revisions. | Detect mismatch or post-review mutation as corruption, not as an eventually consistent condition. | Contain Memory mutations and require Human-led repair through the Memory Application Service. |
| `HumanAuthorityBoundaryViolated` | Authorization and the command Application Service reject Secretary or System execution of Human-only commands. | Human actor columns reference Human Identity and Membership; non-Human principals use separate columns or tables. | Verify that no authoritative transition committed after a prohibited attempt. | Security incident handling and Human-approved repair if state changed. |
| `CrossOrganizationReferenceDetected` | Authorization, Organization-scoped repositories, and owning modules reject cross-Organization access and relationships. | Composite Organization keys and foreign keys where applicable. | Detect structural or access evidence missed by preventive controls. | Immediate containment; scoped Human-led security and integrity recovery. |

### MVP Operational-Finding Classification

| Finding | Primary prevention owner | Reconciliation role | Recovery authority |
|---|---|---|---|
| `PoisonEventOrderingBlocked` | The consumer ordering and poison-event policy in `events-and-outbox.md`. | Confirm the blocked ordering key, later-message policy, and dead-letter evidence. | Typed retry, skip, compensation, or rebuild through the Operations Application Service under the owning consumer policy. |
| `WorkerRetryWithoutProgress` | Worker Runtime retry, lease, and terminal-failure policy. | Detect repeated attempts without checkpoint or outcome progress. | Automatic bounded retry until exhaustion; then Human operational action. |
| `WorkflowHealthProjectionInconsistent` | The projection Worker owns correct derivation from durable sources. | Detect missing source rows, false `Healthy`, duplicate or cross-Organization projection rows, stale high-water marks, and refresh expiry. | Rebuild the projection automatically when sources are intact; Human intervention when authoritative source state is inconsistent. |

Operational projections and reconciliation findings remain non-authoritative metadata. They MUST NOT directly update Work, Decision, Memory, Organization, Membership, authorization, or immutable revision tables.

---

## Scope

This document covers operational concerns for the MVP Modular Monolith.

It applies to:

- HTTP application processes
- Application Services
- PostgreSQL repositories
- Transactional Outbox publisher
- Domain Event consumers
- Memory generation Workers
- projection Workers
- reconciliation Workers
- scheduled maintenance Workers
- identity integration
- authorization evaluation
- audit recording
- database migration
- backup and restoration
- deployment infrastructure

---

## Requirement Levels and Delivery Tiers

This document defines both the minimum production baseline and later operational capabilities. The tiers below determine implementation timing.

Normative terms are used as follows:

- **MUST**: required before the MVP is operated in production
- **SHOULD**: required for production hardening, but may be deferred through an explicit, owned risk decision
- **MAY**: optional or future capability that is not an MVP acceptance condition

Only uppercase **MUST**, **SHOULD**, and **MAY** are normative. Lowercase wording elsewhere is explanatory unless a requirement is assigned to a tier below. Security boundaries, Human-authority rules, Organization isolation, PostgreSQL authority, and transactional consistency remain mandatory regardless of tier.

### MVP Production Baseline — MUST

Before the MVP is operated in production, AIOS MUST provide:

- structured JSON logs with a stable base envelope and redaction
- bounded telemetry exporters with queue limits, timeouts, retry ceilings, loss counters, disk quotas where used, and shutdown deadlines
- server-owned request and workflow correlation
- error capture for unhandled application and Worker failures
- RED metrics for HTTP traffic
- PostgreSQL, Outbox, Worker, queue-age, and Work-to-Memory workflow metrics
- durable audit for successful Human-authoritative transitions and privileged operational actions
- separate HTTP liveness/readiness, Worker liveness/readiness, asynchronous workflow health, and restricted administrative diagnostics
- bounded retry, idempotency, retry-exhaustion visibility, dead-letter handling, and typed Operations Application Service commands for Worker pause/resume, replay, and dead-letter retry/skip
- continuous WAL archiving, a physical base backup at least every 24 hours, a 14-day PITR window, a monthly verified restore test, and the approved RPO and RTO
- actionable alerts for database unavailability, authoritative-write failure, Outbox or Worker stoppage, Memory-generation failure, and Organization-isolation violation
- the six MVP runbooks identified in the Operational Runbooks section

An MVP release is not accepted for production when any item in this baseline is absent unless the architecture owner records a time-bounded risk acceptance.

### Production Hardening — SHOULD

After the baseline is working, AIOS SHOULD add:

- distributed traces with controlled sampling
- reconciliation dashboards and scheduled integrity reporting
- automated restore validation
- security-focused alert routing
- Organization-scoped containment
- deployment automation beyond the minimum rollback procedure
- expanded runbooks for component-specific and administrative failures
- richer Organization-scoped health diagnostics and automated reconciliation dashboards
- tested Organization containment, read-only mode, projection-rebuild, and generalized repair commands

Deferral requires a named owner and an explicit trigger for implementation, such as traffic volume, incident history, or customer requirement.

### Future Enterprise Capabilities — MAY

AIOS MAY introduce when scale and organizational maturity justify them:

- tail-based trace sampling
- customer-facing observability
- advanced incident automation
- generalized automatic repair
- specialized incident-management staffing
- multi-region operational coordination
- Security Operations Center and SIEM integration
- customer-defined alerts and integrations

Future capabilities MUST NOT be prerequisites for the MVP domain workflow and MUST NOT introduce a second source of business authority.

---

## Non-Goals

This document does not define:

- a full Security Operations Center
- enterprise Security Information and Event Management
- multi-region active-active operations
- globally distributed tracing
- public customer observability portals
- customer-defined alerting
- billing analytics
- business intelligence architecture
- data warehouse monitoring
- AI Employee runtime monitoring
- marketplace operations
- Knowledge promotion operations
- Evidence-chain monitoring
- external webhook delivery monitoring
- third-party customer integration monitoring

These may be introduced in future phases.

---

## Operational Goals

The operational architecture must ensure that:

- failures are detectable
- failures are diagnosable
- failures are attributable
- recovery is safe
- retries are bounded
- authoritative actions remain Human-controlled
- Organization isolation remains observable
- asynchronous workflows can be reconciled
- operational data does not become a new source of authority
- sensitive information is not exposed through telemetry
- deployments are reversible or forward-fixable
- Workers can restart without creating duplicate business effects
- operators can distinguish delay from failure
- service health reflects business-processing capability
- operational actions remain auditable

---

## Operational Principles

AIOS operations follow these principles:

```text
Observe Every Boundary

Correlate Every Workflow

Measure User Impact

Separate Symptoms from Causes

Prefer Recovery over Silent Repair

Make Retries Visible

Protect Human Authority

Preserve Organization Isolation

Minimize Sensitive Telemetry

Automate Repetitive Recovery

Keep Operational State Non-Authoritative
```

---

## Principle 1: Observability Is a System Property

Observability is not limited to logs emitted by controllers.

Every major boundary should produce sufficient telemetry.

Examples:

```text
HTTP request boundary

Application Service command boundary

Authorization boundary

Aggregate persistence boundary

Outbox publication boundary

Event consumer boundary

External dependency boundary

Worker claim boundary

Migration boundary

Recovery boundary
```

---

## Principle 2: Business Workflows Are Observable

Infrastructure health alone is insufficient.

The system must expose whether critical business flows are progressing.

Examples:

```text
Decision submitted
    -> Human review pending
```

```text
Decision approved
    -> Work Completion Gate updated
```

```text
Work completed
    -> WorkCompleted event published
```

```text
WorkCompleted event processed
    -> Memory generated
```

```text
Memory submitted
    -> Human review pending
```

---

## Principle 3: Operational Data Is Not Business Authority

Logs, metrics, traces, and dashboards may describe system behavior.

They must not become authoritative sources for:

- Work status
- Decision outcome
- Memory approval
- Membership status
- Organization ownership
- Human authority
- event-processing completion

Authoritative facts remain in PostgreSQL Aggregate and processing tables.

---

## Principle 4: Correlation Is Mandatory

Every command and asynchronous consequence must be traceable across process and transaction boundaries.

The minimum correlation chain is:

```text
requestId

commandId

correlationId

causationId

eventId

aggregateId

organizationId
```

Not every field exists at every boundary, but applicable identifiers must be preserved.

---

## Principle 5: Failures Must Be Classified

Failures should be classified into stable categories.

Examples:

```text
ValidationFailure

AuthorizationDenied

ConcurrencyConflict

DependencyUnavailable

TransientDatabaseFailure

PermanentDatabaseFailure

EventContractFailure

PoisonEvent

InvariantViolation

OrganizationIsolationViolation

WorkerLeaseExpired

RetryExhausted

ConfigurationFailure
```

Error classification supports:

- alert routing
- retry policy
- dashboards
- incident analysis
- recovery automation

---

## Principle 6: Retries Are Observable

Every retry must have:

- retry reason
- attempt number
- next retry time
- maximum attempt policy
- original operation identity
- current claim or lease identity

Infinite invisible retries are prohibited.

---

## Principle 7: Recovery Is Explicit

Recovery must occur through:

- supported Application Services
- replay tooling
- reconciliation
- claim recovery
- controlled migration
- audited operational commands

Operators must not silently rewrite authoritative tables as the ordinary response to failure.

---

## Principle 8: Human Authority Is Observable

AIOS must make authority boundaries visible.

Examples of security-relevant signals:

```text
Secretary attempted Decision approval

System principal attempted Work completion

Human without Reviewer permission attempted Memory approval

Cross-Organization command attempted

Last Owner removal denied
```

These events require structured audit and security telemetry.

---

## Principle 9: Telemetry Is Privacy-Aware

Telemetry is production data and MUST be governed as such.

Identifiers, hashes, timestamps, model references, and correlation chains can be sensitive even when business content is absent. Hashing alone is not anonymization.

AIOS MUST minimize collection, classify fields before export, enforce retention, restrict access, and keep tenant-security telemetry separate from Organization-accessible audit.

---

## Telemetry Data Classes

Every telemetry field MUST belong to one class.

### T0 — Aggregate Operational Metadata

Examples:

- service name and version
- environment
- normalized route template
- operation type
- bounded status, outcome, and error category
- duration and count
- configured provider category

T0 contains no tenant, principal, resource, or content identifier.

### T1 — Correlation and Execution Identifiers

Examples:

- requestId
- commandId
- correlationId
- causationId
- eventId
- traceId
- spanId
- generationOperationId

T1 can link activity across systems and is therefore internal operational data.

### T2 — Tenant, Principal, and Resource Identifiers

Examples:

- organizationId
- principalId
- membershipId
- workId
- decisionId
- memoryId
- provider account reference
- raw or tokenized client network identifier

T2 is sensitive and linkable. It is never an ordinary metric label.

### T3 — Business and Personal Content

Examples:

- Work content
- Decision rationale
- Memory content
- prompt or generated response
- email address
- invitation data
- free-form error payload
- customer-supplied metadata
- content fingerprint

T3 is prohibited from ordinary telemetry unless a separately approved incident-capture procedure explicitly permits a minimal redacted field.

### T4 — Secrets and Credentials

Examples:

- password
- authentication token
- authorization header
- cookie
- API key
- database credential
- invitation token
- encryption key
- full token hash used for authentication

T4 is prohibited from all telemetry and audit payloads.

---

## Telemetry Field Matrix

| Surface | T0 | T1 | T2 | T3 | T4 |
|---|---|---|---|---|---|
| Metrics | Allowed | Trace exemplar only, never a label | Prohibited | Prohibited | Prohibited |
| Traces | Allowed | Allowed | Tokenized by default; raw only in approved restricted capture | Prohibited | Prohibited |
| Ordinary operational logs | Allowed | Allowed | Tokenized by default; selected raw identifiers only in restricted sinks | Prohibited except bounded redacted error metadata | Prohibited |
| Restricted security logs | Allowed | Allowed | Raw when required for investigation and access is restricted | Minimal normalized reason data only | Prohibited |
| Organization-accessible audit | Allowed | Allowed | Raw only within the same Organization scope | Normalized action metadata; no business body | Prohibited |
| Platform-security audit | Allowed | Allowed | Raw when required and access is audited | Minimal normalized reason data only | Prohibited |
| PostgreSQL operational records | Allowed | Allowed | Raw under explicit Organization scope | Only schema-approved bounded fields | Prohibited |

A field not listed or classified is denied by default.

Model name and provider may be T0 only when values come from bounded configuration. A caller-supplied model string is untrusted text and MUST be normalized before telemetry.

---

## Identifier Handling

Raw T2 identifiers are permitted only where they are necessary for authorized diagnosis, audit, reconciliation, or deletion.

Ordinary logs and traces SHOULD use a scoped tokenized reference instead of raw principal or resource identifiers.

Tokenization requirements:

- use a keyed, non-reversible construction such as HMAC
- scope tokens by environment and, where practical, Organization
- version the tokenization key
- restrict re-identification or mapping access to an audited Platform Operator capability
- do not reuse one global token across unrelated external systems
- support key rotation without silently merging old and new identities

Tokenization reduces exposure but does not make the data anonymous.

Organization IDs may remain raw in PostgreSQL audit and operational tables because tenant scoping, repair, and deletion require them. They MUST NOT appear in metric labels or unrestricted exports.

---

## Telemetry Encryption and Transport

All production telemetry stores MUST use encryption at rest.

Telemetry in transit MUST use authenticated encryption, normally TLS.

Requirements:

- managed encryption keys or an approved key-management service
- separate credentials for producers, readers, and administrators
- no key or secret material in telemetry
- encrypted backups
- key rotation according to the secret-management policy
- access to decrypted restricted telemetry is auditable

Disabling certificate validation or exporting telemetry over plaintext is prohibited.

---

## Telemetry Residency and Export

T1, T2, and T3-derived telemetry MUST remain in the approved data region for the associated deployment unless a contract, data-processing agreement, and architecture decision permit export.

Cross-region or third-party export requires:

- field-level classification
- destination and subprocessors
- encryption
- retention and deletion capability
- access model
- incident-notification responsibility
- documented Organization and jurisdiction impact

Unrestricted export of raw Organization, principal, resource, prompt, response, or content-fingerprint data is prohibited.

Vendor support bundles are exports and follow the same rules.

---

## Platform Security Telemetry and Organization Audit

Platform-security telemetry and Organization-accessible audit serve different audiences.

Organization-accessible audit:

- is scoped to one Organization
- explains authorized actions on that Organization
- does not expose other Organizations, platform detection logic, protected network identifiers, or internal threat intelligence

Platform-security telemetry:

- may correlate activity across Organizations only for an authorized security purpose
- requires Platform Security or restricted Platform Operator access
- records access and export
- is not directly exposed to Organization administrators
- does not become a source of business authority

A sanitized Organization audit export MUST be generated from an authorized application service, not by granting direct access to the platform log backend.

---

## Telemetry Deletion and Legal Hold

Telemetry deletion follows Organization deletion, data-subject obligations, contractual retention, and security requirements.

Required behavior:

- delete or irreversibly de-identify T2 and T3-derived telemetry when its approved retention expires
- propagate Organization deletion to searchable telemetry indexes and operational projections
- retain minimal audit evidence only when a documented legal, contractual, fraud, or security basis requires it
- minimize or pseudonymize retained subject identifiers where accountability permits
- record legal-hold creation, scope, owner, reason, and release
- prevent routine retention jobs from deleting records under active legal hold
- delete expired backup copies through the normal backup lifecycle; surgical modification of immutable backups is not required
- record deletion-job success, failure, and backlog without reintroducing deleted identifiers into metrics

A legal hold extends retention but does not broaden access.

---

## Principle 10: Observability Must Survive Partial Failure

Telemetry should remain useful when one subsystem is degraded.

Examples:

- application logs remain available during PostgreSQL latency
- database metrics remain available when the application is unhealthy
- deployment events remain visible when Workers fail
- alert delivery uses a path independent from the failing application where practical

---

## Observability Architecture

The observability model includes four telemetry types:

```text
Logs

Metrics

Traces

Audit Records
```

Each has a distinct purpose.

---

## Logs

Logs provide detailed records of discrete operational events.

Use logs for:

- command execution details
- failure diagnostics
- Worker attempts
- claim acquisition
- deployment events
- migration steps
- recovery actions
- external dependency errors
- reconciliation findings

Logs should be structured and machine-queryable.

---

## Metrics

Metrics provide aggregated numerical measurements over time.

Use metrics for:

- request rate
- error rate
- latency
- queue depth
- oldest pending age
- retry count
- Worker throughput
- database connection usage
- transaction conflicts
- workflow completion delay

Metrics must avoid high-cardinality labels.

---

## Traces

Traces connect operations across boundaries.

Use traces for:

- request-to-database flow
- command execution
- Outbox publication
- event handling
- external AI generation
- projection update
- recovery execution

Tracing must preserve correlation across asynchronous operations.

---

## Audit Records

Audit records provide durable accountability for security-sensitive and Human-authoritative actions.

Use audit records for:

- authorization Allow and Deny
- Work completion
- Decision approval and rejection
- Memory approval and rejection
- Membership suspension and revocation
- role assignment
- ownership transfer
- replay authorization
- data repair approval
- privileged operational access

Audit records belong in durable PostgreSQL storage.

They are not replaceable by ordinary application logs.

---

## Telemetry Flow

```text
Application / Worker
        │
        ├── Structured Logs
        │       ↓
        │   Log Aggregation
        │
        ├── Metrics
        │       ↓
        │   Metrics Backend
        │
        ├── Traces
        │       ↓
        │   Trace Backend
        │
        └── Audit Records
                ↓
            PostgreSQL
```

---

## MVP Implementation Stack Decision

The architecture contracts, telemetry schema, and Application Layer ports remain provider-neutral.

The production MVP implementation is fixed by [ADR-0003](../adr/0003-select-mvp-observability-stack.md). That ADR is the canonical source for:

- selected managed services and disabled components
- primary Region and accepted regional failure mode
- cost limits and cardinality guardrails
- implementation retention and provider constraints
- security controls and operational ownership
- the trigger for revisiting the decision

The selected MVP baseline uses:

- Amazon CloudWatch Logs and Logs Insights
- Amazon CloudWatch metrics, dashboards, and alarms
- Amazon SNS for operator notification
- AWS CloudTrail for AWS control-plane audit
- PostgreSQL for authoritative AIOS audit
- OpenTelemetry APIs and W3C Trace Context without remote trace export

Prometheus, Grafana, a self-managed OpenTelemetry Collector fleet, external error-tracking SaaS, and remote production tracing are not MVP requirements.

Vendor-specific SDKs, resource names, access policies, and exporter settings belong to Infrastructure Layer adapters and Infrastructure as Code. Replacing a selected component requires an ADR update; it MUST NOT change Domain, Application, audit-durability, Organization-isolation, or Human-authority contracts.

---

## OpenTelemetry

OpenTelemetry is recommended for:

- trace instrumentation
- metric instrumentation
- context propagation
- standard semantic attributes
- vendor-neutral export

The MVP production exporter decision is fixed by ADR-0003. Remote trace export is disabled for the MVP baseline. A later exporter or backend requires an ADR update that defines retention, cost, regional behavior, access, ownership, and failure semantics.

---

## Telemetry Failure and Backpressure Contract

Optional telemetry export MUST NOT roll back or reject a valid business operation, but it also MUST NOT consume unbounded memory, disk, threads, connections, or shutdown time. Telemetry is allowed to degrade; the authoritative service is not allowed to fail merely to preserve optional telemetry.

Required durable audit is not an exporter concern. It follows the Audit Durability Classes and is written to PostgreSQL under the required transaction policy. It MUST NOT pass through a lossy log, metric, or trace queue.

Examples:

```text
Trace export failure
    → do not reject Work completion
    → bound or drop spans
    → increment a local loss counter
```

```text
Metrics export failure
    → do not roll back Decision approval
    → retain only bounded current aggregates
    → discard expired samples
```

```text
Required Class A audit persistence failure
    → fail the authoritative command transaction
    → do not report the command as successful
```

---

## Telemetry Delivery Classes

| Delivery class | Data | Failure behavior |
|---|---|---|
| Authoritative durability | Class A audit, authoritative state, Transactional Outbox | Commit atomically or fail according to the transaction policy; never drop |
| Durable operational accountability | Class B audit and approved privileged-operation records | Persist through the bounded durable audit path; do not redirect to optional exporters |
| High-priority diagnostic telemetry | security violations, fatal errors, integrity failures | Attempt first within bounded capacity; aggregate repeated records; may be lost only after capacity protection activates |
| Ordinary operational telemetry | informational logs, standard error details, metrics | Buffer or aggregate within fixed budgets; drop or coalesce on saturation |
| Sampled diagnostic telemetry | traces, debug logs, verbose spans | Sample or drop first |

No non-authoritative telemetry class has an unlimited delivery guarantee. A higher priority changes the order of admission and dropping; it does not permit unbounded resource use.

---

## Bounded Export Queues

Every in-process exporter MUST define fixed limits for:

- maximum queued records and bytes
- maximum batch size
- maximum concurrent export requests
- per-request connection and response timeout
- maximum retry age or retry attempts
- maximum backoff interval
- maximum process memory allocated to telemetry

Limits are configuration validated at startup. A missing or unlimited value is invalid in production.

When a queue reaches its limit, the exporter MUST apply a documented non-blocking admission policy. The default order is:

1. drop new debug spans and verbose trace data
2. drop or sample repetitive informational logs
3. coalesce metric updates and discard expired metric samples
4. aggregate repeated warning, error, and security records by bounded reason code
5. drop additional diagnostic detail rather than block an authoritative transaction or Worker lease

The process MUST NOT allocate a second unbounded overflow queue. Caller threads, event loops, and Worker claim loops MUST NOT synchronously wait for a remote telemetry backend.

---

## Export Timeout and Retry Policy

Remote export calls MUST use explicit connection and response deadlines. Retries MUST use exponential backoff with jitter and a ceiling.

Exporters MUST NOT:

- retry forever at full rate
- create one retry task per failed record
- retain expired data merely because the backend is unavailable
- share retry state with business-command idempotency
- consume the HTTP request budget or Worker lease extension budget
- hold PostgreSQL transactions open during remote export

Authentication failure, invalid configuration, and other non-transient exporter errors open an exporter circuit and suppress hot retries until the configured probe interval or a configuration change. A backend recovery closes the circuit only after a successful bounded probe.

---

## Resource and Bulkhead Isolation

Telemetry export uses resource pools isolated from authoritative request and Worker execution where practical.

Required rules:

- remote exporters use their own bounded network concurrency
- an exporter MUST NOT consume the PostgreSQL connection pool reserved for authoritative commands and Workers
- optional local collectors or agents have explicit CPU and memory limits
- log serialization and enrichment have bounded record size and execution time
- oversized records are truncated or rejected under the telemetry data policy before queue admission
- telemetry backpressure MUST NOT extend an Outbox lease or Worker lease indefinitely

If the deployment writes logs to stdout or a local agent, the writer and collector MUST be configured so a blocked pipe cannot indefinitely block application execution. The application uses a bounded non-blocking queue or an equivalent runtime mechanism and applies the same loss policy when the sink stops reading.

---

## Local Disk Spooling

Disk spooling is optional and MUST NOT be treated as unlimited durability.

When enabled, each process or node MUST define:

- maximum spool bytes
- maximum record age
- approved storage path
- encryption and file permissions appropriate to the highest retained data class
- rotation and deletion behavior
- behavior when the disk budget is reached

The spool MUST NOT share an unbounded volume with PostgreSQL data, WAL, backups, or other authoritative storage. When the spool budget is exhausted, the exporter drops data according to priority and increments loss counters; it MUST NOT consume remaining system disk or make HTTP readiness fail solely to preserve optional telemetry.

Secrets, raw prompts, generated content, and T4 data remain prohibited even in a local spool.

---

## Backend-Unavailable Behavior

When a centralized log, metric, or trace backend is unavailable:

- authoritative commands and required audit continue under their normal PostgreSQL policy
- the exporter circuit opens after its bounded failure threshold
- in-memory queues remain within configured limits
- optional disk spooling remains within its quota
- expired samples and low-priority records are dropped
- local loss and queue-pressure counters remain available through the process metrics or authenticated diagnostic surface
- the incident is raised from independent platform monitoring when the outage or loss threshold is sustained
- HTTP and Worker readiness remain unchanged unless the failing component is actually required for safe business processing

Telemetry backend recovery MUST NOT trigger an uncontrolled catch-up burst. Export resumes with bounded concurrency and preserves current service capacity before draining retained telemetry.

---

## Shutdown Flush Contract

Shutdown attempts a best-effort flush of accepted optional telemetry within a fixed deadline. The MVP default is five seconds, and the configured deadline MUST be shorter than the process termination grace period.

After the deadline:

- optional logs, metrics, and traces may be dropped
- the process records a bounded `telemetry_shutdown_drop_total` observation when possible
- shutdown proceeds without waiting indefinitely for the backend
- authoritative transactions already accepted follow their normal graceful-shutdown and recovery rules
- required durable audit is committed with its authoritative transaction or the transaction is not reported as successful

A telemetry flush MUST NOT delay lease release, transaction rollback, or safe process termination beyond their own deadlines.

---

## Telemetry Self-Observability

Each exporter SHOULD expose bounded local metrics such as:

```text
telemetry_export_attempt_total{signal,outcome}
telemetry_export_failure_total{signal,reason_code}
telemetry_export_dropped_total{signal,priority,reason_code}
telemetry_export_queue_utilization_ratio{signal}
telemetry_export_oldest_queued_seconds{signal}
telemetry_export_circuit_open{signal}
telemetry_spool_bytes{signal}
telemetry_shutdown_flush_timeout_total{signal}
```

Labels MUST come from bounded configuration or enums. They MUST NOT include Organization, Aggregate, request, command, event, trace, span, raw exception, endpoint path, or exporter URL values.

Because the primary telemetry backend may be unavailable, critical exporter-health alerts require an independent signal where feasible, such as collector supervision, platform resource monitoring, or an authenticated direct scrape. Lack of exporter evidence is represented as `Unknown` or `Stale`, not `Healthy`.

Alert conditions SHOULD include:

- sustained queue utilization above the configured threshold
- any sustained loss of high-priority diagnostic telemetry
- rapidly increasing optional telemetry drops
- spool usage approaching its fixed quota
- an exporter circuit remaining open beyond the allowed interval
- repeated shutdown flush timeouts

---

## Telemetry Priority

The system priority order is:

```text
1. Authoritative domain persistence

2. Required durable audit

3. Transactional Outbox

4. High-priority bounded diagnostic telemetry

5. Ordinary operational logs and metrics

6. Sampled traces and debug telemetry
```

The first three may participate in the business transaction. Items four through six are emitted outside the database commit dependency and remain bounded and lossy under failure.

---

## Structured Logging

All runtime components must emit structured logs.

Preferred format:

```text
JSON
```

Plain unstructured text should be limited to local development.

---

## Operational Log Envelope

Every structured operational log uses one fixed base envelope:

```text
logSchemaVersion
timestamp
severity
operationalLogName
operationalLogClass
operationalLogCategory
message
serviceName
serviceVersion
environment
outcome
durationMs
attributes
```

The base keys have one meaning and type across every service. `outcome` and `durationMs` may be null only when the registered operational-log class does not have a terminal outcome or measurable duration.

`attributes` contains only registered namespaced extension attributes. A module MUST NOT add an ad hoc top-level key to the base envelope.

---

## Required Base Fields

Every production log MUST populate:

```text
logSchemaVersion
timestamp
severity
operationalLogName
operationalLogClass
operationalLogCategory
serviceName
serviceVersion
environment
attributes
```

`message` is a bounded Human-readable summary and is never the machine identity. It may be omitted from high-volume records when the operational-log registry permits omission.

---

## Extension Attribute Namespaces

Canonical attribute keys use lower snake case after a registered namespace:

```text
identity.*
http.*
domain.*
authorization.*
event.*
worker.*
ai.*
database.*
projection.*
reconciliation.*
deployment.*
backup.*
operations.*
security.*
error.*
```

Examples:

```text
identity.command_id
identity.correlation_id
identity.organization_id
domain.command_type
domain.expected_version
domain.resulting_version
authorization.permission
event.domain_event_id
event.integration_message_type
worker.attempt
ai.generation_operation_id
operations.operation_id
```

Attribute names are part of the telemetry contract. Aliases such as `commandType`, `domain.commandType`, and `domain.command_type` MUST NOT coexist.

---

## Standard Identity Attributes

Cross-cutting identifiers use:

```text
identity.request_id
identity.command_id
identity.correlation_id
identity.causation_id
identity.trace_id
identity.span_id
identity.organization_id
identity.principal_type
identity.principal_id
identity.membership_id
```

Artifact-specific event and audit identities use:

```text
event.domain_event_id
event.domain_event_type
event.integration_message_id
event.integration_message_type
event.operational_event_id
event.operational_event_type
operations.audit_record_id
operations.audit_action
```

Generic `eventName`, `eventType`, `eventId`, or unqualified `operationId` attributes are prohibited.

---

## Operational Log Class Registry

Every `operationalLogName` MUST have one version-controlled registry entry containing:

```text
operationalLogName
operationalLogClass
owner
category
defaultSeverity
requiredBaseFields
requiredAttributes
optionalAttributes
privacyClasses
samplingPolicy
introducedLogSchemaVersion
deprecatedLogSchemaVersion nullable
```

The MVP class contract is:

| Class | Required attributes in addition to the base envelope |
|---|---|
| `CommandCompletion` | `identity.command_id`, `identity.correlation_id`, `identity.organization_id` when scoped, `identity.principal_type`, `domain.command_type`, `domain.aggregate_type`, `domain.aggregate_id`, `domain.expected_version` when used, `domain.resulting_version` on success |
| `AuthorizationDecision` | `identity.correlation_id`, `identity.principal_type`, `identity.organization_id` when scoped, `authorization.permission`, `authorization.resource_type`, `authorization.outcome`, `authorization.reason_code`, `authorization.policy_version` |
| `WorkerAttempt` | `identity.correlation_id`, `worker.worker_type`, `worker.worker_id`, `worker.operation_id`, `worker.attempt`, `worker.maximum_attempts` |
| `OutboxRelay` | one registered Domain Event or Integration Message identity pair, `event.outbox_record_id`, `worker.attempt` |
| `ConsumerDelivery` | one registered message identity pair, `event.consumer_name`, `worker.attempt`; `event.processed_marker_id` is required for `ConsumerEffectsCommitted` |
| `MemoryGeneration` | `identity.correlation_id`, `identity.organization_id`, `domain.work_id`, `ai.generation_operation_id`, `ai.generation_policy_version`, `worker.attempt` |
| `SecurityViolation` | `identity.correlation_id`, `identity.principal_type`, `authorization.resource_type`, `authorization.reason_code`; protected identifiers follow the restricted-sink policy |
| `PrivilegedOperation` | `operations.operation_id`, `operations.command_type`, `operations.scope_type`, `operations.reason_code`, `operations.audit_record_id` when durable intent or result exists |
| `ProjectionOrReconciliation` | `identity.organization_id` when scoped, `projection.projection_name` or `reconciliation.finding_type`, and the registered source high-water mark or finding reference |
| `DeploymentOrRecovery` | the registered deployment, migration, backup, restore, or incident reference appropriate to the log name |

Conditional requirements are explicit registry rules. The phrase “when available” MUST NOT be used for an attribute required to interpret a terminal success, security violation, authoritative command completion, or privileged operation.

---

## Schema Ownership and Validation

The Observability module owns the base envelope, namespace registry, compatibility policy, and validation tooling. Each producing module owns the semantic accuracy of its registered log names and extension attributes. A change affecting both requires review by both owners.

CI MUST validate representative records for every registered `operationalLogName` against:

- the base schema
- its class contract
- required and prohibited attributes
- attribute types and bounded enums
- privacy classification and sink policy
- sampling prohibition where applicable

Production ingestion records a bounded contract-violation counter and routes malformed security-critical or audit-linked logs to a restricted diagnostic path. A malformed optional log MUST NOT roll back valid business state.

---

## Compatibility Rules

Compatible changes include adding an optional registered attribute or a new operational-log name that does not change an existing meaning.

Breaking changes include:

- adding a required attribute to an existing log name
- removing or renaming an attribute
- changing an attribute type, unit, privacy class, or meaning
- changing the completion boundary represented by a log name
- moving a field between the base envelope and `attributes`
- changing sampling eligibility for accountability- or security-critical records

A breaking change requires a new `logSchemaVersion`, versioned registry fixtures, and either dual emission or a documented compatible query migration window. Consumers MUST ignore unknown optional attributes but MUST NOT reinterpret an unknown required contract as a known success.

---

## Telemetry Identity Namespace

The following semantic names remain distinct:

```text
domainEventType            # event.domain_event_type
integrationMessageType     # event.integration_message_type
operationalEventType       # event.operational_event_type
operationalLogName         # base telemetry record identity
auditAction                # operations.audit_action
```

An ordinary structured log record is not an Operational Event and does not prove that an event was committed, a message was relayed, consumer effects committed, or an audit record stored.

---

## Operational Log Name

`operationalLogName` names the observed processing stage, not the underlying business fact.

Preferred:

```text
WorkCommandCompleted
DecisionApprovalDenied
OutboxRecordClaimed
OutboxRecordRelayed
ConsumerEffectsCommitted
MemoryGenerationFailed
```

Avoid names such as `DomainEventPublished` or `DomainEventProcessed`, because they do not state which transaction or delivery boundary completed.

---

## Log Message

The `message` field is a Human-readable summary.

Example:

```text
"Outbox message publication failed and was scheduled for retry."
```

The message should not contain sensitive domain content.

---

## Severity Levels

Recommended levels:

```text
Debug

Info

Warn

Error

Critical
```

---

## Debug

Use Debug for:

- local diagnostic detail
- development-only branch information
- bounded SQL timing detail
- internal mapping detail

Debug logs should normally be disabled or sampled in production.

---

## Info

Use Info for successful important lifecycle and operational events.

Examples:

- application started
- Worker started
- command completed
- event published
- event processed
- deployment completed
- migration completed
- replay completed

High-volume routine events may require sampling or aggregation.

---

## Warn

Use Warn when the system remains functional but requires attention.

Examples:

- transient dependency failure
- retry scheduled
- claim expired
- queue delay approaching objective
- configuration fallback used
- concurrency conflict above baseline
- deprecated event schema received

---

## Error

Use Error when an operation fails and requires retry, investigation, or user-visible failure.

Examples:

- command transaction failed
- event handling failed
- Memory generation failed
- migration step failed
- reconciliation found an invariant violation
- replay failed

---

## Critical

Use Critical when the service cannot safely continue or a core guarantee may be compromised.

Examples:

- database unavailable for authoritative writes
- active Organization has no Owner
- cross-Organization data exposure detected
- audit persistence unavailable for authoritative actions
- event payload integrity failure
- migration leaves schema incompatible
- backup continuity lost beyond RPO

---

## Stable Error Categories

Logs should include a stable:

```text
errorCategory
```

Recommended categories:

```text
Input

Authorization

Concurrency

Database

Dependency

EventContract

Invariant

OrganizationIsolation

Security

Configuration

Capacity

Timeout

Unknown
```

---

## Stable Error Codes

`errorCode` should identify a specific operational condition.

Examples:

```text
AUTHORIZATION_DENIED

EXPECTED_VERSION_MISMATCH

OUTBOX_CLAIM_EXPIRED

EVENT_SCHEMA_UNSUPPORTED

MEMORY_GENERATION_RETRY_EXHAUSTED

ACTIVE_OWNER_INVARIANT_VIOLATION

CROSS_ORGANIZATION_REFERENCE_REJECTED

DATABASE_CONNECTION_POOL_EXHAUSTED
```

Error codes should remain stable across wording changes.

---

## Exception Logging

Unhandled exceptions should be logged once at the boundary that owns the failure response.

Avoid logging the same exception at every layer.

Incorrect:

```text
Repository logs Error

Application Service logs Error

Controller logs Error
```

Correct:

```text
Lower layer returns classified failure

Owning boundary logs final Error once
```

Additional lower-level Debug detail may be used when necessary.

---

## Stack Traces

Stack traces are useful for unexpected failures.

They should:

- appear only for Error or Critical unexpected failures
- be excluded from ordinary validation failures
- be redacted where necessary
- not include secrets or payload content
- remain linked to errorCode and correlationId

---

## SQL Logging

Production SQL logging should not record full parameter values by default.

It may record:

```text
database.query_name

database.operation

durationMs in the base envelope

database.row_count

database.timeout

error.database_code
```

Sensitive bind values must be redacted.

---

## Named Database Operations

Repository and Worker SQL operations should have stable operation names.

Examples:

```text
WorkRepository.Load

DecisionRepository.Save

OutboxRepository.ClaimBatch

ProcessedEventRepository.MarkProcessed

MembershipRepository.CountActiveOwners
```

These names improve metrics and traces without exposing SQL text.

---

## Slow Query Logging

Queries exceeding a configured duration should emit:

```text
DatabaseQuerySlow
```

Recommended fields:

```text
database.operation

durationMs in the base envelope

database.rows_examined when registered

database.rows_returned

database.organization_scoped

database.transaction_id when registered

identity.trace_id
```

Do not include unrestricted SQL parameters.

---

## Transaction Logging

Important transaction operational log names may include:

```text
TransactionStarted

TransactionCommitted

TransactionRolledBack

TransactionSerializationRetry

TransactionDeadlockRetry

TransactionTimeout
```

High-volume success events may be traced rather than logged individually.

---

## Aggregate Command Logging

An authoritative command should produce one `CommandCompletion` log.

Example:

```json
{
  "logSchemaVersion": 3,
  "operationalLogName": "WorkCommandCompleted",
  "operationalLogClass": "CommandCompletion",
  "operationalLogCategory": "DomainWorkflow",
  "outcome": "Succeeded",
  "durationMs": 42,
  "attributes": {
    "identity.command_id": "command-...",
    "identity.correlation_id": "corr-...",
    "identity.organization_id": "org-...",
    "identity.principal_type": "HumanMember",
    "domain.command_type": "CompleteWork",
    "domain.aggregate_type": "Work",
    "domain.aggregate_id": "work-...",
    "domain.expected_version": 8,
    "domain.resulting_version": 9
  }
}
```

The actual Work content must not be logged.

---

## Authorization Logging

Authorization outcomes should be observable.

Recommended operational log names:

```text
AuthorizationAllowed

AuthorizationDenied
```

High-volume successful Allow logs may be sampled in operational logs because durable audit exists.

Denied authoritative actions should not be silently sampled away.

---

## Authorization Denial Fields

Recommended fields:

```text
identity.principal_type

identity.principal_id

identity.membership_id

identity.organization_id

domain.command_type

authorization.permission

authorization.resource_type

authorization.resource_id when disclosure policy permits

authorization.reason_code

authorization.policy_version
```

---

## Human Authority Violation Logging

Attempts by non-Human principals to perform Human-authoritative commands require a dedicated `SecurityViolation` operational log.

Example:

```text
HumanAuthorityBoundaryViolation
```

Fields:

```text
identity.principal_type

identity.principal_id

domain.command_type

identity.organization_id

authorization.resource_type

authorization.resource_id

authorization.reason_code

identity.correlation_id
```

This should normally be severity:

```text
Warn
```

or:

```text
Error
```

depending on source and frequency.

---

## Organization Isolation Logging

A rejected cross-Organization operation should emit:

```text
OrganizationIsolationViolation
```

Fields should avoid revealing the foreign Organization identifier to unauthorized callers.

Internal security telemetry may contain protected identifiers under restricted access.

---

## Worker Logging

Every real Worker attempt is observable. Claim deferral, predecessor blocking, and lease-recovery bookkeeping are observable outcomes but are not counted as handler attempts.

Recommended generic Worker operational log names:

```text
WorkerBatchStarted
WorkerItemClaimed
WorkerItemSucceeded
WorkerItemRetryScheduled
WorkerItemFailed
WorkerLeaseExpired
WorkerBatchCompleted
```

Claim-sensitive logs include, when applicable:

```text
worker.operation_id
worker.worker_id
worker.attempt
worker.maximum_attempts
worker.claim_version
worker.lease_expires_at
worker.next_attempt_at
worker.retry_delay_ms
event.consumer_name
event.processed_status
identity.correlation_id
error.category
error.code
```

`worker.attempt` increments only when a real `Processing` claim is acquired. A duplicate `Processed` delivery, a valid competing lease, a predecessor-blocked delivery, or lease-recovery bookkeeping does not increment it.

---

## Worker Success Logging

High-volume successful item logs may be sampled. Metrics remain the primary tool for throughput.

Failures, retry scheduling, lease loss or expiry, permanent consumer failure, ordering-key blocking, and poison-event creation must not be sampled away.

---

## Retry Logging

A retry log records the claim version that failed, the completed attempt number, the registered maximum-attempt and elapsed-time policy, the bounded failure category and code, and the database-derived next attempt time.

It must not log unrestricted event payloads, provider responses, or ordering-key content. High-cardinality identifiers remain in authorized logs and traces only.

---

## Retry Exhaustion

When retries are exhausted, emit `RetryExhausted` with `Error` or `Critical` severity according to business impact.

Terminal persistence is type-specific:

```text
Outbox publication
    -> outbox status = Failed

Consumer delivery
    -> processed-event status = Failed
    -> linked dead-letter status = Open

Memory generation operation
    -> generation status = Failed or Abandoned under its typed policy
```

`DeadLettered` and `Abandoned` are not aliases for generic processed-event status. Operational logs report both the canonical persisted status and the linked dead-letter or generation-operation status.

---

## Outbox Relay Logging

Required operational log names:

```text
OutboxRecordClaimed
OutboxRelayStarted
OutboxRecordRelayed
OutboxRelayRetryScheduled
OutboxRelayFailed
OutboxOrderingKeyBlocked
```

`OutboxRecordRelayed` means that the configured transport acknowledged the message. For `local-consumer-bus`, it is emitted only after all target `Pending` processed-event rows and the Outbox `Published` transition commit atomically. For an external broker, it requires configured broker acknowledgement. It does not mean that any consumer committed its effects.

Relay logs populate `integrationMessageId` and `integrationMessageType` when an Integration Message exists. They may also populate `domainEventId` and `domainEventType` when the Outbox record carries an internal Domain Event directly.

---

## Consumer Delivery Logging

Canonical processed-event statuses are `Pending`, `Processing`, `Processed`, `RetryPending`, `Failed`, `Blocked`, and `Skipped`. Telemetry uses these persisted values without aliases.

Required operational log names:

```text
ConsumerDeliveryMaterialized
ConsumerDeliveryReceived
ConsumerDuplicateDeliveryDetected
ConsumerDeliveryClaimed
ConsumerDeliveryStarted
ConsumerLeaseRenewed
ConsumerLeaseLost
ConsumerDeliveryBlocked
ConsumerEffectsCommitted
ConsumerDeliveryRetryScheduled
ConsumerDeliveryDeadLettered
ConsumerDeliverySkipped
ConsumerLeaseRecovered
```

`ConsumerDeliveryMaterialized` is emitted only after the local handoff transaction commits. It records bounded destination, consumer-set version, and target-count evidence without using event or tenant identifiers as metric labels.

`ConsumerEffectsCommitted` is emitted only after the target effect, follow-up Outbox records, processed-event `Processed` transition, required audit metadata, and ordering-state advancement commit atomically.

`ConsumerDeliveryDeadLettered` means the processed event became `Failed` and the linked dead-letter record was committed. It does not introduce a `DeadLettered` processed-event status.

`ConsumerDeliveryBlocked` records canonical processed-event status `Blocked` and bounded reason code `BlockedByPredecessor`; a protected ordering-key reference may appear in authorized logs or traces but never as a metric label.

`ConsumerLeaseLost` is emitted when final fencing validation fails. It must precede any claim of success, and the stale Worker must commit no target Aggregate or consumer outcome.

`ConsumerDeliverySkipped` records the approved ordering-impact classification and recovery reference. It does not imply successful business processing. Lease-renewal success may be traced or sampled, but lease loss and recovery must not be sampled away.

---

## Message Contract Logging

An invalid Domain Event envelope or Integration Message contract emits:

```text
MessageContractRejected
```

Required fields include:

```text
event.category
event.domain_event_id and event.domain_event_type when category = Domain
event.integration_message_id and event.integration_message_type when category = Integration
event.schema_version
event.consumer_name
error.validation_code
security.payload_fingerprint when permitted
identity.organization_id when safely available
```

Exactly one primary message identity pair is required. Both pairs may be present only for an explicitly recorded Domain-to-Integration mapping. Do not log the full invalid payload by default.

---

## Memory Generation Logging

Required operational log names:

```text
MemoryGenerationScheduled

MemoryGenerationStarted

MemoryGenerationProviderCompleted

MemoryGenerationValidationFailed

MemoryGenerationRetryScheduled

MemoryGenerationPersistenceStarted

MemoryGenerationSucceeded

MemoryGenerationFailed

MemoryGenerationAbandoned
```

Every Memory generation log MUST include, when available:

```text
identity.organization_id

domain.work_id

ai.generation_operation_id

event.domain_event_id

ai.generation_policy_version

worker.attempt

ai.status

error.category

error.code

identity.correlation_id

identity.causation_id

identity.trace_id
```

Provider-completion logs MUST report duration, outcome, provider, and configured model reference without prompt or response content.

Success and terminal-failure logs MUST be emitted from committed durable state. A log message alone MUST NOT mark an operation as Generated, Failed, processed, or eligible for replay.

---

## AI Provider Logging

When an external AI provider is used, logs may include:

```text
ai.provider_category

ai.model_slot

ai.provider_duration_ms

ai.response_status_class

ai.token_usage_category

ai.generation_policy_version

ai.prompt_template_version
```

Do not log:

- full prompt
- full response
- secrets
- Restricted Work content
- Restricted Decision content
- generated Memory content

---

## Content Fingerprints

Content fingerprints are T3-derived sensitive data.

Where consistency diagnosis requires a fingerprint, use a versioned keyed construction over normalized content rather than a plain hash.

```text
security.content_fingerprint_version

security.content_fingerprint
```

Requirements:

- compute with a keyed HMAC or equivalent approved construction
- scope by environment and, where practical, Organization
- never use the fingerprint as authentication or authorization input
- never place it in metric labels
- store it only in restricted logs, traces, audit, or operational records when necessary
- apply the same residency, retention, access, and deletion policy as the source class

A fingerprint detects equality for an approved operational purpose. It is not anonymous data and MUST NOT replace proper version identifiers when the domain provides them.

---

## Projection Logging

Recommended projection operational log names:

```text
ProjectionUpdateStarted

ProjectionUpdated

ProjectionDuplicateIgnored

ProjectionGapDetected

ProjectionRebuildStarted

ProjectionRebuildCompleted

ProjectionRebuildFailed
```

---

## Reconciliation Logging

Recommended operational log names:

```text
ReconciliationScanStarted

ReconciliationFindingCreated

ReconciliationRecoveryScheduled

ReconciliationFindingResolved

ReconciliationScanCompleted
```

Reconciliation logs should include:

```text
reconciliation.finding_type

reconciliation.severity

identity.organization_id

domain.aggregate_type

domain.aggregate_id

event.domain_event_id

reconciliation.resolution_reference
```

---

## Migration Logging

Every migration execution should emit:

```text
MigrationStarted

MigrationStepCompleted

MigrationFailed

MigrationCompleted
```

Recommended fields:

```text
deployment.migration_id

deployment.module

database.name

deployment.application_version

durationMs in the base envelope

outcome in the base envelope

error.code
```

---

## Deployment Logging

Deployment systems should emit:

```text
DeploymentStarted

DeploymentInstanceReady

DeploymentInstanceFailed

DeploymentCompleted

DeploymentRolledBack
```

These operational logs should be available independently from the newly deployed application process.

---

## Backup and Restore Logging

Recommended operational log names:

```text
BackupStarted

BackupCompleted

BackupFailed

RestoreStarted

RestoreValidated

RestoreFailed

PointInTimeRecoveryCompleted
```

Backup logs must not expose:

- storage credentials
- encryption keys
- raw backup locations to unauthorized viewers

---

## Operational Action Logging

Privileged operational actions require structured operational logs in addition to durable audit.

Canonical replay and dead-letter log names include:

```text
ReplayRequested
ReplayValidationStarted
ReplayStarted
ReplayCompleted
ReplayFailed
ReplayDenied
ReplayCancelled
DeadLetterSkipped
OrderingKeyUnblocked
```

`ReplayRequested` records durable Human intent, not execution success. `ReplayCompleted` is emitted only from the committed terminal transaction. `ValidateOnly` completion records `replay.mode = ValidateOnly` and MUST NOT emit `OrderingKeyUnblocked`.

Additional privileged action examples include:

```text
IntegrityRepairRequested
IntegrityRepairApplied
WorkerPaused
WorkerResumed
```

High-cardinality replayId, eventId, OrganizationId, ordering key, IdentityId, and MembershipId belong in authorized logs and audit, never metric labels.

---

## Telemetry Retention

Initial MVP production defaults:

| Data set | Default retention |
|---|---:|
| Metrics | 30-day active SLO and dashboard query window; provider-managed non-sensitive rollups may remain longer under ADR-0003 |
| Sampled traces | 7 days |
| Application, Worker, deployment, database, and access logs | 30 days |
| Restricted security logs | 90 days |
| Class A and Class B durable audit | 365 days |
| Persisted Class C denial telemetry | Maximum 30 days |
| Class D aggregated security observations | 30 days |
| Terminal operational workflow records and health history | 90 days after terminal resolution |

For a managed metric backend with fixed rollup retention, the table defines AIOS active query and SLO windows rather than a guaranteed provider deletion time. Such a backend is permitted only when metric dimensions contain bounded T0 or approved T1 attributes and exclude Organization, Aggregate, Human, request, trace, and external-correlation identifiers. The implementation ADR MUST record the provider retention and the security rationale. Logs, audit, operational workflow records, and traces do not inherit this metric-only exception.

Longer retention requires a documented legal, contractual, security, or operational need. Shorter retention must not break an active incident investigation, SLO window, reconciliation requirement, or mandatory audit period.

Retention configuration MUST be versioned, monitored, and tested. Expiry-job failure and retention backlog are operational alerts.

Legal hold overrides automatic expiry only for the explicitly recorded scope.

---

## Log Immutability

Centralized production logs should be protected from ordinary modification.

Application roles should not be able to delete centralized logs.

Stronger immutable storage may be used for security logs.

---

## Telemetry Access

Telemetry access MUST follow least privilege.

| Role | Default access |
|---|---|
| Developer | T0 and T1 application telemetry for assigned environments |
| Platform Operator | Infrastructure, Worker, and operational records required for recovery |
| Platform Security | Restricted authorization, isolation, and threat telemetry |
| Database Administrator | PostgreSQL operational telemetry without business content |
| Organization Administrator | Organization-scoped audit export only; no direct platform log or trace access |

Requirements:

- production access uses named identity and MFA
- access to T2 or restricted security telemetry is logged
- cross-Organization search requires a typed capability, reason, and durable audit
- bulk export is disabled by default
- shared credentials and unrestricted permanent access are prohibited
- break-glass access is time-bounded and reviewed
- vendor access is separately approved and time-bounded

Possession of telemetry access does not grant permission to change business state or execute operational commands.

---

## Log Sampling

Sampling may be applied to:

- successful health checks
- high-volume successful authorization
- successful Worker item processing
- repeated known benign validation failures

Sampling must not remove:

- Critical events
- authorization Deny for authoritative commands
- invariant violations
- cross-Organization violations
- retry exhaustion
- poison events
- data repair actions
- deployment failures

---

## Log Rate Limiting

Repeated identical errors may be rate-limited to protect the telemetry pipeline.

The system must preserve:

- total count metric
- first occurrence
- latest occurrence
- representative correlation identifiers
- escalation when rate increases

---

## Correlation Model

AIOS uses separate server-owned and caller-supplied identifiers. They have different trust, lifecycle, and persistence rules.

```text
requestId
commandId
correlationId              # internalCorrelationId; server-owned
externalCorrelationId      # optional; untrusted caller metadata
causationId
eventId
traceId
spanId
```

They MUST NOT be used interchangeably. An identifier provides correlation only; it is neither proof of identity nor proof of authorization.

---

## Correlation Trust Boundary

At every public ingress, AIOS MUST generate a new server-owned `requestId` and `correlationId`. A value supplied by an external caller MUST NOT be accepted, promoted, or copied into the internal `correlationId` field.

If a caller supplies a correlation header, AIOS MAY retain it as `externalCorrelationId` after bounded validation. It remains untrusted metadata.

A trusted internal continuation MAY propagate an existing internal `correlationId` only when the caller identity and message integrity are authenticated by an explicitly approved internal transport. In the Modular Monolith, in-process propagation is the default and does not cross this trust boundary.

The following rules are mandatory:

- public API responses return the server-owned `correlationId`, not the caller-supplied value
- `externalCorrelationId` MUST NOT be used for authorization, tenant selection, ownership checks, idempotency, uniqueness, database joins, routing, rate-limit identity, or workflow state changes
- neither internal nor external correlation identifiers are secrets or credentials
- an external business reference that affects domain behavior MUST be modeled as a separately validated Value Object, not overloaded as a correlation identifier
- correlation identifiers MUST NOT be used as metric labels

---

## Request ID

`requestId` identifies one inbound transport request and is generated by AIOS.

Examples:

- one HTTP request
- one CLI invocation
- one administrative operation

A retry creates a new `requestId`. The same logical command may still map to the same `commandId` through the idempotency mechanism.

---

## Command ID

`commandId` identifies one logical authoritative command.

Public callers SHOULD use a separate `Idempotency-Key`. AIOS validates and scopes that key by Organization, authenticated Principal, command type, and canonical request fingerprint, then maps it to a server-owned `commandId`. A caller-supplied value MUST NOT directly become an authoritative `commandId`.

Retries with unchanged intent resolve to the same `commandId`; a changed request using the same idempotency key is rejected. Multiple transport requests may therefore share one `commandId`.

---

## Correlation ID

Within AIOS logs, commands, Domain Events, Integration Events, Outbox records, and durable workflow projections, the field `correlationId` always means the server-owned internal correlation identifier. It identifies one end-to-end business workflow and may span multiple commands, events, worker executions, and traces.

The identifier MUST be globally unique, opaque, and generated with at least 128 bits of collision-resistant entropy. UUIDv7 is the recommended implementation format because it is sortable without exposing domain meaning.

Example:

```text
Request blocking Decision

↓

Decision review

↓

Work Completion Gate update
```

---

## External Correlation ID

`externalCorrelationId` is optional caller-supplied metadata used only to help reconcile AIOS activity with an external system. It is classified as T2 operational metadata unless its content requires a stricter class.

At ingress it MUST be:

- limited to 128 bytes
- limited to a documented safe character set such as `[A-Za-z0-9._:-]`
- stripped of control characters and line breaks
- stored only with the authenticated Organization and ingress record
- excluded from Domain Event payloads and trace baggage by default

An absent or invalid value MUST NOT prevent the business command from being processed. AIOS ignores the invalid value and records a bounded validation outcome without logging the raw input.

If an external provider returns its own correlation value, it is stored as provider-specific untrusted metadata, for example `providerExternalCorrelationId`; it MUST NOT overwrite either AIOS identifier.

---

## Causation ID

`causationId` identifies the immediate cause of an operation.

Examples:

```text
Command causes Domain Event
Domain Event causes Worker command
Replay request causes replay execution
```

It MUST reference an internal immutable identifier such as `commandId`, `eventId`, `replayId`, or `jobRunId`; it MUST NOT reference `externalCorrelationId`.

---

## Event ID

`eventId` uniquely identifies one immutable Domain or Integration Event. Retries and redeliveries preserve the same `eventId`.

---

## Trace ID

`traceId` identifies one telemetry trace. A trace may cover one HTTP command, Worker execution, or replay operation. A business correlation may span multiple traces.

Inbound trace context is subject to the Trace Context Trust rules below. A trace identifier MUST NOT be substituted for `correlationId`.

---

## Span ID

`spanId` identifies one operation inside a trace.

Examples:

- authorization evaluation
- Aggregate load
- Aggregate save
- Outbox insert
- external provider call

---

## Correlation Propagation

At public ingress AIOS creates:

```text
requestId             = new server-owned identifier
correlationId         = new server-owned identifier
externalCorrelationId = validated caller value or null
trace context         = accepted or replaced under Trace Context Trust rules
```

The internal `correlationId` is propagated through the Application Service, Aggregate execution metadata, Domain Events, Transactional Outbox, workers, and durable operational projections.

The `externalCorrelationId` remains at the ingress and observability boundary. It MAY be copied to a security-approved structured log field or audit metadata for reconciliation, but MUST NOT be placed in Domain Event payloads, Integration Event contracts, trace baggage, or downstream command identity by default.

---

## Command Correlation

A Human command envelope should include:

```text
commandId
correlationId          # server-owned internal identifier
requestId
principal
organizationId
expectedVersion
```

The Application Service propagates these into:

- logs
- traces
- authorization audit
- Domain Events
- Outbox
- processed-command records

The untrusted `externalCorrelationId` is not part of the authoritative command envelope.

---

## Event Correlation

Every Domain Event envelope should include:

```text
eventId
correlationId          # server-owned internal identifier
causationId
aggregateId
aggregateVersion
organizationId
actorReference
```

When a command creates the event:

```text
causationId = commandId
```

The event schema MUST NOT define `externalCorrelationId` as an authoritative envelope field. Integration-specific external references belong to an explicit versioned contract field with documented semantics.

---

## Consumer Correlation

When a consumer handles an event:

```text
correlationId = event.correlationId
causationId   = event.eventId
```

The consumer execution creates a new `requestId`, `traceId`, and `spanId`. It does not accept an external value as the internal correlation identifier.

---

## Follow-Up Event Correlation

When event handling emits another Domain Event:

```text
newEvent.correlationId = sourceEvent.correlationId
newEvent.causationId   = sourceEvent.eventId
```

---

## Replay Correlation

An operational replay is a new execution and MUST receive a new server-owned `replayCorrelationId`. The original immutable event and its `correlationId` are not mutated.

The replay wrapper records:

```text
correlationId         = replayCorrelationId
causationId           = replayId
originalEventId
originalCorrelationId = originalEvent.correlationId
replayId
```

The replayed delivery retains the original immutable `eventId` inside the wrapper. Any new consequence emitted by replay uses the replay correlation as its active `correlationId` and retains `originalCorrelationId` only as non-authoritative lineage metadata. This keeps live and replay executions distinguishable during incident analysis.

---

## Scheduled Job Correlation

Each scheduled job run creates a server-owned:

```text
jobRunId
correlationId
```

Each processed item records:

```text
causationId = jobRunId
```

Items retain their business identifiers. A schedule name, tenant-supplied value, or external correlation value MUST NOT be promoted to `correlationId`.

---

## Correlation Persistence and Search

Durable operational records SHOULD store separate columns for:

```text
organization_id
correlation_id
external_correlation_id nullable
occurred_at
```

Indexes MUST begin with `organization_id` for tenant-scoped paths. External correlation values MUST NOT have a global uniqueness constraint. Search by `externalCorrelationId` requires exact match, an Organization scope, a bounded time range, pagination, and the same authorization and audit controls as other operational searches.

Operators should be able to search authorized telemetry by:

- correlationId
- commandId
- eventId
- aggregateId
- organizationId
- replayId
- findingId
- traceId
- externalCorrelationId, only within an authorized Organization scope

Cross-Organization search is restricted to explicitly authorized platform-security or incident-response roles and MUST be audited. Search results MUST visually distinguish internal and external identifiers so operators cannot mistake caller metadata for trusted workflow lineage.

---

## Trace Architecture

Tracing should cover synchronous and asynchronous execution.

---

## HTTP Trace

Recommended spans:

```text
HTTP Request

├── Resolve Principal
├── Resolve Organization
├── Authorize Command
├── Load Aggregate
├── Execute Domain Command
├── Persist Transaction
│   ├── Save Aggregate
│   ├── Insert Outbox
│   ├── Insert Audit
│   └── Insert Processed Command
└── Build Response
```

---

## Worker Trace

Recommended spans:

```text
Worker Item

├── Validate Event Envelope
├── Check Processed Event
├── Load Target Aggregate
├── Execute Handler
├── Persist Effect
│   ├── Save Aggregate
│   ├── Insert Follow-Up Outbox
│   └── Mark Processed
└── Record Outcome
```

---

## Memory Generation Trace

Recommended spans:

```text
Memory Generation Operation

├── Load Completed Work Input
├── Build Generation Request
├── Call AI Provider
├── Validate Generated Output
├── Recheck Work and Generation State
├── Create Memory Transaction
└── Record Generation Outcome
```

The external AI call must occur outside a long database transaction.

---

## Database Spans

Database spans should include:

```text
db.system = postgresql

operationName

db.operation

duration

rowsAffected

retryCount
```

Full SQL and sensitive parameters should not be exported by default.

---

## External Dependency Spans

External calls should include:

```text
dependencyName

operationName

timeout

retryAttempt

responseStatusClass

duration
```

Do not include secrets or full payloads.

---

## Span Status

Spans should use clear outcomes:

```text
Unset

Ok

Error
```

Business rejection such as:

```text
AuthorizationDenied
```

may be an expected outcome rather than an infrastructure exception, but should still have appropriate span attributes.

---

## Trace Sampling

Recommended approach:

- sample a baseline percentage of successful traces
- retain all Error traces
- retain all Critical traces
- retain security-relevant Deny traces
- retain high-latency traces
- retain replay and repair traces
- retain traces associated with invariant violations

---

## Tail-Based Sampling

Tail-based sampling is preferred when available because it can retain traces based on final outcome.

It is optional for the MVP.

---

## Trace Retention

Sampled production traces have an initial default retention of 7 days.

Traces are diagnostic data, not durable business history. They MUST NOT be retained longer merely to compensate for missing audit or operational state.

Incident-specific trace retention requires recorded scope, owner, expiry, and data classification.

---

## Trace Context Trust

Inbound trace context is untrusted.

The system should:

- validate format
- limit baggage size
- discard disallowed baggage
- avoid trusting client-provided Organization or principal attributes
- create server-owned security attributes

---

## Baggage Restrictions

Trace baggage must not contain:

- authentication tokens
- email addresses
- Work content
- Decision content
- Memory content
- permission lists
- invitation data
- secrets

---

## Audit Architecture

Audit supports accountability and security investigation. It is distinct from ordinary logs, metrics, and traces.

Audit evidence MUST be:

- append-oriented
- assigned a durability class before implementation
- transactionally persisted when required by that class
- queryable by Organization and actor under authorization
- linked to command, correlation, and event identifiers
- protected from ordinary update and deletion
- bounded against deliberate write amplification
- free of unnecessary business content and secrets

The Aggregate and Domain Event remain authoritative for business state. Audit records prove who acted, which policy was evaluated, what operation was attempted, and whether durable execution evidence exists.

---

## Audit Categories

Required categories:

```text
Authorization

HumanAuthority

Membership

Ownership

DomainLifecycle

Replay

DataRepair

SecurityAdministration

ConfigurationChange
```

---

## Audit Durability Classes

Every audit-producing operation MUST select exactly one class.

### Class A — Transactional Mandatory

Use for successful state changes whose accountability must be atomic with the authoritative mutation.

Examples:

- Work completion
- Decision approval, rejection, or withdrawal
- Memory approval or rejection
- Organization ownership transfer
- role or permission changes
- Human-authoritative Membership changes
- System capability-policy changes

Required behavior:

- the business transaction writes either the final audit row or a durable audit event to the Transactional Outbox
- commandId or another stable idempotency key prevents duplicate success evidence
- if durable evidence cannot be written, the authoritative mutation rolls back
- a rolled-back command MUST NOT be recorded as successfully executed

A durable Outbox audit event satisfies the transaction boundary only when it is retryable and the final audit projection can be reconciled.

### Class B — Durable Independent

Use for privileged operational actions and security-relevant denials that have no domain mutation transaction.

Examples:

- replay, dead-letter skip, or projection rebuild
- data repair
- Worker pause or resume
- Organization containment
- maintenance-mode changes
- cross-Organization denial
- Human-authority violation
- denied Platform Operator command
- repeated denial pattern promoted by security policy

Required behavior:

- a privileged operational action MUST NOT execute until its intent audit is durable
- completion or failure is appended as a second result record
- denial remains denied when audit persistence fails
- audit-write failure creates an operational or security alert
- retries use a stable operation or audit id

### Class C — Best-Effort Security Telemetry

Use for ordinary authenticated denials that are expected during normal product use and do not indicate a security boundary attack.

Examples:

- stale UI submits an operation no longer permitted by lifecycle state
- a Member attempts an unavailable action
- an expected policy denial without cross-Organization or Human-authority implications

Required behavior:

- emit structured security telemetry when capacity permits
- do not synchronously block the denial response on durable audit storage
- retain bounded counters for telemetry loss
- promote the event to Class B when policy, repetition, or context makes it security-relevant

Class C MUST NOT be used for successful Human-authoritative mutations.

### Class D — Rate-Limited or Aggregated

Use for unauthenticated, malformed, automated, or repeated traffic that could create audit-table or telemetry-pipeline denial of service.

Examples:

- repeated invalid tokens
- malformed requests
- credential-stuffing patterns
- repeated identical denials from one bounded client identity
- high-volume probing of nonexistent resources

Required behavior:

- deny the request independently of audit success
- apply per-route, per-principal or protected client-fingerprint, and global limits
- aggregate repeated observations by bounded reason and time window
- sample detailed records after the configured threshold
- expose accepted, aggregated, sampled, and dropped counters
- never store credentials, raw tokens, or unbounded attacker-controlled text

Rate limiting audit evidence MUST NOT weaken authentication, authorization, Organization isolation, or Human authority.

---

## Audit Classification Matrix

| Audit scenario | Class | Persistence boundary | Failure behavior |
|---|---|---|---|
| Successful Human-authoritative transition | A | Same transaction as mutation, directly or through Outbox | Roll back mutation |
| Successful role, ownership, or permission change | A | Same transaction as mutation, directly or through Outbox | Roll back mutation |
| Replay, repair, containment, or Worker control | B | Durable intent before execution; append result | Do not execute without intent audit |
| Cross-Organization or Human-authority denial | B | Separate durable audit | Remain denied and alert on audit loss |
| Ordinary authenticated policy denial | C | Best-effort bounded telemetry | Remain denied; count telemetry loss |
| Unauthenticated, malformed, or denial-flood traffic | D | Rate-limited, sampled, or aggregated | Remain denied; protect service capacity |

The classification is based on security and accountability impact, not on the volume that happens to be observed in one environment.

---

## Authorization Audit

Every accepted authoritative command MUST produce Class A authorization evidence containing:

```text
principal

principal type

organization

permission

resource

policy identifier and version

Allow outcome

reason code

evaluated time

command identifier

resulting Domain Event or Outbox reference
```

Denied commands do not enter the domain mutation transaction.

Deny evidence follows the durability classes:

- security-relevant denial: Class B
- ordinary authenticated denial: Class C
- unauthenticated, malformed, or flood traffic: Class D

A failed Deny audit write never changes the authorization outcome to Allow.

---

## Lifecycle Audit

Human-authoritative transitions should have dedicated durable audit evidence.

Examples:

```text
WorkCompleted

DecisionApproved

DecisionRejected

DecisionWithdrawn

MemoryApproved

MemoryRejected
```

The Domain Event and Aggregate state remain authoritative.

The audit record supports accountability and investigation.

---

## Membership Audit

Audit:

- invitation creation
- invitation acceptance
- Membership activation
- Membership suspension
- Membership reactivation
- Membership revocation
- role assignment
- role revocation
- ownership transfer

---

## Replay Audit

Replay is Class B durable operational audit. The request intent MUST commit before asynchronous execution.

Required request evidence includes:

- replayId
- requester Identity and Membership
- source Organization
- reason code and reason
- immutable target event and registered consumer
- canonical replay mode
- expected dead-letter and ordering-state versions
- authorization policy identifier and version
- side-effect class and registered recovery-policy reference
- request timestamp

Required execution evidence includes:

- execution-time authorization result
- handler version
- replay and consumer claim versions
- start and completion timestamps
- terminal replay, processed-event, dead-letter, and ordering-state results
- stable result, reconciliation, compensation, effect-ledger, or error reference

Authorization denial is audited as `Denied`, not reported as a technical replay failure. A successful `ValidateOnly` audit explicitly states that no consumer effect, dead-letter resolution, or ordering unblock occurred.

Payload content, authentication credentials, provider secrets, and unrestricted exception text are excluded.

---

## Data Repair Audit

Every controlled data repair should record:

```text
operator identity

Organization

affected resources

reason

approval reference

before-state hash

after-state hash

executed tool version

execution time

result
```

Sensitive before-and-after content should not be copied into the audit record unnecessarily.

---

## Audit and Domain Events

Audit records and Domain Events serve different purposes.

```text
Domain Event
    communicates committed domain fact
```

```text
Audit Record
    records accountability and authorization context
```

Neither should replace the other.

---

## Audit Failure

Failure behavior is determined by durability class.

```text
Class A evidence fails
    → roll back the authoritative mutation

Class B intent evidence fails
    → do not execute the privileged operation

Class B denial evidence fails
    → keep the request denied and raise an audit-persistence alert

Class C telemetry fails
    → keep the request denied and increment the loss counter

Class D storage limit is reached
    → keep the request denied, aggregate or drop details, and increment the loss counter
```

Silent loss of successful authoritative execution evidence is prohibited.

Audit failure MUST NOT grant permission, cross an Organization boundary, delegate Human authority, or turn a failed command into a successful one.

The Class A rule may be changed only by an ADR that defines equivalent durable evidence, reconciliation, failure semantics, and operational ownership.

---

## Audit Query Access

Audit queries require elevated authority.

Organization administrators may receive Organization-scoped audit access.

Platform-wide audit access must remain restricted.

---

## Audit Export

Audit export should:

- require explicit permission
- preserve Organization scope
- redact sensitive fields
- record the export action
- use bounded date ranges
- avoid unrestricted bulk extraction

Audit export is optional for the MVP.

---

## Operational Log Taxonomy

Stable operational log names improve search, alerting, and dashboards. They remain telemetry and are not Event contracts.

Recommended `operationalLogCategory` values:

```text
Application
Authorization
DomainWorkflow
Database
Outbox
Consumer
Worker
Projection
Reconciliation
Deployment
Migration
Backup
Security
Configuration
```

---

## Naming Pattern

Recommended pattern:

```text
<ObservedSubject><StageOrAction><Outcome>
```

Examples:

```text
DecisionCommandCompleted
OutboxRelayFailed
ConsumerEffectsCommitted
MemoryGenerationRetryScheduled
OrganizationIsolationViolationDetected
```

Names must identify the stage whose result is known. `OutboxRecordRelayed` and `ConsumerEffectsCommitted` are intentionally different log names.

---

## Outcome Values

Recommended stable values:

```text
Started
Succeeded
Failed
Denied
Skipped
Retried
Expired
Cancelled
Degraded
```

---

## Log Schema Version

Structured log records use:

```text
logSchemaVersion = 3
```

Version 3 fixes the base envelope and moves specialized fields into registered namespaced `attributes`. The compatibility rules in the Operational Log Envelope section govern later changes.

---

## Example Operational Log Record

```json
{
  "logSchemaVersion": 3,
  "timestamp": "2026-07-24T12:00:00Z",
  "severity": "Info",
  "operationalLogName": "ConsumerEffectsCommitted",
  "operationalLogClass": "ConsumerDelivery",
  "operationalLogCategory": "Consumer",
  "message": "The consumer effects and processed-event marker committed.",
  "serviceName": "aios-memory-worker",
  "serviceVersion": "1.0.0",
  "environment": "production",
  "outcome": "Succeeded",
  "durationMs": 184,
  "attributes": {
    "identity.correlation_id": "corr-...",
    "identity.causation_id": "domain-event-...",
    "identity.organization_id": "org-...",
    "identity.principal_type": "System",
    "domain.aggregate_type": "Memory",
    "domain.aggregate_id": "memory-...",
    "event.domain_event_id": "domain-event-...",
    "event.domain_event_type": "WorkCompleted",
    "event.consumer_name": "memory-generation",
    "event.processed_marker_id": "processed-event-...",
    "worker.worker_id": "worker-03",
    "worker.attempt": 1
  }
}
```

---

## Log Field Cardinality

Low-cardinality base fields and attributes may be indexed for aggregation. Examples include:

```text
serviceName
environment
operationalLogName
operationalLogClass
operationalLogCategory
outcome
error.category
event.consumer_name
domain.aggregate_type
```

High-cardinality attributes include:

```text
identity.organization_id
identity.command_id
identity.correlation_id
identity.trace_id
identity.principal_id
domain.aggregate_id
event.domain_event_id
event.integration_message_id
event.operational_event_id
operations.audit_record_id
worker.operation_id
ai.generation_operation_id
```

High-cardinality attributes belong only in permitted logs and traces, not ordinary metric labels. Their namespace does not change their privacy class.

---

## Message Redaction

Before a log is emitted, redaction should remove:

- bearer tokens
- cookies
- passwords
- database credentials
- invitation tokens
- API keys
- authorization headers
- full email addresses where unnecessary
- raw prompt and generated content

---

## Redaction Failure

If the system cannot guarantee safe redaction of a provider or exception payload:

```text
do not log the raw payload
```

Log only:

- provider
- status class
- error category
- bounded error code
- payload hash
- correlation identifiers

---

## Log Injection Protection

User-controlled values must remain structured fields.

They should not be concatenated into free-text log templates without escaping.

This prevents malicious or accidental log-line injection.

---

## Production Console Output

Containers and processes may write structured logs to:

```text
stdout

stderr
```

The platform collects and forwards them centrally.

Local file logging inside ephemeral containers should not be the primary strategy.

---

## Local Development Logging

Local development may use:

- readable console formatting
- expanded Debug details
- developer-only SQL detail
- local trace viewer

Production field names and operational log names should remain consistent.

---

## Clock and Timestamp

Telemetry timestamps must use UTC.

Recommended representation:

```text
ISO 8601

with timezone
```

System clocks should use reliable synchronization.

---

## Duration Measurement

Durations should use monotonic clocks where available.

Wall-clock timestamps should not be subtracted when clock adjustment could distort duration.

---

## Part 1 Invariants

The observability foundation must preserve:

1. Every command and Worker operation has a correlation identifier.
2. Command retries reuse commandId only when intent is unchanged.
3. Domain Events preserve correlationId and immediate causationId.
4. Logs use stable structured operational log names.
5. Error categories and error codes are machine-queryable.
6. High-cardinality identifiers are not ordinary metric labels.
7. Sensitive domain content is excluded from telemetry by default.
8. Required durable audit participates in authoritative transactions.
9. Logs and traces do not replace authoritative PostgreSQL state.
10. Human-authority boundary violations are observable.
11. Cross-Organization violations are observable without unsafe disclosure.
12. Retry attempts and exhaustion remain visible.
13. Worker lease expiry is observable and recoverable.
14. Event contract failures do not expose full payloads.
15. Trace context is propagated but never trusted for authorization.
16. Optional telemetry export is bounded and cannot roll back valid business operations or consume unbounded process resources.
17. Audit failure may roll back authoritative commands where audit is required.
18. Replay and repair operations are fully attributable.
19. Timestamps use UTC.
20. Telemetry schema changes are versioned.
21. Reconciliation detects failure of an independently owned guarantee; it never replaces preventive enforcement or directly mutates authoritative Domain state.
22. Specialized log attributes use registered namespaces and class contracts; modules cannot add ad hoc top-level fields.
23. The MVP telemetry provider, Region, cost limits, retention constraints, and operational owners are selected by an implementation ADR; vendor details remain outside Domain and Application contracts.

---

## Part 1 Design Summary

The AIOS observability foundation combines:

```text
Structured Logs

Metrics

Distributed and Local Traces

Durable Audit Records

Correlation and Causation

Stable Error Taxonomy

Privacy-Aware Telemetry
```

Every synchronous command and asynchronous consequence can be traced through stable identifiers.

Human authority, Organization isolation, retries, event handling, Worker recovery, and privileged operational actions remain visible without making telemetry a new source of business authority.

## Metrics Architecture

Metrics provide continuous quantitative visibility into the operational health and business workflow progression of AIOS.

Unlike logs, metrics are optimized for:

- trend analysis
- alerting
- dashboards
- capacity planning
- Service Level Indicators
- Service Level Objectives

Metrics should be:

- inexpensive to collect
- bounded in cardinality
- easy to aggregate
- resilient to transient failures
- understandable by operators

---

## Metric Design Principles

Metrics should measure:

```text
Availability

Latency

Throughput

Failures

Queue Health

Workflow Progress

Resource Consumption

Recovery Progress
```

Metrics must not expose sensitive business content.

---

## Metric Categories

AIOS metrics are divided into:

```text
Application

Domain Workflow

Authorization

Database

Outbox

Workers

Projections

Infrastructure

Security

Operations
```

Each category has distinct operational responsibilities.

---

## RED Metrics

All externally visible services should expose RED metrics.

RED stands for:

```text
Rate

Errors

Duration
```

These metrics apply to:

- HTTP APIs
- internal command handlers
- background Workers
- replay services

---

## Request Rate

Measure:

```text
requests per second
```

The HTTP request counter uses only server-derived, bounded dimensions:

```text
service
route_template
http_method
operation
outcome_class
```

Conceptual metric:

```text
http_server_requests_total{
    service,
    route_template,
    http_method,
    operation,
    outcome_class
}
```

`route_template` is the matched framework route template, for example:

```text
/organizations/{organizationId}/works/{workId}
```

It is not the request path. `operation` is a server-owned value from the version-controlled operation registry, for example `work.complete` or `decision.approve`; it is not a controller name, caller-supplied GraphQL operation name, RPC method string, or arbitrary span name.

Organization and resource identifiers are prohibited as metric labels even when they appear as route parameters.

---

## Error Rate

Measure:

```text
failed requests

authorization denials

validation failures

internal failures

timeouts
```

Separate expected business denials from unexpected infrastructure failures.

---

## Request Duration

Measure end-to-end execution time.

Preferred percentiles:

```text
P50

P95

P99
```

Average latency alone is insufficient.

---

## USE Metrics

Infrastructure components should expose USE metrics.

USE stands for:

```text
Utilization

Saturation

Errors
```

Examples:

```text
Database Connections

CPU

Memory

Disk

Worker Pool

Connection Pool
```

---

## Domain Workflow Metrics

Infrastructure health alone does not indicate whether AIOS is functioning correctly.

Business workflow progression must also be measured.

---

## Work Lifecycle Metrics

Recommended metrics:

```text
work_created_total

work_completed_total

work_cancelled_total

work_completion_duration_seconds

work_waiting_for_decision_total

work_completion_gate_pending_total
```

These metrics reveal workflow progression rather than infrastructure behavior.

---

## Decision Metrics

Recommended:

```text
decision_created_total

decision_submitted_total

decision_approved_total

decision_rejected_total

decision_withdrawn_total

decision_review_duration_seconds
```

Review duration is measured from:

```text
submitted_at

↓

approved/rejected/withdrawn_at
```

---

## Memory Metrics

Recommended:

```text
memory_generated_total

memory_generation_failed_total

memory_submitted_total

memory_approved_total

memory_rejected_total

memory_review_duration_seconds
```

Generation latency begins when:

```text
WorkCompleted event committed
```

and ends when:

```text
Memory Generated
```

---

## Completion Gate Metrics

Recommended:

```text
completion_gate_pending_total

completion_gate_satisfied_total

completion_gate_unsatisfied_total
```

These metrics help identify approval bottlenecks.

---

## Workflow Latency Metrics

The Work-to-Memory workflow MUST expose one end-to-end measure and stage-level diagnostic measures.

Canonical timing chain:

```text
WorkCompleted committed
    ↓
Outbox record relayed
    ↓
Memory generation consumer started
    ↓
AI provider call completed
    ↓
Generated output validated
    ↓
Memory persistence transaction committed
```

Required histograms:

```text
work_commit_to_outbox_relay_seconds

outbox_relay_to_consumer_start_seconds

memory_generation_provider_seconds

memory_generation_validation_seconds

memory_generation_persistence_seconds

work_completion_to_memory_generated_seconds
```

Optional diagnostic histograms:

```text
consumer_start_to_provider_start_seconds

memory_generation_attempt_seconds

memory_generation_retry_delay_seconds
```

The end-to-end measure is authoritative for the Work-to-Memory SLO. Stage measures explain where time was spent; they do not replace the end-to-end result.

---

## Work-to-Memory Timestamp Contract

The following timestamp semantics MUST be stable:

| Timestamp | Meaning | Durable source |
|---|---|---|
| workCompletedAt | WorkCompleted recorded in the authoritative Work transaction | Domain-event or Outbox recorded timestamp |
| outboxRelayedAt | Outbox publisher durably records successful relay | Outbox delivery state |
| consumerStartedAt | Consumer durably creates or claims the logical generation operation | Memory generation attempt |
| providerStartedAt | A specific external provider attempt starts | Trace or operational measurement |
| providerCompletedAt | The provider attempt returns or times out | Trace or operational measurement |
| validationCompletedAt | Provider output validation completes | Trace or operational measurement |
| memoryPersistenceStartedAt | The short Memory persistence transaction begins | Trace or operational measurement |
| memoryGeneratedAt | Memory draft, generation outcome, and MemoryGenerated Outbox record commit | PostgreSQL transaction timestamp |

Cross-process durations MUST use persisted UTC timestamps from the participating boundaries. In-process durations SHOULD use a monotonic clock.

Wall-clock differences, retry overlap, and queue rescheduling mean stage histograms are diagnostic and are not required to sum exactly to the end-to-end duration.

---

## Retry Measurement

Provider, validation, and persistence durations are recorded per attempt.

The end-to-end duration is recorded once per logical generation operation:

```text
memoryGeneratedAt - workCompletedAt
```

A retry MUST NOT create a second Work-to-Memory SLO observation.

Metrics MAY use bounded labels such as outcome, failureCategory, workerType, and configured provider. They MUST NOT use organizationId, workId, generationOperationId, eventId, raw model response, or error message as metric labels.

---

## Durable Memory Generation State

Logs, metrics, and traces are not sufficient to determine whether Memory generation is pending, running, retrying, or terminal.

The authoritative operational record is `memory_generation_operations`, keyed by Organization, Work, and generation policy.

Required fields include:

```text
generationOperationId
organizationId
workId
sourceEventId
sourceSnapshotId
generationPolicyVersion
status
attemptCount
nextAttemptAt
lockedBy
lockedUntil
claimVersion
firstStartedAt
lastAttemptAt
completedAt
lastErrorCode
createdAt
updatedAt
```

Canonical statuses are:

```text
Pending
Generating
RetryPending
Generated
Failed
Abandoned
```

Required rules:

- duplicate `WorkCompleted` delivery reuses the same logical generation operation;
- each real provider attempt increments `attemptCount` exactly once;
- claim recovery and deferral do not increment attempts;
- provider timeout with no usable candidate becomes `RetryPending` while budget remains;
- Work remains Completed when generation fails;
- a stale or lease-lost response is discarded;
- partial provider output is never exposed as Memory;
- `Generated` is recorded only in the same commit that creates or proves the matching reviewable Memory, processed-event result, `MemoryGenerated` Outbox record, and required audit;
- terminal failure remains queryable until authorized retry or abandonment; and
- reconciliation compares operation, source snapshot, Work, Memory, Outbox, and processed-event state.

Required bounded metrics include:

```text
memory_generation_pending_total
memory_generation_generating_total
memory_generation_retry_pending_total
memory_generation_failed_total
memory_generation_attempt_total
memory_generation_timeout_total
memory_generation_stale_response_total
memory_generation_duplicate_provider_call_total
memory_generation_oldest_pending_age_seconds
```

Labels may include bounded outcome, failure category, configured provider, and registered model reference. OrganizationId, WorkId, operationId, eventId, workerId, claimVersion, raw model response, and error message are prohibited metric labels.

---

## External Effect Ledger Observability

This section applies only when an `ExternalBusinessEffect` consumer is enabled. The baseline MVP has none.

Canonical ledger statuses are `Prepared`, `InFlight`, `Succeeded`, `ConfirmedAbsent`, `OutcomeUnknown`, `Failed`, `Compensating`, and `Compensated`. Telemetry uses these persisted values without aliases.

Required operational log names are:

```text
ExternalEffectPrepared
ExternalEffectSendStarted
ExternalEffectSucceeded
ExternalEffectConfirmedAbsent
ExternalEffectOutcomeUnknown
ExternalEffectReconciliationStarted
ExternalEffectCompensationStarted
ExternalEffectCompensated
ExternalEffectLeaseLost
```

A success log is emitted only from committed `Succeeded` evidence. Timeout, acknowledgement loss, post-send lease loss, or local commit uncertainty emits `ExternalEffectOutcomeUnknown`; it MUST NOT emit failure-as-absence or trigger blind retry.

Required bounded metrics are:

```text
external_effect_in_flight_total
external_effect_outcome_unknown_total
external_effect_reconciliation_due_total
external_effect_compensation_in_progress_total
external_effect_send_total
external_effect_terminal_total
external_effect_oldest_unknown_age_seconds
```

Allowed labels are bounded registered values such as consumer name, effect type, provider, status, and recovery mode. OrganizationId, eventId, effectOperationId, effectKey, provider idempotency key, provider operation reference, ordering key, and raw error are prohibited labels.

The Organization-scoped health query exposes protected identifiers and stable evidence references from PostgreSQL under authorization; dashboards expose only bounded aggregate counts.

---

## Authorization Metrics

Recommended:

```text
authorization_allow_total

authorization_deny_total

authorization_policy_failure_total

human_authority_violation_total

organization_isolation_violation_total
```

Unexpected increases should trigger investigation.

---

## Worker Metrics

Every Worker should expose:

```text
worker_jobs_started_total

worker_jobs_completed_total

worker_jobs_failed_total

worker_retry_total

worker_claim_expired_total

worker_duration_seconds
```

---

## Queue Metrics

Outbox publication and consumer execution expose separate bounded metrics:

```text
outbox_pending_total
outbox_claimed_total
outbox_failed_total
outbox_oldest_pending_age_seconds

consumer_pending_total
consumer_oldest_pending_age_seconds
consumer_processing_total
consumer_retry_pending_total
consumer_failed_total
consumer_blocked_total
consumer_oldest_retry_age_seconds
consumer_oldest_blocked_age_seconds
consumer_claim_expired_total
consumer_processing_rate

dead_letter_open_total
dead_letter_skipped_total

event_replay_requested_total
event_replay_running_total
event_replay_completed_total
event_replay_failed_total
event_replay_denied_total
event_replay_oldest_requested_age_seconds
```

Labels are limited to registered low-cardinality values such as Worker type, consumer name, event type, status, failure category, and policy. OrganizationId, eventId, ordering key, AggregateId, workerId, and claimVersion are prohibited metric labels.

Queue age is often more important than queue length. `Blocked` deliveries do not increase attempt or retry counters; they use blocked-count and blocked-age metrics.

---

## Database Metrics

Recommended:

```text
active_connections

idle_connections

connection_pool_utilization

transaction_duration_seconds

deadlocks_total

serialization_retries_total

slow_queries_total
```

---

## Projection Metrics

Recommended:

```text
projection_updates_total

projection_failures_total

projection_rebuild_duration_seconds

projection_lag_seconds
```

---

## Reconciliation Metrics

Recommended:

```text
reconciliation_runs_total

reconciliation_findings_open

reconciliation_findings_resolved

reconciliation_duration_seconds
```

---

## Deployment Metrics

Recommended:

```text
deployment_duration_seconds

deployment_failures_total

rollback_total

migration_duration_seconds
```

---

## Backup Metrics

Recommended:

```text
backup_success_total

backup_failure_total

backup_age_seconds

restore_test_success_total

restore_test_duration_seconds
```

---

## Backup and Recovery Operational Contract

`docs/architecture/persistence-and-data-model.md` is the canonical source for recovery semantics, protected data, and restore correctness. This document defines how Operations measures and enforces that contract.

The production MVP objectives are:

```text
Recovery Point Objective (RPO) <= 15 minutes

Authoritative Service Recovery Time Objective (RTO) <= 4 hours

Asynchronous Workflow Recovery Target <= 8 hours
```

The minimum production controls are:

```text
continuous WAL archiving
physical base backup at least every 24 hours
PITR restore window >= 14 days
deletion-resistant backup copy or tier >= 30 days
documented isolated restore test at least monthly
full disaster-recovery exercise at least quarterly
```

Backup-job success is not proof of recoverability. The latest confirmed restorable point, backup integrity result, restore-test result, achieved RPO, achieved RTO, and age of the latest exercise MUST be observable independently.

The following metrics are required in addition to the basic backup counters:

```text
wal_archive_lag_seconds
latest_restorable_point_age_seconds
pitr_window_days
backup_integrity_failure_total
restore_test_failure_total
restore_test_rpo_seconds
restore_test_rto_seconds
restore_test_age_seconds
disaster_recovery_exercise_age_seconds
recovery_external_effect_unknown_total
```

Labels MUST follow the bounded-cardinality and Organization-isolation rules in this document. Recovery-point timestamps, provider request identifiers, backup object names, database names, and raw error text belong in restricted operational records, not metric labels.

Operations MUST alert before the 15-minute RPO is consumed. An unconfirmed latest restorable point older than 15 minutes is a Critical recovery-capability incident even when the most recent base-backup job reports success. A restore test older than 31 days or a disaster-recovery exercise older than 92 days is a control failure and MUST enter the owned operations queue.

During production restoration, publishers, consumers, schedulers, and mutation traffic remain paused until the restored consistency boundary passes the validation contract. Before resuming asynchronous processing, Operations MUST inspect Outbox rows, processed-event records, ordering checkpoints, dead letters, replay state, and expired claims together.

Restored Outbox rows retain at-least-once delivery semantics. For an external side effect whose pre-restore outcome is unknown, the consumer MUST use the effect ledger, stable idempotency key, and provider status query defined by the owning integration. The affected ordering key remains blocked when the outcome cannot be proven. Blind replay of a non-idempotent external effect is prohibited.

---

## Metric Label Contract

Metric labels MUST be bounded, server-derived, non-sensitive, and registered before production use.

Permitted label categories include:

```text
service
environment
route_template
http_method
operation
worker
consumer
workflow_type
status
outcome
outcome_class
error_category
provider_category
model_slot
```

`provider_category` and `model_slot` are bounded configuration aliases. Provider account identifiers, deployment identifiers, and arbitrary provider model names are prohibited.

---

## HTTP Route Template Rules

`route_template` MUST be obtained from the server-side router after route matching. A permitted value is a static template such as:

```text
/organizations/{organizationId}/works/{workId}
```

The following are prohibited metric-label values:

```text
/organizations/org-123/works/work-456
raw URL path
query string
URL fragment
host name supplied by the request
route parameter value
user-agent
referer
```

The ambiguous label name `endpoint` is prohibited. HTTP metrics use `route_template`; non-HTTP metrics use a more precise bounded dimension owned by that metric.

Unmatched, rejected-before-routing, or framework-unknown requests use one fixed value:

```text
route_template = unmatched
```

They MUST NOT derive a template by copying or heuristically rewriting the raw path. This prevents an attacker from creating one time series per requested URL.

---

## Operation Label Registry

Every permitted `operation` value is declared in version-controlled configuration or code with:

```text
operation
owner
protocol
route_template or worker_type
introduced_version
deprecated_version nullable
```

Examples:

```text
work.create
work.complete
decision.submit
decision.approve
memory.approve
outbox.relay
memory.generate
```

Unknown runtime values collapse to the fixed value `unknown` and increment the contract-violation metric. A caller-supplied value MUST NOT extend the registry.

---

## Prohibited High-Cardinality Labels

Prohibited labels and values include:

```text
organizationId
aggregateId
workId
decisionId
memoryId
generationOperationId
domainEventId
integrationMessageId
commandId
requestId
correlationId
traceId
spanId
principalId
membershipId
raw URL path
query string
exception message
SQL text
arbitrary model name
external provider request identifier
```

These values belong only in the protected PostgreSQL operational records, logs, or traces permitted by the telemetry data policy. Trace exemplars may reference a trace identifier without turning it into a metric label.

---

## Label Cardinality Enforcement

The build or startup validation MUST compare each label source with its registered bounded set. The runtime MUST NOT create a new label value from untrusted input when validation is bypassed or stale.

Required self-observation:

```text
metric_label_contract_violation_total{metric,label,reason_code}
metric_series_budget_exceeded_total{metric}
```

`metric`, `label`, and `reason_code` themselves come from bounded registries.

Each service defines a series budget per metric based on the Cartesian product of registered label values plus the fixed `unknown` or `unmatched` fallback. Exceeding the budget raises an operational alert and drops or coalesces the invalid dimension; it MUST NOT create the unbounded series first.

Changing a route template, operation value, label name, or bounded value set is a reviewed telemetry-contract change. Dashboards, alerts, recording rules, and SLI queries are updated in the same release or through a compatible overlap window.

The absence of `organizationId` from metrics MUST NOT make Organization-specific failures invisible. AIOS uses the protected operational-health projection below for bounded administrative detection.

---

## Organization Workflow Health Projection

Global metrics can remain healthy while one Organization is permanently blocked. The MVP MUST maintain a rebuildable PostgreSQL projection for Organization-specific asynchronous workflow health.

Recommended relation:

```text
organization_workflow_health
```

Conceptual structure:

```text
organization_id

workflow_type

status

pending_count

oldest_pending_at

last_attempt_at

last_success_at

consecutive_failures

terminal_failure_count

last_error_code

source_high_water_mark

projection_version

updated_at
```

Recommended key:

```text
PRIMARY KEY (organization_id, workflow_type)
```

MVP workflow types include:

```text
OutboxRelay

MemoryGeneration

Projection

Reconciliation
```

This relation is operational metadata. It is not a Domain Aggregate, does not authorize a command, and is not authoritative for Work, Decision, Memory, Membership, or event-processing completion.

---

## Workflow Health Status

Permitted status values:

```text
Healthy

Degraded

Blocked

Stale

NoData
```

Status meaning:

- Healthy: no overdue pending item and no unresolved terminal failure
- Degraded: warning-age pending work or repeated recoverable failure exists
- Blocked: terminal failure, ordering block, or hard-age threshold prevents progress
- Stale: the projection has not refreshed within its required interval
- NoData: the Organization has no observation for that workflow

A quiet Organization MUST NOT become Degraded only because it has no recent success. Pending age, unresolved failure, ordering state, and projection freshness determine health.

Thresholds are versioned configuration by workflow type. A threshold change MUST NOT alter historical source records.

---

## Projection Update and Reconciliation

Workers and Outbox consumers write durable operational state before emitting diagnostic telemetry.

The health projection SHOULD update after each committed workflow transition and MUST be reconciled on a schedule from:

- Outbox delivery state
- processed-event records
- Memory generation attempts
- projection checkpoints
- reconciliation findings

Each refresh records a source high-water mark and projection version.

The projection MUST be rebuildable. Rebuilding or deleting it does not change the underlying business or delivery truth.

Reconciliation MUST detect:

- pending source records absent from the health projection
- terminal failures reported as Healthy
- a source high-water mark that stops advancing
- duplicate rows or cross-Organization references
- projection freshness beyond the Stale threshold

Projection failure is itself operationally visible. When the projection becomes Stale, operators must not infer that Organizations are Healthy.

---

## Organization Health Query Authorization

Organization-specific health data is protected operational information.

Access rules:

- an Organization administrator may query only that Organization when the product exposes the capability
- a Platform Operator may query across Organizations only through a restricted Operations Application Service
- cross-Organization queries require a typed capability, operator identity, reason, and durable audit
- Secretary principals cannot enumerate Organization health
- raw error messages, prompts, generated content, and foreign Organization data are excluded
- repository methods require explicit organization scope unless the caller has an audited platform-wide capability

The projection MUST NOT be exposed through an unrestricted metrics endpoint.

---

## Organization Health Metrics and Alerts

The metric backend receives only aggregated counts:

```text
organization_workflow_health_organizations{workflow_type,status}

organization_workflow_health_projection_age_seconds

organization_workflow_health_transition_total{workflow_type,from_status,to_status}
```

These metrics MUST NOT contain organizationId.

Initial alert behavior:

- a new Blocked transition creates a High alert
- Blocked MemoryGeneration older than the Work-to-Memory critical threshold creates a Critical alert
- sustained Degraded status creates a Warning alert
- any Stale projection beyond two refresh intervals creates a High alert
- a material drop in Organizations represented by the projection creates a High coverage alert

An alert may contain a protected internal reference that an authorized operator resolves through the Operations Application Service. The metric series and ordinary notification title must remain tenant-neutral.

---

## Service Level Management

SLIs measure observed system behavior. SLOs define the minimum acceptable result over a stated measurement window.

An SLO is valid only when its eligibility rules, numerator, denominator, timestamps, data source, owner, and breach response are defined.

---

## SLO Measurement Policy

The MVP MUST apply the following policy:

- environment: production only
- evaluation window: rolling 30 days, evaluated at least hourly
- time standard: UTC
- maintenance: included by default; an exclusion requires a recorded monitoring-data defect or an approved exceptional event
- low traffic: a ratio SLO is reported as insufficient data when fewer than 1,000 eligible observations exist in the 30-day window
- source of record: ingress metrics for HTTP behavior and PostgreSQL timestamps or durable operational records for asynchronous workflows
- ownership: the Service Owner owns HTTP and platform SLOs; the Work/Memory module owner owns the Work-to-Memory SLO
- review: targets and eligibility rules are reviewed monthly and after every qualifying incident

Changing a target, formula, exclusion, or source requires an implementation ADR or an explicitly versioned operational decision. A dashboard-only change MUST NOT silently redefine an SLO.

---

## HTTP Availability SLI

Eligible requests are production requests to supported customer-facing HTTP operations.

The denominator excludes:

- liveness, readiness, metrics, and administrative diagnostic endpoints
- requests rejected before reaching AIOS by infrastructure that is outside the measured ingress boundary
- synthetic traffic marked by an authenticated internal test identity

A successful observation is an eligible request that produces:

- an expected 2xx or 3xx response
- an expected business or authorization 4xx response

A failed observation is an eligible request that produces:

- an unexpected 5xx response
- an application timeout
- a platform-overload rejection
- a connection termination recorded by the measured ingress after AIOS accepted the request

Formula:

```text
eligible successful HTTP requests
/
all eligible HTTP requests
```

Expected validation and authorization failures count as available because the platform evaluated the request correctly. A capacity-generated rejection does not.

Primary data source:

```text
Normalized ingress request counter using registered `route_template`, `operation`, and `outcome_class` labels
```

---

## HTTP Request Latency SLI

Latency is measured from ingress acceptance until the final response is written for successful eligible synchronous requests.

The SLI reports P50, P95, and P99 by normalized operation category. Raw URL paths, streaming operations, administrative exports, and asynchronous completion time are excluded.

Primary data source:

```text
Ingress duration histogram using the registered `route_template` label
```

External AI-provider time is not included in an HTTP latency SLI when the request only enqueues asynchronous work.

---

## Outbox Relay Timeliness SLI

An eligible Outbox record is a committed, publishable record that is not administratively paused before it becomes eligible.

Formula:

```text
Outbox records relayed within 30 seconds of committedAt
/
all eligible Outbox records
```

The terminal timestamp is the durable relay or delivery marker defined by the Outbox implementation. Repeated attempts do not create additional denominator entries.

Primary data source:

```text
PostgreSQL Outbox committedAt and relayedAt timestamps
```

`oldest_pending_message_age` remains an alerting and diagnostic metric. It is not a substitute for the ratio SLI.

---

## Work-to-Memory System Completion SLI

This SLI measures the AIOS system obligation after a Human completes Work. It does not include Human review time.

Start:

```text
WorkCompleted recordedAt in the authoritative transaction
```

End:

```text
A reviewable Memory draft for the same sourceWorkId is committed
```

Formula:

```text
eligible WorkCompleted records producing exactly one reviewable Memory draft within 5 minutes
/
all eligible WorkCompleted records old enough to have reached the 5-minute deadline
```

Retry exhaustion, manual-intervention state, AI-provider failure, Worker failure, and Outbox delay remain failures in the end-to-end SLI. They are classified separately for diagnosis but are not excluded from customer impact.

Cancelled or administratively suppressed generation is excluded only when that behavior is explicitly permitted by the domain contract and durably recorded before the deadline.

Primary data source:

```text
PostgreSQL WorkCompleted recordedAt
joined to durable Memory generation state and Memory generatedAt by sourceWorkId
```

The unique-Memory invariant remains a database and domain guarantee. An SLO does not weaken it.

---

## Worker Terminal Success SLI

A logical Worker item, not an individual claim attempt, is the unit of measurement.

Formula:

```text
logical items completed before retry exhaustion
/
logical items reaching success or terminal failure during the window
```

A retry is neither a new denominator item nor a success. Administrative cancellation is reported separately and is excluded only when authorized and durably audited.

Primary data source:

```text
Durable Worker item status keyed by logical item identifier
```

---

## Decision Review Workflow Indicators

Human review latency is a product workflow indicator, not a platform reliability SLO.

AIOS MUST report separately:

- time from Decision submission to first Human review
- time spent waiting for Human action
- count and age of Decisions awaiting review
- time from a Human decision command to authoritative persistence

Only the final item is system-processing latency. Human waiting time MUST NOT consume the platform error budget.

For the MVP, a submitted Decision MUST be query-visible from PostgreSQL after its authoritative transaction commits. Missing queue visibility is an integrity or query defect, not an objective that may consume an error budget.

---

## MVP SLO Catalog

| SLO | Target | Window | Minimum volume | Initial alert signal | Owner |
|---|---:|---|---:|---|---|
| HTTP availability | >= 99.9% | Rolling 30 days | 1,000 requests | 5-minute availability < 99% with at least 20 requests | Service Owner |
| HTTP P95 latency | < 500 ms | Rolling 30 days | 1,000 requests | P95 > 1 second for 15 minutes with at least 100 requests | Service Owner |
| Outbox relay within 30 seconds | >= 99.9% | Rolling 30 days | 1,000 records | Oldest publishable record > 60 seconds for 5 minutes | Service Owner |
| Work-to-Memory within 5 minutes | >= 99.0% | Rolling 30 days | 100 completed Works | Any generation older than 5 minutes without a draft; critical at 15 minutes | Work/Memory Owner |
| Worker terminal success | >= 99.0% | Rolling 30 days | 100 logical items | Three terminal failures or < 95% success over 15 minutes | Service Owner |

When volume is below the minimum, dashboards MUST show the raw counts and percentile or ratio but MUST label the formal SLO result as insufficient data.

These are the initial MVP production targets. They may be revised through the versioned decision process after measured production evidence exists.

---

## Error-Budget and Breach Policy

For ratio SLOs:

```text
error budget = 1 - SLO target
```

The owner MUST:

- investigate an alert using the authoritative timestamps and operational evidence
- open an incident when the critical threshold or customer-impact condition is met
- record exclusions and monitoring-data defects
- stop reliability-degrading releases when the 30-day error budget is exhausted
- prioritize recovery and corrective work until the service returns within policy
- review the SLO after incidents without retroactively changing the formula to hide failure

Security isolation, Human authority, immutable approval, exactly-one Memory, and other domain invariants have no consumable error budget. Any violation is a correctness or security incident.

---

## Health Surfaces

AIOS exposes separate health surfaces for synchronous HTTP serving, Worker processes, asynchronous workflow progression, and privileged diagnosis. A combined green or red status MUST NOT be used to represent all four concerns.

| Surface | Primary question | Primary consumer | May affect traffic routing |
|---|---|---|---|
| HTTP liveness | Should this HTTP process be restarted? | process supervisor | restart only |
| HTTP readiness | Can this HTTP process safely accept its supported traffic? | load balancer / orchestrator | yes |
| Worker liveness | Should this Worker process be restarted? | process supervisor | restart only |
| Worker readiness | Can this Worker safely claim and process its assigned work? | Worker scheduler / orchestrator | Worker scheduling only |
| Asynchronous workflow health | Are durable workflows progressing within policy? | operators and alerts | no |
| Administrative diagnostic health | Why is a component or workflow unhealthy? | authorized operators | no |

Health status is operational evidence, not authoritative domain state. Work, Decision, Memory, authorization, and event-processing facts remain authoritative in PostgreSQL.

---

## HTTP Liveness

HTTP liveness answers:

```text
Should this HTTP process be restarted?
```

It checks only conditions that a process restart can plausibly repair, such as:

- process responsiveness
- fatal runtime failure
- unrecoverable deadlock or event-loop stall where detectable
- failure to complete mandatory process initialization

HTTP liveness MUST NOT depend on PostgreSQL, Outbox lag, Worker status, an AI provider, or the telemetry backend. A transient dependency outage must not cause a restart loop.

The endpoint MUST return a minimal status and MUST NOT expose dependency names, connection details, versions, or error text publicly.

---

## HTTP Readiness

HTTP readiness answers:

```text
Can this HTTP process safely accept the traffic routed to it?
```

It MUST include only dependencies and conditions required to serve the instance's supported HTTP operations safely:

- mandatory configuration and secrets are loaded
- active schema and migration versions are compatible
- PostgreSQL connectivity and required connection-pool capacity are available
- the process can start a transaction and perform the read or write class required by its routed operations
- security-critical policy configuration is valid

HTTP readiness MUST NOT fail solely because:

- a background Worker is stopped or unready
- Memory generation is delayed or its provider is unavailable
- Outbox messages are old while new authoritative transactions can still commit safely
- a projection or reconciliation job is stale
- an optional telemetry exporter or centralized observability backend is unavailable

Those conditions are exposed through Worker or asynchronous workflow health and alerts. If a dependency is required by only one HTTP operation, the operation SHOULD fail with a bounded explicit response or be removed from routing by an operation-specific capability gate; it SHOULD NOT make unrelated HTTP operations unready.

If PostgreSQL is reachable but the process cannot atomically persist the authoritative mutation, required audit, and Outbox record, write-serving readiness MUST fail. A deliberately read-only instance MAY remain ready only for routes explicitly configured as read-only.

---

## Startup Checks

Startup checks determine whether a process may enter its normal lifecycle. They are separate from recurring liveness and readiness probes.

Before an HTTP process becomes ready, it MUST verify:

- configuration loaded and schema-valid
- database reachable
- migrations compatible
- required secrets available
- authorization policy configuration valid
- required telemetry initialization completed without making the remote telemetry backend a hard dependency

A failure prevents readiness. Restart behavior is controlled by the deployment platform and must avoid an unbounded crash loop for persistent configuration or migration faults.

---

## Worker Liveness

Worker liveness answers:

```text
Should this Worker process be restarted?
```

It checks process responsiveness, fatal runtime failure, and a locally stalled execution loop. It MUST NOT depend on queue age, AI provider availability, or the progress of another Worker type.

Long-running jobs MUST update a bounded heartbeat or lease. A missed heartbeat marks the execution suspect for recovery, but liveness MUST distinguish an active long-running operation from a dead Worker.

---

## Worker Readiness

Worker readiness is scoped by Worker type and answers:

```text
Can this Worker safely claim and process its assigned work now?
```

It MUST verify:

- claim and lease capability
- PostgreSQL read and write access required by that Worker
- required queue or Outbox schema compatibility
- required dependency initialization and credentials
- retry and backoff controls are operational
- the Worker type is not administratively paused

One Worker type becoming unready MUST NOT make unrelated Worker types or the HTTP process unready. A temporary external-provider outage MAY leave a Worker ready when it can safely claim, defer, and back off without consuming attempts incorrectly; otherwise only that Worker type becomes unready.

Worker readiness does not prove progress. A Worker can be ready yet make no useful progress because of poison events, lock contention, repeated retries, or per-Organization ordering blocks.

---

## Asynchronous Workflow Health

Asynchronous workflow health answers:

```text
Are committed workflows progressing within their operational policy?
```

It is derived from durable PostgreSQL facts and bounded operational projections, including:

- oldest unrelayed Outbox record
- oldest unprocessed consumer delivery
- Worker last-success and lease state
- retry exhaustion and dead-letter state
- Work-to-Memory generation state
- `organization_workflow_health` status and projection freshness

Queue lag, terminal failure, stale projections, and lack of progress change asynchronous workflow health and trigger alerts. They MUST NOT directly change HTTP load-balancer readiness.

Asynchronous workflow health MUST be queryable by workflow type and authorized Organization scope. Metric backends receive only bounded aggregate status counts; Organization identifiers remain in PostgreSQL, logs, traces, and authorized diagnostic results.

---

## Administrative Diagnostic Health

Administrative diagnostic health correlates component and workflow evidence for incident investigation. It MAY report database, Outbox, Worker-type, workflow, projection, and provider conditions in one response, but it is not a liveness or readiness endpoint and MUST NOT be configured as a load-balancer or restart probe.

The diagnostic surface MUST:

- require an authenticated operator with an explicit operational role
- enforce Organization scope and default-deny cross-Organization access
- redact secrets, connection strings, raw exception messages, prompts, and business content
- use stable bounded reason codes rather than unbounded error text
- audit privileged or cross-Organization access under the audit durability policy
- apply rate limits, time bounds, and pagination to detailed queries

---

## Health Failure Matrix

| Condition | HTTP liveness | HTTP readiness | Affected Worker readiness | Async workflow health |
|---|---|---|---|---|
| HTTP process deadlock | Unhealthy | Unhealthy | Unchanged | May become degraded later |
| PostgreSQL unavailable | Healthy unless process stalls | Unhealthy | Unhealthy for DB-dependent Workers | Degraded or Unknown |
| Schema incompatible | Healthy | Unhealthy | Unhealthy for incompatible Workers | Unknown until compatible processing resumes |
| Memory Worker stopped | Healthy | Healthy | Unhealthy for Memory Worker only | Degraded or Critical by age/policy |
| AI provider unavailable | Healthy | Healthy | Memory Worker-specific policy | Degraded by retries or age |
| Outbox lag above threshold | Healthy | Healthy while new transactions remain safe | Publisher may be ready but not progressing | Degraded or Critical |
| Telemetry backend unavailable | Healthy | Healthy | Unchanged | Health evidence may be Stale; transactional audit remains required |
| `organization_workflow_health` stale | Healthy | Healthy | Unchanged | Unknown or Stale, never implicitly Healthy |

`Unknown` and `Stale` are explicit outcomes. Missing evidence MUST NOT be presented as `Healthy`.

---

## Health Response Contracts

Each process probe returns only its own status. An HTTP readiness response MUST NOT embed overall Worker or workflow status.

Minimal public or orchestrator-facing example:

```json
{
  "status": "Ready"
}
```

An authenticated diagnostic response may use bounded component records:

```json
{
  "status": "Degraded",
  "observedAt": "2025-01-01T00:00:00Z",
  "components": [
    {
      "componentType": "MemoryWorker",
      "status": "Unready",
      "reasonCode": "PROVIDER_CREDENTIAL_UNAVAILABLE"
    },
    {
      "componentType": "WorkToMemoryWorkflow",
      "status": "Degraded",
      "reasonCode": "OLDEST_PENDING_OVER_THRESHOLD"
    }
  ]
}
```

Responses MUST NOT expose stack traces, raw database errors, hostnames, credentials, provider responses, tenant data, or other infrastructure details to unauthenticated callers.

---

## Dashboards

Dashboards should support:

- executives
- operators
- developers
- incident responders

Each audience requires different views.

---

## Executive Dashboard

Recommended indicators:

- availability
- Work throughput
- Decision throughput
- Memory throughput
- incident count
- deployment status

---

## Operations Dashboard

Required MVP indicators:

- request rate
- error rate
- latency
- queue age
- Worker throughput
- retry rate
- dead letters
- reconciliation findings
- database health
- Organization workflow-health counts by workflow type and status
- Blocked, Degraded, and Stale Organization counts
- age of the Organization workflow-health projection

The dashboard links to the restricted Operations Application Service for Organization-specific diagnosis. It does not place Organization identifiers in metric labels.

---

## Developer Dashboard

Recommended indicators:

- slow queries
- serialization retries
- deadlocks
- deployment history
- exception rate
- trace latency
- Worker failures

---

## Workflow Dashboard

Recommended indicators:

```text
Work Created

↓

Decision Submitted

↓

Decision Approved

↓

Work Completed

↓

Memory Generated

↓

Memory Approved
```

Each stage should expose throughput and delay.

---

## Alerting Principles

Alerts should be:

- actionable
- specific
- low-noise
- severity classified
- deduplicated
- correlated

---

## Alert Severity

Recommended levels:

```text
Info

Warning

High

Critical
```

---

## Critical Alerts

Examples:

- database unavailable
- authoritative writes failing
- Organization isolation violation
- audit persistence unavailable
- no active Owner detected
- migration failure during deployment

---

## High Alerts

Examples:

- Outbox backlog growing
- Worker retries exhausted
- replay failures
- queue age exceeds objective
- Memory generation failure rate increasing

---

## Warning Alerts

Examples:

- increased latency
- retry growth
- slow queries
- projection lag
- backup overdue

---

## Alert Routing

Alert routing should distinguish:

- infrastructure
- application
- security
- business workflow
- deployment

Different teams may own different categories.

---

## Worker Monitoring

Operators should observe:

- active Workers
- idle Workers
- claim success
- retry rates
- failure rates
- lease expiry
- processing latency

---

## Outbox Monitoring

Recommended dashboards:

```text
Pending Messages

Publication Rate

Retry Rate

Oldest Pending Age

Publication Failures
```

---

## Consumer Monitoring

Recommended dashboards:

```text
Messages Processed

Duplicate Events

Retry Pending

Dead Letters

Average Processing Time
```

---

## Database Monitoring

Monitor:

- CPU
- memory
- active connections
- lock waits
- deadlocks
- autovacuum
- replication status if applicable
- storage growth

---

## Capacity Indicators

Monitor growth of:

- Organizations
- Memberships
- Works
- Decisions
- Memories
- Outbox
- Audit Records
- Event History

Growth trends support future capacity planning.

---

## Part 2 Invariants

The operational metrics architecture must preserve:

1. Metrics remain low-cardinality.
2. Business workflow progression is measurable.
3. Availability and latency are measured independently.
4. Queue age is observable.
5. Worker retries are visible.
6. Human-authority violations are measurable.
7. Organization isolation violations are measurable.
8. HTTP and Worker health distinguish liveness from readiness, and asynchronous workflow health remains separate from traffic routing.
9. Dashboards are audience-specific.
10. Alerts remain actionable and low-noise.
11. Workflow latency is measured end-to-end.
12. Metrics never become authoritative business state.
13. HTTP metric labels use only registered route templates and operations; raw paths and caller-supplied dimensions never create time series.

---

## Part 2 Design Summary

The AIOS metrics architecture combines:

```text
RED Metrics

USE Metrics

Workflow Metrics

Service Level Indicators

Health Checks

Audience-Specific Dashboards

Actionable Alerting
```

Infrastructure health and business workflow health are treated as complementary concerns.

Operational success is measured not only by request availability, but by the successful progression of Human-authoritative workflows across synchronous and asynchronous boundaries.

## Incident Response

Incident response defines how AIOS detects, contains, investigates, resolves, and learns from production failures.

The incident process must prioritize:

- Human safety
- Organization isolation
- authoritative data integrity
- Human authority
- recoverability
- clear communication
- evidence preservation
- bounded operational action

---

## Incident Definition

An incident is an unplanned event that materially affects:

- service availability
- data integrity
- Organization isolation
- Human authority
- workflow progression
- security
- recovery capability
- operational objectives

Not every error is an incident.

A single retried Worker failure may remain a normal operational event.

A growing queue that prevents Memory generation may become an incident.

---

## Incident Categories

Recommended categories:

```text
Availability

Performance

DataIntegrity

Security

OrganizationIsolation

HumanAuthority

AsynchronousProcessing

Database

Deployment

Configuration

ExternalDependency

BackupAndRecovery
```

---

## Incident Severity

Recommended severity levels:

```text
SEV-1

SEV-2

SEV-3

SEV-4
```

---

## SEV-1

A SEV-1 incident creates immediate critical risk.

Examples:

- confirmed cross-Organization data exposure
- unauthorized Decision approval
- unauthorized Work completion
- unauthorized Memory approval
- authoritative data corruption affecting multiple Organizations
- complete production unavailability
- unrecoverable database write failure
- audit persistence failure blocking all authoritative actions
- backup and WAL continuity lost beyond approved Recovery Point Objective
- active Organization Owner invariant violated broadly

Expected response:

```text
Immediate paging

Incident coordination responsibility assigned to a named Human

Affected mutation paths contained

Executive and security communication initiated

Continuous response until controlled
```

---

## SEV-2

A SEV-2 incident causes major degradation without confirmed broad critical compromise.

Examples:

- Outbox publication stalled
- Memory generation unavailable
- large Worker backlog
- database latency causing widespread failures
- failed deployment requiring rollback
- significant portion of users unable to complete commands
- reconciliation finds a high-impact invariant violation
- backup failure approaching Recovery Point Objective

Expected response:

```text
Urgent response

Clear ownership

Frequent status updates

Recovery during active response window
```

---

## SEV-3

A SEV-3 incident causes limited degradation.

Examples:

- one Worker repeatedly failing
- one projection delayed
- one Organization-specific workflow blocked
- elevated retries without user-wide impact
- non-critical external dependency degradation
- limited operational tooling failure

Expected response:

```text
Assigned investigation

Bounded mitigation

Resolution within normal operational process
```

---

## SEV-4

A SEV-4 issue has low immediate impact.

Examples:

- minor dashboard defect
- non-actionable log noise
- low-priority configuration drift
- isolated slow query below alert threshold
- cosmetic operational issue

Expected response:

```text
Tracked through normal engineering backlog
```

---

## Incident Lifecycle

Recommended lifecycle:

```text
Detected

Acknowledged

Investigating

Contained

Mitigating

Monitoring

Resolved

Reviewed
```

---

## Detection

Incidents may be detected through:

- alerts
- dashboards
- reconciliation
- security telemetry
- customer reports
- operator observation
- deployment monitoring
- backup verification
- database monitoring

Detection time should be recorded.

---

## Acknowledgement

Acknowledgement confirms that a Human operator has accepted responsibility for the incident.

The acknowledgement record should include:

```text
incidentId

severity

acknowledgedBy

acknowledgedAt

initialOwner
```

---

## Incident Responsibility Model

Incident roles in this document are responsibilities, not assumptions about separate full-time staff positions.

One authorized Human MAY hold more than one responsibility when team size or incident conditions require it. Role combination MUST remain explicit in the incident record; absence of separate staff does not leave a responsibility unassigned.

Every SEV-1 and SEV-2 incident MUST name Human owners for:

- incident coordination and technical response
- business and stakeholder communication
- timeline and evidence capture
- post-incident review

The assignment record MUST include the Human principal, responsibility names, assumption time, and handoff or release time. Automation and the Secretary MAY prepare status summaries, correlate evidence, and suggest next actions, but they cannot own an incident, approve a risky operation, declare authoritative recovery, or perform the post-incident review.

---

## Small-Team Operating Mode

The production MVP is expected to be operated by one to three people. Its minimum accountability model is:

- Responder / Incident Commander
- Business Communicator
- Post-Incident Reviewer

Technical Lead and Scribe responsibilities are folded into these assignments unless separately assigned.

| Available Humans | Active-response assignment | Review assignment |
|---|---|---|
| One | The Primary Responder acts as Incident Commander, Technical Lead, Scribe, and Business Communicator. A designated external business contact receives concise status when reachable. | The same Human performs a time-separated structured self-review. A SEV-1 Security, OrganizationIsolation, HumanAuthority, or DataIntegrity incident receives an independent second review as soon as another qualified reviewer is available and before related corrective actions are closed. |
| Two | One Human is Responder / Incident Commander and Technical Lead. The second is Business Communicator and Scribe, and may take over response duties through an explicit handoff. | Prefer the Human who was not the primary technical responder; record any conflict and obtain an additional reviewer for high-risk findings when practical. |
| Three | Assign Responder / Incident Commander, Technical Responder, and Business Communicator / Scribe separately. | Select a Post-Incident Reviewer who was not the primary technical responder. |

During initial containment, a sole responder MAY defer narrative detail, but MUST record at minimum:

- incident identifier and severity
- acknowledgement and current Human owner
- containment, repair, replay, deployment, or configuration action
- actor and UTC timestamp
- approval or break-glass reference when required
- observed result and recovery-validation evidence

The fuller timeline and hypotheses are completed after immediate risk is controlled. Lack of staff MUST NOT waive Organization isolation, Human-only authority, authorization policy, durable audit, repair preconditions, or the break-glass controls defined later in this document.

When two authorized Humans are available, dangerous repair, replay, or emergency-change approval SHOULD be separated from execution. When only one is available, the existing one-to-three-person break-glass contract applies; role combination itself never grants additional permission.

---

## Incident Commander

The Incident Commander is the incident-coordination responsibility. SEV-1 and SEV-2 incidents MUST assign it to a Human; in small-team mode this is normally the Primary Responder.

The Incident Commander coordinates:

- severity
- priorities
- responder responsibilities
- communication
- mitigation decisions
- escalation
- resolution criteria

The Incident Commander may also perform technical remediation when staffing requires it, but the combined assignment and any resulting approval conflict MUST be recorded.

---

## Technical Lead

The Technical Lead responsibility owns:

- diagnosis
- containment proposal
- mitigation execution
- recovery validation
- technical risk assessment

It MAY be combined with the Incident Commander responsibility in small-team mode.

---

## Communications Lead

For significant incidents, the Communications Lead responsibility owns:

- internal status updates
- stakeholder notifications
- customer-facing communication
- timeline accuracy
- resolution notice

In small-team mode this responsibility is named Business Communicator and MAY be combined with Scribe or secondary-responder duties.

---

## Scribe

The Scribe responsibility records:

- timeline
- decisions
- hypotheses
- commands executed
- configuration changes
- observed results
- unresolved questions

It MAY be combined with another response responsibility. Even when no dedicated Scribe exists, the minimum incident record remains mandatory and MUST NOT depend on memory after the event.


---

## Incident Timeline

Every material incident should maintain a UTC timeline.

Example:

```text
12:01 Alert fired

12:04 Incident acknowledged

12:08 Outbox publisher identified as stalled

12:12 Publisher paused

12:18 Expired claims recovered

12:24 Publication resumed

12:31 Queue age returned below objective
```

---

## Containment

Containment limits further damage.

Possible containment actions:

- pause one Worker
- disable one feature
- block one command type
- isolate one Organization
- stop a deployment
- switch an external dependency
- enter read-only mode
- revoke a compromised credential
- disable replay
- suspend a projection rebuild

Containment must be reversible where practical.

---

## Safe Containment Priority

Recommended priority:

```text
Protect Organization Isolation

Protect Human Authority

Protect Authoritative Data

Stop Duplicate Business Effects

Preserve Evidence

Restore Availability
```

Availability must not be restored by weakening authority or isolation guarantees.

---

## Read-Only Containment

Read-only mode may be used when authoritative writes are unsafe.

In read-only mode:

- reads may continue where safe
- authoritative commands are rejected
- Workers that mutate Aggregate state are paused
- Outbox publication policy is explicitly decided
- audit and operational access remain available
- maintenance messaging is shown

---

## Organization-Specific Containment

Where possible, isolate only the affected Organization.

Possible actions:

- block Organization mutations
- pause Organization-scoped Worker processing
- disable Organization invitations
- prevent replay for the Organization
- preserve read-only access

Organization-specific containment must not expose the Organization to other tenants.

---

## Worker Containment

A Worker may be paused when:

- it produces repeated invalid effects
- event contract interpretation is defective
- an external dependency is unsafe
- duplicate processing risk is high
- queue growth is preferable to corrupted state

Pausing must emit an operational audit event.

---

## Incident Evidence

Preserve:

- relevant logs
- traces
- metrics
- database state
- Outbox rows
- processed-event rows
- deployment identifiers
- migration identifiers
- configuration versions
- feature-flag state
- operator actions
- external dependency responses where permitted

Do not alter evidence unnecessarily during investigation.

---

## Database Investigation Safety

Production investigation queries should:

- be read-only
- use bounded time ranges
- include Organization scope where applicable
- avoid full-table scans during load
- avoid unbounded payload export
- use approved operational roles
- be recorded for significant incidents

---

## Exceptional Manual Database Repair During Incident

Direct database modification is not a normal operational interface. Replay, Worker control, dead-letter actions, containment, and supported repairs MUST use the Operations Application Service.

Break-glass database repair is allowed only when:

- supported typed recovery paths are unavailable or demonstrably insufficient
- continued impact justifies direct intervention
- a Human Operator with the break-glass permission is authenticated
- affected Organization and resource scope are explicit
- a reviewed, version-controlled repair artifact is used; ad hoc console editing is prohibited
- before-state evidence and transaction boundaries are defined
- expected row count, preconditions, postconditions, and rollback or forward-fix plan are documented
- approval follows the operational risk policy
- the database role is time-limited and least-privileged
- dry-run or read-only validation is performed where feasible
- operator identity, tool version, statements hash, and result are durably audited
- follow-up reconciliation and invariant validation are executed

The repair MUST run in a bounded transaction, fail closed on unexpected row count or precondition mismatch, and avoid cross-Organization mutation. A successful SQL commit is not sufficient validation; the owning module's invariants and affected event or projection state must be checked before incident resolution.

---

## Resolution Criteria

An incident is resolved only when:

- immediate impact has stopped
- authoritative state is safe
- queues are progressing
- alerts have cleared or are understood
- recovery is validated
- temporary containment is documented
- residual risk is accepted
- follow-up work is recorded

---

## Monitoring Phase

Before resolution, the system should remain in monitoring long enough to verify:

- no recurrence
- queue age decreases
- error rate normalizes
- database health stabilizes
- Worker claims remain valid
- no new reconciliation findings appear

---

## Incident Review

SEV-1 and SEV-2 incidents require a post-incident review and a named Post-Incident Reviewer.

A SEV-3 incident may also require review when it exposes systemic weakness.

The reviewer SHOULD differ from the primary technical responder whenever another qualified Human is available. A one-person structured self-review is acceptable under the Small-Team Operating Mode, subject to its independent-review requirement for high-risk SEV-1 incidents. Review assignment is separate from incident resolution and MUST NOT delay containment or safe service recovery.

---

## Blameless Review

The review should focus on:

- system conditions
- design gaps
- missing safeguards
- unclear ownership
- operational friction
- detection quality
- recovery quality

It should not focus on individual blame.

---

## Post-Incident Review Contents

Recommended structure:

```text
Summary

Impact

Timeline

Detection

Root Causes

Contributing Factors

What Worked

What Failed

Recovery Actions

Corrective Actions

Owners

Due Dates
```

---

## Root Cause

Root cause analysis should distinguish:

```text
Trigger

Direct Cause

Contributing Conditions

Systemic Cause
```

Example:

```text
Trigger:
    malformed event received

Direct Cause:
    consumer crashed on unsupported field

Contributing Condition:
    no event contract quarantine

Systemic Cause:
    incomplete compatibility testing
```

---

## Corrective Actions

Corrective actions should prioritize:

1. prevention
2. earlier detection
3. safer containment
4. faster recovery
5. clearer ownership

Actions must have Human owners and due dates.

---

## Incident Metrics

Recommended incident metrics:

```text
incident_total

incident_by_severity_total

mean_time_to_detect_seconds

mean_time_to_acknowledge_seconds

mean_time_to_contain_seconds

mean_time_to_recover_seconds

incident_recurrence_total
```

---

## Operational Runbooks

Runbooks define repeatable response procedures.

A runbook should contain:

```text
Purpose

Symptoms

Likely Causes

Safety Constraints

Required Access

Diagnosis Steps

Containment Steps

Recovery Steps

Validation

Escalation

Audit Requirements
```

---

## Runbook Principles

Runbooks must:

- use explicit commands
- define stopping conditions
- preserve Organization scope
- identify destructive steps
- distinguish observation from mutation
- specify required approvals
- avoid hidden assumptions
- remain version-controlled
- be tested periodically

---

## Runbook Ownership

Every runbook should have:

```text
owner

reviewDate

lastTestedAt

applicableVersion

severity
```

---

## Required MVP Runbooks

The MVP MUST include six executable runbooks:

```text
Application or database unavailable

Outbox or Worker processing stalled

Memory generation failure or retry exhaustion

Organization isolation or Human authority violation

Deployment rollback

PostgreSQL backup or WAL failure and point-in-time recovery
```

Each MVP runbook MUST identify detection signals, safe containment, prohibited actions, recovery steps, validation, required authorization, and audit evidence.

The following runbooks SHOULD be added during production hardening:

```text
Database connection pool exhaustion

Dead-letter event replay

Projection lag and rebuild

Last Owner invariant finding

Migration failure


Secret rotation

Configuration rollback

Feature-flag emergency disable
```

The detailed runbook sections below are retained as target guidance. Their presence in this architecture document does not make every production-hardening runbook an MVP release condition.

---

## Runbook: Application Unavailable

Diagnosis:

1. verify load balancer or ingress status
2. inspect readiness failures
3. inspect recent deployment
4. inspect database connectivity
5. inspect configuration and secret loading
6. inspect process crash loop
7. inspect resource saturation

Containment:

```text
Stop faulty rollout

Route to healthy instances

Enable maintenance mode if required
```

Validation:

```text
Readiness healthy

Error rate normal

Authoritative command test succeeds
```

---

## Runbook: Database Unavailable

Safety constraints:

- do not accept authoritative writes
- do not bypass durable audit
- do not use local in-memory fallback as authority
- do not continue state-changing Workers

Actions:

1. confirm network and database status
2. inspect failover status
3. pause mutation Workers
4. reject authoritative commands safely
5. preserve read-only access only if consistency is acceptable
6. initiate managed recovery or database failover
7. validate migrations and authoritative state
8. resume Workers in controlled order

---

## Runbook: Connection Pool Exhaustion

Diagnosis:

- active connection count
- waiting requests
- long transactions
- abandoned transactions
- recent traffic increase
- Worker concurrency
- connection leak indicators

Containment:

- reduce Worker concurrency
- terminate confirmed abandoned transactions
- reject excess requests
- temporarily reduce non-essential workloads

Permanent remediation may include:

- fixing leaks
- shortening transactions
- tuning pool size
- separating Worker pools
- improving backpressure

---

## Runbook: Outbox Backlog

Diagnosis:

- pending count
- oldest pending age
- publication rate
- retry reasons
- blocked stream
- publisher readiness
- external broker availability

Containment:

- pause downstream non-essential producers if necessary
- increase publisher capacity within safe limits
- isolate poison events
- recover expired claims

Validation:

- oldest age decreases
- publication rate exceeds creation rate
- no stream remains blocked
- duplicate delivery remains idempotent

---

## Runbook: External Effect Outcome Unknown

This runbook applies only to a registered `ExternalBusinessEffect`.

1. pause automatic resend for the logical effect and keep its ordering key blocked;
2. verify Organization, consumer, event, effect type, effect key, request fingerprint, provider, and ledger claim history;
3. determine whether the provider enforces the stored idempotency key and whether its retention window is still valid;
4. query the provider using the stored provider operation reference when authoritative status lookup is supported;
5. record exactly one typed outcome: provider-confirmed success, provider-confirmed absence, still unknown, or compensation required;
6. on confirmed success, finalize local processed-event, dead-letter, ordering, Outbox, audit, replay, and ledger evidence through the fenced recovery transaction;
7. on confirmed absence, retain the same logical effect identity and key before any safe retry;
8. when compensation is approved, create a separate linked compensation operation and preserve the original effect history;
9. reconcile successors and external state before unblocking;
10. close only when the durable ledger and downstream state agree.

Prohibited actions include changing the request fingerprint, generating a new effect key to bypass deduplication, treating timeout as absence, deleting the ledger row, manually marking the processed event successful, or resending a non-idempotent unqueryable effect.

If neither provider idempotency nor authoritative outcome query exists, automatic execution of that consumer is an unsupported configuration and remains disabled.

---

## Runbook: Dead-Letter Event

Steps:

1. inspect only authorized, redacted event metadata and consumer failure evidence;
2. confirm the source Organization, ConsumerRegistration, side-effect class, ordering policy, and affected ordering key;
3. determine whether the processed event is `Failed`, whether later deliveries are blocked, and whether any external effect outcome is unknown;
4. for `ExternalBusinessEffect` with unknown outcome, follow the External Effect Outcome Unknown runbook before considering replay;
5. fix the handler, configuration, association, projection, or external dependency without editing the immutable source event;
6. select one canonical recovery mode: `RetryOriginal`, `ReprocessWithCurrentHandler`, `RebuildProjection`, or `ValidateOnly`;
7. use `ValidateOnly` first when handler compatibility, current authorization, idempotency, or ordering impact is uncertain;
8. have an active OrganizationOwner or OrganizationAdmin issue the typed Organization-scoped replay command under the authorization matrix;
9. monitor replay, processed-event, dead-letter, ordering-state, generation-operation or effect-ledger outcomes together;
10. close only when the typed recovery transaction records `Resolved`, or when an authorized validated skip records `Skipped`;
11. verify blocked successors resume and reconciliation reports no remaining gap.

Memory generation is `ExternalComputation`. A provider timeout with no usable candidate follows its generation-operation retry policy; it does not use the external-business-effect outcome runbook.

Do not use a database update, process restart, lease expiry, feature flag, or successful `ValidateOnly` to mark a dead letter resolved or unblock ordering.

---

## Runbook: Memory Generation Failure

Diagnosis:

- source Work status
- WorkCompleted event state
- generation attempt count
- AI provider status
- output validation errors
- active Memory uniqueness
- current Work version
- policy and prompt-template version

Recovery:

- fix provider or validation issue
- retry using the same generation identity where applicable
- recheck no active Memory exists
- create Generated Memory only after validation
- record the attempt outcome

The Secretary may generate a draft.

The Secretary must not approve the Memory.

---

## Runbook: Organization Isolation Alert

Immediate actions:

1. classify as potential SEV-1
2. stop the affected mutation path
3. preserve evidence
4. identify affected Organizations
5. verify whether exposure or only rejected attempt occurred
6. inspect repository and authorization scope
7. assess notification obligations
8. repair through controlled workflow
9. add regression tests

Do not disclose one Organization’s identifiers to another Organization.

---

## Runbook: Human Authority Violation

Immediate actions:

1. verify whether the attempt was denied
2. identify principal type
3. inspect authorization policy version
4. inspect command path
5. verify no authoritative transition committed
6. pause defective Worker or feature if required
7. correct policy or implementation
8. reconcile affected Aggregates
9. record security review

---

## Runbook: Last Owner Finding

Immediate actions:

1. restrict Organization administrative mutations
2. verify active Human Identities
3. verify Membership status
4. verify active Owner assignments
5. identify the operation that caused the state
6. restore ownership only through approved administrative workflow
7. record operator, reason, and evidence
8. run Organization integrity checks

A Secretary or System principal must not be assigned as Human Owner.

---

## Runbook: Migration Failure

Steps:

1. stop deployment progression
2. identify migration identifier
3. inspect transaction status
4. determine whether schema is backward-compatible
5. decide rollback or forward fix
6. prevent mixed incompatible application versions
7. validate schema and data
8. resume deployment only after approval

---

## Runbook: Backup or WAL Archive Failure

1. Confirm the latest independently verified restorable UTC point.
2. Calculate `now - latest_restorable_point` and compare it with the 15-minute RPO.
3. Determine whether the failure affects WAL archiving, the base-backup chain, integrity verification, encryption, retention, credentials, or provider access.
4. Open a High-severity incident before the RPO is exhausted; raise Critical when no point within the 15-minute RPO is confirmed.
5. Preserve provider and database evidence in the restricted operational audit record.
6. Restore WAL continuity or the backup chain without deleting the last known-good recovery artifacts.
7. Verify the new recovery point and run backup-integrity checks.
8. Perform an isolated restore when recoverability is uncertain or the chain changed materially.
9. Record achieved recovery-point age, owner, corrective action, and whether the monthly or quarterly exercise must be repeated.
10. Close only after independent recovery-point and integrity signals are healthy.

---

## Runbook: Production PostgreSQL Restore

1. The Incident Commander declares restoration and records the approved target time and reason.
2. Enter maintenance mode; stop mutation traffic, Outbox publication, consumers, schedulers, and background workers.
3. Preserve the failed environment and all recovery evidence when doing so does not increase customer harm.
4. Restore the complete PostgreSQL consistency boundary to the approved point in an isolated environment.
5. Execute schema, migration, Aggregate, authorization, audit, Organization-isolation, Outbox, idempotency, ordering, and invariant validation from the persistence recovery contract.
6. Measure the achieved RPO before cutover. Do not cut over when the selected point violates the approved objective without explicit incident authority.
7. Cut over application connectivity while workers and publishers remain paused.
8. Execute controlled read and write smoke tests, including mandatory audit persistence.
9. Release only expired claims; preserve valid leases and retry history.
10. Reconcile external-effect ledger entries and provider outcomes. Block any ordering key with an unknown non-idempotent effect.
11. Resume the Outbox publisher and consumers in dependency order, initially with bounded concurrency.
12. Confirm that authoritative service is safe within four hours and asynchronous workflows are progressing within eight hours.
13. Record the achieved RPO/RTO, validation evidence, external-effect decisions, backlog state, and approver in the incident record.

---

## Feature Flags

Feature flags allow controlled activation of behavior without immediate redeployment.

They are operational controls, not replacements for Domain rules.

---

## Feature Flag Principles

Feature flags must:

- have clear ownership
- have a defined default
- have an expiry or review date
- be auditable
- fail safely
- avoid bypassing Human authority
- avoid weakening Organization isolation
- be testable in both states

---

## Feature Flag Categories

Recommended categories:

```text
Release

Operational

Experiment

PermissionedPreview

EmergencyKillSwitch
```

---

## Release Flags

Release flags support gradual rollout of new code paths.

Example:

```text
new-memory-generation-validator
```

They should be temporary.

---

## Operational Flags

Operational flags control runtime behavior.

Examples:

```text
pause-memory-generation

reduce-outbox-batch-size

disable-projection-rebuild
```

---

## Experiment Flags

Experiment flags support user-experience testing.

They must not alter:

- authorization
- Human authority
- Organization isolation
- immutable revision rules
- audit requirements

---

## Permissioned Preview Flags

Permissioned Preview flags may enable a feature for selected Organizations.

Selection must use approved Organization identifiers and remain auditable.

---

## Emergency Kill Switches

Kill switches disable unsafe behavior rapidly.

Recommended kill switches:

```text
disable-authoritative-commands

disable-decision-submission

disable-memory-generation

disable-event-replay

disable-external-ai-provider

pause-all-domain-workers
```

---

## Prohibited Flag Behavior

Feature flags must never allow:

- Secretary approval
- Secretary rejection
- Secretary Work completion
- automatic Work completion after Decision approval
- automatic Memory approval
- cross-Organization access
- bypass of required authorization audit
- mutation of immutable revisions
- duplicate active Memory creation

---

## Flag Evaluation

Flag evaluation should be:

- deterministic
- low-latency
- bounded
- observable
- Organization-aware where applicable
- independent from sensitive payload content

---

## Flag Failure Mode

Every flag must define behavior when the flag service is unavailable.

Recommended defaults:

```text
Authority-sensitive feature:
    fail closed
```

```text
Non-critical user-interface enhancement:
    use last known or default value
```

---

## Flag Caching

Flag values may be cached.

The cache policy should define:

- refresh interval
- maximum staleness
- emergency invalidation
- startup behavior
- fallback value

---

## Flag Audit

Changes to sensitive flags should record:

```text
flagName

oldValue

newValue

scope

changedBy

reason

changedAt

changeRequest
```

---

## Flag Lifecycle

Recommended lifecycle:

```text
Proposed

Implemented

Disabled

EnabledForTest

GradualRollout

FullyEnabled

Retired
```

Retired flags must be removed from code.

---

## Flag Debt

Long-lived release flags create complexity.

Every temporary flag should have:

- owner
- removal criteria
- removal date
- linked implementation task

---

## Configuration Management

Configuration controls runtime behavior that is not ordinary business state.

Examples:

- database connection settings
- Worker concurrency
- retry limits
- timeouts
- feature-flag provider
- telemetry exporter
- AI provider endpoint
- batch sizes
- SLO thresholds

---

## Configuration Principles

Configuration must be:

- environment-specific
- versioned where practical
- validated at startup
- secret-free unless using secret references
- observable
- auditable for sensitive changes
- safely reloadable only where defined

---

## Configuration Hierarchy

Recommended precedence:

```text
Code Defaults

Environment Configuration

Deployment Configuration

Runtime Operational Override
```

Runtime overrides should be limited and auditable.

---

## Typed Configuration

Configuration should use typed structures.

Example:

```text
OutboxPublisherOptions
- BatchSize
- ClaimLease
- PollInterval
- MaximumAttempts
- BaseRetryDelay
```

Avoid unstructured string-based lookup throughout the codebase.

---

## Startup Validation

The process should fail startup when required configuration is:

- missing
- malformed
- outside safe range
- inconsistent
- incompatible with deployed schema
- incompatible with another required setting

---

## Configuration Bounds

Examples of bounded configuration:

```text
Worker concurrency > 0

Batch size within safe maximum

Retry attempts within approved range

Timeout greater than zero

Lease duration greater than expected processing transaction

SLO threshold within valid range
```

---

## Dynamic Configuration

Only selected settings should support runtime reload.

Possible dynamically reloadable settings:

- Worker concurrency
- batch size
- polling interval
- non-security alert thresholds
- sampling rate

Avoid dynamic reload for:

- database identity
- encryption keys without rotation workflow
- authorization policy structure
- schema compatibility
- Human authority rules

---

## Configuration Version

Processes should expose:

```text
configurationVersion
```

Operational events should record the active version.

---

## Configuration Drift

Drift detection should identify differences between:

- declared configuration
- deployed configuration
- runtime configuration
- expected secret references
- feature-flag state

Unexpected drift should create an alert or finding.

---

## Configuration Rollback

Every sensitive configuration change should have:

- previous value
- rollback procedure
- validation criteria
- operator
- reason
- timestamp

---

## Secrets Management

Secrets must be stored outside source control and ordinary configuration files.

Examples:

- database credentials
- AI provider API keys
- telemetry exporter credentials
- encryption keys
- broker credentials
- backup credentials

---

## Secret Management Principles

Secrets must be:

- centrally managed
- encrypted at rest
- encrypted in transit
- access-controlled
- rotatable
- auditable
- environment-separated
- excluded from telemetry

---

## Secret References

Configuration should contain secret references rather than raw secret values.

Example:

```text
AI_PROVIDER_API_KEY_REF
```

rather than:

```text
AI_PROVIDER_API_KEY
```

inside committed configuration.

---

## Secret Access

Runtime processes should access only required secrets.

Examples:

```text
HTTP application:
    database application credential
```

```text
Outbox publisher:
    publisher database credential
    broker credential
```

```text
Memory Worker:
    Worker database credential
    AI provider credential
```

---

## Secret Rotation

Rotation should support:

```text
Create new secret

Deploy overlapping access

Reload or restart processes

Verify use of new secret

Revoke old secret

Audit completion
```

---

## Emergency Rotation

Emergency rotation may be required after:

- suspected credential exposure
- unauthorized access
- employee departure
- provider incident
- logging defect
- backup access concern

Emergency rotation should have a tested runbook.

---

## Secret Expiry

Where supported, secrets should have bounded validity.

Expiring secrets require alerts before expiration.

---

## Secret Logging Prohibition

Secrets must never appear in:

- structured logs
- traces
- metrics
- exception messages
- deployment output
- audit payloads
- support tickets
- screenshots
- test snapshots

---

## Local Development Secrets

Local development should use:

- local secret store
- environment injection
- development-only managed secrets

Shared plaintext secret files are prohibited.

---

## Deployment Strategy

The deployment architecture must preserve availability, compatibility, and authoritative data safety.

Recommended MVP strategy:

```text
Rolling Deployment

with Expand-and-Contract Database Migrations
```

Blue-Green deployment may be used where infrastructure supports it.

---

## Deployment Principles

Deployments must be:

- automated
- repeatable
- observable
- versioned
- reversible or forward-fixable
- compatible with current database schema
- safe for mixed application versions
- validated before full traffic

---

## Deployment Artifact

Each deployable artifact should be immutable and identified by:

```text
applicationVersion

sourceRevision

buildId

dependency lock state

configuration schema version
```

---

## Pre-Deployment Checks

Before deployment:

1. validate automated tests
2. validate migration plan
3. validate adjacent-version compatibility
4. validate configuration
5. validate secret references
6. validate feature-flag defaults
7. confirm backup health
8. confirm rollback or forward-fix plan
9. review capacity
10. review current incidents

---

## Deployment Order

Recommended order:

```text
1. Expand database schema

2. Deploy compatible consumers

3. Deploy compatible producers

4. Run backfill if required

5. Validate new behavior

6. Enable feature gradually

7. Contract obsolete schema later
```

---

## Rolling Deployment

Rolling deployment replaces instances gradually.

During the rollout:

- old and new versions may run concurrently
- both versions must understand the active schema
- event consumers must support relevant event versions
- feature flags should prevent premature activation
- readiness gates control traffic

---

## Rolling Deployment Readiness

A new instance becomes ready only after:

- startup validation succeeds
- database connectivity succeeds
- schema compatibility succeeds
- required secrets load
- telemetry initializes
- critical dependencies are usable
- process-specific readiness passes

---

## Rolling Worker Deployment

Workers require additional care.

Recommended sequence:

1. deploy new consumer code disabled or idle
2. verify startup and contract compatibility
3. reduce or pause old Worker claims if required
4. enable new Workers gradually
5. verify claim ownership and processing
6. retire old Workers

---

## Consumer Compatibility

Consumers should be deployed before producers of a new event schema.

During mixed deployment, consumers must tolerate:

- current event version
- previous supported event versions
- duplicate delivery
- replay
- delayed delivery

---

## Blue-Green Deployment

Blue-Green deployment maintains two complete application environments:

```text
Blue

Green
```

Traffic switches after validation.

---

## Blue-Green Advantages

- rapid rollback
- isolated pre-traffic validation
- reduced mixed-instance duration
- easier smoke testing

---

## Blue-Green Limitations

- shared database compatibility still required
- Workers may process twice if both environments are active
- external callbacks may target both environments
- infrastructure cost increases
- schema contraction remains separate

---

## Blue-Green Worker Rule

Only one environment should actively claim the same Worker queue unless claim safety and idempotency explicitly support both.

Activation must be controlled.

---

## Canary Deployment

Canary deployment may send limited traffic to the new version.

Canary selection may use:

- small request percentage
- internal users
- selected Organizations
- non-authoritative read paths

Authority-sensitive commands require careful validation before canary exposure.

---

## Deployment Smoke Tests

Smoke tests should verify:

- health endpoints
- authentication
- Organization resolution
- authorized Work read
- bounded authoritative command in test Organization
- Outbox insertion
- Worker claim
- event processing
- audit persistence
- no cross-Organization access

Production smoke tests must use controlled test data.

---

## Deployment Validation

After deployment, verify:

- request error rate
- P95 and P99 latency
- database connection usage
- deadlocks
- Outbox age
- Worker retries
- event contract failures
- authorization denials
- Organization isolation alerts
- workflow latency

---

## Automatic Rollback

Automatic rollback may occur when:

- readiness fails
- crash rate exceeds threshold
- request failure rate sharply increases
- critical smoke test fails
- migration compatibility check fails

Automatic rollback must not occur blindly when the database has undergone an irreversible migration.

---

## Forward Fix

A forward fix is preferred when:

- migration is not safely reversible
- new event schema has already been emitted
- data backfill has changed semantic state
- rollback would create greater inconsistency

The deployment plan must classify this before release.

---

## Deployment Freeze

Deployment may be frozen during:

- unresolved SEV-1 or SEV-2 incidents
- backup uncertainty
- migration instability
- major reconciliation findings
- peak operational periods
- provider instability affecting validation

Emergency security fixes may follow a separate expedited process.

---

## Maintenance Mode

Maintenance mode may restrict user operations during unsafe system conditions.

Recommended modes:

```text
Normal

ReadOnly

RestrictedWrites

FullMaintenance
```

---

## Normal Mode

All authorized operations are available.

---

## Read-Only Mode

Safe reads are available.

State-changing commands are denied with a clear temporary response.

Mutation Workers are paused unless explicitly required for recovery.

---

## Restricted Writes Mode

Only selected safe operations are permitted.

Examples:

- operator recovery
- audit access
- claim recovery
- controlled replay
- configuration rollback

---

## Full Maintenance Mode

User traffic is rejected.

Only approved operational access remains.

---

## Maintenance Mode Authority

Changing maintenance mode requires elevated Human operational authority.

The change must record:

```text
mode

scope

reason

changedBy

changedAt

expectedEndTime
```

---

## Organization-Scoped Maintenance

Maintenance may apply to one Organization.

This is preferable when the issue is tenant-specific.

The scope must be enforced in command authorization and Worker processing.

---

## Maintenance Mode Messaging

Responses should communicate:

- operation unavailable
- temporary nature
- retry guidance
- support reference where applicable

They must not expose internal incident details.

---

## Operational Automation

Operational automation reduces repetitive Human intervention.

Automation must remain bounded and auditable.

---

## Safe Automation Examples

- recover expired Worker claims
- restart unhealthy stateless processes
- scale Workers within configured limits
- rotate logs
- validate backups
- run integrity scans
- pause a Worker after repeated poison failures
- reduce concurrency during database saturation
- open an incident after critical alert conditions

---

## Unsafe Automation Examples

Automation must not independently:

- approve Decisions
- reject Decisions
- complete Work
- approve Memory
- promote Memory to Knowledge
- assign Organization ownership
- repair authoritative business state without approved workflow
- skip dead-letter events silently
- weaken authorization
- disable audit

---

## Auto-Remediation Requirements

Auto-remediation must define:

```text
Trigger

Scope

Maximum Actions

Cooldown

Rollback

Audit

Escalation
```

---

## Circuit Breakers

Circuit breakers may protect external dependencies.

Recommended states:

```text
Closed

Open

HalfOpen
```

Use cases:

- AI provider
- external identity provider
- telemetry exporter
- future notification provider

---

## Circuit Breaker Behavior

When the AI provider circuit is open:

- new generation attempts pause or fail transiently
- authoritative Work state remains unchanged
- WorkCompleted events remain durable
- generation retries are scheduled
- no invalid Memory is created
- operators are alerted when objectives are breached

---

## Rate Limiting

Rate limiting protects:

- public APIs
- invitation workflows
- authentication integration
- replay operations
- export operations
- expensive searches
- AI generation

Rate limits must not be keyed with high-cardinality metric labels.

---

## Backpressure

Workers must reduce intake when downstream systems are saturated.

Backpressure strategies:

- lower batch size
- reduce concurrency
- increase polling delay
- pause new claims
- open circuit breaker
- prioritize older items
- reject non-essential operational work

---

## Bulkhead Isolation

Separate resource pools may isolate:

- HTTP requests
- Outbox publisher
- Memory generation
- projections
- maintenance jobs

One overloaded Worker type should not exhaust all database connections.

---

## Scheduled Operations

Scheduled operations may include:

- reconciliation
- backup verification
- integrity checks
- retention cleanup
- partition maintenance
- secret-expiry checks
- feature-flag review
- capacity reporting

Every run should have a unique jobRunId.

---

## Operational Job Idempotency

Scheduled jobs must be safe to retry.

They should use:

- stable operation identity
- progress checkpoints
- bounded batches
- duplicate protection
- explicit completion state

---

## Operational Approval

High-risk operations require explicit Human approval before execution.

Examples:

- replaying a high-authority event
- skipping a dead letter
- applying data repair
- restoring a database
- changing maintenance or read-only mode globally
- enabling an emergency bypass
- rotating platform-wide encryption keys

Approval is a distinct durable fact containing the approver, operationId, command fingerprint, scope, risk class, reason, and expiry. Approval of one fingerprint MUST NOT authorize a changed target, mode, or scope.

For a one-to-three-person MVP team, requester and approver separation is required when two authorized Humans are available. When staffing makes separation impossible during an active incident, a single Human may use an explicitly authorized break-glass path only when the policy permits it. Break-glass execution requires an incident reference, short expiry, durable justification, heightened alerting, and retrospective review; it does not weaken Organization isolation or Human business authority.

---

## Operations Application Service

AIOS MUST expose privileged state-changing recovery actions through a restricted Operations Application Service inside the Modular Monolith. It is a management-plane Application Service, not a Domain Aggregate and not a public business API.

The service coordinates:

- operator authentication and operational authorization
- explicit Organization or platform scope
- command validation and risk classification
- durable intent audit before execution
- idempotency and concurrency control
- dispatch to the owning module's public Application Port
- asynchronous operation state where execution spans transactions
- result validation and durable result audit

The service MUST NOT reach directly into another module's tables or repositories to bypass its rules. A module may expose a narrow operational port for recovery, but the module remains owner of its state and invariants.

The Secretary and other AI Principals cannot invoke this service. `SystemAutomation` may invoke only explicitly allowlisted low-risk capabilities under bounded policy; it cannot approve its own action or acquire Human business authority.

---

## Management-Plane Boundary

The Operations Application Service is available only through an authenticated management-plane endpoint or approved CLI that calls that endpoint.

Required controls:

- short-lived Human or workload identity; no shared operator password or permanent bearer token
- network restriction appropriate to the deployment
- default-deny operational permissions
- separate permissions for request, approval, execution, and status query where risk requires them
- explicit Organization, Worker type, consumer, projection, or platform scope
- rate limiting and bounded query results
- CSRF protection for browser-based administration
- no raw SQL, shell command, repository object, or arbitrary code in the request contract

The management endpoint may be deployed in the same process for the MVP, but its routes, authorization policy, audit, and resource limits remain distinct from the customer-facing data plane.

---

## Operational Command Envelope

Every state-changing operational request MUST use a typed envelope containing at least:

```text
operationId
commandType
idempotencyKey
requesterPrincipal
scopeType
organizationId nullable
targetType
targetId
expectedVersion nullable
reasonCode
reason
incidentOrChangeReference
requestedAt
expiresAt
dryRun
correlationId
approvalReference nullable
commandSchemaVersion
```

Rules:

- `operationId`, internal `correlationId`, and the authoritative command identity are server-owned
- `organizationId` is mandatory for Organization-scoped operations and is derived or verified against the authenticated operator request
- platform scope must be stated explicitly; an omitted Organization MUST NOT silently mean every Organization
- `reasonCode` is a bounded enum; free-text reason is length-limited and follows the telemetry data policy
- `expiresAt` prevents approval or execution of stale recovery intent
- `dryRun` changes no authoritative or control state other than its own audit and result records
- a dry-run result is advisory and does not reserve the target version for later execution

---

## Operational Operation State

Multi-step operational commands use a durable PostgreSQL operation record.

```text
Requested
AwaitingApproval
Approved
Executing
Succeeded
Failed
Cancelled
Expired
```

Required invariants:

- only the permitted state transitions are accepted
- terminal states are immutable except for append-only review metadata
- execution cannot start before required approval is durable and unexpired
- the approved command fingerprint must equal the executed command fingerprint
- cancellation is allowed only before an irreversible step and does not imply rollback
- a timed-out caller does not cancel an already accepted operation
- `Unknown` is a diagnostic query outcome, not a stored successful state

Short operations MAY update the control state and result atomically in one transaction. Long operations use a Worker, durable progress checkpoints, leases, and a Transactional Outbox result event.

---

## Idempotency and Concurrency

Operational idempotency is mandatory, not best-effort.

The idempotency key is scoped by authenticated operator, command type, target scope, and canonical command fingerprint. Repeating the same request returns the existing operation. Reusing the key with a different fingerprint returns a conflict and MUST NOT execute.

Concurrency rules:

- control records use optimistic version checks or a PostgreSQL row lock within a bounded transaction
- `expectedVersion` is required when stale execution could reverse or overwrite a newer control decision
- only one active operation of an incompatible type may hold the same target lock
- locks and leases are durable, expire safely, and have an observable owner
- no network or provider call occurs while a database lock or transaction is held
- completion records the target version before and after execution

A client retry after timeout queries by `operationId` or idempotency key; it does not create a second action.

---

## Durable Intent and Result Boundary

Privileged operations follow Class B audit durability unless a mutation must be Class A with the owning authoritative state.

Execution sequence:

1. authenticate the operator and authorize the exact command and scope
2. validate schema, target existence, expected version, reason, expiry, and risk class
3. persist the operation and intent audit durably
4. obtain required Human approval and persist it when policy requires approval
5. acquire the bounded target execution lease or lock
6. revalidate authorization, approval, scope, fingerprint, and target version
7. execute through the owning module's operational Application Port
8. persist operation result, validation evidence, and any required Outbox record
9. release the lease and expose the terminal result

If intent audit cannot be persisted, execution MUST NOT start. If execution commits but result publication fails, PostgreSQL operation state remains authoritative and reconciliation republishes the result; the command MUST NOT be executed again merely because a response or notification was lost.

---

## MVP Operational Commands

The production MVP MUST implement and test these typed commands because existing incident and dead-letter runbooks depend on them:

```text
PauseWorker
ResumeWorker
RequestReplay
ApproveReplay
StartReplay
RetryDeadLetter
SkipDeadLetter
GetOperationStatus
```

`PauseWorker` stops new claims for the explicit Worker type and scope. By default it does not terminate in-flight work. The operation records pause mode, effective time, control-record version, and remaining active leases.

`ResumeWorker` requires the expected pause version. It MUST NOT resume a newer or differently scoped pause accidentally.

Replay identifies the immutable source event, target consumer, Organization, replay mode, and original processing status. It uses the replay correlation contract, preserves the original event, and cannot bypass consumer idempotency silently.

`RetryDeadLetter` re-enters the defined consumer recovery path without deleting the dead-letter evidence. `SkipDeadLetter` requires explicit Human approval, reason, ordering-impact classification, and post-skip reconciliation. There is no generic delete-dead-letter command.

---

## Worker Pause Semantics

Worker pause control is durable PostgreSQL state read before new claims.

Supported MVP mode:

```text
StopNewClaims
```

In-flight work finishes or expires under its existing lease policy. Force termination or lease cancellation is not an implicit effect of pause and requires a separate future high-risk command.

Pause scope is explicit:

```text
WorkerType
OrganizationAndWorkerType
PlatformWorkerType
```

An Organization-scoped pause MUST NOT stop another Organization. A platform-wide pause requires platform scope, stronger permission, and an incident or change reference.

---

## Replay and Dead-Letter Safety

The Consumer Ordering and Failure-Continuation Contract in `docs/architecture/events-and-outbox.md` is authoritative for whether a failed delivery may be quarantined while later deliveries continue. The Operations Application Service MUST load the registered `orderingRequirement`, `orderingKeyStrategy`, `failureContinuationPolicy`, `sideEffectClass`, and `skipPolicy`; an operator request cannot override those fields ad hoc.

Before replay, dead-letter retry, or skip, the service MUST evaluate:

- target event and consumer contract version
- source Organization and authorization scope
- current processed-event, dead-letter, and durable ordering-key state
- Aggregate, business-key, partition, or consumer-wide ordering impact
- registered failure-continuation and skip policies
- whether the consumer creates an irreversible or outcome-ambiguous external side effect
- consumer technical and business idempotency capability
- later events already processed or blocked for the same ordering key
- required dry-run, reconciliation, compensation, or Human approval policy

Operational behavior follows the registered policy:

```text
ContinueIndependent
    → quarantine the failed delivery and continue only the explicitly safe independent scope

BlockOrderingKey
    → keep later deliveries for the same consumer and key blocked

BlockConsumer
    → stop the consumer until the contract or configuration failure is resolved

RequireExternalRecovery
    → keep the key blocked until the external outcome is reconciled or compensated
```

The result records whether ordering was preserved, intentionally broken, or not applicable. `SkipDeadLetter` records `orderingBroken = true` when continuity is intentionally broken and cannot unblock the key until required reconciliation, rebuild, or compensation validation succeeds. If ordering would be broken without an approved owning-module recovery policy, execution is rejected.

A blocked key degrades the affected asynchronous workflow and Organization workflow-health record without making unrelated Organizations, consumers, ordering keys, or HTTP readiness unhealthy. Consumer-wide blocks and irreversible-effect uncertainty receive higher operational severity than one rebuildable projection entry.

Replay completion means the requested delivery reached its defined terminal consumer result. It does not imply that a Human business decision was approved or that Work, Decision, or Memory state changed successfully unless the owning domain command independently committed that fact.

---

## Operational Result Contract

Every command returns or makes queryable:

```text
operationId
commandType
status
scope
target
requestedAt
startedAt nullable
completedAt nullable
targetVersionBefore nullable
targetVersionAfter nullable
affectedCount
resultCode
failureCode nullable
validationSummary
intentAuditId
approvalAuditId nullable
resultAuditId nullable
outboxEventId nullable
correlationId
```

Failure codes are stable bounded enums. Raw exception text, SQL, secrets, prompts, provider responses, and cross-Organization identifiers are not returned through the ordinary result contract.

---

## Production-Hardening Operational Commands

After the MVP control surface is proven, AIOS SHOULD add typed commands for:

- Organization containment and release
- enter and exit read-only mode with explicit scope and expiry
- projection rebuild with checkpoint, validation, and atomic cutover
- bounded integrity-repair plans with before and after validation
- feature containment and controlled restoration

Generalized repair tooling is not an MVP requirement. It MUST NOT accept arbitrary SQL or code; each repair type has a versioned schema, explicit preconditions, affected scope, dry-run, approval policy, and validation contract.

---

## Operational Principal Types

Operational commands may be initiated by:

```text
HumanOperator
SystemAutomation
```

`HumanOperator` is an authenticated Human Principal with an explicit operational permission. Operational permission does not confer Organization membership or Human business authority.

`SystemAutomation` is constrained to versioned, allowlisted command types, scopes, thresholds, and rate limits. It cannot approve its own operation, skip a dead letter, apply data repair, weaken Organization isolation, approve a Decision, complete Work, or approve Memory.

---

## Operational Audit

Every privileged operational command records durable append-only evidence for:

- requester and executor Principal
- command type and schema version
- canonical command fingerprint
- scope and target
- reason code and bounded reason
- incident or change reference
- expected and observed versions
- dry-run flag
- approval reference and approver where required
- intent, start, completion, failure, cancellation, or expiry timestamps
- result code and validation outcome
- correlationId and operationId

Reading cross-Organization operation details and invoking break-glass access are themselves audited. Audit content follows the telemetry classification and retention policy.

---

## Change Management

Operational changes should be classified by risk.

Recommended classes:

```text
Standard

Normal

Emergency
```

---

## Standard Change

A repeatable, low-risk, pre-approved change.

Examples:

- routine secret rotation
- approved Worker scaling
- tested patch deployment
- regular backup verification

---

## Normal Change

A reviewed change with planned execution.

Examples:

- schema migration
- configuration change
- new Worker rollout
- SLO threshold adjustment

---

## Emergency Change

A change required to contain or resolve an incident.

It must still record:

- reason
- operator
- scope
- result
- retrospective review

---

## Part 3 Invariants

The operational control architecture must preserve:

1. Incident severity is based on impact and risk.
2. Organization isolation and Human authority take priority over availability restoration.
3. Significant incidents have explicit Human ownership.
4. Incident actions and timelines use UTC.
5. Manual repair is controlled, scoped, validated, and audited.
6. Runbooks distinguish diagnosis, containment, recovery, and validation.
7. Feature flags cannot override Domain invariants.
8. Feature flags cannot grant Secretary or System business authority.
9. Sensitive flag changes are audited.
10. Required configuration is validated before readiness.
11. Secrets remain outside source control and telemetry.
12. Secret rotation is supported without uncontrolled downtime.
13. Deployments remain compatible with adjacent application versions.
14. Event consumers are deployed before incompatible producers.
15. Database contraction is separated from initial rollout.
16. Worker activation prevents unsafe duplicate claims.
17. Maintenance mode is explicit, scoped, and Human-controlled.
18. Automation may recover operations but may not make Human business decisions.
19. High-risk replay and repair operations require explicit approval.
20. Operational commands are typed, durably attributable, idempotent, and concurrency-controlled.
21. External dependency failure cannot fabricate authoritative success.
22. Read-only mode does not use non-authoritative fallback state.
23. Automatic rollback is not used when rollback would corrupt schema or event compatibility.
24. Every temporary release flag has a removal plan.
25. Incident resolution includes recovery validation, not only alert clearance.
26. MVP recovery controls execute through the Operations Application Service, not ad hoc SQL, shell commands, or arbitrary scripts.
27. Backup-job success is not proof of recoverability; the monthly restore test is required.
28. Restored Outbox work and external side effects are reconciled before uncontrolled replay.
29. Incident roles are explicit Human responsibilities that may be combined without weakening authorization, audit, tenant isolation, or review controls.

---

## Part 3 Design Summary

The AIOS operational control model combines:

```text
Severity-Based Incident Response

Version-Controlled Runbooks

Audited Feature Flags

Typed Configuration

Centralized Secret Management

Rolling or Blue-Green Deployment

Explicit Maintenance Modes

Restricted Operations Application Service

Bounded Operational Automation
```

Operational controls may pause, contain, retry, scale, or recover the system.

They cannot approve Decisions, complete Work, approve Memory, assign Human authority, or weaken Organization isolation.

Production changes remain observable, reversible where possible, and forward-fixable where rollback is unsafe.

## Capacity Planning

Capacity planning ensures that AIOS can support expected growth without compromising:

- request availability
- workflow latency
- database integrity
- Worker progress
- Organization isolation
- Human-authoritative operations
- recovery objectives
- operational cost

Capacity planning should use measured production behavior rather than assumptions alone.

---

## Capacity Planning Principles

Capacity planning must:

- measure current utilization
- forecast growth
- define safe operating limits
- identify bottlenecks
- test failure boundaries
- preserve operational headroom
- account for asynchronous backlog
- consider recovery load
- avoid scaling one component at the expense of another
- distinguish temporary spikes from sustained growth

---

## Capacity Dimensions

AIOS capacity should be evaluated across:

```text
HTTP Request Load

Concurrent Human Users

Organizations

Memberships

Work Aggregates

Decision Aggregates

Memory Aggregates

Revision History

Outbox Events

Processed Events

Audit Records

Worker Throughput

Database Connections

Database Storage

External AI Usage

Telemetry Volume

Backup Volume
```

---

## Workload Profiles

Capacity planning should define representative workload profiles.

Recommended profiles:

```text
Normal Day

Peak Business Hour

Bulk Import or Migration

Deployment Window

Worker Recovery

External Provider Recovery

Incident Investigation

Projection Rebuild

Backup and Restore Exercise
```

---

## Normal Day Profile

The Normal Day profile represents typical sustained use.

It should capture:

- request rate
- command-to-read ratio
- average concurrent users
- Work creation rate
- Decision submission rate
- Work completion rate
- Memory generation rate
- audit write rate
- Outbox event rate

---

## Peak Business Hour Profile

The Peak Business Hour profile should capture expected short-term load.

It should include:

- increased Human commands
- Decision review bursts
- concurrent Work edits
- elevated search activity
- higher authorization checks
- increased Outbox creation
- Worker catch-up requirements

---

## Worker Recovery Profile

The Worker Recovery profile models a period after:

- Worker outage
- database outage
- external provider outage
- deployment pause
- queue isolation
- disaster recovery

The system must support backlog recovery without overwhelming PostgreSQL or downstream dependencies.

---

## Recovery Capacity

Recovery capacity should be higher than normal production rate.

Example:

```text
Normal event creation rate:
    100 events per minute

Required recovery rate:
    250 events per minute
```

This allows backlog reduction while new work continues.

---

## Capacity Headroom

Production systems should preserve headroom.

Recommended initial target:

```text
steady-state utilization below 70%
```

for constrained shared resources such as:

- CPU
- memory
- connection pools
- Worker concurrency
- database I/O
- external provider quotas

The exact threshold depends on workload behavior.

---

## Saturation Indicators

Capacity planning should monitor:

- request queueing
- connection wait time
- lock wait time
- Worker claim delay
- oldest pending age
- external provider throttling
- database I/O latency
- memory pressure
- garbage collection pressure
- CPU throttling
- disk growth
- WAL growth

---

## Database Capacity

PostgreSQL is the primary authoritative capacity boundary.

Database capacity planning must account for:

- Aggregate writes
- revision history
- Outbox writes
- processed-event writes
- audit writes
- projection updates
- cleanup
- migration
- backup
- reconciliation

---

## Database Connection Capacity

Connections should be divided by workload.

Example logical allocation:

```text
HTTP Application Pool

Outbox Publisher Pool

Domain Worker Pool

Projection Worker Pool

Operations Pool

Migration Pool
```

One workload must not consume every available connection.

---

## Connection Budget

A connection budget should define:

```text
Maximum Database Connections

Reserved Administrative Connections

Application Pool Limit

Worker Pool Limits

Migration Allowance

Operational Emergency Allowance
```

---

## Connection Pool Sizing

Pool size should be based on measured database throughput.

More connections do not automatically increase performance.

Excessive connections may increase:

- context switching
- memory usage
- lock contention
- transaction overlap
- latency variance

---

## Worker Concurrency Capacity

Worker concurrency should be tuned against:

- database connection limits
- average item duration
- external provider quotas
- lock contention
- CPU
- memory
- backlog recovery objective

---

## Little’s Law Guidance

Approximate concurrency may be estimated from:

```text
Concurrency
    ≈
Throughput × Average Duration
```

This is a planning aid, not a substitute for load testing.

---

## Worker Batch Capacity

Batch size affects:

- claim transaction duration
- lock duration
- memory usage
- fairness
- recovery speed
- retry blast radius

Batches should remain bounded.

---

## Outbox Capacity

Outbox capacity planning should consider:

- event creation rate
- event
