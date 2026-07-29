/**
 * Step 6 of the policy evaluation algorithm: the required resource relationship.
 *
 * `docs/architecture/authorization.md` states the model in two halves —
 * "Role permissions are narrowed by relationships between the Human Member and
 * the target resource" — and specifies the division of labour precisely:
 *
 * > The resolver provides facts.
 * > The policy determines whether those facts grant permission.
 *
 * So `resolveWorkRelationships` answers only "how is this Member related to this
 * Work", and each use case names the relationships its row of the Work
 * Authorization Matrix allows. Nothing here decides policy on its own.
 *
 * Holding a permission is not enough and never was. A Member with `work.complete`
 * may complete Work they are assigned to or created — not any Work in the
 * Organization.
 */

import { isHumanMember, type Principal } from "@aios/types";
import {
  activeParticipantsOf,
  type DecisionState,
  type MemoryState,
  type WorkState,
} from "@aios/domain";

import { RelationshipRequiredError, isAdministrator } from "./authorization.js";

/**
 * The relationship names the document lists for Work.
 *
 * `None` from the document's example output is the empty set here. A Member is
 * routinely both Creator and Assignee, and collapsing that to a single "primary"
 * relationship would make "Creator, Assignee, or Admin" unanswerable without
 * deciding which one wins — a decision the document never asks for.
 */
export type WorkRelationship =
  | "Creator"
  | "Assignee"
  | "Participant"
  | "Administrator";

export const resolveWorkRelationships = (
  principal: Principal,
  work: WorkState,
): ReadonlySet<WorkRelationship> => {
  const found = new Set<WorkRelationship>();

  // A non-Human principal holds no relationship at all. It is not merely
  // unrelated: the relationships enumerated for Work are relationships a Human
  // Member has, and a System or AI Principal cannot acquire one.
  if (!isHumanMember(principal)) {
    return found;
  }

  if (work.createdByMembershipId === principal.membershipId) {
    found.add("Creator");
  }

  for (const participant of activeParticipantsOf(work)) {
    if (participant.membershipId !== principal.membershipId) continue;
    found.add(
      participant.relationshipType === "Assignee" ? "Assignee" : "Participant",
    );
  }

  if (isAdministrator(principal)) {
    found.add("Administrator");
  }

  return found;
};

/**
 * Refuse unless the actor holds one of the listed relationships.
 *
 * Called after `requirePermission` and after the Aggregate is loaded, matching
 * the documented order: permission (step 5), then relationship (step 6). The
 * Aggregate's own lifecycle validation runs after both.
 */
export const requireWorkRelationship = (
  principal: Principal,
  work: WorkState,
  allowed: readonly WorkRelationship[],
): void => {
  const held = resolveWorkRelationships(principal, work);
  if (!allowed.some((relationship) => held.has(relationship))) {
    throw new RelationshipRequiredError("Work", allowed);
  }
};

/**
 * The relationship names the document lists for Decision.
 *
 * `DecisionReviewer` is absent, and its absence is the finding rather than an
 * omission: nothing assigns a reviewer to a Decision in this release. The
 * Decision Authorization Matrix gives the review outcomes to "Reviewer, Admin,
 * or Owner", and all three are roles — so for `decision.approve`,
 * `decision.reject`, and `decision.withdraw` the relationship collapses into
 * the permission and step 6 has nothing left to narrow. Adding a
 * `DecisionReviewer` value that always resolved from a role would make the
 * check look like it was doing work it is not.
 */
export type DecisionRelationship = "Creator" | "Contributor" | "Administrator";

export const resolveDecisionRelationships = (
  principal: Principal,
  decision: DecisionState,
): ReadonlySet<DecisionRelationship> => {
  const found = new Set<DecisionRelationship>();

  if (!isHumanMember(principal)) {
    return found;
  }

  if (decision.createdByMembershipId === principal.membershipId) {
    found.add("Creator");
  }

  // A Contributor is someone who authored a revision. The Decision Aggregate
  // records that on every revision, so the relationship is a fact about the
  // Decision rather than a separate membership list to maintain.
  if (
    decision.revisions.some((r) => r.createdByMembershipId === principal.membershipId)
  ) {
    found.add("Contributor");
  }

  if (isAdministrator(principal)) {
    found.add("Administrator");
  }

  return found;
};

export const requireDecisionRelationship = (
  principal: Principal,
  decision: DecisionState,
  allowed: readonly DecisionRelationship[],
): void => {
  const held = resolveDecisionRelationships(principal, decision);
  if (!allowed.some((relationship) => held.has(relationship))) {
    throw new RelationshipRequiredError("Decision", allowed);
  }
};

/**
 * The relationship names the document lists for Memory.
 *
 * "Editor, related Work Member, or Admin" is the matrix row, and the middle
 * term is why Memory relationships need the source Work: a Memory is generated
 * from completed Work, and the people entitled to correct it are the people who
 * did that Work. `MemoryReviewer` is absent for the same reason
 * `DecisionReviewer` is.
 */
export type MemoryRelationship = "Editor" | "RelatedWorkMember" | "Administrator";

/**
 * @param sourceWork the Work the Memory was generated from, or null when it can
 * no longer be read. Null denies the `RelatedWorkMember` relationship rather
 * than granting it — an unreadable source is not evidence of a relationship.
 */
export const resolveMemoryRelationships = (
  principal: Principal,
  memory: MemoryState,
  sourceWork: WorkState | null,
): ReadonlySet<MemoryRelationship> => {
  const found = new Set<MemoryRelationship>();

  if (!isHumanMember(principal)) {
    return found;
  }

  // The generated first revision is authored by the Secretary, whose author
  // record carries no Membership. Only human edits can make anyone an Editor,
  // which is the correct reading: generation is not editing.
  if (
    memory.revisions.some(
      (r) =>
        r.author.actorType === "HumanMember" &&
        r.author.membershipId === principal.membershipId,
    )
  ) {
    found.add("Editor");
  }

  if (sourceWork !== null) {
    const onTheWork = resolveWorkRelationships(principal, sourceWork);
    // Administrator is excluded here deliberately: every Human Member resolves
    // it on every Work, so folding it in would make "related Work Member" true
    // for any Admin and silently erase the distinction the matrix draws.
    if (
      onTheWork.has("Creator") ||
      onTheWork.has("Assignee") ||
      onTheWork.has("Participant")
    ) {
      found.add("RelatedWorkMember");
    }
  }

  if (isAdministrator(principal)) {
    found.add("Administrator");
  }

  return found;
};

export const requireMemoryRelationship = (
  principal: Principal,
  memory: MemoryState,
  sourceWork: WorkState | null,
  allowed: readonly MemoryRelationship[],
): void => {
  const held = resolveMemoryRelationships(principal, memory, sourceWork);
  if (!allowed.some((relationship) => held.has(relationship))) {
    throw new RelationshipRequiredError("Memory", allowed);
  }
};
