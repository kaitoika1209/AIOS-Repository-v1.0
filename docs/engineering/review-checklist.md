# Review Checklist

This checklist is applied to every Pull Request. The scope section is derived from
[ADR-0010](../adr/0010-classify-blueprint-scope-and-implementation-authority.md) and is
not optional — it is the control that keeps the MVP small enough to finish.

---

## Scope and Implementation Authority

Verify before approving:

- [ ] Every changed item traces to an **MVP Normative** requirement in an authoritative document.
- [ ] Each new **Reserved Extension Point** has a current MVP caller *and* a test. Generic abstractions without an MVP consumer are rejected.
- [ ] No **Future Hypothesis** has become a mandatory dependency of MVP code.
- [ ] No **Explicitly Out-of-Scope** artifact appears in migrations, deployment, fixtures, or runbooks.
- [ ] Future names do not appear in the MVP event or command catalogs unless explicitly marked illustrative.
- [ ] The MVP still works with every future capability flag, module, and service absent.

If the change requires promoting a Future Hypothesis, an accepted ADR **and** an update to
`docs/product/mvp.md` must land first. Editing a future design document does not grant
implementation authority.

---

## Architecture

- [ ] Domain responsibilities are respected.
- [ ] No layer violations.
- [ ] Dependencies point inward.
- [ ] Module boundaries are not bypassed (ADR-0005).
- [ ] No cross-context God Component; AI assistance goes through context-owned ports (ADR-0011).

---

## Domain

- [ ] Business logic belongs in the domain.
- [ ] Aggregates remain consistent; one Aggregate per transaction.
- [ ] Domain events are used appropriately and published via the Outbox (ADR-0006).
- [ ] Each enforced rule has an explicit enforcement owner (ADR-0009).

---

## Human Authority

- [ ] No AI Principal can approve, reject, complete Work, or grant permissions.
- [ ] Approved historical records remain immutable.
- [ ] The acting principal is auditable for every state change.

---

## Code Quality

- [ ] Naming follows project conventions.
- [ ] No duplicated logic.
- [ ] Methods remain focused.
- [ ] Code is easy to understand.

---

## Testing

- [ ] Unit tests added where appropriate.
- [ ] Existing tests continue to pass.
- [ ] Edge cases considered.
- [ ] Retry and idempotency paths are tested where processing is asynchronous.

---

## Documentation

- [ ] Documentation updated if necessary.
- [ ] ADR created when architecture changes.
- [ ] New docs carry a scope classification header.
- [ ] No contradiction introduced against a higher-ranked document (see [Document Governance](../document-governance.md)).

---

## Security

- [ ] No secrets committed.
- [ ] Input validation performed.
- [ ] Authorization considered where applicable.
- [ ] Organization scoping enforced; no query can cross a tenant boundary.
