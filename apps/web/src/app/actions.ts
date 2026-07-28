"use server";

/**
 * Server actions.
 *
 * Each one calls the API as the currently selected development user and
 * revalidates the affected page. Errors are returned rather than thrown so the
 * page can show what the API refused and why — a 403 from an unauthorised
 * command is normal traffic here, not a crash.
 */

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ApiError, api, currentUser } from "../lib/api";

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

export const switchUser = async (formData: FormData): Promise<void> => {
  const subject = String(formData.get("subject") ?? "alice");
  const store = await cookies();
  store.set("aios_dev_subject", subject, { httpOnly: true, sameSite: "lax" });
  revalidatePath("/", "layout");
};

export const createWork = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const user = await currentUser();
  const title = String(formData.get("title") ?? "").trim();
  if (title.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A title is required." } };
  }

  const result = await run(() => api.createWork(user.subject, { title }));
  if (result.error === undefined) revalidatePath("/");
  return result;
};

export const startWork = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const user = await currentUser();
  const workId = String(formData.get("workId"));
  const result = await run(() => api.startWork(user.subject, workId));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const completeWork = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const user = await currentUser();
  const workId = String(formData.get("workId"));
  const summary = String(formData.get("completionSummary") ?? "").trim();
  if (summary.length === 0) {
    return {
      error: { code: "VALIDATION_FAILED", message: "A completion summary is required." },
    };
  }
  const result = await run(() => api.completeWork(user.subject, workId, summary));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const requestDecision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const user = await currentUser();
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
    const decision = await api.createDecision(user.subject, {
      relatedWorkId: workId,
      title: question.slice(0, 80),
      question,
      options,
      isBlocking: true,
    });
    await api.submitDecision(user.subject, decision.decisionId);
  });

  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const approveDecision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const user = await currentUser();
  const workId = String(formData.get("workId"));
  const decisionId = String(formData.get("decisionId"));
  const selectedOptionId = String(formData.get("selectedOptionId") ?? "");
  const rationale = String(formData.get("rationale") ?? "").trim();

  if (rationale.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A rationale is required." } };
  }

  const result = await run(() =>
    api.approveDecision(user.subject, decisionId, { selectedOptionId, rationale }),
  );
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const rejectDecision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const user = await currentUser();
  const workId = String(formData.get("workId"));
  const decisionId = String(formData.get("decisionId"));
  const rationale = String(formData.get("rationale") ?? "").trim();

  if (rationale.length === 0) {
    return { error: { code: "VALIDATION_FAILED", message: "A rationale is required." } };
  }

  const result = await run(() => api.rejectDecision(user.subject, decisionId, rationale));
  if (result.error === undefined) revalidatePath(`/works/${workId}`);
  return result;
};

export const startRevision = async (
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> => {
  const user = await currentUser();
  const workId = String(formData.get("workId"));
  const decisionId = String(formData.get("decisionId"));
  const result = await run(() => api.startRevision(user.subject, decisionId));
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
  subject: (await currentUser()).subject,
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
