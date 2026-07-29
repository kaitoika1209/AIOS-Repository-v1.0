import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  type AiPrincipal,
  type HumanMemberPrincipal,
} from "@aios/types";

import {
  createOrganization,
  isOperable,
  renameOrganization,
  type OrganizationState,
} from "./organization.js";
import { DomainError } from "./errors.js";
import type { ActorContext } from "./work.js";

const ORG = OrganizationId("org-1");
const OTHER_ORG = OrganizationId("org-2");
const NOW = new Date("2026-07-28T10:00:00Z");
const FOUNDER = IdentityId("identity-founder");

const owner = (organizationId = ORG): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: FOUNDER,
  membershipId: MembershipId("membership-owner"),
  organizationId,
  roles: ["OrganizationOwner"],
});

const secretary: AiPrincipal = {
  type: "AI",
  identityId: IdentityId("secretary-1"),
  organizationId: ORG,
  assistanceOperation: "memory.generate.v1",
};

const ctx = (
  principal: HumanMemberPrincipal | AiPrincipal = owner(),
): ActorContext => ({ principal, now: NOW });

const created = (): OrganizationState =>
  createOrganization(
    { organizationId: ORG, name: "  Northwind  ", createdByIdentityId: FOUNDER },
    NOW,
  ).state;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected:${String(error)}`;
  }
  return "no error thrown";
};

describe("creating an Organization", () => {
  it("starts Active with the name trimmed", () => {
    const { state, events } = createOrganization(
      { organizationId: ORG, name: "  Northwind  ", createdByIdentityId: FOUNDER },
      NOW,
    );

    // Active is the only entry state: there is no draft Organization.
    expect(state.status).toBe("Active");
    expect(state.name).toBe("Northwind");
    expect(state.version).toBe(1);
    expect(isOperable(state)).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["OrganizationCreated"]);
  });

  it("attributes creation with no acting Membership", () => {
    // The creator's Membership does not exist when this event is produced, so
    // there is none to attribute the event to.
    const { events } = createOrganization(
      { organizationId: ORG, name: "Northwind", createdByIdentityId: FOUNDER },
      NOW,
    );

    expect(events[0]).toMatchObject({
      actorIdentityId: FOUNDER,
      actorMembershipId: null,
      name: "Northwind",
    });
  });

  it("does not create a Membership", () => {
    // The Owner Membership is a separate Aggregate. "Organization bootstrap ...
    // does not merge Aggregate boundaries."
    const { state } = createOrganization(
      { organizationId: ORG, name: "Northwind", createdByIdentityId: FOUNDER },
      NOW,
    );
    expect(Object.keys(state)).not.toContain("memberships");
  });

  it("refuses a blank name", () => {
    expect(() =>
      createOrganization(
        { organizationId: ORG, name: "   ", createdByIdentityId: FOUNDER },
        NOW,
      ),
    ).toThrowError(/name is required/);
  });

  it("refuses a name over the limit", () => {
    expect(
      codeOf(() =>
        createOrganization(
          { organizationId: ORG, name: "x".repeat(201), createdByIdentityId: FOUNDER },
          NOW,
        ),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("renaming an Organization", () => {
  it("changes the name and advances the version", () => {
    const { state, events } = renameOrganization(created(), "Northwind Group", ctx());

    expect(state.name).toBe("Northwind Group");
    expect(state.version).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["OrganizationRenamed"]);
  });

  it("advances the version even when the name is unchanged", () => {
    // A caller holding a stale expected version must not have it accepted
    // because their no-op happened to match.
    const before = created();
    expect(renameOrganization(before, before.name, ctx()).state.version).toBe(
      before.version + 1,
    );
  });

  it("refuses a Member of another Organization", () => {
    expect(() =>
      renameOrganization(created(), "Mine now", ctx(owner(OTHER_ORG))),
    ).toThrowError(/its own Member/);
  });

  it("refuses a non-Human principal", () => {
    expect(() => renameOrganization(created(), "By the AI", ctx(secretary))).toThrowError(
      /Only a Human Member/,
    );
  });

  it("refuses an Archived Organization", () => {
    // An archived Organization is a historical record; renaming it would change
    // what past Work and Memory appear to have belonged to.
    const archived: OrganizationState = {
      ...created(),
      status: "Archived",
      archivedAt: NOW,
    };
    expect(codeOf(() => renameOrganization(archived, "Rewrite", ctx()))).toBe(
      "ORGANIZATION_INVALID_TRANSITION",
    );
  });

  it("allows a Suspended Organization to be renamed", () => {
    // Suspension removes operability, not the ability to correct the record.
    const suspended: OrganizationState = {
      ...created(),
      status: "Suspended",
      suspendedAt: NOW,
    };
    expect(isOperable(suspended)).toBe(false);
    expect(renameOrganization(suspended, "Corrected", ctx()).state.name).toBe(
      "Corrected",
    );
  });

  it("refuses a blank name", () => {
    expect(() => renameOrganization(created(), "  ", ctx())).toThrowError(
      /name is required/,
    );
  });
});
