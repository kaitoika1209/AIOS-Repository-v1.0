# AIOS

> **The Operating System for Organizational Intelligence**

AIOS is a next-generation operating system designed to help organizations make better decisions, preserve institutional knowledge, and continuously improve through collaboration between humans and AI.

Unlike traditional work management software, AIOS is built around **Work**, **Decision**, **Memory**, and **Knowledge**. Every completed work contributes to the organization's collective intelligence, enabling future teams to make better decisions with greater confidence.

---

## Vision

Most software helps people manage work.

AIOS helps organizations become smarter.

Its purpose is not simply to complete tasks, but to transform every meaningful decision into reusable organizational knowledge.

---

## Core Concepts

| Concept | Description |
|----------|-------------|
| **Organization** | The company operating inside AIOS |
| **Member** | A human participant who belongs to an Organization and may receive business authority |
| **AI Principal** | A non-human execution identity with governed, non-human authority |
| **Secretary** | The advisory AI Principal assigned to assist an Organization |
| **System Principal** | Trusted internal automation for technical processing |
| **Work** | The central business object of AIOS |
| **Decision** | A formal decision made by a human |
| **Memory** | Organizational experience generated from completed work |
| **Knowledge** | Validated experience that can be reused across the organization |
| **Workflow** | The lifecycle that moves work forward |
| **Capability** | Organizational abilities that grow over time |

---

## Design Principles

AIOS is built on the following principles:

- Everything begins with **Work**.
- AI proposes. Humans decide.
- Every important decision should be explainable.
- Organizational knowledge is a living asset.
- Every completed work should improve future work.

---

## Project Status

AIOS is in early implementation. The **MVP loop runs end to end**: create Work,
record a blocking Decision, complete the Work, and have a human review and
approve the resulting organizational Memory — browser to HTTP API to PostgreSQL,
with the Outbox carrying the asynchronous steps.

Organizations are created through the API: `POST /organizations` takes a name
and nothing else, and brings the Organization and its first Owner Membership
into existence in one transaction. That route holds no permission and needs no
`X-Organization-Id` — the caller cannot be a Member of something that does not
exist yet — so authority is being an authenticated, Active Human Identity.

Members then join through the invitation flow: an Owner or Admin invites an
address, a single-use token is issued, and accepting it is what creates the
Membership that carries authority. An Owner or Admin can also suspend,
reactivate, or revoke a Member, and the last active Owner cannot be removed.

Memory generation calls Anthropic when `ANTHROPIC_API_KEY` is set, and a
deterministic generator when it is not — so the whole loop runs on a laptop with
no provider account. Either way the provider response is untrusted candidate
content until it passes local validation (ADR-0004): a draft asserting a figure,
date, identifier, or name the Work never recorded is discarded and never reaches
a reviewer. See [Memory Generation Policy](docs/architecture/memory-generation-policy.md).

Authentication is Clerk (ADR-0013). Set `CLERK_JWT_KEY` — the PEM public key
from the Clerk dashboard, which verifies sessions without a network call — or
`CLERK_SECRET_KEY` to fetch the JWKS instead. `CLERK_AUTHORIZED_PARTIES` is a
comma-separated list of frontend origins permitted to mint a session.

With neither set, the API falls back to a development header adapter that
verifies nothing, and it refuses to start that way unless `NODE_ENV` is
`development` or `test`. Clerk authenticates only: Organization, Membership,
roles, and invitations stay in PostgreSQL, and Clerk Organizations are not used.

The Secretary prepares Decision material on request (ADR-0011). It is advisory
and structurally so: the port exposes one typed operation, an active
Organization grant must authorize it, the output is stored as an attributable
contribution, and adopting it is the Human's own `PATCH` — the Secretary never
writes authoritative content. `/me` is the Personal Workspace: assigned Work,
Work waiting on a Decision, and — for a Reviewer — Memory awaiting review.

In-app notifications are live. A registered Projection Consumer turns events
into a Member's attention list — Work assigned to you, a Decision or Memory
waiting for review, an outcome affecting Work you took part in — and the whole
table is rebuildable from the Outbox, which is why it is the one consumer whose
result may be skipped.

Invitation delivery is not built. Sending email is an `ExternalBusinessEffect`,
which the events architecture places outside the baseline MVP until an External
Effect Contract exists — so an invitation token is shown once in the UI and
delivered by hand.

Current progress:

- ✅ Product Vision
- ✅ Domain Architecture
- ✅ Technical Specification
- 🚧 Foundation Development — Work → Decision → Memory, end to end

Current objective:

> Build the first MVP that demonstrates AI-assisted organizational workflows.

The authoritative definition of what the MVP includes is
[`docs/product/mvp.md`](docs/product/mvp.md). When this README and an authoritative
document disagree, the authoritative document wins — see
[Document Governance](docs/document-governance.md).

---

## Repository Structure

The target layout is defined in
[`docs/engineering/folder-structure.md`](docs/engineering/folder-structure.md).

```text
.
├── apps/
│   ├── api/           NestJS, ADR-0014 routes, Outbox worker
│   └── web/           Next.js, minimal Work, Decision, and Memory UI
├── packages/
│   ├── types/         shared vocabulary and catalogues
│   ├── domain/        Work and Decision aggregates, no framework
│   ├── application/   use cases, ports, permission evaluation
│   └── persistence/   PostgreSQL adapters (ADR-0015)
├── services/          (planned)
├── infra/             (planned)
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── engineering/
│   └── adr/
├── scripts/
└── README.md
```

