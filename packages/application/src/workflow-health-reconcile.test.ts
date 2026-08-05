/**
 * Reconciling the workflow-health projection (ADR-0023).
 *
 * The properties worth testing are the ones the architecture states as MUSTs and
 * that nothing else would notice were missing: that the projection is genuinely
 * rebuildable, that the reconcile reports what it corrected, and that a row
 * cannot outlive what it described.
 */

import { describe, expect, it } from "vitest";

import { IdentityId, OrganizationId, type HumanMemberPrincipal } from "@aios/types";

import { buildTestHarness } from "./testing/in-memory.js";
import { readWorkflowHealthUseCase } from "./workflow-health.js";
import { reconcileWorkflowHealthUseCase } from "./workflow-health-reconcile.js";

const NOW = new Date("2026-08-05T09:00:00Z");
const ORG = OrganizationId("11111111-1111-1111-1111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-2222-2222-222222222222");

const ctx = (organizationId = ORG) => ({
  principal: {
    type: "HumanMember",
    identityId: IdentityId("identity-1"),
    membershipId: "membership-1" as never,
    organizationId,
    roles: ["OrganizationOwner"],
  } satisfies HumanMemberPrincipal,
  organizationId,
  now: NOW,
});

describe("the first reconcile", () => {
  it("inserts a row per workflow type and reports them as corrections", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);

    const result = await reconcileWorkflowHealthUseCase(h.deps);

    expect(result).toMatchObject({
      organizations: 1,
      inserted: 4,
      statusChanged: 0,
      removed: 0,
    });
  });

  it("corrects nothing on the second pass", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    const second = await reconcileWorkflowHealthUseCase(h.deps);

    // The whole point of reporting corrections. A projection that keeps needing
    // them is a defect in whatever should have kept it current; zero is what
    // "already correct" looks like.
    expect(second).toMatchObject({ inserted: 0, statusChanged: 0, removed: 0 });
  });
});

describe("the projection is rebuildable", () => {
  it("reproduces itself exactly after being deleted", async () => {
    // "The projection MUST be rebuildable. Rebuilding or deleting it does not
    // change the underlying business or delivery truth."
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    h.workflowHealth.set("OutboxPublication", {
      pending: 3,
      oldestPendingSeconds: 3600,
      unresolvedFailures: 0,
    });
    await reconcileWorkflowHealthUseCase(h.deps);
    const before = await h.workflowHealth.readFor(ORG);

    h.workflowHealth.clearProjection();
    expect(await h.workflowHealth.readFor(ORG)).toEqual([]);

    const rebuild = await reconcileWorkflowHealthUseCase(h.deps);
    const after = await h.workflowHealth.readFor(ORG);

    expect(after).toEqual(before);
    // Every row absent, so every row is an insert. That count is the
    // architecture's "pending source records absent from the health projection"
    // reported rather than silently repaired.
    expect(rebuild.inserted).toBe(4);
  });
});

describe("what the reconcile detects", () => {
  it("reports a status that moved", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    h.workflowHealth.set("DeadLetter", {
      pending: 1,
      oldestPendingSeconds: 5,
      unresolvedFailures: 1,
    });
    const result = await reconcileWorkflowHealthUseCase(h.deps);

    // Healthy → Blocked, which is exactly "terminal failures reported as
    // Healthy" being corrected.
    expect(result.statusChanged).toBe(1);
    const rows = await h.workflowHealth.readFor(ORG);
    expect(rows.find((r) => r.workflowType === "DeadLetter")?.status).toBe("Blocked");
  });

  it("removes rows for an Organization it no longer observes", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    h.workflowHealth.observe(OTHER_ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    // The second Organization stops being observed — archived, in the real
    // adapter. Its rows must not outlive it.
    await h.workflowHealth.removeOthers([ORG]);
    const remaining = await h.workflowHealth.readFor(OTHER_ORG);

    expect(remaining).toEqual([]);
    expect(await h.workflowHealth.readFor(ORG)).toHaveLength(4);
  });

  it("advances the source high-water mark", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);

    const first = await reconcileWorkflowHealthUseCase(h.deps);

    // A clock that does not move is a high-water mark that does not advance,
    // which the architecture requires reconciliation to detect. The harness
    // clock is fixed, so the second pass reports exactly that.
    const second = await reconcileWorkflowHealthUseCase(h.deps);

    expect(first.highWaterMarkAdvanced).toBe(true);
    expect(second.highWaterMarkAdvanced).toBe(false);
  });

  it("counts pending items across every Organization it observed", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    h.workflowHealth.set("OutboxPublication", {
      pending: 7,
      oldestPendingSeconds: 10,
      unresolvedFailures: 0,
    });

    const result = await reconcileWorkflowHealthUseCase(h.deps);

    // Reported beside `highWaterMarkAdvanced` because the two only mean
    // something together: a mark that stops advancing on an idle system is
    // normal, and one that stops with work pending is not.
    expect(result.pendingAcrossAll).toBe(7);
  });
});

describe("the projection keeps Organizations apart", () => {
  it("writes each Organization's rows under its own key", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    h.workflowHealth.observe(OTHER_ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    expect(await h.workflowHealth.readFor(ORG)).toHaveLength(4);
    expect(await h.workflowHealth.readFor(OTHER_ORG)).toHaveLength(4);

    const report = await readWorkflowHealthUseCase(h.deps, ctx(OTHER_ORG));
    expect(report.organizationId).toBe(OTHER_ORG);
  });
});
