"use server";

/**
 * Server actions.
 *
 * Each one resolves the signed-in session first — a server action is a POST
 * endpoint anyone who knows its identifier can call directly, without ever
 * rendering the page that contains its form, so gating only the pages would
 * leave every command reachable by an unauthenticated caller. Then it calls the
 * API as that session and
 * revalidates the affected page. Errors are returned rather than thrown so the
 * page can show what the API refused and why — a 403 from an unauthorised
 * command is normal traffic here, not a crash.
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ApiError, ORGANIZATION_COOKIE, api } from "../lib/api";
import {
  DEV_SUBJECT_COOKIE,
  DEV_USERS,
  chooseSessionProvider,
  requireSession,
} from "../lib/session";

export interface ActionResult {
  error?: { code: string; message: string };
}

const run = async (fn: () => Promise<unknown>): Promise<ActionResult> => {
  try {
    await fn();
    return {};
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: { code: error.code, message: error.message } };
    }
    throw error;
  }
};

/**
 * Sign in as one of the development identities.
 *
 * The old `switchUser`, moved out of the global header and onto the sign-in
 * page, and no longer able to make you someone else from wherever you happen to
 * be standing.
 *
 * It refuses outside development, twice over. `chooseSessionProvider` throws
 * when the development adapter is not permitted, and the subject is checked
 * against the declared list rather than written through — the cookie could
 * otherwise carry any string, and the API's development adapter would create an
 * Identity for it on first invitation acceptance.
 */
export const signInAsDevelopmentUser = async (formData: FormData): Promise<void> => {
  const choice = chooseSessionProvider(process.env);
  if (choice.provider !== "dev") {
    throw new Error("Development sign-in is not available with a real session provider.");
  }

  const requested = String(formData.get("subject") ?? "");
  const user = DEV_USERS.find((u) => u.subject === requested);
  if (user === undefined) {
    throw new Error("Unknown development identity.");
  }

  const store = await cookies();
  store.set(DEV_SUBJECT_COOKIE, user.subject, { httpOnly: true, sameSite: "lax" });
  // The Organization preference belongs to the previous person. Left in place it
  // would name an Organization the new one may not belong to — harmless, since
  // the client validates it against their real Memberships, but it would silently
  // land them somewhere they did not choose.
  store.delete(ORGANIZATION_COOKIE);
  revalidatePath("/", "layout");
  redirect("/");
};

/**
 * Sign out.
 *
 * Clears this client's own state and nothing else. With Clerk, ending the
 * *provider's* session is Clerk's business and happens at its sign-out URL —
 * a client that deleted its cookie and called that done would leave a live
 * session behind on a shared machine.
 */
export const signOut = async (): Promise<void> => {
  const store = await cookies();
  store.delete(DEV_SUBJECT_COOKIE);
  store.delete(ORGANIZATION_COOKIE);
  revalidatePath("/", "layout");

  const signOutUrl = process.env["NEXT_PUBLIC_CLERK_SIGN_OUT_URL"] ?? "";
  redirect(signOutUrl === "" ? "/sign-in" : signOutUrl);
};

/**
 * Choose which Organization to act in.
 *
 * The cookie is a preference and is validated against the caller's real
 * Memberships on read — see `currentOrganization`. Nothing here needs to check
 * it, and nothing here should: a check in the setter would look like the
 * security boundary while the real one is elsewhere.
 */
export const switchOrganization = async (formData: FormData): Promise<void> => {
  const organizationId = String(formData.get("organizationId") ?? "");
  const store = await cookies();
  store.set(ORGANIZATION_COOKIE, organizationId, { httpOnly: true, sameSite: "lax" });
  revalidatePath("/", "layout");
};

/**
 * Create an Organization and switch into it.
 *
 * `POST /organizations` needs no Organization context and no permission — the
 * caller is bringing one into existence (ADR-0014). Switching afterwards is the
 * obvious thing to want, and doing it here saves a second deliberate step.
 */
export const createOrganization = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A name is required." } };
  }

  try {
    const created = await api.createOrganization(session, name);
    const store = await cookies();
    store.set(ORGANIZATION_COOKIE, created.organizationId, {
      httpOnly: true,
      sameSite: "lax",
    });
    revalidatePath("/", "layout");
    return {};
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: { code: error.code, message: error.message } };
    }
    throw error;
  }
};

export const createWork = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const title = String(formData.get("title") ?? "").trim();
  if (title.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A title is required." } };
  }

  const result = await run(() => api.createWork(session, { title }));
  if (result.error === undefined) revalidatePath("/");
  return result;
};

