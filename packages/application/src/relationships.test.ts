/**
 * Step 6 of the policy evaluation algorithm.
 *
 * The Work Authorization Matrix's "Required Relationship" column, asserted
 * through the use cases rather than against the resolver alone: the resolver
 * only reports facts, and a fact nobody consults enforces nothing.
 */

import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  type AggregateVersion,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

import { RelationshipRequiredError } from "./authorization.js";
import {
  resolveDecisionRelationships,
  resolveMemoryRelationships,
  resolveWorkRelationships,
} from "./relationships.js";
import {
  assignWorkUseCase,
  cancelWorkUseCase,
  completeWorkUseCase,
  createWorkUseCase,
  editWorkUseCase,
  recordProgressUseCase,
  startWorkUseCase,
} from "./work-use-cases.js";
import {
  createDecisionUseCase,
  editDecisionDraftUseCase,
} from "./decision-use-cases.js";
import type { MemoryState } from "@aios/domain";

import { buildTestHarness } from "./testing/in-memory.js";

const ORG = OrganizationId("org-1");
const NOW = new Date("2026-07-28T10:00:00Z");

const CREATOR = MembershipId("membership-creator");
const OTHER = MembershipId("membership-other");
const WORKER = MembershipId("membership-worker");

const principal = (
  membershipId: MembershipId,
  roles: Role[] = ["Member"],
): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId(`identity-${membershipId}`),
  membershipId,
  organizationId: ORG,
  roles,
});

const ctx = (membershipId: MembershipId, roles?: Role[]) => ({
  principal: principal(membershipId, roles),
  organizationId: ORG,
  now: NOW,
});

/**
 * A harness whose Memberships all exist and are Active.
 *
 * `assignWorkUseCase` validates the target Member, so a test about
 * relationships needs the targets to be real or it would be testing the
 * validation instead.
 */
const harness = async () => {
  const h = buildTestHarness(NOW);
  for (const membershipId of [CREATOR, OTHER, WORKER]) {
    await h.memberships.insert({
      membershipId,
      organizationId: ORG,
      identityId: IdentityId(`identity-${membershipId}`),
      status: "Active",
      roles: ["Member"],
      pendingInviteeEmail: null,
      invitations: [],
      invitedByIdentityId: null,
      invitedByMembershipId: null,
      invitedAt: NOW,
      activatedAt: NOW,
      revokedByIdentityId: null,
      revokedAt: null,
      revocationReason: null,
      version: 1 as AggregateVersion,
    });
  }
  const work = await createWorkUseCase(h.deps, ctx(CREATOR), { title: "Ship it" });
  return { ...h, workId: work.workId as WorkId };
};

describe("resolving Work relationships", () => {
  it("reports the creator", async () => {
    const h = await harness();
    const work = (await h.work.findById(ORG, h.workId))!;

    expect([...resolveWorkRelationships(principal(CREATOR), work)]).toEqual([
      "Creator",
    ]);
  });

  it("reports nothing for an unrelated Member", async () => {
    const h = await harness();
    const work = (await h.work.findById(ORG, h.workId))!;

    // The document's `None` output. An empty set, so "Creator, Assignee, or
    // Admin" is answerable without deciding which single relationship wins.
    expect([...resolveWorkRelationships(principal(OTHER), work)]).toEqual([]);
  });

  it("reports Administrator from the role alone", async () => {
    const h = await harness();
    const work = (await h.work.findById(ORG, h.workId))!;

    expect([
      ...resolveWorkRelationships(principal(OTHER, ["OrganizationAdmin"]), work),
    ]).toEqual(["Administrator"]);
  });

  it("reports both when a Member is creator and assignee", async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: CREATOR,
    });
    const work = (await h.work.findById(ORG, h.workId))!;

    expect([...resolveWorkRelationships(principal(CREATOR), work)].sort()).toEqual([
      "Assignee",
      "Creator",
    ]);
  });

  it("stops reporting a relationship once it has ended", async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: WORKER,
    });
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: null,
    });
    const work = (await h.work.findById(ORG, h.workId))!;

    // The row survives as history; the relationship does not.
    expect([...resolveWorkRelationships(principal(WORKER), work)]).toEqual([]);
    expect(work.participants).toHaveLength(1);
  });
});

