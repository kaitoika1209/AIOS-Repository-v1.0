/**
 * PostgreSQL unit of work.
 *
 * One use case, one transaction. State changes and their Outbox rows commit
 * together or not at all, which is the guarantee ADR-0006 depends on.
 *
 * The Decision repository is deliberately absent: see `decision-repository.md`
 * note in ADR-0015's follow-up. Only Work is persisted so far.
 */

import type { Pool, PoolClient } from "pg";

import type { UnitOfWork } from "@aios/application";

import { PostgresOutbox } from "./outbox.js";
import { PostgresWorkRepository } from "./work-repository.js";

export interface WorkOnlyBundle {
  readonly work: PostgresWorkRepository;
  readonly outbox: PostgresOutbox;
}

export class PostgresUnitOfWork {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(fn: (tx: WorkOnlyBundle) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const result = await fn({
        work: new PostgresWorkRepository(client),
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

/** Narrowing helper so the partial bundle can satisfy `UnitOfWork` in tests. */
export type PartialUnitOfWork = Pick<UnitOfWork, "transaction">;
