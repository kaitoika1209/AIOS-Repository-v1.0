/**
 * The provider-neutral half of the Memory generation policy.
 *
 * Implements the "Source Snapshot to Provider Input" section of
 * `docs/architecture/memory-generation-policy.md`. Everything here is
 * deterministic and provider-independent on purpose: the `provider_input_hash`
 * that ADR-0012 requires must be computable *before* any provider is chosen or
 * called, and must be identical across retries of one logical operation.
 *
 * The prompt and the model live in the adapter. The canonicalization lives here,
 * because the Application Layer needs the hash to open the durable generation
 * operation that ADR-0004 requires it to commit before the call.
 */

import { createHash } from "node:crypto";

import type { DecisionState, WorkState } from "@aios/domain";

/**
 * What the provider is shown.
 *
 * Derived only from the committed source snapshot. Deliberately narrow: every
 * field crossing this boundary is retention surface that ADR-0012 requires to
 * be erasable later, so identifiers of people are absent — the model has no use
 * for them.
 */
export interface ProviderInput {
  readonly workId: string;
  readonly title: string;
  readonly description?: string;
  readonly completionSummary?: string;
  readonly completedAt?: string;
  readonly decision?: {
    readonly decisionId: string;
    readonly question: string;
    readonly selectedOptionId?: string;
    readonly rationale?: string;
  };
}

const omitEmpty = (value: string | null | undefined): string | undefined =>
  value === null || value === undefined || value.trim().length === 0
    ? undefined
    : value;

/**
 * Build the provider input for a completed Work.
 *
 * `decision` is present only when the completion gate was satisfied — that is
 * the one case where an approved Decision is part of why the Work completed.
 * The Decision is passed in rather than loaded here: Work never reads the
 * Decision Aggregate, and the caller already holds the submitted snapshot.
 */
export const buildProviderInput = (
  work: WorkState,
  decision: DecisionState | null,
): ProviderInput => {
  const base: ProviderInput = {
    workId: work.workId,
    title: work.title,
    ...(omitEmpty(work.description) === undefined
      ? {}
      : { description: work.description! }),
    ...(omitEmpty(work.completionSummary) === undefined
      ? {}
      : { completionSummary: work.completionSummary! }),
    ...(work.completedAt === null
      ? {}
      : { completedAt: work.completedAt.toISOString() }),
  };

  if (work.completionGate.kind !== "Satisfied" || decision === null) {
    return base;
  }

  // The revision Work's gate points at, not whatever revision is current now.
  // A later revision would describe a different decision than the one that
  // unblocked this Work.
  const submittedId = work.completionGate.reference.submittedSnapshotId;
  const revision = decision.revisions.find((r) => r.revisionId === submittedId);
  const review = decision.reviewRecords.find(
    (r) => r.revisionId === submittedId && r.outcome === "Approved",
  );

  if (revision === undefined) {
    return base;
  }

  return {
    ...base,
    decision: {
      decisionId: decision.decisionId,
      question: revision.question,
      ...(review?.selectedOptionId == null
        ? {}
        : { selectedOptionId: review.selectedOptionId }),
      ...(omitEmpty(review?.rationale) === undefined
        ? {}
        : { rationale: review!.rationale! }),
    },
  };
};

/**
 * Canonical JSON: sorted keys, no insignificant whitespace, absent fields
 * omitted rather than emitted as null.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * inputs built by different code paths would otherwise hash differently. This
 * is the whole reason a retry can reuse `provider_input_hash`.
 */
export const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(",")}}`;
};

export const providerInputHash = (input: ProviderInput): string =>
  createHash("sha256").update(canonicalize(input)).digest("hex");
