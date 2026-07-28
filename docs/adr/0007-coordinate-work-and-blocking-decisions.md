# ADR-0007: Coordinate Work and Blocking Decisions with Atomic Activation and Asynchronous Outcomes

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.1

## Context

Work Management owns the Work lifecycle and Completion Gate. Decision Management owns Decision content, revisions, submitted snapshots, review, and outcomes. The two Bounded Contexts are implemented in one `Work and Decision` module for the MVP, but their Aggregate boundaries remain separate.

The platform must prevent two invalid committed states:

- Work waits for a blocking Decision revision that does not exist or has not been submitted; and
- a submitted blocking Decision revision exists without the related Work recording the same active blocking reference.

After review, however, Work and Decision do not need to change atomically. A Decision outcome is authoritative even while Work temporarily retains a Pending Completion Gate. The design must tolerate that delay, duplicate delivery, stale revisions, cancellation races, and worker failure without allowing Decision approval to complete Work.

## Decision

### Separate authorities

- Decision is authoritative for its lifecycle, revision number, immutable submitted snapshot, and Human review outcome.
- Work is authoritative for its lifecycle, active blocking reference, local Completion Gate, and explicit completion.
- An authorized Human Member is the only authority that may submit or resolve a Decision and complete or cancel Work.
- A System Principal may apply an already-authoritative Decision outcome to Work. It cannot originate that outcome or complete Work.

### Blocking Decision reference

The cross-Aggregate business key is:

```text
BlockingDecisionReference
- decisionId
- revisionNumber
- submittedSnapshotId
```

`decisionId` alone is insufficient because a rejected or withdrawn Decision may later have a new revision. Work must match all three values before applying an outcome.

### Atomic activation is the only MVP Work/Decision transaction exception

`RequestBlockingDecision` is the only approved MVP use case that mutates both Work and Decision in one transaction. It may either create a new Decision or use the active Draft revision of an existing rejected or withdrawn Decision.

Within one PostgreSQL transaction, the Application Service must:

1. authenticate and authorize the Human Member;
2. load Work and validate Organization scope;
3. create Decision when required, or load the existing Decision with its expected version;
4. call `Decision.SubmitForReview`, creating an immutable submitted snapshot and changing the blocking Decision to `InReview`;
5. call `Work.RequestBlockingDecision` with the resulting `BlockingDecisionReference`;
6. persist both Aggregate versions, all Domain and Integration Event records, command idempotency, and required audit evidence; and
7. commit once or roll back everything.

A Draft Decision never places Work in `WaitingForDecision`. An `InReview` blocking Decision and Work's Pending reference become visible together. Non-blocking Decision submission does not use this coordinator and does not change Work.

This transaction is permitted only because both Bounded Contexts are co-located in one implementation module and one authoritative PostgreSQL database. A service split requires a superseding ADR with durable coordination, compensation, recovery visibility, and equivalent invariants.

### Asynchronous outcome propagation

Approval, rejection, and withdrawal each commit only the Decision Aggregate, its outcome Domain Event, and `Integration / DecisionOutcomeOccurred / 1` in the Transactional Outbox.

The Work handler later:

1. validates the event envelope, Organization, Human-authoritative source actor, and routing identifiers;
2. checks technical idempotency by consumer registration and source event identifier;
3. loads Work with its expected version;
4. matches `decisionId`, `revisionNumber`, and `submittedSnapshotId` against the active Pending reference;
5. invokes `Work.RecordDecisionOutcome` rather than editing fields directly; and
6. atomically saves Work, `WorkDecisionOutcomeRecorded`, processed-event state, and required audit evidence.

The handler does not load Decision and never invokes `CompleteWork`.

### Completion Gate semantics

Work stores two distinct concepts:

- `activeBlockingDecisionReference`: present only while the Work is waiting for an unresolved submitted revision; and
- `completionGate`: the current local evidence used to guard completion.

The state changes are:

```text
Request accepted:
    Work = WaitingForDecision
    active reference = BlockingDecisionReference
    gate = Pending(BlockingDecisionReference)

Approved outcome recorded:
    Work = InProgress
    active reference = null
    gate = Satisfied(BlockingDecisionReference, outcome evidence)

Rejected or Withdrawn outcome recorded:
    Work = InProgress
    active reference = null
    gate = Unsatisfied(BlockingDecisionReference, outcome evidence)
```

Resolved references remain in the Completion Gate and append-only outcome history; they are not retained as the active blocking reference.

Only a separate, authorized Human `CompleteWork` command may transition `InProgress` to `Completed`. Approval makes completion eligible; it does not perform completion.

### Revisions

After rejection or withdrawal, a Human may start a new Draft revision. If that revision must block Work, its submission must again use `RequestBlockingDecision`. Reusing the same `decisionId` is allowed, but the new `revisionNumber` and `submittedSnapshotId` create a different blocking reference. A previous revision's outcome cannot satisfy or unsatisfy the new gate.