export const startWork = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const workId = String(formData.get("workId"));
  const result = await run(() => api.startWork(session, workId));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const completeWork = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const workId = String(formData.get("workId"));
  const summary = String(formData.get("completionSummary") ?? "").trim();
  if (summary.length === 0) {
    return {
      error: { code: "VALIDATION_FAILED", message: "A completion summary is required." },
    };
  }
  const result = await run(() => api.completeWork(session, workId, summary));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const requestDecision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const workId = String(formData.get("workId"));
  const question = String(formData.get("question") ?? "").trim();
  const optionsRaw = String(formData.get("options") ?? "").trim();

  if (question.length === 0 || optionsRaw.length === 0) {
    return {
      error: { code: "VALIDATION_FAILED", message: "A question and options are required." },
    };
  }

  const options = optionsRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((summary, index) => ({ optionId: `opt-${index + 1}`, summary }));

  // Create then submit: submission is what blocks the Work (ADR-0007).
  const result = await run(async () => {
    const decision = await api.createDecision(session, {
      relatedWorkId: workId,
      title: question.slice(0, 80),
      question,
      options,
      isBlocking: true,
    });
    await api.submitDecision(session, decision.decisionId);
  });

  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const approveDecision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const workId = String(formData.get("workId"));
  const decisionId = String(formData.get("decisionId"));
  const selectedOptionId = String(formData.get("selectedOptionId") ?? "");
  const rationale = String(formData.get("rationale") ?? "").trim();

  if (rationale.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A rationale is required." } };
  }

  const result = await run(() =>
    api.approveDecision(session, decisionId, { selectedOptionId, rationale }),
  );
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const rejectDecision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const workId = String(formData.get("workId"));
  const decisionId = String(formData.get("decisionId"));
  const rationale = String(formData.get("rationale") ?? "").trim();

  if (rationale.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A rationale is required." } };
  }

  const result = await run(() => api.rejectDecision(session, decisionId, rationale));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const startRevision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const workId = String(formData.get("workId"));
  const decisionId = String(formData.get("decisionId"));
  const result = await run(() => api.startRevision(session, decisionId));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const openWork = async (formData: FormData): Promise<void> => {
  redirect(`/works/${String(formData.get("workId"))}`);
};

/**
 * Memory review actions.
 *
 * Written out rather than produced by a factory: a "use server" module may only
 * export async functions, so a returned closure is rejected at build time.
 */
const memoryContext = async (formData: FormData) => ({
  subject: await requireSession(),
  workId: String(formData.get("workId")),
  memoryId: String(formData.get("memoryId")),
  note: String(formData.get("note") ?? "").trim(),
});

export const editMemory = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { subject, workId, memoryId } = await memoryContext(formData);
  const summary = String(formData.get("summary") ?? "").trim();

  if (summary.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A summary is required." } };
  }

  const result = await run(() => api.editMemory(subject, memoryId, { summary }));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const submitMemory = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { subject, workId, memoryId } = await memoryContext(formData);
  const result = await run(() => api.submitMemory(subject, memoryId));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const approveMemory = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { subject, workId, memoryId, note } = await memoryContext(formData);
  const result = await run(() => api.approveMemory(subject, memoryId, note));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const rejectMemory = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { subject, workId, memoryId, note } = await memoryContext(formData);
  if (note.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A note is required." } };
  }
  const result = await run(() => api.rejectMemory(subject, memoryId, note));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const reopenMemory = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { subject, workId, memoryId } = await memoryContext(formData);
  const result = await run(() => api.reopenMemory(subject, memoryId));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

/**
 * Invitation actions.
 *
 * The issued token is put in a cookie rather than returned through
 * `ActionResult`, because `revalidatePath` re-renders the page and the value has
 * to survive that. It is short-lived and read once by the members page, which is
 * as close as this gets to "the invitee received an email" — the
 * `MembershipInvited` delivery consumer is not in this release.
 */
const ISSUED_TOKEN_COOKIE = "aios_dev_last_invitation";

export const inviteMember = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "Member");

  if (email.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "An email address is required." } };
  }

  try {
    const invitation = await api.inviteMember(session, { email, roles: [role] });
    const store = await cookies();
    store.set(ISSUED_TOKEN_COOKIE, JSON.stringify(invitation), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
    });
    revalidatePath("/members");
    return {};
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: { code: error.code, message: error.message } };
    }
    throw error;
  }
};

export const resendInvitation = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const membershipId = String(formData.get("membershipId"));

  try {
    const invitation = await api.resendInvitation(session, membershipId);
    const store = await cookies();
    store.set(ISSUED_TOKEN_COOKIE, JSON.stringify(invitation), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
    });
    revalidatePath("/members");
    return {};
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: { code: error.code, message: error.message } };
    }
    throw error;
  }
};

export const revokeInvitation = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const membershipId = String(formData.get("membershipId"));
  const reason = String(formData.get("reason") ?? "").trim();

  if (reason.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A reason is required." } };
  }

  const result = await run(() =>
    api.revokeInvitation(session, membershipId, reason),
  );
  if (result.error === undefined) revalidatePath("/members");
  return result;
};

/**
 * Member administration.
 *
 * Every one of these requires a reason, because every underlying command does:
 * an authority change that nobody wrote a reason for leaves the audit able to
 * say what happened and not why.
 */
const memberContext = async (formData: FormData) => ({
  session: await requireSession(),
  membershipId: String(formData.get("membershipId")),
  reason: String(formData.get("reason") ?? "").trim(),
});

const requireReason = (reason: string): ActionResult | null =>
  reason.length === 0
    ? { error: { code: "VALIDATION_FAILED", message: "A reason is required." } }
    : null;

