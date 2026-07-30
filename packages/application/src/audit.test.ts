/**
 * The authorization audit's use-case half.
 *
 * The edge interceptor records *that* a command was allowed or denied; those
 * tests live in `apps/api/src/api.e2e.test.ts`, because the property only exists
 * once a request passes through the interceptor. What is testable here is the
 * half the edge cannot supply: `mvp.md` requires previous and next state on
 * every important business transition, and only the use case sees both.
 */

import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

import { AUTHORIZATION_POLICY_VERSION } from "./audit.js";
import {
  approveDecisionUseCase,
  createDecisionUseCase,
  rejectDecisionUseCase,
  startRevisionUseCase,
  submitBlockingDecisionUseCase,
} from "./decision-use-cases.js";
import {
  cancelWorkUseCase,
  completeWorkUseCase,
  createWorkUseCase,
  editWorkUseCase,
  startWorkUseCase,
} from "./work-use-cases.js";
import { AuthorizationError } from "./authorization.js";
import { buildTestHarness } from "./testing/in-memory.js";

const ORG = OrganizationId("org-1");
const NOW = new Date("2026-07-28T10:00:00Z");

const member = (roles: Role[] = ["Member"]): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-member"),
  membershipId: MembershipId("membership-member"),
  organizationId: ORG,
  roles,
});

const reviewer = (): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-reviewer"),
  membershipId: MembershipId("membership-reviewer"),
  organizationId: ORG,
  roles: ["Reviewer"],
});

const administrator = (): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-admin"),
  membershipId: MembershipId("membership-admin"),
  organizationId: ORG,
  roles: ["OrganizationAdmin"],
});

const contextFor = (principal: HumanMemberPrincipal) => ({
  principal,
  organizationId: ORG,
  now: NOW,
});

