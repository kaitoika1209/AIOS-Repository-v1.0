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
  createOrganizationUseCase,
  getOrganizationUseCase,
  renameOrganizationUseCase,
} from "./organization-use-cases.js";
import { listMembersUseCase } from "./membership-use-cases.js";
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
