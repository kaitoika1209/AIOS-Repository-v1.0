import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { analyzeBuzzPatterns } from '../../domain/buzz-pattern-analyzer.ts';
import { BuzzPost } from '../../domain/buzz-post.ts';
import { createPostBrief } from '../../domain/post-brief.ts';
import { ClaudePostComposer } from './claude.post-composer.ts';

/**
 * Exercises prompt assembly and response handling without touching the network.
 * The live call is covered by running `x-buzz compose` against a real key.
 */
function stubClient(response: unknown): { client: Anthropic; requests: unknown[] } {
  const requests: unknown[] = [];
  const client = {
    messages: {
      create: async (body: unknown) => {
        requests.push(body);
        return response;
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

function jsonResponse(payload: unknown) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const winner = (text: string, index: number): BuzzPost =>
  BuzzPost.of(
    {
      authorHandle: `winner${index}`,
      text,
      metrics: {
        likes: 5000,
        reposts: 800,
        replies: 100,
        bookmarks: 3000,
        impressions: 500_000,
        authorFollowers: 9_000,
      },
    },
    `winner-${index}`,
  );

const flop = (text: string, index: number): BuzzPost =>
  BuzzPost.of(
    {
      authorHandle: `flop${index}`,
      text,
      metrics: { likes: 30, reposts: 1, replies: 2, impressions: 40_000, authorFollowers: 15_000 },
    },
    `flop-${index}`,
  );

// Nine posts so the default top cohort is a real subset and a trait can stand
// out. The winners all use lists; the rest are single-line remarks.
const analysis = analyzeBuzzPatterns([
  winner('解約理由の1位は「高い」ではありません。\n\n・理由1\n・理由2\n・理由3', 1),
  winner('3つの型を紹介します。\n\n1. ひとつ\n2. ふたつ\n3. みっつ', 2),
  winner('やめたこと。\n\n・ひとつ\n・ふたつ\n・みっつ', 3),
  flop('おはようございます。', 1),
  flop('資料を作り直しています。', 2),
  flop('本日は登壇でした。', 3),
  flop('新機能をリリースしました。', 4),
  flop('よろしくお願いします。', 5),
  flop('お疲れさまでした。', 6),
]);

const brief = createPostBrief({
  topic: '個人開発の収益化',
  language: 'ja',
  draftCount: 2,
  audience: '個人開発者',
  mustAvoid: ['煽り表現'],
});

const settings = { model: 'claude-opus-5', effort: 'high' } as const;

describe('ClaudePostComposer', () => {
  it('returns a draft per generated entry', async () => {
    const { client } = stubClient(
      jsonResponse({
        drafts: [
          { text: '一つ目の案', rationale: '理由A', appliedPatterns: ['Uses a list or bullets'] },
          { text: '二つ目の案', rationale: '理由B', appliedPatterns: [] },
        ],
      }),
    );

    const drafts = await new ClaudePostComposer(client, settings).composeDrafts({ brief, analysis });

    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.text).toBe('一つ目の案');
    expect(drafts[0]?.appliedPatterns).toEqual(['Uses a list or bullets']);
    expect(drafts[0]?.fitsInOnePost()).toBe(true);
  });

  it('sends the configured model, adaptive thinking, effort and the JSON schema', async () => {
    const { client, requests } = stubClient(
      jsonResponse({ drafts: [{ text: 'x', rationale: 'y', appliedPatterns: [] }] }),
    );

    await new ClaudePostComposer(client, settings).composeDrafts({ brief, analysis });

    const body = requests[0] as Record<string, any>;
    expect(body.model).toBe('claude-opus-5');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toContain('drafts');
  });

  it('puts the brief, the measured patterns and the exemplars into the prompt', async () => {
    const { client, requests } = stubClient(
      jsonResponse({ drafts: [{ text: 'x', rationale: 'y', appliedPatterns: [] }] }),
    );

    await new ClaudePostComposer(client, settings).composeDrafts({ brief, analysis });

    const prompt = (requests[0] as any).messages[0].content as string;
    expect(prompt).toContain('個人開発の収益化');
    expect(prompt).toContain('個人開発者');
    expect(prompt).toContain('Must avoid: 煽り表現');
    expect(prompt).toContain('Uses a list or bullets');
    // The strongest reference post must be shown verbatim, not summarised away.
    expect(prompt).toContain('解約理由の1位は「高い」ではありません。');
  });

  it('flags an over-limit draft instead of trusting the model to count', async () => {
    const { client } = stubClient(
      jsonResponse({
        drafts: [{ text: 'あ'.repeat(200), rationale: '', appliedPatterns: [] }],
      }),
    );

    const drafts = await new ClaudePostComposer(client, settings).composeDrafts({ brief, analysis });
    expect(drafts[0]?.weightedLength()).toBe(400);
    expect(drafts[0]?.fitsInOnePost()).toBe(false);
  });

  it('reports a refusal as an actionable error', async () => {
    const { client } = stubClient({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      content: [],
    });

    await expect(
      new ClaudePostComposer(client, settings).composeDrafts({ brief, analysis }),
    ).rejects.toThrow(/declined this request \(cyber\)/u);
  });

  it('reports unparseable output rather than throwing a bare SyntaxError', async () => {
    const { client } = stubClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'not json' }],
    });

    await expect(
      new ClaudePostComposer(client, settings).composeDrafts({ brief, analysis }),
    ).rejects.toThrow(/unparseable JSON/u);
  });

  it('reports a response with no drafts array', async () => {
    const { client } = stubClient(jsonResponse({ unexpected: true }));

    await expect(
      new ClaudePostComposer(client, settings).composeDrafts({ brief, analysis }),
    ).rejects.toThrow(/no "drafts" array/u);
  });
});
