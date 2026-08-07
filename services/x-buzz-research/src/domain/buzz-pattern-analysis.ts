import type { BuzzPost } from './buzz-post.ts';
import type { TraitName } from './post-structure.ts';

/**
 * A structural trait, measured inside the top-scoring cohort and against the
 * whole reference set. `lift` is what makes a trait interesting: a trait present
 * in every post tells you nothing, one that is twice as common among the
 * winners is a pattern worth copying.
 */
export interface TraitPattern {
  readonly trait: TraitName;
  readonly label: string;
  readonly topCount: number;
  readonly topShare: number;
  readonly overallShare: number;
  readonly lift: number;
}

export interface LengthProfile {
  readonly topMedianWeightedLength: number;
  readonly overallMedianWeightedLength: number;
  readonly topMedianLineCount: number;
  readonly overallMedianLineCount: number;
}

export interface BuzzPatternAnalysis {
  /** Every post, best score first. */
  readonly rankedPosts: readonly BuzzPost[];
  /** The cohort the patterns were measured against. */
  readonly topPosts: readonly BuzzPost[];
  /** Traits over-represented among the top posts, strongest lift first. */
  readonly signaturePatterns: readonly TraitPattern[];
  /** Every trait, for the full picture. */
  readonly allPatterns: readonly TraitPattern[];
  readonly lengthProfile: LengthProfile;
  readonly hooks: readonly string[];
  readonly medianScore: number;
  readonly topMedianScore: number;
}
