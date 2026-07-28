# ADR-0004: Separate External Computation from External Business Effects

**Status:** Accepted  
**Date:** 2026-07-26  
**Blueprint Version:** 0.2.0  
**Decision Owner:** Platform Runtime and Organizational Learning  
**Review Trigger:** before enabling the first ExternalBusinessEffect consumer, when a provider idempotency or outcome-query contract changes, when external notification delivery enters MVP scope, or when recovery requirements change materially

---

## Context

AIOS uses a Modular Monolith, PostgreSQL as the authoritative data store, a Transactional Outbox, background Workers, and at-least-once delivery.

Remote calls cannot participate in the same atomic transaction as PostgreSQL. A process may fail:

- before a provider request is sent;
- after the provider performs an effect but before acknowledgement is received;
- after acknowledgement but before local evidence commits; or
- after local lease ownership has been lost.

Treating every remote call as an ordinary retryable failure creates two opposite risks.

For AI generation, excessive caution would send computation-only timeouts to unnecessary Human recovery even though no external business state was created.

For email, webhook, remote-object, payment, access-control, or similar effects, automatic retry after timeout may repeat an irreversible business effect.

The architecture therefore requires an explicit distinction between remote computation and externally visible business mutation.

The decision must remain practical for a one-to-three-person team. The MVP should not implement infrastructure for integrations that are outside product scope, but future integration code must not be allowed to bypass the safety contract.

---

## Decision

Every event consumer declares one canonical `sideEffectClass`:

```text
PostgreSQLLocal
ExternalComputation
ExternalBusinessEffect
```

The side-effect class and provider capability modes are version-controlled ConsumerRegistration data. A handler, exception, retry path, or operator cannot change them implicitly.

---

## PostgreSQLLocal

`PostgreSQLLocal` means the effect is fully represented inside the authoritative PostgreSQL consistency boundary.

Target Aggregate state, processed-event result, Outbox records, required audit, dead-letter resolution, and ordering-state changes can be finalized atomically where the use case requires them.

MVP domain coordination, projections, and in-app notification records use this class.

---

## ExternalComputation

`ExternalComputation` means a provider computes candidate data but does not become the source of an AIOS business outcome.

Memory generation uses this class.

The provider response:

- is untrusted candidate content;
- has no Human or domain authority;
- becomes meaningful only after local validation;
- cannot create Memory without a valid generation and consumer claim; and
- cannot bypass Human review.

Memory generation uses one durable `memory_generation_operation` identified by:

```text
organizationId
workId
generationPolicyVersion
```

The operation commits its immutable source snapshot and provider-input hash before the provider call.

Canonical operation statuses are:

```text
Pending
Generating
RetryPending
Generated
Failed
Abandoned
```

A provider timeout with no usable candidate may transition `Generating -> RetryPending` while retry budget remains. Retry reuses the same source snapshot, policy version, provider-input hash, and logical operation.

A late response from a stale or lease-lost claim is discarded. `Generated` commits only with the matching Memory, `MemoryGenerated` Outbox record, processed-event result, and required audit evidence.

Duplicate provider cost is an operational risk. It is not duplicate business state and does not justify weakening Memory uniqueness or review invariants.

---

## ExternalBusinessEffect

`ExternalBusinessEffect` means the provider changes externally visible state that PostgreSQL rollback cannot undo.

Examples include:

- external email or SMS delivery;
- webhook delivery;
- creation or mutation of a remote business object;
- transfer of value;
- remote access grant or revocation; and
- another irreversible or outcome-ambiguous provider action.

An enabled consumer in this class requires a durable `external_effect_operation` written before the first provider call.

The logical effect identity includes Organization, consumer, source event, effect type, and effect key. A stable request fingerprint prevents changed intent from reusing the identity.

Canonical ledger statuses are:

```text
Prepared
InFlight
Succeeded
ConfirmedAbsent
OutcomeUnknown
Failed
Compensating
Compensated
```

The same logical effect always reuses the same operation and provider idempotency key.

---

## Provider Capability Contract

ConsumerRegistration records:

```text
providerIdempotencyMode
providerOutcomeQueryMode
compensationMode
externalEffectPolicyReference
```

For an `ExternalBusinessEffect`, at least one safe completion path is mandatory:

- provider-enforced idempotency with a stable key whose verified retention window covers every retry and recovery window; or
- a durable provider operation reference with authoritative outcome query.

Application-only deduplication is insufficient because the provider may commit after the last local check and before local success evidence commits.

A non-idempotent and non-queryable external business effect is prohibited for automatic MVP consumers.

---

## OutcomeUnknown

Timeout, acknowledgement loss, post-send lease loss, or local commit uncertainty after a provider call is not proof of failure.

