import type { ComposePostDraftsResult } from '../application/compose-post-drafts.usecase.ts';
import type { PostBrief } from '../domain/post-brief.ts';
import { POST_WEIGHTED_LENGTH_LIMIT } from '../domain/post-structure.ts';

export function formatDraftReport(brief: PostBrief, result: ComposePostDraftsResult): string {
  const sections = [
    '# Post drafts',
    '',
    `**Topic:** ${brief.topic}`,
    brief.audience ? `**Audience:** ${brief.audience}` : undefined,
    brief.goal ? `**Goal:** ${brief.goal}` : undefined,
    brief.tone ? `**Tone:** ${brief.tone}` : undefined,
    '',
  ].filter((line): line is string => line !== undefined);

  if (result.oversizedDrafts.length > 0) {
    sections.push(
      `> ⚠️ ${result.oversizedDrafts.length} draft(s) exceed the ${POST_WEIGHTED_LENGTH_LIMIT}-unit`,
      '> limit and are marked below. Trim them or split them into a thread before posting.',
      '',
    );
  }

  result.drafts.forEach((draft, index) => {
    const length = draft.weightedLength();
    const status = draft.fitsInOnePost()
      ? `${length}/${POST_WEIGHTED_LENGTH_LIMIT}`
      : `${length}/${POST_WEIGHTED_LENGTH_LIMIT} — OVER LIMIT`;

    sections.push(
      `## Draft ${index + 1} (${status})`,
      '',
      '```',
      draft.text,
      '```',
      '',
      `**Why this angle:** ${draft.rationale || '—'}`,
      '',
      `**Patterns applied:** ${draft.appliedPatterns.length > 0 ? draft.appliedPatterns.join(', ') : '—'}`,
      '',
    );
  });

  sections.push(
    '---',
    '',
    'Drafts are starting points. Check every factual claim before posting — the model was',
    'instructed not to invent numbers or sources, but that instruction is not a guarantee.',
    '',
  );

  return sections.join('\n');
}
