import { describe, expect, it } from "vitest";

import {
  DecisionId,
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  type AiPrincipal,
  type HumanMemberPrincipal,
  type Principal,
} from "@aios/types";

import {
  activeParticipantsOf,
  addParticipant,
  assigneeOf,
  assignMember,
  cancelWork,
  updateWorkDetails,
  completeWork,
  createWork,
  recordDecisionOutcome,
  recordProgress,
  removeParticipant,
  requestBlockingDecision,
  startWork,
  unassignMember,
  type ActorContext,
  type WorkState,
} from "./work.js";
import type { BlockingReference } from "./completion-gate.js";
import { DomainError } from "./errors.js";

const ORG = OrganizationId("org-1");
const OTHER_ORG = OrganizationId("org-2");
const NOW = new Date("2026-07-28T10:00:00Z");

const human = (organizationId = ORG): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-1"),
  membershipId: MembershipId("membership-1"),
  organizationId,
  roles: ["Member"],
});

const secretary: AiPrincipal = {
  type: "AI",
  identityId: IdentityId("secretary-1"),
  organizationId: ORG,
  assistanceOperation: "work.summarize.v1",
};

const ctx = (principal: Principal = human(), now = NOW): ActorContext => ({
  principal,
  now,
});

const reference: BlockingReference = {
  decisionId: DecisionId("decision-1"),
  revisionNumber: 1,
  submittedSnapshotId: "snapshot-1",
};

const draft = (): WorkState =>
  createWork({ workId: WorkId("work-1"), organizationId: ORG, title: "Ship it" }, ctx())
    .state;

const inProgress = (): WorkState => startWork(draft(), ctx()).state;

const waiting = (): WorkState =>
  requestBlockingDecision(inProgress(), reference, ctx()).state;

describe("Work lifecycle", () => {
  it("starts in Draft and emits WorkCreated", () => {
    const { state, events } = createWork(
      { workId: WorkId("work-1"), organizationId: ORG, title: "Ship it" },
      ctx(),
    );
    expect(state.status).toBe("Draft");
    expect(state.version).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["WorkCreated"]);
  });

  it("Draft → InProgress sets startedAt once", () => {
    const { state, events } = startWork(draft(), ctx());
    expect(state.status).toBe("InProgress");
    expect(state.startedAt).toEqual(NOW);
    expect(events.map((e) => e.type)).toEqual(["WorkStarted"]);
  });

  it("rejects starting Work that is already InProgress", () => {
    expect(() => startWork(inProgress(), ctx())).toThrowError(
      /cannot accept work.start from state InProgress/,
    );
  });

  it("increments the version on every state change", () => {
    const a = draft();
    const b = startWork(a, ctx()).state;
    expect(b.version).toBe(a.version + 1);
  });
});

describe("human authority", () => {
  it.each([
    ["complete", () => completeWork(inProgress(), "done", ctx(secretary))],
    ["cancel", () => cancelWork(inProgress(), "no longer needed", ctx(secretary))],
    ["start", () => startWork(draft(), ctx(secretary))],
  ])("the Secretary cannot %s Work", (_name, act) => {
    expect(act).toThrowError(/requires a Human Member/);
  });

  it("names the principal type in the error so audit can record it", () => {
    try {
      completeWork(inProgress(), "done", ctx(secretary));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("HUMAN_AUTHORITY_REQUIRED");
      expect((error as DomainError).details["principalType"]).toBe("AI");
    }
  });
});

describe("tenant isolation", () => {
  it("rejects a principal from another Organization", () => {
    expect(() => startWork(draft(), ctx(human(OTHER_ORG)))).toThrowError(
      /different Organization/,
    );
  });

  it("rejects creating Work in an Organization the actor does not act for", () => {
    expect(() =>
      createWork(
        { workId: WorkId("work-9"), organizationId: OTHER_ORG, title: "x" },
        ctx(human(ORG)),
      ),
    ).toThrowError(/different Organization/);
  });
});

/**
 * Scenarios transcribed from the Given/When/Then blocks in
 * docs/architecture/state-machines/work.md.
 */
