import type { BuzzPost } from './buzz-post.ts';
import type { BuzzPatternAnalysis, LengthProfile, TraitPattern } from './buzz-pattern-analysis.ts';
import { TRAIT_LABELS, TRAIT_NAMES, type TraitName } from './post-structure.ts';

/** A trait must appear in at least this share of the top cohort to be a pattern. */
const MINIMUM_TOP_SHARE = 0.4;
/** ...and be at least this much more common there than across the whole set. */
const MINIMUM_LIFT = 1.15;

export interface AnalysisOptions {
  /**
   * Size of the top cohort the patterns are measured against. Defaults to the
   * best third of the reference set, with a floor of three posts.
   */
  readonly topCount?: number;
}

/**
 * Ranks a reference set and reports which structural traits separate the posts
 * that outperformed from the ones that did not.
 */
export function analyzeBuzzPatterns(
  posts: readonly BuzzPost[],
  options: AnalysisOptions = {},
): BuzzPatternAnalysis {
  if (posts.length === 0) {
    throw new Error('Cannot analyze an empty reference set.');
  }

  const rankedPosts = [...posts].sort((left, right) => right.score().value - left.score().value);
  const topCount = resolveTopCount(rankedPosts.length, options.topCount);
  const topPosts = rankedPosts.slice(0, topCount);

  const allPatterns = TRAIT_NAMES.map((trait) => {
    const topCountForTrait = countWith(topPosts, trait);
    const topShare = topCountForTrait / topPosts.length;
    const overallShare = countWith(rankedPosts, trait) / rankedPosts.length;
    return {
      trait,
      label: TRAIT_LABELS[trait],
      topCount: topCountForTrait,
      topShare,
      overallShare,
      lift: overallShare === 0 ? (topShare > 0 ? Infinity : 0) : topShare / overallShare,
    } satisfies TraitPattern;
  });

  const signaturePatterns = allPatterns
    .filter((pattern) => pattern.topShare >= MINIMUM_TOP_SHARE && pattern.lift >= MINIMUM_LIFT)
    .sort((left, right) => right.lift - left.lift || right.topShare - left.topShare);

  return {
    rankedPosts,
    topPosts,
    signaturePatterns,
    allPatterns: [...allPatterns].sort((left, right) => right.topShare - left.topShare),
    lengthProfile: buildLengthProfile(topPosts, rankedPosts),
    hooks: topPosts.map((post) => post.hook()).filter((hook) => hook.length > 0),
    medianScore: median(rankedPosts.map((post) => post.score().value)),
    topMedianScore: median(topPosts.map((post) => post.score().value)),
  };
}

function resolveTopCount(total: number, requested: number | undefined): number {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 1) {
      throw new Error(`topCount must be a positive integer, received: ${String(requested)}`);
    }
    return Math.min(requested, total);
  }
  return Math.min(total, Math.max(3, Math.ceil(total / 3)));
}

function countWith(posts: readonly BuzzPost[], trait: TraitName): number {
  return posts.filter((post) => post.structure().traits[trait]).length;
}

function buildLengthProfile(
  topPosts: readonly BuzzPost[],
  allPosts: readonly BuzzPost[],
): LengthProfile {
  return {
    topMedianWeightedLength: median(topPosts.map((post) => post.structure().weightedLength)),
    overallMedianWeightedLength: median(allPosts.map((post) => post.structure().weightedLength)),
    topMedianLineCount: median(topPosts.map((post) => post.structure().lineCount)),
    overallMedianLineCount: median(allPosts.map((post) => post.structure().lineCount)),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
