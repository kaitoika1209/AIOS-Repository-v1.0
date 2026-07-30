import type { HumanIdentity, Membership, Organization, OrganizationRole } from '../domain/model.js';

export interface AuthenticationAssertion {
  readonly provider: string;
  readonly issuer: string;
  readonly subject: string;
}

export interface AuthenticationSubjectRepository {
  findActive(assertion: AuthenticationAssertion): Promise<HumanIdentity | undefined>;
}

export interface OrganizationAccessRepository {
  findOrganization(organizationId: string): Promise<Organization | undefined>;
  findMembership(organizationId: string, membershipId: string): Promise<Membership | undefined>;
  findActiveMembershipForIdentity(organizationId: string, identityId: string): Promise<Membership | undefined>;
  countActiveHumanOwnersForUpdate(organizationId: string): Promise<number>;
  saveMembership(membership: Membership, expectedVersion: number): Promise<void>;
  assignRole(organizationId: string, membershipId: string, role: OrganizationRole, actorMembershipId: string): Promise<void>;
  revokeRole(organizationId: string, membershipId: string, role: OrganizationRole, actorMembershipId: string, reason: string): Promise<void>;
  createOrganizationWithOwner(input: { organizationId: string; name: string; ownerMembershipId: string; identityId: string }): Promise<void>;
  createInvitation(input: { organizationId: string; membershipId: string; inviteeEmailNormalized: string; inviterIdentityId: string; inviterMembershipId: string }): Promise<void>;
  findInvitation(organizationId: string, membershipId: string): Promise<Membership | undefined>;
}

export interface TransactionManager {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}
