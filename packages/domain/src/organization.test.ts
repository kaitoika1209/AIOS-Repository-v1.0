import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  type AiPrincipal,
  type HumanMemberPrincipal,
} from "@aios/types";

import {
  archiveOrganization,
  createOrganization,
  isOperable,
  reactivateOrganization,
  renameOrganization,
  suspendOrganization,
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

const suspended = (): OrganizationState =>
  suspendOrganization(created(), "Pausing for the summer.", ctx()).state;

describe("the Organization lifecycle (ADR-0017)", () => {
  it("suspends an Active Organization and records why", () => {
    const { state, events } = suspendOrganization(
      created(),
      "  Pausing for the summer.  ",
      ctx(),
    );

    expect(state.status).toBe("Suspended");
    expect(state.suspendedAt).toEqual(NOW);
    expect(state.version).toBe(2);
    // The status is the whole mechanism: `PrincipalResolver` reads it on every
    // request, which is what makes the Organization stop responding.
    expect(isOperable(state)).toBe(false);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "OrganizationSuspended",
      organizationId: ORG,
      reason: "Pausing for the summer.",
      actorIdentityId: FOUNDER,
      aggregateVersion: 2,
    });
  });

  it("keeps every Membership: suspension deletes nothing", () => {
    // "no automatic deletion of resources", "preservation of membership and
    // audit history". The Aggregate holds no Memberships to delete, and this
    // asserts it does not acquire the ability.
    const state = suspended();
    expect(Object.keys(state)).toEqual(Object.keys(created()));
  });

  it("refuses suspension without a reason", () => {
    expect(() => suspendOrganization(created(), "   ", ctx())).toThrowError(
      /suspension reason is required/,
    );
  });

  it("refuses to suspend an already suspended Organization", () => {
    expect(codeOf(() => suspendOrganization(suspended(), "Again.", ctx()))).toBe(
      "ORGANIZATION_INVALID_TRANSITION",
    );
  });

  it("reactivates a suspended Organization and clears suspendedAt", () => {
    const { state, events } = reactivateOrganization(suspended(), "Back.", ctx());

    expect(state.status).toBe("Active");
    // Current state, not history. The `OrganizationSuspended` event remains the
    // durable record that the suspension happened.
    expect(state.suspendedAt).toBeNull();
    expect(state.version).toBe(3);
    expect(isOperable(state)).toBe(true);
    expect(events[0]).toMatchObject({ type: "OrganizationReactivated", reason: "Back." });
  });

  it("refuses to reactivate an Organization that is not suspended", () => {
    expect(codeOf(() => reactivateOrganization(created(), "Why?", ctx()))).toBe(
      "ORGANIZATION_INVALID_TRANSITION",
    );
  });

  it("archives from Active", () => {
    const { state, events } = archiveOrganization(created(), "Closing down.", ctx());

    expect(state.status).toBe("Archived");
    expect(state.archivedAt).toEqual(NOW);
    expect(isOperable(state)).toBe(false);
    expect(events[0]).toMatchObject({ type: "OrganizationArchived", reason: "Closing down." });
  });

  /**
   * An Owner who paused their Organization and then decided to close it should
   * not have to reactivate it first. "Organization not already Archived" is the
   * only precondition the document states.
   */
  it("archives from Suspended without a detour through Active", () => {
    expect(archiveOrganization(suspended(), "Closing down.", ctx()).state.status).toBe(
      "Archived",
    );
  });

  it("refuses to archive twice", () => {
    const archived = archiveOrganization(created(), "Closing down.", ctx()).state;
    expect(codeOf(() => archiveOrganization(archived, "Again.", ctx()))).toBe(
      "ORGANIZATION_INVALID_TRANSITION",
    );
  });

  it("has no command that returns an Archived Organization to Active", () => {
    // "An Archived Organization does not return to Active in the MVP." This is
    // why ADR-0014's recovery exemption covers Suspended alone.
    const archived = archiveOrganization(created(), "Closing down.", ctx()).state;
    expect(codeOf(() => reactivateOrganization(archived, "Reopen.", ctx()))).toBe(
      "ORGANIZATION_INVALID_TRANSITION",
    );
    expect(codeOf(() => suspendOrganization(archived, "Reopen.", ctx()))).toBe(
      "ORGANIZATION_INVALID_TRANSITION",
    );
  });

  /**
   * The Aggregate checks the tenant itself rather than trusting the Application
   * Layer's permission check. A principal holding `organization.suspend` in
   * their own Organization must not be able to suspend a different one.
   */
  it("refuses a principal from another Organization", () => {
    const foreign = ctx(owner(OTHER_ORG));
    expect(() => suspendOrganization(created(), "Not yours.", foreign)).toThrowError(
      /its own Member/,
    );
    expect(() => archiveOrganization(created(), "Not yours.", foreign)).toThrowError(
      /its own Member/,
    );
    expect(() =>
      reactivateOrganization(suspended(), "Not yours.", foreign),
    ).toThrowError(/its own Member/);
  });

  it("refuses the Secretary", () => {
    // Human authority is not delegable: "Human Members retain all
    // organizational authority."
    expect(() => suspendOrganization(created(), "Automated.", ctx(secretary))).toThrowError(
      /Only a Human Member/,
    );
    expect(() => archiveOrganization(created(), "Automated.", ctx(secretary))).toThrowError(
      /Only a Human Member/,
    );
  });
});
