export type PostLanguage = 'ja' | 'en';

/** What the author wants to post about, and the constraints around it. */
export interface PostBrief {
  readonly topic: string;
  readonly language: PostLanguage;
  readonly draftCount: number;
  readonly audience?: string;
  readonly goal?: string;
  readonly tone?: string;
  /** Who is posting — account positioning, expertise, recurring themes. */
  readonly accountContext?: string;
  readonly mustInclude?: readonly string[];
  readonly mustAvoid?: readonly string[];
}

export const DEFAULT_DRAFT_COUNT = 5;
const MAX_DRAFT_COUNT = 12;

export function createPostBrief(input: Partial<PostBrief> & { topic: string }): PostBrief {
  const topic = input.topic.trim();
  if (!topic) {
    throw new Error('A brief needs a topic.');
  }

  const draftCount = input.draftCount ?? DEFAULT_DRAFT_COUNT;
  if (!Number.isInteger(draftCount) || draftCount < 1 || draftCount > MAX_DRAFT_COUNT) {
    throw new Error(`draftCount must be an integer between 1 and ${MAX_DRAFT_COUNT}.`);
  }

  return {
    ...input,
    topic,
    language: input.language ?? 'ja',
    draftCount,
  };
}
