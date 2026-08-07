import { readFile } from 'node:fs/promises';
import { BuzzPost, type BuzzPostInput } from '../../domain/buzz-post.ts';
import type { BuzzPostSource } from '../../domain/buzz-post-source.ts';

/**
 * Reads a reference set from a JSON file: either a bare array of posts, or an
 * object with a `posts` array (which is also the shape `research --json` emits,
 * so an exported analysis can be fed straight back in).
 */
export class JsonFileBuzzPostSource implements BuzzPostSource {
  readonly name: string;

  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.name = `JSON file ${filePath}`;
  }

  async findPosts(): Promise<readonly BuzzPost[]> {
    const raw = await readFile(this.filePath, 'utf8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`${this.filePath} is not valid JSON: ${(cause as Error).message}`);
    }

    const entries = extractEntries(parsed, this.filePath);

    return entries.map((entry, index) => {
      try {
        return BuzzPost.of(entry as BuzzPostInput, `post-${index + 1}`);
      } catch (cause) {
        throw new Error(`${this.filePath} entry ${index + 1}: ${(cause as Error).message}`);
      }
    });
  }
}

function extractEntries(parsed: unknown, filePath: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { posts?: unknown }).posts)) {
    return (parsed as { posts: unknown[] }).posts;
  }
  throw new Error(`${filePath} must contain an array of posts, or an object with a "posts" array.`);
}
