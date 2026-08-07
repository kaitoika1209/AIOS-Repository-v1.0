/**
 * Observed engagement counters for a single post.
 *
 * Every counter beyond likes/reposts/replies is optional because the numbers a
 * person can read off a post differ from the numbers an API returns. The
 * derived rates below return `undefined` rather than a fabricated value when
 * their inputs are missing, so scoring can tell "zero" apart from "unknown".
 */
export interface EngagementCounters {
  readonly likes: number;
  readonly reposts: number;
  readonly replies: number;
  readonly quotes?: number;
  readonly bookmarks?: number;
  readonly impressions?: number;
  readonly authorFollowers?: number;
}

export class EngagementMetrics {
  readonly likes: number;
  readonly reposts: number;
  readonly replies: number;
  readonly quotes: number;
  readonly bookmarks: number;
  readonly impressions: number | undefined;
  readonly authorFollowers: number | undefined;

  private constructor(counters: EngagementCounters) {
    this.likes = counters.likes;
    this.reposts = counters.reposts;
    this.replies = counters.replies;
    this.quotes = counters.quotes ?? 0;
    this.bookmarks = counters.bookmarks ?? 0;
    this.impressions = positiveOrUndefined(counters.impressions);
    this.authorFollowers = positiveOrUndefined(counters.authorFollowers);
  }

  static of(counters: EngagementCounters): EngagementMetrics {
    for (const [field, value] of Object.entries(counters)) {
      if (value === undefined || value === null) continue;
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Engagement counter "${field}" must be a non-negative number, received: ${String(value)}`);
      }
    }
    return new EngagementMetrics(counters);
  }

  /** Every interaction the post collected, regardless of kind. */
  totalEngagement(): number {
    return this.likes + this.reposts + this.replies + this.quotes + this.bookmarks;
  }

  /** Interactions that put the post in front of somebody else's timeline. */
  amplifications(): number {
    return this.reposts + this.quotes;
  }

  hasImpressions(): boolean {
    return this.impressions !== undefined;
  }

  hasAuthorFollowers(): boolean {
    return this.authorFollowers !== undefined;
  }

  /** Share of viewers who interacted at all. */
  engagementRate(): number | undefined {
    return this.impressions === undefined ? undefined : this.totalEngagement() / this.impressions;
  }

  /** Share of viewers who rebroadcast the post. The strongest spread signal. */
  amplificationRate(): number | undefined {
    return this.impressions === undefined ? undefined : this.amplifications() / this.impressions;
  }

  /** Share of viewers who kept the post for later. Proxy for durable usefulness. */
  saveRate(): number | undefined {
    return this.impressions === undefined ? undefined : this.bookmarks / this.impressions;
  }

  /**
   * How far the post travelled past the author's own audience. A value of 1
   * means it roughly reached the follower count and no further.
   */
  reachMultiple(): number | undefined {
    if (this.impressions === undefined || this.authorFollowers === undefined) return undefined;
    return this.impressions / this.authorFollowers;
  }

  /** Interactions per follower. The fallback signal when impressions are unknown. */
  followerEngagementRate(): number | undefined {
    if (this.authorFollowers === undefined) return undefined;
    return this.totalEngagement() / this.authorFollowers;
  }
}

function positiveOrUndefined(value: number | undefined): number | undefined {
  // Zero impressions or zero followers would make every derived rate divide by
  // zero, so they are treated as "not reported" rather than as a real value.
  return value === undefined || value <= 0 ? undefined : value;
}
