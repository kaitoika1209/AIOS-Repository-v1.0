# ADR-0002: Select the MVP Observability and Operations Stack

- Status: Accepted
- Date: 2026-07-26
- Blueprint Version: v0.2.0
- Decision Owner: Platform Operations
- Review Trigger: before production launch, when monthly observability cost exceeds the approved limit, or when a second production region is introduced

---

# Context

The AIOS observability architecture defines portable contracts for structured logs, metrics, traces, audit, alerting, and incident response.

Portability is useful at the architecture boundary, but the MVP cannot validate cost, retention, regional failure behavior, access control, or operational ownership without selecting an implementation stack.

AIOS is operated by a one-to-three-person team and the repository already selects AWS as the infrastructure platform. The MVP therefore favors managed AWS services and the smallest operational surface that satisfies the production baseline.

This ADR selects an implementation stack. It does not make CloudWatch concepts part of the Domain Model, Application Layer, or telemetry schema.

---

# Decision

The MVP production observability stack is:

| Concern | MVP implementation |
|---|---|
| Application and Worker logs | Structured JSON written to stdout and ingested into Amazon CloudWatch Logs by the selected AWS compute runtime |
| Log query | Amazon CloudWatch Logs Insights with version-controlled saved queries for required runbooks |
| Metrics | AWS service metrics plus bounded AIOS custom metrics published to Amazon CloudWatch under environment-specific namespaces |
| Dashboards | Amazon CloudWatch Dashboards |
| Alert evaluation | Amazon CloudWatch Alarms |
| Alert delivery | Amazon SNS to verified operator email destinations; additional paging vendors are not required for the MVP |
| Error tracking | Registered `error.*` attributes, operational log classes, Logs Insights queries, metric filters, and alarms; no separate error-tracking SaaS |
| Trace context | OpenTelemetry API and W3C Trace Context for in-process instrumentation and propagation |
| Remote trace backend | Disabled for the MVP baseline; activation is Production Hardening and requires a retention and cost review |
| Durable audit | PostgreSQL audit tables under the audit durability classes; audit is not exported through CloudWatch as its authoritative store |
| AWS control-plane audit | AWS CloudTrail for changes to telemetry resources, IAM policy, alarms, log groups, and retention configuration |
| Recovery visibility | CloudWatch alarms and dashboards over the backup, WAL, restore-test, and recovery metrics required by the architecture |

Prometheus, Grafana, a self-managed OpenTelemetry Collector fleet, and an external error-tracking SaaS are not part of the MVP production baseline.

Application code depends on AIOS telemetry ports and the versioned operational log schema. AWS SDKs, CloudWatch namespaces, and exporter configuration remain Infrastructure Layer details.

---

# Region and Availability

The MVP primary AWS Region is `ap-northeast-1` (Tokyo).

Production logs, metrics, dashboards, alarms, SNS topics, and encryption keys remain in that Region unless an approved security or recovery decision states otherwise.

The MVP does not build a multi-region observability control plane. A full regional failure may make the application and its same-region telemetry unavailable together. This is an accepted MVP risk, not an availability guarantee.

The regional-outage runbook MUST include:

- checking the AWS public status and account health surfaces
- verifying the last known database recovery point through the recovery control path
- using the designated out-of-band operator contact channel
- recording the observation gap in the incident timeline
- prohibiting restoration claims based only on missing CloudWatch alarms

Before AIOS claims multi-region availability, a later ADR MUST select an external or out-of-region availability signal and define its ownership, cost, data classification, and failure behavior.

---

# Retention

The architecture document remains canonical for AIOS retention intent.

| Data | MVP implementation retention |
|---|---|
| Application, Worker, deployment, database, and access log groups | 30 days |
| Restricted security log groups | 90 days |
| CloudWatch custom metrics | 30-day active SLO and dashboard query window; provider-managed aggregated metric points may remain available under CloudWatch's fixed rollup retention |
| Remote traces | Not collected in the MVP baseline |
| Class A and Class B audit | 365 days in PostgreSQL |
| Persisted Class C denial telemetry | Maximum 30 days |
| Terminal operational workflow records and health history | 90 days after terminal resolution |

CloudWatch metric dimensions MUST contain only bounded T0 or approved T1 attributes. They MUST NOT contain `organizationId`, Aggregate identifiers, Human identifiers, content, external correlation identifiers, or other tenant-sensitive values. This permits provider-managed metric rollups to exist beyond the active 30-day AIOS query window without becoming a hidden tenant-data retention path.

CloudWatch log-group retention is set explicitly through Infrastructure as Code. The provider default of indefinite log retention is prohibited.

If remote tracing is enabled later, the implementation ADR MUST reconcile the selected backend's actual retention with the architecture's trace-retention rule before production spans are exported.

Provider constraints are recorded against the official service documentation:

- [CloudWatch Logs retention](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/WhatIsCloudWatchLogs.html)
- [CloudWatch metrics retention and rollups](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_concepts.html)
- [AWS X-Ray retention, if evaluated later](https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html)

---

# Cost Guardrails

