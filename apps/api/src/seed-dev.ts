/**
 * Development seed.
 *
 * Creates one Organization with two Members and their development
 * authentication subjects, so the API and UI can be exercised before the
 * invitation flow exists.
 *
 * This writes identity, Organization, and Membership rows directly. That is
 * deliberate and temporary: those aggregates have no use cases yet, and
 * inventing ad-hoc ones here would create a second, untested path into the
 * tenant boundary. The invitation flow replaces this.
 *
 *     pnpm --filter @aios/api seed
 *
 * Refuses to run outside development.
 */

import { Pool } from "pg";

export const SEED = {
  organizationId: "0a105eed-0000-4000-8000-000000000001",
  organizationName: "Acme Product Team",
  members: [
    {
      subject: "olivia",
      displayName: "Olivia (Owner)",
      email: "olivia@example.test",
      identityId: "0a105eed-0000-4000-8000-00000000a10b",
      membershipId: "0a105eed-0000-4000-8000-00000000b10b",
      role: "OrganizationOwner",
    },
    {
      subject: "alice",
      displayName: "Alice (Member)",
      email: "alice@example.test",
      identityId: "0a105eed-0000-4000-8000-00000000a11c",
      membershipId: "0a105eed-0000-4000-8000-00000000b11c",
      role: "Member",
    },
    {
      subject: "raj",
      displayName: "Raj (Reviewer)",
      email: "raj@example.test",
      identityId: "0a105eed-0000-4000-8000-00000000a12d",
      membershipId: "0a105eed-0000-4000-8000-00000000b12d",
      role: "Reviewer",
    },
  ],
} as const;

/** Matches SECRETARY_IDENTITY_ID in app.ts. */
const SECRETARY = {
  identityId: "0a105eed-0000-4000-8000-00000000c001",
  displayName: "Secretary",
};

const DEV_PROVIDER = "dev";
const DEV_ISSUER = "https://dev.local";

export const seed = async (pool: Pool): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // The Secretary needs an identity row so generated Memory can be attributed
    // to it. It has no authentication subject and no Membership: it can never
    // sign in and holds no Human authority.
    await client.query(
      `INSERT INTO human_identities
         (identity_id, status, display_name, version, created_at, updated_at)
       VALUES ($1, 'Active', $2, 1, now(), now())
       ON CONFLICT (identity_id) DO NOTHING`,
      [SECRETARY.identityId, SECRETARY.displayName],
    );

    for (const member of SEED.members) {
      await client.query(
        `INSERT INTO human_identities
           (identity_id, status, display_name, primary_email, primary_email_normalized,
            version, created_at, updated_at)
         VALUES ($1, 'Active', $2, $3, lower($3), 1, now(), now())
         ON CONFLICT (identity_id) DO NOTHING`,
        [member.identityId, member.displayName, member.email],
      );
    }

    await client.query(
      `INSERT INTO organizations
         (organization_id, name, status, created_by_identity_id, version, created_at, updated_at)
       VALUES ($1, $2, 'Active', $3, 1, now(), now())
       ON CONFLICT (organization_id) DO NOTHING`,
      [SEED.organizationId, SEED.organizationName, SEED.members[0].identityId],
    );

    for (const member of SEED.members) {
      await client.query(
        `INSERT INTO authentication_subjects
           (authentication_subject_id, identity_id, provider, issuer, subject, linked_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())
         ON CONFLICT DO NOTHING`,
        [member.identityId, DEV_PROVIDER, DEV_ISSUER, member.subject],
      );

      await client.query(
        `INSERT INTO memberships
           (membership_id, organization_id, identity_id, status,
            invited_by_identity_id, invited_at, activated_at,
            version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Active', $3, now(), now(), 1, now(), now())
         ON CONFLICT (membership_id) DO NOTHING`,
        [member.membershipId, SEED.organizationId, member.identityId],
      );

      await client.query(
        `INSERT INTO membership_role_assignments
           (role_assignment_id, organization_id, membership_id, role,
            assigned_by_identity_id, assigned_by_membership_id, assigned_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $2, now())
         ON CONFLICT DO NOTHING`,
        [SEED.organizationId, member.membershipId, member.role, member.identityId],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const main = async (): Promise<void> => {
  const connectionString = process.env["DATABASE_URL"];
  if (connectionString === undefined) {
    throw new Error("DATABASE_URL is required.");
  }

  const environment = process.env["NODE_ENV"] ?? "development";
  if (environment !== "development" && environment !== "test") {
    throw new Error(
      `Seeding writes identity and membership rows directly and must not run ` +
        `outside development (NODE_ENV=${environment}).`,
    );
  }

  const pool = new Pool({ connectionString });
  try {
    await seed(pool);
    console.log(`Seeded Organization ${SEED.organizationId} (${SEED.organizationName})`);
    for (const member of SEED.members) {
      console.log(`  ${member.role.padEnd(9)} ${member.displayName}  X-Dev-Subject: ${member.subject}`);
    }
  } finally {
    await pool.end();
  }
};

if (process.argv[1]?.endsWith("seed-dev.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
