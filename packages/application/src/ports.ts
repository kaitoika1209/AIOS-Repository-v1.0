/**
 * Application ports.
 *
 * The Application Layer coordinates use cases and owns the transaction; it does
 * not implement business rules and never touches the database directly
 * (`docs/architecture/application-services.md`).
 *
 * Every repository is Organization-scoped by signature rather than by
 * convention: there is no way to ask for a Work without saying which
 * Organization is asking. That is the persistence document's
 * Organization-Scoped Repository Rule expressed in types.
 */

import type {
  DecisionId,
  IdentityId,
  GenerationOperationStatus,
  IdentityStatus,
  InvitationId,
  MemoryId,
  MembershipId,
  MembershipStatus,
  OrganizationId,
  Permission,
  Role,
  WorkId,
} from "@aios/types";
import type {
  DecisionState,
  DomainEvent,
  MemoryState,
  MembershipState,
  WorkState,
} from "@aios/domain";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  workId(): WorkId;
  decisionId(): DecisionId;
  memoryId(): MemoryId;
  membershipId(): MembershipId;
  invitationId(): InvitationId;
  identityId(): IdentityId;
  /**
   * Identifies one row of `work_participants` or `work_progress_records`.
   *
   * Both columns are typed `uuid`, so neither may be an opaque string. They are
   * not branded types because neither is ever used as a lookup key — a
   * participant is found by Membership and a progress record is never found at
   * all, only appended and listed.
   */
  workParticipantId(): string;
  workProgressRecordId(): string;
  /**
   * Identifies one Decision revision.
   *
   * A submitted revision's id is what Work stores as `submittedSnapshotId`, so
   * it must be a UUID: the corresponding `work_items` columns are typed `uuid`
   * and reject an opaque non-UUID string at write time.
   */
  revisionId(): string;
}

export interface WorkRepository {
  findById(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<WorkState | null>;
  insert(work: WorkState): Promise<void>;
  /**
   * Persist a new version.
   *
   * `expectedVersion` is the version the caller read. Implementations must
   * update conditionally and report a conflict rather than overwriting, which
   * is the optimistic concurrency ADR-0014 surfaces as `409`.
   */
  update(work: WorkState, expectedVersion: number): Promise<void>;
  listByOrganization(organizationId: OrganizationId): Promise<readonly WorkState[]>;
}

export interface DecisionRepository {
  findById(
    organizationId: OrganizationId,
    decisionId: DecisionId,
  ): Promise<DecisionState | null>;
  insert(decision: DecisionState): Promise<void>;
  update(decision: DecisionState, expectedVersion: number): Promise<void>;
  listByWork(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<readonly DecisionState[]>;
}

/**
 * The Transactional Outbox (ADR-0006).
 *
 * Events are appended in the same transaction as the state change. A separate
 * publisher delivers them at least once.
 */
export interface MemoryRepository {
  findById(
    organizationId: OrganizationId,
    memoryId: MemoryId,
  ): Promise<MemoryState | null>;
  /** At most one active Memory exists per Work; the database enforces it. */
  findActiveByWork(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<MemoryState | null>;
  insert(memory: MemoryState): Promise<void>;
  update(memory: MemoryState, expectedVersion: number): Promise<void>;
  listByOrganization(organizationId: OrganizationId): Promise<readonly MemoryState[]>;
}

/**
 * A Human Identity as the Membership flow needs to see it.
 *
 * Not an Aggregate: Identity has no commands in this release, and Membership
 * references it by `identityId` only. Provider subjects never appear here — the
 * lookup that consumes them is the one method that takes them as arguments.
 */
export interface IdentityRecord {
  readonly identityId: IdentityId;
  readonly status: IdentityStatus;
  readonly displayName: string;
  /** Already lowercased, matching `primary_email_normalized`. */
  readonly primaryEmailNormalized: string | null;
}

export interface IdentityRepository {
  findBySubject(subject: {
    readonly provider: string;
    readonly issuer: string;
    readonly subject: string;
  }): Promise<IdentityRecord | null>;

