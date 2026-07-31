/**
 * API client.
 *
 * The browser never talks to the API directly: every call runs on the server,
 * so the acting subject is chosen server-side rather than by whatever headers a
 * client happens to send.
 *
 * The identity here is the development stub (ADR-0013). Replacing it with Clerk
 * means taking the subject from the session instead of from a cookie, and
 * changes nothing else in this file.
 */

import { cookies } from "next/headers";

const API_URL = process.env["API_URL"] ?? "http://localhost:3001";
const ORGANIZATION_ID =
  process.env["DEV_ORGANIZATION_ID"] ?? "0a105eed-0000-4000-8000-000000000001";

/**
 * Development identities.
 *
 * Only Olivia is seeded. Alice and Raj have no Membership — and no Identity —
 * until Olivia invites them and they accept, which is why acting as them before
 * that produces "not authenticated" rather than a working session. That is the
 * invitation flow being real, not a gap.
 *
 * `expectedRole` is what each will hold *after* joining, and it drives demo copy
 * only. It confers nothing: real roles come from the Membership, and every form
 * below submits to the API whether or not the label says it will succeed.
 */
export const DEV_USERS = [
  { subject: "olivia", label: "Olivia", seeded: true, expectedRole: "OrganizationOwner" },
  { subject: "alice", label: "Alice", seeded: false, expectedRole: "Member" },
  { subject: "raj", label: "Raj", seeded: false, expectedRole: "Reviewer" },
] as const;

export type DevUser = (typeof DEV_USERS)[number];

export const currentUser = async (): Promise<DevUser> => {
  const store = await cookies();
  const subject = store.get("aios_dev_subject")?.value;
  return DEV_USERS.find((u) => u.subject === subject) ?? DEV_USERS[0];
};

export interface Work {
  workId: string;
  title: string;
  description: string | null;
  status: string;
  completionGate: string;
  blockedBy: string | null;
  assigneeMembershipId: string | null;
  participantMembershipIds: string[];
  completionSummary: string | null;
  version: number;
}

export interface Decision {
  decisionId: string;
  relatedWorkId: string;
  status: string;
  isBlocking: boolean;
  revisionNumber: number;
  question: string;
  options: { optionId: string; summary: string }[];
  reviewHistory: {
    revisionNumber: number;
    outcome: string;
    rationale: string;
    selectedOptionId: string | null;
    reviewedAt: string;
  }[];
  version: number;
}

export interface Memory {
  memoryId: string;
  sourceWorkId: string;
  status: string;
  revisionNumber: number;
  title: string;
  summary: string;
  content: string;
  sourceReferences: string[];
  authoredBy: string;
  provenance: {
    generationPolicyVersion: number;
    generatedBySystemPrincipalId: string;
    generatedAt: string;
  };
  reviewHistory: {
    revisionNumber: number;
    outcome: string;
    note: string;
    reviewedAt: string;
  }[];
  version: number;
}

/** An API error carrying the code and status the API returned. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const call = async <T>(
  path: string,
  init: RequestInit & { subject: string; withoutOrganization?: boolean },
): Promise<T> => {
  const { subject, withoutOrganization = false, ...rest } = init;

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      "x-dev-subject": subject,
      // Only read when acceptance has to create an Identity, so the member list
      // shows a name rather than a provider subject.
      "x-dev-display-name":
        DEV_USERS.find((u) => u.subject === subject)?.label ?? subject,
      // Omitted only for invitation acceptance, the one route ADR-0014 exempts
      // from Organization resolution — the caller is not yet a Member.
      ...(withoutOrganization ? {} : { "x-organization-id": ORGANIZATION_ID }),
      ...(rest.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    throw new ApiError(
      response.status,
      body.code ?? "UNKNOWN",
      body.message ?? response.statusText,
    );
  }

  // `204 No Content` has no body to parse, and several command routes return
  // one — acknowledging a notification and retrying a failed event among them.
  // Parsing unconditionally turned an empty success into a server-side
  // exception, which is how this was found.
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
};

export const ORGANIZATION = ORGANIZATION_ID;

export interface Member {
  membershipId: string;
  status: string;
  roles: string[];
  displayName: string | null;
  email: string | null;
  invitedAt: string | null;
  activatedAt: string | null;
  invitationExpiresAt: string | null;
}

export interface Invitation {
  membershipId: string;
  status: string;
  email: string | null;
  expiresAt: string | null;
  /** Shown once, here, because no mail delivery exists yet. */
  token: string;
}

