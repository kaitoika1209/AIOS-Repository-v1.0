/**
 * Consumer registration vocabulary.
 *
 * `docs/architecture/events-and-outbox.md` is explicit that a registration is
 * "version-controlled configuration" and that "runtime exception type, ad hoc
 * operator judgment, or handler code MUST NOT silently change its side-effect
 * class or recovery policy". That rules out a database table an operator can
 * edit: the registry lives in the repository, changes through review, and ships
 * with the code whose behaviour it governs.
 *
 * The catalogues here are closed, like every other vocabulary in this package.
 */

/** Consumer types, from the "Default Policy by Consumer Type" table. */
export const CONSUMER_TYPES = [
  "DomainCoordination",
  "Projection",
  "Integration",
  "Operational",
] as const;
export type ConsumerType = (typeof CONSUMER_TYPES)[number];

/** "Canonical Side-Effect Classes". */
export const SIDE_EFFECT_CLASSES = [
  "PostgreSQLLocal",
  "ExternalComputation",
  "ExternalBusinessEffect",
] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

/**
 * Permitted `orderingRequirement` values.
 *
 * `ConsumerWide` is listed because the document lists it, and is rejected by
 * `assertRegistry` because the document prohibits it for the MVP "unless an ADR
 * demonstrates why per-key ordering cannot preserve correctness". No such ADR
 * exists, so the value is representable and unusable.
 */
export const ORDERING_REQUIREMENTS = [
  "None",
  "PerAggregateStream",
  "PerBusinessKey",
  "ConsumerWide",
] as const;
export type OrderingRequirement = (typeof ORDERING_REQUIREMENTS)[number];

/** "Failure-Continuation Policies". */
export const FAILURE_CONTINUATION_POLICIES = [
  "ContinueIndependent",
  "BlockOrderingKey",
  "BlockConsumer",
  "RequireExternalRecovery",
] as const;
export type FailureContinuationPolicy =
  (typeof FAILURE_CONTINUATION_POLICIES)[number];

/** "Skip Policies". */
export const SKIP_POLICIES = [
  "Prohibited",
  "RequiresSafetyEvidence",
  "AllowedWhenRebuildable",
] as const;
export type SkipPolicy = (typeof SKIP_POLICIES)[number];

/** "Canonical Replay Modes". */
export const REPLAY_MODES = [
  "RetryOriginal",
  "ReprocessWithCurrentHandler",
  "RebuildProjection",
  "ValidateOnly",
] as const;
export type ReplayMode = (typeof REPLAY_MODES)[number];

/** "Dead Letter Status Values". */
export const DEAD_LETTER_STATUSES = [
  "Open",
  "Investigating",
  "ReadyForReplay",
  "Resolved",
  "Skipped",
] as const;
export type DeadLetterStatus = (typeof DEAD_LETTER_STATUSES)[number];

export interface ConsumerRegistration {
  readonly consumerName: string;
  readonly eventTypes: readonly string[];
  readonly consumerType: ConsumerType;
  readonly sideEffectClass: SideEffectClass;
  readonly orderingRequirement: OrderingRequirement;
  readonly failureContinuationPolicy: FailureContinuationPolicy;
  readonly skipPolicy: SkipPolicy;
  readonly enabled: boolean;
  /**
   * Why this registration departs from its consumer type's default
   * continuation policy, or why its skip policy is not `Prohibited`.
   *
   * Required by the document for any override: "The registration may override a
   * default only with a documented invariant, owner, recovery procedure, and
   * test coverage." Null means no override.
   */
  readonly overrideRationale: string | null;
}

/** Default continuation policy per consumer type. */
export const DEFAULT_CONTINUATION: Readonly<
  Record<ConsumerType, FailureContinuationPolicy>
> = {
  DomainCoordination: "BlockOrderingKey",
  Projection: "BlockOrderingKey",
  Integration: "RequireExternalRecovery",
  Operational: "ContinueIndependent",
};

/**
 * Notification types, from the persistence document's closed list.
 *
 * Six, not the eight examples `mvp.md` gives. Two of those examples are not
 * in-app deliverable and the reasons are structural: an invitation's recipient
 * has no Identity or Membership until they accept, and Memory generation failure
 * has no registered event — `MemoryGenerationFailed` is deliberately
 * unregistered, with operation state as the authoritative evidence instead.
 */
export const NOTIFICATION_TYPES = [
  "WorkAssigned",
  "DecisionSubmittedForReview",
  "DecisionResolved",
  "MemoryReadyForReview",
  "MemoryRejected",
  "MemoryApproved",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
