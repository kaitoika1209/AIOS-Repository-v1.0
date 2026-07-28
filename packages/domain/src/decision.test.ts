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
  approveDecision,
  createDecision,
  rejectDecision,
  startRevision,
  submitForReview,
  updateDraft,
  withdrawDecision,
  type DecisionState,
} from "./decision.js";
import type { ActorContext } from "./work.js";

const ORG = OrganizationId("org-1");
const NOW = new Date("2026-07-28T10:00:00Z");

const human = (): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-1"),
  membershipId: MembershipId("membership-1"),
  organizationId: ORG,
  roles: ["Reviewer"],
});

const secretary: AiPrincipal = {
  type: "AI",
  identityId: IdentityId("secretary-1"),
  organizationId: ORG,
  assistanceOperation: "decision.draft.v1",
};

const ctx = (principal: Principal = human()): ActorContext => ({
  principal,
  now: NOW,
});

const options = [
  { optionId: "a", summary: "Do it now" },
  { optionId: "b", summary: "Defer" },
];

const draft = (): DecisionState =>
  createDecision(
    {
      decisionId: DecisionId("decision-1"),
      organizationId: ORG,
      relatedWorkId: WorkId("work-1"),
      question: "Ship this week?",
      options,
    },
    ctx(),
  ).state;

const inReview = (): DecisionState => submitForReview(draft(), "snapshot-1", ctx()).state;

describe("Decision lifecycle", () => {
  it("starts in Draft at revision 1 with no snapshot", () => {
    const state = draft();
    expect(state.status).toBe("Draft");
    expect(state.revisionNumber).toBe(1);
    expect(state.submittedSnapshotId).toBeNull();
  });

  it("Draft → InReview locks the draft and records the snapshot", () => {
    const { state, events } = submitForReview(draft(), "snapshot-1", ctx());
    expect(state.status).toBe("InReview");
    expect(state.submittedSnapshotId).toBe("snapshot-1");
    expect(events.map((e) => e.type)).toEqual(["DecisionSubmitted"]);
  });

  it("an InReview Decision is no longer editable", () => {
    expect(() => updateDraft(inReview(), { question: "changed" }, ctx())).toThrowError(
      /cannot accept decision.edit_draft from state InReview/,
    );
  });

  it("requires at least one option before review", () => {
    const empty = createDecision(
      {
        decisionId: DecisionId("d"),
        organizationId: ORG,
        relatedWorkId: WorkId("work-1"),
        question: "?",
      },
      ctx(),
    ).state;
    expect(() => submitForReview(empty, "snap", ctx())).toThrowError(/at least one option/);
  });
});

describe("human authority", () => {
  it.each([
    ["approve", () => approveDecision(inReview(), { selectedOptionId: "a", rationale: "ok" }, ctx(secretary))],
    ["reject", () => rejectDecision(inReview(), "no", ctx(secretary))],
    ["withdraw", () => withdrawDecision(inReview(), "moot", ctx(secretary))],
    ["submit", () => submitForReview(draft(), "snap", ctx(secretary))],
  ])("the Secretary cannot %s a Decision", (_name, act) => {
    expect(act).toThrowError(/requires a Human Member/);
  });
});

describe("approval", () => {
  it("records the reviewer, rationale, and selected option", () => {
    const { state, events } = approveDecision(
      inReview(),
      { selectedOptionId: "a", rationale: "Lowest risk" },
      ctx(),
    );
    expect(state.status).toBe("Approved");
    expect(state.resolutions).toHaveLength(1);
    expect(state.resolutions[0]).toMatchObject({
      outcome: "Approved",
      selectedOptionId: "a",
      rationale: "Lowest risk",
      revisionNumber: 1,
    });
    expect(events[0]).toMatchObject({
      type: "DecisionApproved",
      submittedSnapshotId: "snapshot-1",
    });
  });

  it("rejects an option that is not part of the submitted revision", () => {
    expect(() =>
      approveDecision(inReview(), { selectedOptionId: "zzz", rationale: "?" }, ctx()),
    ).toThrowError(/not part of the submitted revision/);
  });

  it("Approved is terminal", () => {
    const approved = approveDecision(
      inReview(),
      { selectedOptionId: "a", rationale: "ok" },
      ctx(),
    ).state;
    expect(() => rejectDecision(approved, "changed my mind", ctx())).toThrowError(
      /cannot accept decision.reject from state Approved/,
    );
    expect(() => startRevision(approved, ctx())).toThrowError(
      /cannot accept decision.start_revision from state Approved/,
    );
  });
});

describe("rejection and revision", () => {
  const rejected = () => rejectDecision(inReview(), "Needs more data", ctx()).state;

  it("Rejected is not terminal", () => {
    expect(startRevision(rejected(), ctx()).state.status).toBe("Draft");
  });

  it("a new revision increments the number and clears the snapshot", () => {
    const revised = startRevision(rejected(), ctx()).state;
    expect(revised.revisionNumber).toBe(2);
    expect(revised.submittedSnapshotId).toBeNull();
  });

  it("a new revision does not erase the rejected one", () => {
    const revised = startRevision(rejected(), ctx()).state;
    expect(revised.resolutions).toHaveLength(1);
    expect(revised.resolutions[0]).toMatchObject({
      outcome: "Rejected",
      revisionNumber: 1,
      rationale: "Needs more data",
    });
  });

  it("resubmitting produces a distinct reference from the rejected revision", () => {
    const revised = startRevision(rejected(), ctx()).state;
    const resubmitted = submitForReview(revised, "snapshot-2", ctx()).state;
    expect(resubmitted.revisionNumber).toBe(2);
    expect(resubmitted.submittedSnapshotId).toBe("snapshot-2");
  });
});

describe("withdrawal", () => {
  it("is permitted from Draft and from InReview", () => {
    expect(withdrawDecision(draft(), "moot", ctx()).state.status).toBe("Withdrawn");
    expect(withdrawDecision(inReview(), "moot", ctx()).state.status).toBe("Withdrawn");
  });

  it("is terminal", () => {
    const withdrawn = withdrawDecision(inReview(), "moot", ctx()).state;
    expect(() => startRevision(withdrawn, ctx())).toThrowError(
      /cannot accept decision.start_revision from state Withdrawn/,
    );
  });
});
