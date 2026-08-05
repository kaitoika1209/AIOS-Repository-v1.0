/**
 * PostgreSQL unit of work.
 *
 * One use case, one transaction. Aggregate state and its Outbox rows commit
 * together or not at all, which is the guarantee ADR-0006 depends on: an event
 * can never exist without the state change that produced it.
 *
 * Repositories are constructed per transaction and share the one client, so
 * every statement in a use case runs inside the same transaction.
 */

import type { Pool, PoolClient } from "pg";

import type { RepositoryBundle, UnitOfWork } from "@aios/application";

import {
  PostgresAssistanceGrantRepository,
  PostgresSecretaryContributionRepository,
} from "./assistance-repository.js";
import { PostgresConsumerDeliveryRepository } from "./consumer-delivery-repository.js";
import { PostgresWorkerPauseRepository } from "./worker-pause-repository.js";
import { PostgresWorkflowHealthQuery } from "./workflow-health-query.js";
import { PostgresDecisionRepository } from "./decision-repository.js";
import { PostgresReplayRepository } from "./replay-repository.js";
import { PostgresEventRecoveryRepository } from "./event-recovery-repository.js";
import { PostgresGenerationOperationRepository } from "./generation-operation-repository.js";
import {
  PostgresIdentityRepository,
  PostgresMembershipRepository,
} from "./membership-repository.js";
import { PostgresMemoryRepository } from "./memory-repository.js";
import { PostgresNotificationRepository } from "./notification-repository.js";
import { PostgresOrganizationRepository } from "./organization-repository.js";
import { PostgresOutbox } from "./outbox.js";
import { PostgresWorkRepository } from "./work-repository.js";

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: RepositoryBundle) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await fn({
        organizations: new PostgresOrganizationRepository(client),
        work: new PostgresWorkRepository(client),
        decisions: new PostgresDecisionRepository(client),
        memories: new PostgresMemoryRepository(client),
        generationOperations: new PostgresGenerationOperationRepository(client),
        eventRecovery: new PostgresEventRecoveryRepository(client),
        deliveries: new PostgresConsumerDeliveryRepository(client),
        replays: new PostgresReplayRepository(client),
        memberships: new PostgresMembershipRepository(client),
        notifications: new PostgresNotificationRepository(client),
        assistanceGrants: new PostgresAssistanceGrantRepository(client),
        contributions: new PostgresSecretaryContributionRepository(client),
        identities: new PostgresIdentityRepository(client),
        workflowHealth: new PostgresWorkflowHealthQuery(client),
        workerPauses: new PostgresWorkerPauseRepository(client),
        outbox: new PostgresOutbox(client),
      });

      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
