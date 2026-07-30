/**
 * The invitation flow through the Application Layer.
 *
 * These cover what the Aggregate alone cannot: the duplicate check that spans
 * an Organization, the Identity resolution acceptance performs, and the
 * property the flow exists to establish — that an invited person holds no
 * authority until they accept.
 */

import { describe, expect, it } from "vitest";

import {
  IdentityId,
  MembershipId,
  OrganizationId,
  type HumanMemberPrincipal,
  type Role,
} from "@aios/types";

import { AuthorizationError, hasPermission } from "./authorization.js";
import {
  acceptInvitationUseCase,
  assignRoleUseCase,
  revokeRoleUseCase,
  hashToken,
  inviteMemberUseCase,
  listMembersUseCase,
  resendInvitationUseCase,
  reactivateMemberUseCase,
  revokeInvitationUseCase,
  revokeMemberUseCase,
  suspendMemberUseCase,
} from "./membership-use-cases.js";
import { buildTestHarness } from "./testing/in-memory.js";

/**
 * Every refusal on the acceptance path must be one error with one message.
 * Asserting the code rather than a class is what keeps that true: a new refusal
 * that raised a different error would still be a 404, but with a message a
 * caller could tell apart.
 */
const expectUnacceptable = async (promise: Promise<unknown>): Promise<void> => {
  await expect(promise).rejects.toMatchObject({
    code: "INVITATION_NOT_ACCEPTABLE",
    message: "This invitation cannot be accepted.",
  });
};

const ORG = OrganizationId("org-1");
const OTHER_ORG = OrganizationId("org-2");
const NOW = new Date("2026-07-28T10:00:00Z");

const principal = (
  roles: Role[] = ["OrganizationAdmin"],
  organizationId = ORG,
): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-admin"),
  membershipId: MembershipId("membership-admin"),
  organizationId,
  roles,
});

const ctx = (roles?: Role[], organizationId = ORG) => ({
  principal: principal(roles, organizationId),
  organizationId,
  now: NOW,
});

const subject = { provider: "dev", issuer: "https://dev.local", subject: "alice" };

