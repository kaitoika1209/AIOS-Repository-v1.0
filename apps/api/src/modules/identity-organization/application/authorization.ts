import type { OrganizationRole } from '../domain/model.js';
import type { HumanMemberPrincipal } from './principal.js';

export type AccessPermission = 'organization.read' | 'membership.invite' | 'membership.manage' | 'role.manage' | 'ownership.transfer';

const grants: Readonly<Record<OrganizationRole, readonly AccessPermission[]>> = {
  OrganizationOwner: ['organization.read', 'membership.invite', 'membership.manage', 'role.manage', 'ownership.transfer'],
  OrganizationAdmin: ['organization.read', 'membership.invite', 'membership.manage', 'role.manage'],
  Member: ['organization.read'],
  Reviewer: ['organization.read'],
};

export class AuthorizationDenied extends Error {
  constructor(readonly reasonCode: 'ORGANIZATION_SCOPE_MISMATCH' | 'PERMISSION_DENIED') { super('The resource was not found or is not available'); }
}

export function authorize(principal: HumanMemberPrincipal, organizationId: string, permission: AccessPermission): void {
  if (principal.organizationId !== organizationId) throw new AuthorizationDenied('ORGANIZATION_SCOPE_MISMATCH');
  if (!principal.roles.some((role) => grants[role as OrganizationRole].includes(permission))) {
    throw new AuthorizationDenied('PERMISSION_DENIED');
  }
}
