# Observability and Operations Architecture

**Status:** Draft  
**Phase:** MVP  
**Architecture:** Modular Monolith  
**Primary Database:** PostgreSQL  
**Event Delivery:** Transactional Outbox  
**Background Processing:** PostgreSQL-Backed Workers  
**Operational Model:** Observable, Recoverable, Human-Controlled

---

# Purpose

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

# Scope

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

# Non-Goals

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

# Operational Goals

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

# Operational Principles

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

# Principle 1: Observability Is a System Property

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

# Principle 2: Business Workflows Are Observable

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

# Principle 3: Operational Data Is Not Business Authority

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

# Principle 4: Correlation Is Mandatory

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

# Principle 5: Failures Must Be Classified

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

# Principle 6: Retries Are Observable

Every retry must have:

- retry reason
- attempt number
- next retry time
- maximum attempt policy
- original operation identity
- current claim or lease identity

Infinite invisible retries are prohibited.

---

# Principle 7: Recovery Is Explicit

Recovery must occur through:

- supported Application Services
- replay tooling
- reconciliation
- claim recovery
- controlled migration
- audited operational commands

Operators must not silently rewrite authoritative tables as the ordinary response to failure.

---

# Principle 8: Human Authority Is Observable

AIOS must make authority boundaries visible.

Examples of security-relevant events:

```text
Secretary attempted Decision approval

System principal attempted Work completion

Human without Reviewer permission attempted Memory approval

Cross-Organization command attempted

Last Owner removal denied
```

These events require structured audit and security telemetry.

---

# Principle 9: Telemetry Is Privacy-Aware

Logs and traces must avoid unnecessary storage of:

- Work content
- Decision rationale
- Memory content
- email addresses
- authentication subjects
- invitation tokens
- token hashes
- secrets
- full external-provider payloads

Use identifiers, classifications, hashes, and bounded redacted metadata instead.

---

# Principle 10: Observability Must Survive Partial Failure

Telemetry should remain useful when one subsystem is degraded.

Examples:

- application logs remain available during PostgreSQL latency
- database metrics remain available when the application is unhealthy
- deployment events remain visible when Workers fail
- alert delivery uses a path independent from the failing application where practical

---

# Observability Architecture

The observability model includes four telemetry types:

```text
Logs

Metrics

Traces

Audit Records
```

Each has a distinct purpose.

---

# Logs

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

# Metrics

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

# Traces

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

# Audit Records

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

# Telemetry Flow

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

# Recommended MVP Components

The architecture remains vendor-neutral.

A possible implementation may use:

```text
OpenTelemetry

Prometheus-compatible metrics

Grafana-compatible dashboards

Structured JSON logs

Centralized log aggregation

PostgreSQL audit tables
```

Managed equivalents are acceptable.

---

# OpenTelemetry

OpenTelemetry is recommended for:

- trace instrumentation
- metric instrumentation
- context propagation
- standard semantic attributes
- vendor-neutral export

The exact exporter and backend may vary by environment.

---

# Telemetry Failure Behavior

Business operations should not normally fail because optional telemetry export is unavailable.

Examples:

```text
Trace export failure
    must not reject Work completion
```

```text
Metrics export failure
    must not roll back Decision approval
```

Durable authorization audit is different.

If required audit persistence fails inside an authoritative command transaction, the transaction should fail according to audit policy.

---

# Telemetry Priority

Recommended priority order:

```text
1. Authoritative domain persistence

2. Required durable audit

3. Transactional Outbox

4. Operational logs

5. Metrics

6. Traces
```

The first three may participate in the business transaction.

Logs, metrics, and traces should normally be emitted outside the database commit dependency.

---

# Structured Logging

All runtime components must emit structured logs.

Preferred format:

```text
JSON
```

Plain unstructured text should be limited to local development.

---

# Log Event Model

Each log record should contain:

```text
timestamp

severity

eventName

message

serviceName

serviceVersion

environment

requestId

commandId

correlationId

causationId

traceId

spanId

organizationId

principalType

principalId

aggregateType

aggregateId

eventId

consumerName

workerId

attempt

outcome

errorCategory

errorCode

durationMs
```

Only applicable fields should be populated.

---

# Required Log Fields

Every production log should include:

```text
timestamp

severity

eventName

serviceName

serviceVersion

environment
```

Every request or Worker operation should additionally include a correlation identifier.

---

# Log Event Name

`eventName` should be stable and machine-queryable.

Preferred:

```text
WorkCommandCompleted

DecisionApprovalDenied

OutboxMessageClaimed

DomainEventPublished

MemoryGenerationFailed
```

Avoid using the free-text message as the primary event identity.

---

# Log Message

The `message` field is a Human-readable summary.

Example:

```text
"Outbox message publication failed and was scheduled for retry."
```

The message should not contain sensitive domain content.

---

# Severity Levels

Recommended levels:

```text
Debug

Info

Warn

Error

Critical
```

---

# Debug

Use Debug for:

- local diagnostic detail
- development-only branch information
- bounded SQL timing detail
- internal mapping detail

Debug logs should normally be disabled or sampled in production.

---

# Info

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

# Warn

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

# Error

Use Error when an operation fails and requires retry, investigation, or user-visible failure.

Examples:

- command transaction failed
- event handling failed
- Memory generation failed
- migration step failed
- reconciliation found an invariant violation
- replay failed

---

# Critical

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

# Stable Error Categories

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

# Stable Error Codes

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

# Exception Logging

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

# Stack Traces

Stack traces are useful for unexpected failures.

They should:

- appear only for Error or Critical unexpected failures
- be excluded from ordinary validation failures
- be redacted where necessary
- not include secrets or payload content
- remain linked to errorCode and correlationId

---

# SQL Logging

Production SQL logging should not record full parameter values by default.

It may record:

```text
query name

operation type

duration

row count

timeout

database error code
```

