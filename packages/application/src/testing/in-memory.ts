/**
 * In-memory adapters for testing use cases without a database.
 *
 * These are deliberately strict about optimistic concurrency and Organization
 * scoping, because those are the two properties most easily lost when a real
 * adapter is written later. A test that passes here should behave the same way
 * against PostgreSQL.
 */

import type {
  DecisionId,
  GenerationOperationStatus,
  IdentityId,
  InvitationId,
  MemoryId,
  MembershipId,
  NotificationType,
  OrganizationId,
  Role,
  WorkId,
} from "@aios/types";
import {
  VersionConflictError,
  currentInvitation,
  type DecisionState,
  type DomainEvent,
  type MemoryState,
  type MembershipState,
  type OrganizationState,
  type WorkState,
} from "@aios/domain";

import type { AuditRecord, AuditRepository } from "../audit.js";
import type {
  AssistanceGrantRepository,
  ContributionType,
  SecretaryContribution,
  SecretaryContributionRepository,
} from "../assistance.js";
import type {
  Clock,
  ConsumerDeliveryRepository,
  NotificationRecord,
  NotificationRepository,
  OrganizationRepository,
  DeadLetteredDelivery,
  DecisionRepository,
  EventRecoveryRepository,
  FailedEventSummary,
  GenerationOperation,
  GenerationOperationRepository,
  IdentityRecord,
  IdentityRepository,
  MemoryRepository,
  MembershipRepository,
  IdGenerator,
  OrganizationMemberSummary,
  OutboxPort,
  ReplayRepository,
  RepositoryBundle,
  UnitOfWork,
  WorkRepository,
} from "../ports.js";

/**
 * The Organization repository, with the bootstrap kept atomic.
 *
 * `bootstrap` writes both rows or neither, mirroring the single transaction the
 * real adapter uses. A double that inserted the Organization and then the
 * Membership as two independent steps would let a test pass while the invariant
 * the bootstrap exists to protect was broken.
 */
export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly rows = new Map<string, OrganizationState>();

  constructor(private readonly memberships: InMemoryMembershipRepository) {}

  async findById(organizationId: OrganizationId): Promise<OrganizationState | null> {
    return this.rows.get(organizationId) ?? null;
  }

  async bootstrap(input: {
    organization: OrganizationState;
    ownerMembership: MembershipState;
    roleAssignmentId: string;
  }): Promise<void> {
    if (this.rows.has(input.organization.organizationId)) {
      throw new Error("Organization already exists.");
    }
    this.rows.set(input.organization.organizationId, input.organization);
    await this.memberships.insert(input.ownerMembership);
  }

  async update(
    organization: OrganizationState,
    expectedVersion: number,
  ): Promise<void> {
    const existing = this.rows.get(organization.organizationId);
    if (existing === undefined) {
      throw new Error(`Organization ${organization.organizationId} does not exist.`);
    }
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, existing.version);
    }
    this.rows.set(organization.organizationId, organization);
  }

  /** Seed an Organization that already exists. */
  seed(organization: OrganizationState): void {
    this.rows.set(organization.organizationId, organization);
  }
}

export class InMemoryWorkRepository implements WorkRepository {
  private readonly rows = new Map<string, WorkState>();

  async findById(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<WorkState | null> {
    const row = this.rows.get(workId);
    // Scoping is applied on read, mirroring the Organization-Scoped Repository
    // Rule. A row from another Organization is reported as absent.
    if (row === undefined || row.organizationId !== organizationId) {
      return null;
    }
    return row;
  }

  async insert(work: WorkState): Promise<void> {
    this.rows.set(work.workId, work);
  }

  async update(work: WorkState, expectedVersion: number): Promise<void> {
    const existing = this.rows.get(work.workId);
    if (existing === undefined) {
      throw new Error(`Work ${work.workId} does not exist.`);
    }
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, existing.version);
    }
    this.rows.set(work.workId, work);
  }

  async listByOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly WorkState[]> {
    return [...this.rows.values()].filter(
      (w) => w.organizationId === organizationId,
    );
  }
}

