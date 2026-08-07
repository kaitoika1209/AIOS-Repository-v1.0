/**
 * Deterministic, language-agnostic structure of a post's text.
 *
 * These traits are what the pattern analyzer compares across a cohort, so they
 * are kept mechanical on purpose: no model call, no judgement, fully testable.
 */

export type TraitName =
  | 'hasQuestion'
  | 'hasNumber'
  | 'opensWithNumber'
  | 'hasList'
  | 'hasLineBreaks'
  | 'hasEmoji'
  | 'hasHashtag'
  | 'hasMention'
  | 'hasUrl'
  | 'hasCallToAction'
  | 'hasColonHook'
  | 'isShort'
  | 'isLong';

export const TRAIT_LABELS: Record<TraitName, string> = {
  hasQuestion: 'Asks a question',
  hasNumber: 'Contains a number',
  opensWithNumber: 'Opens with a number',
  hasList: 'Uses a list or bullets',
  hasLineBreaks: 'Broken across multiple lines',
  hasEmoji: 'Uses emoji',
  hasHashtag: 'Uses a hashtag',
  hasMention: 'Mentions another account',
  hasUrl: 'Links out',
  hasCallToAction: 'Ends on a call to action',
  hasColonHook: 'Uses a "label: payoff" hook',
  isShort: 'Short (under 60 weighted characters)',
  isLong: 'Long (over 200 weighted characters)',
};

/** X counts most characters as 1 and everything outside these ranges as 2. */
const SINGLE_WEIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

export const POST_WEIGHTED_LENGTH_LIMIT = 280;

const SHORT_POST_THRESHOLD = 60;
const LONG_POST_THRESHOLD = 200;

const LIST_MARKER = /^\s*(?:[-–—*•・▪◆▶‣>]|[0-9０-９]+[.)、．]|[①-⑳]|[✅✔☑🔹🔸👉])\s*\S/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const HASHTAG = /(?:^|\s)[#＃][^\s#＃]+/u;
const MENTION = /(?:^|\s)[@＠][A-Za-z0-9_]{1,15}/u;
const URL = /https?:\/\/\S+/iu;
const QUESTION = /[?？]/u;
const NUMBER = /[0-9０-９]/u;
const COLON_HOOK = /^[^\n]{1,24}[:：]\s*\S/u;

/**
 * Phrases that ask the reader to do something. Japanese and English are both
 * covered because a Japanese account's reference set often mixes the two.
 */
const CALL_TO_ACTION = [
  'リプ',
  'コメント',
  'フォロー',
  '保存',
  'ブックマーク',
  'リポスト',
  'リツイート',
  'いいね',
  '詳しくは',
  '詳細は',
  '続きは',
  'プロフ',
  '教えて',
  'ぜひ',
  'follow me',
  'follow for',
  'retweet',
  'repost this',
  'comment below',
  'link in bio',
  'save this',
  'share this',
  'let me know',
  'drop a',
];

export interface PostStructure {
  readonly weightedLength: number;
  readonly characterCount: number;
  readonly lineCount: number;
  readonly paragraphCount: number;
  readonly openingLine: string;
  readonly hashtagCount: number;
  readonly traits: Readonly<Record<TraitName, boolean>>;
}

/**
 * Length as X itself counts it: CJK and emoji cost two units, so a 140-character
 * Japanese post is already at the 280 limit.
 */
export function weightedLengthOf(text: string): number {
  let total = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    total += SINGLE_WEIGHT_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? 1 : 2;
  }
  return total;
}

export function analyzeStructure(text: string): PostStructure {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  const openingLine = nonEmptyLines[0]?.trim() ?? '';
  const weightedLength = weightedLengthOf(normalized);
  const lowerCased = normalized.toLowerCase();

  const traits: Record<TraitName, boolean> = {
    hasQuestion: QUESTION.test(normalized),
    hasNumber: NUMBER.test(normalized),
    opensWithNumber: NUMBER.test(openingLine),
    hasList: nonEmptyLines.filter((line) => LIST_MARKER.test(line)).length >= 2,
    hasLineBreaks: nonEmptyLines.length > 1,
    hasEmoji: EMOJI.test(normalized),
    hasHashtag: HASHTAG.test(normalized),
    hasMention: MENTION.test(normalized),
    hasUrl: URL.test(normalized),
    hasCallToAction: CALL_TO_ACTION.some((phrase) => lowerCased.includes(phrase.toLowerCase())),
    hasColonHook: COLON_HOOK.test(openingLine),
    isShort: weightedLength < SHORT_POST_THRESHOLD,
    isLong: weightedLength > LONG_POST_THRESHOLD,
  };

  return {
    weightedLength,
    characterCount: [...normalized].length,
    lineCount: nonEmptyLines.length,
    paragraphCount: normalized.split(/\n\s*\n/u).filter((block) => block.trim().length > 0).length,
    openingLine,
    hashtagCount: normalized.match(new RegExp(HASHTAG, 'gu'))?.length ?? 0,
    traits,
  };
}

export function isWithinPostLimit(text: string): boolean {
  return weightedLengthOf(text) <= POST_WEIGHTED_LENGTH_LIMIT;
}

export const TRAIT_NAMES = Object.keys(TRAIT_LABELS) as TraitName[];