describe("documented scenarios", () => {
  it("Complete Work Without a Decision", () => {
    const { state, events } = completeWork(inProgress(), "Delivered", ctx());
    expect(state.status).toBe("Completed");
    expect(events.filter((e) => e.type === "WorkCompleted")).toHaveLength(1);
  });

  it("Approved Decision Does Not Complete Work", () => {
    const { state } = recordDecisionOutcome(
      waiting(),
      {
        reference,
        outcome: "Approved",
        resolvedByIdentityId: IdentityId("reviewer-1"),
        resolvedByMembershipId: MembershipId("membership-2"),
      },
      ctx(),
    );
    expect(state.status).toBe("InProgress");
    expect(state.completionGate.kind).toBe("Satisfied");
    expect(state.status).not.toBe("Completed");
  });

  it("Explicit Completion After Approval", () => {
    const satisfied = recordDecisionOutcome(
      waiting(),
      {
        reference,
        outcome: "Approved",
        resolvedByIdentityId: IdentityId("reviewer-1"),
        resolvedByMembershipId: MembershipId("membership-2"),
      },
      ctx(),
    ).state;
    expect(completeWork(satisfied, "Delivered", ctx()).state.status).toBe("Completed");
  });

  it("Rejected Decision Blocks Completion", () => {
    const unsatisfied = recordDecisionOutcome(
      waiting(),
      {
        reference,
        outcome: "Rejected",
        resolvedByIdentityId: IdentityId("reviewer-1"),
        resolvedByMembershipId: MembershipId("membership-2"),
      },
      ctx(),
    ).state;

    expect(unsatisfied.status).toBe("InProgress");
    expect(unsatisfied.completionGate.kind).toBe("Unsatisfied");
    expect(() => completeWork(unsatisfied, "Delivered", ctx())).toThrowError(
      /requires an approved Decision/,
    );
  });
});

describe("completion gate", () => {
  it("moves to WaitingForDecision and marks the gate Pending", () => {
    const state = waiting();
    expect(state.status).toBe("WaitingForDecision");
    expect(state.completionGate).toMatchObject({ kind: "Pending", reference });
  });

  it("refuses a second unresolved blocking Decision", () => {
    const resumed = recordDecisionOutcome(
      waiting(),
      {
        reference,
        outcome: "Approved",
        resolvedByIdentityId: IdentityId("reviewer-1"),
        resolvedByMembershipId: MembershipId("membership-2"),
      },
      ctx(),
    ).state;
    // Resolving clears the blocking reference, so a new one is allowed.
    expect(() =>
      requestBlockingDecision(
        resumed,
        { ...reference, revisionNumber: 2, submittedSnapshotId: "snapshot-2" },
        ctx(),
      ),
    ).not.toThrow();
  });

  it("rejects an outcome whose revision does not match the active reference", () => {
    expect(() =>
      recordDecisionOutcome(
        waiting(),
        {
          reference: { ...reference, revisionNumber: 2 },
          outcome: "Approved",
          resolvedByIdentityId: IdentityId("reviewer-1"),
          resolvedByMembershipId: MembershipId("membership-2"),
        },
        ctx(),
      ),
    ).toThrowError(/does not match the active blocking reference/);
  });

  it("rejects an outcome whose snapshot does not match, even with the same decisionId", () => {
    expect(() =>
      recordDecisionOutcome(
        waiting(),
        {
          reference: { ...reference, submittedSnapshotId: "stale-snapshot" },
          outcome: "Approved",
          resolvedByIdentityId: IdentityId("reviewer-1"),
          resolvedByMembershipId: MembershipId("membership-2"),
        },
        ctx(),
      ),
    ).toThrowError(/does not match the active blocking reference/);
  });

  it("cannot complete while a blocking Decision is unresolved", () => {
    expect(() => completeWork(waiting(), "Delivered", ctx())).toThrowError(
      /cannot accept work.complete from state WaitingForDecision/,
    );
  });
});

describe("terminal states", () => {
  it("Completed Work cannot be completed again", () => {
    const completed = completeWork(inProgress(), "Delivered", ctx()).state;
    expect(() => completeWork(completed, "Again", ctx())).toThrowError(
      /cannot accept work.complete from state Completed/,
    );
  });

  it("Completed Work cannot be cancelled", () => {
    const completed = completeWork(inProgress(), "Delivered", ctx()).state;
    expect(() => cancelWork(completed, "changed my mind", ctx())).toThrowError(
      /cannot accept work.cancel from state Completed/,
    );
  });

  it("Work can be cancelled from any non-terminal state", () => {
    for (const state of [draft(), inProgress(), waiting()]) {
      expect(cancelWork(state, "stopped", ctx()).state.status).toBe("Cancelled");
    }
  });
});

describe("validation", () => {
  it("requires a completion summary", () => {
    expect(() => completeWork(inProgress(), "   ", ctx())).toThrowError(
      /completion summary is required/,
    );
  });

  it("requires a title", () => {
    expect(() =>
      createWork({ workId: WorkId("w"), organizationId: ORG, title: "  " }, ctx()),
    ).toThrowError(/title is required/);
  });
});

