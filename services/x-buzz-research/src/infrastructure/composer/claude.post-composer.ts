import Anthropic from '@anthropic-ai/sdk';
import type { BuzzPatternAnalysis } from '../../domain/buzz-pattern-analysis.ts';
import type { PostBrief } from '../../domain/post-brief.ts';
import type { PostComposer, PostCompositionRequest } from '../../domain/post-composer.ts';
import { PostDraft } from '../../domain/post-draft.ts';
import { POST_WEIGHTED_LENGTH_LIMIT } from '../../domain/post-structure.ts';
import { readComposerSettings, requireApiKey, type ComposerSettings } from '../config/environment.ts';

const MAX_TOKENS = 16_000;

/** Enough exemplars to show the register without flooding the context. */
const EXEMPLAR_COUNT = 8;

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The post exactly as it would be published, including line breaks.',
          },
          rationale: {
            type: 'string',
            description: 'One or two sentences on why this angle should land with this audience.',
          },
          appliedPatterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'Which of the observed patterns this draft uses.',
          },
        },
        required: ['text', 'rationale', 'appliedPatterns'],
        additionalProperties: false,
      },
    },
  },
  required: ['drafts'],
  additionalProperties: false,
} as const;

export class ClaudePostComposer implements PostComposer {
  readonly name = 'Claude';

  private readonly client: Anthropic;
  private readonly settings: ComposerSettings;

  constructor(client?: Anthropic, settings?: ComposerSettings) {
    this.settings = settings ?? readComposerSettings();
    this.client = client ?? new Anthropic({ apiKey: requireApiKey() });
  }

  async composeDrafts(request: PostCompositionRequest): Promise<readonly PostDraft[]> {
    const response = await this.client.messages.create({
      model: this.settings.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.settings.effort,
        format: { type: 'json_schema', schema: DRAFT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildPrompt(request) }],
    });

    if (response.stop_reason === 'refusal') {
      throw new Error(
        `The model declined this request (${response.stop_details?.category ?? 'no category'}). ` +
          'Revise the brief and try again.',
      );
    }

    const payload = extractJson(response.content);
    return payload.drafts.map((draft) =>
      PostDraft.of({
        text: draft.text,
        rationale: draft.rationale,
        appliedPatterns: draft.appliedPatterns,
      }),
    );
  }
}

const SYSTEM_PROMPT = [
  'You write posts for X. You are given a set of posts that measurably outperformed on a',
  'specific account niche, a structural analysis of what those posts have in common, and a brief',
  'describing what the author wants to say next.',
  '',
  'Write drafts that could plausibly be posted as-is. Ground each one in the observed patterns:',
  'the hook shapes, the length, the line-break rhythm, the presence or absence of lists, emoji,',
  'questions and calls to action. The patterns are evidence about what this audience responds to,',
  'not a checklist — apply the ones that fit the topic and ignore the ones that would read as',
  'forced.',
  '',
  'Constraints that are not negotiable:',
  `- Each draft must fit one post: at most ${POST_WEIGHTED_LENGTH_LIMIT} weighted characters,`,
  '  where Japanese and emoji characters cost 2 and Latin characters cost 1. A Japanese draft is',
  '  therefore capped around 140 characters. Count before you answer.',
  '- Never invent statistics, studies, quotes, dates, or named sources. If a draft would be',
  '  stronger with a number the brief did not supply, write it so the author can fill the number',
  '  in, and say so in the rationale.',
  '- Do not copy sentences from the reference posts. Borrow structure, not wording.',
  '- Vary the drafts. Each should take a genuinely different angle or hook shape, not the same',
  '  idea reworded.',
  '',
  'Write in the language the brief specifies.',
].join('\n');

function buildPrompt(request: PostCompositionRequest): string {
  const { brief, analysis } = request;
  return [
    '# Brief',
    describeBrief(brief),
    '',
    '# What outperformed in this reference set',
    describeAnalysis(analysis),
    '',
    '# Reference posts (highest performing first)',
    describeExemplars(analysis),
    '',
    '# Task',
    `Write ${brief.draftCount} distinct drafts about: ${brief.topic}`,
  ].join('\n');
}

function describeBrief(brief: PostBrief): string {
  const lines = [
    `- Topic: ${brief.topic}`,
    `- Language: ${brief.language === 'ja' ? 'Japanese' : 'English'}`,
    `- Number of drafts: ${brief.draftCount}`,
  ];
  if (brief.audience) lines.push(`- Audience: ${brief.audience}`);
  if (brief.goal) lines.push(`- Goal: ${brief.goal}`);
  if (brief.tone) lines.push(`- Tone: ${brief.tone}`);
  if (brief.accountContext) lines.push(`- About the account: ${brief.accountContext}`);
  if (brief.mustInclude?.length) lines.push(`- Must include: ${brief.mustInclude.join(', ')}`);
  if (brief.mustAvoid?.length) lines.push(`- Must avoid: ${brief.mustAvoid.join(', ')}`);
  return lines.join('\n');
}

function describeAnalysis(analysis: BuzzPatternAnalysis): string {
  const { lengthProfile } = analysis;
  const lines = [
    `Reference set: ${analysis.rankedPosts.length} posts. Top cohort: ${analysis.topPosts.length} posts.`,
    '',
    'Traits over-represented among the top cohort (share in top cohort vs. share overall):',
  ];

  if (analysis.signaturePatterns.length === 0) {
    lines.push('- None stood out. The top posts are structurally similar to the rest of the set.');
  } else {
    for (const pattern of analysis.signaturePatterns) {
      lines.push(
        `- ${pattern.label}: ${formatShare(pattern.topShare)} vs ${formatShare(pattern.overallShare)} ` +
          `(${formatLift(pattern.lift)} more common)`,
      );
    }
  }

  lines.push(
    '',
    'Length and shape:',
    `- Top cohort median length: ${lengthProfile.topMedianWeightedLength} weighted characters ` +
      `(whole set: ${lengthProfile.overallMedianWeightedLength})`,
    `- Top cohort median line count: ${lengthProfile.topMedianLineCount} ` +
      `(whole set: ${lengthProfile.overallMedianLineCount})`,
  );

  if (analysis.hooks.length > 0) {
    lines.push('', 'Opening lines of the top cohort:');
    for (const hook of analysis.hooks) lines.push(`- ${hook}`);
  }

  return lines.join('\n');
}

function describeExemplars(analysis: BuzzPatternAnalysis): string {
  return analysis.rankedPosts
    .slice(0, EXEMPLAR_COUNT)
    .map((post, index) => {
      const score = post.score();
      return [
        `## ${index + 1}. ${post.describeAuthor()} — buzz score ${score.value} (${score.confidence} confidence)`,
        '```',
        post.text,
        '```',
      ].join('\n');
    })
    .join('\n\n');
}

interface DraftPayload {
  drafts: Array<{ text: string; rationale: string; appliedPatterns: string[] }>;
}

function extractJson(content: Anthropic.ContentBlock[]): DraftPayload {
  const text = content.find((block) => block.type === 'text')?.text;
  if (!text) {
    throw new Error('The model returned no text content.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`The model returned unparseable JSON: ${(cause as Error).message}`);
  }

  const drafts = (parsed as DraftPayload | null)?.drafts;
  if (!Array.isArray(drafts)) {
    throw new Error('The model response had no "drafts" array.');
  }
  return { drafts };
}

function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function formatLift(lift: number): string {
  return Number.isFinite(lift) ? `${lift.toFixed(1)}x` : 'much';
}
