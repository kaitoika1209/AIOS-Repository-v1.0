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
  IdentityId,
  InvitationId,
  MemoryId,
  MembershipId,
  OrganizationId,
  WorkId,
} from "@aios/types";
import {
  VersionConflictError,
  currentInvitation,
  type DecisionState,
  type DomainEvent,
  type MemoryState,
  type MembershipState,
  type WorkState,
} from "@aios/domain";

import type {
  Clock,
  DecisionRepository,
  IdentityRecord,
  IdentityRepository,
  MemoryRepository,
  MembershipRepository,
  IdGenerator,
  OrganizationMemberSummary,
  OutboxPort,
  RepositoryBundle,
  UnitOfWork,
  WorkRepository,
} from "../ports.js";

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
  invitationId(): InvitationId {
    return `invitation-${++this.n}` as InvitationId;
  }
  identityId(): IdentityId {
    return `identity-${++this.n}` as IdentityId;
  }
  revisionId(): string {
    return `revision-${++this.n}`;
  }
}

export const buildTestHarness = (now = new Date("2026-07-28T10:00:00Z")) => {
  const work = new InMemoryWorkRepository();
  const decisions = new InMemoryDecisionRepository();
  const memories = new InMemoryMemoryRepository();
  const memberships = new InMemoryMembershipRepository();
  const identities = new InMemoryIdentityRepository();
  const outbox = new InMemoryOutbox();
  const bundle = { work, decisions, memories, memberships, identities, outbox };

  return {
    ...bundle,
    deps: {
      uow: new InMemoryUnitOfWork(bundle),
      clock: new FixedClock(now),
      ids: new SequentialIds(),
    },
  };
};