  /**
   * Create an Identity and link the authenticating subject in one step.
   *
   * Inseparable on purpose: an Identity with no linked subject could never be
   * signed into, and a subject linked to no Identity resolves to no principal.
   */
  createWithSubject(input: {
    readonly identityId: IdentityId;
    readonly displayName: string;
    readonly primaryEmail: string;
    readonly provider: string;
    readonly issuer: string;
    readonly subject: string;
  }): Promise<IdentityRecord>;
}

/** One row of the member list. A query projection, not an Aggregate. */
export interface OrganizationMemberSummary {
  readonly membershipId: MembershipId;
  readonly status: MembershipStatus;
  readonly roles: readonly Role[];
  readonly identityId: IdentityId | null;
  readonly displayName: string | null;
  /** The identity's address once Active, the invitee's while Invited. */
  readonly email: string | null;
  readonly invitedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly invitationExpiresAt: Date | null;
}

export interface MembershipRepository {
  findById(
    organizationId: OrganizationId,
    membershipId: MembershipId,
  ): Promise<MembershipState | null>;

  /**
   * Find the Membership an invitation token belongs to.
   *
   * The only repository method that is not Organization-scoped, and the
   * exception is structural rather than convenient: the caller is not yet a
   * Member of anything, so no Organization context exists to scope by. The
   * token itself names the Organization — the returned state carries it, and
   * the caller never supplies one.
   */
  findByInvitationTokenHash(tokenHash: string): Promise<MembershipState | null>;

  /**
   * Any Membership already addressed to this normalized email, whether it is
   * still `Invited` or already bound to an Identity.
   *
   * Used to refuse a duplicate invitation. `uq_memberships_pending_invitation`
   * and `uq_memberships_organization_identity` are the backstops.
   */
  findByEmail(
    organizationId: OrganizationId,
    normalizedEmail: string,
  ): Promise<MembershipState | null>;

  findByIdentity(
    organizationId: OrganizationId,
    identityId: IdentityId,
  ): Promise<MembershipState | null>;

  insert(membership: MembershipState): Promise<void>;
  update(membership: MembershipState, expectedVersion: number): Promise<void>;

  listMembers(
    organizationId: OrganizationId,
  ): Promise<readonly OrganizationMemberSummary[]>;
}

/**
 * The durable evidence of one Memory generation attempt sequence.
 *
 * ADR-0004 requires this to exist and to commit its source snapshot and
 * provider-input hash *before* the provider is called, so that a process that
 * dies mid-call leaves a record of what was attempted rather than nothing.
 *
 * Not an Aggregate. The Memory state machine is explicit that generation
 * attempts are "operational process state outside the Memory Aggregate until a
 * valid draft is created" — a failed generation must not produce a Memory in
 * any state.
 */
export interface GenerationOperation {
  readonly generationOperationId: string;
  readonly organizationId: OrganizationId;
  readonly workId: WorkId;
  readonly generationPolicyVersion: number;
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotHash: string;
  readonly providerInputHash: string;
  readonly status: GenerationOperationStatus;
  readonly attemptCount: number;
  /** Set exactly when the status is `Generated`; the database enforces both. */
  readonly memoryId: MemoryId | null;
}

export interface GenerationOperationRepository {
  /**
   * The stable operation for this Work under this policy version, creating it
   * if it does not exist.
   *
   * Identity is `(organizationId, workId, generationPolicyVersion)` and a
   * terminal `Failed` row does not free it — a redelivered `WorkCompleted`
   * finds the existing row rather than starting a parallel attempt.
   */
  ensure(input: {
    readonly generationOperationId: string;
    readonly organizationId: OrganizationId;
    readonly workId: WorkId;
    readonly generationPolicyVersion: number;
    readonly sourceEventId: string;
    readonly sourceSnapshotId: string;
    readonly sourceSnapshotHash: string;
    readonly providerInputHash: string;
    readonly promptTemplateVersion: number;
    readonly outputSchemaVersion: number;
    readonly now: Date;
  }): Promise<GenerationOperation>;

