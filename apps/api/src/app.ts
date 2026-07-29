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

import {
  DecisionId,
  IdentityId,
  InvitationId,
  MembershipId,
  MemoryId,
  WorkId,
} from "@aios/types";
import type { Clock, IdGenerator, UseCaseDependencies } from "@aios/application";
import { PostgresUnitOfWork } from "@aios/persistence";

import { AdminEventsController } from "./admin-events.controller.js";
import { chooseGenerator } from "./anthropic-memory-generator.js";
import { DecisionController } from "./decision.controller.js";
import { InvitationController } from "./invitation.controller.js";
import { MemoryController } from "./memory.controller.js";
import { OrganizationMemberController } from "./organization.controller.js";
import { DevAuthAdapter } from "./dev-auth.js";
import { DomainExceptionFilter } from "./http-errors.js";
import { PrincipalResolver } from "./principal-resolver.js";
import { startOutboxWorker } from "./outbox-worker.js";
import { RequestContextGuard, type AuthAdapter } from "./request-context.js";
import { USE_CASE_DEPENDENCIES } from "./tokens.js";
import { WorkController } from "./work.controller.js";

/**
 * The Secretary credited with generated Memory drafts.
 *
 * Seeded as a Human Identity row for now because `authentication_subjects` and
 * `human_identities` are the only identity tables that exist; the AI Principal
 * model that ADR-0011 describes is not yet persisted. The Memory records it as
 * an AI author regardless, so the attribution a reviewer sees is correct.
 */
export const SECRETARY_IDENTITY_ID = "0a105eed-0000-4000-8000-00000000c001";

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
  memoryId(): MemoryId {
    return MemoryId(randomUUID());
  }
  membershipId(): MembershipId {
    return MembershipId(randomUUID());
  }
  invitationId(): InvitationId {
    return InvitationId(randomUUID());
  }
  identityId(): IdentityId {
    return IdentityId(randomUUID());
  }
  workParticipantId(): string {
    return randomUUID();
  }
  workProgressRecordId(): string {
    return randomUUID();
  }
  revisionId(): string {
    return randomUUID();
  }
}

export interface AppOptions {
  readonly pool: Pool;
  readonly auth: AuthAdapter;
}

export const dependenciesFor = (pool: Pool): UseCaseDependencies => ({
  uow: new PostgresUnitOfWork(pool),
  clock: new SystemClock(),
  ids: new UuidGenerator(),
});

export const createApp = async (options: AppOptions): Promise<INestApplication> => {
  const deps = dependenciesFor(options.pool);

  const resolver = new PrincipalResolver(options.pool);

  @Module({
    controllers: [
      WorkController,
      DecisionController,
      MemoryController,
      OrganizationMemberController,
      InvitationController,
      AdminEventsController,
    ],
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

export const buildDevApp = async (connectionString: string) => {
  const pool = new Pool({ connectionString });
  const app = await createApp({ pool, auth: new DevAuthAdapter() });

  // The asynchronous halves of ADR-0007 and ADR-0008. Production runs these as
  // a separate worker; in development they poll in-process so a blocked Work
  // unblocks and a completed Work produces its Memory draft.
  const { generator, reason } = chooseGenerator(process.env);
  console.log(`Memory generation: ${reason}`);

  const stop = startOutboxWorker(pool, dependenciesFor(pool), 500, {
    memory: {
      generator,
      secretaryIdentityId: SECRETARY_IDENTITY_ID,
      systemPrincipalId: "memory-generator",
    },
  });
  app.enableShutdownHooks();
  process.once("beforeExit", stop);

  return app;
};
