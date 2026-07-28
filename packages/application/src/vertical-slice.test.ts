/**
 * End-to-end tests of the Work → Decision slice through the Application Layer.
 *
 * These exercise the paths that only appear once use cases, authorization, and
 * transactions are combined — in particular ADR-0007's atomic activation and
 * the rule that approving a Decision never completes Work.
 */

import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  WorkId,
  type AiPrincipal,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

import { AuthorizationError, hasPermission } from "./authorization.js";
import {
  approveDecisionUseCase,
  applyDecisionOutcomeUseCase,
  createDecisionUseCase,
  rejectDecisionUseCase,
  startRevisionUseCase,
  submitBlockingDecisionUseCase,
} from "./decision-use-cases.js";
import {
  completeWorkUseCase,
  createWorkUseCase,
  getWorkUseCase,
  startWorkUseCase,
} from "./work-use-cases.js";
import { NotFoundError } from "./ports.js";
import { buildTestHarness } from "./testing/in-memory.js";

const ORG = OrganizationId("org-1");
const OTHER_ORG = OrganizationId("org-2");
const NOW = new Date("2026-07-28T10:00:00Z");

const member = (roles: Role[] = ["Member"], org = ORG): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-member"),
  membershipId: MembershipId("membership-member"),
  organizationId: org,
  roles,
});

const reviewer = (): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-reviewer"),
  membershipId: MembershipId("membership-reviewer"),
  organizationId: ORG,
  roles: ["Reviewer"],
});

const secretary: AiPrincipal = {
  type: "AI",
  identityId: IdentityId("secretary"),
  organizationId: ORG,
  assistanceOperation: "work.summarize.v1",
};

const system = {
  type: "System" as const,
  component: "decision-outcome-consumer",
  organizationId: ORG,
};

const ctxFor = (principal: HumanMemberPrincipal | AiPrincipal | typeof system) => ({
  principal,
  now: NOW,
  organizationId: ORG,
});

const setupInProgressWork = async () => {
  const h = buildTestHarness(NOW);
  const ctx = ctxFor(member());
  const created = await createWorkUseCase(h.deps, ctx, { title: "Ship the MVP" });
  const started = await startWorkUseCase(h.deps, ctx, created.workId);
  return { h, ctx, work: started };
};

