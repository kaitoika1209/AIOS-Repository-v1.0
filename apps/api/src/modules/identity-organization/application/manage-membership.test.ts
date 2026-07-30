import { describe, expect, it, vi } from 'vitest';
import { AuthorizationDenied } from './authorization.js';
import { AccessResourceNotFound, ConcurrentModification, LastActiveOwnerViolation, ManageMembershipService } from './manage-membership.js';
import type { HumanMemberPrincipal } from './principal.js';
import type { OrganizationAccessRepository, TransactionManager } from './ports.js';

const owner: HumanMemberPrincipal = { principalType: 'HumanMember', principalId: 'owner-a', identityId: 'human-a', membershipId: 'owner-a', organizationId: 'org-a', roles: ['OrganizationOwner'] };
const target = { membershipId: 'member-a', organizationId: 'org-a', identityId: 'human-b', status: 'Active' as const, roles: ['Member' as const], version: 3 };
const transactions: TransactionManager = { transaction: (work) => work() };

function repository(overrides: Partial<OrganizationAccessRepository> = {}): OrganizationAccessRepository {
  return {
    findOrganization: () => Promise.resolve(undefined),
    findMembership: (organizationId, membershipId) => Promise.resolve(organizationId === 'org-a' && membershipId === 'member-a' ? target : undefined),
    findActiveMembershipForIdentity: () => Promise.resolve(undefined),
    countActiveHumanOwnersForUpdate: () => Promise.resolve(2),
    saveMembership: vi.fn(() => Promise.resolve()), assignRole: vi.fn(() => Promise.resolve()), revokeRole: vi.fn(() => Promise.resolve()),
    createOrganizationWithOwner: vi.fn(() => Promise.resolve()), createInvitation: vi.fn(() => Promise.resolve()), findInvitation: () => Promise.resolve(undefined),
    ...overrides,
  };
}

describe('ManageMembershipService', () => {
  it('writes an Organization-scoped mutation with expected version', async () => {
    const saveMembership = vi.fn(() => Promise.resolve());
    const repo = repository({ saveMembership });
    await new ManageMembershipService(transactions, repo).suspend(owner, 'org-a', 'member-a', 3);
    expect(saveMembership).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a', status: 'Suspended', version: 4 }), 3);
  });

  it('returns safe not-found behavior for known and random foreign identifiers', async () => {
    const service = new ManageMembershipService(transactions, repository());
    await expect(service.suspend(owner, 'org-a', 'member-from-org-b', 1)).rejects.toBeInstanceOf(AccessResourceNotFound);
    await expect(service.suspend(owner, 'org-a', 'random-id', 1)).rejects.toBeInstanceOf(AccessResourceNotFound);
  });

  it('rejects stale expected versions', async () => {
    await expect(new ManageMembershipService(transactions, repository()).suspend(owner, 'org-a', 'member-a', 2)).rejects.toBeInstanceOf(ConcurrentModification);
  });

  it('does not combine authority across Organizations', async () => {
    const foreignPrincipal = { ...owner, organizationId: 'org-b' };
    await expect(new ManageMembershipService(transactions, repository()).suspend(foreignPrincipal, 'org-a', 'member-a', 3)).rejects.toBeInstanceOf(AuthorizationDenied);
  });

  it('rechecks the owner count while inside the transaction', async () => {
    const lastOwner = { ...target, roles: ['OrganizationOwner' as const] };
    const saveMembership = vi.fn(() => Promise.resolve());
    const repo = repository({ findMembership: () => Promise.resolve(lastOwner), countActiveHumanOwnersForUpdate: () => Promise.resolve(1), saveMembership });
    await expect(new ManageMembershipService(transactions, repo).revoke(owner, 'org-a', 'member-a', 3)).rejects.toBeInstanceOf(LastActiveOwnerViolation);
    expect(saveMembership).not.toHaveBeenCalled();
  });
});
