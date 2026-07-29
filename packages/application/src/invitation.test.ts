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
  hashToken,
  inviteMemberUseCase,
  listMembersUseCase,
  resendInvitationUseCase,
  revokeInvitationUseCase,
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