describe("the relationship a command requires", () => {
  it("refuses an unrelated Member editing Work they hold the permission for", async () => {
    const h = await harness();

    // OTHER holds `work.edit` — every Member does. Permission alone is not
    // authorization, which is exactly what step 6 exists to enforce.
    await expect(
      editWorkUseCase(h.deps, ctx(OTHER), h.workId, { title: "Mine now" }),
    ).rejects.toBeInstanceOf(RelationshipRequiredError);
  });

  it("allows the assignee to edit", async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: WORKER,
    });

    const edited = await editWorkUseCase(h.deps, ctx(WORKER), h.workId, {
      title: "Renamed",
    });
    expect(edited.title).toBe("Renamed");
  });

  it("allows an Admin who is a stranger to the Work", async () => {
    const h = await harness();
    const edited = await editWorkUseCase(
      h.deps,
      ctx(OTHER, ["OrganizationAdmin"]),
      h.workId,
      { title: "Administered" },
    );
    expect(edited.title).toBe("Administered");
  });

  it.each([
    ["start", (h: Awaited<ReturnType<typeof harness>>) =>
      startWorkUseCase(h.deps, ctx(OTHER), h.workId)],
    ["complete", (h: Awaited<ReturnType<typeof harness>>) =>
      completeWorkUseCase(h.deps, ctx(OTHER), h.workId, "Done")],
  ])("refuses an unrelated Member trying to %s", async (_name, act) => {
    const h = await harness();
    await expect(act(h)).rejects.toBeInstanceOf(RelationshipRequiredError);
  });

  it("stops a Member cancelling at the permission, before the relationship", async () => {
    const h = await harness();

    // `work.cancel` belongs to Owner and Admin only, so everyone who holds it
    // is an Administrator and satisfies "Creator, Admin, or Owner" already.
    // Step 6 therefore never denies a cancel — step 5 does. Asserting the error
    // type keeps that true: if a Member is ever granted `work.cancel`, this
    // fails and the relationship rule has to be reconsidered deliberately.
    await expect(
      cancelWorkUseCase(h.deps, ctx(OTHER), h.workId, "Not mine"),
    ).rejects.toMatchObject({ name: "AuthorizationError" });

    await expect(
      cancelWorkUseCase(h.deps, ctx(OTHER, ["OrganizationOwner"]), h.workId, "Mine"),
    ).resolves.toBeDefined();
  });
});

describe("assignment through the use case", () => {
  it("refuses an assignee who is not an active Member", async () => {
    const h = await harness();

    await expect(
      assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
        assigneeMembershipId: MembershipId("membership-ghost"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("replaces the participant set rather than merging it", async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      participantMembershipIds: [WORKER, OTHER],
    });
    const after = await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      participantMembershipIds: [OTHER],
    });

    expect(
      after.participants.filter((p) => p.removedAt === null).map((p) => p.membershipId),
    ).toEqual([OTHER]);
  });

  it("emits one event per Member changed", async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: WORKER,
      participantMembershipIds: [OTHER],
    });

    expect(h.outbox.typesOf()).toEqual([
      "WorkCreated",
      "WorkAssignmentChanged",
      "WorkParticipantChanged",
    ]);
  });

  it("changes nothing when the request matches the current state", async () => {
    const h = await harness();
    const assigned = await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: WORKER,
    });
    const again = await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: WORKER,
    });

    // No command ran, so no version was spent and no event was emitted.
    expect(again.version).toBe(assigned.version);
    expect(h.outbox.typesOf()).toEqual(["WorkCreated", "WorkAssignmentChanged"]);
  });

  it("lets the assignee change participants but not the assignee", async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: WORKER,
    });

    // "AddParticipant | Creator, Assignee, or Admin".
    await expect(
      assignWorkUseCase(h.deps, ctx(WORKER), h.workId, {
        participantMembershipIds: [OTHER],
      }),
    ).resolves.toBeDefined();

    // "AssignMember | Creator, Admin, or Owner" — the Assignee is absent.
    await expect(
      assignWorkUseCase(h.deps, ctx(WORKER), h.workId, {
        assigneeMembershipId: OTHER,
      }),
    ).rejects.toBeInstanceOf(RelationshipRequiredError);
  });
});

