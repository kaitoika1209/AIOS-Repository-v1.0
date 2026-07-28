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
  currentRevision,
  rejectDecision,
  revisionByNumber,
  startRevision,
  submitForReview,
  submittedRevision,
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
      revisionId: "rev-1",
      title: "Launch timing",
      question: "Ship this week?",
      options,
    },
    ctx(),
  ).state;

const inReview = (): DecisionState => submitForReview(draft(), ctx()).state;
const rejected = (): DecisionState =>
  rejectDecision(inReview(), "Needs more data", ctx()).state;

describe("Decision lifecycle", () => {
  it("starts in Draft with one Draft revision", () => {
    const state = draft();
    expect(state.status).toBe("Draft");
    expect(state.revisions).toHaveLength(1);
    expect(currentRevision(state)).toMatchObject({
      revisionNumber: 1,
      status: "Draft",
    });
    expect(state.submittedRevisionId).toBeNull();
  });

  it("Draft → InReview locks the revision and exposes it as the snapshot", () => {
    const { state, events } = submitForReview(draft(), ctx());
    expect(state.status).toBe("InReview");
    expect(state.currentRevisionId).toBeNull();
    expect(submittedRevision(state)).toMatchObject({ status: "Submitted" });
    expect(events[0]).toMatchObject({
      type: "DecisionSubmitted",
      submittedSnapshotId: state.submittedRevisionId,
    });
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
        revisionId: "rev-x",
        title: "t",
        question: "?",
      },
      ctx(),
    ).state;
    expect(() => submitForReview(empty, ctx())).toThrowError(/at least one option/);
  });

  it("rejects duplicate option identity", () => {
    const dup = draft();
    expect(() =>
      updateDraft(
        dup,
        { options: [{ optionId: "a", summary: "x" }, { optionId: "a", summary: "y" }] },
        ctx(),
      ),
    ).toThrowError(/Duplicate option identity/);
  });
});

describe("human authority", () => {
  it.each([
    ["approve", () => approveDecision(inReview(), { selectedOptionId: "a", rationale: "ok" }, ctx(secretary))],
    ["reject", () => rejectDecision(inReview(), "no", ctx(secretary))],
    ["withdraw", () => withdrawDecision(inReview(), "moot", ctx(secretary))],
    ["submit", () => submitForReview(draft(), ctx(secretary))],
    ["start a revision", () => startRevision(rejected(), "rev-2", ctx(secretary))],
  ])("the Secretary cannot %s", (_name, act) => {
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
    expect(state.reviewRecords).toHaveLength(1);
    expect(state.reviewRecords[0]).toMatchObject({
      outcome: "Approved",
      selectedOptionId: "a",
      rationale: "Lowest risk",
      revisionNumber: 1,
    });
    expect(events[0]).toMatchObject({ type: "DecisionApproved" });
  });

  it("marks the approved revision immutable", () => {
    const state = approveDecision(
      inReview(),
      { selectedOptionId: "a", rationale: "ok" },
      ctx(),
    ).state;
    expect(revisionByNumber(state, 1)).toMatchObject({ status: "Approved" });
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
    expect(() => startRevision(approved, "rev-2", ctx())).toThrowError(
      /cannot accept decision.start_revision from state Approved/,
    );
  });
});

describe("rejection and revision", () => {
  it("Rejected is not terminal", () => {
    expect(startRevision(rejected(), "rev-2", ctx()).state.status).toBe("Draft");
  });

  it("a new revision is a new entity, not a reopened one", () => {
    const revised = startRevision(rejected(), "rev-2", ctx()).state;
    expect(revised.revisions).toHaveLength(2);
    expect(currentRevision(revised)).toMatchObject({
      revisionId: "rev-2",
      revisionNumber: 2,
      status: "Draft",
    });
  });

  /**
   * The invariant the previous flattened model violated: the state machine says
   * a new revision "does not erase or rewrite the rejected revision".
   */
  it("editing the new revision does not rewrite the rejected one", () => {
    const revised = startRevision(rejected(), "rev-2", ctx()).state;
    const edited = updateDraft(
      revised,
      { question: "Ship next month instead?", options: [{ optionId: "c", summary: "Later" }] },
      ctx(),
    ).state;

    const original = revisionByNumber(edited, 1)!;
    expect(original.question).toBe("Ship this week?");
    expect(original.options.map((o) => o.optionId)).toEqual(["a", "b"]);
    expect(original.status).toBe("Rejected");

    expect(revisionByNumber(edited, 2)!.question).toBe("Ship next month instead?");
  });

  it("keeps the rejection review record", () => {
    const revised = startRevision(rejected(), "rev-2", ctx()).state;
    expect(revised.reviewRecords).toHaveLength(1);
    expect(revised.reviewRecords[0]).toMatchObject({
      outcome: "Rejected",
      revisionNumber: 1,
      rationale: "Needs more data",
    });
  });

  it("resubmitting produces a snapshot distinct from the rejected revision", () => {
    const revised = startRevision(rejected(), "rev-2", ctx()).state;
    const resubmitted = submitForReview(revised, ctx()).state;
    expect(resubmitted.submittedRevisionId).toBe("rev-2");
    expect(submittedRevision(resubmitted)!.revisionNumber).toBe(2);
  });
});

describe("withdrawal", () => {
  it("is permitted from Draft and from InReview", () => {
    expect(withdrawDecision(draft(), "moot", ctx()).state.status).toBe("Withdrawn");
    expect(withdrawDecision(inReview(), "moot", ctx()).state.status).toBe("Withdrawn");
  });

  it("is terminal — no revision may follow", () => {
    const withdrawn = withdrawDecision(inReview(), "moot", ctx()).state;
    expect(() => startRevision(withdrawn, "rev-2", ctx())).toThrowError(
      /cannot accept decision.start_revision from state Withdrawn/,
    );
  });
});
