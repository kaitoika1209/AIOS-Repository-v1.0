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
import type { Pool } from "pg";

import {
  DecisionId,
  IdentityId,
  InvitationId,
  MembershipId,
  MemoryId,
  OrganizationId,
  WorkId,
} from "@aios/types";
import type { Clock, IdGenerator, UseCaseDependencies } from "@aios/application";
import { getLogger } from "@aios/application";
import { PostgresAuditRepository, PostgresUnitOfWork, createPool } from "@aios/persistence";

import { AdminEventsController } from "./admin-events.controller.js";
import { DiagnosticsController } from "./diagnostics.controller.js";
import { WorkersController } from "./workers.controller.js";
import { WorkflowHealthController } from "./workflow-health.controller.js";
import { AuditInterceptor } from "./audit-interceptor.js";
import { metricsMiddleware } from "./metrics-middleware.js";
import { correlationMiddleware } from "./correlation-middleware.js";
import { chooseGenerator } from "./anthropic-memory-generator.js";
import { DecisionController } from "./decision.controller.js";
import { chooseDecisionAssistanceProvider } from "./decision-assistance-provider.js";
import { InvitationController } from "./invitation.controller.js";
import { MeController } from "./me.controller.js";
import { MemoryController } from "./memory.controller.js";
import { NotificationController } from "./notification.controller.js";
import { OrganizationAdminController } from "./organization-admin.controller.js";
import { OrganizationMemberController } from "./organization.controller.js";
import { ClerkAuthAdapter, clerkOptionsFrom } from "./clerk-auth.js";
import { DevAuthAdapter } from "./dev-auth.js";
import { DomainExceptionFilter } from "./http-errors.js";
import { PrincipalResolver } from "./principal-resolver.js";
import { startOutboxWorker } from "./outbox-worker.js";
import { RequestContextGuard, type AuthAdapter } from "./request-context.js";
import { DECISION_ASSISTANCE, USE_CASE_DEPENDENCIES } from "./tokens.js";
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
  notificationId(): string {
    return randomUUID();
  }
  grantId(): string {
    return randomUUID();
  }
  contributionId(): string {
    return randomUUID();
  }
  generationId(): string {
    return randomUUID();
  }
  invitationId(): InvitationId {
    return InvitationId(randomUUID());
  }
  identityId(): IdentityId {
    return IdentityId(randomUUID());
  }
  organizationId(): OrganizationId {
    return OrganizationId(randomUUID());
  }
  roleAssignmentId(): string {
    return randomUUID();
  }
  deadLetterId(): string {
    return randomUUID();
  }
  replayId(): string {
    return randomUUID();
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
  // Takes the pool, not a transaction client: an audit row must survive a
  // business transaction that rolls back.
  audit: new PostgresAuditRepository(pool),
});

