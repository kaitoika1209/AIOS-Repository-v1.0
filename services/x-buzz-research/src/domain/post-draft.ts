import {
  POST_WEIGHTED_LENGTH_LIMIT,
  analyzeStructure,
  type PostStructure,
} from './post-structure.ts';

export interface PostDraftInput {
  readonly text: string;
  readonly rationale: string;
  /** Patterns from the analysis this draft deliberately applies. */
  readonly appliedPatterns: readonly string[];
}

export class PostDraft {
  readonly text: string;
  readonly rationale: string;
  readonly appliedPatterns: readonly string[];

  private readonly draftStructure: PostStructure;

  private constructor(input: PostDraftInput) {
    this.text = input.text;
    this.rationale = input.rationale;
    this.appliedPatterns = input.appliedPatterns;
    this.draftStructure = analyzeStructure(input.text);
  }

  static of(input: PostDraftInput): PostDraft {
    const text = input.text?.trim();
    if (!text) {
      throw new Error('A draft needs text.');
    }
    return new PostDraft({
      text,
      rationale: input.rationale?.trim() ?? '',
      appliedPatterns: input.appliedPatterns ?? [],
    });
  }

  structure(): PostStructure {
    return this.draftStructure;
  }

  weightedLength(): number {
    return this.draftStructure.weightedLength;
  }

  /**
   * Whether the draft fits in a single post. Generated Japanese text overruns
   * easily because CJK characters cost two units each, so this is checked
   * locally rather than trusted to the model.
   */
  fitsInOnePost(): boolean {
    return this.draftStructure.weightedLength <= POST_WEIGHTED_LENGTH_LIMIT;
  }
}