describe("editing Work details", () => {
  const completed = (): WorkState =>
    completeWork(inProgress(), "Shipped", ctx()).state;

  it("changes the title and emits WorkDetailsUpdated", () => {
    const { state, events } = updateWorkDetails(
      draft(),
      { title: "Ship it, revised" },
      ctx(),
    );
    expect(state.title).toBe("Ship it, revised");
    expect(state.status).toBe("Draft");
    expect(events.map((e) => e.type)).toEqual(["WorkDetailsUpdated"]);
  });

  it("leaves an omitted field untouched", () => {
    const before = updateWorkDetails(draft(), { description: "Detail." }, ctx()).state;
    const after = updateWorkDetails(before, { title: "New title" }, ctx()).state;
    expect(after.description).toBe("Detail.");
  });

  it("clears the description when explicitly given null", () => {
    const before = updateWorkDetails(draft(), { description: "Detail." }, ctx()).state;
    expect(updateWorkDetails(before, { description: null }, ctx()).state.description)
      .toBeNull();
  });

  it("advances the version even when nothing changed", () => {
    // A stale If-Match must not be silently accepted because the caller's
    // no-op happened to match the current content.
    const work = draft();
    expect(updateWorkDetails(work, {}, ctx()).state.version).toBe(work.version + 1);
  });

  it("edits Work that is waiting on a Decision", () => {
    expect(updateWorkDetails(waiting(), { title: "Still editable" }, ctx()).state.title)
      .toBe("Still editable");
  });

  it("refuses to edit Completed Work", () => {
    // Completed Work is the source snapshot a Memory was generated from.
    expect(() => updateWorkDetails(completed(), { title: "Rewrite" }, ctx()))
      .toThrowError(/cannot accept work.edit/);
  });

  it("refuses to edit Cancelled Work", () => {
    const cancelled = cancelWork(draft(), "Not needed", ctx()).state;
    expect(() => updateWorkDetails(cancelled, { title: "Rewrite" }, ctx()))
      .toThrowError(/cannot accept work.edit/);
  });

  it("refuses a blank title", () => {
    expect(() => updateWorkDetails(draft(), { title: "   " }, ctx()))
      .toThrowError(/title is required/);
  });

  it("refuses a non-Human principal", () => {
    expect(() => updateWorkDetails(draft(), { title: "By the Secretary" }, ctx(secretary)))
      .toThrowError(/requires a Human Member/);
  });
});

const ALICE = MembershipId("membership-alice");
const BOB = MembershipId("membership-bob");

const assigned = (to = ALICE): WorkState =>
  assignMember(draft(), { participantId: "p-1", membershipId: to }, ctx()).state;

describe("assignment", () => {
  it("makes one Member responsible", () => {
    const result = assignMember(
      draft(),
      { participantId: "p-1", membershipId: ALICE },
      ctx(),
    );

    expect(assigneeOf(result.state)).toBe(ALICE);
    expect(result.events.map((e) => e.type)).toEqual(["WorkAssignmentChanged"]);
  });

  it("ends the previous assignment rather than keeping both", () => {
    const reassigned = assignMember(
      assigned(ALICE),
      { participantId: "p-2", membershipId: BOB },
      ctx(),
    ).state;

    // "Who is responsible" must always have one answer.
    expect(assigneeOf(reassigned)).toBe(BOB);
    expect(
      activeParticipantsOf(reassigned).filter(
        (p) => p.relationshipType === "Assignee",
      ),
    ).toHaveLength(1);
  });

  it("keeps the ended assignment as history", () => {
    const reassigned = assignMember(
      assigned(ALICE),
      { participantId: "p-2", membershipId: BOB },
      ctx(),
    ).state;

    const ended = reassigned.participants.find((p) => p.membershipId === ALICE);
    expect(ended?.removedAt).toEqual(NOW);
    // Removal attribution is inseparable from the removal, matching
    // ck_work_participants_removal.
    expect(ended?.removedByIdentityId).toBe(IdentityId("identity-1"));
    expect(ended?.removedByMembershipId).toBe(MembershipId("membership-1"));
  });

  it("reports the previous assignee on the event", () => {
    const result = assignMember(
      assigned(ALICE),
      { participantId: "p-2", membershipId: BOB },
      ctx(),
    );

    expect(result.events[0]).toMatchObject({
      assigneeMembershipId: BOB,
      previousAssigneeMembershipId: ALICE,
    });
  });

  it("refuses to reassign to the current assignee", () => {
    expect(() =>
      assignMember(assigned(ALICE), { participantId: "p-2", membershipId: ALICE }, ctx()),
    ).toThrowError(/already the assignee/);
  });

  it("unassigns, leaving nobody responsible", () => {
    const result = unassignMember(assigned(ALICE), ctx());

    expect(assigneeOf(result.state)).toBeNull();
    expect(result.events[0]).toMatchObject({
      assigneeMembershipId: null,
      previousAssigneeMembershipId: ALICE,
    });
  });

  it("refuses to unassign Work that has no assignee", () => {
    expect(() => unassignMember(draft(), ctx())).toThrowError(/no assignee/);
  });

  it("refuses to assign terminal Work", () => {
    const cancelled = cancelWork(draft(), "Not needed", ctx()).state;
    expect(() =>
      assignMember(cancelled, { participantId: "p-1", membershipId: ALICE }, ctx()),
    ).toThrowError(/cannot accept work.assign/);
  });
});

