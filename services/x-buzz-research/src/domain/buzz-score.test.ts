import { describe, expect, it } from 'vitest';
import { BuzzScore } from './buzz-score.ts';
import { EngagementMetrics } from './engagement-metrics.ts';

const baseCounters = { likes: 100, reposts: 10, replies: 5, quotes: 2, bookmarks: 20 };

describe('BuzzScore', () => {
  it('reports high confidence only when impressions and followers are both known', () => {
    const full = BuzzScore.of(
      EngagementMetrics.of({ ...baseCounters, impressions: 10_000, authorFollowers: 1_000 }),
    );
    const impressionsOnly = BuzzScore.of(
      EngagementMetrics.of({ ...baseCounters, impressions: 10_000 }),
    );
    const neither = BuzzScore.of(EngagementMetrics.of(baseCounters));

    expect(full.confidence).toBe('high');
    expect(impressionsOnly.confidence).toBe('medium');
    expect(neither.confidence).toBe('low');
  });

  it('falls back to raw interaction volume when no denominator is reported', () => {
    const score = BuzzScore.of(EngagementMetrics.of(baseCounters));
    expect(score.signals).toHaveLength(1);
    expect(score.signals[0]?.name).toBe('totalEngagement');
  });

  it('ranks a small account that travelled far above a large account that did not', () => {
    const outperformer = BuzzScore.of(
      EngagementMetrics.of({
        likes: 4000,
        reposts: 600,
        replies: 120,
        quotes: 90,
        bookmarks: 1800,
        impressions: 400_000,
        authorFollowers: 8_000,
      }),
    );
    const bigAccountFlop = BuzzScore.of(
      EngagementMetrics.of({
        likes: 4000,
        reposts: 40,
        replies: 60,
        quotes: 5,
        bookmarks: 50,
        impressions: 400_000,
        authorFollowers: 2_000_000,
      }),
    );

    expect(outperformer.value).toBeGreaterThan(bigAccountFlop.value);
  });

  it('normalises a signal to 0.5 when it lands exactly on its benchmark', () => {
    // 3% engagement rate is the engagementRate benchmark.
    const score = BuzzScore.of(
      EngagementMetrics.of({ likes: 300, reposts: 0, replies: 0, impressions: 10_000 }),
    );
    const engagement = score.signals.find((signal) => signal.name === 'engagementRate');
    expect(engagement?.normalized).toBeCloseTo(0.5, 6);
  });

  it('renormalises weights so every score stays on the same 0..100 scale', () => {
    const score = BuzzScore.of(
      EngagementMetrics.of({ ...baseCounters, impressions: 10_000, authorFollowers: 1_000 }),
    );
    const totalWeight = score.signals.reduce((sum, signal) => sum + signal.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 6);
    expect(score.value).toBeGreaterThanOrEqual(0);
    expect(score.value).toBeLessThanOrEqual(100);
  });

  it('treats a zero denominator as unreported rather than dividing by zero', () => {
    const score = BuzzScore.of(EngagementMetrics.of({ ...baseCounters, impressions: 0 }));
    expect(Number.isFinite(score.value)).toBe(true);
    expect(score.confidence).toBe('low');
  });

  it('rejects negative counters', () => {
    expect(() => EngagementMetrics.of({ likes: -1, reposts: 0, replies: 0 })).toThrow(
      /non-negative/u,
    );
  });
});
