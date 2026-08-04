/**
 * Anthropic Memory generator — generation policy version 2 (ADR-0016).
 *
 * The prompt and schema below are the ones in
 * `docs/architecture/memory-generation-policy.md`. They are constants rather
 * than templates because ADR-0012 requires the bytes recorded in provenance to
 * be the bytes sent, and a string assembled at call time is not that.
 *
 * This adapter produces candidate content and stops. It does not validate
 * groundedness — that runs in the Application Layer, where it applies to every
 * generator rather than to whichever one remembered to call it.
 *
 * Changing anything here requires bumping `POLICY_VERSION`. A reviewer looking
 * at an old Memory needs to know which rules produced it, and a silent prompt
 * edit makes every earlier `provider_input_hash` incomparable.
 */

import Anthropic from "@anthropic-ai/sdk";

import type { GeneratedContent } from "@aios/domain";
import {
  describeError,
  getLogger,
  GenerationRejectedError,
  canonicalize,
  type MemoryGenerator,
  type ProviderInput,
} from "@aios/application";
import { createHash } from "node:crypto";

import { DeterministicMemoryGenerator } from "./deterministic-memory-generator.js";

export const POLICY_VERSION = 2;
export const PROMPT_TEMPLATE_VERSION = 1;
export const OUTPUT_SCHEMA_VERSION = 1;

export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Most of this says what *not* to do.
 *
 * The failure this policy exists to prevent is not a poorly written draft, it
 * is a plausible false one. A model asked to write a good summary will fill
 * gaps, because filling gaps is what makes prose read well — and a reviewer
 * cannot tell a filled gap from a recorded fact.
 */
export const SYSTEM_PROMPT = `You write the organization's record of a completed piece of work.

You are a secretary. You are not a participant, not a reviewer, and not an
author of opinions. A human will read what you write, correct it, and decide
whether it becomes the organization's history. Your draft is a proposal.

Write only what the source material states.

- Every fact in your output must be traceable to the source material.
- Do not add context, background, or explanation from your own knowledge.
- Do not name people, teams, systems, tools, dates, or figures that the
  source material does not name.
- Do not infer what happened between recorded facts.
- Do not evaluate whether the work was done well.
- Do not recommend follow-up work.

When the source material is thin, write a short record. A short accurate
record is correct. Padding it is not.

If the source material does not support a section, omit it rather than
writing that information was unavailable.

Write in plain past tense, in the third person, without headings in the
summary. Do not begin with "This document", "This memory", or "In summary".`;

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "content", "sourceReferences"],
  properties: {
    title: {
      type: "string",
      description:
        "A short name for this record. Reuse the Work's title unless it is uninformative.",
    },
    summary: {
      type: "string",
      description:
        "One paragraph stating what was done and what resulted. No headings, no lists.",
    },
    content: {
      type: "string",
      description: "The full record in Markdown. May use headings and lists.",
    },
    sourceReferences: {
      type: "array",
      items: { type: "string" },
      description: "Which parts of the source material this record draws on.",
    },
  },
} as const;

/** The shape the schema constrains the response to. Validated, never trusted. */
interface RawDraft {
  title: unknown;
  summary: unknown;
  content: unknown;
  sourceReferences: unknown;
}

const requireText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GenerationRejectedError(
      "GENERATION_SCHEMA_VIOLATION",
      `The provider returned no usable ${field}.`,
      // Terminal: the same input produces the same malformed answer, so a
      // retry only spends money to be told the same thing.
      true,
    );
  }
  return value;
};

/**
 * What one generation cost, and what headroom the provider reported afterwards.
 *
 * Named in AIOS terms rather than the SDK's, because this crosses out of the
 * adapter: the release-readiness document asks for cost per generation and the
 * applicable rate limits, and neither question should require the reader to know
 * which provider answered it.
 */
export interface GenerationUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * How many of `outputTokens` were internal reasoning.
   *
   * Worth reporting separately because it is billed as output and is invisible
   * in the draft: `claude-opus-5` thinks by default, so a policy that never sets
   * `thinking` still pays for it.
   */
  readonly thinkingTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheCreationInputTokens: number | null;
  /**
   * The provider's rate-limit headers, verbatim.
   *
   * Collected by pattern rather than by a fixed list of names: the question this
   * answers is "which limits apply", and a hard-coded list can only report the
   * limits that existed when it was written.
   */
  readonly rateLimits: Readonly<Record<string, string>>;
}

export interface AnthropicGeneratorOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly maxTokens?: number;
  /**
   * Observes what each call cost.
   *
   * A callback rather than a field on the returned content: `GeneratedContent`
   * is a domain type, and what a provider charged is not part of the Memory. It
   * is also where the Outbox metrics of baseline item 6 will attach.
   */
  readonly onUsage?: (usage: GenerationUsage) => void;
}