describe("recording progress", () => {
  const started = async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      assigneeMembershipId: WORKER,
    });
    await startWorkUseCase(h.deps, ctx(CREATOR), h.workId);
    return h;
  };

  it("allows the assignee", async () => {
    const h = await started();
    const after = await recordProgressUseCase(
      h.deps,
      ctx(WORKER),
      h.workId,
      "Migration plan reviewed.",
    );

    expect(after.progressRecords).toHaveLength(1);
  });

  it("allows a participant", async () => {
    const h = await started();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      participantMembershipIds: [OTHER],
    });

    await expect(
      recordProgressUseCase(h.deps, ctx(OTHER), h.workId, "Checked the data."),
    ).resolves.toBeDefined();
  });

  it("refuses the creator who is neither assignee nor participant", async () => {
    const h = await started();

    // The one Work command whose required relationship excludes the Creator:
    // "RecordProgress | Assignee or Participant".
    await expect(
      recordProgressUseCase(h.deps, ctx(CREATOR), h.workId, "Looks fine to me."),
    ).rejects.toBeInstanceOf(RelationshipRequiredError);
  });

  it("refuses an Admin who is neither assignee nor participant", async () => {
    const h = await started();

    // Administrative Override does not extend here. Progress is a claim about
    // work someone is doing, not an administrative action.
    await expect(
      recordProgressUseCase(
        h.deps,
        ctx(OTHER, ["OrganizationAdmin"]),
        h.workId,
        "Reported on their behalf.",
      ),
    ).rejects.toBeInstanceOf(RelationshipRequiredError);
  });
});

describe("Decision relationships", () => {
  const withDecision = async () => {
    const h = await harness();
    const decision = await createDecisionUseCase(h.deps, ctx(CREATOR), {
      relatedWorkId: h.workId,
      title: "Launch timing",
      question: "Launch on Friday?",
      options: [{ optionId: "yes", summary: "Yes" }],
    });
    return { ...h, decisionId: decision.decisionId };
  };

  it("reports the creator, who is also the first revision's author", async () => {
    const h = await withDecision();
    const decision = (await h.decisions.findById(ORG, h.decisionId))!;

    expect([...resolveDecisionRelationships(principal(CREATOR), decision)].sort()).toEqual(
      ["Contributor", "Creator"],
    );
  });

  it("reports nothing for an unrelated Member", async () => {
    const h = await withDecision();
    const decision = (await h.decisions.findById(ORG, h.decisionId))!;

    expect([...resolveDecisionRelationships(principal(OTHER), decision)]).toEqual([]);
  });

  it("refuses an unrelated Member editing the Draft", async () => {
    const h = await withDecision();

    await expect(
      editDecisionDraftUseCase(h.deps, ctx(OTHER), h.decisionId, {
        question: "Rewriting someone else's proposal.",
      }),
    ).rejects.toBeInstanceOf(RelationshipRequiredError);
  });

  it("makes the author of any revision a Contributor", async () => {
    const h = await withDecision();
    const created = (await h.decisions.findById(ORG, h.decisionId))!;

    // A later revision is authored by whoever starts it, which is how someone
    // who did not create the Decision becomes entitled to edit it. Asserted on
    // the resolver rather than driven through `startRevisionUseCase`, which
    // needs a Rejected Decision and so a full submit-and-reject cycle.
    const withSecondRevision = {
      ...created,
      revisions: [
        ...created.revisions,
        { ...created.revisions[0]!, revisionId: "rev-2", revisionNumber: 2,
          createdByMembershipId: WORKER },
      ],
    };

    expect([
      ...resolveDecisionRelationships(principal(WORKER), withSecondRevision),
    ]).toEqual(["Contributor"]);
    // And the creator stays a Creator regardless of who revised it.
    expect([
      ...resolveDecisionRelationships(principal(CREATOR), withSecondRevision),
    ]).toContain("Creator");
  });
});