export class InMemoryDecisionRepository implements DecisionRepository {
  private readonly rows = new Map<string, DecisionState>();

  async findById(
    organizationId: OrganizationId,
    decisionId: DecisionId,
  ): Promise<DecisionState | null> {
    const row = this.rows.get(decisionId);
    if (row === undefined || row.organizationId !== organizationId) {
      return null;
    }
    return row;
  }

  async insert(decision: DecisionState): Promise<void> {
    this.rows.set(decision.decisionId, decision);
  }

  async update(decision: DecisionState, expectedVersion: number): Promise<void> {
    const existing = this.rows.get(decision.decisionId);
    if (existing === undefined) {
      throw new Error(`Decision ${decision.decisionId} does not exist.`);
    }
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, existing.version);
    }
    this.rows.set(decision.decisionId, decision);
  }

  async listByWork(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<readonly DecisionState[]> {
    return [...this.rows.values()].filter(
      (d) => d.organizationId === organizationId && d.relatedWorkId === workId,
    );
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly rows = new Map<string, MemoryState>();

  async findById(
    organizationId: OrganizationId,
    memoryId: MemoryId,
  ): Promise<MemoryState | null> {
    const row = this.rows.get(memoryId);
    if (row === undefined || row.organizationId !== organizationId) return null;
    return row;
  }

  async findActiveByWork(
    organizationId: OrganizationId,
    workId: WorkId,
  ): Promise<MemoryState | null> {
    return (
      [...this.rows.values()].find(
        (m) =>
          m.organizationId === organizationId &&
          m.sourceWorkId === workId &&
          m.isActive,
      ) ?? null
    );
  }

  async insert(memory: MemoryState): Promise<void> {
    // Mirrors uq_memories_active_source_work, so the idempotency the generation
    // consumer relies on is exercised here too.
    const existing = await this.findActiveByWork(
      memory.organizationId,
      memory.sourceWorkId,
    );
    if (existing !== null) {
      throw new Error("An active Memory already exists for this Work.");
    }
    this.rows.set(memory.memoryId, memory);
  }

  async update(memory: MemoryState, expectedVersion: number): Promise<void> {
    const existing = this.rows.get(memory.memoryId);
    if (existing === undefined) {
      throw new Error(`Memory ${memory.memoryId} does not exist.`);
    }
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, existing.version);
    }
    this.rows.set(memory.memoryId, memory);
  }

  async listByOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly MemoryState[]> {
    return [...this.rows.values()].filter((m) => m.organizationId === organizationId);
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly rows = new Map<string, MembershipState>();

  async findById(
    organizationId: OrganizationId,
    membershipId: MembershipId,
  ): Promise<MembershipState | null> {
    const row = this.rows.get(membershipId);
    if (row === undefined || row.organizationId !== organizationId) return null;
    return row;
  }

  async findByInvitationTokenHash(
    tokenHash: string,
  ): Promise<MembershipState | null> {
    // Not Organization-scoped, matching the port: the token is what names the
    // Organization. Only the current invitation is searched, so a superseded
    // token finds nothing rather than finding a stale row.
    return (
      [...this.rows.values()].find(
        (m) => currentInvitation(m)?.tokenHash === tokenHash,
      ) ?? null
    );
  }

  async findByEmail(
    organizationId: OrganizationId,
    normalizedEmail: string,
  ): Promise<MembershipState | null> {
    return (
      [...this.rows.values()].find(
        (m) =>
          m.organizationId === organizationId &&
          m.pendingInviteeEmail === normalizedEmail,
      ) ?? null
    );
  }

  async findByIdentity(
    organizationId: OrganizationId,
    identityId: IdentityId,
  ): Promise<MembershipState | null> {
    return (
      [...this.rows.values()].find(
        (m) => m.organizationId === organizationId && m.identityId === identityId,
      ) ?? null
    );
  }

  async insert(membership: MembershipState): Promise<void> {
    this.rows.set(membership.membershipId, membership);
  }

  async update(membership: MembershipState, expectedVersion: number): Promise<void> {
    const existing = this.rows.get(membership.membershipId);
    if (existing === undefined) {
      throw new Error(`Membership ${membership.membershipId} does not exist.`);
    }
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, existing.version);
    }
    this.rows.set(membership.membershipId, membership);
  }

  async listActiveByRole(
    organizationId: OrganizationId,
    role: Role,
  ): Promise<readonly MembershipId[]> {
    return [...this.rows.values()]
      .filter(
        (m) =>
          m.organizationId === organizationId &&
          m.status === "Active" &&
          m.roles.includes(role),
      )
      .map((m) => m.membershipId);
  }

  async listMembers(
    organizationId: OrganizationId,
  ): Promise<readonly OrganizationMemberSummary[]> {
    return [...this.rows.values()]
      .filter((m) => m.organizationId === organizationId)
      .map((m) => ({
        membershipId: m.membershipId,
        status: m.status,
        roles: m.roles,
        identityId: m.identityId,
        displayName: null,
        email: m.pendingInviteeEmail,
        invitedAt: m.invitedAt,
        activatedAt: m.activatedAt,
        invitationExpiresAt: currentInvitation(m)?.expiresAt ?? null,
      }));
  }
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly rows = new Map<string, IdentityRecord & { subject: string }>();

  private static key(subject: {
    provider: string;
    issuer: string;
    subject: string;
  }): string {
    return `${subject.provider}|${subject.issuer}|${subject.subject}`;
  }

  async findBySubject(subject: {
    provider: string;
    issuer: string;
    subject: string;
  }): Promise<IdentityRecord | null> {
    return this.rows.get(InMemoryIdentityRepository.key(subject)) ?? null;
  }

  async createWithSubject(input: {
    identityId: IdentityId;
    displayName: string;
    primaryEmail: string;
    provider: string;
    issuer: string;
    subject: string;
  }): Promise<IdentityRecord> {
    const record = {
      identityId: input.identityId,
      status: "Active" as const,
      displayName: input.displayName,
      primaryEmailNormalized: input.primaryEmail.trim().toLowerCase(),
      subject: input.subject,
    };
    this.rows.set(InMemoryIdentityRepository.key(input), record);
    return record;
  }

  /** Seed an Identity that already exists, for tests about the matching rule. */
  seed(
    record: IdentityRecord,
    subject: { provider: string; issuer: string; subject: string },
  ): void {
    this.rows.set(InMemoryIdentityRepository.key(subject), {
      ...record,
      subject: subject.subject,
    });
  }
}

