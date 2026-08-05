/**
 * Restricted administrative diagnostics (ADR-0023).
 *
 * The counting is SQL and is tested against a real database. What is tested here
 * is everything the architecture attaches to this surface *besides* the numbers:
 * who may read it, what bounds are applied, and that the response cannot carry
 * anything the architecture requires redacted.
 */

import { describe, expect, it } from "vitest";

import { IdentityId, OrganizationId, type HumanMemberPrincipal, type Role } from "@aios/types";

import { AuthorizationError } from "./authorization.js";
import {
  DEFAULT_WINDOW_SECONDS,
  MAX_ITEMS,
  MAX_WINDOW_SECONDS,
  readDiagnosticsUseCase,
} from "./diagnostics.js";
import { buildTestHarness } from "./testing/in-memory.js";
import { reconcileWorkflowHealthUseCase } from "./workflow-health-reconcile.js";

const NOW = new Date("2026-08-05T09:00:00Z");
const ORG = OrganizationId("11111111-1111-1111-1111-111111111111");

const ctx = (roles: Role[] = ["OrganizationOwner"]) => ({
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

describe("who may read diagnostics", () => {
  it("allows an Owner", async () => {
    const h = buildTestHarness(NOW);
    await expect(readDiagnosticsUseCase(h.deps, ctx())).resolves.toMatchObject({
      organizationId: ORG,
    });
  });

  it("refuses an Admin, unlike every other operations permission", async () => {
    // The architecture asks this surface — and only this surface — for "an
    // authenticated operator with an explicit operational role". The MVP models
    // none, so ADR-0023 narrows to the narrowest role that exists rather than
    // inventing one.
    const h = buildTestHarness(NOW);
    await expect(
      readDiagnosticsUseCase(h.deps, ctx(["OrganizationAdmin"])),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a Member", async () => {
    const h = buildTestHarness(NOW);
    await expect(readDiagnosticsUseCase(h.deps, ctx(["Member"]))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses a Secretary, which cannot enumerate Organization health", async () => {
    const h = buildTestHarness(NOW);
    const context = {
      organizationId: ORG,
      now: NOW,
      principal: {
        type: "AI" as const,
        identityId: IdentityId("secretary-1"),
        organizationId: ORG,
        assistanceOperation: "decision.draft@1",
      },
    };

    await expect(readDiagnosticsUseCase(h.deps, context)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("the bounds the architecture requires", () => {
  it("defaults the window rather than looking at everything", async () => {
    const h = buildTestHarness(NOW);

    const report = await readDiagnosticsUseCase(h.deps, ctx());

    expect(report.windowSeconds).toBe(DEFAULT_WINDOW_SECONDS);
    expect(h.diagnostics.lastQuery?.since).toEqual(
      new Date(NOW.getTime() - DEFAULT_WINDOW_SECONDS * 1000),
    );
  });

  it("clamps a window wider than the maximum instead of refusing it", async () => {
    const h = buildTestHarness(NOW);

    // Accepting and clamping rather than rejecting: an operator mid-incident
    // should not have a query refused over a query string, and the response
    // reports the window actually used.
    const report = await readDiagnosticsUseCase(h.deps, ctx(), {
      windowSeconds: MAX_WINDOW_SECONDS * 10,
    });

    expect(report.windowSeconds).toBe(MAX_WINDOW_SECONDS);
  });

  it("clamps a nonsensical window up to a floor", async () => {
    const h = buildTestHarness(NOW);
    const report = await readDiagnosticsUseCase(h.deps, ctx(), { windowSeconds: -5 });
    expect(report.windowSeconds).toBe(60);
  });

  it("caps every list", async () => {
    const h = buildTestHarness(NOW);
    await readDiagnosticsUseCase(h.deps, ctx());
    expect(h.diagnostics.lastQuery?.limit).toBe(MAX_ITEMS);
  });

  it("passes the caller's own Organization and nothing else", async () => {
    const h = buildTestHarness(NOW);
    await readDiagnosticsUseCase(h.deps, ctx());
    expect(h.diagnostics.lastQuery?.organizationId).toBe(ORG);
  });
});

describe("what it correlates", () => {
  it("reports the projection's freshness beside the workflows", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    const report = await readDiagnosticsUseCase(h.deps, ctx());

    expect(report.projection.stale).toBe(false);
    expect(report.projection.projectionVersion).toBe(1);
    expect(report.workflows).toHaveLength(4);
  });

  it("reports a stale projection as stale, so a fresh-looking answer is not implied", async () => {
    const h = buildTestHarness(NOW);
    h.workflowHealth.observe(ORG);
    await reconcileWorkflowHealthUseCase(h.deps);

    const report = await readDiagnosticsUseCase(h.deps, {
      ...ctx(),
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
    });

    expect(report.projection.stale).toBe(true);
  });

  it("reports a pause by its code, never by the operator's words", async () => {
    const h = buildTestHarness(NOW);
    await h.workerPauses.pause({
      organizationId: ORG,
      workerType: "MemoryGeneration",
      pausedAt: NOW,
      pausedByIdentityId: "identity-1",
      pausedByMembershipId: "membership-1",
      reasonCode: "PROVIDER_UNSAFE",
      reason: "A free-text note that must not reach a diagnostic response.",
    });

    const report = await readDiagnosticsUseCase(h.deps, ctx());

    expect(report.pauses).toEqual([
      { workerType: "MemoryGeneration", pausedAtSeconds: 0, reasonCode: "PROVIDER_UNSAFE" },
    ]);
    // The rule stated as a property rather than trusted: "use stable bounded
    // reason codes rather than unbounded error text". A response that carried an
    // operator's prose would be one refactor away from carrying a driver's.
    expect(JSON.stringify(report)).not.toContain("free-text note");
  });
});