Unless provider evidence proves otherwise, the effect becomes `OutcomeUnknown`.

While unknown:

- ordinary retry cannot resend it;
- the processed event is or remains `Failed`;
- the linked dead letter remains `Investigating`;
- the ordering key remains blocked; and
- replay completion cannot be claimed.

The Operations Application Service may resolve the outcome only through:

- provider-confirmed success;
- provider-confirmed absence followed by safe retry with the same identity;
- provider-enforced idempotent retry with the same key inside the verified retention window; or
- approved compensation represented as a separate linked operation.

Compensation never rewrites the original effect as if it did not occur.

---

## Transaction Boundary

The external provider effect cannot be atomic with PostgreSQL.

The required pattern is:

```text
Commit Prepared effect identity and request fingerprint

Commit fenced InFlight claim

Call provider outside PostgreSQL

Obtain authoritative provider evidence

Commit local effect outcome, processed event, dead letter,
ordering state, required Outbox, audit, and replay result
```

If the final local commit fails after provider success, recovery queries the provider or reuses the same provider-enforced idempotency key. It does not generate a new effect identity.

---

## MVP Activation Boundary

The baseline MVP has no enabled `ExternalBusinessEffect` consumer.

MVP scope is:

| Capability | MVP classification |
|---|---|
| Domain coordination and projections | `PostgreSQLLocal` |
| In-app notifications | `PostgreSQLLocal` |
| Memory generation provider call | `ExternalComputation` |
| External email, SMS, webhook, remote object, payment, or remote access mutation | Out of baseline MVP |

The future-facing ledger schema is conditional. It becomes an implementation requirement only when the first `ExternalBusinessEffect` consumer is approved.

Such a consumer cannot be enabled until registration, provider adapter, credentials and tenant isolation, ledger persistence, reconciliation, runbook, metrics, alerting, and failure-injection tests are complete.

---

## Alternatives Considered

### Treat Every Remote Call as ExternalBusinessEffect

Rejected because AI computation does not create authoritative provider-side business state. Requiring Human reconciliation for every generation timeout would add unnecessary operational cost and delay.

### Treat Every Remote Call as Retryable Computation

Rejected because timeout is not proof that an externally visible effect did not occur. Blind retry can duplicate email, webhook, payment, or remote mutation.

### Use Only Processed Events

Rejected because a processed-event row cannot prove whether a provider effect occurred during the crash window. It lacks provider operation identity, request fingerprint, idempotency retention, and reconciliation state.

### Implement the External-Effect Ledger for Every MVP Call

Rejected as over-engineering. The baseline MVP has no external business-effect consumer. Memory generation needs a smaller typed operation optimized for computation and local finalization.

### Rely Only on Provider Idempotency

Rejected because provider guarantees vary, may expire, and do not replace local Organization scope, request fingerprint, claim fencing, audit, ordering, or recovery state.

### Use Distributed Transactions or Event Sourcing

Rejected for the MVP. External providers generally do not participate in PostgreSQL distributed transactions, and Event Sourcing does not remove the external outcome ambiguity.

---

## Consequences

### Positive

- AI generation retry remains practical and bounded.
- Externally visible effects cannot be blindly resent after ambiguous failure.
- PostgreSQL remains authoritative for AIOS state and recovery evidence.
- Provider capability assumptions become explicit and testable.
- Future integrations have a safe activation gate.
- The baseline MVP avoids implementing unused integration infrastructure.
- Memory uniqueness and Human review remain independent of provider behavior.

### Negative

- Consumer registration becomes more detailed.
- Future external-effect adapters require provider-specific reconciliation.
- Ordering keys may remain blocked while provider outcome is unknown.
- Compensation requires an additional typed workflow and ledger operation.
- Duplicate AI compute cost can still occur after timeout or crash.
- Enabling external notification delivery requires an ADR review and production-readiness work.

---

## Required Verification

Before implementation approval, tests must cover:

- duplicate event delivery;
- crash before provider send;
- crash after provider send and before acknowledgement;
- provider success followed by local commit failure;
- lease loss and late provider response;
- request-fingerprint conflict;
- provider idempotency-window expiry;
- provider-confirmed absence and same-identity retry;
- `OutcomeUnknown` ordering block;
- compensation lineage;
- Memory generation timeout and bounded retry;
- Memory uniqueness under concurrent completion; and
- restore followed by external-effect reconciliation.

---

## Related Documents

- [Events and Outbox](../architecture/events-and-outbox.md)
- [Application Services](../architecture/application-services.md)
- [Persistence and Data Model](../architecture/persistence-and-data-model.md)
- [Memory Aggregate](../architecture/aggregates/memory.md)
- [Observability and Operations](../architecture/observability-and-operations.md)
- [MVP Scope](../product/mvp.md)