Sensitive bind values must be redacted.

---

# Named Database Operations

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

# Slow Query Logging

Queries exceeding a configured duration should emit:

```text
DatabaseQuerySlow
```

Recommended fields:

```text
operationName

durationMs

rowsExamined when available

rowsReturned

organizationScoped

transactionId when available

traceId
```

Do not include unrestricted SQL parameters.

---

# Transaction Logging

Important transaction events may include:

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

# Aggregate Command Logging

An authoritative command should produce one completion log.

Example:

```json
{
  "eventName": "WorkCommandCompleted",
  "commandType": "CompleteWork",
  "organizationId": "org-...",
  "aggregateType": "Work",
  "aggregateId": "work-...",
  "expectedVersion": 8,
  "resultingVersion": 9,
  "principalType": "HumanMember",
  "outcome": "Succeeded",
  "durationMs": 42
}
```

The actual Work content must not be logged.

---

# Authorization Logging

Authorization outcomes should be observable.

Recommended log events:

```text
AuthorizationAllowed

AuthorizationDenied
```

High-volume successful Allow logs may be sampled in operational logs because durable audit exists.

Denied authoritative actions should not be silently sampled away.

---

# Authorization Denial Fields

Recommended fields:

```text
principalType

principalId

membershipId

organizationId

commandType

permission

resourceType

resourceId when disclosure policy permits

reasonCode

policyVersion
```

---

# Human Authority Violation Logging

Attempts by non-Human principals to perform Human-authoritative commands require a dedicated event.

Example:

```text
HumanAuthorityBoundaryViolation
```

Fields:

```text
principalType

principalId

attemptedCommand

organizationId

resourceType

resourceId

reasonCode

correlationId
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

# Organization Isolation Logging

A rejected cross-Organization operation should emit:

```text
OrganizationIsolationViolation
```

Fields should avoid revealing the foreign Organization identifier to unauthorized callers.

Internal security telemetry may contain protected identifiers under restricted access.

---

# Worker Logging

Every Worker attempt should be observable.

Recommended Worker events:

```text
WorkerBatchStarted

WorkerItemClaimed

WorkerItemSucceeded

WorkerItemRetryScheduled

WorkerItemFailed

WorkerLeaseExpired

WorkerBatchCompleted
```

---

# Worker Success Logging

High-volume successful item logs may be sampled.

Metrics remain the primary tool for throughput.

Failures, retries, lease expiry, and poison events must not be sampled away.

---

# Retry Logging

A retry log must include:

```text
operationId

attempt

maximumAttempts

errorCategory

errorCode

nextAttemptAt

retryDelayMs

workerId

correlationId
```

---

# Retry Exhaustion

When retries are exhausted, emit:

```text
RetryExhausted
```

with severity:

```text
Error
```

or:

```text
Critical
```

depending on business impact.

The item should transition to a visible terminal operational state such as:

```text
Failed

DeadLettered

Abandoned
```

---

# Event Publication Logging

Recommended Outbox publication events:

```text
OutboxMessageClaimed

DomainEventPublicationStarted

DomainEventPublished

DomainEventPublicationRetryScheduled

DomainEventPublicationFailed

OutboxStreamBlocked
```

---

# Event Consumer Logging

Recommended consumer events:

```text
DomainEventReceived

DomainEventDuplicateDetected

DomainEventProcessingStarted

DomainEventProcessed

DomainEventRetryScheduled

DomainEventDeadLettered

DomainEventSkipped
```

---

# Event Contract Logging

Invalid event contracts should emit:

```text
EventContractRejected
```

Recommended fields:

```text
eventId

eventType

schemaVersion

consumerName

validationErrorCode

payloadHash

organizationId when safely available
```

Do not log the full invalid payload by default.

---

# Memory Generation Logging

Recommended events:

```text
MemoryGenerationScheduled

MemoryGenerationStarted

MemoryGenerationSucceeded

MemoryGenerationValidationFailed

MemoryGenerationRetryScheduled

MemoryGenerationFailed
```

---

# AI Provider Logging

When an external AI provider is used, logs may include:

```text
providerName

modelReference

requestDurationMs

responseStatusClass

tokenUsageCategory

generationPolicyVersion

promptTemplateVersion
```

Do not log:

- full prompt
- full response
- secrets
- Restricted Work content
- Restricted Decision content
- generated Memory content

---

# Content Fingerprints

Where troubleshooting requires identifying content consistency, use:

```text
contentHash
```

rather than content itself.

Hashes must not be treated as anonymization when the source space is guessable.

---

# Projection Logging

Recommended projection events:

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

# Reconciliation Logging

Recommended events:

```text
ReconciliationScanStarted

ReconciliationFindingCreated

ReconciliationRecoveryScheduled

ReconciliationFindingResolved

ReconciliationScanCompleted
```

Reconciliation logs should include:

```text
findingType

severity

organizationId

aggregateType

aggregateId

sourceEventId

resolutionReference
```

---

# Migration Logging

Every migration execution should emit:

```text
MigrationStarted

MigrationStepCompleted

MigrationFailed

MigrationCompleted
```

Recommended fields:

```text
migrationId

module

databaseName

applicationVersion

durationMs

outcome

errorCode
```

---

# Deployment Logging

Deployment systems should emit:

```text
DeploymentStarted

DeploymentInstanceReady

DeploymentInstanceFailed

DeploymentCompleted

DeploymentRolledBack
```

These events should be available independently from the newly deployed application process.

---

# Backup and Restore Logging

Recommended events:

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

# Operational Action Logging

Privileged operator actions require structured events.

Examples:

```text
ReplayRequested

ReplayApproved

ReplayStarted

ReplayCompleted

DeadLetterSkipped

IntegrityRepairRequested

IntegrityRepairApplied

WorkerPaused

