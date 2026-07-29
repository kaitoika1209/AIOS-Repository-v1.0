/**
 * Live evaluation of the Memory generation policy.
 *
 *     ANTHROPIC_API_KEY=... pnpm --filter @aios/api evaluate
 *
 * Runs the real provider against the cases in
 * `docs/architecture/memory-generation-policy.md` § Evaluation and reports what
 * came back. It is **not** a gate on merge — the fixture suite in
 * `@aios/application` is what runs in CI, on machines with no credential.
 *
 * This is how the prompt is developed, and how a policy version is justified
 * before being pinned. Per the policy, a change to any element of it requires a
 * live run recorded in the pull request that bumps the version.
 *
 * Nothing here writes to the database. Evaluation observes the generator; it
 * does not create Memories.
 */

import {
  canonicalize,
  checkGroundedness,
  type ProviderInput,
} from "@aios/application";

import { AnthropicMemoryGenerator, DEFAULT_MODEL } from "./anthropic-memory-generator.js";

interface Case {
  readonly name: string;
  readonly input: ProviderInput;
  /** What a human reading the draft should be able to confirm. */
  readonly expect: string;
}

const CASES: readonly Case[] = [
  {
    name: "ordinary completed Work",
    input: {
      workId: "6705a9ed-2306-42b3-af63-35cabd03a431",
      title: "Migrate the billing service to the new payments gateway",
      description:
        "The legacy gateway is being retired at the end of the quarter. The payments team owns the migration.",
      completionSummary:
        "Cut over 3 services on 2026-07-28. Latency dropped to 40ms. One rollback was needed for the invoicing service.",
      completedAt: "2026-07-28T10:00:00.000Z",
    },
    expect: "Reports the cutover, the rollback, and the latency, and adds nothing else.",
  },
  {
    name: "completed Work with an approved Decision",
    input: {
      workId: "b1c2d3e4-0000-4000-8000-000000000001",
      title: "Choose a queue for the notification pipeline",
      description: "Notifications are dropped under load.",
      completionSummary: "Implemented the chosen queue and drained the backlog.",
      completedAt: "2026-07-20T09:30:00.000Z",
      decision: {
        decisionId: "d4c3b2a1-0000-4000-8000-000000000002",
        question: "Which queue should the notification pipeline use?",
        selectedOptionId: "option-managed",
        rationale:
          "The managed queue removes the operational burden, and the cost difference is small at current volume.",
      },
    },
    expect: "Records what was decided and why, without arguing for or against it.",
  },
  {
    name: "thin source material",
    input: {
      workId: "c0ffee00-0000-4000-8000-000000000003",
      title: "Fix the typo on the pricing page",
      completionSummary: "Fixed.",
      completedAt: "2026-07-25T14:00:00.000Z",
    },
    // The interesting case. A model asked to write a good summary will pad
    // this; the policy says a short accurate record is correct.
    expect: "Stays short. Does not invent context, impact, or follow-up work.",
  },
  {
    name: "no completion summary",
    input: {
      workId: "0000dead-0000-4000-8000-000000000004",
      title: "Investigate intermittent test failures",
      description: "CI has been flaky for two weeks.",
      completedAt: "2026-07-26T16:45:00.000Z",
    },
    expect: "Does not invent an outcome that was never recorded.",
  },
];

const main = async (): Promise<void> => {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.error(
      "ANTHROPIC_API_KEY is required. This is the live half of evaluation;\n" +
        "the fixture half runs in CI with `pnpm --filter @aios/application test`.",
    );
    process.exit(1);
  }

  const model = process.env["ANTHROPIC_MODEL"] ?? DEFAULT_MODEL;
  const generator = new AnthropicMemoryGenerator({ apiKey, model });

  console.log(`Model: ${model}`);
  console.log(`Policy version: ${generator.policyVersion}\n`);

  let grounded = 0;
  let failed = 0;

  for (const testCase of CASES) {
    const source = canonicalize(testCase.input);
    console.log("─".repeat(72));
    console.log(`CASE  ${testCase.name}`);
    console.log(`WANT  ${testCase.expect}\n`);

    try {
      const content = await generator.generate({
        providerInput: testCase.input,
        providerInputHash: "evaluation",
      });

      const violations = checkGroundedness(content, source);
      if (violations.length === 0) {
        grounded += 1;
        console.log("GROUNDED  yes");
      } else {
        failed += 1;
        console.log("GROUNDED  no");
        for (const violation of violations) {
          console.log(`          ${violation.kind}: ${violation.value}`);
        }
      }

      console.log(`\nTITLE     ${content.title}`);
      console.log(`SUMMARY   ${content.summary}`);
      console.log(`LENGTH    ${content.content.length} characters\n`);
      console.log(content.content);
      console.log();
    } catch (error) {
      failed += 1;
      console.log(`REJECTED  ${(error as Error).message}\n`);
    }
  }

  console.log("─".repeat(72));
  console.log(`${grounded} grounded, ${failed} rejected, of ${CASES.length}`);

  // Judgement is the reader's. Groundedness is mechanical and reported above;
  // whether a draft is fair, complete, and appropriately brief is not something
  // this script can decide, and pretending otherwise would make the number look
  // like a verdict.
  console.log("\nRead the drafts. Groundedness is checked; judgement is not.");
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