### Cancellation and concurrency

Work uses optimistic concurrency. Outcome, cancellation, and completion commands never merge stale state.

- If an outcome commits first, a later Human cancellation or completion reloads the resolved gate and applies normal Work rules.
- If cancellation commits first, it clears the active blocking reference while preserving the gate snapshot and Decision history. A later outcome is recorded as a terminal no-op in processed-event and audit evidence; it does not reopen or mutate Work.
- Completion cannot win while the gate is Pending or Unsatisfied.
- A concurrency conflict causes a bounded reload and re-evaluation; it never retries an already-computed mutation blindly.

Work cancellation does not withdraw Decision. Any Decision withdrawal is a separate Human-authorized command.

### Duplicate, stale, and conflicting outcomes

- Technical duplicates are suppressed by consumer registration plus `sourceDomainEventId`.
- Logical duplicates are suppressed by `organizationId + decisionId + revisionNumber + submittedSnapshotId`.
- An outcome for an older revision is a recorded stale no-op only when Work already reflects a newer valid reference or outcome.
- An outcome for an unrelated or newer-than-pending reference is not used to rebind the gate; it is failed or blocked for investigation.
- Two different outcomes for the same submitted revision are a permanent integrity or security failure, not last-write-wins behavior.

Per-Decision stream-head ordering and reconciliation protect against out-of-order publication. No global ordering between Work and Decision is required.

### Database enforcement

Persistence must distinguish the active blocking reference from resolved Completion Gate evidence. Constraints must enforce:

- `WaitingForDecision` has a Pending gate and a matching active reference;
- `InProgress` has no active blocking reference;
- Satisfied and Unsatisfied gates retain a complete immutable Decision revision reference;
- at most one unresolved submitted blocking Decision exists per Organization and Work; and
- Work and Decision references share the same Organization.

Repository and database checks supplement Aggregate rules; they do not transfer lifecycle authority to persistence code.

### Failure and operations

- Atomic activation failure commits neither Aggregate, event, idempotency record, nor audit evidence.
- Outcome propagation failure leaves Decision resolved and its Outbox record retryable; Work may safely remain Pending temporarily.
- Pending outcome age, blocked stream heads, terminal no-ops, and Work/Decision mismatches must be observable and reconcilable.
- Routine reconciliation may retry supported commands or create findings, but must not directly rewrite authoritative state.

## Alternatives considered

### Let a Draft Decision block Work

Rejected because an editable Draft is not stable review evidence and could leave Work blocked before any reviewer can act.

### Create or submit the blocking Decision asynchronously

Rejected for the MVP because it permits orphaned Decisions, dangling Work references, and compensation logic with no product value while both contexts share one database.

### Update Work synchronously in the Decision outcome transaction

Rejected because it couples independent Aggregate lifecycles, expands review-command contention, and makes Decision resolution depend on Work availability. The local Completion Gate makes eventual propagation safe.

### Query Decision during Work completion

Rejected because it hides a cross-Aggregate consistency dependency inside a Work command and weakens Work's Aggregate boundary. Work completes from its own event-derived gate snapshot.

## Consequences

Positive consequences:

- no committed half-activated blocking workflow;
- exact revision-level protection against stale outcomes;
- independent Decision review and Work completion lifecycles;
- safe asynchronous failure and replay; and
- a practical single-database implementation for a small team.

Costs and constraints:

- one explicitly exceptional multi-Aggregate transaction must remain narrow;
- Work persists a small, duplicated authoritative-event snapshot;
- consumer idempotency and reconciliation are mandatory; and
- extracting Work and Decision into separate services requires a new coordination design.

## Required verification before implementation approval

Tests must cover:

- rollback of every partial activation failure point;
- Draft Decisions never blocking Work;
- Organization mismatch rejection;
- concurrent blocking requests;
- duplicate and out-of-order outcomes;
- stale outcome from a previous revision;
- conflicting outcomes for one submitted snapshot;
- cancellation racing outcome delivery;
- completion racing outcome delivery;
- publisher and consumer restart after Decision commit; and
- Decision approval never invoking or implying Work completion.

## Related documents

- [ADR-0005](0005-adopt-boundary-enforced-modular-monolith.md)
- [ADR-0006](0006-use-postgresql-transactional-outbox.md)
- [Work Aggregate](../architecture/aggregates/work.md)
- [Decision Aggregate](../architecture/aggregates/decision.md)
- [Work State Machine](../architecture/state-machines/work.md)
- [Decision State Machine](../architecture/state-machines/decision.md)
- [Application Services](../architecture/application-services.md)
- [Events and Outbox](../architecture/events-and-outbox.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
