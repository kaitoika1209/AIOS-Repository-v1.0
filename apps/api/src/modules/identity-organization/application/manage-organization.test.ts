import { describe, expect, it, vi } from 'vitest';
import { AuthorizationDenied } from './authorization.js';
import { AccessResourceNotFound } from './manage-membership.js';
import { OrganizationManagementService } from './manage-organization.js';
import type { HumanMemberPrincipal } from './principal.js';
import type { OrganizationAccessRepository, TransactionManager } from './ports.js';

const owner: HumanMemberPrincipal = { principalType: 'HumanMember', principalId: 'owner-a', identityId: 'human-a', membershipId: 'owner-a', organizationId: 'org-a', roles: ['OrganizationOwner'] };
const transactions: TransactionManager = { transaction: (work) => work() };

function repository(): OrganizationAccessRepository {
  return {
    findOrganization: () => Promise.resolve(undefined), findMembership: () => Promise.resolve(undefined),
    findActiveMembershipForIdentity: () => Promise.resolve(undefined), countActiveHumanOwnersForUpdate: () => Promise.resolve(1),
    saveMembership: vi.fn(() => Promise.resolve()), assignRole: () => Promise.resolve(), revokeRole: () => Promise.resolve(),
    createOrganizationWithOwner: vi.fn(() => Promise.resolve()), createInvitation: vi.fn(() => Promise.resolve()), findInvitation: () => Promise.resolve(undefined),
  };
}

describe('OrganizationManagementService', () => {
  it('creates Organization and Human Owner through one repository operation', async () => {
    const createOrganizationWithOwner = vi.fn(() => Promise.resolve());
    const repo = { ...repository(), createOrganizationWithOwner };
    await new OrganizationManagementService(transactions, repo).create({ organizationId: 'org-a', ownerMembershipId: 'owner-a', creatorIdentityId: 'human-a', name: 'Alpha' });
    expect(createOrganizationWithOwner).toHaveBeenCalledWith({ organizationId: 'org-a', ownerMembershipId: 'owner-a', identityId: 'human-a', name: 'Alpha' });
  });

  it('normalizes invitation email and attributes the Human inviter', async () => {
    const createInvitation = vi.fn(() => Promise.resolve());
    const repo = { ...repository(), createInvitation };
    await new OrganizationManagementService(transactions, repo).invite(owner, { organizationId: 'org-a', membershipId: 'invite-1', inviteeEmail: ' Person@Example.COM ' });
    expect(createInvitation).toHaveBeenCalledWith(expect.objectContaining({ inviteeEmailNormalized: 'person@example.com', inviterIdentityId: 'human-a', inviterMembershipId: 'owner-a' }));
  });

  it('rejects an invitation command using authority from another Organization', async () => {
    const repo = repository();
    await expect(new OrganizationManagementService(transactions, repo).invite({ ...owner, organizationId: 'org-b' }, { organizationId: 'org-a', membershipId: 'invite-1', inviteeEmail: 'p@example.com' })).rejects.toBeInstanceOf(AuthorizationDenied);
  });

  it('does not disclose missing versus already-consumed invitations', async () => {
    await expect(new OrganizationManagementService(transactions, repository()).acceptInvitation('org-a', 'unknown', 'human-b', 1)).rejects.toBeInstanceOf(AccessResourceNotFound);
  });
});
