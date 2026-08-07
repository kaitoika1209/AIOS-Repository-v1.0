import { describe, expect, it } from 'vitest';
import { BuzzPost } from './buzz-post.ts';
import { analyzeBuzzPatterns, median } from './buzz-pattern-analyzer.ts';

function post(text: string, impressionMultiplier: number, index: number): BuzzPost {
  return BuzzPost.of(
    {
      authorHandle: `author${index}`,
      text,
      metrics: {
        likes: 100 * impressionMultiplier,
        reposts: 20 * impressionMultiplier,
        replies: 5,
        bookmarks: 30 * impressionMultiplier,
        impressions: 10_000,
        authorFollowers: 5_000,
      },
    },
    `post-${index}`,
  );
}

describe('analyzeBuzzPatterns', () => {
  it('ranks by buzz score, best first', () => {
    const analysis = analyzeBuzzPatterns([post('a', 1, 1), post('b', 5, 2), post('c', 3, 3)]);
    expect(analysis.rankedPosts.map((entry) => entry.text)).toEqual(['b', 'c', 'a']);
  });

  it('surfaces a trait that is over-represented in the top cohort', () => {
    const analysis = analyzeBuzzPatterns(
      [
        post('・ひとつ\n・ふたつ\n・みっつ', 9, 1),
        post('・ひとつ\n・ふたつ\n・みっつ', 8, 2),
        post('・ひとつ\n・ふたつ\n・みっつ', 7, 3),
        post('普通の文章です', 1, 4),
        post('普通の文章です', 1, 5),
        post('普通の文章です', 1, 6),
        post('普通の文章です', 1, 7),
        post('普通の文章です', 1, 8),
        post('普通の文章です', 1, 9),
      ],
      { topCount: 3 },
    );

    const listPattern = analysis.signaturePatterns.find(
      (pattern) => pattern.trait === 'hasList',
    );
    expect(listPattern).toBeDefined();
    expect(listPattern?.topShare).toBe(1);
    expect(listPattern?.lift).toBeCloseTo(3, 5);
  });

  it('reports no signature patterns when the cohort is structurally uniform', () => {
    const uniform = Array.from({ length: 9 }, (_, index) =>
      post('同じ形の投稿です', 9 - index, index),
    );
    expect(analyzeBuzzPatterns(uniform, { topCount: 3 }).signaturePatterns).toHaveLength(0);
  });

  it('defaults the top cohort to the best third with a floor of three', () => {
    const nine = Array.from({ length: 9 }, (_, index) => post(`post ${index}`, index + 1, index));
    expect(analyzeBuzzPatterns(nine).topPosts).toHaveLength(3);

    const four = Array.from({ length: 4 }, (_, index) => post(`post ${index}`, index + 1, index));
    expect(analyzeBuzzPatterns(four).topPosts).toHaveLength(3);
  });

  it('never asks for more top posts than exist', () => {
    const two = [post('a', 2, 1), post('b', 1, 2)];
    expect(analyzeBuzzPatterns(two, { topCount: 10 }).topPosts).toHaveLength(2);
  });

  it('refuses an empty reference set', () => {
    expect(() => analyzeBuzzPatterns([])).toThrow(/empty reference set/u);
  });
});

describe('median', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns the middle value for an odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
  });
});
