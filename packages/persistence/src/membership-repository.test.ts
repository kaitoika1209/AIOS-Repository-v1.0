/**
 * Membership and invitation persistence against a real PostgreSQL database.
 *
 * The schema carries more of the invitation rules than the code does —
 * `ck_memberships_identity_presence`, the partial unique index on pending
 * invitations, and the unique token hash are all invariants that only exist once
 * the documented DDL is applied. Testing against a fixture would test none of
 * them.
 *
 * Skipped when DATABASE_URL is unset so `pnpm test` stays runnable offline.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  IdentityId,
  InvitationId,
  MembershipId,
  OrganizationId,
  type HumanMemberPrincipal,
} from "@aios/types";
import {
  acceptInvitation,
  inviteToOrganization,
  resendInvitation,
  revokeInvitation,
  currentInvitation,
  VersionConflictError,
  type ActorContext,
  type MembershipState,
} from "@aios/domain";

import {
  PostgresIdentityRepository,
  PostgresMembershipRepository,
} from "./membership-repository.js";

const url = process.env["DATABASE_URL"];

const SCHEMA = "test_membership_repo";
const suite = url ? describe : describe.skip;

const repoRoot = resolve(import.meta.dirname, "../../..");
const NOW = new Date("2026-07-28T10:00:00Z");
const EXPIRY = new Date("2026-08-04T10:00:00Z");

const ORG = OrganizationId("11111111-1111-1111-1111-111111111111");
const OTHER_ORG = OrganizationId("22222222-2222-2222-2222-222222222222");
const INVITER_IDENTITY = IdentityId("33333333-3333-3333-3333-333333333333");
const INVITER_MEMBERSHIP = MembershipId("44444444-4444-4444-4444-444444444444");

const inviter: HumanMemberPrincipal = {
  type: "HumanMember",
  identityId: INVITER_IDENTITY,
  membershipId: INVITER_MEMBERSHIP,
  organizationId: ORG,
  roles: ["OrganizationAdmin"],
};

const ctx: ActorContext = { principal: inviter, now: NOW };

const SUBJECT = { provider: "dev", issuer: "https://dev.local", subject: "alice" };

suite("PostgresMembershipRepository", () => {
  let pool: Pool;

  beforeAll(async () => {
    execFileSync("python3", [resolve(repoRoot, "scripts/extract_schema.py")], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
    const schema = readFileSync(resolve(repoRoot, "build/schema.sql"), "utf8");

    const client = await pool.connect();
    try {
      await client.query(
        `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`,
      );
      await client.query(schema);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await client.query(
        `TRUNCATE organization_invitations, membership_role_assignments,
                  memberships, authentication_subjects, organizations,
                  human_identities CASCADE`,
      );
      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, version, created_at, updated_at)
         VALUES ($1, 'Active', 'Inviter', 1, now(), now())`,
        [INVITER_IDENTITY],
      );
      for (const org of [ORG, OTHER_ORG]) {
        await client.query(
          `INSERT INTO organizations
             (organization_id, name, status, created_by_identity_id, version, created_at, updated_at)
           VALUES ($1, 'Test Org', 'Active', $2, 1, now(), now())`,
          [org, INVITER_IDENTITY],
        );
      }
      // The inviter's own Membership, so role assignments have a valid
      // `assigned_by_membership_id` to point at.
      await client.query(
        `INSERT INTO memberships
           (membership_id, organization_id, identity_id, status,
            invited_by_identity_id, invited_at, activated_at,
            version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Active', $3, now(), now(), 1, now(), now())`,
        [INVITER_MEMBERSHIP, ORG, INVITER_IDENTITY],
      );
    } finally {
      client.release();
    }
  });

  const withRepo = async <T>(
    fn: (
      memberships: PostgresMembershipRepository,
      identities: PostgresIdentityRepository,
      client: PoolClient,
    ) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(
        new PostgresMembershipRepository(client),
        new PostgresIdentityRepository(client),
        client,
      );
    } finally {
      client.release();
    }
  };

  const invited = (
    email = "alice@example.test",
    organizationId = ORG,
  ): MembershipState =>
    inviteToOrganization(
      { principal: { ...inviter, organizationId }, now: NOW },
      {
        membershipId: MembershipId(randomUUID()),
        organizationId,
        inviteeEmail: email,
        roles: ["Reviewer"],
        invitationId: InvitationId(randomUUID()),
        tokenHash: randomUUID(),
        expiresAt: EXPIRY,
      },
    ).state;

  it("round-trips an Invited Membership with no Identity bound", async () => {
    const membership = invited();
    const loaded = await withRepo(async (repo) => {
      await repo.insert(membership);
      return repo.findById(ORG, membership.membershipId);
    });

    expect(loaded).not.toBeNull();
    expect(loaded).toMatchObject({
      membershipId: membership.membershipId,
      organizationId: ORG,
      identityId: null,
      pendingInviteeEmail: "alice@example.test",
      status: "Invited",
      version: 1,
    });
    expect(loaded!.roles).toEqual(["Reviewer"]);
    expect(currentInvitation(loaded!)).toMatchObject({
      invitationVersion: 1,
      status: "Pending",
    });
  });

  /** Insert a raw row, bypassing the repository, to probe a check constraint. */
  const insertRaw = (
    status: string,
    identityId: string | null,
    pendingEmail: string | null,
  ) =>
    withRepo(async (_repo, _identities, client) =>
      client.query(
        `INSERT INTO memberships
           (membership_id, organization_id, identity_id,
            pending_invitee_email, pending_invitee_email_normalized,
            status, revoked_at, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, lower($4), $5, $6, 1, now(), now())`,
        [
          randomUUID(),
          ORG,
          identityId,
          pendingEmail,
          status,
          status === "Revoked" ? new Date() : null,
        ],
      ),
    );

  it("refuses an Invited Membership addressed to nobody", async () => {
    // `ck_memberships_identity_state`: an invitation must name either an
    // Identity or an address, or there is no one to accept it.
    await expect(insertRaw("Invited", null, null)).rejects.toThrow(
      /ck_memberships_identity_state/,
    );
  });

  it("refuses an Active Membership with no Identity", async () => {
    // This is what makes "only an Active Membership carries authority"
    // structural: authority always resolves to a person.
    await expect(insertRaw("Active", null, "alice@example.test")).rejects.toThrow(
      /ck_memberships_identity_state/,
    );
  });

  it("allows a Revoked Membership with no Identity", async () => {
    // The Invited -> Revoked transitions in the Membership state machine
    // (RevokeInvitation, ExpireInvitation) happen before any Identity exists.
    await expect(
      insertRaw("Revoked", null, "alice@example.test"),
    ).resolves.toBeDefined();
  });

  it("refuses a second pending invitation to the same address", async () => {
    await expect(
      withRepo(async (repo) => {
        await repo.insert(invited("alice@example.test"));
        await repo.insert(invited("ALICE@example.test"));
      }),
    ).rejects.toThrow(/uq_memberships_pending_invitation/);
  });

  it("refuses to reuse a token hash across Organizations", async () => {
    // A distinct invitation row in a different Organization, carrying the same
    // token. Globally unique hashes are what make "the token names exactly one
    // Organization" true — acceptance resolves by hash alone.
    const first = invited("alice@example.test", ORG);
    const other = invited("bob@example.test", OTHER_ORG);
    const second: MembershipState = {
      ...other,
      invitations: other.invitations.map((invitation) => ({
        ...invitation,
        tokenHash: first.invitations[0]!.tokenHash,
      })),
    };

    await expect(
      withRepo(async (repo) => {
        await repo.insert(first);
        await repo.insert(second);
      }),
    ).rejects.toThrow(/uq_organization_invitations_token_hash/);
  });

  it("finds a Membership by token hash without an Organization", async () => {
    const membership = invited();
    const hash = currentInvitation(membership)!.tokenHash;

    const loaded = await withRepo(async (repo) => {
      await repo.insert(membership);
      return repo.findByInvitationTokenHash(hash);
    });

    expect(loaded?.membershipId).toBe(membership.membershipId);
    // The Organization comes back with it — that is what lets acceptance run
    // with no `X-Organization-Id`.
    expect(loaded?.organizationId).toBe(ORG);
  });

  it("finds a Membership by the invitee address", async () => {
    const membership = invited();
    const loaded = await withRepo(async (repo) => {
      await repo.insert(membership);
      return repo.findByEmail(ORG, "alice@example.test");
    });
    expect(loaded?.membershipId).toBe(membership.membershipId);
  });

  it("finds an activated Member by their Identity's address", async () => {
    const membership = invited();
    const loaded = await withRepo(async (repo, identities) => {
      await repo.insert(membership);
      const identity = await identities.createWithSubject({
        identityId: IdentityId(randomUUID()),
        displayName: "Alice",
        primaryEmail: "alice@example.test",
        ...SUBJECT,
      });
      const { state } = acceptInvitation(membership, NOW, {
        identityId: identity.identityId,
        tokenHash: currentInvitation(membership)!.tokenHash,
        existingIdentityEmail: null,
      });
      await repo.update(state, membership.version);
      // The pending address is cleared on activation, so this can only match
      // through the joined Identity.
      return repo.findByEmail(ORG, "alice@example.test");
    });

    expect(loaded?.status).toBe("Active");
    expect(loaded?.pendingInviteeEmail).toBeNull();
  });

  it("activates a Membership and consumes its invitation", async () => {
    const membership = invited();
    const loaded = await withRepo(async (repo, identities) => {
      await repo.insert(membership);
      const identity = await identities.createWithSubject({
        identityId: IdentityId(randomUUID()),
        displayName: "Alice",
        primaryEmail: "alice@example.test",
        ...SUBJECT,
      });
      const { state } = acceptInvitation(membership, NOW, {
        identityId: identity.identityId,
        tokenHash: currentInvitation(membership)!.tokenHash,
        existingIdentityEmail: null,
      });
      await repo.update(state, membership.version);
      return repo.findById(ORG, membership.membershipId);
    });

    expect(loaded).toMatchObject({ status: "Active", version: 2 });
    expect(loaded!.identityId).not.toBeNull();
    expect(currentInvitation(loaded!)).toMatchObject({ status: "Consumed" });
    expect(currentInvitation(loaded!)!.consumedAt).not.toBeNull();
  });

  it("keeps the superseded invitation when one is resent", async () => {
    const membership = invited();
    const loaded = await withRepo(async (repo) => {
      await repo.insert(membership);
      const { state } = resendInvitation(membership, { ...ctx, now: NOW }, {
        invitationId: InvitationId(randomUUID()),
        tokenHash: randomUUID(),
        expiresAt: EXPIRY,
      });
      await repo.update(state, membership.version);
      return repo.findById(ORG, membership.membershipId);
    });

    expect(loaded!.invitations).toHaveLength(2);
    expect(loaded!.invitations[0]).toMatchObject({
      invitationVersion: 1,
      status: "Revoked",
    });
    expect(currentInvitation(loaded!)).toMatchObject({
      invitationVersion: 2,
      status: "Pending",
    });
  });

  it("makes a superseded token unfindable as the current invitation", async () => {
    const membership = invited();
    const supersededHash = currentInvitation(membership)!.tokenHash;

    const found = await withRepo(async (repo) => {
      await repo.insert(membership);
      const { state } = resendInvitation(membership, ctx, {
        invitationId: InvitationId(randomUUID()),
        tokenHash: randomUUID(),
        expiresAt: EXPIRY,
      });
      await repo.update(state, membership.version);
      return repo.findByInvitationTokenHash(supersededHash);
    });

    // The row is still found by hash — it is retained for audit — but its
    // status is Revoked and it is no longer the current invitation, which is
    // what the domain checks.
    expect(found).not.toBeNull();
    expect(currentInvitation(found!)!.tokenHash).not.toBe(supersededHash);
  });

  it("revokes an invitation and its pending token together", async () => {
    const membership = invited();
    const loaded = await withRepo(async (repo) => {
      await repo.insert(membership);
      const { state } = revokeInvitation(membership, ctx, "Sent in error");
      await repo.update(state, membership.version);
      return repo.findById(ORG, membership.membershipId);
    });

    expect(loaded).toMatchObject({
      status: "Revoked",
      revocationReason: "Sent in error",
    });
    expect(loaded!.revokedAt).not.toBeNull();
    expect(currentInvitation(loaded!)).toMatchObject({ status: "Revoked" });
  });

  it("rejects a stale write rather than overwriting", async () => {
    const membership = invited();
    await expect(
      withRepo(async (repo) => {
        await repo.insert(membership);
        const { state } = revokeInvitation(membership, ctx, "First");
        await repo.update(state, membership.version);
        // Second writer read version 1 and lost the race.
        const { state: other } = revokeInvitation(membership, ctx, "Second");
        await repo.update(other, membership.version);
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("does not return a Membership from another Organization", async () => {
    const membership = invited("alice@example.test", OTHER_ORG);
    const loaded = await withRepo(async (repo) => {
      await repo.insert(membership);
      return repo.findById(ORG, membership.membershipId);
    });
    expect(loaded).toBeNull();
  });

  it("lists members with roles, addresses, and invitation expiry", async () => {
    const membership = invited();
    const members = await withRepo(async (repo) => {
      await repo.insert(membership);
      return repo.listMembers(ORG);
    });

    // The inviter's seeded Membership plus the invitee.
    expect(members).toHaveLength(2);
    const invitee = members.find((m) => m.status === "Invited")!;
    expect(invitee).toMatchObject({
      roles: ["Reviewer"],
      email: "alice@example.test",
      displayName: null,
      identityId: null,
    });
    expect(invitee.invitationExpiresAt).toEqual(EXPIRY);
  });

  it("shows an activated Member's display name", async () => {
    const membership = invited();
    const members = await withRepo(async (repo, identities) => {
      await repo.insert(membership);
      const identity = await identities.createWithSubject({
        identityId: IdentityId(randomUUID()),
        displayName: "Alice",
        primaryEmail: "alice@example.test",
        ...SUBJECT,
      });
      const { state } = acceptInvitation(membership, NOW, {
        identityId: identity.identityId,
        tokenHash: currentInvitation(membership)!.tokenHash,
        existingIdentityEmail: null,
      });
      await repo.update(state, membership.version);
      return repo.listMembers(ORG);
    });

    expect(members.find((m) => m.status === "Active" && m.displayName === "Alice")).
      toBeDefined();
  });
});

suite("PostgresIdentityRepository", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, options: `-c search_path=${SCHEMA}` });
  });

  afterAll(async () => {
    await pool?.end();
  });

  const withRepo = async <T>(
    fn: (repo: PostgresIdentityRepository) => Promise<T>,
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      return await fn(new PostgresIdentityRepository(client));
    } finally {
      client.release();
    }
  };

  it("creates an Identity and its authentication subject together", async () => {
    const subject = { ...SUBJECT, subject: randomUUID() };
    const record = await withRepo(async (repo) => {
      const created = await repo.createWithSubject({
        identityId: IdentityId(randomUUID()),
        displayName: "Alice",
        primaryEmail: "Alice@Example.test",
        ...subject,
      });
      expect(created.status).toBe("Active");
      return repo.findBySubject(subject);
    });

    expect(record).not.toBeNull();
    // Normalization happens in SQL, so this also checks the column matches what
    // the invitation matching rule compares against.
    expect(record!.primaryEmailNormalized).toBe("alice@example.test");
  });

  it("returns null for an unknown subject", async () => {
    const record = await withRepo((repo) =>
      repo.findBySubject({ ...SUBJECT, subject: randomUUID() }),
    );
    expect(record).toBeNull();
  });
});
