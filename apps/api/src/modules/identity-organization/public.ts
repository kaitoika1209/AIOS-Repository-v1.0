export const identityOrganizationModule = 'identity-organization' as const;
export { resolveOrganizationContext, OrganizationContextDenied } from './application/resolve-organization-context.js';
export type { AuthenticatedIdentity, OrganizationContext, OrganizationMembership } from './application/resolve-organization-context.js';
