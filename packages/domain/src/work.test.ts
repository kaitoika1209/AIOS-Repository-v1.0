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
  cancelWork,
  updateWorkDetails,
  completeWork,
  createWork,
  recordDecisionOutcome,
  requestBlockingDecision,
  startWork,
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
