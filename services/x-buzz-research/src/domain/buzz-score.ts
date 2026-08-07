import type { EngagementMetrics } from './engagement-metrics.ts';

/**
 * Raw like counts are a poor ranking key: a large account earns them without
 * the post being remarkable. A buzz score instead measures *outperformance* —
 * how hard the post worked relative to the audience that saw it.
 */

export type SignalName =
  | 'engagementRate'
  | 'amplificationRate'
  | 'saveRate'
  | 'reachMultiple'
  | 'followerEngagementRate'
  | 'totalEngagement';

/**
 * Benchmarks are the value at which a signal scores 0.5. They are deliberately
 * set near "a good day for an ordinary account" so that genuine outliers land
 * high without saturating the whole cohort.
 */
interface SignalDefinition {
  readonly label: string;
  readonly benchmark: number;
  readonly weight: number;
  readonly read: (metrics: EngagementMetrics) => number | undefined;
}

const SIGNAL_DEFINITIONS: Record<SignalName, SignalDefinition> = {
  engagementRate: {
    label: 'Engagement rate (interactions / impressions)',
    benchmark: 0.03,
    weight: 0.25,
    read: (metrics) => metrics.engagementRate(),
  },
  amplificationRate: {
    label: 'Amplification rate (reposts + quotes / impressions)',
    benchmark: 0.005,
    weight: 0.25,
    read: (metrics) => metrics.amplificationRate(),
  },
  saveRate: {
    label: 'Save rate (bookmarks / impressions)',
    benchmark: 0.005,
    weight: 0.15,
    read: (metrics) => metrics.saveRate(),
  },
  reachMultiple: {
    label: 'Reach multiple (impressions / followers)',
    benchmark: 3,
    weight: 0.2,
    read: (metrics) => metrics.reachMultiple(),
  },
  followerEngagementRate: {
    label: 'Follower engagement rate (interactions / followers)',
    benchmark: 0.02,
    weight: 0.15,
    read: (metrics) => metrics.followerEngagementRate(),
  },
  totalEngagement: {
    label: 'Total interactions (no denominator available)',
    benchmark: 1000,
    weight: 1,
    read: (metrics) => metrics.totalEngagement(),
  },
};

/** Signals that need impressions or follower counts, in reporting order. */
const RELATIVE_SIGNALS: readonly SignalName[] = [
  'engagementRate',
  'amplificationRate',
  'saveRate',
  'reachMultiple',
  'followerEngagementRate',
];

export interface ScoreSignal {
  readonly name: SignalName;
  readonly label: string;
  readonly observed: number;
  readonly benchmark: number;
  /** 0..1, where 0.5 means the signal landed exactly on its benchmark. */
  readonly normalized: number;
  /** Share of the final score this signal accounted for, after renormalisation. */
  readonly weight: number;
}

/**
 * How much the score can be trusted, given which denominators were reported.
 * `low` means the post was ranked on raw interaction volume alone.
 */
export type ScoreConfidence = 'high' | 'medium' | 'low';

export class BuzzScore {
  readonly value: number;
  readonly confidence: ScoreConfidence;
  readonly signals: readonly ScoreSignal[];

  private constructor(value: number, confidence: ScoreConfidence, signals: readonly ScoreSignal[]) {
    this.value = value;
    this.confidence = confidence;
    this.signals = signals;
  }

  static of(metrics: EngagementMetrics): BuzzScore {
    const available = collectSignals(metrics, RELATIVE_SIGNALS);

    if (available.length === 0) {
      const fallback = collectSignals(metrics, ['totalEngagement']);
      return new BuzzScore(weightedValue(fallback), 'low', fallback);
    }

    const confidence: ScoreConfidence =
      metrics.hasImpressions() && metrics.hasAuthorFollowers() ? 'high' : 'medium';
    return new BuzzScore(weightedValue(available), confidence, available);
  }

  /** The single signal that contributed the most to the score. */
  strongestSignal(): ScoreSignal | undefined {
    return [...this.signals].sort(
      (left, right) => right.normalized * right.weight - left.normalized * left.weight,
    )[0];
  }
}

function collectSignals(metrics: EngagementMetrics, names: readonly SignalName[]): ScoreSignal[] {
  const raw: Array<{ name: SignalName; definition: SignalDefinition; observed: number }> = [];

  for (const name of names) {
    const definition = SIGNAL_DEFINITIONS[name];
    const observed = definition.read(metrics);
    if (observed === undefined) continue;
    raw.push({ name, definition, observed });
  }

  // Weights are renormalised over the signals we could actually compute, so a
  // post missing bookmarks is not silently penalised against one that has them.
  const totalWeight = raw.reduce((sum, entry) => sum + entry.definition.weight, 0);
  if (totalWeight === 0) return [];

  return raw.map((entry) => ({
    name: entry.name,
    label: entry.definition.label,
    observed: entry.observed,
    benchmark: entry.definition.benchmark,
    normalized: saturate(entry.observed, entry.definition.benchmark),
    weight: entry.definition.weight / totalWeight,
  }));
}

function weightedValue(signals: readonly ScoreSignal[]): number {
  const score = signals.reduce((sum, signal) => sum + signal.normalized * signal.weight, 0);
  return round(score * 100, 1);
}

/**
 * Maps an unbounded observation onto 0..1 with diminishing returns, so a post
 * that is ten times the benchmark does not swamp one that is three times it.
 */
function saturate(observed: number, benchmark: number): number {
  if (observed <= 0) return 0;
  return observed / (observed + benchmark);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
