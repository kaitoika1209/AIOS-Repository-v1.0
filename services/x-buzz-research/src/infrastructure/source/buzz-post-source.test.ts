import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBuzzPostSource } from './buzz-post-source.factory.ts';

const samplePath = (name: string): string =>
  fileURLToPath(new URL(`../../../samples/${name}`, import.meta.url));

describe('createBuzzPostSource', () => {
  it('rejects an unsupported extension with an actionable message', () => {
    expect(() => createBuzzPostSource('posts.xlsx')).toThrow(/\.json or \.csv/u);
  });
});

describe('JSON and CSV sources', () => {
  it('reads the JSON sample', async () => {
    const posts = await createBuzzPostSource(samplePath('buzz-posts.sample.json')).findPosts();
    expect(posts.length).toBeGreaterThan(5);
    expect(posts[0]?.authorHandle).toBe('indie_dev_mika');
    expect(posts[0]?.score().confidence).toBe('high');
  });

  it('derives a post id from the status URL when none is given', async () => {
    const posts = await createBuzzPostSource(samplePath('buzz-posts.sample.json')).findPosts();
    expect(posts[0]?.id).toBe('1000000000000000001');
  });

  it('reads the CSV sample through its Japanese headers', async () => {
    const posts = await createBuzzPostSource(samplePath('buzz-posts.sample.csv')).findPosts();
    expect(posts.length).toBeGreaterThan(5);

    const first = posts[0];
    expect(first?.authorHandle).toBe('indie_dev_mika');
    expect(first?.metrics.likes).toBe(4820);
    expect(first?.metrics.impressions).toBe(412_000);
    expect(first?.metrics.authorFollowers).toBe(8_400);
    expect(first?.structure().lineCount).toBeGreaterThan(1);
  });

  it('produces the same ranking from the JSON and CSV samples', async () => {
    const fromJson = await createBuzzPostSource(samplePath('buzz-posts.sample.json')).findPosts();
    const fromCsv = await createBuzzPostSource(samplePath('buzz-posts.sample.csv')).findPosts();

    const topFromJson = [...fromJson].sort((a, b) => b.score().value - a.score().value)[0];
    const topFromCsv = [...fromCsv].sort((a, b) => b.score().value - a.score().value)[0];
    expect(topFromCsv?.authorHandle).toBe(topFromJson?.authorHandle);
  });
});