/**
 * The audit write is deliberately not awaited into the caller's transaction, so
 * a test that asserts immediately after the use case resolves can race it.
 */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("transition audit", () => {
  it("records the previous and next state of a Work transition", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await startWorkUseCase(harness.deps, ctx, work.workId);
    await settled();

    const rows = harness.audit.transitionsFor(work.workId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      commandType: "StartWork",
      permission: "work.start",
      resourceType: "Work",
      resourceId: work.workId,
      previousState: "Draft",
      nextState: "InProgress",
      outcome: "Allow",
      reasonCode: null,
    });
  });

  it("attributes the transition to the acting Member", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await startWorkUseCase(harness.deps, ctx, work.workId);
    await settled();

    expect(harness.audit.transitionsFor(work.workId)[0]).toMatchObject({
      identityId: IdentityId("identity-member"),
      membershipId: MembershipId("membership-member"),
      principalType: "HumanMember",
      organizationId: ORG,
      evaluatedAt: NOW,
    });
  });

  it("records each transition of a Work's lifecycle in order", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await startWorkUseCase(harness.deps, ctx, work.workId);
    await completeWorkUseCase(harness.deps, ctx, work.workId, "Shipped.");
    await settled();

    expect(
      harness.audit
        .transitionsFor(work.workId)
        .map((row) => [row.previousState, row.nextState]),
    ).toEqual([
      ["Draft", "InProgress"],
      ["InProgress", "Completed"],
    ]);
  });

  /**
   * The distinction the audit exists to draw. A `PATCH` changes what the Work
   * says it is, never what state it is in (ADR-0014), so it has no transition to
   * record — and a row claiming `Draft → Draft` would be noise in the one place
   * that must stay readable.
   */
  it("records no transition for a content edit", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await editWorkUseCase(harness.deps, ctx, work.workId, { title: "Ship it well" });
    await settled();

    expect(harness.audit.transitionsFor(work.workId)).toHaveLength(0);
  });

  /**
   * ADR-0007's atomic activation changes two Aggregates in one transaction, so
   * it records two rows. One row naming both would lose which state belonged to
   * which — and the Work's move into `WaitingForDecision` is the fact an auditor
   * asking "why did this Work stall?" needs.
   */
  it("records both Aggregates when atomic activation moves two", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await startWorkUseCase(harness.deps, ctx, work.workId);
    const decision = await createDecisionUseCase(harness.deps, ctx, {
      relatedWorkId: work.workId,
      title: "Which region?",
      question: "Which region do we launch in first?",
      options: [
        { optionId: "eu", summary: "Launch in the EU first." },
        { optionId: "us", summary: "Launch in the US first." },
      ],
    });
    await submitBlockingDecisionUseCase(harness.deps, ctx, decision.decisionId);
    await settled();

    expect(harness.audit.transitionsFor(decision.decisionId)).toMatchObject([
      { commandType: "SubmitForReview", previousState: "Draft", nextState: "InReview" },
    ]);
    expect(harness.audit.transitionsFor(work.workId)).toMatchObject([
      { commandType: "StartWork" },
      {
        commandType: "RequestBlockingDecision",
        permission: "work.request_decision",
        previousState: "InProgress",
        nextState: "WaitingForDecision",
      },
    ]);
  });

  it("records a rejection and the revision that follows it", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());
    const reviewing = contextFor(reviewer());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await startWorkUseCase(harness.deps, ctx, work.workId);
    const decision = await createDecisionUseCase(harness.deps, ctx, {
      relatedWorkId: work.workId,
      title: "Which region?",
      question: "Which region do we launch in first?",
      options: [
        { optionId: "eu", summary: "Launch in the EU first." },
        { optionId: "us", summary: "Launch in the US first." },
      ],
    });
    await submitBlockingDecisionUseCase(harness.deps, ctx, decision.decisionId);
    await rejectDecisionUseCase(
      harness.deps,
      reviewing,
      decision.decisionId,
      "Needs a cost comparison.",
    );
    await startRevisionUseCase(harness.deps, ctx, decision.decisionId);
    await settled();

    expect(
      harness.audit
        .transitionsFor(decision.decisionId)
        .map((row) => [row.commandType, row.previousState, row.nextState]),
    ).toEqual([
      ["SubmitForReview", "Draft", "InReview"],
      ["RejectDecision", "InReview", "Rejected"],
      ["StartRevision", "Rejected", "Draft"],
    ]);
  });

  /**
   * A refused command changes nothing, so it has no transition to record. The
   * denial is not lost — the edge interceptor records it, because the edge is
   * the only place that sees a command that never reached its use case.
   */
  it("records nothing when the command is refused", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());
    // A Reviewer reviews; the matrix gives them no `work.start`, so the command
    // is refused at step 5 and never reaches the Aggregate.
    const outsider = contextFor(reviewer());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await expect(
      startWorkUseCase(harness.deps, outsider, work.workId),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await settled();

    expect(harness.audit.entries).toHaveLength(0);
  });

  /**
   * An audit outage must not become an availability outage. The command has
   * already committed by the time the row is written; refusing it afterwards
   * would undo work that succeeded.
   */
  it("does not fail the command when the audit write fails", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());
    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });

    harness.audit.record = () => Promise.reject(new Error("audit store is down"));

    const started = await startWorkUseCase(harness.deps, ctx, work.workId);
    await settled();

    expect(started.status).toBe("InProgress");
    const reread = await harness.work.findById(ORG, work.workId);
    expect(reread?.status).toBe("InProgress");
  });

  it("cancels a Work and records the terminal transition", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());
    // `work.cancel` is an administrative permission; the Member who created the
    // Work does not hold it.
    const admin = contextFor(administrator());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await cancelWorkUseCase(harness.deps, admin, work.workId, "Descoped.");
    await settled();

    expect(harness.audit.transitionsFor(work.workId)).toMatchObject([
      { commandType: "CancelWork", previousState: "Draft", nextState: "Cancelled" },
    ]);
  });

  it("approves a Decision and records the transition", async () => {
    const harness = buildTestHarness(NOW);
    const ctx = contextFor(member());
    const reviewing = contextFor(reviewer());

    const work = await createWorkUseCase(harness.deps, ctx, { title: "Ship it" });
    await startWorkUseCase(harness.deps, ctx, work.workId);
    const decision = await createDecisionUseCase(harness.deps, ctx, {
      relatedWorkId: work.workId,
      title: "Which region?",
      question: "Which region do we launch in first?",
      options: [
        { optionId: "eu", summary: "Launch in the EU first." },
        { optionId: "us", summary: "Launch in the US first." },
      ],
    });
    await submitBlockingDecisionUseCase(harness.deps, ctx, decision.decisionId);
    const submitted = await harness.decisions.findById(ORG, decision.decisionId);
    const optionId = submitted!.revisions.at(-1)!.options[0]!.optionId;

    await approveDecisionUseCase(harness.deps, reviewing, decision.decisionId, {
      selectedOptionId: optionId,
      rationale: "The EU launch is lower risk.",
    });
    await settled();

    expect(harness.audit.transitionsFor(decision.decisionId).at(-1)).toMatchObject({
      commandType: "ApproveDecision",
      permission: "decision.approve",
      previousState: "InReview",
      nextState: "Approved",
      membershipId: MembershipId("membership-reviewer"),
    });
  });

  it("pins the policy version the decision was made under", () => {
    // Recorded rather than implied, so a permission set that changes later does
    // not rewrite what was allowed at the time.
    expect(AUTHORIZATION_POLICY_VERSION).toBe(1);
  });
});