describe("inviting", () => {
  it("returns a token that is not stored anywhere", async () => {
    const harness = buildTestHarness(NOW);
    const { membership, token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await harness.memberships.findById(ORG, membership.membershipId);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).toContain(hashToken(token));
  });

  it("emits MembershipInvited", async () => {
    const harness = buildTestHarness(NOW);
    await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    expect(harness.outbox.typesOf()).toEqual(["MembershipInvited"]);
  });

  it("refuses a Member without administration authority", async () => {
    const harness = buildTestHarness(NOW);
    await expect(
      inviteMemberUseCase(harness.deps, ctx(["Member"]), {
        email: "alice@example.test",
        roles: ["Member"],
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a second invitation to the same address", async () => {
    const harness = buildTestHarness(NOW);
    await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    await expect(
      inviteMemberUseCase(harness.deps, ctx(), {
        email: "ALICE@example.test",
        roles: ["Reviewer"],
      }),
    ).rejects.toThrow(/already been invited/);
  });

  it("writes nothing when the invitation is refused", async () => {
    const harness = buildTestHarness(NOW);
    await expect(
      inviteMemberUseCase(harness.deps, ctx(), {
        email: "alice@example.test",
        roles: ["OrganizationOwner"],
      }),
    ).rejects.toThrow();
    expect(await harness.memberships.listMembers(ORG)).toEqual([]);
    expect(harness.outbox.events).toEqual([]);
  });
});

describe("accepting", () => {
  const accept = async (
    harness: ReturnType<typeof buildTestHarness>,
    token: string,
    now = NOW,
  ) =>
    acceptInvitationUseCase(
      harness.deps,
      { subject, displayName: "Alice", now },
      token,
    );

  it("creates an Identity and activates the Membership", async () => {
    const harness = buildTestHarness(NOW);
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Reviewer"],
    });

    const accepted = await accept(harness, token);
    expect(accepted.membership.status).toBe("Active");
    expect(accepted.organizationId).toBe(ORG);
    expect(await harness.identities.findBySubject(subject)).not.toBeNull();
  });

  it("carries the roles the invitation granted", async () => {
    const harness = buildTestHarness(NOW);
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Reviewer"],
    });
    const { membership } = await accept(harness, token);

    // The point of the flow: authority appears only now, and it is the
    // authority the inviter chose.
    const asPrincipal: HumanMemberPrincipal = {
      type: "HumanMember",
      identityId: membership.identityId!,
      membershipId: membership.membershipId,
      organizationId: membership.organizationId,
      roles: membership.roles,
    };
    expect(hasPermission(asPrincipal, "memory.approve")).toBe(true);
    expect(hasPermission(asPrincipal, "work.create")).toBe(false);
  });

  it("takes the Organization from the token, not from the caller", async () => {
    const harness = buildTestHarness(NOW);
    const { token } = await inviteMemberUseCase(harness.deps, ctx(undefined, OTHER_ORG), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    const accepted = await accept(harness, token);
    expect(accepted.organizationId).toBe(OTHER_ORG);
  });

  it("refuses an unknown token", async () => {
    const harness = buildTestHarness(NOW);
    await expectUnacceptable(accept(harness, "not-a-real-token"));
  });

  it("refuses a revoked invitation", async () => {
    const harness = buildTestHarness(NOW);
    const { membership, token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    await revokeInvitationUseCase(
      harness.deps,
      ctx(),
      membership.membershipId,
      "Sent in error",
    );
    await expectUnacceptable(accept(harness, token));
  });

  it("refuses a superseded token after a resend", async () => {
    const harness = buildTestHarness(NOW);
    const { membership, token: first } = await inviteMemberUseCase(
      harness.deps,
      ctx(),
      { email: "alice@example.test", roles: ["Member"] },
    );
    const { token: second } = await resendInvitationUseCase(
      harness.deps,
      ctx(),
      membership.membershipId,
    );

    expect(second).not.toBe(first);
    await expectUnacceptable(accept(harness, first));
    await expect(accept(harness, second)).resolves.toBeDefined();
  });

  it("refuses an existing Identity addressed to someone else", async () => {
    const harness = buildTestHarness(NOW);
    harness.identities.seed(
      {
        identityId: IdentityId("identity-mallory"),
        status: "Active",
        displayName: "Mallory",
        primaryEmailNormalized: "mallory@example.test",
      },
      subject,
    );
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    await expectUnacceptable(accept(harness, token));
  });

  it("accepts an existing Identity that is the addressee", async () => {
    const harness = buildTestHarness(NOW);
    harness.identities.seed(
      {
        identityId: IdentityId("identity-alice"),
        status: "Active",
        displayName: "Alice",
        primaryEmailNormalized: "alice@example.test",
      },
      subject,
    );
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "Alice@Example.test",
      roles: ["Member"],
    });
    const accepted = await accept(harness, token);
    expect(accepted.membership.identityId).toBe("identity-alice");
  });

  it("refuses a disabled Identity", async () => {
    const harness = buildTestHarness(NOW);
    harness.identities.seed(
      {
        identityId: IdentityId("identity-alice"),
        status: "Disabled",
        displayName: "Alice",
        primaryEmailNormalized: "alice@example.test",
      },
      subject,
    );
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    await expectUnacceptable(accept(harness, token));
  });

  it("leaves the invitation usable after a refused attempt", async () => {
    const harness = buildTestHarness(NOW);
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });

    await expectUnacceptable(
      acceptInvitationUseCase(
        harness.deps,
        { subject, displayName: "Alice", now: new Date("2026-09-01T10:00:00Z") },
        token,
      ),
    );

    // The rollback matters: a failed attempt must not consume the invitation
    // or leave an orphaned Identity behind.
    expect(await harness.identities.findBySubject(subject)).toBeNull();
    await expect(accept(harness, token)).resolves.toBeDefined();
  });
});

describe("listing members", () => {
  it("is readable by every role", async () => {
    const harness = buildTestHarness(NOW);
    await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });

    for (const role of ["OrganizationOwner", "OrganizationAdmin", "Member", "Reviewer"] as Role[]) {
      const members = await listMembersUseCase(harness.deps, ctx([role]));
      expect(members).toHaveLength(1);
      expect(members[0]!.status).toBe("Invited");
    }
  });

  it("does not show another Organization's members", async () => {
    const harness = buildTestHarness(NOW);
    await inviteMemberUseCase(harness.deps, ctx(undefined, OTHER_ORG), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    expect(await listMembersUseCase(harness.deps, ctx())).toEqual([]);
  });
});

/**
 * The Last Owner Invariant, which spans Memberships and so lives in the
 * Application Layer.
 *
 * "An operation must not remove, suspend, or revoke the final active Owner when
 * the Organization remains Active."
 */
