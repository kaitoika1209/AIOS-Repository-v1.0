# ADR-0010: Classify Blueprint Scope and Implementation Authority

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1

## Context

AIOS intentionally documents a long-term learning cycle beyond the MVP. Knowledge, Evidence, Capability, AI Employees, External Knowledge Sources, and Semantic Search are useful architectural hypotheses because they protect terminology and future boundaries.

Detailed future models can nevertheless be mistaken for approved implementation scope. A state machine, command name, event name, table-shaped example, or normative word such as `must` may cause a small implementation team to create placeholder modules, unused ports, speculative schemas, or event contracts before the corresponding product behavior has been validated.

The architecture therefore needs one classification model that distinguishes current implementation authority from future design exploration.

## Decision

### Every architecture artifact has one scope classification

| Classification | Meaning | Implementation authority |
|---|---|---|
| MVP Normative | Required to implement, secure, test, operate, or explicitly exclude for the current MVP | Yes, subject to the authoritative-document hierarchy |
| Reserved Extension Point | A present MVP contract deliberately leaves a bounded place for compatible evolution | Only the present generic contract; no future feature implementation |
| Future Hypothesis | A candidate future domain model, lifecycle, policy, or technical direction that requires later validation | No |
| Explicitly Out of Scope | A capability the MVP must not depend on or implement | No |

`Deferred`, `future`, `Blueprint`, and `not implemented` are descriptive words, not additional classifications.

### MVP Normative

An MVP Normative requirement is implementable and verifiable in the current release. Its authoritative source is identified by the document-governance hierarchy defined in [Document Governance](../document-governance.md).

The MVP Normative domain slice ends at Human-reviewed Memory. It includes Organization-scoped Human Membership, Secretary assistance, Work, Decision, Work-to-Memory generation, Memory review, authorization, persistence, reliable local event processing, audit, tenant isolation, and the minimum production baseline accepted for the MVP.

### Reserved Extension Point

A Reserved Extension Point exists only when the MVP needs a stable generic seam now and the seam has a current consumer or protects a current compatibility guarantee.

Examples may include:

- versioned event envelopes;
- provider-neutral AI computation ports used by MVP Memory generation;
- opaque identifiers and provenance fields required by current records; and
- module interfaces that already serve an MVP use case.

A Reserved Extension Point does not authorize:

- an empty Knowledge, Capability, AI Employee, or search module;
- speculative tables, queues, handlers, repositories, routes, or UI;
- future enum values registered only for anticipation;
- future event types in the MVP event catalog; or
- generic abstractions without an MVP caller and test.

### Future Hypothesis

Knowledge, Evidence, Capability, AI Employees, External Knowledge Sources, Semantic Search, Knowledge Graphs, cross-Organization sharing, and autonomous execution are Future Hypotheses unless a later accepted ADR promotes a bounded slice.

Detailed Future Hypothesis documents may constrain the review of a future design, but they do not constrain MVP code. Normative words in such a document mean “required if this hypothesis is later adopted,” not “required now.”

Future commands, events, states, interfaces, schemas, and provider choices are illustrative until all of the following exist:

- validated product need and phase scope;
- accepted Bounded Context and Aggregate boundaries;
- authorization and Human-authority rules;
- persistence and event contracts;
- operational and migration implications;
- an accepted implementation ADR; and
- updates to the MVP or successor release-scope document.

### Explicitly Out of Scope

An Explicitly Out-of-Scope capability must not be required by any MVP acceptance criterion, transaction, event handler, deployment, migration, test fixture, or operational runbook.

The MVP must remain complete when all future capability flags, modules, and infrastructure are absent.

### Promotion rule

A concept moves from Future Hypothesis to MVP Normative or a later release's normative scope only through an accepted ADR and an authoritative scope-document update. Editing a future design document alone cannot promote implementation authority.

Promotion must identify the smallest useful vertical slice. It must not activate every concept described in the future model by default.

### Document header rule

Every future-focused architecture artifact states:

```text
Scope classification: Future Hypothesis
MVP implementation authority: None
Promotion requirement: Accepted implementation ADR and scope-document update
```

Mixed-scope documents must label sections or tables so readers can distinguish classifications without inference.

### Review and enforcement

Before implementation approval, reviewers verify that:

- every planned item traces to an MVP Normative requirement;
- each Reserved Extension Point has a current MVP use and test;
- no Future Hypothesis creates a mandatory dependency;
- no Explicitly Out-of-Scope artifact is included in migrations or deployment; and
- future names are absent from authoritative MVP event and command catalogs unless explicitly marked illustrative.

## Alternatives considered

### Remove all future architecture

Rejected because Memory/Knowledge separation, Human authority, provenance, and future context boundaries benefit from early conceptual clarity.

### Keep future documents without a classification system

Rejected because detail and normative wording would continue to imply implementation readiness.

### Implement placeholder modules for every future context

Rejected because placeholders create coupling, unused contracts, migrations, and maintenance cost without validated behavior.

### Treat the roadmap as implementation approval

Rejected because the roadmap is directional and cannot replace a release-scope document and implementation ADR.

## Consequences

Benefits:

- the MVP remains small enough for a one-to-three-person team;
- future domain thinking is preserved without creating current dependencies;
- reviewers can distinguish architectural intent from implementation authority;
- speculative abstractions and event contracts are easier to reject; and
- promotion of future capabilities becomes explicit and auditable.

Costs:

- mixed-scope documents require visible classification;
- future documents may contain detailed rules that are intentionally non-binding for the MVP; and
- each future phase requires deliberate promotion work rather than relying on old Blueprint prose.

## Related documents

- [Document Governance](../document-governance.md)
- [Architecture Overview](../architecture/overview.md)
- [Domain Model](../architecture/domain-model.md)
- [MVP Domain Model](../architecture/mvp-domain-model.md)
- [Context Map](../architecture/context-map.md)
- [MVP Scope](../product/mvp.md)
- [Product Roadmap](../product/roadmap.md)
- [Knowledge Aggregate](../architecture/aggregates/knowledge.md)
- [Knowledge State Machine](../architecture/state-machines/knowledge.md)
