/**
 * Composition root.
 *
 * Wiring lives here so the layers below stay free of framework and driver
 * types: controllers receive `UseCaseDependencies`, and the concrete
 * PostgreSQL adapters are chosen once, at the edge.
 */

import { randomUUID } from "node:crypto";

import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Pool } from "pg";

import { DecisionId, WorkId } from "@aios/types";
import type { Clock, IdGenerator, UseCaseDependencies } from "@aios/application";
import { PostgresUnitOfWork } from "@aios/persistence";

import { DecisionController } from "./decision.controller.js";
import { DevAuthAdapter } from "./dev-auth.js";
import { DomainExceptionFilter } from "./http-errors.js";
import { PrincipalResolver } from "./principal-resolver.js";
import { RequestContextGuard, type AuthAdapter } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";
import { WorkController } from "./work.controller.js";

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * UUIDs throughout: the schema types every identifier column as `uuid`,
 * including the submitted-revision id Work stores in its completion gate.
 */
class UuidGenerator implements IdGenerator {
  workId(): WorkId {
    return WorkId(randomUUID());
  }
  decisionId(): DecisionId {
    return DecisionId(randomUUID());
  }
  revisionId(): string {
    return randomUUID();
  }
}

export interface AppOptions {
  readonly pool: Pool;
  readonly auth: AuthAdapter;
}

export const createApp = async (options: AppOptions): Promise<INestApplication> => {
  const deps: UseCaseDependencies = {
    uow: new PostgresUnitOfWork(options.pool),
    clock: new SystemClock(),
    ids: new UuidGenerator(),
  };

  const resolver = new PrincipalResolver(options.pool);

  @Module({
    controllers: [WorkController, DecisionController],
    providers: [{ provide: USE_CASE_DEPENDENCIES, useValue: deps }],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { logger: false });

  // The guard runs before every handler, so no route can be reached without a
  // resolved principal (ADR-0013).
  app.useGlobalGuards(new RequestContextGuard(options.auth, resolver));
  app.useGlobalFilters(new DomainExceptionFilter());

  return app;
};

export const buildDevApp = async (connectionString: string) =>
  createApp({ pool: new Pool({ connectionString }), auth: new DevAuthAdapter() });
