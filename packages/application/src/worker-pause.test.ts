/**
 * Worker pause and resume (ADR-0022).
 *
 * The authorization boundary is the part worth testing hardest, because it is
 * the reason this sat unbuilt: a pause is process-wide by nature and a
 * permission is Organization-scoped by construction, and the whole design exists
 * to keep those two facts from colliding.
 */

import { describe, expect, it } from "vitest";

import { IdentityId, MembershipId, OrganizationId } from "@aios/types";

import { AuthorizationError } from "./authorization.js";
import { buildTestHarness } from "./testing/in-memory.js";
import {
  PAUSABLE_WORKER_TYPES,
  isPausableWorkerType,
  pauseWorkerUseCase,
  resumeWorkerUseCase,
} from "./worker-pause.js";
import { readWorkflowHealthUseCase } from "./workflow-health.js";

const ORG = OrganizationId("11111111-1111-4111-8111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-4222-8222-222222222222");

const contextFor = (
  organizationId = ORG,
  roles: readonly ("OrganizationOwner" | "OrganizationAdmin" | "Member")[] = [
    "OrganizationOwner",
  ],
) => ({
  organizationId,
  now: new Date("2026-08-05T09:00:00Z"),
  principal: {
    type: "HumanMember" as const,
    identityId: IdentityId("0a105eed-0000-4000-8000-000000000001"),
    membershipId: MembershipId("0a105eed-0000-4000-8000-0000000000a1"),
    organizationId,
    roles,
  },
});

const COMMAND = {
  workerType: "MemoryGeneration" as const,
  reasonCode: "PROVIDER_UNSAFE",
  reason: "The provider is returning malformed candidates.",
};

describe("the pausable vocabulary", () => {
  it("is a subset of the workflow health types, so one name means one thing", () => {
    expect([...PAUSABLE_WORKER_TYPES]).toEqual(["OutboxPublication", "MemoryGeneration"]);
  });

  it("rejects a workflow type that has no claim loop to pause", () => {
    // Accepting these would let an operator believe processing had stopped when
    // nothing had changed — the failure mode of a control whose whole purpose is
    // to stop something.
    expect(isPausableWorkerType("ConsumerDelivery")).toBe(false);
    expect(isPausableWorkerType("DeadLetter")).toBe(false);
  });
});

describe("pausing a Worker", () => {
  it("records who paused it, when, and why", async () => {
    const h = buildTestHarness();

    const pause = await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);

    expect(pause.workerType).toBe("MemoryGeneration");
    expect(pause.reason).toBe("The provider is returning malformed candidates.");
    expect(pause.pausedByMembershipId).toBe("0a105eed-0000-4000-8000-0000000000a1");
    expect(pause.pausedAt).toEqual(new Date("2026-08-05T09:00:00Z"));
  });

  it("takes attribution from the principal, never from the command", async () => {
    const h = buildTestHarness();
    const context = contextFor();

    // A caller who could name their own actor could write someone else's name
    // onto the durable record of a privileged operational action.
    await pauseWorkerUseCase(h.deps, context, {
      ...COMMAND,
      ...({ pausedByMembershipId: "not-mine", organizationId: OTHER_ORG } as object),
    });

    const [stored] = await h.workerPauses.listFor(ORG);
    expect(stored?.pausedByMembershipId).toBe(context.principal.membershipId);
    expect(stored?.organizationId).toBe(ORG);
  });

  it("keeps the first reason when the command is repeated", async () => {
    const h = buildTestHarness();

    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);
    const second = await pauseWorkerUseCase(h.deps, contextFor(), {
      ...COMMAND,
      reason: "A different note entirely.",
    });

    // The first pause is the one that explains the current state. Overwriting it
    // would discard the note an operator left for whoever lifts it.
    expect(second.reason).toBe("The provider is returning malformed candidates.");
  });

  it("requires a reason", async () => {
    const h = buildTestHarness();

    await expect(
      pauseWorkerUseCase(h.deps, contextFor(), { ...COMMAND, reason: "   " }),
    ).rejects.toThrow(/reason is required/i);
  });

  it("bounds the reason, so operational state cannot carry a payload", async () => {
    const h = buildTestHarness();

    await expect(
      pauseWorkerUseCase(h.deps, contextFor(), { ...COMMAND, reason: "x".repeat(501) }),
    ).rejects.toThrow(/at most 500/);
  });

  it("pauses one Worker type without pausing the other", async () => {
    const h = buildTestHarness();

    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);

    const stored = await h.workerPauses.listFor(ORG);
    expect(stored.map((p) => p.workerType)).toEqual(["MemoryGeneration"]);
  });

  it("cannot reach another Organization", async () => {
    const h = buildTestHarness();

    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);

    // The point of the whole design: a permission held through one Membership
    // must not stop another tenant's work.
    expect(await h.workerPauses.listFor(OTHER_ORG)).toEqual([]);
  });
});

