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
  getOrganizationUseCase,
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
      { name: "Northwind" },
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
    await createOrganizationUseCase(h.deps, creator(), { name: "Northwind" });

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
    await createOrganizationUseCase(h.deps, creator(), { name: "First" });
    const first = await h.identities.findBySubject(SUBJECT);

    await createOrganizationUseCase(h.deps, creator(), { name: "Second" });
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
      createOrganizationUseCase(h.deps, creator(), { name: "Northwind" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("emits OrganizationCreated and MembershipActivated", async () => {
    const h = buildTestHarness(NOW);
    await createOrganizationUseCase(h.deps, creator(), { name: "Northwind" });

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
      createOrganizationUseCase(h.deps, creator(), { name: "   " }),
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