WorkerResumed
```

---

# Log Retention

Log retention should vary by category.

Suggested categories:

```text
Application Operational Logs

Security Logs

Deployment Logs

Database Logs

Worker Failure Logs

Access Logs
```

Final retention periods depend on compliance, privacy, and cost requirements.

---

# Log Immutability

Centralized production logs should be protected from ordinary modification.

Application roles should not be able to delete centralized logs.

Stronger immutable storage may be used for security logs.

---

# Log Access

Access should be role-based.

Examples:

```text
Developers
    application operational logs

Operators
    infrastructure and Worker logs

Security Operators
    authorization and isolation logs

Database Administrators
    PostgreSQL operational logs
```

Restricted payload access should require additional authority.

---

# Log Sampling

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

# Log Rate Limiting

Repeated identical errors may be rate-limited to protect the telemetry pipeline.

The system must preserve:

- total count metric
- first occurrence
- latest occurrence
- representative correlation identifiers
- escalation when rate increases

---

# Correlation Model

AIOS uses several identifiers for different purposes.

```text
requestId

commandId

correlationId

causationId

eventId

traceId

spanId
```

They must not be used interchangeably.

---

# Request ID

`requestId` identifies one inbound transport request.

Examples:

- one HTTP request
- one CLI invocation
- one administrative operation

A retry creates a new requestId.

---

# Command ID

`commandId` identifies one logical authoritative command.

Client retries reuse the same commandId when intent is unchanged.

Example:

```text
CompleteWork command
```

Multiple HTTP requests may share one commandId.

---

# Correlation ID

`correlationId` identifies one end-to-end business workflow.

Example:

```text
Request blocking Decision

↓

Decision review

↓

Work Completion Gate update
```

The same correlationId may span multiple commands and events.

---

# Causation ID

`causationId` identifies the immediate cause of an operation.

Examples:

```text
Command causes Domain Event
```

```text
Domain Event causes Worker command
```

```text
Replay request causes replay execution
```

---

# Event ID

`eventId` uniquely identifies one immutable Domain or Integration Event.

Retries and redeliveries preserve the same eventId.

---

# Trace ID

`traceId` identifies one telemetry trace.

A trace may cover:

- one HTTP command
- one Worker execution
- one replay operation

A business correlation may span multiple traces.

---

# Span ID

`spanId` identifies one operation inside a trace.

Examples:

- authorization evaluation
- Aggregate load
- Aggregate save
- Outbox insert
- external provider call

---

# Correlation Propagation

Inbound transport should accept or create:

```text
requestId

correlationId

trace context
```

The server must validate inbound identifier format and length.

Untrusted callers must not be allowed to inject unsafe log content.

---

# Command Correlation

A Human command envelope should include:

```text
commandId

correlationId

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

---

# Event Correlation

Every Domain Event envelope should include:

```text
eventId

correlationId

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

---

# Consumer Correlation

When a consumer handles an event:

```text
correlationId = event.correlationId
```

The consumer execution creates a new traceId.

The immediate cause remains:

```text
causationId = event.eventId
```

---

# Follow-Up Event Correlation

When event handling emits another Domain Event:

```text
newEvent.correlationId
    = sourceEvent.correlationId
```

```text
newEvent.causationId
    = sourceEvent.eventId
```

---

# Replay Correlation

Replay should preserve the original business correlation while also recording the replay operation.

Recommended fields:

```text
correlationId = originalEvent.correlationId

causationId = replayId

originalEventId

replayId
```

The replayed delivery retains the original immutable eventId unless the delivery mechanism explicitly wraps it in an operational replay envelope.

---

# Scheduled Job Correlation

A scheduled job should create:

```text
jobRunId

correlationId
```

Each processed item receives:

```text
causationId = jobRunId
```

Items must still retain their business identifiers.

---

# Correlation Search

Operators should be able to search telemetry by:

- correlationId
- commandId
- eventId
- aggregateId
- organizationId
- replayId
- findingId
- traceId

Search access must respect privacy and Organization boundaries.

---

# Trace Architecture

Tracing should cover synchronous and asynchronous execution.

---

# HTTP Trace

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

# Worker Trace

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

# Memory Generation Trace

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

# Database Spans

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

# External Dependency Spans

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

# Span Status

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

# Trace Sampling

Recommended approach:

- sample a baseline percentage of successful traces
- retain all Error traces
- retain all Critical traces
- retain security-relevant Deny traces
- retain high-latency traces
- retain replay and repair traces
- retain traces associated with invariant violations

---

# Tail-Based Sampling

Tail-based sampling is preferred when available because it can retain traces based on final outcome.

It is optional for the MVP.

---

# Trace Retention

Trace retention may be shorter than audit retention.

Traces are diagnostic data, not durable business history.

---

# Trace Context Trust

Inbound trace context is untrusted.

The system should:

- validate format
- limit baggage size
- discard disallowed baggage
- avoid trusting client-provided Organization or principal attributes
- create server-owned security attributes

---

# Baggage Restrictions

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

# Audit Architecture

Durable audit complements logs and traces.

Audit records should be:

- append-oriented
- transactionally persisted when required
- queryable by Organization
- queryable by actor
- linked to command and event identifiers
- protected from ordinary update and deletion

---

# Audit Categories

Recommended categories:

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

# Authorization Audit

Every authoritative command should record:

```text
principal

organization

permission

resource

policy version

Allow or Deny

reason code