export const suspendMember = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { session, membershipId, reason } = await memberContext(formData);
  const missing = requireReason(reason);
  if (missing !== null) return missing;

  const result = await run(() => api.suspendMember(session, membershipId, reason));
  if (result.error === undefined) revalidatePath("/members");
  return result;
};

export const reactivateMember = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { session, membershipId, reason } = await memberContext(formData);
  const missing = requireReason(reason);
  if (missing !== null) return missing;

  const result = await run(() =>
    api.reactivateMember(session, membershipId, reason),
  );
  if (result.error === undefined) revalidatePath("/members");
  return result;
};

export const revokeMember = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { session, membershipId, reason } = await memberContext(formData);
  const missing = requireReason(reason);
  if (missing !== null) return missing;

  const result = await run(() => api.revokeMember(session, membershipId, reason));
  if (result.error === undefined) revalidatePath("/members");
  return result;
};

export const assignRole = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const result = await run(() =>
    api.assignRole(
      session,
      String(formData.get("membershipId")),
      String(formData.get("role")),
    ),
  );
  if (result.error === undefined) revalidatePath("/members");
  return result;
};

export const revokeRole = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const { session, membershipId, reason } = await memberContext(formData);
  const missing = requireReason(reason);
  if (missing !== null) return missing;

  const result = await run(() =>
    api.revokeRole(session, membershipId, String(formData.get("role")), reason),
  );
  if (result.error === undefined) revalidatePath("/members");
  return result;
};

/**
 * Organization settings.
 *
 * Suspension and archival ask the caller to retype the Organization's name.
 * Both take an Organization away from everyone in it — suspension until an Owner
 * reverses it, archival for good — and a button that does that on one click is
 * a button someone will press by accident.
 */
export const renameOrganization = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A name is required." } };
  }

  const result = await run(() => api.renameOrganization(session, name));
  if (result.error === undefined) revalidatePath("/settings");
  return result;
};

const confirmedName = (formData: FormData): string =>
  String(formData.get("confirmName") ?? "").trim();

export const suspendOrganization = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const reason = String(formData.get("reason") ?? "").trim();
  const missing = requireReason(reason);
  if (missing !== null) return missing;
  if (confirmedName(formData) !== String(formData.get("expectedName"))) {
    return {
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "Type the Organization's name exactly to confirm.",
      },
    };
  }

  const result = await run(() => api.suspendOrganization(session, reason));
  if (result.error === undefined) revalidatePath("/settings");
  return result;
};

export const reactivateOrganization = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const reason = String(formData.get("reason") ?? "").trim();
  const missing = requireReason(reason);
  if (missing !== null) return missing;

  // No retyping here. Reactivation is the way back, and putting an obstacle in
  // front of recovery is the wrong place for one.
  const result = await run(() => api.reactivateOrganization(session, reason));
  if (result.error === undefined) revalidatePath("/settings");
  return result;
};

export const archiveOrganization = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const reason = String(formData.get("reason") ?? "").trim();
  const missing = requireReason(reason);
  if (missing !== null) return missing;
  if (confirmedName(formData) !== String(formData.get("expectedName"))) {
    return {
      error: {
        code: "CONFIRMATION_REQUIRED",
        message: "Type the Organization's name exactly to confirm.",
      },
    };
  }

  const result = await run(() => api.archiveOrganization(session, reason));
  if (result.error === undefined) revalidatePath("/settings");
  return result;
};

export const grantAssistance = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const result = await run(() =>
    api.grantAssistance(
      session,
      String(formData.get("operation")),
      "Enabled from Organization settings.",
    ),
  );
  if (result.error === undefined) revalidatePath("/settings");
  return result;
};

export const revokeAssistance = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const result = await run(() =>
    api.revokeAssistance(session, String(formData.get("operation"))),
  );
  if (result.error === undefined) revalidatePath("/settings");
  return result;
};

export const acceptInvitation = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const token = String(formData.get("token") ?? "").trim();

  if (token.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A token is required." } };
  }

  const result = await run(() => api.acceptInvitation(session, token));
  if (result.error === undefined) {
    const store = await cookies();
    store.delete(ISSUED_TOKEN_COOKIE);
    revalidatePath("/", "layout");
  }
  return result;
};

/** The token issued by the most recent invitation, if it is still in the cookie. */
export const lastIssuedInvitation = async (): Promise<{
  membershipId: string;
  email: string | null;
  token: string;
} | null> => {
  const store = await cookies();
  const raw = store.get(ISSUED_TOKEN_COOKIE)?.value;
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as { membershipId: string; email: string | null; token: string };
  } catch {
    return null;
  }
};

export const acknowledgeNotification = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const session = await requireSession();
  const notificationId = String(formData.get("notificationId"));

  const result = await run(() =>
    api.acknowledgeNotification(session, notificationId),
  );
  // The layout carries the unacknowledged count, so it has to be revalidated
  // too or the badge keeps showing an item the list no longer highlights.
  if (result.error === undefined) revalidatePath("/", "layout");
  return result;
};