/**
 * Mirrors the PostgreSQL operation repository, including the parts that make it
 * safe: identity is `(organization, work, policy)`, a claim is conditional on
 * status and lease, and `complete` fences on still holding the claim.
 *
 * Modelled faithfully because these are the semantics the at-least-once story
 * rests on — a permissive double would let a test pass that the real adapter
 * would fail.
 */
export class InMemoryGenerationOperationRepository
  implements GenerationOperationRepository
{
  private readonly rows = new Map<string, GenerationOperation & {
    lockedBy: string | null;
    lockedUntil: Date | null;
  }>();

  private static identity(
    organizationId: OrganizationId,
    workId: WorkId,
    policyVersion: number,
  ): string {
    return `${organizationId}|${workId}|${policyVersion}`;
  }

  async ensure(input: {
    generationOperationId: string;
    organizationId: OrganizationId;
    workId: WorkId;
    generationPolicyVersion: number;
    sourceEventId: string;
    sourceSnapshotId: string;
    sourceSnapshotHash: string;
    providerInputHash: string;
    promptTemplateVersion: number;
    outputSchemaVersion: number;
    now: Date;
  }): Promise<GenerationOperation> {
    const key = InMemoryGenerationOperationRepository.identity(
      input.organizationId,
      input.workId,
      input.generationPolicyVersion,
    );
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const created = {
      generationOperationId: input.generationOperationId,
      organizationId: input.organizationId,
      workId: input.workId,
      generationPolicyVersion: input.generationPolicyVersion,
      sourceSnapshotId: input.sourceSnapshotId,
      sourceSnapshotHash: input.sourceSnapshotHash,
      providerInputHash: input.providerInputHash,
      status: "Pending" as GenerationOperationStatus,
      attemptCount: 0,
      memoryId: null,
      lockedBy: null,
      lockedUntil: null,
    };
    this.rows.set(key, created);
    return created;
  }

  private byId(id: string) {
    for (const row of this.rows.values()) {
      if (row.generationOperationId === id) return row;
    }
    return undefined;
  }

  async claim(input: {
    generationOperationId: string;
    lockedBy: string;
    leaseUntil: Date;
    now: Date;
  }): Promise<GenerationOperation | null> {
    const row = this.byId(input.generationOperationId);
    if (row === undefined) return null;

    const claimable =
      row.status === "Pending" ||
      row.status === "RetryPending" ||
      (row.status === "Generating" &&
        row.lockedUntil !== null &&
        row.lockedUntil.getTime() < input.now.getTime());
    if (!claimable) return null;

    const next = {
      ...row,
      status: "Generating" as GenerationOperationStatus,
      attemptCount: row.attemptCount + 1,
      lockedBy: input.lockedBy,
      lockedUntil: input.leaseUntil,
    };
    this.rows.set(
      InMemoryGenerationOperationRepository.identity(
        row.organizationId,
        row.workId,
        row.generationPolicyVersion,
      ),
      next,
    );
    return next;
  }

  async complete(input: {
    generationOperationId: string;
    memoryId: MemoryId;
    modelReference: string;
    now: Date;
  }): Promise<void> {
    const row = this.byId(input.generationOperationId);
    if (row === undefined || row.status !== "Generating") {
      throw new Error(
        `Generation operation ${input.generationOperationId} was not claimed by this worker.`,
      );
    }
    this.rows.set(
      InMemoryGenerationOperationRepository.identity(
        row.organizationId,
        row.workId,
        row.generationPolicyVersion,
      ),
      {
        ...row,
        status: "Generated",
        memoryId: input.memoryId,
        lockedBy: null,
        lockedUntil: null,
      },
    );
  }

  async fail(input: {
    generationOperationId: string;
    errorCode: string;
    terminal: boolean;
    nextAttemptAt: Date | null;
    now: Date;
  }): Promise<void> {
    const row = this.byId(input.generationOperationId);
    if (row === undefined || row.status !== "Generating") return;
    this.rows.set(
      InMemoryGenerationOperationRepository.identity(
        row.organizationId,
        row.workId,
        row.generationPolicyVersion,
      ),
      {
        ...row,
        status: input.terminal ? "Failed" : "RetryPending",
        lockedBy: null,
        lockedUntil: null,
      },
    );
  }

  /** Exposed so tests can assert what the operation recorded. */
  find(
    organizationId: OrganizationId,
    workId: WorkId,
    policyVersion: number,
  ): GenerationOperation | null {
    return (
      this.rows.get(
        InMemoryGenerationOperationRepository.identity(
          organizationId,
          workId,
          policyVersion,
        ),
      ) ?? null
    );
  }
}

