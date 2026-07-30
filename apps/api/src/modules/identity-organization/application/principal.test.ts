import { describe, expect, it } from 'vitest';
import { OrganizationContextDenied } from './resolve-organization-context.js';
import { resolveHumanMemberPrincipal } from './principal.js';
import type { AuthenticationSubjectRepository, OrganizationAccessRepository } from './ports.js';

const assertion = { provider: 'clerk', issuer: 'https://issuer.example', subject: 'user-1' };
const identity = { identityId: 'human-1', status: 'Active' as const };
const membership = { membershipId: 'member-a', organizationId: 'org-a', identityId: 'human-1', status: 'Active' as const, roles: ['Member' as const], version: 1 };

function repositories(overrides: Partial<OrganizationAccessRepository> = {}) {
  const subjects: AuthenticationSubjectRepository = { findActive: async (candidate) => candidate === assertion ? identity : undefined };
  const access: OrganizationAccessRepository = {
    findOrganization: async (organizationId) => organizationId === 'org-a' ? { organizationId, status: 'Active', version: 1 } : undefined,
    findMembership: async () => undefined,
    findActiveMembershipForIdentity: async (organizationId, identityId) => organizationId === 'org-a' && identityId === 'human-1' ? membership : undefined,
    countActiveHumanOwnersForUpdate: async () => 1,
    saveMembership: async () => undefined,
    assignRole: async () => undefined,
    revokeRole: async () => undefined,
    createOrganizationWithOwner: async () => undefined,
    createInvitation: async () => undefined,
    findInvitation: async () => undefined,
    ...overrides,
  };
  return { subjects, access };
}

describe('resolveHumanMemberPrincipal', () => {
  it('maps a trusted provider subject to internal Identity and current Membership', async () => {
    const { subjects, access } = repositories();
    await expect(resolveHumanMemberPrincipal(assertion, 'org-a', subjects, access)).resolves.toMatchObject({
      principalType: 'HumanMember', identityId: 'human-1', membershipId: 'member-a', organizationId: 'org-a',
    });
  });

  it('never treats IdP organization or role claims as authority', async () => {
    const { subjects, access } = repositories();
    const untrusted = { ...assertion, organizationId: 'org-b', roles: ['OrganizationOwner'] };
    await expect(resolveHumanMemberPrincipal(untrusted, 'org-b', subjects, access)).rejects.toBeInstanceOf(OrganizationContextDenied);
  });

  it('rechecks Membership for every resolution and fails closed after revocation', async () => {
    let revoked = false;
    const { subjects, access } = repositories({ findActiveMembershipForIdentity: async () => revoked ? undefined : membership });
    await expect(resolveHumanMemberPrincipal(assertion, 'org-a', subjects, access)).resolves.toBeDefined();
    revoked = true;
    await expect(resolveHumanMemberPrincipal(assertion, 'org-a', subjects, access)).rejects.toBeInstanceOf(OrganizationContextDenied);
  });
});