The initial monthly observability budgets, excluding authoritative PostgreSQL storage and ordinary application compute, are:

| Environment | Monthly limit |
|---|---:|
| Production | USD 100 |
| All non-production environments combined | USD 25 |

AWS Budgets notifications MUST be delivered at 60%, 80%, and 100% of each limit.

The MVP MUST also enforce:

- no more than 100 active AIOS custom metric time series without review
- no high-resolution custom metrics unless an SLO cannot be measured otherwise
- no Organization, Aggregate, request, trace, or principal identifiers in metric dimensions
- INFO as the normal production log level
- DEBUG disabled by default and enabled only with an owner, scope, and expiry
- no remote trace export in the MVP baseline
- bounded Logs Insights queries and version-controlled operational query examples
- monthly review of ingestion volume, stored bytes, custom metric count, alarm count, and query spend

Exceeding a budget does not permit dropping Class A or Class B audit, security violations, Human-authority violations, Organization-isolation evidence, or required recovery evidence. Cost reduction first targets debug logs, ordinary informational logs, query frequency, and optional telemetry.

A sustained need above the limit requires an ADR update or a documented capacity decision; silent cost growth is not accepted.

---

# Security and Tenant Isolation

Production telemetry uses least-privilege IAM roles and named Human access with MFA.

Separate log groups and access policies are used for ordinary application telemetry and restricted security telemetry.

Restricted security log groups use a customer-managed KMS key and deletion protection. Application execution roles may write but cannot change retention, disable deletion protection, or delete production log groups.

CloudTrail records administrative changes to CloudWatch, SNS, KMS, and IAM resources. CloudTrail is infrastructure audit and does not replace AIOS Domain or authorization audit.

No external telemetry exporter or vendor support integration receives production data in the MVP. Adding one requires:

- data classification and field allowlist
- regional and subprocessors review
- access and deletion contract
- failure and backpressure contract
- cost limit
- an ADR update

---

# Failure Behavior

CloudWatch failure MUST NOT roll back a valid Domain transaction or report an authoritative command as failed after it committed.

Application-side log and metric delivery uses bounded buffers, finite timeouts, bounded retries, and the drop priority defined in the observability architecture. Required durable audit remains in PostgreSQL and is not placed behind an optional telemetry exporter.

The platform MUST expose telemetry-loss and exporter-failure counters through the cheapest remaining local or managed path. Repeated exporter failure opens an owned operational finding.

When CloudWatch Alarms or SNS delivery is unavailable:

- AIOS does not infer that the platform is healthy
- readiness remains based on authoritative dependencies, not telemetry delivery
- operators use the relevant direct diagnostic and AWS health runbooks
- missed or delayed notifications are recorded during incident review

---

# Operational Ownership

Responsibilities may be combined by the small team, but they cannot be unowned.

| Responsibility | Owner |
|---|---|
| Operational log and metric semantics | Owning application module |
| Telemetry adapter implementation | Platform engineering |
| CloudWatch, SNS, KMS, CloudTrail, budgets, retention, and dashboards | Platform Operations |
| Restricted security telemetry and access reviews | Platform Security |
| SLO formulas and alert thresholds | Service owner with Platform Operations review |
| Monthly cost and cardinality review | Platform Operations |
| Incident use of telemetry | Named Human incident owner |

The production readiness checklist MUST verify these owners, alert destinations, and budget recipients. Placeholder addresses or unowned alarms block production approval.

---

# Alternatives Considered

## Self-Managed Prometheus and Grafana

Rejected for the MVP because a one-to-three-person team would own additional storage, upgrades, backup, access control, and availability concerns before the product has validated its workload.

## Managed Prometheus and Managed Grafana

Deferred because they add cost and operational surfaces without a current requirement that CloudWatch metrics and dashboards cannot satisfy.

## External Error-Tracking or Observability SaaS

Deferred because it introduces another processor of production telemetry, a separate retention contract, regional decisions, and additional cost.

## Remote Tracing in the MVP

Deferred because the modular monolith can diagnose the initial workflow with correlation identifiers, structured logs, PostgreSQL operational state, and bounded metrics. OpenTelemetry propagation is retained so remote traces can be enabled without changing Domain or Application contracts.

---

# Consequences

## Positive

- The MVP has a concrete, cost-bounded implementation.
- Managed services reduce the operational load on a small team.
- PostgreSQL remains authoritative for business state and durable audit.
- Vendor-specific code remains behind Infrastructure Layer adapters.
- Retention and regional limitations are explicit rather than hidden.

## Negative

- CloudWatch metric rollups can remain available longer than the 30-day active AIOS query window.
- A regional AWS failure can remove both service availability and same-region observability.
- CloudWatch-only error investigation is less specialized than a dedicated error-tracking SaaS.
- Remote traces are not available in the MVP baseline.
- Moving provider requires replacing Infrastructure Layer adapters and operational assets.

---

# Related Documents

- `observability-and-operations.md`
- `docs/architecture/persistence-and-data-model.md`
- `docs/architecture/events-and-outbox.md`
- `README.md`