/**
 * Failed deliveries as the recovery routes see them.
 *
 * Separate from `InMemoryOutbox` on purpose: the outbox port only appends, and
 * a failed delivery is a state the *publisher* produces, not the use case. Tests
 * seed that state directly, which is also what a real incident looks like from
 * the recovery side.
 */
export class InMemoryEventRecoveryRepository implements EventRecoveryRepository {
  private readonly rows = new Map<
    string,
    FailedEventSummary & { organizationId: OrganizationId; status: string }
  >();

  async listFailed(
    organizationId: OrganizationId,
    limit: number,
  ): Promise<readonly FailedEventSummary[]> {
    return [...this.rows.values()]
      .filter((r) => r.organizationId === organizationId && r.status === "Failed")
      .slice(0, limit)
      .map(({ organizationId: _organizationId, status: _status, ...summary }) => summary);
  }

  async retryFailed(
    organizationId: OrganizationId,
    eventId: string,
    _now: Date,
  ): Promise<boolean> {
    const row = this.rows.get(eventId);
    // All three conditions in one place, matching the single conditional
    // UPDATE the PostgreSQL adapter issues.
    if (
      row === undefined ||
      row.organizationId !== organizationId ||
      row.status !== "Failed"
    ) {
      return false;
    }
    // `attemptCount` is deliberately carried over unchanged.
    this.rows.set(eventId, { ...row, status: "Pending" });
    return true;
  }

