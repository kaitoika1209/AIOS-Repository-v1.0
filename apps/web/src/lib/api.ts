/**
 * API client.
 *
 * The browser never talks to the API directly: every call runs on the server,
 * so the credential is chosen server-side rather than by whatever headers a
 * client happens to send.
 *
 * What changed with A1 is the *source* of that credential. Every function used
 * to take `session: WebSession` — a name the caller picked — and the client sent it
 * as a header the API's development adapter trusted. They now take a
 * `WebSession`, which only `session.ts` can produce and only from a real
 * sign-in. A page cannot construct one, and there is no longer a string that
 * means "act as this person".
 */

import { cookies } from "next/headers";

import type { WebSession } from "./session";

const API_URL = process.env["API_URL"] ?? "http://localhost:3001";

/** Which Organization the person is currently acting in. */
export const ORGANIZATION_COOKIE = "aios_organization";

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
    session: WebSession;
    /**
     * Omitted for the routes ADR-0014 exempts from Organization resolution.
     * Supplied explicitly everywhere else rather than read from a module
     * constant — that constant was the whole of the A2 defect.
     */
    organizationId?: string;
    withoutOrganization?: boolean;
  },
): Promise<T> => {
  const { session, organizationId, withoutOrganization = false, ...rest } = init;

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(await credentialFor(session)),
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
              organizationId ?? (await requireOrganization(session)).organizationId,
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

/**
 * How this session proves who it is to the API.
 *
 * A bearer token when the session has one — which is the Clerk path, and the
 * only path a deployed client ever takes — and the development headers
 * otherwise. The two are mutually exclusive by construction rather than by
 * convention: a session with a token never sends `x-dev-session`, so there is no
 * arrangement in which a real session and a development header are both present
 * and the API has to choose.
 *
 * The API refuses the development adapter outside `development` anyway. This is
 * the client's half of the same rule, and it is worth having on both sides:
 * relying on the far end to reject what this end should not have sent is how a
 * misconfiguration becomes an authentication bypass.
 */
const credentialFor = async (
  session: WebSession,
): Promise<Record<string, string>> => {
  const token = await session.token();
  if (token !== null) {
    return { authorization: `Bearer ${token}` };
  }

  return {
    "x-dev-subject": session.subject,
    // Read only when acceptance has to create an Identity, so the member list
    // shows a name rather than a provider session.
    "x-dev-display-name": session.displayName,
    ...(session.email === null ? {} : { "x-dev-email": session.email }),
  };
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
  session: WebSession,
): Promise<readonly CallerOrganization[]> =>
  (
    await call<{ organizations: CallerOrganization[] }>("/organizations", {
      method: "GET",
      session,
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
  session: WebSession,
): Promise<CallerOrganization | null> => {
  const available = await myOrganizations(session);
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
const requireOrganization = async (session: WebSession): Promise<CallerOrganization> => {
  const organization = await currentOrganization(session);
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
  listMembers: async (session: WebSession) => {
    const org = await requireOrganization(session);
    return call<{ items: Member[] }>(`/organizations/${org.organizationId}/members`, {
      method: "GET",
      session,
      organizationId: org.organizationId,
    });
  },

  inviteMember: async (session: WebSession, body: { email: string; roles: string[] }) => {
    const org = await requireOrganization(session);
    return call<Invitation>(`/organizations/${org.organizationId}/members`, {
      method: "POST",
      session,
      organizationId: org.organizationId,
      body: JSON.stringify(body),
    });
  },

  resendInvitation: async (session: WebSession, membershipId: string) => {
    const org = await requireOrganization(session);
    return call<Invitation>(
      `/organizations/${org.organizationId}/members/${membershipId}/resend-invitation`,
      { method: "POST", session, organizationId: org.organizationId },
    );
  },

  revokeInvitation: async (session: WebSession, membershipId: string, reason: string) => {
    const org = await requireOrganization(session);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/revoke-invitation`,
      { method: "POST", session, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  suspendMember: async (session: WebSession, membershipId: string, reason: string) => {
    const org = await requireOrganization(session);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/suspend`,
      { method: "POST", session, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  reactivateMember: async (session: WebSession, membershipId: string, reason: string) => {
    const org = await requireOrganization(session);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/reactivate`,
      { method: "POST", session, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  revokeMember: async (session: WebSession, membershipId: string, reason: string) => {
    const org = await requireOrganization(session);
    return call<{ membershipId: string; status: string }>(
      `/organizations/${org.organizationId}/members/${membershipId}/revoke`,
      { method: "POST", session, organizationId: org.organizationId, body: JSON.stringify({ reason }) },
    );
  },

  assignRole: async (session: WebSession, membershipId: string, role: string) => {
    const org = await requireOrganization(session);
    return call<{ membershipId: string; roles: string[] }>(
      `/organizations/${org.organizationId}/members/${membershipId}/assign-role`,
      { method: "POST", session, organizationId: org.organizationId, body: JSON.stringify({ role }) },
    );
  },

  revokeRole: async (
    session: WebSession,
    membershipId: string,
    role: string,
    reason: string,
  ) => {
    const org = await requireOrganization(session);
    return call<{ membershipId: string; roles: string[] }>(
      `/organizations/${org.organizationId}/members/${membershipId}/revoke-role`,
      { method: "POST", session, organizationId: org.organizationId, body: JSON.stringify({ role, reason }) },
    );
  },

  organization: async (session: WebSession) => {
    const org = await requireOrganization(session);
    return call<Organization>(`/organizations/${org.organizationId}`, {
      method: "GET",
      session,
      organizationId: org.organizationId,
    });
  },

  renameOrganization: async (session: WebSession, name: string) => {
    const org = await requireOrganization(session);
    return call<Organization>(`/organizations/${org.organizationId}`, {
      method: "PATCH",
      session,
      organizationId: org.organizationId,
      body: JSON.stringify({ name }),
    });
  },

  suspendOrganization: async (session: WebSession, reason: string) => {
    const org = await requireOrganization(session);
    return call<Organization>(`/organizations/${org.organizationId}/suspend`, {
      method: "POST",
      session,
      organizationId: org.organizationId,
      body: JSON.stringify({ reason }),
    });
  },

  reactivateOrganization: async (session: WebSession, reason: string) => {
    const org = await requireOrganization(session);
    return call<Organization>(`/organizations/${org.organizationId}/reactivate`, {
      method: "POST",
      session,
      organizationId: org.organizationId,
      body: JSON.stringify({ reason }),
    });
  },

  archiveOrganization: async (session: WebSession, reason: string) => {
    const org = await requireOrganization(session);
    return call<Organization>(`/organizations/${org.organizationId}/archive`, {
      method: "POST",
      session,
      organizationId: org.organizationId,
      body: JSON.stringify({ reason }),
    });
  },

  grantAssistance: async (session: WebSession, operation: string, reason: string) => {
    const org = await requireOrganization(session);
    return call<AssistanceGrant>(`/organizations/${org.organizationId}/assistance-grants`, {
      method: "POST",
      session,
      organizationId: org.organizationId,
      body: JSON.stringify({ operation, reason }),
    });
  },

  revokeAssistance: async (session: WebSession, operation: string) => {
    const org = await requireOrganization(session);
    return call<AssistanceGrant>(
      `/organizations/${org.organizationId}/assistance-grants/revoke`,
      { method: "POST", session, organizationId: org.organizationId, body: JSON.stringify({ operation }) },
    );
  },

  /**
   * Create an Organization with its first Owner.
   *
   * No `x-organization-id`: the caller is bringing the Organization into
   * existence, so there is nothing for the header to select among (ADR-0014).
   */
  createOrganization: (session: WebSession, name: string) =>
    call<Organization & { membershipId: string }>("/organizations", {
      method: "POST",
      session,
      withoutOrganization: true,
      body: JSON.stringify({ name }),
    }),

  acceptInvitation: (session: WebSession, token: string) =>
    call<{ organizationId: string; membershipId: string; roles: string[] }>(
      "/invitations/accept",
      {
        method: "POST",
        session,
        withoutOrganization: true,
        body: JSON.stringify({ token }),
      },
    ),

  /** The caller's own resolved principal — which Membership is acting. */
  me: (session: WebSession) =>
    call<{
      identityId: string;
      membershipId: string;
      organizationId: string;
      roles: string[];
    }>("/me", { method: "GET", session }),

  /** The caller's own notifications. There is no parameter for whose they are. */
  listNotifications: (session: WebSession) =>
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
    }>("/notifications", { method: "GET", session }),

  acknowledgeNotification: (session: WebSession, notificationId: string) =>
    call<void>(`/notifications/${notificationId}/acknowledge`, {
      method: "POST",
      session,
    }),

  listWork: (session: WebSession) =>
    call<{ items: Work[] }>("/works", { method: "GET", session }),

  getWork: (session: WebSession, workId: string) =>
    call<Work>(`/works/${workId}`, { method: "GET", session }),

  createWork: (session: WebSession, body: { title: string; description?: string }) =>
    call<Work>("/works", { method: "POST", session, body: JSON.stringify(body) }),

  startWork: (session: WebSession, workId: string) =>
    call<Work>(`/works/${workId}/start`, { method: "POST", session }),

  completeWork: (session: WebSession, workId: string, completionSummary: string) =>
    call<Work>(`/works/${workId}/complete`, {
      method: "POST",
      session,
      body: JSON.stringify({ completionSummary }),
    }),

  cancelWork: (session: WebSession, workId: string, reason: string) =>
    call<Work>(`/works/${workId}/cancel`, {
      method: "POST",
      session,
      body: JSON.stringify({ reason }),
    }),

  listDecisionsForWork: (session: WebSession, workId: string) =>
    call<{ items: Decision[] }>(`/decisions/by-work/${workId}`, {
      method: "GET",
      session,
    }),

  createDecision: (
    session: WebSession,
    body: {
      relatedWorkId: string;
      title: string;
      question: string;
      options: { optionId: string; summary: string }[];
      isBlocking: boolean;
    },
  ) => call<Decision>("/decisions", { method: "POST", session, body: JSON.stringify(body) }),

  submitDecision: (session: WebSession, decisionId: string) =>
    call<{ decision: Decision; workStatus: string }>(
      `/decisions/${decisionId}/submit`,
      { method: "POST", session },
    ),

  approveDecision: (
    session: WebSession,
    decisionId: string,
    body: { selectedOptionId: string; rationale: string },
  ) =>
    call<Decision>(`/decisions/${decisionId}/approve`, {
      method: "POST",
      session,
      body: JSON.stringify(body),
    }),

  rejectDecision: (session: WebSession, decisionId: string, rationale: string) =>
    call<Decision>(`/decisions/${decisionId}/reject`, {
      method: "POST",
      session,
      body: JSON.stringify({ rationale }),
    }),

  listMemories: (session: WebSession) =>
    call<{ items: Memory[] }>("/memories", { method: "GET", session }),

  memoryForWork: (session: WebSession, workId: string) =>
    call<{ memory: Memory | null }>(`/memories/by-work/${workId}`, {
      method: "GET",
      session,
    }),

  editMemory: (
    session: WebSession,
    memoryId: string,
    body: { title?: string; summary?: string; content?: string },
  ) =>
    call<Memory>(`/memories/${memoryId}`, {
      method: "PATCH",
      session,
      body: JSON.stringify(body),
    }),

  submitMemory: (session: WebSession, memoryId: string) =>
    call<Memory>(`/memories/${memoryId}/submit`, { method: "POST", session }),

  approveMemory: (session: WebSession, memoryId: string, note: string) =>
    call<Memory>(`/memories/${memoryId}/approve`, {
      method: "POST",
      session,
      body: JSON.stringify({ note }),
    }),

  rejectMemory: (session: WebSession, memoryId: string, note: string) =>
    call<Memory>(`/memories/${memoryId}/reject`, {
      method: "POST",
      session,
      body: JSON.stringify({ note }),
    }),

  reopenMemory: (session: WebSession, memoryId: string) =>
    call<Memory>(`/memories/${memoryId}/reopen`, { method: "POST", session }),

  startRevision: (session: WebSession, decisionId: string) =>
    call<Decision>(`/decisions/${decisionId}/revisions`, { method: "POST", session }),
};
