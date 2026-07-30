/**
 * Work use cases.
 *
 * Each function is one Application Service: it checks the permission, opens the
 * transaction, loads the Aggregate, lets the Aggregate decide, then persists
 * state and events together.
 *
 * The Aggregate decides whether a transition is valid. These services never
 * re-implement that rule — they coordinate.
 */

import { isHumanMember, type MembershipId, type OrganizationId, type WorkId } from "@aios/types";
import {
  addParticipant,
  assigneeOf,
  assignMember,
  activeParticipantsOf,
  cancelWork,
  completeWork,
  createWork,
  recordProgress,
  removeParticipant,
  startWork,
  unassignMember,
  updateWorkDetails,
  type ActorContext,
  type WorkState,
} from "@aios/domain";

import { recordTransition } from "./audit.js";
import { requirePermission } from "./authorization.js";
import { requireWorkRelationship } from "./relationships.js";
import {
  NotFoundError,
  type RepositoryBundle,
  type UseCaseDependencies,
} from "./ports.js";

export interface WorkCommandContext extends ActorContext {
  readonly organizationId: OrganizationId;
}

const loadWork = async (
  tx: { work: { findById: (o: OrganizationId, w: WorkId) => Promise<WorkState | null> } },
  organizationId: OrganizationId,
  workId: WorkId,
): Promise<WorkState> => {
  const work = await tx.work.findById(organizationId, workId);
  if (work === null) {
    throw new NotFoundError("Work");
  }
  return work;
};

/**
 * Record a Work lifecycle transition.
 *
 * The edge interceptor records that the command was allowed; only here are both
 * states known. `mvp.md` requires previous and next state on every important
 * business transition, and a status change is what makes one important.
 */
const auditWorkTransition = (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  before: WorkState,
  after: WorkState,
  permission: string,
  commandType: string,
): void => {
  if (before.status === after.status) return;
  recordTransition(deps.audit, {
    organizationId: ctx.organizationId,
    identityId: isHumanMember(ctx.principal) ? ctx.principal.identityId : null,
    membershipId: isHumanMember(ctx.principal) ? ctx.principal.membershipId : null,
    commandType,
    permission,
    resourceType: "Work",
    resourceId: after.workId,
    previousState: before.status,
    nextState: after.status,
    now: ctx.now,
  });
};

export const createWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  input: { readonly title: string; readonly description?: string | null },
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.create");

  return deps.uow.transaction(async (tx) => {
    const { state, events } = createWork(
      {
        workId: deps.ids.workId(),
        organizationId: ctx.organizationId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      ctx,
    );

    await tx.work.insert(state);
    await tx.outbox.append(events);
    return state;
  });
};

/**
 * Edit the Work's own details.
 *
 * `PATCH`, not a command sub-resource: this changes what the Work says it is,
 * never what state it is in (ADR-0014).
 */
export const editWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
  changes: { readonly title?: string; readonly description?: string | null },
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.edit");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    // "UpdateWorkDetails | Creator, Assignee, or Admin".
    requireWorkRelationship(ctx.principal, current, [
      "Creator",
      "Assignee",
      "Administrator",
    ]);
    const { state, events } = updateWorkDetails(current, changes, ctx);

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const startWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.start");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    // "StartWork | Assignee, Creator, or Admin".
    requireWorkRelationship(ctx.principal, current, [
      "Assignee",
      "Creator",
      "Administrator",
    ]);
    const { state, events } = startWork(current, ctx);

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    auditWorkTransition(deps, ctx, current, state, "work.start", "StartWork");
    return state;
  });
};

/**
 * Complete Work.
 *
 * `WorkCompleted` is the durable trigger for Memory generation (ADR-0008). It
 * is appended to the Outbox in this transaction; generation happens later, in a
 * separate process, and cannot roll this transaction back.
 */
export const completeWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
  completionSummary: string,
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.complete");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    // "CompleteWork | Assignee, Creator, or Admin".
    requireWorkRelationship(ctx.principal, current, [
      "Assignee",
      "Creator",
      "Administrator",
    ]);
    const { state, events } = completeWork(current, completionSummary, ctx);

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    auditWorkTransition(deps, ctx, current, state, "work.complete", "CompleteWork");
    return state;
  });
};

export const cancelWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
  reason: string,
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.cancel");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    // "CancelWork | Creator, Admin, or Owner".
    requireWorkRelationship(ctx.principal, current, ["Creator", "Administrator"]);
    const { state, events } = cancelWork(current, reason, ctx);

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    auditWorkTransition(deps, ctx, current, state, "work.cancel", "CancelWork");
    return state;
  });
};

