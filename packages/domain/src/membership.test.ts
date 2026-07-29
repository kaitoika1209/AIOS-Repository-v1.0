import { describe, expect, it } from "vitest";

import {
  IdentityId,
  InvitationId,
  MembershipId,
  OrganizationId,
  type AiPrincipal,
  type HumanMemberPrincipal,
  type Principal,
} from "@aios/types";

import {
  DEFAULT_INVITED_ROLE,
  acceptInvitation,
  currentInvitation,
  grantsAuthority,
  inviteToOrganization,
  normalizeEmail,
  resendInvitation,
  revokeInvitation,
  type MembershipState,
} from "./membership.js";
import { DomainError } from "./errors.js";
import type { ActorContext } from "./work.js";

const ORG = OrganizationId("org-1");
const OTHER_ORG = OrganizationId("org-2");
const NOW = new Date("2026-07-28T10:00:00Z");
const LATER = new Date("2026-07-29T10:00:00Z");
const EXPIRY = new Date("2026-07-31T10:00:00Z");

const admin = (organizationId = ORG): HumanMemberPrincipal => ({
  type: "HumanMember",
  identityId: IdentityId("identity-admin"),
  membershipId: MembershipId("membership-admin"),
  organizationId,
  roles: ["OrganizationAdmin"],
});

const secretary: AiPrincipal = {
  type: "AI",
  identityId: IdentityId("secretary-1"),
  organizationId: ORG,
  assistanceOperation: "memory.generate.v1",
};

const ctx = (principal: Principal = admin(), now = NOW): ActorContext => ({
  principal,
  now,
});

