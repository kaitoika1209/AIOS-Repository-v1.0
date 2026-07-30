import { describe, expect, it, vi } from 'vitest';
import { AuthorizationDenied } from './authorization.js';
import { AccessResourceNotFound } from './manage-membership.js';
import { OrganizationManagementService } from './manage-organization.js';
import type { HumanMemberPrincipal } from './principal.js';
import type { OrganizationAccessRepository, TransactionManager } from './ports.js';

const owner: HumanMemberPrincipal = { principalType: 'HumanMember', principalId: 'owner-a', identityId: 'human-a', membershipId: 'owner-a', organizationId: 'org-a', roles: ['OrganizationOwner'] };
const transactions: TransactionManager = { transaction: async (work) => work() };

function repository(): OrganizationAccessRepository {
  return {
    findOrganization: async () => undefined, findMembership: async () => undefined,
    findActiveMembershipForIdentity: async () => undefined, countActiveHumanOwnersForUpdate: async () => 1,
    saveMembership: vi.fn(async () => undefined), assignRole: async () => undefined, revokeRole: async () => undefined,
    createOrganizationWithOwner: vi.fn(async () => undefined), createInvitation: vi.fn(async () => undefined), findInvitation: async () => undefined,
  };
}

describe('OrganizationManagementService', () => {
  it('creates Organization and Human Owner through one repository operation', async () => {
    const repo = repository();
    await new OrganizationManagementService(transactions, repo).create({ organizationId: 'org-a', ownerMembershipId: 'owner-a', creatorIdentityId: 'human-a', name: 'Alpha' });
    expect(repo.createOrganizationWithOwner).toHaveBeenCalledWith({ organizationId: 'org-a', ownerMembershipId: 'owner-a', identityId: 'human-a', name: 'Alpha' });
  });

  it('normalizes invitation email and attributes the Human inviter', async () => {
    const repo = repository();
    await new OrganizationManagementService(transactions, repo).invite(owner, { organizationId: 'org-a', membershipId: 'invite-1', inviteeEmail: ' Person@Example.COM ' });
    expect(repo.createInvitation).toHaveBeenCalledWith(expect.objectContaining({ inviteeEmailNormalized: 'person@example.com', inviterIdentityId: 'human-a', inviterMembershipId: 'owner-a' }));
  });

  it('rejects an invitation command using authority from another Organization', async () => {
    const repo = repository();
    await expect(new OrganizationManagementService(transactions, repo).invite({ ...owner, organizationId: 'org-b' }, { organizationId: 'org-a', membershipId: 'invite-1', inviteeEmail: 'p@example.com' })).rejects.toBeInstanceOf(AuthorizationDenied);
  });

  it('does not disclose missing versus already-consumed invitations', async () => {
    await expect(new OrganizationManagementService(transactions, repository()).acceptInvitation('org-a', 'unknown', 'human-b', 1)).rejects.toBeInstanceOf(AccessResourceNotFound);
  });
});
