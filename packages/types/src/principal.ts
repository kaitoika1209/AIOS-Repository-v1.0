/**
 * Principal model.
 *
 * `docs/glossary.md` and `docs/architecture/identity-and-organization.md`
 * recognise three principal categories. Principal type is part of the
 * authorization boundary: a non-Human Principal must never be treated as a
 * Human Member.
 *
 * The discriminated union below makes that unrepresentable rather than merely
 * forbidden — only `HumanMemberPrincipal` carries roles and a membership.
 */

import type { IdentityId, MembershipId, OrganizationId } from "./ids.js";
import type { Role } from "./authorization.js";

export const PRINCIPAL_TYPES = ["HumanMember", "AI", "System"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * A human acting within one Organization through an Active Membership.
 *
 * Produced at the edge by ADR-0013's resolution chain
 * (Clerk subject → identity → membership → roles). Absence of this principal
 * means no business authority; resolution fails closed.
 */
export interface HumanMemberPrincipal {
  readonly type: "HumanMember";
  readonly identityId: IdentityId;
  readonly membershipId: MembershipId;
  readonly organizationId: OrganizationId;
  readonly roles: readonly Role[];
}

/**
 * The Secretary, or a future AI Employee.
 *
 * Holds no roles by construction: AI Principals do not inherit Human Member
 * permissions and cannot exercise Human-only business authority.
 */
export interface AiPrincipal {
  readonly type: "AI";
  readonly identityId: IdentityId;
  readonly organizationId: OrganizationId;
  /** Versioned assistance operation identifier (ADR-0011). */
  readonly assistanceOperation: string;
}

/**
 * Trusted internal automation: event delivery, retries, reconciliation.
 *
 * May execute a permitted operational action caused by prior authoritative
 * intent. It cannot create new Human business intent.
 */
export interface SystemPrincipal {
  readonly type: "System";
  readonly component: string;
  readonly organizationId?: OrganizationId;
}

export type Principal = HumanMemberPrincipal | AiPrincipal | SystemPrincipal;

export const isHumanMember = (p: Principal): p is HumanMemberPrincipal =>
  p.type === "HumanMember";

export const isAi = (p: Principal): p is AiPrincipal => p.type === "AI";

export const isSystem = (p: Principal): p is SystemPrincipal => p.type === "System";
