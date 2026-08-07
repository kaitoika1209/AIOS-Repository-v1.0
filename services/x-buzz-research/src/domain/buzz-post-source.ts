import type { BuzzPost } from './buzz-post.ts';

/**
 * Where the reference set comes from.
 *
 * The MVP reads posts a person collected by hand (JSON or CSV). Keeping this a
 * port means an X API adapter can be dropped in later without the domain or the
 * use cases changing — only the factory that picks an implementation.
 */
export interface BuzzPostSource {
  readonly name: string;
  findPosts(): Promise<readonly BuzzPost[]>;
}