const invite = (
  overrides: Partial<Parameters<typeof inviteToOrganization>[1]> = {},
): MembershipState =>
  inviteToOrganization(ctx(), {
    membershipId: MembershipId("membership-1"),
    organizationId: ORG,
    inviteeEmail: "Alice@Example.test",
    roles: ["Member"],
    invitationId: InvitationId("invitation-1"),
    tokenHash: "hash-1",
    expiresAt: EXPIRY,
    ...overrides,
  }).state;

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected:${String(error)}`;
  }
  return "no error thrown";
};

describe("inviting", () => {
  it("creates an Invited Membership with no Identity bound", () => {
    const state = invite();
    expect(state.status).toBe("Invited");
    expect(state.identityId).toBeNull();
    expect(state.pendingInviteeEmail).toBe("alice@example.test");
    expect(state.version).toBe(1);
  });

  it("grants no authority while Invited", () => {
    expect(grantsAuthority(invite())).toBe(false);
  });

  it("normalizes the invitee address the way the schema does", () => {
    expect(normalizeEmail("  Alice@Example.TEST ")).toBe("alice@example.test");
  });

  it("emits MembershipInvited stamped with the aggregate version", () => {
    const { events } = inviteToOrganization(ctx(), {
      membershipId: MembershipId("membership-1"),
      organizationId: ORG,
      inviteeEmail: "alice@example.test",
      roles: ["Reviewer"],
      invitationId: InvitationId("invitation-1"),
      tokenHash: "hash-1",
      expiresAt: EXPIRY,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("MembershipInvited");
    expect(events[0]!.aggregateVersion).toBe(1);
    expect(events[0]!.actorMembershipId).toBe("membership-admin");
  });

  it("applies the default role when none is named", () => {
    expect(invite({ roles: [] }).roles).toEqual([DEFAULT_INVITED_ROLE]);
  });

  it("refuses to grant OrganizationOwner by invitation", () => {
    expect(codeOf(() => invite({ roles: ["OrganizationOwner"] }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("refuses a malformed address", () => {
    expect(codeOf(() => invite({ inviteeEmail: "not-an-address" }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("refuses an expiry that has already passed", () => {
    expect(codeOf(() => invite({ expiresAt: new Date("2026-07-27T10:00:00Z") }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("refuses to invite into another Organization", () => {
    expect(codeOf(() => invite({ organizationId: OTHER_ORG }))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("refuses a non-Human principal", () => {
    expect(
      codeOf(() =>
        inviteToOrganization(ctx(secretary), {
          membershipId: MembershipId("membership-1"),
          organizationId: ORG,
          inviteeEmail: "alice@example.test",
          roles: ["Member"],
          invitationId: InvitationId("invitation-1"),
          tokenHash: "hash-1",
          expiresAt: EXPIRY,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("accepting", () => {
  const accept = (
    state: MembershipState,
    overrides: Partial<Parameters<typeof acceptInvitation>[2]> = {},
    now = NOW,
  ) =>
    acceptInvitation(state, now, {
      identityId: IdentityId("identity-alice"),
      tokenHash: "hash-1",
      existingIdentityEmail: null,
      ...overrides,
    });

  it("activates the Membership and binds the Identity", () => {
    const { state } = accept(invite());
    expect(state.status).toBe("Active");
    expect(state.identityId).toBe("identity-alice");
    expect(state.pendingInviteeEmail).toBeNull();
    expect(grantsAuthority(state)).toBe(true);
  });

  it("consumes the invitation", () => {
    const { state } = accept(invite());
    expect(currentInvitation(state)!.status).toBe("Consumed");
    expect(currentInvitation(state)!.consumedAt).toEqual(NOW);
  });

  it("records no acting Membership, because the acceptor held none", () => {
    const { events } = accept(invite());
    expect(events[0]!.type).toBe("MembershipActivated");
    expect(events[0]!.actorMembershipId).toBeNull();
    expect(events[0]!.actorIdentityId).toBe("identity-alice");
  });

  it("refuses a token that does not match", () => {
    expect(codeOf(() => accept(invite(), { tokenHash: "wrong" }))).toBe(
      "INVITATION_NOT_ACCEPTABLE",
    );
  });

  it("refuses an expired invitation regardless of stored status", () => {
    const state = invite();
    expect(currentInvitation(state)!.status).toBe("Pending");
    expect(
      codeOf(() => accept(state, {}, new Date("2026-08-01T10:00:00Z"))),
    ).toBe("INVITATION_NOT_ACCEPTABLE");
  });

  it("cannot be accepted twice", () => {
    const { state } = accept(invite());
    expect(codeOf(() => accept(state))).toBe("INVITATION_NOT_ACCEPTABLE");
  });

  it("refuses an existing Identity addressed to someone else", () => {
    expect(
      codeOf(() =>
        accept(invite(), { existingIdentityEmail: "mallory@example.test" }),
      ),
    ).toBe("INVITATION_NOT_ACCEPTABLE");
  });

  it("accepts an existing Identity that is the addressee", () => {
    const { state } = accept(invite(), {
      existingIdentityEmail: "ALICE@example.test",
    });
    expect(state.status).toBe("Active");
  });

  it("reports every refusal identically, so a token cannot be probed", () => {
    const messages = new Set<string>();
    const collect = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        messages.add((error as Error).message);
      }
    };
    collect(() => accept(invite(), { tokenHash: "wrong" }));
    collect(() => accept(invite(), {}, new Date("2026-08-01T10:00:00Z")));
    collect(() => accept(accept(invite()).state));
    expect(messages.size).toBe(1);
  });
});

describe("resending", () => {
  it("supersedes the previous token without creating a Membership", () => {
    const state = invite();
    const { state: resent } = resendInvitation(state, ctx(admin(), LATER), {
      invitationId: InvitationId("invitation-2"),
      tokenHash: "hash-2",
      expiresAt: EXPIRY,
    });

    expect(resent.membershipId).toBe(state.membershipId);
    expect(resent.invitations).toHaveLength(2);
    expect(currentInvitation(resent)!.invitationVersion).toBe(2);
    expect(resent.invitations[0]!.status).toBe("Revoked");
  });

  it("invalidates the superseded token", () => {
    const { state } = resendInvitation(invite(), ctx(admin(), LATER), {
      invitationId: InvitationId("invitation-2"),
      tokenHash: "hash-2",
      expiresAt: EXPIRY,
    });
    expect(
      codeOf(() =>
        acceptInvitation(state, LATER, {
          identityId: IdentityId("identity-alice"),
          tokenHash: "hash-1",
          existingIdentityEmail: null,
        }),
      ),
    ).toBe("INVITATION_NOT_ACCEPTABLE");
  });

  it("emits nothing, because no Membership fact changed", () => {
    const { events } = resendInvitation(invite(), ctx(admin(), LATER), {
      invitationId: InvitationId("invitation-2"),
      tokenHash: "hash-2",
      expiresAt: EXPIRY,
    });
    expect(events).toEqual([]);
  });

  it("cannot resend once accepted", () => {
    const { state } = acceptInvitation(invite(), NOW, {
      identityId: IdentityId("identity-alice"),
      tokenHash: "hash-1",
      existingIdentityEmail: null,
    });
    expect(
      codeOf(() =>
        resendInvitation(state, ctx(admin(), LATER), {
          invitationId: InvitationId("invitation-2"),
          tokenHash: "hash-2",
          expiresAt: EXPIRY,
        }),
      ),
    ).toBe("MEMBERSHIP_INVALID_TRANSITION");
  });
});

describe("revoking an invitation", () => {
  it("reaches Revoked and emits MembershipRevoked with the reason", () => {
    const { state, events } = revokeInvitation(invite(), ctx(), "Sent in error");
    expect(state.status).toBe("Revoked");
    expect(state.revocationReason).toBe("Sent in error");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("MembershipRevoked");
  });

  it("records a null identity, because nobody accepted", () => {
    const { events } = revokeInvitation(invite(), ctx(), "Sent in error");
    const event = events[0]!;
    expect(event.type === "MembershipRevoked" && event.identityId).toBeNull();
  });

  it("makes the token unusable", () => {
    const { state } = revokeInvitation(invite(), ctx(), "Sent in error");
    expect(
      codeOf(() =>
        acceptInvitation(state, NOW, {
          identityId: IdentityId("identity-alice"),
          tokenHash: "hash-1",
          existingIdentityEmail: null,
        }),
      ),
    ).toBe("INVITATION_NOT_ACCEPTABLE");
  });

  it("requires a reason", () => {
    expect(codeOf(() => revokeInvitation(invite(), ctx(), "   "))).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("cannot revoke an invitation that was already accepted", () => {
    const { state } = acceptInvitation(invite(), NOW, {
      identityId: IdentityId("identity-alice"),
      tokenHash: "hash-1",
      existingIdentityEmail: null,
    });
    expect(codeOf(() => revokeInvitation(state, ctx(), "Too late"))).toBe(
      "MEMBERSHIP_INVALID_TRANSITION",
    );
  });
});
