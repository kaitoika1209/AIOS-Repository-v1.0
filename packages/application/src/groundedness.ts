/**
 * Local validation of untrusted provider output.
 *
 * ADR-0004 states that a provider response "is untrusted candidate content" and
 * "becomes meaningful only after local validation". This is that validation, and
 * it exists to preserve one specific property the deterministic generator had
 * for free: it invented nothing.
 *
 * The check is narrow on purpose. It answers exactly one question — did the
 * draft introduce a specific, checkable fact that the source does not contain? —
 * and it answers that question well. It is not a hallucination detector. A
 * fluent, plausible, entirely invented sentence containing no numbers, dates, or
 * names passes every rule here.
 *
 * That gap is closed by human approval, not by this file. Describing this as
 * catching hallucinations would encourage the misplaced trust the review gate
 * exists to prevent.
 *
 * Rules: `docs/architecture/memory-generation-policy.md` § Local Validation.
 */

import type { GeneratedContent } from "@aios/domain";

export type ViolationKind = "number" | "date" | "identifier" | "url" | "name";

export interface GroundednessViolation {
  readonly kind: ViolationKind;
  /** The token as it appeared in the draft, for the operator log. */
  readonly value: string;
}

/**
 * Markdown structure that carries no factual claim.
 *
 * Stripped before scanning, because an ordered-list marker is a `1.` that means
 * "first item", not a figure. Leaving them in would fail every draft that uses
 * a numbered list.
 */
