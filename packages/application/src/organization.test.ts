/**
 * Organization bootstrap through the Application Layer.
 *
 * What the Aggregate cannot cover: the coordinated creation of two Aggregates in
 * one transaction, the Identity check that precedes it, and the invariant the
 * whole workflow exists for — an Active Organization is never visible without an
 * active Owner.
 */

import { describe, expect, it } from "vitest";

import {
  IdentityId,
  OrganizationId,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

import { AuthorizationError } from "./authorization.js";
import {
  archiveOrganizationUseCase,
  createOrganizationUseCase,
  grantAssistanceUseCase,
  revokeAssistanceUseCase,
  getOrganizationUseCase,
  listCallerOrganizationsUseCase,
  reactivateOrganizationUseCase,
  renameOrganizationUseCase,
  suspendOrganizationUseCase,
} from "./organization-use-cases.js";
import { listMembersUseCase } from "./membership-use-cases.js";
import {
  completeWorkUseCase,
  createWorkUseCase,
  startWorkUseCase,
} from "./work-use-cases.js";
import { buildTestHarness } from "./testing/in-memory.js";

const NOW = new Date("2026-07-28T10:00:00Z");

/** The Organization's Secretary, as the composition root names it. */
const SECRETARY = "secretary-1";

const SUBJECT = {
  provider: "dev",
  issuer: "https://dev.local",
  subject: "founder-1",
};

const creator = () => ({
  subject: SUBJECT,
  displayName: "Olivia Reed",
  email: "olivia@example.test",
  now: NOW,
});

const ctxFor = (organizationId: OrganizationId, roles: Role[] = ["OrganizationOwner"]) => ({
  principal: {
    type: "HumanMember",
    identityId: IdentityId("identity-1"),
    membershipId: "membership-1" as never,
    organizationId,
    roles,
  } satisfies HumanMemberPrincipal,
  organizationId,
  now: NOW,
});

describe("Organization bootstrap", () => {
  it("creates the Organization and its first Owner together", async () => {
    const h = buildTestHarness(NOW);

    const { organization, membership } = await createOrganizationUseCase(
      h.deps,
      creator(),
      { name: "Northwind", secretaryPrincipalId: SECRETARY },
    );

    expect(organization.status).toBe("Active");
    expect(membership.status).toBe("Active");
    expect(membership.roles).toEqual(["OrganizationOwner"]);
    expect(membership.organizationId).toBe(organization.organizationId);
  });

  it("never leaves an Active Organization without an active Owner", async () => {
    const h = buildTestHarness(NOW);
    const { organization } = await createOrganizationUseCase(h.deps, creator(), {
      name: "Northwind",
      secretaryPrincipalId: SECRETARY,
    });

    // The bootstrap invariant, checked from the outside: the member list an
    // administrator would read already contains an active Owner.
    const members = await listMembersUseCase(
      h.deps,
      ctxFor(organization.organizationId),
    );
    expect(
      members.filter(
        (m) => m.status === "Active" && m.roles.includes("OrganizationOwner"),
      ),
    ).toHaveLength(1);
  });

  it("creates the Human Identity when the subject is unmapped", async () => {
    const h = buildTestHarness(NOW);
    await createOrganizationUseCase(h.deps, creator(), {
        name: "Northwind",
        secretaryPrincipalId: SECRETARY,
      });

    // ADR-0013: an unmapped subject "may create a Human Identity". Membership is
    // still granted only here or through the invitation flow.
    const identity = await h.identities.findBySubject(SUBJECT);
    expect(identity).toMatchObject({
      displayName: "Olivia Reed",
      primaryEmailNormalized: "olivia@example.test",
    });
  });

  it("reuses an Identity the subject already maps to", async () => {
    const h = buildTestHarness(NOW);
    await createOrganizationUseCase(h.deps, creator(), {
        name: "First",
        secretaryPrincipalId: SECRETARY,
      });
    const first = await h.identities.findBySubject(SUBJECT);

    await createOrganizationUseCase(h.deps, creator(), {
        name: "Second",
        secretaryPrincipalId: SECRETARY,
      });
    const second = await h.identities.findBySubject(SUBJECT);

    // "A person may have Memberships in multiple Organizations" — one Identity,
    // two Organizations, not two Identities.
    expect(second?.identityId).toBe(first?.identityId);
  });

  it("refuses a disabled Identity", async () => {
    const h = buildTestHarness(NOW);
    h.identities.seed(
      {
        identityId: IdentityId("identity-disabled"),
        status: "Disabled",
        displayName: "Former",
        primaryEmailNormalized: "former@example.test",
      },
      SUBJECT,
    );

    // "Verify Human Identity is Active" is the first step of the bootstrap
    // transaction: a disabled Identity must not acquire a new Organization.
    await expect(
      createOrganizationUseCase(h.deps, creator(), {
        name: "Northwind",
        secretaryPrincipalId: SECRETARY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("emits OrganizationCreated and MembershipActivated", async () => {
    const h = buildTestHarness(NOW);
    await createOrganizationUseCase(h.deps, creator(), {
        name: "Northwind",
        secretaryPrincipalId: SECRETARY,
      });

    // `MembershipCreated` appears in the identity document but is not a
    // registered event name; the events catalogue is authoritative for names.
    expect(h.outbox.typesOf()).toEqual([
      "OrganizationCreated",
      "MembershipActivated",
    ]);
  });

  it("refuses a blank name before anything is written", async () => {
    const h = buildTestHarness(NOW);

    await expect(
      createOrganizationUseCase(h.deps, creator(), {
        name: "   ",
        secretaryPrincipalId: SECRETARY,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(h.outbox.typesOf()).toEqual([]);
    expect(await h.identities.findBySubject(SUBJECT)).toBeNull();
  });
});

describe("renaming", () => {
  const withOrganization = async () => {
    const h = buildTestHarness(NOW);
    const { organization } = await createOrganizationUseCase(h.deps, creator(), {
      name: "Northwind",
      secretaryPrincipalId: SECRETARY,
    });
    return { h, organizationId: organization.organizationId };
  };

  it("renames and reads back", async () => {
    const { h, organizationId } = await withOrganization();

    await renameOrganizationUseCase(h.deps, ctxFor(organizationId), "Northwind Group");

    const reloaded = await getOrganizationUseCase(h.deps, organizationId);
    expect(reloaded.name).toBe("Northwind Group");
    expect(reloaded.version).toBe(2);
  });

  it("refuses a Member and a Reviewer", async () => {
    const { h, organizationId } = await withOrganization();

    for (const roles of [["Member"], ["Reviewer"]] as Role[][]) {
      await expect(
        renameOrganizationUseCase(h.deps, ctxFor(organizationId, roles), "Mine"),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("reports an Organization that does not exist as absent", async () => {
    const h = buildTestHarness(NOW);
    await expect(
      renameOrganizationUseCase(
        h.deps,
        ctxFor(OrganizationId("organization-missing")),
        "Ghost",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

/**
 * The Owner-held Organization lifecycle (ADR-0017).
 *
 * The Aggregate covers the transitions themselves. What only exists here is the
 * archival precondition, which spans Aggregates: a Work left `InProgress` in a
 * read-only Organization could never afterwards be completed or cancelled.
 */
describe("the Organization lifecycle", () => {
  const withOrganization = async () => {
    const h = buildTestHarness(NOW);
    const { organization } = await createOrganizationUseCase(h.deps, creator(), {
      name: "Northwind",
      secretaryPrincipalId: SECRETARY,
    });
    return { h, organizationId: organization.organizationId };
  };

  it("suspends and reactivates, back to Active", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    expect((await suspendOrganizationUseCase(h.deps, ctx, "Pausing.")).status).toBe(
      "Suspended",
    );
    expect((await reactivateOrganizationUseCase(h.deps, ctx, "Back.")).status).toBe(
      "Active",
    );
  });

  it("gives the lifecycle to the Owner and to no other role", async () => {
    const { h, organizationId } = await withOrganization();

    // Admin included, and deliberately. While an Organization is Suspended,
    // reactivation is the only reachable route — an Admin who could suspend
    // could strand every Owner behind a command only an Owner can call.
    for (const roles of [["OrganizationAdmin"], ["Member"], ["Reviewer"]] as Role[][]) {
      const ctx = ctxFor(organizationId, roles);
      await expect(
        suspendOrganizationUseCase(h.deps, ctx, "Mine now."),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        reactivateOrganizationUseCase(h.deps, ctx, "Mine now."),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        archiveOrganizationUseCase(h.deps, ctx, "Mine now."),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("archives an Organization with no live Work", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    // A Draft Work does not block: nothing has started, so nothing is stranded.
    await createWorkUseCase(h.deps, ctx, { title: "Never started" });

    expect((await archiveOrganizationUseCase(h.deps, ctx, "Closing.")).status).toBe(
      "Archived",
    );
  });

  it("refuses archival while Work is InProgress, naming the count", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    const work = await createWorkUseCase(h.deps, ctx, { title: "Live" });
    await startWorkUseCase(h.deps, ctx, work.workId);

    await expect(
      archiveOrganizationUseCase(h.deps, ctx, "Closing."),
    ).rejects.toMatchObject({ code: "LIVE_WORK_REMAINS", count: 1 });
  });

  /**
   * The refusal is a condition the caller can clear, not a permanent one — which
   * is why it is a `409` and not a `422`.
   */
  it("allows archival once the live Work is finished", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    const work = await createWorkUseCase(h.deps, ctx, { title: "Live" });
    await startWorkUseCase(h.deps, ctx, work.workId);
    await expect(
      archiveOrganizationUseCase(h.deps, ctx, "Closing."),
    ).rejects.toMatchObject({ code: "LIVE_WORK_REMAINS" });

    await completeWorkUseCase(h.deps, ctx, work.workId, "Done.");

    expect((await archiveOrganizationUseCase(h.deps, ctx, "Closing.")).status).toBe(
      "Archived",
    );
  });

  it("counts every live Work, not just the first", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    for (const title of ["One", "Two", "Three"]) {
      const work = await createWorkUseCase(h.deps, ctx, { title });
      await startWorkUseCase(h.deps, ctx, work.workId);
    }

    await expect(
      archiveOrganizationUseCase(h.deps, ctx, "Closing."),
    ).rejects.toMatchObject({ count: 3 });
  });

  it("records each lifecycle transition in the audit", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    await suspendOrganizationUseCase(h.deps, ctx, "Pausing.");
    await reactivateOrganizationUseCase(h.deps, ctx, "Back.");
    await archiveOrganizationUseCase(h.deps, ctx, "Closing.");
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      h.audit
        .transitionsFor(organizationId)
        .map((row) => [row.commandType, row.previousState, row.nextState]),
    ).toEqual([
      ["SuspendOrganization", "Active", "Suspended"],
      ["ReactivateOrganization", "Suspended", "Active"],
      ["ArchiveOrganization", "Active", "Archived"],
    ]);
  });
});

/**
 * Secretary assistance grants (ADR-0019).
 *
 * The Organization enables and disables its own Secretary. What only exists at
 * this level is the registry boundary — a caller names an operation, never a
 * context — and the bootstrap provisioning that makes a new Organization
 * usable without a second step.
 */
describe("assistance grants", () => {
  const withOrganization = async () => {
    const h = buildTestHarness(NOW);
    const { organization, membership } = await createOrganizationUseCase(
      h.deps,
      creator(),
      { name: "Northwind", secretaryPrincipalId: SECRETARY },
    );
    return { h, organizationId: organization.organizationId, membership };
  };

  const isGranted = (h: ReturnType<typeof buildTestHarness>, organizationId: OrganizationId) =>
    h.assistanceGrants.isGranted({
      organizationId,
      secretaryPrincipalId: SECRETARY,
      contextKey: "Decision",
      assistanceOperation: "decision.draft_material",
      portContractVersion: 1,
    });

  it("grants the baseline operations when the Organization is created", async () => {
    const { h, organizationId } = await withOrganization();

    // `mvp.md` presents one Secretary per Organization as a property of an
    // Organization, not an opt-in.
    expect(await isGranted(h, organizationId)).toBe(true);
  });

  it("revokes and re-grants, so bootstrap is not a one-way door", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    await revokeAssistanceUseCase(h.deps, ctx, {
      secretaryPrincipalId: SECRETARY,
      operation: "decision.draft_material",
    });
    expect(await isGranted(h, organizationId)).toBe(false);

    await grantAssistanceUseCase(h.deps, ctx, {
      secretaryPrincipalId: SECRETARY,
      operation: "decision.draft_material",
      reason: "Turning the Secretary back on.",
    });
    expect(await isGranted(h, organizationId)).toBe(true);
  });

  it("reports a revocation of something not granted as absent", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    await revokeAssistanceUseCase(h.deps, ctx, {
      secretaryPrincipalId: SECRETARY,
      operation: "decision.draft_material",
    });

    // Silently succeeding would tell an operator the Secretary had been stopped
    // when it was already stopped — the opposite of what they asked to confirm.
    await expect(
      revokeAssistanceUseCase(h.deps, ctx, {
        secretaryPrincipalId: SECRETARY,
        operation: "decision.draft_material",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  /**
   * ADR-0011 requires unknown operations to "fail closed". This is that
   * boundary at granting time: a caller cannot invent an operation and have a
   * grant written for it.
   */
  it("refuses an operation the build does not declare", async () => {
    const { h, organizationId } = await withOrganization();

    await expect(
      grantAssistanceUseCase(h.deps, ctxFor(organizationId), {
        secretaryPrincipalId: SECRETARY,
        operation: "decision.approve",
        reason: "Trying to widen the port.",
      }),
    ).rejects.toMatchObject({ code: "ASSISTANCE_NOT_GRANTED" });
  });

  it("gives both commands to Owner and Admin, and to nobody else", async () => {
    const { h, organizationId } = await withOrganization();

    for (const roles of [["Member"], ["Reviewer"]] as Role[][]) {
      const ctx = ctxFor(organizationId, roles);
      await expect(
        grantAssistanceUseCase(h.deps, ctx, {
          secretaryPrincipalId: SECRETARY,
          operation: "decision.draft_material",
          reason: "Not mine to grant.",
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        revokeAssistanceUseCase(h.deps, ctx, {
          secretaryPrincipalId: SECRETARY,
          operation: "decision.draft_material",
        }),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }

    // An Admin may, because enabling advisory drafting is administration.
    await revokeAssistanceUseCase(h.deps, ctxFor(organizationId, ["OrganizationAdmin"]), {
      secretaryPrincipalId: SECRETARY,
      operation: "decision.draft_material",
    });
    expect(await isGranted(h, organizationId)).toBe(false);
  });

  it("grants idempotently", async () => {
    const { h, organizationId } = await withOrganization();
    const ctx = ctxFor(organizationId);

    // Already granted by the bootstrap. A repeat must not create a second active
    // grant that revocation would then have to find twice.
    await grantAssistanceUseCase(h.deps, ctx, {
      secretaryPrincipalId: SECRETARY,
      operation: "decision.draft_material",
      reason: "Again.",
    });
    expect(await isGranted(h, organizationId)).toBe(true);

    await revokeAssistanceUseCase(h.deps, ctx, {
      secretaryPrincipalId: SECRETARY,
      operation: "decision.draft_material",
    });
    expect(await isGranted(h, organizationId)).toBe(false);
  });
});

describe("listing the Organizations a caller may act in", () => {
  /** A second person, so "only mine" can mean something. */
  const OTHER = {
    provider: "dev",
    issuer: "https://dev.local",
    subject: "stranger-1",
  };

  it("returns the Organizations the caller founded", async () => {
    const h = buildTestHarness(NOW);
    await createOrganizationUseCase(h.deps, creator(), {
      name: "Northwind",
      secretaryPrincipalId: SECRETARY,
    });
    await createOrganizationUseCase(h.deps, creator(), {
      name: "Acme",
      secretaryPrincipalId: SECRETARY,
    });

    const listed = await listCallerOrganizationsUseCase(h.deps, SUBJECT);

    // Sorted by name, so a client renders a stable menu rather than one that
    // reorders whenever the underlying rows do.
    expect(listed.map((o) => o.name)).toEqual(["Acme", "Northwind"]);
    expect(listed.every((o) => o.roles.includes("OrganizationOwner"))).toBe(true);
  });

  it("returns nothing that belongs to someone else", async () => {
    // The property the whole exemption rests on. This route has no Organization
    // context to check, so isolation has to come from the query being derived
    // from the subject — there is no header here to get wrong.
    const h = buildTestHarness(NOW);
    await createOrganizationUseCase(h.deps, creator(), {
      name: "Northwind",
      secretaryPrincipalId: SECRETARY,
    });

    expect(await listCallerOrganizationsUseCase(h.deps, OTHER)).toEqual([]);
  });

  it("is empty for a subject that belongs to nothing yet", async () => {
    // Someone who has signed in but never accepted an invitation or created an
    // Organization. An ordinary state with an ordinary answer — not a 404,
    // which would suggest the route was wrong rather than the answer empty.
    const h = buildTestHarness(NOW);
    expect(await listCallerOrganizationsUseCase(h.deps, SUBJECT)).toEqual([]);
  });

  it("still lists a Suspended Organization, so its Owner can recover it", async () => {
    // Reactivation is exempt from the Organization status check precisely so an
    // Owner can bring a suspended Organization back. An Owner who cannot see it
    // has no route to that exemption, so hiding it here would quietly make the
    // documented recovery path unreachable from any client.
    const h = buildTestHarness(NOW);
    const { organization } = await createOrganizationUseCase(h.deps, creator(), {
      name: "Northwind",
      secretaryPrincipalId: SECRETARY,
    });
    await suspendOrganizationUseCase(
      h.deps,
      ctxFor(organization.organizationId),
      "Billing lapsed.",
    );

    const listed = await listCallerOrganizationsUseCase(h.deps, SUBJECT);

    expect(listed).toHaveLength(1);
    // Reported with its status, so the client can show why it cannot be worked
    // in while still offering the Owner the one command that applies.
    expect(listed[0]?.status).toBe("Suspended");
  });
});