export class AnthropicMemoryGenerator implements MemoryGenerator {
  readonly policyVersion = POLICY_VERSION;
  readonly promptTemplateVersion = PROMPT_TEMPLATE_VERSION;
  readonly outputSchemaVersion = OUTPUT_SCHEMA_VERSION;
  readonly modelReference: string;

  private readonly client: Anthropic;
  private readonly maxTokens: number;
  private readonly onUsage: ((usage: GenerationUsage) => void) | undefined;

  constructor(options: AnthropicGeneratorOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.modelReference = options.model ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 8192;
    this.onUsage = options.onUsage;
  }

  async generate(input: {
    providerInput: ProviderInput;
    providerInputHash: string;
  }): Promise<GeneratedContent> {
    const { data: response, response: http } = await this.client.messages
      .create({
        model: this.modelReference,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        // Restating recorded facts accurately is not an intelligence-limited
        // task; the groundedness rules already constrain what may be said.
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            // Canonical form, so the bytes sent are the bytes hashed. Sending a
            // re-serialized object would make the recorded provider_input_hash
            // describe something the provider never saw.
            content: canonicalize(input.providerInput),
          },
        ],
      })
      // `withResponse` rather than the body alone, because the rate limits the
      // release-readiness document asks about are reported in headers and
      // nowhere else.
      .withResponse();

    // Before the outcome is judged, because a refused or truncated generation
    // costs the same as a successful one. Reporting only successes would make
    // the recorded cost per generation an underestimate by exactly the amount
    // that matters when generation starts failing.
    this.reportUsage(response, http);

    // Checked before the body is read: on a refusal `content` is empty or
    // partial, and indexing into it would throw something unrecognizable.
    if (response.stop_reason === "refusal") {
      throw new GenerationRejectedError(
        "GENERATION_REFUSED",
        "The provider declined to generate this draft.",
        // Terminal. Retrying identical input produces an identical refusal, so
        // a retry loop would spend money to be refused repeatedly.
        true,
      );
    }

    if (response.stop_reason === "max_tokens") {
      throw new GenerationRejectedError(
        "GENERATION_TRUNCATED",
        "The draft did not fit within the token budget.",
        // Not terminal: a retry may fit, and the budget is policy rather than
        // a property of the input.
        false,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let raw: RawDraft;
    try {
      raw = JSON.parse(text) as RawDraft;
    } catch {
      throw new GenerationRejectedError(
        "GENERATION_SCHEMA_VIOLATION",
        "The provider response was not valid JSON.",
        true,
      );
    }

    const title = requireText(raw.title, "title");
    const summary = requireText(raw.summary, "summary");
    const content = requireText(raw.content, "content");

    const sourceReferences = Array.isArray(raw.sourceReferences)
      ? raw.sourceReferences.filter((r): r is string => typeof r === "string")
      : [];

    return {
      title,
      summary,
      content,
      sourceReferences,
      // Computed locally rather than accepted from the provider. A hash the
      // provider supplied would attest to nothing.
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  }

  /**
   * Hands one call's cost to the observer, if there is one.
   *
   * Swallows its own failures. Nothing here is authoritative — a metrics sink
   * that throws must not turn a generated draft into a failed generation.
   */
  private reportUsage(response: Anthropic.Message, http: Response): void {
    if (this.onUsage === undefined) return;

    const rateLimits: Record<string, string> = {};
    http.headers.forEach((value, name) => {
      if (/ratelimit|retry-after/i.test(name)) rateLimits[name] = value;
    });

    try {
      this.onUsage({
        // From the response, not from `modelReference`: the two can differ when
        // an alias resolves, and provenance should record what answered.
        model: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        thinkingTokens: response.usage.output_tokens_details?.thinking_tokens ?? null,
        cacheReadInputTokens: response.usage.cache_read_input_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        rateLimits,
      });
    } catch (error) {
      getLogger().log({
        severity: "WARN",
        operationalLogName: "ai.usage_observer_failed",
        operationalLogClass: "Provider",
        operationalLogCategory: "Operations",
        message: "A usage observer threw; the generated draft is unaffected.",
        outcome: "Failure",
        attributes: describeError(error),
      });
    }
  }
}

/**
 * The generator this deployment should use.
 *
 * No credential means the deterministic generator, not a crash: the whole loop
 * must run on a machine with no provider account, and a developer who has not
 * configured one is not in an error state.
 */
export const chooseGenerator = (
  env: NodeJS.ProcessEnv,
): { generator: MemoryGenerator; reason: string } => {
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return {
      generator: new DeterministicMemoryGenerator(),
      reason: "ANTHROPIC_API_KEY is unset; using the deterministic generator",
    };
  }
  return {
    generator: new AnthropicMemoryGenerator({
      apiKey,
      ...(env["ANTHROPIC_MODEL"] === undefined
        ? {}
        : { model: env["ANTHROPIC_MODEL"] }),
    }),
    reason: `using ${env["ANTHROPIC_MODEL"] ?? DEFAULT_MODEL}`,
  };
};