const stripMarkdown = (text: string): string =>
  text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`~]/g, "");

/** Case-folded, punctuation-stripped, whitespace-collapsed. */
const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const MONTHS: Readonly<Record<string, string>> = {
  january: "01", jan: "01", february: "02", feb: "02", march: "03", mar: "03",
  april: "04", apr: "04", may: "05", june: "06", jun: "06", july: "07",
  jul: "07", august: "08", aug: "08", september: "09", sep: "09", sept: "09",
  october: "10", oct: "10", november: "11", nov: "11", december: "12", dec: "12",
};

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
const LONG_DATE = new RegExp(
  String.raw`\b(\d{1,2})\s+(${Object.keys(MONTHS).join("|")})\s+(\d{4})\b|` +
    String.raw`\b(${Object.keys(MONTHS).join("|")})\s+(\d{1,2}),?\s+(\d{4})\b`,
  "gi",
);

/**
 * Every date in a text, as `YYYY-MM-DD`.
 *
 * Normalizing to one representation is what lets `2026-07-29` in the source
 * satisfy `29 July 2026` in the draft — the same fact written two ways is not
 * an invention.
 */
const datesIn = (text: string): Set<string> => {
  const out = new Set<string>();

  for (const m of text.matchAll(ISO_DATE)) {
    out.add(`${m[1]}-${m[2]}-${m[3]}`);
  }
  for (const m of text.matchAll(SLASH_DATE)) {
    out.add(`${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`);
  }
  for (const m of text.matchAll(LONG_DATE)) {
    const [day, month, year] =
      m[1] !== undefined
        ? [m[1], MONTHS[m[2]!.toLowerCase()]!, m[3]!]
        : [m[5]!, MONTHS[m[4]!.toLowerCase()]!, m[6]!];
    out.add(`${year}-${month}-${day.padStart(2, "0")}`);
  }

  return out;
};

/**
 * Tokens that name a specific thing: UUIDs, issue keys, commit-like hashes,
 * handles. Anything shaped like these is checkable, so it is checked.
 */
const IDENTIFIER =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[A-Z][A-Z0-9]+-\d+\b|\b[0-9a-f]{7,40}\b|@[A-Za-z0-9_.-]{2,}/g;

/**
 * Digits, separators removed, so `1,024` and `1024` are one figure.
 *
 * No trailing `\b`: a figure is routinely written against a unit — `40ms`,
 * `3x`, `12kb` — and `\b` does not match between a digit and a letter, so
 * requiring it would silently skip exactly the figures worth checking.
 */
const NUMBER = /(?<![\d.,])\d[\d,]*(?:\.\d+)?/g;

/**
 * Runs on raw text, never on the normalized form: normalization replaces the
 * comma in `12,000` with a space, which would split one figure into `12` and
 * `000` and make a grounded draft look invented.
 */
const numbersIn = (text: string): Set<string> => {
  const scannable = text
    .replace(ISO_DATE, " ")
    .replace(SLASH_DATE, " ")
    .replace(LONG_DATE, " ")
    // Identifiers are full of digit runs. Leaving a UUID in would put `6705`
    // and `2306` into the source's figure set and quietly license a draft to
    // invent them — identifiers are checked as identifiers instead.
    .replace(IDENTIFIER, " ");
  return new Set(
    [...scannable.matchAll(NUMBER)].map((m) =>
      m[0].replace(/,/g, "").replace(/\.0+$/, ""),
    ),
  );
};

const URL = /\bhttps?:\/\/[^\s)>\]]+/g;

/**
 * Capitalized multi-word phrases, excluding sentence-initial ones.
 *
 * A capitalized word that opens a sentence is capitalized by grammar, not
 * because it names something, so including it would flag ordinary prose.
 *
 * The separator is horizontal whitespace only. Allowing `\s+` let the pattern
 * run across a line break and join the last word of a paragraph to the first
 * word of the next heading — "Friday" and "What" became the invented name
 * "Friday What". Words on different lines are not one phrase.
 */
const NAME = /(?<![.!?]\s|^)\b(\p{Lu}\p{L}+(?:[^\S\r\n]+\p{Lu}\p{L}+)+)\b/gmu;

const setOf = (text: string, pattern: RegExp): Set<string> =>
  new Set([...text.matchAll(pattern)].map((m) => (m[1] ?? m[0]).trim()));

/**
 * Whether the source contains this phrase, or every word in it.
 *
 * The word-level fallback is deliberate. Re-describing recorded facts in new
 * phrasing is exactly what a good draft does — a source saying "the payments
 * team" supports a draft saying "Payments Team". Requiring a literal match would
 * fail well-written drafts for doing their job, and a validator that rejects
 * correct output gets switched off.
 */
const supportsPhrase = (haystack: string, phrase: string): boolean => {
  const normalized = normalize(phrase);
  if (haystack.includes(normalized)) return true;
  return normalized
    .split(" ")
    .every((word) => haystack.includes(word));
};

/**
 * Check a draft against the text it was generated from.
 *
 * `source` is the canonical provider input — the exact bytes the provider was
 * shown. Checking against anything else (the live Work, a projection) would
 * make the result depend on state the provider never saw.
 */
export const checkGroundedness = (
  content: GeneratedContent,
  source: string,
): readonly GroundednessViolation[] => {
  const draft = stripMarkdown(
    [content.title, content.summary, content.content].join("\n\n"),
  );

  const haystack = normalize(source);
  const sourceDates = datesIn(source);
  const sourceNumbers = numbersIn(source);

  const violations: GroundednessViolation[] = [];
  const seen = new Set<string>();

  const flag = (kind: ViolationKind, value: string): void => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ kind, value });
  };

  for (const date of datesIn(draft)) {
    if (!sourceDates.has(date)) flag("date", date);
  }

  for (const number of numbersIn(draft)) {
    if (!sourceNumbers.has(number)) flag("number", number);
  }

  for (const identifier of setOf(draft, IDENTIFIER)) {
    if (!haystack.includes(normalize(identifier))) flag("identifier", identifier);
  }

  for (const url of setOf(draft, URL)) {
    if (!source.includes(url)) flag("url", url);
  }

  for (const name of setOf(draft, NAME)) {
    if (!supportsPhrase(haystack, name)) flag("name", name);
  }

  return violations;
};

/**
 * A provider response that cannot become a draft.
 *
 * `terminal` decides whether the operation retries. A groundedness failure and a
 * schema violation are terminal because the same input produces the same answer
 * — retrying only spends money to be told the same thing. A timeout is not.
 */
export class GenerationRejectedError extends Error {
  readonly code: string;
  readonly terminal: boolean;
  readonly violations: readonly GroundednessViolation[];

  constructor(
    code: string,
    message: string,
    terminal: boolean,
    violations: readonly GroundednessViolation[] = [],
  ) {
    super(message);
    this.name = "GenerationRejectedError";
    this.code = code;
    this.terminal = terminal;
    this.violations = violations;
  }
}

/** Raise unless every rule passes. Called before a Memory exists. */
export const requireGrounded = (
  content: GeneratedContent,
  source: string,
): void => {
  const violations = checkGroundedness(content, source);
  if (violations.length === 0) return;

  throw new GenerationRejectedError(
    "GENERATION_UNGROUNDED",
    `The generated draft asserts ${violations.length} fact(s) absent from the source: ` +
      violations.map((v) => `${v.kind} ${JSON.stringify(v.value)}`).join(", "),
    true,
    violations,
  );
};
