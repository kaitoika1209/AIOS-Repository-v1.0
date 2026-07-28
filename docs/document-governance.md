# Document Governance

> **Scope classification:** MVP Normative  
> **MVP implementation authority:** Yes — this document governs how authority is resolved  
> **Promotion requirement:** Changes require an accepted ADR

## Purpose

This document defines the **document-governance hierarchy** referenced by
[ADR-0010](adr/0010-classify-blueprint-scope-and-implementation-authority.md).

ADR-0010 establishes that every architecture artifact carries a scope classification and
that MVP Normative requirements have an authoritative source "identified by the
document-governance hierarchy." This document is that hierarchy.

It answers one question:

> When two documents in this repository disagree, which one is correct?

---

## Authority Hierarchy

Documents are ranked. A higher-ranked document always wins over a lower-ranked one.

| Rank | Document class | Location | Authority |
|---:|---|---|---|
| 1 | Accepted ADRs | `docs/adr/` | Decisions. Override everything below. |
| 2 | Release scope | `docs/product/mvp.md` | What is in and out of the current release. |
| 3 | Normative architecture | `docs/architecture/` | How MVP Normative behavior must be built. |
| 4 | Engineering standards | `docs/engineering/` | How code is written and reviewed. |
| 5 | Product direction | `docs/product/roadmap.md`, `docs/product/vision.md`, `docs/product/mvp-use-cases.md` | Intent and sequencing. Not implementation authority. |
| 6 | Orientation | `README.md`, `CONTRIBUTING.md`, `docs/glossary.md` | Summaries and vocabulary. Never authoritative on scope. |

### Rank 1 — Accepted ADRs

An ADR with `**Status:** Accepted` is the highest authority in the repository. A later
Accepted ADR supersedes an earlier one; the superseded ADR must be marked
`**Status:** Superseded by ADR-XXXX` rather than deleted.

An ADR with any status other than `Accepted` carries **no** authority.

### Rank 2 — Release scope

`docs/product/mvp.md` is the single authoritative statement of what the current release
includes, excludes, and classifies. Its scope classification table is definitive.

No document below this rank may expand MVP scope. A use case, roadmap entry, or README
bullet describing behavior absent from `mvp.md` is an error in that document.

### Rank 3 — Normative architecture

Architecture documents define how MVP Normative behavior must be implemented. They bind
implementation but cannot introduce scope that `mvp.md` excludes.

Where two architecture documents overlap, the one that **owns** the subject wins:

| Subject | Owning document |
|---|---|
| Persistence, schema, concurrency | `architecture/persistence-and-data-model.md` |
| Events, Outbox, delivery, ordering | `architecture/events-and-outbox.md` |
| Identity, Organization, membership | `architecture/identity-and-organization.md` |
| Permissions, authority, tenant isolation | `architecture/authorization.md` |
| Application service boundaries | `architecture/application-services.md` |
| Observability, operations, incidents | `architecture/observability-and-operations.md` |
| Aggregate invariants | `architecture/aggregates/<name>.md` |
| Lifecycle and transitions | `architecture/state-machines/<name>.md` |
| Context boundaries and relationships | `architecture/context-map.md` |

`architecture/overview.md` and `architecture/domain-model.md` are introductory. Where
they disagree with an owning document, the owning document wins.

### Rank 5 — Product direction

Roadmap, vision, and use-case documents express intent. Per ADR-0010, the roadmap is
directional and is **not** implementation approval.

### Rank 6 — Orientation

The README and glossary exist to orient readers. They summarize; they never decide. A
README statement conflicting with `mvp.md` is a README bug.

---

## Scope Classification Precedence

Authority rank and scope classification are independent axes. Both must be satisfied.

A requirement is implementable only when **both** hold:

1. its scope classification is `MVP Normative`; and
2. it appears in — or is consistent with — the highest-ranked document addressing it.

A `MUST` inside a `Future Hypothesis` document is not binding on MVP code. Per ADR-0010 it
means "required if this hypothesis is later adopted."

---

## Resolving a Conflict

1. Identify each document's rank and scope classification.
2. Apply the higher rank. Within rank 3, apply subject ownership.
3. Confirm the winning statement is classified `MVP Normative` before implementing.
4. **Fix the losing document.** A resolved conflict that is left in place will be
   rediscovered as a real contradiction later.
5. If the conflict is a genuine decision rather than an editing error, raise an ADR.

Conflicts are defects. Silently working around one is not resolution.

---

## Required Document Header

Per ADR-0010, every architecture and product artifact states its classification near the
top:

```text
Scope classification: <MVP Normative | Reserved Extension Point | Future Hypothesis | Explicitly Out of Scope | Mixed>
MVP implementation authority: <Yes | None | qualified statement>
Promotion requirement: <Accepted implementation ADR and scope-document update | Not applicable>
```

Mixed-scope documents must additionally label sections or tables so a reader can
determine classification without inference.

ADRs are exempt from the scope header. They instead carry the metadata block defined
below.

---

## Required ADR Metadata

Every ADR begins with:

```text
**Status:** <Proposed | Accepted | Superseded by ADR-XXXX | Rejected>
**Date:** YYYY-MM-DD
**Blueprint Version:** X.Y.Z
```

`Status` is required because ADR-0010 makes accepted ADRs the sole mechanism for
promoting a Future Hypothesis into implementable scope. An ADR without a status cannot
promote anything.

---

## Enforcement

The checks below are mechanical and run in CI (`.github/workflows/docs.yml`):

- every relative Markdown link resolves;
- every ADR declares `Status`, `Date`, and `Blueprint Version`;
- every document under `docs/architecture/` and `docs/product/` declares a scope classification;
- each Markdown file has exactly one H1.

Judgment-based checks belong to review — see
[`engineering/review-checklist.md`](engineering/review-checklist.md).

---

## Related Documents

- [ADR-0010: Classify Blueprint Scope and Implementation Authority](adr/0010-classify-blueprint-scope-and-implementation-authority.md)
- [MVP Scope](product/mvp.md)
- [Review Checklist](engineering/review-checklist.md)
- [Glossary](glossary.md)