---

## Getting Started

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
```

Documentation structure is verified separately:

```bash
pnpm run check:docs
```

Copy [`.env.example`](.env.example) to `.env` before running the applications.

To run the whole slice against a local PostgreSQL database:

```bash
python3 scripts/extract_schema.py          # documented DDL → build/schema.sql
psql "$DATABASE_URL" -f build/schema.sql
pnpm --filter @aios/api seed               # one Organization and its Owner
pnpm --filter @aios/api dev                # API on :3001
pnpm --filter @aios/web dev                # UI on :3000
```

The seed creates one Organization, its first Owner (Olivia), and the Secretary,
so the loop is runnable immediately — the same shape `POST /organizations`
produces. **Everyone else joins by invitation.** Sign in
as Olivia, open **Members**, invite Alice as a `Member` and Raj as a `Reviewer`,
then switch identity and accept each invitation.

That detour is the point. Before accepting, Alice authenticates but resolves to
no principal at all, so every route refuses her — an invitation grants no
authority until someone accepts it. After accepting, she holds exactly the roles
the invitation named.

The UI has an identity switcher because authority differs by role. Alice can
create Work, complete it, and correct a generated Memory draft. Raj is the only
one who can approve a Decision or a Memory. Switching between them is how the
human-authority boundary becomes visible — including that the Secretary drafts a
Memory but can never approve its own draft.

The invitation token is shown once in the UI because nothing delivers it. A
`MembershipInvited` consumer that sent email would be an `ExternalBusinessEffect`
consumer, which the MVP Side-Effect Scope table lists as out of the baseline
until an External Effect Contract, adapter, security review, runbook, metrics,
and tests exist. The consumer registry refuses to enable one, so this is an
absence the code enforces rather than a task nobody has reached. Only the
token's hash is ever stored.

Generation quality is evaluated rather than proven. Fixture cases run in CI with
no credential; the live half needs one:

```bash
ANTHROPIC_API_KEY=... pnpm --filter @aios/api evaluate
```

Database-backed tests are skipped unless `DATABASE_URL` is set, so
`pnpm run test` stays runnable without a database.

---

## Documentation

| Directory | Description |
|-----------|-------------|
| [`docs/product`](docs/product) | Product vision, roadmap, and MVP scope |
| [`docs/architecture`](docs/architecture) | Domain model and system architecture |
| [`docs/engineering`](docs/engineering) | Engineering standards and conventions |
| [`docs/adr`](docs/adr) | Architecture Decision Records |
| [`docs/glossary.md`](docs/glossary.md) | Canonical domain vocabulary |
| [`docs/document-governance.md`](docs/document-governance.md) | Which document wins when documents disagree |

`docs/api` is not yet created. API specifications are a Phase 5 deliverable
(see [Roadmap](docs/product/roadmap.md)).

---

## Technology Stack

See [`docs/engineering/tech-stack.md`](docs/engineering/tech-stack.md) for the rationale
behind each choice.

| Layer | Technology |
|--------|------------|
| Frontend | Next.js (App Router) + TypeScript |
| UI | Tailwind CSS + shadcn/ui |
| Backend | NestJS |
| Database | PostgreSQL |
| Database Access | `pg` with hand-written SQL (ADR-0015) |
| AI Runtime | LangGraph |
| Model Provider | OpenAI (the application remains provider-agnostic) |
| Authentication | Clerk |
| Infrastructure | AWS (ECS, RDS, S3, CloudFront) |
| Monorepo | Turborepo |
| Package Manager | pnpm |
| Testing | Vitest + Playwright |
| Code Quality | ESLint + Prettier |

---

## Roadmap

This is a summary. [`docs/product/roadmap.md`](docs/product/roadmap.md) is authoritative.

| Phase | Name | Primary Outcome |
|---:|---|---|
| 1 | Foundation — MVP | Human-approved organizational Memory from completed Work |
| 2 | Structured Collaboration | Repeatable workflows and stronger team coordination |
| 3 | AI Organization | Multiple governed AI Principals working with humans |
| 4 | Organizational Intelligence | Approved experience transformed into reusable Knowledge and Capability |
| 5 | Platform and Ecosystem | Stable extension model for developers, partners, and integrations |

### Phase 1 — Foundation (MVP)

- Identity and Organization
- Workspace (presentation views)
- Work
- Decision
- **Secretary** — one advisory Secretary per Organization
- **Memory** — generation, human review, and approval

Phase 1 ends at Approved Memory. Knowledge promotion is **not** part of the MVP.

### Phase 2 — Structured Collaboration

- Work templates and repeatable patterns
- Dependencies, milestones, and checklists
- Team coordination and review queues

### Phase 3 — AI Organization

- AI Employees as governed AI Principals
- Delegated execution boundaries
- Multi-principal collaboration

### Phase 4 — Organizational Intelligence

- Knowledge promotion from Approved Memory
- Evidence
- Capability

### Phase 5 — Platform and Ecosystem

- Public API
- SDK
- Plugin system and Marketplace

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow, coding standards,
and review expectations.

For architectural changes, please create or update an Architecture Decision Record (ADR)
in [`docs/adr`](docs/adr) before implementation.

---

## License

License information will be added before the first public release.
