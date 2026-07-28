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

export const DEV_USERS = [
  { subject: "alice", label: "Alice", role: "Member" },
  { subject: "raj", label: "Raj", role: "Reviewer" },
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
  init: RequestInit & { subject: string },
): Promise<T> => {
  const { subject, ...rest } = init;

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      "x-dev-subject": subject,
      "x-organization-id": ORGANIZATION_ID,
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

  return (await response.json()) as T;
};

export const api = {
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

  startRevision: (subject: string, decisionId: string) =>
    call<Decision>(`/decisions/${decisionId}/revisions`, { method: "POST", subject }),
};