export interface Organization {
  organizationId: string;
  name: string;
  status: "Active" | "Suspended" | "Archived";
  version: number;
}

export interface AssistanceGrant {
  operation: string;
  contextKey: string;
  portContractVersion: number;
}

export const api = {
  listMembers: (subject: string) =>
    call<{ items: Member[] }>(`/organizations/${ORGANIZATION_ID}/members`, {
      method: "GET",
      subject,
    }),

  inviteMember: (subject: string, body: { email: string; roles: string[] }) =>
    call<Invitation>(`/organizations/${ORGANIZATION_ID}/members`, {
      method: "POST",
      subject,
      body: JSON.stringify(body),
    }),

  resendInvitation: (subject: string, membershipId: string) =>
    call<Invitation>(
      `/organizations/${ORGANIZATION_ID}/members/${membershipId}/resend-invitation`,
      { method: "POST", subject },
    ),

  revokeInvitation: (subject: string, membershipId: string, reason: string) =>
    call<{ membershipId: string; status: string }>(
      `/organizations/${ORGANIZATION_ID}/members/${membershipId}/revoke-invitation`,
      { method: "POST", subject, body: JSON.stringify({ reason }) },
    ),

  suspendMember: (subject: string, membershipId: string, reason: string) =>
    call<{ membershipId: string; status: string }>(
      `/organizations/${ORGANIZATION_ID}/members/${membershipId}/suspend`,
      { method: "POST", subject, body: JSON.stringify({ reason }) },
    ),

  reactivateMember: (subject: string, membershipId: string, reason: string) =>
    call<{ membershipId: string; status: string }>(
      `/organizations/${ORGANIZATION_ID}/members/${membershipId}/reactivate`,
      { method: "POST", subject, body: JSON.stringify({ reason }) },
    ),

  revokeMember: (subject: string, membershipId: string, reason: string) =>
    call<{ membershipId: string; status: string }>(
      `/organizations/${ORGANIZATION_ID}/members/${membershipId}/revoke`,
      { method: "POST", subject, body: JSON.stringify({ reason }) },
    ),

  assignRole: (subject: string, membershipId: string, role: string) =>
    call<{ membershipId: string; roles: string[] }>(
      `/organizations/${ORGANIZATION_ID}/members/${membershipId}/assign-role`,
      { method: "POST", subject, body: JSON.stringify({ role }) },
    ),

  revokeRole: (
    subject: string,
    membershipId: string,
    role: string,
    reason: string,
  ) =>
    call<{ membershipId: string; roles: string[] }>(
      `/organizations/${ORGANIZATION_ID}/members/${membershipId}/revoke-role`,
      { method: "POST", subject, body: JSON.stringify({ role, reason }) },
    ),

  organization: (subject: string) =>
    call<Organization>(`/organizations/${ORGANIZATION_ID}`, {
      method: "GET",
      subject,
    }),

  renameOrganization: (subject: string, name: string) =>
    call<Organization>(`/organizations/${ORGANIZATION_ID}`, {
      method: "PATCH",
      subject,
      body: JSON.stringify({ name }),
    }),

  suspendOrganization: (subject: string, reason: string) =>
    call<Organization>(`/organizations/${ORGANIZATION_ID}/suspend`, {
      method: "POST",
      subject,
      body: JSON.stringify({ reason }),
    }),

  reactivateOrganization: (subject: string, reason: string) =>
    call<Organization>(`/organizations/${ORGANIZATION_ID}/reactivate`, {
      method: "POST",
      subject,
      body: JSON.stringify({ reason }),
    }),

  archiveOrganization: (subject: string, reason: string) =>
    call<Organization>(`/organizations/${ORGANIZATION_ID}/archive`, {
      method: "POST",
      subject,
      body: JSON.stringify({ reason }),
    }),

  grantAssistance: (subject: string, operation: string, reason: string) =>
    call<AssistanceGrant>(`/organizations/${ORGANIZATION_ID}/assistance-grants`, {
      method: "POST",
      subject,
      body: JSON.stringify({ operation, reason }),
    }),

  revokeAssistance: (subject: string, operation: string) =>
    call<AssistanceGrant>(
      `/organizations/${ORGANIZATION_ID}/assistance-grants/revoke`,
      { method: "POST", subject, body: JSON.stringify({ operation }) },
    ),

  acceptInvitation: (subject: string, token: string) =>
    call<{ organizationId: string; membershipId: string; roles: string[] }>(
      "/invitations/accept",
      {
        method: "POST",
        subject,
        withoutOrganization: true,
        body: JSON.stringify({ token }),
      },
    ),

  /** The caller's own resolved principal — which Membership is acting. */
  me: (subject: string) =>
    call<{
      identityId: string;
      membershipId: string;
      organizationId: string;
      roles: string[];
    }>("/me", { method: "GET", subject }),

  /** The caller's own notifications. There is no parameter for whose they are. */
  listNotifications: (subject: string) =>
    call<{
      items: {
        notificationId: string;
        notificationType: string;
        subjectType: string;
        subjectId: string;
        title: string;
        occurredAt: string;
        acknowledgedAt: string | null;
      }[];
      unacknowledged: number;
    }>("/notifications", { method: "GET", subject }),

  acknowledgeNotification: (subject: string, notificationId: string) =>
    call<void>(`/notifications/${notificationId}/acknowledge`, {
      method: "POST",
      subject,
    }),

  listWork: (subject: string) =>
    call<{ items: Work[] }>("/works", { method: "GET", subject }),

  getWork: (subject: string, workId: string) =>
    call<Work>(`/works/${workId}`, { method: "GET", subject }),

  createWork: (subject: string, body: { title: string; description?: string }) =>
    call<Work>("/works", { method: "POST", subject, body: JSON.stringify(body) }),

  startWork: (subject: string, workId: string) =>
    call<Work>(`/works/${workId}/start`, { method: "POST", subject }),

  completeWork: (subject: string, workId: string, completionSummary: string) =>
    call<Work>(`/works/${workId}/complete`, {
      method: "POST",
      subject,
      body: JSON.stringify({ completionSummary }),
    }),

  cancelWork: (subject: string, workId: string, reason: string) =>
    call<Work>(`/works/${workId}/cancel`, {
      method: "POST",
      subject,
      body: JSON.stringify({ reason }),
    }),

  listDecisionsForWork: (subject: string, workId: string) =>
    call<{ items: Decision[] }>(`/decisions/by-work/${workId}`, {
      method: "GET",
      subject,
    }),

  createDecision: (
    subject: string,
    body: {
      relatedWorkId: string;
      title: string;
      question: string;
      options: { optionId: string; summary: string }[];
      isBlocking: boolean;
    },
  ) => call<Decision>("/decisions", { method: "POST", subject, body: JSON.stringify(body) }),

  submitDecision: (subject: string, decisionId: string) =>
    call<{ decision: Decision; workStatus: string }>(
      `/decisions/${decisionId}/submit`,
      { method: "POST", subject },
    ),

  approveDecision: (
    subject: string,
    decisionId: string,
    body: { selectedOptionId: string; rationale: string },
  ) =>
    call<Decision>(`/decisions/${decisionId}/approve`, {
      method: "POST",
      subject,
      body: JSON.stringify(body),
    }),

  rejectDecision: (subject: string, decisionId: string, rationale: string) =>
    call<Decision>(`/decisions/${decisionId}/reject`, {
      method: "POST",
      subject,
      body: JSON.stringify({ rationale }),
    }),

  listMemories: (subject: string) =>
    call<{ items: Memory[] }>("/memories", { method: "GET", subject }),

  memoryForWork: (subject: string, workId: string) =>
    call<{ memory: Memory | null }>(`/memories/by-work/${workId}`, {
      method: "GET",
      subject,
    }),

  editMemory: (
    subject: string,
    memoryId: string,
    body: { title?: string; summary?: string; content?: string },
  ) =>
    call<Memory>(`/memories/${memoryId}`, {
      method: "PATCH",
      subject,
      body: JSON.stringify(body),
    }),

  submitMemory: (subject: string, memoryId: string) =>
    call<Memory>(`/memories/${memoryId}/submit`, { method: "POST", subject }),

  approveMemory: (subject: string, memoryId: string, note: string) =>
    call<Memory>(`/memories/${memoryId}/approve`, {
      method: "POST",
      subject,
      body: JSON.stringify({ note }),
    }),

  rejectMemory: (subject: string, memoryId: string, note: string) =>
    call<Memory>(`/memories/${memoryId}/reject`, {
      method: "POST",
      subject,
      body: JSON.stringify({ note }),
    }),

  reopenMemory: (subject: string, memoryId: string) =>
    call<Memory>(`/memories/${memoryId}/reopen`, { method: "POST", subject }),

  startRevision: (subject: string, decisionId: string) =>
    call<Decision>(`/decisions/${decisionId}/revisions`, { method: "POST", subject }),
};
