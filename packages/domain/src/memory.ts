/**
 * The Memory Aggregate.
 *
 * Implements `docs/architecture/state-machines/memory.md` and
 * `docs/architecture/aggregates/memory.md`.
 *
 * A Memory begins as an AI-assisted draft and becomes authoritative
 * organizational history only after explicit human approval. Approval is
 * terminal and Approved content is immutable — history that can be quietly
 * rewritten is worse than none.
 *
 * A Memory is not Knowledge. Approval establishes trustworthy history; it does
 * not establish reusable guidance (ADR-0002).
 */

import type {
  AggregateVersion,
  IdentityId,
  MemoryId,
  MembershipId,
  MemoryStatus,
  OrganizationId,
  WorkId,
} from "@aios/types";
import { isHumanMember } from "@aios/types";

import {
  CrossOrganizationError,
  DomainError,
  HumanAuthorityRequiredError,
  InvalidTransitionError,
  ValidationError,
} from "./errors.js";
import { stampMemory, type MemoryEvent } from "./events.js";
import type { ActorContext, CommandResult } from "./work.js";

/** Mirrors the Memory state; a revision locks when it leaves `Generated`. */
export type MemoryRevisionStatus =
  | "Generated"
  | "Submitted"
  | "Rejected"
  | "Approved";

/**
 * Who wrote a revision.
 *
 * The first revision is written by the Secretary, so this is an actor
 * reference rather than an identity plus membership: an AI Principal holds no
 * Membership.
 */
export interface RevisionAuthor {
  readonly actorType: "HumanMember" | "AI" | "System";
  readonly actorId: IdentityId;
  readonly membershipId: MembershipId | null;
}

export interface MemoryRevision {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly status: MemoryRevisionStatus;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  /** Provenance for the generated content. Not Evidence in the Knowledge sense. */
  readonly sourceReferences: readonly string[];
  readonly author: RevisionAuthor;
  readonly contentHash: string;
  readonly createdAt: Date;
}

export interface MemoryReviewRecord {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly outcome: "Approved" | "Rejected";
  readonly reviewedByIdentityId: IdentityId;
  readonly reviewedByMembershipId: MembershipId;
  readonly reviewedAt: Date;
  readonly note: string;
}

/**
 * Provenance of the generation that produced the first revision.
 *
 * ADR-0012 requires a Memory to record what it was generated from, and
 * ADR-0008 requires the model and policy versions to travel with it.
 */
export interface GenerationProvenance {
  readonly sourceSnapshotId: string;
  readonly sourceSnapshotHash: string;
  readonly generationPolicyVersion: number;
  readonly generatedBySystemPrincipalId: string;
  readonly generatedAt: Date;
}

export interface MemoryState {
  readonly memoryId: MemoryId;
  readonly organizationId: OrganizationId;
  readonly sourceWorkId: WorkId;
  readonly status: MemoryStatus;
  /** One active Memory exists per completed Work; the database enforces it too. */
  readonly isActive: boolean;
  readonly provenance: GenerationProvenance;
  readonly revisions: readonly MemoryRevision[];
  readonly currentRevisionId: string;
  readonly submittedRevisionId: string | null;
  readonly reviewedRevisionId: string | null;
  readonly reviewRecords: readonly MemoryReviewRecord[];
  readonly version: AggregateVersion;
}

const requireHuman = (
  { principal }: ActorContext,
  command: string,
): { identityId: IdentityId; membershipId: MembershipId } => {
  if (!isHumanMember(principal)) {
    throw new HumanAuthorityRequiredError(command, principal.type);
  }
  return {
    identityId: principal.identityId,
    membershipId: principal.membershipId,
  };
};

const requireSameOrganization = (memory: MemoryState, ctx: ActorContext): void => {
  const actual =
    "organizationId" in ctx.principal ? ctx.principal.organizationId : undefined;
  if (actual !== memory.organizationId) {
    throw new CrossOrganizationError(
      memory.organizationId,
      String(actual),
      "Memory",
    );
  }
};

const requireStatus = (
  memory: MemoryState,
  command: string,
  allowed: readonly MemoryStatus[],
): void => {
  if (!allowed.includes(memory.status)) {
    throw new InvalidTransitionError("Memory", memory.status, command, allowed);
  }
};

const nextVersion = (v: AggregateVersion): AggregateVersion =>
  (v + 1) as AggregateVersion;

export const currentMemoryRevision = (m: MemoryState): MemoryRevision => {
  const revision = m.revisions.find((r) => r.revisionId === m.currentRevisionId);
  if (revision === undefined) {
    throw new DomainError(
      "MEMORY_INVALID_TRANSITION",
      "The Memory has no current revision.",
      { memoryId: m.memoryId },
    );
  }
  return revision;
};

