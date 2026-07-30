import type { AuthenticationAssertion, AuthenticationSubjectRepository, OrganizationAccessRepository } from './ports.js';
import { OrganizationContextDenied } from './resolve-organization-context.js';

export interface HumanMemberPrincipal {
  readonly principalType: 'HumanMember';
  readonly principalId: string;
  readonly identityId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
}

export async function resolveHumanMemberPrincipal(
  assertion: AuthenticationAssertion,
  requestedOrganizationId: string,
  subjects: AuthenticationSubjectRepository,
  access: OrganizationAccessRepository,
): Promise<HumanMemberPrincipal> {
  const identity = await subjects.findActive(assertion);
  if (!identity || identity.status !== 'Active') throw new OrganizationContextDenied('IDENTITY_INACTIVE');
  const organization = await access.findOrganization(requestedOrganizationId);
  const membership = await access.findActiveMembershipForIdentity(requestedOrganizationId, identity.identityId);
  if (!organization || organization.status !== 'Active' || !membership || membership.status !== 'Active') {
    throw new OrganizationContextDenied('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
  }
  return {
    principalType: 'HumanMember', principalId: membership.membershipId,
    identityId: identity.identityId, membershipId: membership.membershipId,
    organizationId: requestedOrganizationId, roles: membership.roles,
  };
}