describe("Memory relationships", () => {
  const memory = (
    editorMembershipId: MembershipId | null,
    sourceWorkId: WorkId,
  ): MemoryState =>
    ({
      memoryId: "memory-1",
      organizationId: ORG,
      sourceWorkId,
      status: "Generated",
      isActive: true,
      // Provenance is irrelevant to relationship resolution and long enough that
      // building a real one would obscure what the test is about.
      provenance: {} as MemoryState["provenance"],
      revisions: [
        {
          revisionId: "rev-1",
          revisionNumber: 1,
          status: "Draft",
          title: "t",
          summary: "s",
          content: "c",
          sourceReferences: [],
          author:
            editorMembershipId === null
              ? { actorType: "AI", actorId: IdentityId("secretary"), membershipId: null }
              : {
                  actorType: "HumanMember",
                  actorId: IdentityId("identity-editor"),
                  membershipId: editorMembershipId,
                },
          contentHash: "h",
          createdAt: NOW,
        },
      ],
      currentRevisionId: "rev-1",
      submittedRevisionId: null,
      reviewedRevisionId: null,
      reviewRecords: [],
      version: 1 as AggregateVersion,
    }) as unknown as MemoryState;

  it("does not make the generating Secretary an Editor", async () => {
    const h = await harness();
    const work = (await h.work.findById(ORG, h.workId))!;

    // The generated first revision has no Membership on its author record, so
    // nobody becomes an Editor by generation alone.
    expect([
      ...resolveMemoryRelationships(principal(OTHER), memory(null, h.workId), work),
    ]).toEqual([]);
  });

  it("reaches the Members of the source Work", async () => {
    const h = await harness();
    await assignWorkUseCase(h.deps, ctx(CREATOR), h.workId, {
      participantMembershipIds: [WORKER],
    });
    const work = (await h.work.findById(ORG, h.workId))!;

    expect([
      ...resolveMemoryRelationships(principal(WORKER), memory(null, h.workId), work),
    ]).toEqual(["RelatedWorkMember"]);
  });

  it("denies the Work relationship when the source Work cannot be read", async () => {
    const h = await harness();

    // Null is not evidence of a relationship. Treating an unreadable source as
    // permissive would turn a failed read into an authorization grant.
    expect([
      ...resolveMemoryRelationships(principal(CREATOR), memory(null, h.workId), null),
    ]).toEqual([]);
  });

  it("does not count an Admin as a related Work Member", async () => {
    const h = await harness();
    const work = (await h.work.findById(ORG, h.workId))!;

    // Administrator is reported, but not RelatedWorkMember — the matrix lists
    // them separately and folding them together would erase the distinction.
    expect([
      ...resolveMemoryRelationships(
        principal(OTHER, ["OrganizationAdmin"]),
        memory(null, h.workId),
        work,
      ),
    ]).toEqual(["Administrator"]);
  });

  it("reports a human editor", async () => {
    const h = await harness();
    const work = (await h.work.findById(ORG, h.workId))!;

    expect([
      ...resolveMemoryRelationships(principal(OTHER), memory(OTHER, h.workId), work),
    ]).toEqual(["Editor"]);
  });
});