export const memoryRevisionByNumber = (
  m: MemoryState,
  revisionNumber: number,
): MemoryRevision | null =>
  m.revisions.find((r) => r.revisionNumber === revisionNumber) ?? null;

const replaceRevision = (
  revisions: readonly MemoryRevision[],
  updated: MemoryRevision,
): readonly MemoryRevision[] =>
  revisions.map((r) => (r.revisionId === updated.revisionId ? updated : r));

export interface GeneratedContent {
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly sourceReferences: readonly string[];
  readonly contentHash: string;
}

export interface CreateGeneratedMemoryInput {
  readonly memoryId: MemoryId;
  readonly organizationId: OrganizationId;
  readonly sourceWorkId: WorkId;
  readonly revisionId: string;
  readonly generated: GeneratedContent;
  readonly provenance: GenerationProvenance;
  /** The Secretary that produced the draft. */
  readonly generatedBy: IdentityId;
}

/**
 * Create the generated Memory.
 *
 * Performed by a System Principal running the generation process, not by a
 * human — which is why this command does not require Human authority. The
 * resulting Memory carries no authority of its own until a human approves it.
 */
export const createGeneratedMemory = (
  input: CreateGeneratedMemoryInput,
  ctx: ActorContext,
): CommandResult<MemoryState, MemoryEvent> => {
  if (input.generated.title.trim().length === 0) {
    throw new ValidationError("Generated Memory requires a title.", {
      field: "title",
    });
  }

  const revision: MemoryRevision = {
    revisionId: input.revisionId,
    revisionNumber: 1,
    status: "Generated",
    title: input.generated.title.trim(),
    summary: input.generated.summary.trim(),
    content: input.generated.content,
    sourceReferences: input.generated.sourceReferences,
    author: {
      actorType: "AI",
      actorId: input.generatedBy,
      membershipId: null,
    },
    contentHash: input.generated.contentHash,
    createdAt: ctx.now,
  };

  const state: MemoryState = {
    memoryId: input.memoryId,
    organizationId: input.organizationId,
    sourceWorkId: input.sourceWorkId,
    status: "Generated",
    isActive: true,
    provenance: input.provenance,
    revisions: [revision],
    currentRevisionId: revision.revisionId,
    submittedRevisionId: null,
    reviewedRevisionId: null,
    reviewRecords: [],
    version: 1 as AggregateVersion,
  };

  return {
    state,
    events: stampMemory(state.version, [
      {
        type: "MemoryGenerated",
        memoryId: state.memoryId,
        sourceWorkId: state.sourceWorkId,
        organizationId: state.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: input.generatedBy,
        actorMembershipId: null,
      },
    ]),
  };
};

/**
 * Correct the generated draft before review.
 *
 * Editing in `Generated` updates the current revision rather than creating a
 * new one: the state machine is explicit that draft correction does not create
 * a separate revision object.
 */
export const editGeneratedMemory = (
  memory: MemoryState,
  changes: {
    readonly title?: string;
    readonly summary?: string;
    readonly content?: string;
  },
  contentHash: string,
  ctx: ActorContext,
): CommandResult<MemoryState, MemoryEvent> => {
  requireHuman(ctx, "memory.edit_generated");
  requireSameOrganization(memory, ctx);
  requireStatus(memory, "memory.edit_generated", ["Generated"]);

  const revision = currentMemoryRevision(memory);
  const updated: MemoryRevision = {
    ...revision,
    title: changes.title === undefined ? revision.title : changes.title.trim(),
    summary:
      changes.summary === undefined ? revision.summary : changes.summary.trim(),
    content: changes.content === undefined ? revision.content : changes.content,
    contentHash,
  };

  if (updated.title.length === 0) {
    throw new ValidationError("Memory requires a title.", { field: "title" });
  }

  return {
    state: {
      ...memory,
      revisions: replaceRevision(memory.revisions, updated),
      version: nextVersion(memory.version),
    },
    events: [],
  };
};

