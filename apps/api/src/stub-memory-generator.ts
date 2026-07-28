/**
 * Deterministic Memory generator.
 *
 * Stands in for the AI generation that step 6 will specify. It produces a draft
 * from the Work's own recorded facts and nothing else, so the review flow can be
 * built and exercised before any prompt exists.
 *
 * It is deliberately *not* a fake model: it invents nothing. Everything it
 * writes is traceable to the Work, which is what makes it safe to review and
 * approve during development — approving a hallucination would corrupt exactly
 * the organizational history the product exists to protect.
 *
 * Replacing it means implementing `MemoryGenerator` against a provider. Nothing
 * else changes: the port is provider-neutral by ADR-0004.
 */

import { createHash } from "node:crypto";

import type { GeneratedContent, WorkState } from "@aios/domain";
import type { MemoryGenerator } from "@aios/application";

/**
 * Bumped whenever the generated shape changes.
 *
 * ADR-0012 requires this to be recorded with every Memory, so a reader can tell
 * which generation produced the text they are approving.
 */
export const STUB_POLICY_VERSION = 1;

const hashOf = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

export class StubMemoryGenerator implements MemoryGenerator {
  readonly policyVersion = STUB_POLICY_VERSION;

  async generate(input: {
    work: WorkState;
    sourceSnapshotId: string;
    sourceSnapshotHash: string;
  }): Promise<GeneratedContent> {
    const { work } = input;

    const lines = [
      `# ${work.title}`,
      "",
      work.description ?? "_No description was recorded._",
      "",
      "## Outcome",
      "",
      work.completionSummary ?? "_No completion summary was recorded._",
      "",
      "## What this draft is based on",
      "",
      `- Work ${work.workId}`,
      `- Completed at ${work.completedAt?.toISOString() ?? "unknown"}`,
      work.completionGate.kind === "Satisfied"
        ? `- Completion required an approved Decision (${work.completionGate.reference.decisionId})`
        : "- Completion required no Decision approval",
      "",
      "---",
      "",
      "_Generated without a language model. This draft repeats what the Work",
      "recorded and draws no conclusions; a reviewer must add the lessons._",
    ];

    const content = lines.join("\n");

    return {
      title: work.title,
      summary:
        work.completionSummary ??
        "Completed without a recorded summary.",
      content,
      sourceReferences: [
        `work:${work.workId}`,
        ...(work.completionGate.kind === "Satisfied"
          ? [`decision:${work.completionGate.reference.decisionId}`]
          : []),
      ],
      contentHash: hashOf(content),
    };
  }
}
