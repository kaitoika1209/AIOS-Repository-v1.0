export interface AuthenticatedIdentity {
  readonly identityId: string;
  readonly status: 'Active' | 'Disabled';
}

export interface OrganizationMembership {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly identityId: string;
  readonly organizationStatus: 'Active' | 'Suspended' | 'Archived';
  readonly membershipStatus: 'Invited' | 'Active' | 'Suspended' | 'Revoked';
  readonly roles: readonly ('OrganizationOwner' | 'OrganizationAdmin' | 'Member' | 'Reviewer')[];
}

export interface OrganizationContext {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly identityId: string;
  readonly roles: OrganizationMembership['roles'];
}

export class OrganizationContextDenied extends Error {
  constructor(readonly reasonCode: 'IDENTITY_INACTIVE' | 'MEMBERSHIP_NOT_FOUND_OR_INACTIVE') {
    super('Organization context could not be resolved');
  }
}

export function resolveOrganizationContext(
  identity: AuthenticatedIdentity,
  requestedOrganizationId: string,
  memberships: readonly OrganizationMembership[],
): OrganizationContext {
  if (identity.status !== 'Active') throw new OrganizationContextDenied('IDENTITY_INACTIVE');
  const membership = memberships.find((candidate) =>
    candidate.identityId === identity.identityId &&
    candidate.organizationId === requestedOrganizationId &&
    candidate.organizationStatus === 'Active' &&
    candidate.membershipStatus === 'Active',
  );
  if (!membership) throw new OrganizationContextDenied('MEMBERSHIP_NOT_FOUND_OR_INACTIVE');
  return { organizationId: membership.organizationId, membershipId: membership.membershipId, identityId: identity.identityId, roles: membership.roles };
}