  /** Seed a failed delivery. */
  seedFailed(
    organizationId: OrganizationId,
    summary: FailedEventSummary,
  ): void {
    this.rows.set(summary.eventId, {
      ...summary,
      organizationId,
      status: "Failed",
    });
  }

  /** Exposed so tests can assert what a retry did to the row. */
  statusOf(eventId: string): { status: string; attemptCount: number } | null {
    const row = this.rows.get(eventId);
    return row === undefined
      ? null
      : { status: row.status, attemptCount: row.attemptCount };
  }
}


/**
 * Consumer-side delivery state, modelled closely enough that the atomicity
 * rules are exercised.
 *
 * `skip` refuses unless the dead letter is non-terminal, the version matches,
 * and the processed event is `Failed` — the three conditions that make the real
 * skip a single fenced sequence rather than three hopeful updates.
 */
export class InMemoryConsumerDeliveryRepository
  implements ConsumerDeliveryRepository
{
  private readonly rows = new Map<
    string,
    DeadLetteredDelivery & { orderingBlocked: boolean }
  >();

  private static key(consumerName: string, eventId: string): string {
    return `${consumerName}|${eventId}`;
  }

  async claim(): Promise<"Claimed" | "AlreadyHandled" | "Blocked"> {
    return "Claimed";
  }

  async complete(): Promise<void> {}

  async fail(): Promise<void> {}

  async listDeadLettered(
    organizationId: OrganizationId,
    limit: number,
  ): Promise<readonly DeadLetteredDelivery[]> {
    return [...this.rows.values()]
      .filter(
        (d) =>
          d.organizationId === organizationId &&
          d.deadLetterStatus !== "Resolved" &&
          d.deadLetterStatus !== "Skipped",
      )
      .slice(0, limit);
  }

  async findDeadLetter(
    organizationId: OrganizationId,
    deadLetterId: string,
  ): Promise<DeadLetteredDelivery | null> {
    return (
      [...this.rows.values()].find(
        (d) => d.organizationId === organizationId && d.deadLetterId === deadLetterId,
      ) ?? null
    );
  }

  async skip(input: {
    organizationId: OrganizationId;
    deadLetterId: string;
    expectedDeadLetterVersion: number;
    orderingBroken: boolean;
  }): Promise<boolean> {
    const found = await this.findDeadLetter(input.organizationId, input.deadLetterId);
    if (
      found === null ||
      found.deadLetterVersion !== input.expectedDeadLetterVersion ||
      (found.deadLetterStatus !== "Open" && found.deadLetterStatus !== "Investigating") ||
      found.processedEventStatus !== "Failed"
    ) {
      return false;
    }

    this.rows.set(InMemoryConsumerDeliveryRepository.key(found.consumerName, found.eventId), {
      ...found,
      deadLetterStatus: "Skipped",
      processedEventStatus: "Skipped",
      deadLetterVersion: found.deadLetterVersion + 1,
      orderingBlocked: false,
    });
    return true;
  }

  async reprocess(input: {
    organizationId: OrganizationId;
    deadLetterId: string;
    expectedDeadLetterVersion: number;
  }): Promise<boolean> {
    const found = await this.findDeadLetter(input.organizationId, input.deadLetterId);
    if (
      found === null ||
      found.deadLetterVersion !== input.expectedDeadLetterVersion ||
      (found.deadLetterStatus !== "Open" && found.deadLetterStatus !== "Investigating")
    ) {
      return false;
    }

    this.rows.set(InMemoryConsumerDeliveryRepository.key(found.consumerName, found.eventId), {
      ...found,
      deadLetterStatus: "ReadyForReplay",
      processedEventStatus: "RetryPending",
      deadLetterVersion: found.deadLetterVersion + 1,
      orderingBlocked: false,
    });
    return true;
  }

  /** Seed a dead-lettered delivery. */
  seed(delivery: DeadLetteredDelivery): void {
    this.rows.set(
      InMemoryConsumerDeliveryRepository.key(delivery.consumerName, delivery.eventId),
      { ...delivery, orderingBlocked: true },
    );
  }
}

