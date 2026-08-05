/**
 * What "healthy" means for an asynchronous workflow.
 *
 * The rule is the part worth getting right, and it is the part a query cannot
 * check: the architecture requires health to be determined by *age* rather than
 * *count*, and the two disagree in both directions on the cases that matter.
 */

import { describe, expect, it } from "vitest";

import { AuthorizationError } from "./authorization.js";
import {
  BLOCKED_AFTER_SECONDS,
  STALE_AFTER_SECONDS,
  DEGRADED_AFTER_SECONDS,
  classify,
  readWorkflowHealthUseCase,
  worstOf,
} from "./workflow-health.js";
import { reconcileWorkflowHealthUseCase } from "./workflow-health-reconcile.js";
import { buildTestHarness } from "./testing/in-memory.js";
import { IdentityId, OrganizationId, type HumanMemberPrincipal, type Role } from "@aios/types";

const NOW = new Date("2026-08-04T12:00:00Z");
const ORG = OrganizationId("11111111-1111-1111-1111-111111111111");

const ctx = (roles: Role[]) => ({
  principal: {
    type: "HumanMember",
    identityId: IdentityId("identity-1"),
    membershipId: "membership-1" as never,
    organizationId: ORG,
    roles,
  } satisfies HumanMemberPrincipal,
  organizationId: ORG,
  now: NOW,
});

describe("classifying one workflow", () => {
  const counts = (over: Partial<Parameters<typeof classify>[0] & object> = {}) => ({
    pending: 0,
    oldestPendingSeconds: null,
    unresolvedFailures: 0,
    ...over,
  });

  it("is healthy with nothing pending", () => {
    expect(classify(counts())).toEqual({ status: "Healthy", reasonCode: "OK" });
  });

  it("stays healthy with many items moving promptly", () => {
    // The direction a count-based rule gets wrong. A busy Organization is not a
    // sick one, and the architecture is explicit: "A quiet Organization MUST NOT
    // become Degraded only because it has no recent success."
    expect(classify(counts({ pending: 5000, oldestPendingSeconds: 3 })).status).toBe(
      "Healthy",
    );
  });

  it("degrades on one item stuck past the threshold", () => {
    // The other direction. One item is a trivial count and a real stall.
    expect(
      classify(counts({ pending: 1, oldestPendingSeconds: DEGRADED_AFTER_SECONDS })),
    ).toEqual({ status: "Degraded", reasonCode: "PENDING_OVER_THRESHOLD" });
  });

  it("becomes critical when the wait gets long", () => {
    expect(
      classify(counts({ pending: 1, oldestPendingSeconds: BLOCKED_AFTER_SECONDS })).status,
    ).toBe("Blocked");
  });

  it("treats an unresolved failure as critical regardless of age", () => {
    // A dead letter that arrived a second ago is already a decision waiting for
    // a person. Waiting five minutes to say so would only delay it.
    expect(
      classify(counts({ pending: 1, oldestPendingSeconds: 1, unresolvedFailures: 1 })),
    ).toEqual({ status: "Blocked", reasonCode: "UNRESOLVED_FAILURE" });
  });

  it("reports Unknown when the query could not answer", () => {
    // "Missing evidence MUST NOT be presented as `Healthy`."
    expect(classify(null)).toEqual({ status: "Unknown", reasonCode: "QUERY_FAILED" });
  });
});

describe("rolling four workflows into one status", () => {
  it("reports the worst", () => {
    expect(worstOf(["Healthy", "Degraded", "Healthy"])).toBe("Degraded");
    expect(worstOf(["Degraded", "Blocked"])).toBe("Blocked");
  });

  it("ranks Unknown above Degraded", () => {
    // A workflow nobody can measure is a worse position than one measurably
    // behind: the second has a number to act on and the first does not.
    expect(worstOf(["Degraded", "Unknown"])).toBe("Unknown");
  });

  it("does not let Unknown mask a Blocked", () => {
    expect(worstOf(["Unknown", "Blocked"])).toBe("Blocked");
  });
});

describe("reading the report", () => {
  it("requires the promoted permission", async () => {
    const h = buildTestHarness(NOW);
    // A Member has no business reading operational health, and the promotion
    // granted it to Owner and Admin only.
    await expect(
      readWorkflowHealthUseCase(h.deps, ctx(["Member"])),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("reports every workflow type, so none can be silently missing", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    const report = await readWorkflowHealthUseCase(h.deps, ctx(["OrganizationOwner"]));

    expect(report.workflows.map((w) => w.workflowType)).toEqual([
      "OutboxPublication",
      "ConsumerDelivery",
      "DeadLetter",
      "MemoryGeneration",
    ]);
    expect(report.status).toBe("Healthy");
  });

  it("reports NoData before the projection has ever observed the Organization", async () => {
    // The read no longer derives anything itself (ADR-0023), so an Organization
    // the reconcile has not reached has no row. That is `NoData` — never
    // `Healthy`, which is what an empty result would look like to anyone who
    // assumed absence meant nothing was wrong.
    const h = buildTestHarness(NOW);

    const report = await readWorkflowHealthUseCase(h.deps, ctx(["OrganizationOwner"]));

    expect(report.workflows.every((w) => w.status === "NoData")).toBe(true);
    expect(report.status).toBe("NoData");
    expect(report.freshness.ageSeconds).toBeNull();
  });

  it("reports a workflow the query could not answer as Unknown, not absent", async () => {
    // An operator reading three healthy workflows would reasonably conclude the
    // fourth was fine. It must appear, and it must not say Healthy.
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    h.workflowHealth.set("MemoryGeneration", null);
    await reconcileWorkflowHealthUseCase(h.deps);

    const report = await readWorkflowHealthUseCase(h.deps, ctx(["OrganizationOwner"]));
    const generation = report.workflows.find((w) => w.workflowType === "MemoryGeneration");

    expect(generation?.status).toBe("Unknown");
    expect(report.status).toBe("Unknown");
  });

  it("reports Stale rather than the numbers it last had", async () => {
    // The property the projection exists for, and the one the live query could
    // not have: "When the projection becomes Stale, operators must not infer
    // that Organizations are Healthy."
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    const later = new Date(NOW.getTime() + (STALE_AFTER_SECONDS + 1) * 1000);
    const report = await readWorkflowHealthUseCase(h.deps, {
      ...ctx(["OrganizationOwner"]),
      now: later,
    });

    expect(report.freshness.stale).toBe(true);
    expect(report.status).toBe("Stale");
    expect(report.workflows.every((w) => w.status === "Stale")).toBe(true);
    expect(report.workflows.every((w) => w.reasonCode === "PROJECTION_STALE")).toBe(true);
  });

  it("is not stale one second before the threshold", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    const report = await readWorkflowHealthUseCase(h.deps, {
      ...ctx(["OrganizationOwner"]),
      now: new Date(NOW.getTime() + (STALE_AFTER_SECONDS - 1) * 1000),
    });

    expect(report.freshness.stale).toBe(false);
    expect(report.status).toBe("Healthy");
  });
});
