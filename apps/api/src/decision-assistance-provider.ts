/**
 * Secretary Runtime adapter for Decision assistance (ADR-0011).
 *
 * An adapter, not a domain owner. It receives the request the Decision context
 * chose to send and returns text; it holds no repository, no Aggregate, and no
 * way to ask for more than it was given.
 *
 * Two implementations, chosen at the edge exactly as Memory generation is: a
 * deterministic one so the flow runs with no provider account, and Anthropic
 * when a key is present.
 */

import Anthropic from "@anthropic-ai/sdk";

import type {
  DecisionAssistanceProvider,
  DecisionMaterialDraft,
  DecisionMaterialRequest,
} from "@aios/application";

/** The Secretary that produces Decision material. One per Organization. */
export const SECRETARY_PRINCIPAL_ID = "decision-secretary";

/**
 * Deliberately plain, and permanently retained.
 *
 * Restates the question and options as material a reviewer can read, inventing
 * nothing. That is what makes it a usable stand-in: the flow it exercises is the
 * authorization and recording path, not the wording.
 */
export class DeterministicDecisionAssistanceProvider
  implements DecisionAssistanceProvider
{
  readonly secretaryPrincipalId = SECRETARY_PRINCIPAL_ID;

  async draftMaterial(
    request: DecisionMaterialRequest,
  ): Promise<DecisionMaterialDraft> {
    const options = request.options
      .map((o, i) => `${i + 1}. ${o.summary} (${o.optionId})`)
      .join("\n");

    return {
      content: [
        `Question: ${request.question}`,
        request.context === null ? null : `Context: ${request.context}`,
        "",
        "Options under consideration:",
        options.length === 0 ? "(none recorded yet)" : options,
        "",
        "This material restates what the Decision records. A reviewer still has to decide.",
      ]
        .filter((line) => line !== null)
        .join("\n"),
    };
  }
}

const SYSTEM_PROMPT = `You prepare material for a human decision inside an organization.

Restate and organize only what the request contains. Do not invent facts, figures, dates, names, or options that are not present. Do not recommend an option, state a conclusion, or express a preference — a human decides, and material that argues for an answer displaces that judgement.

Write plain prose and short lists. Be brief.`;

export class AnthropicDecisionAssistanceProvider
  implements DecisionAssistanceProvider
{
  readonly secretaryPrincipalId = SECRETARY_PRINCIPAL_ID;

  constructor(
    private readonly client: Anthropic,
    private readonly model = "claude-opus-5",
  ) {}

  async draftMaterial(
    request: DecisionMaterialRequest,
  ): Promise<DecisionMaterialDraft> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          // The canonical request, serialized. Nothing beyond what the port sent.
          content: JSON.stringify(request, null, 2),
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      // Terminal. Retrying identical input produces an identical refusal, and
      // the Decision context treats an empty draft as a failed attempt.
      return { content: "" };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return { content: text };
  }
}

export const chooseDecisionAssistanceProvider = (
  env: NodeJS.ProcessEnv,
): { provider: DecisionAssistanceProvider; reason: string } => {
  const key = env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.length === 0) {
    return {
      provider: new DeterministicDecisionAssistanceProvider(),
      reason: "ANTHROPIC_API_KEY is unset; using the deterministic provider",
    };
  }
  return {
    provider: new AnthropicDecisionAssistanceProvider(new Anthropic({ apiKey: key })),
    reason: "Anthropic",
  };
};