export class InMemoryReplayRepository implements ReplayRepository {
  readonly rows: {
    replayId: string;
    consumerName: string;
    replayMode: string;
    status: string;
    reasonCode: string;
    resultCode?: string;
  }[] = [];

  async record(input: {
    replayId: string;
    consumerName: string;
    replayMode: string;
    status: string;
    reasonCode: string;
  }): Promise<void> {
    this.rows.push({
      replayId: input.replayId,
      consumerName: input.consumerName,
      replayMode: input.replayMode,
      status: input.status,
      reasonCode: input.reasonCode,
    });
  }

  async settle(input: {
    replayId: string;
    status: string;
    resultCode: string;
  }): Promise<void> {
    const row = this.rows.find((r) => r.replayId === input.replayId);
    if (row !== undefined) {
      row.status = input.status;
      row.resultCode = input.resultCode;
    }
  }
}

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly rows = new Map<
    string,
    NotificationRecord & {
      organizationId: OrganizationId;
      recipientMembershipId: MembershipId;
      sourceEventId: string;
    }
  >();

  async append(input: {
    notificationId: string;
    organizationId: OrganizationId;
    recipientMembershipId: MembershipId;
    notificationType: NotificationType;
    subjectType: string;
    subjectId: string;
    title: string;
    sourceEventId: string;
    occurredAt: Date;
  }): Promise<void> {
    // Keyed by recipient and source event, matching
    // `uq_notifications_recipient_event`: a redelivery must not produce a second
    // row, and modelling it any other way would let a test pass that PostgreSQL
    // would reject.
    const key = `${input.recipientMembershipId}|${input.sourceEventId}`;
    if (this.rows.has(key)) return;

    this.rows.set(key, {
      notificationId: input.notificationId,
      notificationType: input.notificationType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: input.title,
      occurredAt: input.occurredAt,
      acknowledgedAt: null,
      organizationId: input.organizationId,
      recipientMembershipId: input.recipientMembershipId,
      sourceEventId: input.sourceEventId,
    });
  }

  async listForMember(
    organizationId: OrganizationId,
    recipientMembershipId: MembershipId,
    limit: number,
  ): Promise<readonly NotificationRecord[]> {
    return [...this.rows.values()]
      .filter(
        (n) =>
          n.organizationId === organizationId &&
          n.recipientMembershipId === recipientMembershipId,
      )
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, limit);
  }

  async acknowledge(input: {
    organizationId: OrganizationId;
    recipientMembershipId: MembershipId;
    notificationId: string;
    now: Date;
  }): Promise<boolean> {
    for (const [key, row] of this.rows) {
      if (
        row.notificationId === input.notificationId &&
        row.organizationId === input.organizationId &&
        row.recipientMembershipId === input.recipientMembershipId &&
        row.acknowledgedAt === null
      ) {
        this.rows.set(key, { ...row, acknowledgedAt: input.now });
        return true;
      }
    }
    return false;
  }
}

export class InMemoryAssistanceGrantRepository implements AssistanceGrantRepository {
  private readonly rows = new Map<string, { revoked: boolean }>();

  private static key(i: {
    organizationId: string;
    secretaryPrincipalId: string;
    contextKey: string;
    assistanceOperation: string;
    portContractVersion: number;
  }): string {
    return [
      i.organizationId,
      i.secretaryPrincipalId,
      i.contextKey,
      i.assistanceOperation,
      i.portContractVersion,
    ].join("|");
  }