describe("permission model", () => {
  it("a Member cannot approve a Decision", () => {
    expect(hasPermission(member(), "decision.approve")).toBe(false);
  });

  it("a Reviewer can approve a Decision", () => {
    expect(hasPermission(reviewer(), "decision.approve")).toBe(true);
  });

  it("a Reviewer cannot create Work", () => {
    expect(hasPermission(reviewer(), "work.create")).toBe(false);
  });

  it("the Secretary holds no permission at all", () => {
    for (const p of ["work.create", "work.complete", "decision.approve"] as const) {
      expect(hasPermission(secretary, p)).toBe(false);
    }
  });

  it("a System Principal holds no business permission", () => {
    expect(hasPermission(system, "work.complete")).toBe(false);
  });

  it("denies before the Aggregate is ever loaded", async () => {
    const h = buildTestHarness(NOW);
    await expect(
      createWorkUseCase(h.deps, ctxFor(reviewer()), { title: "x" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(await h.work.listByOrganization(ORG)).toHaveLength(0);
  });
});

describe("tenant isolation", () => {
  it("reports Work from another Organization as not found", async () => {
    const { h, work } = await setupInProgressWork();
    const foreign = { principal: member(["Member"], OTHER_ORG), now: NOW, organizationId: OTHER_ORG };

    await expect(getWorkUseCase(h.deps, foreign, work.workId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("does not reveal that the resource exists elsewhere", async () => {
    const { h, work } = await setupInProgressWork();
    const foreign = { principal: member(["Member"], OTHER_ORG), now: NOW, organizationId: OTHER_ORG };

    await expect(getWorkUseCase(h.deps, foreign, work.workId)).rejects.toThrowError(
      /Work not found/,
    );
  });
});

describe("atomic activation (ADR-0007)", () => {
  it("submitting a blocking Decision also blocks the Work, in one transaction", async () => {
    const { h, ctx, work } = await setupInProgressWork();

    const decision = await createDecisionUseCase(h.deps, ctx, {
      relatedWorkId: work.workId,
      title: "Launch timing",
      question: "Launch on Friday?",
      options: [{ optionId: "yes", summary: "Yes" }],
    });

    const result = await submitBlockingDecisionUseCase(h.deps, ctx, decision.decisionId);

    expect(result.decision.status).toBe("InReview");
    expect(result.work.status).toBe("WaitingForDecision");
    expect(result.work.completionGate).toMatchObject({
      kind: "Pending",
      reference: {
        decisionId: decision.decisionId,
        revisionNumber: 1,
        submittedSnapshotId: result.decision.submittedRevisionId,
      },
    });
  });

  it("leaves neither Aggregate changed when the Work transition is invalid", async () => {
    const h = buildTestHarness(NOW);
    const ctx = ctxFor(member());

    // Work is still Draft, so requesting a blocking Decision must fail.
    const work = await createWorkUseCase(h.deps, ctx, { title: "Not started" });
    const decision = await createDecisionUseCase(h.deps, ctx, {
      relatedWorkId: work.workId,
      title: "t",
      question: "?",
      options: [{ optionId: "a", summary: "A" }],
    });

    await expect(
      submitBlockingDecisionUseCase(h.deps, ctx, decision.decisionId),
    ).rejects.toThrowError(/cannot accept work.request_decision from state Draft/);

    // The Decision must not be left InReview with no Work waiting on it.
    const after = await h.decisions.findById(ORG, decision.decisionId);
    expect(after?.status).toBe("Draft");
    expect(after?.submittedRevisionId).toBeNull();
    expect((await h.work.findById(ORG, work.workId))?.status).toBe("Draft");
  });
});

describe("approval does not complete Work", () => {
  const blockAndApprove = async () => {
    const { h, ctx, work } = await setupInProgressWork();
    const decision = await createDecisionUseCase(h.deps, ctx, {
      relatedWorkId: work.workId,
      title: "Launch",
      question: "Launch?",
      options: [{ optionId: "yes", summary: "Yes" }],
    });
    const blocked = await submitBlockingDecisionUseCase(h.deps, ctx, decision.decisionId);
    const approved = await approveDecisionUseCase(
      h.deps,
      ctxFor(reviewer()),
      decision.decisionId,
      { selectedOptionId: "yes", rationale: "Risk accepted" },
    );
    return { h, ctx, work: blocked.work, decision: approved };
  };

  it("the Work is still WaitingForDecision until the outcome is projected", async () => {
    const { h, work } = await blockAndApprove();
    expect((await h.work.findById(ORG, work.workId))?.status).toBe(
      "WaitingForDecision",
    );
  });

  it("projecting the outcome returns Work to InProgress with a Satisfied gate", async () => {
    const { h, work, decision } = await blockAndApprove();

    const updated = await applyDecisionOutcomeUseCase(
      h.deps,
      { principal: system, now: NOW },
      {
        organizationId: ORG,
        workId: work.workId,
        decisionId: decision.decisionId,
        revisionNumber: 1,
        submittedSnapshotId: decision.reviewRecords[0]!.revisionId,
        outcome: "Approved",
        resolvedByIdentityId: IdentityId("identity-reviewer"),
        resolvedByMembershipId: MembershipId("membership-reviewer"),
      },
    );

    expect(updated.status).toBe("InProgress");
    expect(updated.completionGate.kind).toBe("Satisfied");
  });

  it("completion still requires an explicit human command", async () => {
    const { h, ctx, work, decision } = await blockAndApprove();
    await applyDecisionOutcomeUseCase(
      h.deps,
      { principal: system, now: NOW },
      {
        organizationId: ORG,
        workId: work.workId,
        decisionId: decision.decisionId,
        revisionNumber: 1,
        submittedSnapshotId: decision.reviewRecords[0]!.revisionId,
        outcome: "Approved",
        resolvedByIdentityId: IdentityId("identity-reviewer"),
        resolvedByMembershipId: MembershipId("membership-reviewer"),
      },
    );

    const completed = await completeWorkUseCase(h.deps, ctx, work.workId, "Shipped");
    expect(completed.status).toBe("Completed");
    expect(h.outbox.typesOf()).toContain("WorkCompleted");
  });
});

describe("rejection blocks completion", () => {
  it("an Unsatisfied gate refuses completion until a new Decision is approved", async () => {
    const { h, ctx, work } = await setupInProgressWork();
    const decision = await createDecisionUseCase(h.deps, ctx, {
      relatedWorkId: work.workId,
      title: "Launch",
      question: "Launch?",
      options: [{ optionId: "yes", summary: "Yes" }],
    });
    const blocked = await submitBlockingDecisionUseCase(h.deps, ctx, decision.decisionId);
    const rejected = await rejectDecisionUseCase(
      h.deps,
      ctxFor(reviewer()),
      decision.decisionId,
      "Insufficient evidence",
    );

    await applyDecisionOutcomeUseCase(
      h.deps,
      { principal: system, now: NOW },
      {
        organizationId: ORG,
        workId: blocked.work.workId,
        decisionId: decision.decisionId,
        revisionNumber: 1,
        submittedSnapshotId: rejected.reviewRecords[0]!.revisionId,
        outcome: "Rejected",
        resolvedByIdentityId: IdentityId("identity-reviewer"),
        resolvedByMembershipId: MembershipId("membership-reviewer"),
      },
    );

    await expect(
      completeWorkUseCase(h.deps, ctx, blocked.work.workId, "Shipped anyway"),
    ).rejects.toThrowError(/requires an approved Decision/);

    // The rejected revision remains, and a new revision may be started.
    const revised = await startRevisionUseCase(h.deps, ctx, decision.decisionId);
    expect(revised.status).toBe("Draft");
    expect(revised.revisions).toHaveLength(2);
    expect(revised.reviewRecords).toHaveLength(1);
  });
});

describe("outbox", () => {
  it("records the events of a completed slice in order", async () => {
    const { h, ctx, work } = await setupInProgressWork();
    const decision = await createDecisionUseCase(h.deps, ctx, {
      relatedWorkId: work.workId,
      title: "Launch",
      question: "Launch?",
      options: [{ optionId: "yes", summary: "Yes" }],
    });
    await submitBlockingDecisionUseCase(h.deps, ctx, decision.decisionId);

    expect(h.outbox.typesOf()).toEqual([
      "WorkCreated",
      "WorkStarted",
      "DecisionCreated",
      "DecisionSubmitted",
      "WorkDecisionRequested",
    ]);
  });

  it("appends no event when a command is rejected", async () => {
    const { h, ctx, work } = await setupInProgressWork();
    const before = h.outbox.typesOf().length;
    await expect(
      completeWorkUseCase(h.deps, ctx, work.workId, "   "),
    ).rejects.toThrowError(/completion summary is required/);
    expect(h.outbox.typesOf()).toHaveLength(before);
  });
});
