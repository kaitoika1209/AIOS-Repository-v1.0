import { BuzzScore } from './buzz-score.ts';
import { EngagementMetrics, type EngagementCounters } from './engagement-metrics.ts';
import { analyzeStructure, type PostStructure } from './post-structure.ts';

/** A post observed on X that is a candidate for the reference set. */
export interface BuzzPostInput {
  readonly id?: string;
  readonly authorHandle?: string;
  readonly text: string;
  readonly url?: string;
  readonly postedAt?: string;
  readonly language?: string;
  readonly metrics: EngagementCounters;
}

export class BuzzPost {
  readonly id: string;
  readonly authorHandle: string | undefined;
  readonly text: string;
  readonly url: string | undefined;
  readonly postedAt: Date | undefined;
  readonly language: string | undefined;
  readonly metrics: EngagementMetrics;

  private readonly postStructure: PostStructure;
  private readonly buzzScore: BuzzScore;

  private constructor(input: BuzzPostInput, id: string, metrics: EngagementMetrics) {
    this.id = id;
    this.authorHandle = input.authorHandle?.trim() || undefined;
    this.text = input.text;
    this.url = input.url?.trim() || undefined;
    this.postedAt = parseDate(input.postedAt);
    this.language = input.language?.trim() || undefined;
    this.metrics = metrics;
    this.postStructure = analyzeStructure(input.text);
    this.buzzScore = BuzzScore.of(metrics);
  }

  static of(input: BuzzPostInput, fallbackId: string): BuzzPost {
    const text = input.text?.trim();
    if (!text) {
      throw new Error(`Post "${input.id ?? fallbackId}" has no text.`);
    }
    const id = input.id?.trim() || deriveIdFromUrl(input.url) || fallbackId;
    return new BuzzPost({ ...input, text }, id, EngagementMetrics.of(input.metrics));
  }

  structure(): PostStructure {
    return this.postStructure;
  }

  score(): BuzzScore {
    return this.buzzScore;
  }

  /** First line of the post — the hook a reader decides on before expanding. */
  hook(): string {
    return this.postStructure.openingLine;
  }

  excerpt(maxCharacters = 140): string {
    const singleLine = this.text.replace(/\s*\n\s*/gu, ' / ').trim();
    const characters = [...singleLine];
    return characters.length <= maxCharacters
      ? singleLine
      : `${characters.slice(0, maxCharacters).join('')}…`;
  }

  describeAuthor(): string {
    return this.authorHandle ? `@${this.authorHandle.replace(/^@/u, '')}` : 'unknown author';
  }
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function deriveIdFromUrl(url: string | undefined): string | undefined {
  const match = url?.match(/status\/(\d+)/u);
  return match?.[1];
}
