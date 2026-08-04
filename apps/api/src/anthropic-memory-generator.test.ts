/**
 * What a generation costs, and what limits applied.
 *
 * The release-readiness document asks Stage A3 to "establish cost per
 * generation and the provider rate limits that apply". Until the generator
 * reported `usage`, that question had no answer available anywhere in this
 * repository — a live run would have produced drafts and no cost.
 *
 * These tests run against a local HTTP server rather than the provider, so the
 * reporting path is exercised on a machine with no credential. What they cannot
 * check is whether the real API sends the fields assumed here; that is what the
 * live evaluation run is for.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnthropicMemoryGenerator,
  type GenerationUsage,
} from "./anthropic-memory-generator.js";

/** A well-formed Messages response carrying a draft the policy would accept. */
const messageBody = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  stop_reason: "end_turn",
  content: [
    {
      type: "text",
      text: JSON.stringify({
        title: "Migrated the billing service",
        summary: "The cutover completed on 2026-07-28.",
        content: "The cutover completed on 2026-07-28.",
        sourceReferences: ["completionSummary"],
      }),
    },
  ],
  usage: {
    input_tokens: 1200,
    output_tokens: 800,
    output_tokens_details: { thinking_tokens: 500 },
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  },
  ...overrides,
});

let server: Server;
let baseUrl: string;
/** Set per test to control what the stub returns. */
let respond: () => { status: number; headers: Record<string, string>; body: unknown };

beforeEach(async () => {
  respond = () => ({
    status: 200,
    headers: {
      "anthropic-ratelimit-requests-remaining": "49",
      "anthropic-ratelimit-input-tokens-remaining": "39800",
      "anthropic-ratelimit-requests-reset": "2026-08-04T12:00:00Z",
      // Present to prove the filter is a filter: this must not be reported.
      "content-type": "application/json",
      "request-id": "req_test",
    },
    body: messageBody(),
  });

  server = createServer((_req, res) => {
    const { status, headers, body } = respond();
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env["ANTHROPIC_BASE_URL"] = baseUrl;
});

afterEach(async () => {
  delete process.env["ANTHROPIC_BASE_URL"];
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const providerInput = {
  workId: "6705a9ed-2306-42b3-af63-35cabd03a431",
  title: "Migrate the billing service",
  completionSummary: "Cut over on 2026-07-28.",
  completedAt: "2026-07-28T10:00:00.000Z",
};

const generateWith = async (
  onUsage: (usage: GenerationUsage) => void,
): Promise<unknown> => {
  const generator = new AnthropicMemoryGenerator({ apiKey: "test-key", onUsage });
  return generator.generate({ providerInput, providerInputHash: "test" });
};

describe("reporting what a generation cost", () => {
  it("reports the token counts the provider billed", async () => {
    const seen: GenerationUsage[] = [];
    await generateWith((usage) => seen.push(usage));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.inputTokens).toBe(1200);
    expect(seen[0]?.outputTokens).toBe(800);
  });

  it("separates internal reasoning from the rest of the output", async () => {
    // Billed as output and absent from the draft. `claude-opus-5` thinks by
    // default and the generation policy sets no `thinking`, so a cost estimate
    // that assumed output tokens meant written words would be wrong here by
    // more than half.
    const seen: GenerationUsage[] = [];
    await generateWith((usage) => seen.push(usage));

    expect(seen[0]?.thinkingTokens).toBe(500);
  });

  it("records the model that answered, not the one that was asked for", async () => {
    respond = () => ({
      status: 200,
      headers: {},
      body: messageBody({ model: "claude-opus-5-20260601" }),
    });

    const seen: GenerationUsage[] = [];
    await generateWith((usage) => seen.push(usage));

    expect(seen[0]?.model).toBe("claude-opus-5-20260601");
  });

  it("collects the rate-limit headers and nothing else", async () => {
    const seen: GenerationUsage[] = [];
    await generateWith((usage) => seen.push(usage));

    const limits = seen[0]?.rateLimits ?? {};
    expect(limits["anthropic-ratelimit-requests-remaining"]).toBe("49");
    expect(limits["anthropic-ratelimit-input-tokens-remaining"]).toBe("39800");
    // A header dump would be a privacy and noise problem, and would bury the
    // three values the question is actually about.
    expect(limits["content-type"]).toBeUndefined();
    expect(limits["request-id"]).toBeUndefined();
  });

  it("reports the cost of a rejected generation too", async () => {
    // The failure that makes this matter: generation starts being refused, the
    // spend continues, and a cost report built only from successes shows it
    // falling.
    respond = () => ({
      status: 200,
      headers: {},
      body: messageBody({ stop_reason: "refusal", content: [] }),
    });

    const seen: GenerationUsage[] = [];
    await expect(generateWith((usage) => seen.push(usage))).rejects.toThrow();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.outputTokens).toBe(800);
  });

  it("does not let a failing observer destroy a generated draft", async () => {
    // Cost accounting is not authoritative. A metrics sink that throws must not
    // turn a valid Memory draft into a failed generation.
    const content = await generateWith(() => {
      throw new Error("metrics sink is down");
    });

    expect(content).toMatchObject({ title: "Migrated the billing service" });
  });

  it("costs nothing to observe when no observer is given", async () => {
    const generator = new AnthropicMemoryGenerator({ apiKey: "test-key" });
    await expect(
      generator.generate({ providerInput, providerInputHash: "test" }),
    ).resolves.toMatchObject({ title: "Migrated the billing service" });
  });
});