evaluated time
```

---

# Lifecycle Audit

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

# Membership Audit

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

# Replay Audit

Replay requires:

- requester identity
- requester Membership
- reason
- target event
- target consumer
- replay mode
- approval when required
- result
- timestamps

---

# Data Repair Audit

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

# Audit and Domain Events

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

# Audit Failure

For authoritative Human actions, required audit persistence should occur inside the same transaction.

If audit persistence fails:

```text
the authoritative command should roll back
```

This policy may be relaxed only through an explicit risk decision.

---

# Audit Query Access

Audit queries require elevated authority.

Organization administrators may receive Organization-scoped audit access.

Platform-wide audit access must remain restricted.

---

# Audit Export

Audit export should:

- require explicit permission
- preserve Organization scope
- redact sensitive fields
- record the export action
- use bounded date ranges
- avoid unrestricted bulk extraction

Audit export is optional for the MVP.

---

# Operational Event Taxonomy

Stable operational events improve search, alerting, and dashboards.

Recommended top-level categories:

```text
Application

Authorization

Domain

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

# Naming Pattern

Recommended pattern:

```text
<Subject><Action><Outcome>
```

Examples:

```text
DecisionCommandCompleted

OutboxMessagePublicationFailed

MemoryGenerationRetryScheduled

OrganizationIsolationViolationDetected
```

---

# Outcome Values

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

# Log Schema Version

Structured log records should include:

```text
logSchemaVersion
```

This supports changes to field names and semantics.

---

# Example Base Log Schema

```json
{
  "logSchemaVersion": 1,
  "timestamp": "2026-07-24T12:00:00Z",
  "severity": "Info",
  "eventName": "DomainEventProcessed",
  "message": "The domain event was processed successfully.",
  "serviceName": "aios-memory-worker",
  "serviceVersion": "1.0.0",
  "environment": "production",
  "requestId": null,
  "commandId": null,
  "correlationId": "corr-...",
  "causationId": "event-...",
  "traceId": "trace-...",
  "spanId": "span-...",
  "organizationId": "org-...",
  "principalType": "System",
  "principalId": "system-memory-worker",
  "aggregateType": "Memory",
  "aggregateId": "memory-...",
  "eventId": "event-...",
  "consumerName": "memory-generation",
  "workerId": "worker-03",
  "attempt": 1,
  "outcome": "Succeeded",
  "errorCategory": null,
  "errorCode": null,
  "durationMs": 184
}
```

---

# Log Field Cardinality

Fields intended for aggregation must remain bounded.

Low-cardinality examples:

```text
serviceName

environment

eventName

outcome

errorCategory

consumerName

aggregateType
```

High-cardinality examples:

```text
organizationId

aggregateId

commandId

eventId

traceId

principalId
```

High-cardinality fields belong in logs and traces, not ordinary metric labels.

---

# Message Redaction

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

# Redaction Failure

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

# Log Injection Protection

User-controlled values must remain structured fields.

They should not be concatenated into free-text log templates without escaping.

This prevents malicious or accidental log-line injection.

---

# Production Console Output

Containers and processes may write structured logs to:

```text
stdout

stderr
```

The platform collects and forwards them centrally.

Local file logging inside ephemeral containers should not be the primary strategy.

---

# Local Development Logging

Local development may use:

- readable console formatting
- expanded Debug details
- developer-only SQL detail
- local trace viewer

Production field names and event names should remain consistent.

---

# Clock and Timestamp

Telemetry timestamps must use UTC.

Recommended representation:

```text
ISO 8601

with timezone
```

System clocks should use reliable synchronization.

---

# Duration Measurement

Durations should use monotonic clocks where available.

Wall-clock timestamps should not be subtracted when clock adjustment could distort duration.

---

# Part 1 Invariants

The observability foundation must preserve:

1. Every command and Worker operation has a correlation identifier.
2. Command retries reuse commandId only when intent is unchanged.
3. Domain Events preserve correlationId and immediate causationId.
4. Logs use stable structured event names.
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
16. Operational telemetry failure does not normally roll back valid business operations.
17. Audit failure may roll back authoritative commands where audit is required.
18. Replay and repair operations are fully attributable.
19. Timestamps use UTC.
20. Telemetry schema changes are versioned.

---

# Part 1 Design Summary

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

# Metrics Architecture

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

# Metric Design Principles

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

# Metric Categories

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

# RED Metrics

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

# Request Rate

Measure:

```text
requests per second
```

Dimensions should include:

```text
service

endpoint

operation

result
```

Avoid Organization identifiers as metric labels.

---

# Error Rate

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

# Request Duration

Measure end-to-end execution time.

Preferred percentiles:

```text
P50

P95

P99
```

Average latency alone is insufficient.

---

# USE Metrics

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

# Domain Workflow Metrics

Infrastructure health alone does not indicate whether AIOS is functioning correctly.

Business workflow progression must also be measured.

---

# Work Lifecycle Metrics

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

# Decision Metrics

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

# Memory Metrics

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

# Completion Gate Metrics

Recommended:

```text
completion_gate_pending_total

completion_gate_satisfied_total

completion_gate_unsatisfied_total
```

These metrics help identify approval bottlenecks.

---

# Workflow Latency Metrics

Recommended:

```text
decision_submission_to_review_seconds

work_completion_to_memory_generation_seconds

memory_submission_to_review_seconds
```

Workflow latency often matters more than request latency.

---

# Authorization Metrics

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

# Worker Metrics

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

# Queue Metrics

Outbox and consumer queues should expose:

```text
pending_messages

oldest_pending_age_seconds

retry_pending_total

dead_letter_total

processing_rate
```

Queue age is often more important than queue length.

---

# Database Metrics

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

# Projection Metrics

Recommended:

```text
projection_updates_total

projection_failures_total

projection_rebuild_duration_seconds

projection_lag_seconds
```

---

# Reconciliation Metrics

Recommended:

```text
reconciliation_runs_total

reconciliation_findings_open

reconciliation_findings_resolved

reconciliation_duration_seconds
```

---

# Deployment Metrics

Recommended:

```text
deployment_duration_seconds

deployment_failures_total

rollback_total

migration_duration_seconds
```

---

# Backup Metrics

Recommended:

```text
backup_success_total

backup_failure_total

backup_age_seconds

restore_test_success_total

restore_test_duration_seconds
```

---

# Metric Labels

Labels should remain bounded.

Recommended labels:

```text
service

environment

operation

worker

consumer

status

outcome

error_category
```

Avoid:

```text
organizationId

aggregateId

eventId

commandId

traceId
```

These belong in logs and traces.

---

# Service Level Indicators

SLIs measure the observed quality of the service.

Recommended SLIs include:

```text
Availability

Request Latency

Worker Success Rate

Workflow Completion Latency

Queue Age

Memory Generation Success

Decision Review Latency
```

---

# Availability SLI

Definition:

```text
successful requests

/

total requests
```

Infrastructure failures and unexpected internal errors reduce availability.

Business validation failures do not.

---

# Request Latency SLI

Measure:

```text
P95 latency

P99 latency
```

per operation category.

---

# Workflow Completion SLI

Example:

```text
Completed Work

↓

Memory Generated

↓

within target duration
```

This measures end-to-end workflow health.

---

# Worker Success SLI

Definition:

```text
successful Worker items

/

claimed Worker items
```

Retries should not count as success until completed.

---

# Queue Age SLI

Definition:

```text
oldest pending message age
```

A growing age often indicates a stalled system before backlog becomes obvious.

---

# Suggested MVP SLOs

Illustrative objectives:

```text
HTTP Availability
>= 99.9%

P95 Request Latency
< 500 ms

Outbox Oldest Pending
< 30 seconds

Memory Generation Success
>= 99%

Decision Review Queue Availability
100% visible

Worker Claim Success
>= 99.9%
```

Final values depend on product requirements and operational capacity.

---

# Health Checks

Health checks determine whether components are functioning sufficiently for operation.

Health checks are not business diagnostics.

---

# Liveness

Liveness answers:

```text
Should this process be restarted?
```

Checks should include:

- process responsiveness
- deadlock detection where applicable
- fatal initialization failures

Liveness should not depend on transient external systems.

---

# Readiness

Readiness answers:

```text
Can this process safely receive traffic?
```

Checks may include:

- database connectivity
- migration compatibility
- configuration validity
- connection pool availability
- required dependency availability

---

# Startup Checks

On startup the application should verify:

- configuration loaded
- migrations compatible
- database reachable
- secrets available
- telemetry initialized

Failure should prevent accepting traffic.

---

# Worker Health

Worker readiness should additionally verify:

- claim capability
- database write access
- required queues accessible
- dependency initialization complete

---

# Health Response

Health endpoints should return structured responses.

Example:

```json
{
  "status": "Healthy",
  "checks": {
    "database": "Healthy",
    "outbox": "Healthy",
    "workers": "Healthy"
  }
}
```

Avoid exposing internal infrastructure details publicly.

---

# Dashboards

Dashboards should support:

- executives
- operators
- developers
- incident responders

Each audience requires different views.

---

# Executive Dashboard

Recommended indicators:

- availability
- Work throughput
- Decision throughput
- Memory throughput
- incident count
- deployment status

---

# Operations Dashboard

Recommended indicators:

- request rate
- error rate
- latency
- queue age
- Worker throughput
- retry rate
- dead letters
- reconciliation findings
- database health

---

# Developer Dashboard

Recommended indicators:

- slow queries
- serialization retries
- deadlocks
- deployment history
- exception rate
- trace latency
- Worker failures

---

# Workflow Dashboard

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

# Alerting Principles

Alerts should be:

- actionable
- specific
- low-noise
- severity classified
- deduplicated
- correlated

---

# Alert Severity

Recommended levels:

```text
Info

Warning

High

Critical
```

---

# Critical Alerts

Examples:

- database unavailable
- authoritative writes failing
- Organization isolation violation
- audit persistence unavailable
- no active Owner detected
- migration failure during deployment

---

# High Alerts

Examples:

- Outbox backlog growing
- Worker retries exhausted
- replay failures
- queue age exceeds objective
- Memory generation failure rate increasing

---

# Warning Alerts

Examples:

- increased latency
- retry growth
- slow queries
- projection lag
- backup overdue

---

# Alert Routing

Alert routing should distinguish:

- infrastructure
- application
- security
- business workflow
- deployment

Different teams may own different categories.

---

# Worker Monitoring

Operators should observe:

- active Workers
- idle Workers
- claim success
- retry rates
- failure rates
- lease expiry
- processing latency

---

# Outbox Monitoring

Recommended dashboards:

```text
Pending Messages

Publication Rate

Retry Rate

Oldest Pending Age

Publication Failures
```

---

# Consumer Monitoring

Recommended dashboards:

```text
Messages Processed

Duplicate Events

Retry Pending

Dead Letters

Average Processing Time
```

---

# Database Monitoring

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

# Capacity Indicators

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

# Part 2 Invariants

The operational metrics architecture must preserve:

1. Metrics remain low-cardinality.
2. Business workflow progression is measurable.
3. Availability and latency are measured independently.
4. Queue age is observable.
5. Worker retries are visible.
6. Human-authority violations are measurable.
7. Organization isolation violations are measurable.
8. Health checks distinguish liveness from readiness.
9. Dashboards are audience-specific.
10. Alerts remain actionable and low-noise.
11. Workflow latency is measured end-to-end.
12. Metrics never become authoritative business state.

---

# Part 2 Design Summary

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

# Incident Response

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

# Incident Definition

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

# Incident Categories

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

# Incident Severity

Recommended severity levels:

```text
SEV-1

SEV-2

SEV-3

SEV-4
```

---

# SEV-1

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

Incident Commander assigned

Affected mutation paths contained

Executive and security communication initiated

