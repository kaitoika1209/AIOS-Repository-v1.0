# Review Checklist

## Architecture

- Domain responsibilities are respected.
- No layer violations.
- Dependencies point inward.
- The change has one owning module and does not expose Aggregates, repositories, ORM entities, or unrestricted database access across modules.
- Controllers and Workers use the owning Application Service.

---

## Code Quality

- Naming follows project conventions.
- No duplicated logic.
- Methods remain focused.
- Code is easy to understand.

---

## Domain

- Business logic belongs in the domain.
- Aggregates remain consistent.
- Domain events are used appropriately.
- Human-authoritative actions remain Human-only; Decision approval does not complete Work.
- Approved Memory remains immutable and is not treated as Knowledge.

---

## Transactions and Events

- Transaction and idempotency boundaries are explicit.
- Aggregate mutation, required audit, Outbox, and command idempotency commit together where required.
- No network or AI-provider call occurs inside a PostgreSQL transaction.
- Event handlers are idempotent, Organization-scoped, fenced where leased, and have a visible failure/recovery path.

---

## Testing

- Unit tests added where appropriate.
- Existing tests continue to pass.
- Edge cases considered.
- Foreign-Organization, unauthorized-principal, duplicate, concurrent, rollback, and retry cases are covered where applicable.
- PostgreSQL constraints and repositories are tested against PostgreSQL rather than an in-memory substitute.

---

## Documentation

- Documentation updated if necessary.
- ADR created when architecture changes.

---

## Security

- No secrets committed.
- Input validation performed.
- Authorization considered where applicable.
- Actor and Organization context come from trusted server-side resolution, not request or provider claims alone.
- Logs, metrics, traces, events, prompts, and errors omit secrets and prohibited tenant content.
- Database, provider, and support access remain least-privileged and auditable.