/**
 * Set the Work's assignee and participant set in one request.
 *
 * ADR-0014 allows `work.assign` exactly one route, and the permission covers
 * four Aggregate commands. Declaring the desired relationships rather than
 * naming an operation is what reconciles the two: the service computes the
 * delta and issues only the commands it implies, so `AssignMember`,
 * `UnassignMember`, `AddParticipant`, and `RemoveParticipant` all remain
 * distinct in the Aggregate and in the event stream.
 *
 * Each command is authorized separately, because the matrix does not give them
 * the same required relationship: changing the assignee is Creator or Admin,
 * while changing participants is also open to the Assignee.
 */
export const assignWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
  desired: {
    readonly assigneeMembershipId?: MembershipId | null;
    readonly participantMembershipIds?: readonly MembershipId[];
  },
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.assign");

  return deps.uow.transaction(async (tx) => {
    const original = await loadWork(tx, ctx.organizationId, workId);
    let current = original;
    const events = [];

    if (desired.assigneeMembershipId !== undefined) {
      // "AssignMember / UnassignMember | Creator, Admin, or Owner".
      requireWorkRelationship(ctx.principal, current, ["Creator", "Administrator"]);

      const target = desired.assigneeMembershipId;
      if (target !== null) {
        await requireActiveMember(tx, ctx.organizationId, target);
      }

      if (assigneeOf(current) !== target) {
        const result =
          target === null
            ? unassignMember(current, ctx)
            : assignMember(
                current,
                { participantId: deps.ids.workParticipantId(), membershipId: target },
                ctx,
              );
        current = result.state;
        events.push(...result.events);
      }
    }

    if (desired.participantMembershipIds !== undefined) {
      // "AddParticipant / RemoveParticipant | Creator, Assignee, or Admin".
      requireWorkRelationship(ctx.principal, current, [
        "Creator",
        "Assignee",
        "Administrator",
      ]);

      const wanted = new Set(desired.participantMembershipIds);
      const held = new Set(
        activeParticipantsOf(current)
          .filter((p) => p.relationshipType === "Participant")
          .map((p) => p.membershipId),
      );

      for (const membershipId of held) {
        if (wanted.has(membershipId)) continue;
        const result = removeParticipant(current, membershipId, ctx);
        current = result.state;
        events.push(...result.events);
      }

      for (const membershipId of wanted) {
        if (held.has(membershipId)) continue;
        await requireActiveMember(tx, ctx.organizationId, membershipId);
        const result = addParticipant(
          current,
          { participantId: deps.ids.workParticipantId(), membershipId },
          ctx,
        );
        current = result.state;
        events.push(...result.events);
      }
    }

    // A request that asks for the state the Work is already in changes nothing
    // and advances no version. Unlike an edit, there is no content here that a
    // stale `If-Match` could silently overwrite.
    if (events.length === 0) {
      return current;
    }

    await tx.work.update(current, original.version);
    await tx.outbox.append(events);
    return current;
  });
};

/**
 * Validate that a target Membership exists, is Active, and is in this
 * Organization.
 *
 * The Aggregate document assigns this to the Application Layer explicitly —
 * "target Member reference is validated by the Application Layer" — because the
 * Work Aggregate must not load the Membership Aggregate to find out.
 *
 * Reported as `404`, not `422`. A Membership in another Organization must not be
 * distinguishable from one that does not exist.
 */
const requireActiveMember = async (
  tx: { memberships: { findById: RepositoryBundle["memberships"]["findById"] } },
  organizationId: OrganizationId,
  membershipId: MembershipId,
): Promise<void> => {
  const membership = await tx.memberships.findById(organizationId, membershipId);
  if (membership === null || membership.status !== "Active") {
    throw new NotFoundError("Member");
  }
};

/**
 * Append an attributable progress update.
 *
 * The only Work command whose required relationship excludes the Creator and
 * the Admin: "RecordProgress | Assignee or Participant". Progress is a claim
 * about work someone is doing, so the people entitled to make it are the people
 * doing it — an administrator watching from outside cannot report progress on
 * another Member's behalf.
 */
export const recordProgressUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
  content: string,
): Promise<WorkState> => {
  requirePermission(ctx.principal, "work.record_progress");

  return deps.uow.transaction(async (tx) => {
    const current = await loadWork(tx, ctx.organizationId, workId);
    requireWorkRelationship(ctx.principal, current, ["Assignee", "Participant"]);

    const { state, events } = recordProgress(
      current,
      { progressRecordId: deps.ids.workProgressRecordId(), content },
      ctx,
    );

    await tx.work.update(state, current.version);
    await tx.outbox.append(events);
    return state;
  });
};

export const getWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
  workId: WorkId,
): Promise<WorkState> =>
  deps.uow.transaction((tx) => loadWork(tx, ctx.organizationId, workId));

export const listWorkUseCase = async (
  deps: UseCaseDependencies,
  ctx: WorkCommandContext,
): Promise<readonly WorkState[]> =>
  deps.uow.transaction((tx) => tx.work.listByOrganization(ctx.organizationId));