describe("the Last Owner Invariant", () => {
  const ownerRoles: Role[] = ["OrganizationOwner"];

  /** An Active Membership holding the given roles, seeded directly. */
  const seedActive = async (
    h: ReturnType<typeof buildTestHarness>,
    membershipId: string,
    roles: Role[],
  ) => {
    await h.memberships.insert({
      membershipId: MembershipId(membershipId),
      organizationId: ORG,
      identityId: IdentityId(`identity-${membershipId}`),
      status: "Active",
      roles,
      pendingInviteeEmail: null,
      invitations: [],
      invitedByIdentityId: null,
      invitedByMembershipId: null,
      invitedAt: NOW,
      activatedAt: NOW,
      revokedByIdentityId: null,
      revokedAt: null,
      revocationReason: null,
      version: 1 as never,
    });
  };

  it("refuses to revoke the only active Owner", async () => {
    const h = buildTestHarness(NOW);
    await seedActive(h, "owner-1", ownerRoles);

    await expect(
      revokeMemberUseCase(h.deps, ctx(), MembershipId("owner-1"), "Leaving"),
    ).rejects.toMatchObject({ code: "LAST_OWNER_REQUIRED" });
  });

  it("refuses to suspend the only active Owner", async () => {
    // The invariant names suspension too: a suspended Owner is not an active
    // Owner, so suspending the last one leaves the Organization ownerless.
    const h = buildTestHarness(NOW);
    await seedActive(h, "owner-1", ownerRoles);

    await expect(
      suspendMemberUseCase(h.deps, ctx(), MembershipId("owner-1"), "On leave"),
    ).rejects.toMatchObject({ code: "LAST_OWNER_REQUIRED" });
  });

  it("allows it once a second Owner is active", async () => {
    const h = buildTestHarness(NOW);
    await seedActive(h, "owner-1", ownerRoles);
    await seedActive(h, "owner-2", ownerRoles);

    const revoked = await revokeMemberUseCase(
      h.deps,
      ctx(),
      MembershipId("owner-1"),
      "Handed over",
    );
    expect(revoked.status).toBe("Revoked");
  });

  it("does not count a suspended Owner as remaining", async () => {
    const h = buildTestHarness(NOW);
    await seedActive(h, "owner-1", ownerRoles);
    await seedActive(h, "owner-2", ownerRoles);
    await suspendMemberUseCase(h.deps, ctx(), MembershipId("owner-2"), "On leave");

    await expect(
      revokeMemberUseCase(h.deps, ctx(), MembershipId("owner-1"), "Leaving"),
    ).rejects.toMatchObject({ code: "LAST_OWNER_REQUIRED" });
  });

  it("does not apply to a Member who is not an Owner", async () => {
    const h = buildTestHarness(NOW);
    await seedActive(h, "member-1", ["Member"]);

    // No Owner check runs at all: the invariant is about Owners, and requiring
    // one here would make the last ordinary Member unremovable.
    const revoked = await revokeMemberUseCase(
      h.deps,
      ctx(),
      MembershipId("member-1"),
      "Left",
    );
    expect(revoked.status).toBe("Revoked");
  });

  it("lets a suspended Owner be reactivated with no Owner check", async () => {
    const h = buildTestHarness(NOW);
    await seedActive(h, "owner-1", ownerRoles);
    await seedActive(h, "owner-2", ownerRoles);
    await suspendMemberUseCase(h.deps, ctx(), MembershipId("owner-2"), "On leave");

    const back = await reactivateMemberUseCase(
      h.deps,
      ctx(),
      MembershipId("owner-2"),
      "Returned",
    );
    expect(back.status).toBe("Active");
  });
});

/**
 * Role assignment (ADR-0018).
 *
 * The Aggregate covers what a role change does. What only exists here are the
 * two rules that narrow the permission — the target role, and the prohibition on
 * assigning to yourself — plus the Last Owner Invariant, which spans Memberships.
 */
