# ADR-0005: Adopt a Boundary-Enforced Modular Monolith for the MVP

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1  
**Decision Owner:** Platform Architecture  
**Review Trigger:** before extracting any module into an independently deployed service, before introducing a second authoritative database or internal network boundary, when module-boundary tests cannot prevent recurring coupling, or when measured scaling, reliability, regulatory, deployment-cadence, or team-ownership requirements materially change

---

## Context

AIOS is an early enterprise product intended to be implemented and operated by a team of one to three people.

Its MVP must preserve:

- explicit DDD Bounded Contexts;
- Human authority over Work, Decision, and Memory;
- PostgreSQL as the authoritative data store;
- durable asynchronous processing through the Transactional Outbox;
- Organization isolation;
- recoverable background processing; and
- a credible path to future extraction when justified.

Deploying one service per Bounded Context would add network failure modes, distributed tracing requirements, contract deployment coordination, multiple data stores, additional infrastructure, and higher operational load before the product has demonstrated a need for them.

A conventional unstructured monolith would reduce initial infrastructure but allow presentation code, Workers, repositories, tables, and domain models to become mutually dependent. That coupling would weaken Aggregate boundaries and make later change or extraction expensive.

AIOS therefore needs one deployable architecture with enforceable internal boundaries.

---

## Decision

The MVP adopts a boundary-enforced Modular Monolith backed by one authoritative PostgreSQL database.

The system is versioned and released as one application. The HTTP Application and Background Workers may run:

- in one process; or
- as separate process roles built from the same versioned codebase.

Separate process roles do not become independently versioned services and do not communicate through private internal network APIs.

The MVP implementation modules are:

~~~text
Organization and Access
Work and Decision
Organizational Learning
Platform Runtime
~~~

Knowledge Management and Capability Management are future Bounded Contexts. The MVP creates no placeholder modules, tables, handlers, or public ports for them.

---

## Semantic Boundaries and Packaging Boundaries

A DDD Bounded Context is a semantic boundary that owns business language, rules, and models.

An implementation module is a code, dependency, migration, and persistence-ownership boundary.

They are not interchangeable.

One implementation module may contain more than one Bounded Context when co-location reduces operational cost and a concrete use case benefits from local coordination. Co-location does not merge:

- Aggregates;
- Aggregate invariants;
- Ubiquitous Language;
- repository ownership;
- state machines; or
- authority.

In the MVP, Work Management and Decision Management remain separate Bounded Contexts inside the `Work and Decision` implementation module.

Platform Runtime is a technical module. It owns Outbox, Worker claims, processed-operation state, dead letters, replay, reconciliation, and projection infrastructure. It owns no Human business authority and no Domain Aggregate lifecycle.

Authorization is an Application and Security capability. It may evaluate trusted facts but does not own or mutate another context's Aggregate lifecycle.

---

## Module Interface Contract

Each business module exposes explicit Application command and query interfaces.

A caller from Presentation, a Worker, a scheduler, Platform Runtime, or another module must enter through the owning module's Application interface.

The following are prohibited across implementation module boundaries:

- importing or invoking another module's Repository;
- loading another module's Aggregate for mutation;
- directly updating another module's tables;
- exposing ORM entities, database connections, or unrestricted query builders;
- using a generic repository or global Unit of Work as a service locator;
- importing internal Domain Events as cross-context contracts;
- sharing mutable domain objects; and
- creating an unowned common business package.

Repository ports remain internal to the owning Aggregate and module. An adapter may implement a port, but that port is not an integration API.

Synchronous cross-module reads use a narrow query interface returning an immutable DTO or snapshot. A query result is informational and cannot become a hidden mutation path or duplicate the source module's lifecycle rules.

Asynchronous cross-context communication uses stable, versioned Integration Events. A producing context maps internal Domain Events to Integration Events before durable Outbox persistence.

A minimal shared technical kernel may contain identifiers, time abstractions, transaction metadata, correlation metadata, and versioned envelope primitives. It must not contain business lifecycle rules or become a default home for disputed ownership.

---

## Dependency Direction

The permitted execution direction is:

~~~text
Presentation or Worker
        |
        v
Owning Module Application Interface
        |
        v
Application Service
        |
        v
Owning Domain Model
        |
        v
Repository Port
        ^
        |
