import { revokeMembership, suspendMembership, type OrganizationRole } from '../domain/model.js';
import { authorize } from './authorization.js';
import type { HumanMemberPrincipal } from './principal.js';
import type { OrganizationAccessRepository, TransactionManager } from './ports.js';

export class ConcurrentModification extends Error {}
export class AccessResourceNotFound extends Error { constructor() { super('The resource was not found or is not available'); } }
export class LastActiveOwnerViolation extends Error {}

export class ManageMembershipService {
  constructor(private readonly transactions: TransactionManager, private readonly repository: OrganizationAccessRepository) {}

  suspend(principal: HumanMemberPrincipal, organizationId: string, membershipId: string, expectedVersion: number): Promise<void> {
    return this.changeStatus(principal, organizationId, membershipId, expectedVersion, 'suspend');
  }

  revoke(principal: HumanMemberPrincipal, organizationId: string, membershipId: string, expectedVersion: number): Promise<void> {
    return this.changeStatus(principal, organizationId, membershipId, expectedVersion, 'revoke');
  }

  changeRole(principal: HumanMemberPrincipal, organizationId: string, membershipId: string, role: OrganizationRole, action: 'assign' | 'revoke', reason?: string): Promise<void> {
    return this.transactions.transaction(async () => {
      authorize(principal, organizationId, role === 'OrganizationOwner' ? 'ownership.transfer' : 'role.manage');
      const target = await this.repository.findMembership(organizationId, membershipId);
      if (!target) throw new AccessResourceNotFound();
      if (action === 'revoke' && role === 'OrganizationOwner' && target.status === 'Active' && target.roles.includes(role)) {
        if (await this.repository.countActiveHumanOwnersForUpdate(organizationId) <= 1) throw new LastActiveOwnerViolation();
      }
      if (action === 'assign') await this.repository.assignRole(organizationId, membershipId, role, principal.membershipId);
      else await this.repository.revokeRole(organizationId, membershipId, role, principal.membershipId, reason ?? 'role-revoked');
    });
  }

  private changeStatus(principal: HumanMemberPrincipal, organizationId: string, membershipId: string, expectedVersion: number, action: 'suspend' | 'revoke'): Promise<void> {
    return this.transactions.transaction(async () => {
      authorize(principal, organizationId, 'membership.manage');
      const target = await this.repository.findMembership(organizationId, membershipId);
      if (!target) throw new AccessResourceNotFound();
      if (target.version !== expectedVersion) throw new ConcurrentModification();
      if (target.status === 'Active' && target.roles.includes('OrganizationOwner')) {
        if (await this.repository.countActiveHumanOwnersForUpdate(organizationId) <= 1) throw new LastActiveOwnerViolation();
      }
      await this.repository.saveMembership(action === 'suspend' ? suspendMembership(target) : revokeMembership(target), expectedVersion);
    });
  }
}
