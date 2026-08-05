/**
 * Administrative Worker pause and resume (baseline item 9, ADR-0022).
 *
 * The typed Operations commands the baseline asks for. Before them, "pause the
 * Worker" meant `SIGTERM`, which stops every Organization the process serves and
 * cannot be narrowed — so none of the containment procedures in
 * `observability-and-operations.md` could be followed as written.
 *
 * Two scopes exist and only one of them is here. This is the Organization-scoped
 * half: a pause taken through a Membership, effective for that Organization
 * alone. The global half is deployment configuration (`deploymentPause` in
 * `apps/api/src/worker-pause-config.ts`) because `authorization.md` is explicit
 * that the MVP models no cross-Organization Human principal — an Owner of one
 * tenant must not be able to halt another's work.
 *
 * Pausing means **not claiming**. Nothing is begun and abandoned, no delivery is
 * recorded as attempted, no attempt counter moves. Rows stay `Pending` and are
 * claimed on the first drain after the resume. Checking the pause inside a
 * consumer instead would mark deliveries attempted that were never attempted,
 * corrupting the retry counts and pending ages that the rest of items 9 and 11
 * are built on.
 */

import { ValidationError } from "@aios/domain";
import { isHumanMember, type OrganizationId } from "@aios/types";

import { requirePermission } from "./authorization.js";
import type { UseCaseDependencies } from "./ports.js";
import type { WorkCommandContext } from "./work-use-cases.js";

/**
 * The Worker types an operator can pause.
 *
 * A subset of ADR-0021's `WORKFLOW_TYPES`, sharing its names so one vocabulary
 * covers both the health report and the command. The two it omits are omitted
 * because pausing them would do nothing: consumer delivery has no claim loop of
 * its own — it runs inside the Outbox drain, so `OutboxPublication` already is
 * its pause — and a dead letter is a durable record awaiting a decision, not a
 * Worker. Accepting a name that pauses nothing would let an operator believe
 * processing had stopped when it had not.
 */
export const PAUSABLE_WORKER_TYPES = ["OutboxPublication", "MemoryGeneration"] as const;
export type PausableWorkerType = (typeof PAUSABLE_WORKER_TYPES)[number];

export const isPausableWorkerType = (value: string): value is PausableWorkerType =>
  (PAUSABLE_WORKER_TYPES as readonly string[]).includes(value);

/** One Organization's pause of one Worker type. Its existence is the pause. */
export interface WorkerPause {
  readonly organizationId: OrganizationId;
  readonly workerType: PausableWorkerType;
  readonly pausedAt: Date;
  readonly pausedByIdentityId: string;
  readonly pausedByMembershipId: string;
  readonly reasonCode: string;
  readonly reason: string;
}

export interface PauseWorkerCommand {
  readonly workerType: PausableWorkerType;
  readonly reasonCode: string;
  /**
   * Why, in the operator's words.
   *
   * Required, never defaulted — the same rule `events.skip` follows. A pause
   * with no stated cause is a pause nobody else can safely lift, and pauses are
   * routinely lifted by someone other than the person who took them.
   */
  readonly reason: string;
}

/** Bounded so an operator cannot write a payload into operational state. */
const MAX_REASON = 500;
const MAX_REASON_CODE = 100;

const requireBounded = (value: string, field: string, max: number): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ValidationError(`${field} is required.`);
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters.`);
  }
  return trimmed;
};

/**
 * Suspend a Worker type's claiming for this Organization.
 *
 * The attribution comes from the resolved principal, never from the body: the
 * same rule that forbids a recovery request from naming its own Organization or
 * its own requester. A caller must not be able to influence what the durable
 * record says about who acted.
 *
 * Idempotent in the sense that matters operationally — pausing an already-paused
 * Worker leaves the original pause and its original reason intact rather than
 * overwriting them. The first pause is the one that explains the state, and an
 * operator repeating the command should not silently discard it.
 */
export const pauseWorkerUseCase = async (
  deps: UseCaseDependencies,
  context: WorkCommandContext,
  command: PauseWorkerCommand,
): Promise<WorkerPause> => {
  requirePermission(context.principal, "operations.pause_worker");

  // The command is Organization business authority, so it needs a Membership to
  // attribute — and the database agrees, through the composite foreign key that
  // ties the pause to a Membership in the Organization being paused.
  //
  // Unreachable through `requirePermission`, which grants the permission to no
  // non-Human role, and stated anyway so the rule is visible where it applies
  // rather than only where it is implemented.
  if (!isHumanMember(context.principal)) {
    throw new ValidationError("A pause must be attributed to a Human Member.");
  }
  const principal = context.principal;

  const pause: WorkerPause = {
    organizationId: context.organizationId,
    workerType: command.workerType,
    pausedAt: context.now,
    pausedByIdentityId: principal.identityId,
    pausedByMembershipId: principal.membershipId,
    reasonCode: requireBounded(command.reasonCode, "reasonCode", MAX_REASON_CODE),
    reason: requireBounded(command.reason, "reason", MAX_REASON),
  };

  return deps.uow.transaction((tx) => tx.workerPauses.pause(pause));
};

/**
 * Lift a pause.
 *
 * Resuming a Worker that is not paused succeeds and reports it. The alternative
 * — a 404 — would make an operator restoring service after an incident stop to
 * work out whether the pause had already been lifted, when the state they wanted
 * is the state they have.
 *
 * Resume does not replay. It stops excluding rows from the claim, and the
 * backlog drains in `recorded_at` order like any other backlog.
 */
export const resumeWorkerUseCase = async (
  deps: UseCaseDependencies,
  context: WorkCommandContext,
  workerType: PausableWorkerType,
): Promise<{ resumed: boolean }> => {
  requirePermission(context.principal, "operations.resume_worker");

  const resumed = await deps.uow.transaction((tx) =>
    tx.workerPauses.resume(context.organizationId, workerType),
  );

  return { resumed };
};
