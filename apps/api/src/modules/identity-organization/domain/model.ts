export type IdentityStatus = 'Active' | 'Disabled';
export type OrganizationStatus = 'Active' | 'Suspended' | 'Archived';
export type MembershipStatus = 'Invited' | 'Active' | 'Suspended' | 'Revoked';
export type OrganizationRole = 'OrganizationOwner' | 'OrganizationAdmin' | 'Member' | 'Reviewer';

export interface HumanIdentity {
  readonly identityId: string;
  readonly status: IdentityStatus;
}

export interface Organization {
  readonly organizationId: string;
  readonly status: OrganizationStatus;
  readonly version: number;
}

export interface Membership {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly identityId?: string;
  readonly pendingInviteeEmailNormalized?: string | undefined;
  readonly status: MembershipStatus;
  readonly roles: readonly OrganizationRole[];
  readonly version: number;
}

export class MembershipTransitionDenied extends Error {}

export function activateMembership(membership: Membership, identityId: string): Membership {
  if (membership.status !== 'Invited') throw new MembershipTransitionDenied('Only an invited Membership can be activated');
  if (!identityId) throw new MembershipTransitionDenied('Activation requires a stable Human Identity');
  return { ...membership, identityId, pendingInviteeEmailNormalized: undefined, status: 'Active', version: membership.version + 1 };
}

export function suspendMembership(membership: Membership): Membership {
  if (membership.status !== 'Active') throw new MembershipTransitionDenied('Only an active Membership can be suspended');
  return { ...membership, status: 'Suspended', version: membership.version + 1 };
}

export function revokeMembership(membership: Membership): Membership {
  if (membership.status === 'Revoked') throw new MembershipTransitionDenied('A revoked Membership is terminal');
  return { ...membership, status: 'Revoked', version: membership.version + 1 };
}
