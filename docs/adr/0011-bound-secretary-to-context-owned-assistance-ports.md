# ADR-0011: Bind the Secretary to Context-Owned AI Assistance Ports

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1

## Context

The Secretary participates in Work, Decision, and Memory use cases. Treating it as one central domain service with broad repository, Aggregate, tool, or command access would create a cross-context God Component. It would concentrate domain knowledge, weaken module ownership, make tenant isolation depend on one coordinator, and allow future AI behavior to bypass Human authority.

“Advisory only” is necessary but insufficient. The implementation boundary must make unauthorized operations unavailable by construction and must ensure that each Bounded Context owns the meaning, inputs, validation, and recording of AI assistance performed in that context.

## Decision

### The Secretary is a Principal and adapter, not a domain owner

The Secretary is an Organization-scoped AI Principal resolved by Identity and Organization and constrained by Authorization. It is not:

- a Bounded Context;
- an Aggregate;
- a cross-context Domain Service;
- an owner of Work, Decision, Memory, or future Knowledge rules;
- a global repository or query gateway; or
- a source of Human business authority.

The Secretary Runtime is an Application/Infrastructure adapter that invokes context-owned AI Assistance Application Ports.

### Each context owns its AI Assistance Port

Each participating context may expose a narrow port for the assistance operations it currently supports.

```text
Secretary Runtime Adapter
        |
        +--> WorkAiAssistancePort
        +--> DecisionAiAssistancePort
        +--> MemoryAiAssistancePort
```

The owning context defines:

- typed request and response contracts;
- the Organization-scoped source query;
- the minimum permitted source data;
- content and size validation;
- provenance requirements;
- the Aggregate command, if any, that records an advisory contribution; and
- stable failure outcomes.

These ports return proposals or record attributable advisory contributions. They do not expose generic command dispatch, repositories, ORM entities, database connections, mutable Aggregates, or unrestricted search.

### Human-only commands are absent from Secretary-facing interfaces

The following are not members of any AI Assistance Port:

- start, complete, cancel, or reopen Work;
- submit, approve, reject, or withdraw a Decision;
- submit, approve, reject, or authoritatively reopen Memory;
- manage Membership, roles, permissions, or Organization ownership;
- publish future Knowledge; or
- invoke an arbitrary module command by name.

Runtime authorization remains mandatory, but interface segregation provides the first structural control. A string-based generic `ExecuteCommand(commandName, payload)` or general tool executor is prohibited.

### Invocation is deny-by-default and context-specific

Every invocation is authorized against an active grant identified by:

```text
organizationId
secretaryPrincipalId
contextKey
assistanceOperation
portContractVersion
```

The grant is an AI-assistance permission, not the future `Capability` domain concept. Unknown contexts, operations, versions, tools, models, or source types fail closed.

An invocation also requires:

- an authenticated initiating Human command or a separately permitted System workflow;
- same-Organization Principal, target, source data, and contribution destination;
- current policy evaluation at execution time;
- bounded input and output schemas;
- an idempotency or generation-operation identifier where persistence may occur; and
- correlation and causation metadata.

### Generation and adoption are separate commands

An authorized request to generate a suggestion authorizes only generation and optional recording of that advisory contribution.

Adoption requires a later authorized Human command through the normal context Application Service. The Human command reloads current state, re-evaluates authorization and invariants, and records both the Secretary provenance and the Human actor who adopted or edited the proposal.

No AI response, model confidence, event, callback, or tool result is proof of Human intent.

### Data access remains context-owned

The Secretary Runtime never reads a context's tables or Repository directly. It supplies an authorized request to the context-owned port. The owning Application Service obtains the smallest necessary Organization-scoped snapshot through owned query or Repository ports and sends only that bounded snapshot to external computation.

Cross-context source data must be obtained through an explicit query port, immutable event data, or a documented coordinator. A Secretary prompt is not an integration contract.

### External computation is separated from business effects

Model invocation is `ExternalComputation` under ADR-0004. Provider success produces untrusted candidate data, not a business transition.

The MVP Secretary cannot invoke arbitrary external business-effect tools. Enabling email, webhook, payment, access-control, remote-object mutation, or another external effect requires a separately registered effect contract, Authorization policy, durable effect ledger, operational controls, and an accepted implementation decision.

### Tenant isolation and prompt safety

All persisted Secretary identities and grants include immutable `organization_id`. Composite constraints prevent cross-Organization grants and contributions.

Prompts, retrieved content, provider responses, and tool-like instructions are untrusted data. They cannot modify the allowlist, select another Organization, expand source scope, choose a command, or grant authority. Source selection is performed by trusted Application code before provider invocation.

### Failure behavior

Secretary timeout, provider rejection, invalid output, authorization denial, stale generation result, or contribution-persistence failure:

- does not change authoritative lifecycle state;
- does not retry a Human command;
- does not silently switch Organization, operation, model, or source scope;
- records a bounded operational outcome; and
- returns a stable advisory failure result.

Retries reuse the same bounded source snapshot and generation-operation identity where the use case requires effectively-once contribution recording.

### Audit and observability

Every attempted invocation records or correlates, according to the audit durability policy:

- Organization and Secretary Principal;
- initiating Human or System Principal;
- context, assistance operation, and contract version;
- authorization policy and grant version;
- source-reference identifiers without ordinary telemetry content leakage;
- provider/model provenance where applicable;
- generation-operation, correlation, and causation identifiers;
- validation result; and
- whether a Human later adopted the contribution.

Generation and adoption remain distinct audit actions.

### Required verification

Before implementation approval, tests must prove:

- the Secretary Runtime has no Repository, database, ORM, Aggregate, or generic command-dispatch dependency;
- every AI Assistance Port is owned by exactly one context;
- Human-only operations are absent from Secretary-facing interfaces;
- unknown and revoked assistance grants fail closed;
- Organization mismatch is rejected before provider invocation;
- provider output cannot select a command or expand data access;
- generated output alone never changes authoritative state;
- Human adoption re-evaluates current authorization and Aggregate rules; and
- failures and retries do not create duplicate contributions.

## Alternatives considered

### One central Secretary Domain Service

Rejected because it would own knowledge and orchestration belonging to multiple contexts and would become a privileged integration hub.

### Give the Secretary normal module command access and rely only on authorization

Rejected because Human-only operations would remain reachable, configuration mistakes would be high impact, and the interface would not communicate the authority boundary.

### Let each context implement a separate AI identity

Rejected because Principal identity, Organization binding, disablement, and authorization should remain consistent while domain assistance semantics stay context-owned.

### Store all context data in a Secretary memory store

Rejected because it would duplicate authoritative state, create tenant-isolation and deletion risks, and weaken provenance.

## Consequences

Benefits:

- Bounded Contexts retain domain ownership;
- Secretary authority is constrained structurally and by policy;
- adding a new assistance operation requires an explicit context contract and grant;
- tenant and provenance boundaries remain reviewable; and
- future AI Employees can reuse the Principal and port pattern without becoming Members.

Costs:

- each context defines and tests a small assistance port;
- cross-context assistance requires explicit snapshots or coordinators; and
- assistance permission versions must be managed and audited.

## Related documents

- [Architecture Overview](../architecture/overview.md)
- [Context Map](../architecture/context-map.md)
- [Application Services](../architecture/application-services.md)
- [Authorization](../architecture/authorization.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [ADR-0004](0004-separate-external-computation-and-business-effects.md)
- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [ADR-0009](0009-assign-rule-enforcement-responsibilities.md)