export const createApp = async (options: AppOptions): Promise<INestApplication> => {
  const deps = dependenciesFor(options.pool);

  const resolver = new PrincipalResolver(options.pool);

  @Module({
    controllers: [
      WorkController,
      DecisionController,
      MemoryController,
      MeController,
      NotificationController,
      OrganizationAdminController,
      OrganizationMemberController,
      InvitationController,
      AdminEventsController,
      DiagnosticsController,
      WorkersController,
      WorkflowHealthController,
    ],
    providers: [
      { provide: USE_CASE_DEPENDENCIES, useValue: deps },
      {
        provide: DECISION_ASSISTANCE,
        useValue: chooseDecisionAssistanceProvider(process.env).provider,
      },
    ],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { logger: false });

  // Before the guard, and before everything else. Nest runs middleware first,
  // which is what makes the guard's own refusals correlated — an interceptor
  // would arrive after those audit rows were already written.
  app.use(correlationMiddleware);
  // Also middleware, and after correlation so a metric and a log line describe
  // the same request. It must run before the guard: a guard refusal never
  // reaches an interceptor, and those are the denials most worth counting.
  app.use(metricsMiddleware);

  // The guard runs before every handler, so no route can be reached without a
  // resolved principal (ADR-0013). It carries the audit store because Nest runs
  // guards before interceptors: the refusals it makes — steps 2 to 4 of the
  // Policy Evaluation Algorithm — never reach the interceptor below, and it is
  // the only place that can record them.
  app.useGlobalGuards(new RequestContextGuard(options.auth, resolver, deps.audit));
  // After the guard, so the resolved principal is available, and wrapping the
  // handler so the outcome is observed rather than predicted.
  app.useGlobalInterceptors(new AuditInterceptor(deps.audit));
  app.useGlobalFilters(new DomainExceptionFilter());

  return app;
};

/**
 * Choose the authentication adapter for an environment.
 *
 * Clerk when it is configured, the development stub only when it is not *and*
 * the environment permits one. There is no flag that selects the stub: an
 * environment that fails to configure Clerk in production must fail to start,
 * not fall back to an adapter that verifies nothing.
 */
export const chooseAuth = (
  env: NodeJS.ProcessEnv,
): { auth: AuthAdapter; reason: string } => {
  const clerk = clerkOptionsFrom(env);
  if (clerk !== null) {
    return {
      auth: new ClerkAuthAdapter(clerk),
      reason:
        clerk.jwtKey !== undefined && clerk.jwtKey.length > 0
          ? "Clerk (networkless, CLERK_JWT_KEY)"
          : "Clerk (JWKS fetched with CLERK_SECRET_KEY)",
    };
  }

  const environment = env["NODE_ENV"] ?? "development";
  if (environment !== "development" && environment !== "test") {
    throw new Error(
      "Clerk is not configured and the development auth adapter performs no " +
        `verification, so it must not run with NODE_ENV=${environment}. ` +
        "Set CLERK_JWT_KEY or CLERK_SECRET_KEY.",
    );
  }

  return { auth: new DevAuthAdapter(), reason: "development stub (no verification)" };
};

/**
 * Whether this API process also drains the Outbox.
 *
 * The observability baseline requires a separate Worker with its own liveness
 * and readiness, so in production it must not. Running it in-process there is
 * not unsafe — `FOR UPDATE SKIP LOCKED` and the per-consumer delivery claim make
 * concurrent drains correct — but it ties generation throughput to API replica
 * count and leaves no worker to pause independently.
 *
 * Shaped like `chooseAuth`: an explicit setting wins, and otherwise the
 * environment decides, with the reason logged rather than inferred.
 */
export const chooseWorkerMode = (
  env: NodeJS.ProcessEnv,
): { inProcess: boolean; reason: string } => {
  const explicit = env["WORKER_IN_PROCESS"];
  if (explicit === "true") {
    return { inProcess: true, reason: "in-process (WORKER_IN_PROCESS=true)" };
  }
  if (explicit === "false") {
    return { inProcess: false, reason: "separate process (WORKER_IN_PROCESS=false)" };
  }

  const environment = env["NODE_ENV"] ?? "development";
  return environment === "development" || environment === "test"
    ? { inProcess: true, reason: `in-process (NODE_ENV=${environment})` }
    : {
        inProcess: false,
        reason: `separate process (NODE_ENV=${environment}); run \`pnpm --filter @aios/api worker\``,
      };
};

export const buildDevApp = async (connectionString: string) => {
  const pool = createPool({ connectionString });
  const { auth, reason: authReason } = chooseAuth(process.env);
  getLogger().log({
    severity: "INFO",
    operationalLogName: "auth.adapter_selected",
    operationalLogClass: "Operations",
    operationalLogCategory: "Security",
    message: "Authentication adapter selected.",
    attributes: { "security.auth_adapter": authReason },
  });
  const app = await createApp({ pool, auth });

  // The asynchronous halves of ADR-0007 and ADR-0008. One process is convenient
  // in development and wrong in production, so the choice is explicit.
  const { inProcess, reason: workerReason } = chooseWorkerMode(process.env);
  getLogger().log({
    severity: "INFO",
    operationalLogName: "worker.mode_selected",
    operationalLogClass: "Operations",
    operationalLogCategory: "Operations",
    message: "Outbox worker mode selected.",
    attributes: { "worker.mode": workerReason },
  });

  app.enableShutdownHooks();

  if (inProcess) {
    const { generator, reason } = chooseGenerator(process.env);
    getLogger().log({
      severity: "INFO",
      operationalLogName: "ai.generator_selected",
      operationalLogClass: "Operations",
      operationalLogCategory: "Operations",
      message: "Memory generator selected.",
      attributes: { "ai.generator": reason },
    });

    const stop = startOutboxWorker(pool, dependenciesFor(pool), 500, {
      memory: {
        generator,
        secretaryIdentityId: SECRETARY_IDENTITY_ID,
        systemPrincipalId: "memory-generator",
      },
    });
    process.once("beforeExit", stop);
  }

  return app;
};
