/**
 * The validator's job is narrow: catch a draft that asserts a specific,
 * checkable fact the source does not contain.
 *
 * These tests are written in two halves, and the second half matters as much as
 * the first. Rejecting invented facts is what the validator is for; *accepting*
 * well-written grounded prose is what keeps it switched on. A validator that
 * fails correct drafts gets disabled, and then it protects nothing.
 */

import { describe, expect, it } from "vitest";

import type { GeneratedContent } from "@aios/domain";

import { checkGroundedness, requireGrounded } from "./groundedness.js";

const SOURCE = JSON.stringify({
  workId: "6705a9ed-2306-42b3-af63-35cabd03a431",
  title: "Migrate the billing service to the new payments gateway",
  description:
    "The legacy gateway is being retired. The payments team owns the migration.",
  completionSummary:
    "Cut over 3 services on 2026-07-28. Latency dropped to 40ms.",
  completedAt: "2026-07-28T10:00:00.000Z",
});

const draft = (overrides: Partial<GeneratedContent> = {}): GeneratedContent => ({
  title: "Migrate the billing service to the new payments gateway",
  summary: "The migration completed.",
  content: "The migration completed.",
  sourceReferences: [],
  contentHash: "hash",
  ...overrides,
});

const kinds = (content: GeneratedContent): string[] =>
  checkGroundedness(content, SOURCE).map((v) => v.kind);

describe("rejecting invented facts", () => {
  it("catches a figure that is not in the source", () => {
    expect(kinds(draft({ content: "Latency dropped to 12ms." }))).toContain(
      "number",
    );
  });

  it("catches a date that is not in the source", () => {
    expect(
      kinds(draft({ content: "The cutover happened on 2026-08-15." })),
    ).toContain("date");
  });

  it("catches an invented identifier", () => {
    expect(kinds(draft({ content: "Tracked as PROJ-4417." }))).toContain(
      "identifier",
    );
  });

  it("catches an invented URL", () => {
    expect(
      kinds(draft({ content: "See https://wiki.example.test/runbook." })),
    ).toContain("url");
  });

  it("catches a name nobody mentioned", () => {
    expect(
      kinds(draft({ content: "The work was led by Dana Whitfield." })),
    ).toContain("name");
  });

  it("catches an invented fact in the summary, not only the content", () => {
    expect(kinds(draft({ summary: "9 services were migrated." }))).toContain(
      "number",
    );
  });

  it("reports each distinct invention once", () => {
    const violations = checkGroundedness(
      draft({ content: "12ms, then 12ms again, and 12ms after that." }),
      SOURCE,
    );
    expect(violations).toHaveLength(1);
  });

  it("throws a terminal rejection naming what it found", () => {
    try {
      requireGrounded(draft({ content: "Latency dropped to 12ms." }), SOURCE);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toMatchObject({
        code: "GENERATION_UNGROUNDED",
        // Terminal: the same input produces the same answer, so retrying only
        // spends money to be told the same thing.
        terminal: true,
      });
      expect((error as Error).message).toContain("12");
    }
  });
});

describe("accepting grounded prose", () => {
  it("accepts a draft that only restates the source", () => {
    expect(
      checkGroundedness(
        draft({
          content:
            "Three services were cut over on 2026-07-28. Latency dropped to 40ms.",
        }),
        SOURCE,
      ),
    ).toEqual([]);
  });

  it("accepts the same date written differently", () => {
    // Normalizing to one representation is the point: a fact written two ways
    // is not an invention.
    expect(
      kinds(draft({ content: "The cutover completed on 28 July 2026." })),
    ).not.toContain("date");
  });

  it("accepts a figure written with a thousands separator", () => {
    const source = JSON.stringify({ completionSummary: "Processed 12000 rows." });
    expect(
      checkGroundedness(draft({ content: "Processed 12,000 rows." }), source),
    ).toEqual([]);
  });

  it("accepts a capitalized rephrasing of words the source uses", () => {
    // "the payments team" in the source supports "Payments Team" in the draft.
    // Requiring a literal match would fail well-written drafts for doing their
    // job.
    expect(
      kinds(draft({ content: "Ownership sat with the Payments Team." })),
    ).not.toContain("name");
  });

  it("does not treat ordered-list markers as figures", () => {
    // A `1.` means "first item", not a quantity. Without this the validator
    // would reject every draft that uses a numbered list.
    expect(
      kinds(
        draft({
          content: "Steps taken:\n\n1. Prepared the cutover\n2. Verified latency",
        }),
      ),
    ).not.toContain("number");
  });

  it("does not flag a capitalized word that merely starts a sentence", () => {
    expect(
      kinds(draft({ content: "Latency improved. Legacy Gateway was retired." })),
    ).not.toContain("name");
  });

  it("does not join a word to the heading on the next line", () => {
    // Found by the end-to-end test, not by inspection: the last word of a
    // paragraph and the first word of the following heading were matched as one
    // phrase, so every draft ending a section on a capitalized word failed.
    expect(
      kinds(
        draft({
          content: "The cutover finished on Monday\n\n## What this is based on",
        }),
      ),
    ).not.toContain("name");
  });

  it("accepts the Work identifier the source carries", () => {
    expect(
      kinds(
        draft({
          content: "Recorded against 6705a9ed-2306-42b3-af63-35cabd03a431.",
        }),
      ),
    ).toEqual([]);
  });
});

describe("what it deliberately does not catch", () => {
  it("passes a fluent invented claim containing no checkable token", () => {
    // Documented, not accidental. This sentence is unfalsifiable by any local
    // check and may be entirely invented. Human approval is what stands
    // between it and organizational history — describing this validator as a
    // hallucination detector would encourage exactly the misplaced trust the
    // review gate exists to prevent.
    expect(
      checkGroundedness(
        draft({
          content:
            "The team considered several alternatives before proceeding, and the approach was well received.",
        }),
        SOURCE,
      ),
    ).toEqual([]);
  });
});
