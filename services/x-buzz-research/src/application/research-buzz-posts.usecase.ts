import type { BuzzPatternAnalysis } from '../domain/buzz-pattern-analysis.ts';
import { analyzeBuzzPatterns } from '../domain/buzz-pattern-analyzer.ts';
import type { BuzzPostSource } from '../domain/buzz-post-source.ts';

export interface ResearchBuzzPostsCommand {
  readonly source: BuzzPostSource;
  readonly topCount?: number;
}

/**
 * Loads a reference set and reports what the high performers have in common.
 * Requires no model provider and no API key — the analysis is deterministic.
 */
export async function researchBuzzPosts(
  command: ResearchBuzzPostsCommand,
): Promise<BuzzPatternAnalysis> {
  const posts = await command.source.findPosts();
  if (posts.length === 0) {
    throw new Error(`No posts found in ${command.source.name}.`);
  }
  return analyzeBuzzPatterns(posts, { topCount: command.topCount });
}
