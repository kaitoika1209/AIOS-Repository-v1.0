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
  OrganizationId,
  Permission,
  WorkId,
} from "@aios/types";
import type { DecisionState, DomainEvent, WorkState } from "@aios/domain";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  workId(): WorkId;
  decisionId(): DecisionId;
  /** Identifies one locked Decision revision snapshot. */
  snapshotId(): string;
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
