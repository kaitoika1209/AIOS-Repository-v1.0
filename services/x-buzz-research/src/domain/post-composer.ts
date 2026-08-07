import type { BuzzPatternAnalysis } from './buzz-pattern-analysis.ts';
import type { PostBrief } from './post-brief.ts';
import type { PostDraft } from './post-draft.ts';

export interface PostCompositionRequest {
  readonly brief: PostBrief;
  readonly analysis: BuzzPatternAnalysis;
}

/**
 * Turns an analysis plus a brief into candidate posts.
 *
 * A port so the generation model stays swappable — `docs/engineering/tech-stack.md`
 * requires the application to remain provider-agnostic.
 */
export interface PostComposer {
  readonly name: string;
  composeDrafts(request: PostCompositionRequest): Promise<readonly PostDraft[]>;
}