describe("who may pause", () => {
  it("refuses a Member", async () => {
    const h = buildTestHarness();

    await expect(
      pauseWorkerUseCase(h.deps, contextFor(ORG, ["Member"]), COMMAND),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("allows an Admin, matching the recovery family it sits beside", async () => {
    const h = buildTestHarness();

    await expect(
      pauseWorkerUseCase(h.deps, contextFor(ORG, ["OrganizationAdmin"]), COMMAND),
    ).resolves.toMatchObject({ workerType: "MemoryGeneration" });
  });

  it("refuses a System Principal, which holds no business authority", async () => {
    const h = buildTestHarness();
    const context = {
      organizationId: ORG,
      now: new Date(),
      principal: { type: "System" as const, component: "outbox-worker", organizationId: ORG },
    };

    await expect(
      pauseWorkerUseCase(h.deps, context, COMMAND),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("resuming", () => {
  it("lifts the pause", async () => {
    const h = buildTestHarness();
    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);

    const result = await resumeWorkerUseCase(h.deps, contextFor(), "MemoryGeneration");

    expect(result).toEqual({ resumed: true });
    expect(await h.workerPauses.listFor(ORG)).toEqual([]);
  });

  it("succeeds when there was nothing to lift", async () => {
    const h = buildTestHarness();

    // Not a 404: an operator restoring service should not have to work out
    // whether someone else already lifted it.
    expect(await resumeWorkerUseCase(h.deps, contextFor(), "OutboxPublication")).toEqual({
      resumed: false,
    });
  });

  it("lifts only the Worker type named", async () => {
    const h = buildTestHarness();
    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);
    await pauseWorkerUseCase(h.deps, contextFor(), {
      ...COMMAND,
      workerType: "OutboxPublication",
    });

    await resumeWorkerUseCase(h.deps, contextFor(), "MemoryGeneration");

    const remaining = await h.workerPauses.listFor(ORG);
    expect(remaining.map((p) => p.workerType)).toEqual(["OutboxPublication"]);
  });

  it("refuses a Member", async () => {
    const h = buildTestHarness();

    await expect(
      resumeWorkerUseCase(h.deps, contextFor(ORG, ["Member"]), "MemoryGeneration"),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("the health report", () => {
  it("says a paused workflow is paused, and still says it is degrading", async () => {
    const h = buildTestHarness();
    h.workflowHealth.set("MemoryGeneration", {
      pending: 4,
      oldestPendingSeconds: 3600,
      unresolvedFailures: 0,
    });
    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);

    const report = await readWorkflowHealthUseCase(h.deps, contextFor());
    const memory = report.workflows.find((w) => w.workflowType === "MemoryGeneration");

    // Both facts, because they are different questions. The backlog is real, and
    // an operator reading `Critical` needs to see that they are looking at their
    // own containment rather than a new incident.
    expect(memory).toMatchObject({ status: "Critical", paused: true });
  });

  it("reports the workflows that cannot be paused as not paused", async () => {
    const h = buildTestHarness();
    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);

    const report = await readWorkflowHealthUseCase(h.deps, contextFor());

    expect(
      report.workflows.filter((w) => w.paused).map((w) => w.workflowType),
    ).toEqual(["MemoryGeneration"]);
  });

  it("does not show one Organization's pause to another", async () => {
    const h = buildTestHarness();
    await pauseWorkerUseCase(h.deps, contextFor(), COMMAND);

    const report = await readWorkflowHealthUseCase(h.deps, contextFor(OTHER_ORG));

    expect(report.workflows.every((w) => !w.paused)).toBe(true);
  });
});