Infrastructure Adapter
~~~

Platform Runtime dispatches work to a registered module Application interface. It must not receive a business module Repository or inspect domain tables to decide business outcomes.

Infrastructure depends on module-owned ports and contracts. Domain code does not depend on HTTP, Worker, PostgreSQL, ORM, telemetry vendor, event broker, or AI-provider implementations.

Module dependency cycles are prohibited. If two modules require bidirectional interaction, the design must use:

- separate directional Application interfaces;
- an Integration Event in one direction;
- an explicit orchestration owner; or
- a new ADR if a true atomic exception is required.

---

## Transaction Boundary

An Application Service owns the transaction boundary.

A normal Application Service loads and saves only Aggregates whose repositories are owned by its implementation module.

Inside one implementation module, a specifically documented use case may coordinate multiple Aggregates or Bounded Contexts in one PostgreSQL transaction when one atomic invariant or relationship establishment requires it.

The MVP `RequestBlockingDecision` use case is permitted to coordinate Work and Decision repositories because both contexts are co-located and their initial relationship must commit atomically. This permission is use-case-specific and must not become a general cross-context Unit of Work.

Atomic coordination across implementation module boundaries is prohibited unless a later accepted ADR documents:

- the exact invariant that cannot tolerate eventual consistency;
- the participating modules and repositories;
- why an owning-module command or durable event is insufficient;
- failure and lock-contention analysis;
- migration and extraction consequences; and
- tests that prevent the exception from expanding.

Technical records required for correctness may participate in the owning Application transaction through narrow Platform Runtime ports. These include:

- Transactional Outbox records;
- processed-command or processed-event records;
- required audit records; and
- operation or reconciliation evidence.

This participation does not authorize Platform Runtime to mutate Domain Aggregate tables or determine Human business outcomes.

Remote provider calls and other external effects occur outside PostgreSQL transactions.

---

## Persistence Ownership

The MVP uses one authoritative PostgreSQL database.

Logical table and migration ownership by implementation module is mandatory. Physical PostgreSQL schemas are optional for the MVP when they do not materially increase deployment complexity.

At minimum:

- table names reveal ownership;
- migrations are grouped and reviewed by owning module;
- repositories access only owned tables for mutation;
- database roles or schema permissions may reinforce ownership when practical;
- direct cross-module updates are rejected;
- cross-Organization constraints are enforced; and
- PostgreSQL remains the source of authoritative state.

Cross-module foreign keys and joins are not automatically prohibited. They may be used when they materially strengthen tenant isolation, historical integrity, or referential correctness in the single-database MVP.

However:

- the source module remains authoritative for its lifecycle;
- a foreign key does not grant mutation ownership;
- a join used for reporting or validation cannot become an authoritative cross-module write path; and
- an extraction proposal must account for replacing cross-module database constraints and reads.

Read models and projections may combine data from multiple modules, but they are non-authoritative and cannot enforce Domain Aggregate invariants.

---

## Event and Worker Contract

PostgreSQL Outbox records provide the durable boundary for required asynchronous reactions.

The Modular Monolith may dispatch messages in process, through separate Worker process roles, or through multiple replicas. Delivery semantics remain at least once.

Consumers must be:

- idempotent;
- Organization-scoped;
- version-aware;
- recoverable;
- observable; and
- fenced where concurrent or leased processing can occur.

An external broker is not required for the MVP. Introducing one must not change Aggregate behavior or make the broker authoritative for committed business state.

Because Outbox messages and Worker backlog may survive a deployment, Integration Event and operation contracts require compatibility across rolling or overlapping process versions even though the application is released as one unit.

---

## Boundary Enforcement

Implementation approval requires automated architecture checks appropriate to the selected language and framework.

At minimum, CI must detect:

- forbidden imports between module internals;
- cross-module Repository dependencies;
- infrastructure imports from Domain code;
- migrations placed outside an owning module;
- duplicate ownership of an event contract;
- unregistered Integration Event consumers; and
- dependency cycles.

Tests must also verify:

- a cross-module caller uses the owning Application interface;
- Platform Runtime cannot load business Aggregates;
- `RequestBlockingDecision` remains the only approved Work/Decision atomic coordinator unless another exception is accepted;
- Outbox persistence occurs atomically with required state changes; and
- Organization isolation holds across module interfaces and event handlers.