Continuous response until controlled
```

---

# SEV-2

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

# SEV-3

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

# SEV-4

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

# Incident Lifecycle

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

# Detection

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

# Acknowledgement

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

# Incident Commander

SEV-1 and SEV-2 incidents should have an Incident Commander.

The Incident Commander coordinates:

- severity
- priorities
- responder roles
- communication
- mitigation decisions
- escalation
- resolution criteria

The Incident Commander does not necessarily perform technical remediation.

---

# Technical Lead

The Technical Lead owns:

- diagnosis
- containment proposal
- mitigation execution
- recovery validation
- technical risk assessment

---

# Communications Lead

For significant incidents, a Communications Lead may own:

- internal status updates
- stakeholder notifications
- customer-facing communication
- timeline accuracy
- resolution notice

---

# Scribe

A Scribe records:

- timeline
- decisions
- hypotheses
- commands executed
- configuration changes
- observed results
- unresolved questions

Incident records must not depend on memory after the event.

---

# Incident Timeline

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

# Containment

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

# Safe Containment Priority

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

# Read-Only Containment

Read-only mode may be used when authoritative writes are unsafe.

In read-only mode:

- reads may continue where safe
- authoritative commands are rejected
- Workers that mutate Aggregate state are paused
- Outbox publication policy is explicitly decided
- audit and operational access remain available
- maintenance messaging is shown

---

# Organization-Specific Containment

Where possible, isolate only the affected Organization.

Possible actions:

- block Organization mutations
- pause Organization-scoped Worker processing
- disable Organization invitations
- prevent replay for the Organization
- preserve read-only access

Organization-specific containment must not expose the Organization to other tenants.

---

# Worker Containment

A Worker may be paused when:

- it produces repeated invalid effects
- event contract interpretation is defective
- an external dependency is unsafe
- duplicate processing risk is high
- queue growth is preferable to corrupted state

Pausing must emit an operational audit event.

---

# Incident Evidence

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

# Database Investigation Safety

Production investigation queries should:

- be read-only
- use bounded time ranges
- include Organization scope where applicable
- avoid full-table scans during load
- avoid unbounded payload export
- use approved operational roles
- be recorded for significant incidents

---

# Manual Repair During Incident

Manual repair is allowed only when:

- supported recovery paths are insufficient
- impact justifies intervention
- repair is reviewed
- before-state evidence is preserved
- affected Organization scope is explicit
- validation criteria are defined
- operator identity is recorded
- follow-up reconciliation is executed

---

# Resolution Criteria

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

# Monitoring Phase

Before resolution, the system should remain in monitoring long enough to verify:

- no recurrence
- queue age decreases
- error rate normalizes
- database health stabilizes
- Worker claims remain valid
- no new reconciliation findings appear

---

# Incident Review

SEV-1 and SEV-2 incidents require a post-incident review.

A SEV-3 incident may also require review when it exposes systemic weakness.

---

# Blameless Review

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

# Post-Incident Review Contents

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

# Root Cause

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

# Corrective Actions

Corrective actions should prioritize:

1. prevention
2. earlier detection
3. safer containment
4. faster recovery
5. clearer ownership

Actions must have Human owners and due dates.

---

# Incident Metrics

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

# Operational Runbooks

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

# Runbook Principles

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

# Runbook Ownership

Every runbook should have:

```text
owner

reviewDate

lastTestedAt

applicableVersion

severity
```

---

# Required MVP Runbooks

The MVP should include runbooks for:

```text
Application unavailable

Database unavailable

Database connection pool exhausted

Outbox backlog

Outbox publisher stalled

Worker retry exhaustion

Dead-letter event

Memory generation failure

Projection lag

Organization isolation alert

Human authority violation

Last Owner invariant finding

Migration failure

Deployment rollback

Backup failure

Point-in-time recovery

Secret rotation

Configuration rollback

Feature-flag emergency disable
```

---

# Runbook: Application Unavailable

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

# Runbook: Database Unavailable

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

# Runbook: Connection Pool Exhaustion

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

# Runbook: Outbox Backlog

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

# Runbook: Dead-Letter Event

Steps:

1. inspect event metadata
2. inspect consumer error classification
3. validate event schema
4. identify affected Organization
5. determine whether failure is transient or permanent
6. fix consumer or data condition
7. request replay
8. validate idempotency
9. resolve dead-letter record

Skipping requires explicit Human approval and reason.

---

# Runbook: Memory Generation Failure

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

# Runbook: Organization Isolation Alert

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

# Runbook: Human Authority Violation

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

# Runbook: Last Owner Finding

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

# Runbook: Migration Failure

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

# Runbook: Backup Failure

Steps:

1. identify last successful backup
2. verify WAL continuity
3. calculate RPO exposure
4. restore backup job
5. verify encryption and storage access
6. perform validation backup
7. escalate before RPO breach
8. schedule restore test if confidence is reduced

---

# Feature Flags

Feature flags allow controlled activation of behavior without immediate redeployment.

They are operational controls, not replacements for Domain rules.

---

# Feature Flag Principles

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

# Feature Flag Categories

Recommended categories:

```text
Release

Operational

Experiment

PermissionedPreview

EmergencyKillSwitch
```

---

# Release Flags

Release flags support gradual rollout of new code paths.

Example:

```text
new-memory-generation-validator
```

They should be temporary.

---

# Operational Flags

Operational flags control runtime behavior.

Examples:

```text
pause-memory-generation

reduce-outbox-batch-size