describe("assigning and revoking roles", () => {
  /** An Active Member, invited and accepted, holding exactly one role. */
  const withMember = async (roles: Role[] = ["Member"]) => {
    const harness = buildTestHarness(NOW);
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles,
    });
    const accepted = await acceptInvitationUseCase(
      harness.deps,
      { subject, displayName: "Alice", now: NOW },
      token,
    );
    return { harness, membershipId: accepted.membership.membershipId };
  };

  it("grants a role an Admin is allowed to grant", async () => {
    const { harness, membershipId } = await withMember();

    const state = await assignRoleUseCase(harness.deps, ctx(), membershipId, "Reviewer");
    expect(state.roles).toContain("Reviewer");
    expect(state.roles).toContain("Member");
  });

  it("revokes a role and stamps the assignment rather than deleting it", async () => {
    const { harness, membershipId } = await withMember(["Member", "Reviewer"]);

    await revokeRoleUseCase(
      harness.deps,
      ctx(),
      membershipId,
      "Reviewer",
      "Moving off review.",
    );

    const rows = [...harness.memberships.roleAssignments.values()].filter(
      (r) => r.membershipId === membershipId && r.role === "Reviewer",
    );
    // The row survives, carrying why it ended. "The lifecycle is append-only
    // from an audit perspective."
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revocationReason: "Moving off review." });
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  /**
   * The target role narrows the actor. Without this, an Admin could appoint
   * themselves an accomplice Owner or strip the Owners one at a time.
   */
  it("refuses an Admin on the OrganizationOwner role", async () => {
    const { harness, membershipId } = await withMember();

    await expect(
      assignRoleUseCase(harness.deps, ctx(["OrganizationAdmin"]), membershipId, "OrganizationOwner"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("lets an Owner grant Ownership", async () => {
    const { harness, membershipId } = await withMember();

    const state = await assignRoleUseCase(
      harness.deps,
      ctx(["OrganizationOwner"]),
      membershipId,
      "OrganizationOwner",
    );
    expect(state.roles).toContain("OrganizationOwner");
  });

  /**
   * The self-escalation policy, flat rather than rank-based: the four roles are
   * a set, not a ladder.
   */
  it("refuses any self-assignment, including by an Owner", async () => {
    const harness = buildTestHarness(NOW);
    const self = ctx(["OrganizationOwner"]);

    await expect(
      assignRoleUseCase(
        harness.deps,
        self,
        self.principal.membershipId,
        "Reviewer",
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("refuses Member and Reviewer outright", async () => {
    const { harness, membershipId } = await withMember();

    for (const roles of [["Member"], ["Reviewer"]] as Role[][]) {
      await expect(
        assignRoleUseCase(harness.deps, ctx(roles), membershipId, "Reviewer"),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(
        revokeRoleUseCase(harness.deps, ctx(roles), membershipId, "Member", "x"),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });

  /**
   * The dead end this whole change exists to close.
   *
   * Before it, the Last Owner Invariant refused to remove the final Owner and
   * told the caller to "assign another Owner" first — and no command could. This
   * is that sequence, end to end: promote a second Owner, then step the first
   * one down, with the invariant satisfied at every point between.
   */
  it("closes the Last Owner dead end", async () => {
    const harness = buildTestHarness(NOW);
    const owner = ctx(["OrganizationOwner"]);

    const join = async (email: string, subjectId: string) => {
      const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
        email,
        roles: ["Member"],
      });
      const accepted = await acceptInvitationUseCase(
        harness.deps,
        { subject: { ...subject, subject: subjectId }, displayName: subjectId, now: NOW },
        token,
      );
      return accepted.membership.membershipId;
    };

    const first = await join("alice@example.test", "alice");
    const second = await join("raj@example.test", "raj");

    await assignRoleUseCase(harness.deps, owner, first, "OrganizationOwner");
    // One Owner in the member list. Removing them now is the prohibited result.
    await expect(
      revokeRoleUseCase(harness.deps, owner, first, "OrganizationOwner", "Leaving."),
    ).rejects.toMatchObject({ code: "LAST_OWNER_REQUIRED" });

    // "The Organization must first: assign another Owner." Now it can.
    await assignRoleUseCase(harness.deps, owner, second, "OrganizationOwner");

    const stepped = await revokeRoleUseCase(
      harness.deps,
      owner,
      first,
      "OrganizationOwner",
      "Handing over.",
    );
    expect(stepped.roles).not.toContain("OrganizationOwner");
    // Still a Member: "role removal does not silently revoke Membership".
    expect(stepped.status).toBe("Active");
    expect(stepped.roles).toContain("Member");
  });

  it("refuses to revoke Ownership from the only Owner", async () => {
    const harness = buildTestHarness(NOW);
    const { token } = await inviteMemberUseCase(harness.deps, ctx(), {
      email: "alice@example.test",
      roles: ["Member"],
    });
    const accepted = await acceptInvitationUseCase(
      harness.deps,
      { subject, displayName: "Alice", now: NOW },
      token,
    );
    const owner = ctx(["OrganizationOwner"]);
    await assignRoleUseCase(
      harness.deps,
      owner,
      accepted.membership.membershipId,
      "OrganizationOwner",
    );

    // Now the only active Owner in the member list. Removing the role is the
    // same prohibited result as revoking the Membership.
    await expect(
      revokeRoleUseCase(
        harness.deps,
        owner,
        accepted.membership.membershipId,
        "OrganizationOwner",
        "Leaving.",
      ),
    ).rejects.toMatchObject({ code: "LAST_OWNER_REQUIRED" });
  });
});