  async isGranted(input: {
    organizationId: OrganizationId;
    secretaryPrincipalId: string;
    contextKey: string;
    assistanceOperation: string;
    portContractVersion: number;
  }): Promise<boolean> {
    // Deny by default: an absent key is a refusal, not a default-allow.
    const row = this.rows.get(InMemoryAssistanceGrantRepository.key(input));
    return row !== undefined && !row.revoked;
  }

  async grant(input: {
    organizationId: OrganizationId;
    secretaryPrincipalId: string;
    contextKey: string;
    assistanceOperation: string;
    portContractVersion: number;
  }): Promise<void> {
    this.rows.set(InMemoryAssistanceGrantRepository.key(input), { revoked: false });
  }

  /** Revoke, so a test can prove the check is consulted every time. */
  revoke(input: {
    organizationId: OrganizationId;
    secretaryPrincipalId: string;
    contextKey: string;
    assistanceOperation: string;
    portContractVersion: number;
  }): void {
    this.rows.set(InMemoryAssistanceGrantRepository.key(input), { revoked: true });
  }
}

export class InMemorySecretaryContributionRepository
  implements SecretaryContributionRepository
{
  private readonly rows = new Map<string, SecretaryContribution & { organizationId: OrganizationId }>();

  async append(input: {
    contributionId: string;
    organizationId: OrganizationId;
    decisionId: DecisionId;
    decisionRevisionId: string;
    secretaryPrincipalId: string;
    requestedByIdentityId: IdentityId;
    requestedByMembershipId: MembershipId;
    contributionType: ContributionType;
    content: string;
    generationId: string;
    now: Date;
  }): Promise<void> {
    this.rows.set(input.contributionId, {
      contributionId: input.contributionId,
      decisionId: input.decisionId,
      decisionRevisionId: input.decisionRevisionId,
      secretaryPrincipalId: input.secretaryPrincipalId,
      requestedByMembershipId: input.requestedByMembershipId,
      contributionType: input.contributionType,
      content: input.content,
      createdAt: input.now,
      adoptedAt: null,
      adoptedByIdentityId: null,
      organizationId: input.organizationId,
    });
  }

  async listForDecision(
    organizationId: OrganizationId,
    decisionId: DecisionId,
  ): Promise<readonly SecretaryContribution[]> {
    return [...this.rows.values()]
      .filter((c) => c.organizationId === organizationId && c.decisionId === decisionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async markAdopted(input: {
    organizationId: OrganizationId;
    decisionId: DecisionId;
    contributionId: string;
    adoptedByIdentityId: IdentityId;
    now: Date;
  }): Promise<boolean> {
    const row = this.rows.get(input.contributionId);
    if (
      row === undefined ||
      row.organizationId !== input.organizationId ||
      row.decisionId !== input.decisionId ||
      row.adoptedAt !== null
    ) {
      return false;
    }
    this.rows.set(input.contributionId, {
      ...row,
      adoptedAt: input.now,
      adoptedByIdentityId: input.adoptedByIdentityId,
    });
    return true;
  }
}

/**
 * The audit store, as a test can inspect it.
 *
 * Append-only like the real one: there is no method here that updates or
 * deletes, so a test cannot accidentally assert against a mutable record.
 */
export class InMemoryAuditRepository implements AuditRepository {
  readonly entries: AuditRecord[] = [];

  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }

  /** Transitions recorded for one resource, oldest first. */
  transitionsFor(resourceId: string): AuditRecord[] {
    return this.entries.filter(
      (e) => e.resourceId === resourceId && e.previousState !== null,
    );
  }
}

export class InMemoryOutbox implements OutboxPort {
  readonly events: DomainEvent[] = [];

  async append(events: readonly DomainEvent[]): Promise<void> {
    this.events.push(...events);
  }

  typesOf(): string[] {
    return this.events.map((e) => e.type);
  }
}

/**
 * A transaction that discards writes when the callback throws.
 *
 * Without rollback the atomic-activation test in ADR-0007 would pass
 * vacuously, so the snapshot/restore below is load-bearing rather than
 * convenience.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly bundle: RepositoryBundle & { outbox: InMemoryOutbox }) {}

  /**
   * Every repository in the bundle, seen as its backing map.
   *
   * Enumerated rather than listed by name so adding a repository to the bundle
   * cannot silently escape rollback — an omitted one would make a test pass by
   * leaving writes behind that a real transaction would have discarded.
   */
  private stores(): Map<string, unknown>[] {
    return Object.values(this.bundle)
      .map((repository) => (repository as { rows?: Map<string, unknown> }).rows)
      .filter((rows): rows is Map<string, unknown> => rows instanceof Map);
  }

  async transaction<T>(fn: (tx: RepositoryBundle) => Promise<T>): Promise<T> {
    const stores = this.stores();
    const snapshot = stores.map((rows) => new Map(rows));
    const events = [...this.bundle.outbox.events];

    try {
      return await fn(this.bundle);
    } catch (error) {
      stores.forEach((rows, index) => {
        rows.clear();
        for (const [key, value] of snapshot[index]!) rows.set(key, value);
      });
      this.bundle.outbox.events.length = 0;
      this.bundle.outbox.events.push(...events);
      throw error;
    }
  }
}

