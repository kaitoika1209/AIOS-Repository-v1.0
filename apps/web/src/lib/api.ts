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

/** Which Organization the person is currently acting in. */
export const ORGANIZATION_COOKIE = "aios_organization";

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
  init: RequestInit & {
    subject: string;
    /**
     * Omitted for the routes ADR-0014 exempts from Organization resolution.
     * Supplied explicitly everywhere else rather than read from a module
     * constant — that constant was the whole of the A2 defect.
     */
    organizationId?: string;
    withoutOrganization?: boolean;
  },
): Promise<T> => {
  const { subject, organizationId, withoutOrganization = false, ...rest } = init;

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      "x-dev-subject": subject,
      // Only read when acceptance has to create an Identity, so the member list
      // shows a name rather than a provider subject.
      "x-dev-display-name":
        DEV_USERS.find((u) => u.subject === subject)?.label ?? subject,
      // Omitted for the routes ADR-0014 exempts from Organization resolution:
      // invitation acceptance, Organization creation, and listing the caller's
      // own Organizations.
      //
      // Otherwise resolved here when the caller did not supply it, so a flat
      // resource path like `/works` is scoped as surely as an Organization one.
      // Callers that already hold it pass it, to save a second lookup.
      ...(withoutOrganization
        ? {}
        : {
            "x-organization-id":
              organizationId ?? (await requireOrganization(subject)).organizationId,
          }),
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

/** One Organization the caller belongs to, as `GET /organizations` reports it. */
export interface CallerOrganization {
  organizationId: string;
  name: string;
  status: "Active" | "Suspended" | "Archived";
  membershipId: string;
  roles: string[];
}

/**
 * Every Organization this person may act in.
 *
 * The route that made Organization selection possible at all. Before it, the
 * client could be told which single Organization to use and had no way to offer
 * a choice — see ADR-0014.
 */
export const myOrganizations = async (
  subject: string,
): Promise<readonly CallerOrganization[]> =>
  (
    await call<{ organizations: CallerOrganization[] }>("/organizations", {
      method: "GET",
      subject,
      withoutOrganization: true,
    })
  ).organizations;

/**
 * The Organization this person is currently acting in.
 *
 * The cookie is a *preference*, never an authority: it is validated against the
 * caller's real Memberships on every request, and a value naming an Organization
 * they do not belong to is discarded rather than sent. The API would refuse it
 * anyway with a `404`, but a client that forwards an unvalidated tenant
 * identifier is one line away from being the thing that leaks.
 *
 * Falls back to the first Organization, so a person with exactly one never has
 * to choose. Null when they belong to none — which is an ordinary state for
 * someone who has signed in and not yet been invited anywhere.
 */
export const currentOrganization = async (
  subject: string,
): Promise<CallerOrganization | null> => {
  const available = await myOrganizations(subject);
  if (available.length === 0) return null;

  const store = await cookies();
  const preferred = store.get(ORGANIZATION_COOKIE)?.value;
  return (
    available.find((o) => o.organizationId === preferred) ?? available[0] ?? null
  );
};

/**
 * The Organization a scoped request acts in, or a refusal.
 *
 * Throws rather than returning null so a caller cannot forget the empty case
 * and send a request with no tenant at all.
 */
const requireOrganization = async (subject: string): Promise<CallerOrganization> => {
  const organization = await currentOrganization(subject);
  if (organization === null) {
    throw new ApiError(404, "NO_ORGANIZATION", "You do not belong to an Organization.");
  }
  return organization;
};

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
  listMembers: async (subject: string) => {
    const org = await requireOrganization(subject);
    return call<{ items: Member[] }>(`/organizations/${org.organizationId}/members`, {
      method: "GET",
      subject,
      organizationId: org.organizationId,
    });
  },

  inviteMember: async (subject: string, body: { email: string; roles: string[] }) => {
    const org = await requireOrganization(subject);
    return call<Invitation>(`/organizations/${org.organizationId}/members`, {
      method: "POST",
      subject,
      organizationId: org.organizationId,
      body: JSON.stringify(body),
    });
  },

  resendInvitation: async (subject: string, membershipId: string) => {
    const org = await requireOrganization(subject);
    return call<Invitation>(
      `/organizations/${org.organizationId}/members/${membershipId}/resend-invitation`,
      { method: "POST", subject, organizationId: org.organizationId },
    );
  },

  revokeInvitation: async (subject: string, membershipId: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/revoke-invitation`,
      { method: "POST", subject, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  suspendMember: async (subject: string, membershipId: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/suspend`,
      { method: "POST", subject, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  reactivateMember: async (subject: string, membershipId: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/reactivate`,
      { method: "POST", subject, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  revokeMember: async (subject: string, membershipId: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/revoke`,
      { method: "POST", subject, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  assignRole: async (subject: string, membershipId: string, role: string) => {
    const org = await requireOrganization(subject);
    return call<{ membershipId: string; roles: string[] }>(
      `/organizations/${org.organizationId}/members/${membershipId}/assign-role`,
      { method: "POST", subject, organizationId: org.organizationId, body: JSON.stringify({ role }) },
    );
  },

  revokeRole: async (
    subject: string,
    membershipId: string,
    role: string,
    reason: string,
  ) => {
    const org = await requireOrganization(subject);
    return call<{ membershipId: string; roles: string[] }>(
      `/organizations/${org.organizationId}/members/${membershipId}/revoke-role`,
      { method: "POST", subject, organizationId: org.organizationId, body: JSON.stringify({ role, reason }) },
    );
  },

  organization: async (subject: string) => {
    const org = await requireOrganization(subject);
    return call<Organization>(`/organizations/${org.organizationId}`, {
      method: "GET",
      subject,
      organizationId: org.organizationId,
    });
  },

  renameOrganization: async (subject: string, name: string) => {
    const org = await requireOrganization(subject);
    return call<Organization>(`/organizations/${org.organizationId}`, {
      method: "PATCH",
      subject,
      organizationId: org.organizationId,
      body: JSON.stringify({ name }),
    });
  },

  suspendOrganization: async (subject: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<Organization>(`/organizations/${org.organizationId}/suspend`, {
      method: "POST",
      subject,
      organizationId: org.organizationId,
      body: JSON.stringify({ reason }),
    });
  },

  reactivateOrganization: async (subject: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<Organization>(`/organizations/${org.organizationId}/reactivate`, {
      method: "POST",
      subject,
      organizationId: org.organizationId,
      body: JSON.stringify({ reason }),
    });
  },

  archiveOrganization: async (subject: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<Organization>(`/organizations/${org.organizationId}/archive`, {
      method: "POST",
      subject,
      organizationId: org.organizationId,
      body: JSON.stringify({ reason }),
    });
  },

  grantAssistance: async (subject: string, operation: string, reason: string) => {
    const org = await requireOrganization(subject);
    return call<AssistanceGrant>(`/organizations/${org.organizationId}/assistance-grants`, {
      method: "POST",
      subject,
      organizationId: org.organizationId,
      body: JSON.stringify({ operation, reason }),
    });
  },

  revokeAssistance: async (subject: string, operation: string) => {
    const org = await requireOrganization(subject);
    return call<AssistanceGrant>(
      `/organizations/${org.organizationId}/assistance-grants/revoke`,
      { method: "POST", subject, organizationId: org.organizationId, body: JSON.stringify({ operation }) },
    );
  },

  /**
   * Create an Organization with its first Owner.
   *
   * No `x-organization-id`: the caller is bringing the Organization into
   * existence, so there is nothing for the header to select among (ADR-0014).
   */
  createOrganization: (subject: string, name: string) =>
    call<Organization & { membershipId: string }>("/organizations", {
      method: "POST",
      subject,
      withoutOrganization: true,
      body: JSON.stringify({ name }),
    }),

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
