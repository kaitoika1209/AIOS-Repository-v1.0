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

import { PostgresDecisionRepository } from "./decision-repository.js";
import { PostgresOutbox } from "./outbox.js";
import { PostgresWorkRepository } from "./work-repository.js";

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: RepositoryBundle) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await fn({
        work: new PostgresWorkRepository(client),
        decisions: new PostgresDecisionRepository(client),
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