export class FixedClock implements Clock {
  constructor(private readonly value: Date) {}
  now(): Date {
    return this.value;
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  workId(): WorkId {
    return `work-${++this.n}` as WorkId;
  }
  decisionId(): DecisionId {
    return `decision-${++this.n}` as DecisionId;
  }
  memoryId(): MemoryId {
    return `memory-${++this.n}` as MemoryId;
  }
  membershipId(): MembershipId {
    return `membership-${++this.n}` as MembershipId;
  }
  notificationId(): string {
    return `notification-${++this.n}`;
  }
  grantId(): string {
    return `grant-${++this.n}`;
  }
  contributionId(): string {
    return `contribution-${++this.n}`;
  }
  generationId(): string {
    return `generation-${++this.n}`;
  }
  invitationId(): InvitationId {
    return `invitation-${++this.n}` as InvitationId;
  }
  identityId(): IdentityId {
    return `identity-${++this.n}` as IdentityId;
  }
  organizationId(): OrganizationId {
    return `organization-${++this.n}` as OrganizationId;
  }
  roleAssignmentId(): string {
    return `role-assignment-${++this.n}`;
  }
  deadLetterId(): string {
    return `dead-letter-${++this.n}`;
  }
  replayId(): string {
    return `replay-${++this.n}`;
  }
  workParticipantId(): string {
    return `participant-${++this.n}`;
  }
  workProgressRecordId(): string {
    return `progress-${++this.n}`;
  }
  revisionId(): string {
    return `revision-${++this.n}`;
  }
}

export const buildTestHarness = (now = new Date("2026-07-28T10:00:00Z")) => {
  const work = new InMemoryWorkRepository();
  const decisions = new InMemoryDecisionRepository();
  const memories = new InMemoryMemoryRepository();
  const generationOperations = new InMemoryGenerationOperationRepository();
  const eventRecovery = new InMemoryEventRecoveryRepository();
  const deliveries = new InMemoryConsumerDeliveryRepository();
  const replays = new InMemoryReplayRepository();
  const memberships = new InMemoryMembershipRepository();
  const organizations = new InMemoryOrganizationRepository(memberships);
  const notifications = new InMemoryNotificationRepository();
  const assistanceGrants = new InMemoryAssistanceGrantRepository();
  const contributions = new InMemorySecretaryContributionRepository();
  const identities = new InMemoryIdentityRepository();
  const outbox = new InMemoryOutbox();
  const audit = new InMemoryAuditRepository();
  const bundle = {
    organizations,
    work,
    decisions,
    memories,
    generationOperations,
    eventRecovery,
    deliveries,
    replays,
    memberships,
    notifications,
    assistanceGrants,
    contributions,
    identities,
    outbox,
  };

  return {
    ...bundle,
    audit,
    deps: {
      uow: new InMemoryUnitOfWork(bundle),
      clock: new FixedClock(now),
      ids: new SequentialIds(),
      audit,
    },
  };
};