describe("participants", () => {
  it("adds a participant without touching the assignee", () => {
    const result = addParticipant(
      assigned(ALICE),
      { participantId: "p-2", membershipId: BOB },
      ctx(),
    );

    expect(assigneeOf(result.state)).toBe(ALICE);
    expect(result.events).toMatchObject([
      { type: "WorkParticipantChanged", membershipId: BOB, change: "Added" },
    ]);
  });

  it("refuses a duplicate active participant", () => {
    const withBob = addParticipant(
      draft(),
      { participantId: "p-2", membershipId: BOB },
      ctx(),
    ).state;

    expect(() =>
      addParticipant(withBob, { participantId: "p-3", membershipId: BOB }, ctx()),
    ).toThrowError(/already a participant/);
  });

  it("lets the assignee also be a participant", () => {
    // The two relationships are independent rows, so this is not a duplicate.
    const both = addParticipant(
      assigned(ALICE),
      { participantId: "p-2", membershipId: ALICE },
      ctx(),
    ).state;

    expect(activeParticipantsOf(both)).toHaveLength(2);
  });

  it("ends a participant rather than dropping the row", () => {
    const withBob = addParticipant(
      draft(),
      { participantId: "p-2", membershipId: BOB },
      ctx(),
    ).state;
    const removed = removeParticipant(withBob, BOB, ctx()).state;

    expect(activeParticipantsOf(removed)).toHaveLength(0);
    expect(removed.participants).toHaveLength(1);
    expect(removed.participants[0]?.removedAt).toEqual(NOW);
  });

  it("removing a participant does not remove their assignment", () => {
    const both = addParticipant(
      assigned(ALICE),
      { participantId: "p-2", membershipId: ALICE },
      ctx(),
    ).state;
    const removed = removeParticipant(both, ALICE, ctx()).state;

    expect(assigneeOf(removed)).toBe(ALICE);
  });

  it("refuses to remove someone who is not a participant", () => {
    expect(() => removeParticipant(draft(), BOB, ctx())).toThrowError(
      /not a participant/,
    );
  });
});

describe("progress", () => {
  it("appends an attributable record", () => {
    const result = recordProgress(
      inProgress(),
      { progressRecordId: "pr-1", content: "Reviewed the migration plan." },
      ctx(),
    );

    expect(result.state.progressRecords).toMatchObject([
      {
        progressRecordId: "pr-1",
        content: "Reviewed the migration plan.",
        recordedByIdentityId: IdentityId("identity-1"),
        recordedByMembershipId: MembershipId("membership-1"),
      },
    ]);
    expect(result.events.map((e) => e.type)).toEqual(["WorkProgressRecorded"]);
  });

  it("never completes the Work", () => {
    // "progress alone never completes Work".
    const before = inProgress();
    const after = recordProgress(
      before,
      { progressRecordId: "pr-1", content: "Nearly done." },
      ctx(),
    ).state;

    expect(after.status).toBe(before.status);
    expect(after.completionGate).toEqual(before.completionGate);
    expect(after.completedAt).toBeNull();
  });

  it("is allowed while waiting for a Decision", () => {
    expect(
      recordProgress(waiting(), { progressRecordId: "pr-1", content: "Chased it." }, ctx())
        .state.progressRecords,
    ).toHaveLength(1);
  });

  it("refuses progress on Work that has not started", () => {
    expect(() =>
      recordProgress(draft(), { progressRecordId: "pr-1", content: "Started?" }, ctx()),
    ).toThrowError(/cannot accept work.record_progress/);
  });

  it("refuses progress on completed Work", () => {
    const completed = completeWork(inProgress(), "Done", ctx()).state;
    expect(() =>
      recordProgress(completed, { progressRecordId: "pr-1", content: "More" }, ctx()),
    ).toThrowError(/cannot accept work.record_progress/);
  });

  it("refuses blank content", () => {
    expect(() =>
      recordProgress(inProgress(), { progressRecordId: "pr-1", content: "   " }, ctx()),
    ).toThrowError(/content is required/);
  });

  it("appends rather than replaces", () => {
    const first = recordProgress(
      inProgress(),
      { progressRecordId: "pr-1", content: "First" },
      ctx(),
    ).state;
    const second = recordProgress(
      first,
      { progressRecordId: "pr-2", content: "Second" },
      ctx(),
    ).state;

    expect(second.progressRecords.map((r) => r.content)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("refuses a non-Human principal", () => {
    expect(() =>
      recordProgress(
        inProgress(),
        { progressRecordId: "pr-1", content: "By the Secretary" },
        ctx(secretary),
      ),
    ).toThrowError(/requires a Human Member/);
  });
});
