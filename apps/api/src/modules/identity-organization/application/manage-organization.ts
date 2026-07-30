import { activateMembership } from '../domain/model.js';
import { authorize } from './authorization.js';
import { AccessResourceNotFound } from './manage-membership.js';
import type { HumanMemberPrincipal } from './principal.js';
import type { OrganizationAccessRepository, TransactionManager } from './ports.js';

export interface CreateOrganizationCommand {
  readonly organizationId: string;
  readonly ownerMembershipId: string;
  readonly creatorIdentityId: string;
  readonly name: string;
}

export interface InviteMembershipCommand {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly inviteeEmail: string;
}

function normalizeVerifiedEmail(email: string): string {
  const normalized = email.trim().toLocaleLowerCase('en-US');
  if (!normalized.includes('@') || normalized.length > 320) throw new Error('A valid verified invitee email is required');
  return normalized;
}

export class OrganizationManagementService {
  constructor(private readonly transactions: TransactionManager, private readonly repository: OrganizationAccessRepository) {}

  create(command: CreateOrganizationCommand): Promise<void> {
    if (!command.creatorIdentityId || !command.organizationId || !command.ownerMembershipId || !command.name.trim()) {
      throw new Error('Organization creation requires server-owned identifiers, an active creator and a name');
    }
    return this.transactions.transaction(() => this.repository.createOrganizationWithOwner({
      organizationId: command.organizationId,
      ownerMembershipId: command.ownerMembershipId,
      identityId: command.creatorIdentityId,
      name: command.name.trim(),
    }));
  }

  invite(principal: HumanMemberPrincipal, command: InviteMembershipCommand): Promise<void> {
    return this.transactions.transaction(async () => {
      authorize(principal, command.organizationId, 'membership.invite');
      await this.repository.createInvitation({
        organizationId: command.organizationId,
        membershipId: command.membershipId,
        inviteeEmailNormalized: normalizeVerifiedEmail(command.inviteeEmail),
        inviterIdentityId: principal.identityId,
        inviterMembershipId: principal.membershipId,
      });
    });
  }

  acceptInvitation(organizationId: string, membershipId: string, identityId: string, expectedVersion: number): Promise<void> {
    return this.transactions.transaction(async () => {
      const invitation = await this.repository.findInvitation(organizationId, membershipId);
      if (!invitation || invitation.status !== 'Invited') throw new AccessResourceNotFound();
      if (invitation.version !== expectedVersion) throw new AccessResourceNotFound();
      await this.repository.saveMembership(activateMembership(invitation, identityId), expectedVersion);
    });
  }
}
