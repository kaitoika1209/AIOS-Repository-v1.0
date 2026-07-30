import { describe, expect, it } from 'vitest';
import { OrganizationContextDenied } from './resolve-organization-context.js';
import { resolveHumanMemberPrincipal } from './principal.js';
import type { AuthenticationSubjectRepository, OrganizationAccessRepository } from './ports.js';

const assertion = { provider: 'clerk', issuer: 'https://issuer.example', subject: 'user-1' };
const identity = { identityId: 'human-1', status: 'Active' as const };
const membership = { membershipId: 'member-a', organizationId: 'org-a', identityId: 'human-1', status: 'Active' as const, roles: ['Member' as const], version: 1 };

function repositories(overrides: Partial<OrganizationAccessRepository> = {}) {
  const subjects: AuthenticationSubjectRepository = { findActive: (candidate) => Promise.resolve(candidate === assertion ? identity : undefined) };
  const access: OrganizationAccessRepository = {
    findOrganization: (organizationId) => Promise.resolve(organizationId === 'org-a' ? { organizationId, status: 'Active', version: 1 } : undefined),
    findMembership: () => Promise.resolve(undefined),
    findActiveMembershipForIdentity: (organizationId, identityId) => Promise.resolve(organizationId === 'org-a' && identityId === 'human-1' ? membership : undefined),
    countActiveHumanOwnersForUpdate: () => Promise.resolve(1),
    saveMembership: () => Promise.resolve(),
    assignRole: () => Promise.resolve(),
    revokeRole: () => Promise.resolve(),
    createOrganizationWithOwner: () => Promise.resolve(),
    createInvitation: () => Promise.resolve(),
    findInvitation: () => Promise.resolve(undefined),
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
    const { subjects, access } = repositories({ findActiveMembershipForIdentity: () => Promise.resolve(revoked ? undefined : membership) });
    await expect(resolveHumanMemberPrincipal(assertion, 'org-a', subjects, access)).resolves.toBeDefined();
    revoked = true;
    await expect(resolveHumanMemberPrincipal(assertion, 'org-a', subjects, access)).rejects.toBeInstanceOf(OrganizationContextDenied);
  });
});