disable-projection-rebuild
```

---

# Experiment Flags

Experiment flags support user-experience testing.

They must not alter:

- authorization
- Human authority
- Organization isolation
- immutable revision rules
- audit requirements

---

# Permissioned Preview Flags

Permissioned Preview flags may enable a feature for selected Organizations.

Selection must use approved Organization identifiers and remain auditable.

---

# Emergency Kill Switches

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

# Prohibited Flag Behavior

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

# Flag Evaluation

Flag evaluation should be:

- deterministic
- low-latency
- bounded
- observable
- Organization-aware where applicable
- independent from sensitive payload content

---

# Flag Failure Mode

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

# Flag Caching

Flag values may be cached.

The cache policy should define:

- refresh interval
- maximum staleness
- emergency invalidation
- startup behavior
- fallback value

---

# Flag Audit

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

# Flag Lifecycle

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

# Flag Debt

Long-lived release flags create complexity.

Every temporary flag should have:

- owner
- removal criteria
- removal date
- linked implementation task

---

# Configuration Management

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

# Configuration Principles

Configuration must be:

- environment-specific
- versioned where practical
- validated at startup
- secret-free unless using secret references
- observable
- auditable for sensitive changes
- safely reloadable only where defined

---

# Configuration Hierarchy

Recommended precedence:

```text
Code Defaults

Environment Configuration

Deployment Configuration

Runtime Operational Override
```

Runtime overrides should be limited and auditable.

---

# Typed Configuration

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

# Startup Validation

The process should fail startup when required configuration is:

- missing
- malformed
- outside safe range
- inconsistent
- incompatible with deployed schema
- incompatible with another required setting

---

# Configuration Bounds

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

# Dynamic Configuration

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

# Configuration Version

Processes should expose:

```text
configurationVersion
```

Operational events should record the active version.

---

# Configuration Drift

Drift detection should identify differences between:

- declared configuration
- deployed configuration
- runtime configuration
- expected secret references
- feature-flag state

Unexpected drift should create an alert or finding.

---

# Configuration Rollback

Every sensitive configuration change should have:

- previous value
- rollback procedure
- validation criteria
- operator
- reason
- timestamp

---

# Secrets Management

Secrets must be stored outside source control and ordinary configuration files.

Examples:

- database credentials
- AI provider API keys
- telemetry exporter credentials
- encryption keys
- broker credentials
- backup credentials

---

# Secret Management Principles

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

# Secret References

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

# Secret Access

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

# Secret Rotation

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

# Emergency Rotation

Emergency rotation may be required after:

- suspected credential exposure
- unauthorized access
- employee departure
- provider incident
- logging defect
- backup access concern

Emergency rotation should have a tested runbook.

---

# Secret Expiry

Where supported, secrets should have bounded validity.

Expiring secrets require alerts before expiration.

---

# Secret Logging Prohibition

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

# Local Development Secrets

Local development should use:

- local secret store
- environment injection
- development-only managed secrets

Shared plaintext secret files are prohibited.

---

# Deployment Strategy

The deployment architecture must preserve availability, compatibility, and authoritative data safety.

Recommended MVP strategy:

```text
Rolling Deployment

with Expand-and-Contract Database Migrations
```

Blue-Green deployment may be used where infrastructure supports it.

---

# Deployment Principles

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

# Deployment Artifact

Each deployable artifact should be immutable and identified by:

```text
applicationVersion

sourceRevision

buildId

dependency lock state

configuration schema version
```

---

# Pre-Deployment Checks

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

# Deployment Order

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

# Rolling Deployment

Rolling deployment replaces instances gradually.

During the rollout:

- old and new versions may run concurrently
- both versions must understand the active schema
- event consumers must support relevant event versions
- feature flags should prevent premature activation
- readiness gates control traffic

---

# Rolling Deployment Readiness

A new instance becomes ready only after:

- startup validation succeeds
- database connectivity succeeds
- schema compatibility succeeds
- required secrets load
- telemetry initializes
- critical dependencies are usable
- process-specific readiness passes

---

# Rolling Worker Deployment

Workers require additional care.

Recommended sequence:

1. deploy new consumer code disabled or idle
2. verify startup and contract compatibility
3. reduce or pause old Worker claims if required
4. enable new Workers gradually
5. verify claim ownership and processing
6. retire old Workers

---

# Consumer Compatibility

Consumers should be deployed before producers of a new event schema.

During mixed deployment, consumers must tolerate:

- current event version
- previous supported event versions
- duplicate delivery
- replay
- delayed delivery

---

# Blue-Green Deployment

Blue-Green deployment maintains two complete application environments:

```text
Blue

Green
```

Traffic switches after validation.

---

# Blue-Green Advantages

- rapid rollback
- isolated pre-traffic validation
- reduced mixed-instance duration
- easier smoke testing

---

# Blue-Green Limitations

- shared database compatibility still required
- Workers may process twice if both environments are active
- external callbacks may target both environments
- infrastructure cost increases
- schema contraction remains separate

---

# Blue-Green Worker Rule

Only one environment should actively claim the same Worker queue unless claim safety and idempotency explicitly support both.

Activation must be controlled.

---

# Canary Deployment

Canary deployment may send limited traffic to the new version.

Canary selection may use:

- small request percentage
- internal users
- selected Organizations
- non-authoritative read paths

Authority-sensitive commands require careful validation before canary exposure.

---

# Deployment Smoke Tests

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

# Deployment Validation

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

# Automatic Rollback

Automatic rollback may occur when:

- readiness fails
- crash rate exceeds threshold
- request failure rate sharply increases
- critical smoke test fails
- migration compatibility check fails

Automatic rollback must not occur blindly when the database has undergone an irreversible migration.

---

# Forward Fix

A forward fix is preferred when:

- migration is not safely reversible
- new event schema has already been emitted
- data backfill has changed semantic state
- rollback would create greater inconsistency

The deployment plan must classify this before release.

---

# Deployment Freeze

Deployment may be frozen during:

- unresolved SEV-1 or SEV-2 incidents
- backup uncertainty
- migration instability
- major reconciliation findings
- peak operational periods
- provider instability affecting validation

Emergency security fixes may follow a separate expedited process.

---

# Maintenance Mode

Maintenance mode may restrict user operations during unsafe system conditions.

Recommended modes:

```text
Normal

ReadOnly

RestrictedWrites

