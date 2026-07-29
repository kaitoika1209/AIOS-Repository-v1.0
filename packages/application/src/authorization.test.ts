/**
 * The role-to-permission mapping was derived by hand from the "Recommended MVP
 * mapping" table in authorization.md, which is stated in permission
 * *categories* rather than individual permissions. An exact textual comparison
 * is therefore not possible, so these tests assert the rules the document
 * states in prose.
 */

import { describe, expect, it } from "vitest";

import { PERMISSIONS, ROLES, HUMAN_ONLY_PERMISSIONS, type Permission } from "@aios/types";

import { rolePermissions } from "./authorization.js";

describe("role to permission mapping", () => {
  it("covers every role", () => {
    expect(Object.keys(rolePermissions).sort()).toEqual([...ROLES].sort());
  });

  it("grants only permissions that exist in the catalogue", () => {
    for (const [role, granted] of Object.entries(rolePermissions)) {
      for (const permission of granted) {
        expect(PERMISSIONS, `${role} grants unknown ${permission}`).toContain(
          permission,
        );
      }
    }
  });

  it("leaves no permission unreachable by every role", () => {
    const reachable = new Set<Permission>(Object.values(rolePermissions).flat());
    expect([...PERMISSIONS].filter((p) => !reachable.has(p))).toEqual([]);
  });

  it("gives the Owner the highest administrative authority", () => {
    expect([...rolePermissions.OrganizationOwner].sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
  });

  it("does not give a Member approval authority automatically", () => {
    // "A Member does not receive approval authority automatically."
    for (const permission of HUMAN_ONLY_PERMISSIONS) {
      if (permission === "work.complete") continue; // Members may complete related Work.
      expect(rolePermissions.Member).not.toContain(permission);
    }
  });

  it("gives the Reviewer review authority and nothing else", () => {
    // "A Reviewer is authorized to perform Human review actions."
    expect([...rolePermissions.Reviewer].sort()).toEqual(
      [
        "organization.read_members",
        "decision.approve",
        "decision.reject",
        "decision.withdraw",
        "memory.approve",
        "memory.reject",
      ].sort(),
    );
  });

  it("lets every role read the member list", () => {
    for (const role of ROLES) {
      expect(rolePermissions[role]).toContain("organization.read_members");
    }
  });

  it("restricts membership administration to Owner and Admin", () => {
    // "Organization administration | Full | Limited | None | None".
    const administration = PERMISSIONS.filter(
      (p) => p.startsWith("organization.") && p !== "organization.read_members",
    );
    expect(administration.length).toBeGreaterThan(0);
    for (const permission of administration) {
      expect(rolePermissions.OrganizationOwner).toContain(permission);
      expect(rolePermissions.OrganizationAdmin).toContain(permission);
      expect(rolePermissions.Member).not.toContain(permission);
      expect(rolePermissions.Reviewer).not.toContain(permission);
    }
  });

  it("does not let an Admin approve Decisions or Memory by default", () => {
    // The mapping table marks Decision and Memory review "Optional" for Admin,
    // so the default grant must not include it.
    expect(rolePermissions.OrganizationAdmin).not.toContain("decision.approve");
    expect(rolePermissions.OrganizationAdmin).not.toContain("memory.approve");
  });

  it("restricts event recovery permissions to Owner and Admin", () => {
    const recovery = PERMISSIONS.filter((p) => p.startsWith("events."));
    for (const permission of recovery) {
      expect(rolePermissions.Member).not.toContain(permission);
      expect(rolePermissions.Reviewer).not.toContain(permission);
      expect(rolePermissions.OrganizationAdmin).toContain(permission);
    }
  });
});
