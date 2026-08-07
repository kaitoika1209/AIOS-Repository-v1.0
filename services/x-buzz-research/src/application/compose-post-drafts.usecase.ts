import type { BuzzPatternAnalysis } from '../domain/buzz-pattern-analysis.ts';
import type { PostBrief } from '../domain/post-brief.ts';
import type { PostComposer } from '../domain/post-composer.ts';
import type { PostDraft } from '../domain/post-draft.ts';

export interface ComposePostDraftsCommand {
  readonly composer: PostComposer;
  readonly analysis: BuzzPatternAnalysis;
  readonly brief: PostBrief;
}

export interface ComposePostDraftsResult {
  readonly drafts: readonly PostDraft[];
  /** Drafts that exceed the single-post limit, surfaced rather than silently dropped. */
  readonly oversizedDrafts: readonly PostDraft[];
}

export async function composePostDrafts(
  command: ComposePostDraftsCommand,
): Promise<ComposePostDraftsResult> {
  const drafts = await command.composer.composeDrafts({
    brief: command.brief,
    analysis: command.analysis,
  });

  if (drafts.length === 0) {
    throw new Error(`${command.composer.name} returned no drafts.`);
  }

  return {
    drafts,
    oversizedDrafts: drafts.filter((draft) => !draft.fitsInOnePost()),
  };
}
