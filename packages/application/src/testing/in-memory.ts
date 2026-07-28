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
  MemoryId,
  OrganizationId,
  WorkId,
} from "@aios/types";
import {
  VersionConflictError,
  type DecisionState,
  type DomainEvent,
  type MemoryState,
  type WorkState,
} from "@aios/domain";

import type {
  Clock,
  DecisionRepository,
  MemoryRepository,
  IdGenerator,
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

  async transaction<T>(fn: (tx: RepositoryBundle) => Promise<T>): Promise<T> {
    const snapshot = structuredClone({
      work: (this.bundle.work as unknown as { rows: Map<string, WorkState> }).rows,
      decisions: (this.bundle.decisions as unknown as { rows: Map<string, DecisionState> })
        .rows,
      memories: (this.bundle.memories as unknown as { rows: Map<string, MemoryState> })
        .rows,
      outbox: [...this.bundle.outbox.events],
    });

    try {
      return await fn(this.bundle);
    } catch (error) {
      const work = this.bundle.work as unknown as { rows: Map<string, WorkState> };
      const decisions = this.bundle.decisions as unknown as {
        rows: Map<string, DecisionState>;
      };
      work.rows.clear();
      for (const [k, v] of snapshot.work) work.rows.set(k, v);
      decisions.rows.clear();
      for (const [k, v] of snapshot.decisions) decisions.rows.set(k, v);
      const memories = this.bundle.memories as unknown as {
        rows: Map<string, MemoryState>;
      };
      memories.rows.clear();
      for (const [k, v] of snapshot.memories) memories.rows.set(k, v);
      this.bundle.outbox.events.length = 0;
      this.bundle.outbox.events.push(...snapshot.outbox);
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
  revisionId(): string {
    return `revision-${++this.n}`;
  }
}

export const buildTestHarness = (now = new Date("2026-07-28T10:00:00Z")) => {
  const work = new InMemoryWorkRepository();
  const decisions = new InMemoryDecisionRepository();
  const memories = new InMemoryMemoryRepository();
  const outbox = new InMemoryOutbox();
  const bundle = { work, decisions, memories, outbox };

  return {
    ...bundle,
    deps: {
      uow: new InMemoryUnitOfWork(bundle),
      clock: new FixedClock(now),
      ids: new SequentialIds(),
    },
  };
};