  /**
   * Take the operation for one attempt.
   *
   * Returns null when another worker holds an unexpired lease, or when the
   * operation is in a state that accepts no attempt. Both are ordinary
   * outcomes, not errors: at-least-once delivery means two workers racing for
   * the same `WorkCompleted` is expected.
   */
  claim(input: {
    readonly generationOperationId: string;
    readonly lockedBy: string;
    readonly leaseUntil: Date;
    readonly now: Date;
  }): Promise<GenerationOperation | null>;

  /** Generating -> Generated, linking the Memory the attempt produced. */
  complete(input: {
    readonly generationOperationId: string;
    readonly memoryId: MemoryId;
    readonly modelReference: string;
    readonly now: Date;
  }): Promise<void>;

  /**
   * Generating -> RetryPending, or -> Failed when the failure is terminal.
   *
   * A refusal and a schema violation are terminal: retrying identical input
   * produces an identical answer, so a retry only spends money. A timeout is
   * not, because the same input may well succeed.
   */
  fail(input: {
    readonly generationOperationId: string;
    readonly errorCode: string;
    readonly terminal: boolean;
    readonly nextAttemptAt: Date | null;
    readonly now: Date;
  }): Promise<void>;
}

/**
 * A failed delivery, as an operator is permitted to see it.
 *
 * The authorization document calls this "redacted failed-event metadata", and
 * the redaction is the point: `payload` carries the business content of a Work,
 * Decision, or Memory, and an operator diagnosing a delivery failure has no need
 * of it. `last_error_message` is excluded for the same reason — a driver error
 * routinely quotes the row it choked on.
 *
 * What is left is enough to decide whether to retry: what failed, how often, and
 * with which error code.
 */
export interface FailedEventSummary {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly occurredAt: Date;
  readonly lastAttemptAt: Date | null;
}

export interface EventRecoveryRepository {
  /** Failed deliveries in one Organization, newest failure first. */
  listFailed(
    organizationId: OrganizationId,
    limit: number,
  ): Promise<readonly FailedEventSummary[]>;

  /**
   * Return one failed delivery to `Pending`.
   *
   * Scoped by Organization in the statement itself, not by a check the caller
   * could forget: the source event determines the Organization, and a recovery
   * request cannot name another one. Returns false when no row matched — an
   * event that is not Failed, or belongs elsewhere.
   *
   * `attempt_count` is preserved. Resetting it would erase the evidence of how
   * hard the system already tried and let a poisonous message cycle forever.
   */
  retryFailed(
    organizationId: OrganizationId,
    eventId: string,
    now: Date,
  ): Promise<boolean>;
}

export interface OutboxPort {
  append(events: readonly DomainEvent[]): Promise<void>;
}

/**
 * Transaction boundary.
 *
 * One use case, one transaction, one Aggregate mutated per transaction
 * (ADR-0005). Where two Aggregates must change, they are coordinated through
 * events rather than a shared transaction — except the one atomic activation
 * ADR-0007 defines, which is why `requestBlockingDecision` runs inside a single
 * `transaction` call.
 */
export interface UnitOfWork {
  transaction<T>(fn: (tx: RepositoryBundle) => Promise<T>): Promise<T>;
}

export interface RepositoryBundle {
  readonly work: WorkRepository;
  readonly decisions: DecisionRepository;
  readonly memories: MemoryRepository;
  readonly generationOperations: GenerationOperationRepository;
  readonly eventRecovery: EventRecoveryRepository;
  readonly memberships: MembershipRepository;
  readonly identities: IdentityRepository;
  readonly outbox: OutboxPort;
}

export interface UseCaseDependencies {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class NotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;

  /**
   * Deliberately does not distinguish "absent" from "belongs to another
   * Organization". ADR-0014 requires `404` for a cross-tenant resource so the
   * response cannot confirm that it exists elsewhere.
   */
  constructor(resource: string) {
    super(`${resource} not found.`);
    this.name = "NotFoundError";
  }
}

export type { Permission };