/** Submit for review. Locks the revision under review. */
export const submitMemoryForReview = (
  memory: MemoryState,
  ctx: ActorContext,
): CommandResult<MemoryState, MemoryEvent> => {
  const actor = requireHuman(ctx, "memory.submit");
  requireSameOrganization(memory, ctx);
  requireStatus(memory, "memory.submit", ["Generated"]);

  const submitted: MemoryRevision = { ...currentMemoryRevision(memory), status: "Submitted" };

  return {
    state: {
      ...memory,
      status: "InReview",
      revisions: replaceRevision(memory.revisions, submitted),
      submittedRevisionId: submitted.revisionId,
      version: nextVersion(memory.version),
    },
    events: stampMemory(nextVersion(memory.version), [
      {
        type: "MemorySubmittedForReview",
        memoryId: memory.memoryId,
        sourceWorkId: memory.sourceWorkId,
        revisionNumber: submitted.revisionNumber,
        organizationId: memory.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/**
 * Approve. Human-only, and terminal.
 *
 * Approved Memory becomes the organization's authoritative record of the
 * completed Work and can never be edited again.
 */
export const approveMemory = (
  memory: MemoryState,
  note: string,
  ctx: ActorContext,
): CommandResult<MemoryState, MemoryEvent> => {
  const actor = requireHuman(ctx, "memory.approve");
  requireSameOrganization(memory, ctx);
  requireStatus(memory, "memory.approve", ["InReview"]);

  const revision = currentMemoryRevision(memory);
  const approved: MemoryRevision = { ...revision, status: "Approved" };

  return {
    state: {
      ...memory,
      status: "Approved",
      revisions: replaceRevision(memory.revisions, approved),
      reviewedRevisionId: revision.revisionId,
      reviewRecords: [
        ...memory.reviewRecords,
        {
          revisionId: revision.revisionId,
          revisionNumber: revision.revisionNumber,
          outcome: "Approved",
          reviewedByIdentityId: actor.identityId,
          reviewedByMembershipId: actor.membershipId,
          reviewedAt: ctx.now,
          note: note.trim(),
        },
      ],
      version: nextVersion(memory.version),
    },
    events: stampMemory(nextVersion(memory.version), [
      {
        type: "MemoryApproved",
        memoryId: memory.memoryId,
        sourceWorkId: memory.sourceWorkId,
        revisionNumber: revision.revisionNumber,
        organizationId: memory.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/** Reject. Human-only. Non-terminal: the draft may be reopened. */
export const rejectMemory = (
  memory: MemoryState,
  note: string,
  ctx: ActorContext,
): CommandResult<MemoryState, MemoryEvent> => {
  const actor = requireHuman(ctx, "memory.reject");
  requireSameOrganization(memory, ctx);
  requireStatus(memory, "memory.reject", ["InReview"]);

  if (note.trim().length === 0) {
    throw new ValidationError("Rejecting a Memory requires a note.", {
      field: "note",
    });
  }

  const revision = currentMemoryRevision(memory);
  const rejected: MemoryRevision = { ...revision, status: "Rejected" };

  return {
    state: {
      ...memory,
      status: "Rejected",
      revisions: replaceRevision(memory.revisions, rejected),
      submittedRevisionId: null,
      reviewedRevisionId: revision.revisionId,
      reviewRecords: [
        ...memory.reviewRecords,
        {
          revisionId: revision.revisionId,
          revisionNumber: revision.revisionNumber,
          outcome: "Rejected",
          reviewedByIdentityId: actor.identityId,
          reviewedByMembershipId: actor.membershipId,
          reviewedAt: ctx.now,
          note: note.trim(),
        },
      ],
      version: nextVersion(memory.version),
    },
    events: stampMemory(nextVersion(memory.version), [
      {
        type: "MemoryRejected",
        memoryId: memory.memoryId,
        sourceWorkId: memory.sourceWorkId,
        revisionNumber: revision.revisionNumber,
        organizationId: memory.organizationId,
        occurredAt: ctx.now,
        actorIdentityId: actor.identityId,
        actorMembershipId: actor.membershipId,
      },
    ]),
  };
};

/**
 * Reopen a rejected Memory for revision.
 *
 * Creates the next revision from the rejected one rather than reopening it, so
 * the rejected content stays as review evidence.
 */
export const reopenMemory = (
  memory: MemoryState,
  revisionId: string,
  ctx: ActorContext,
): CommandResult<MemoryState, MemoryEvent> => {
  const actor = requireHuman(ctx, "memory.reopen");
  requireSameOrganization(memory, ctx);
  requireStatus(memory, "memory.reopen", ["Rejected"]);

  const previous = currentMemoryRevision(memory);
  const next: MemoryRevision = {
    revisionId,
    revisionNumber: previous.revisionNumber + 1,
    status: "Generated",
    title: previous.title,
    summary: previous.summary,
    content: previous.content,
    sourceReferences: previous.sourceReferences,
    author: {
      actorType: "HumanMember",
      actorId: actor.identityId,
      membershipId: actor.membershipId,
    },
    contentHash: previous.contentHash,
    createdAt: ctx.now,
  };

  return {
    state: {
      ...memory,
      status: "Generated",
      revisions: [...memory.revisions, next],
      currentRevisionId: next.revisionId,
      submittedRevisionId: null,
      reviewedRevisionId: null,
      version: nextVersion(memory.version),
    },
    events: [],
  };
};
