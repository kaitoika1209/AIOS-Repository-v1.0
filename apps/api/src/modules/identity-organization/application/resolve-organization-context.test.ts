import { describe, expect, it } from 'vitest';
import { OrganizationContextDenied, resolveOrganizationContext, type OrganizationMembership } from './resolve-organization-context.js';

const membership: OrganizationMembership = {
  organizationId: 'org-alpha', membershipId: 'member-alpha', identityId: 'human-1',
  organizationStatus: 'Active', membershipStatus: 'Active', roles: ['Member'],
};

describe('resolveOrganizationContext', () => {
  it('returns only the exact active Organization membership', () => {
    expect(resolveOrganizationContext({ identityId: 'human-1', status: 'Active' }, 'org-alpha', [membership])).toEqual({
      organizationId: 'org-alpha', membershipId: 'member-alpha', identityId: 'human-1', roles: ['Member'],
    });
  });
  it('fails closed without disclosing whether another Organization exists', () => {
    expect(() => resolveOrganizationContext({ identityId: 'human-1', status: 'Active' }, 'org-beta', [membership])).toThrow(OrganizationContextDenied);
  });
  it('does not restore authority for a disabled identity', () => {
    expect(() => resolveOrganizationContext({ identityId: 'human-1', status: 'Disabled' }, 'org-alpha', [membership])).toThrow(OrganizationContextDenied);
  });
  it('does not retain Organization authority when an execution context is reused', () => {
    expect(resolveOrganizationContext({ identityId: 'human-1', status: 'Active' }, 'org-alpha', [membership])).toMatchObject({ organizationId: 'org-alpha' });
    expect(() => resolveOrganizationContext({ identityId: 'human-1', status: 'Active' }, 'org-beta', [membership])).toThrow(OrganizationContextDenied);
  });
});
