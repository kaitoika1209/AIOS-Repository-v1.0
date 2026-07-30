/**
 * The registered consumers.
 *
 * Version-controlled configuration, per events-and-outbox.md: "Every consumer
 * must be registered explicitly" and a registration "MUST NOT" be changed
 * silently by handler code or operator judgment. Adding a consumer means
 * editing this file and passing review — there is no runtime path that
 * registers one, and `assertRegistry` runs at import so an invalid entry fails
 * the process rather than the first recovery request.
 *
 * The registry is what makes the recovery operations decidable. Skip and the
 * two replays each assert something about the original delivery, and whether
 * that assertion is safe is a property of the consumer, not of the request.
 */

import {
  DEFAULT_CONTINUATION,
  type ConsumerRegistration,
} from "@aios/types";

/**
 * `decision-outcome` applies a committed Decision outcome to the Work
 * completion gate (ADR-0007's asynchronous half).
 *
 * A Domain Coordination Consumer carrying an authoritative outcome. Ordered by
 * the source Decision stream, because applying a later outcome for the same
 * Decision after an earlier one failed would leave the gate reflecting the
 * wrong revision.
 *
 * `skipPolicy` is `RequiresSafetyEvidence` rather than `Prohibited`: the
 * document's own row for "Skip Domain Coordination ... result" is
 * "Allow only with registered safety or compensation evidence", so the case is
 * contemplated. Discarding one outcome leaves the Work blocked forever, which
 * is recoverable by a human resolving the Work directly — that is the
 * compensation the evidence has to name.
 */
const DECISION_OUTCOME: ConsumerRegistration = {
  consumerName: "decision-outcome",
  eventTypes: ["DecisionApproved", "DecisionRejected", "DecisionWithdrawn"],
  consumerType: "DomainCoordination",
  sideEffectClass: "PostgreSQLLocal",
  orderingRequirement: "PerAggregateStream",
  failureContinuationPolicy: "BlockOrderingKey",
  skipPolicy: "RequiresSafetyEvidence",
  enabled: true,
  overrideRationale: null,
};

/**
 * `memory-generation` produces a Memory draft from completed Work (ADR-0008).
 *
 * An Integration Consumer by handler type — it calls a provider — but
 * `ExternalComputation` by side-effect class, because the provider computes a
 * candidate with no authority until validated locally (ADR-0004).
 *
 * Its recovery store is the typed Memory-generation operation, not the generic
 * ledger; the MVP Side-Effect Scope table says so directly. That is why the
 * continuation policy is `ContinueIndependent` rather than the Integration
 * default: a failed generation for one Work has no bearing on the next, and
 * the operation row already records what was attempted.
 *
 * `skipPolicy` is `Prohibited`. Skipping would discard the trigger while the
 * generation operation still claims the attempt, leaving two records that
 * disagree about whether the Work was ever considered.
 */
const MEMORY_GENERATION: ConsumerRegistration = {
  consumerName: "memory-generation",
  eventTypes: ["WorkCompleted"],
  consumerType: "Integration",
  sideEffectClass: "ExternalComputation",
  orderingRequirement: "None",
  failureContinuationPolicy: "ContinueIndependent",
  skipPolicy: "Prohibited",
  enabled: true,
  overrideRationale:
    "ExternalComputation with a typed generation operation as its recovery store: a failed generation for one Work does not invalidate the next, and the operation row is the durable evidence of the attempt.",
};

/**
 * `notifications` projects Member-facing attention from registered events.
 *
 * The first Projection Consumer, and the only registration that can honestly
 * claim `AllowedWhenRebuildable`: the whole table is derivable from the Outbox,
 * so a discarded delivery costs a missing notification and nothing else. No
 * business decision depends on one existing.
 *
 * `ContinueIndependent` for the same reason. A notification about one Decision
 * is not invalidated by a failure to notify about another, and blocking the key
 * would stop every later notification for a Member because of one that could
 * simply be rebuilt.
 */
const NOTIFICATIONS: ConsumerRegistration = {
  consumerName: "notifications",
  eventTypes: [
    "WorkAssignmentChanged",
    "DecisionSubmitted",
    "DecisionApproved",
    "DecisionRejected",
    "DecisionWithdrawn",
    "MemorySubmittedForReview",
    "MemoryApproved",
    "MemoryRejected",
  ],
  consumerType: "Projection",
  sideEffectClass: "PostgreSQLLocal",
  orderingRequirement: "None",
  failureContinuationPolicy: "ContinueIndependent",
  skipPolicy: "AllowedWhenRebuildable",
  enabled: true,
  overrideRationale:
    "A rebuildable projection whose entries are independent: each notification derives from one event, and a missing one is recoverable by replaying that event rather than by blocking later ones.",
};

export const CONSUMER_REGISTRY: readonly ConsumerRegistration[] = [
  DECISION_OUTCOME,
  MEMORY_GENERATION,
  NOTIFICATIONS,
];

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Validate the registry against the rules the document states.
 *
 * Run at import rather than on demand. A registration that violates an
 * ordering or override rule is a configuration defect, and the process should
 * refuse to start rather than serve requests under it.
 */
export const assertRegistry = (
  registry: readonly ConsumerRegistration[] = CONSUMER_REGISTRY,
): void => {
  const seen = new Set<string>();

  for (const registration of registry) {
    const name = registration.consumerName;

    if (seen.has(name)) {
      throw new RegistryError(`Duplicate consumer registration: ${name}.`);
    }
    seen.add(name);

    if (registration.eventTypes.length === 0) {
      throw new RegistryError(`${name} registers no event type.`);
    }

    // "ConsumerWide ordering is prohibited for the MVP unless an ADR
    // demonstrates why per-key ordering cannot preserve correctness."
    if (registration.orderingRequirement === "ConsumerWide") {
      throw new RegistryError(
        `${name} declares ConsumerWide ordering, which the MVP prohibits without an ADR.`,
      );
    }

    // "The registration may override a default only with a documented
    // invariant, owner, recovery procedure, and test coverage."
    const expected = DEFAULT_CONTINUATION[registration.consumerType];
    if (
      registration.failureContinuationPolicy !== expected &&
      registration.overrideRationale === null
    ) {
      throw new RegistryError(
        `${name} overrides the ${registration.consumerType} default ` +
          `(${expected}) with ${registration.failureContinuationPolicy} and states no rationale.`,
      );
    }

    // An ExternalBusinessEffect consumer requires the External Effect Contract,
    // which is out of the baseline MVP. Representable, never enabled.
    if (
      registration.sideEffectClass === "ExternalBusinessEffect" &&
      registration.enabled
    ) {
      throw new RegistryError(
        `${name} is an enabled ExternalBusinessEffect consumer, which requires the External Effect Contract.`,
      );
    }

    // A skip that is neither prohibited nor evidence-gated is a claim that the
    // result can be rebuilt, and only a projection can make it.
    if (
      registration.skipPolicy === "AllowedWhenRebuildable" &&
      registration.consumerType !== "Projection"
    ) {
      throw new RegistryError(
        `${name} claims AllowedWhenRebuildable but is not a Projection Consumer.`,
      );
    }
  }
};

assertRegistry();

export const findRegistration = (
  consumerName: string,
): ConsumerRegistration | null =>
  CONSUMER_REGISTRY.find((r) => r.consumerName === consumerName) ?? null;

/** Every enabled consumer registered for an event type. */
export const consumersFor = (
  eventType: string,
): readonly ConsumerRegistration[] =>
  CONSUMER_REGISTRY.filter((r) => r.enabled && r.eventTypes.includes(eventType));
