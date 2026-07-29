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
import { activeParticipantsOf, type WorkState } from "@aios/domain";

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