These checks are part of the definition of done, not optional documentation guidance. The exact tooling may remain language-specific.

---

## Operational Consequences

A single application release and database reduce MVP deployment and on-call complexity.

The tradeoff is a shared failure and resource-contention domain. One module can consume database connections, CPU, memory, or Worker capacity needed by another module.

Mitigations include:

- per-process-role concurrency limits;
- database connection budgets;
- bounded Worker queues and leases;
- module and consumer labels in logs, metrics, and traces;
- query and lock observability;
- circuit breaking for external providers; and
- operational runbooks for degraded Worker roles.

A Worker role may be scaled independently at runtime while remaining part of the same versioned Modular Monolith. Independent runtime scaling alone is not service extraction.

---

## Extraction Criteria

Module extraction is not a roadmap milestone and is not justified by the existence of a Bounded Context alone.

Extraction requires measured evidence of at least one material need:

- independent scaling that process-role scaling cannot satisfy;
- unacceptable shared blast radius or availability requirements;
- materially different security, regulatory, residency, or retention requirements;
- independent deployment cadence with stable ownership;
- a stable integration contract and data-ownership boundary;
- sustained database contention that cannot be resolved within PostgreSQL; or
- a separate team capable of owning build, deployment, observability, data migration, and on-call responsibility.

Before extraction, a new ADR must define:

- service and data ownership;
- synchronous and asynchronous contracts;
- consistency and failure semantics;
- migration and rollback;
- tenant-isolation enforcement;
- observability and SLO ownership;
- compatibility strategy; and
- operational staffing.

The extracted boundary must not depend on direct table access to the remaining monolith.

---

## Alternatives Considered

### One microservice per Bounded Context

Rejected for the MVP because semantic separation does not require independent deployment. The operational and distributed-systems cost is not justified for a one-to-three-person team.

### Unstructured layered monolith

Rejected because one deployment without enforceable ownership would permit hidden repository, table, and model coupling.

### Multiple repositories and databases from the beginning

Rejected because it increases migration, transaction, testing, observability, backup, and recovery cost before independent ownership is needed.

### External event broker as the internal module boundary

Rejected as an MVP requirement. PostgreSQL Outbox and Workers provide durable asynchronous processing without adding a second authoritative delivery dependency.

### Eventual consistency for every internal interaction

Rejected because local atomic coordination is useful for a small number of explicitly documented use cases inside one implementation module. Requiring asynchronous coordination everywhere would add complexity without improving independence.

### One global transaction across arbitrary modules

Rejected because it would turn one PostgreSQL database into hidden Aggregate and module coupling, enlarge lock scope, and obstruct later extraction.

---

## Consequences

### Positive

- The team operates one release and one authoritative database.
- DDD boundaries remain explicit without premature distribution.
- Local ACID transactions remain available for narrow, documented cases.
- Durable events preserve failure recovery and future integration options.
- Module extraction remains possible because repositories and mutation paths are not shared.
- MVP infrastructure cost remains proportionate to team size.

### Negative

- Architecture boundaries require automated enforcement and disciplined review.
- All modules share a release cadence.
- PostgreSQL and process resources remain shared failure and contention domains.
- Cross-module foreign keys and reads can increase later extraction cost.
- A poorly governed shared technical kernel can recreate monolithic coupling.
- Some interface and event contracts are required before they are externally distributed.

---

## Required Verification

Before implementation approval, verify that:

- every MVP module has explicit owned packages and migrations;
- every cross-module call uses an Application interface or Integration Event;
- Repository and Domain internals are inaccessible across module boundaries;
- transaction exceptions are enumerated and tested;
- Platform Runtime has no business Repository dependencies;
- Worker process roles use the same versioned release;
- Outbox backlog remains compatible across deployment;
- Organization isolation is enforced at every interface;
- architecture checks run in CI; and
- the next extraction decision is evidence-based and recorded by ADR.

---

## Related Documents

- [Architecture Overview](../architecture/overview.md)
- [Context Map](../architecture/context-map.md)
- [Application Services](../architecture/application-services.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [Events and Outbox](../architecture/events-and-outbox.md)
- [Authorization](../architecture/authorization.md)
- [MVP Scope](../product/mvp.md)
- [Product Roadmap](../product/roadmap.md)