FullMaintenance
```

---

# Normal Mode

All authorized operations are available.

---

# Read-Only Mode

Safe reads are available.

State-changing commands are denied with a clear temporary response.

Mutation Workers are paused unless explicitly required for recovery.

---

# Restricted Writes Mode

Only selected safe operations are permitted.

Examples:

- operator recovery
- audit access
- claim recovery
- controlled replay
- configuration rollback

---

# Full Maintenance Mode

User traffic is rejected.

Only approved operational access remains.

---

# Maintenance Mode Authority

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

# Organization-Scoped Maintenance

Maintenance may apply to one Organization.

This is preferable when the issue is tenant-specific.

The scope must be enforced in command authorization and Worker processing.

---

# Maintenance Mode Messaging

Responses should communicate:

- operation unavailable
- temporary nature
- retry guidance
- support reference where applicable

They must not expose internal incident details.

---

# Operational Automation

Operational automation reduces repetitive Human intervention.

Automation must remain bounded and auditable.

---

# Safe Automation Examples

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

# Unsafe Automation Examples

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

# Auto-Remediation Requirements

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

# Circuit Breakers

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

# Circuit Breaker Behavior

When the AI provider circuit is open:

- new generation attempts pause or fail transiently
- authoritative Work state remains unchanged
- WorkCompleted events remain durable
- generation retries are scheduled
- no invalid Memory is created
- operators are alerted when objectives are breached

---

# Rate Limiting

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

# Backpressure

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

# Bulkhead Isolation

Separate resource pools may isolate:

- HTTP requests
- Outbox publisher
- Memory generation
- projections
- maintenance jobs

One overloaded Worker type should not exhaust all database connections.

---

# Scheduled Operations

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

# Operational Job Idempotency

Scheduled jobs must be safe to retry.

They should use:

- stable operation identity
- progress checkpoints
- bounded batches
- duplicate protection
- explicit completion state

---

# Operational Approval

High-risk operations require Human approval.

Examples:

- replaying a high-authority event
- skipping a dead letter
- applying data repair
- restoring a database
- changing maintenance mode globally
- enabling an emergency bypass
- rotating platform-wide encryption keys

---

# Operational Commands

Operational actions should use explicit commands.

Examples:

```text
PauseWorker

ResumeWorker

RequestReplay

ApproveReplay

StartReplay

EnterMaintenanceMode

ExitMaintenanceMode

RequestDataRepair

ApplyDataRepair
```

These commands should be idempotent where practical.

---

# Operational Principal Types

Operational commands may be initiated by:

```text
HumanOperator

SystemAutomation
```

System automation remains constrained to explicitly approved operational capabilities.

A System principal does not gain Human business authority.

---

# Operational Audit

Every privileged operational command should record:

- principal
- scope
- command
- reason
- approval reference
- result
- correlationId
- timestamp

---

# Change Management

Operational changes should be classified by risk.

Recommended classes:

```text
Standard

Normal

Emergency
```

---

# Standard Change

A repeatable, low-risk, pre-approved change.

Examples:

- routine secret rotation
- approved Worker scaling
- tested patch deployment
- regular backup verification

---

# Normal Change

A reviewed change with planned execution.

Examples:

- schema migration
- configuration change
- new Worker rollout
- SLO threshold adjustment

---

# Emergency Change

A change required to contain or resolve an incident.

It must still record:

- reason
- operator
- scope
- result
- retrospective review

---

# Part 3 Invariants

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
20. Operational commands remain attributable and idempotent where practical.
21. External dependency failure cannot fabricate authoritative success.
22. Read-only mode does not use non-authoritative fallback state.
23. Automatic rollback is not used when rollback would corrupt schema or event compatibility.
24. Every temporary release flag has a removal plan.
25. Incident resolution includes recovery validation, not only alert clearance.

---

# Part 3 Design Summary

The AIOS operational control model combines:

```text
Severity-Based Incident Response

Version-Controlled Runbooks

Audited Feature Flags

Typed Configuration

Centralized Secret Management

Rolling or Blue-Green Deployment

Explicit Maintenance Modes

Bounded Operational Automation
```

Operational controls may pause, contain, retry, scale, or recover the system.

They cannot approve Decisions, complete Work, approve Memory, assign Human authority, or weaken Organization isolation.

Production changes remain observable, reversible where possible, and forward-fixable where rollback is unsafe.

# Capacity Planning

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

# Capacity Planning Principles

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

# Capacity Dimensions

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

# Workload Profiles

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

# Normal Day Profile

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

# Peak Business Hour Profile

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

# Worker Recovery Profile

The Worker Recovery profile models a period after:

- Worker outage
- database outage
- external provider outage
- deployment pause
- queue isolation
- disaster recovery

The system must support backlog recovery without overwhelming PostgreSQL or downstream dependencies.

---

# Recovery Capacity

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

# Capacity Headroom

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

# Saturation Indicators

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

# Database Capacity

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

# Database Connection Capacity

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

# Connection Budget

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

# Connection Pool Sizing

Pool size should be based on measured database throughput.

More connections do not automatically increase performance.

Excessive connections may increase:

- context switching
- memory usage
- lock contention
- transaction overlap
- latency variance

---

# Worker Concurrency Capacity

Worker concurrency should be tuned against:

- database connection limits
- average item duration
- external provider quotas
- lock contention
- CPU
- memory
- backlog recovery objective

---

# Little’s Law Guidance

Approximate concurrency may be estimated from:

```text
Concurrency
    ≈
Throughput × Average Duration
```

This is a planning aid, not a substitute for load testing.

---

# Worker Batch Capacity

Batch size affects:

- claim transaction duration
- lock duration
- memory usage
- fairness
- recovery speed
- retry blast radius

Batches should remain bounded.

---

# Outbox Capacity

Outbox capacity planning should consider:

- event creation rate
- event