import { readFile } from 'node:fs/promises';
import { BuzzPost } from '../../domain/buzz-post.ts';
import type { BuzzPostSource } from '../../domain/buzz-post-source.ts';
import { parseCsv } from './csv.ts';

/**
 * Column aliases, so a sheet exported from X analytics or typed up by hand in
 * either language maps without the person having to rename headers first.
 */
const COLUMN_ALIASES = {
  text: ['text', 'content', 'post', 'tweet', 'body', '本文', '投稿', 'ツイート'],
  authorHandle: ['author', 'handle', 'username', 'account', 'user', 'アカウント', 'ユーザー名'],
  url: ['url', 'link', 'permalink', 'リンク'],
  postedAt: ['posted_at', 'postedat', 'date', 'created_at', 'createdat', '投稿日', '日付'],
  language: ['language', 'lang', '言語'],
  likes: ['likes', 'like', 'favorites', 'favourite', 'favorite', 'いいね'],
  reposts: ['reposts', 'repost', 'retweets', 'retweet', 'rt', 'リポスト', 'リツイート'],
  replies: ['replies', 'reply', 'comments', 'comment', 'リプライ', 'コメント', '返信'],
  quotes: ['quotes', 'quote', 'quote_tweets', '引用', '引用リポスト'],
  bookmarks: ['bookmarks', 'bookmark', 'saves', 'ブックマーク', '保存'],
  impressions: ['impressions', 'impression', 'views', 'view', 'インプレッション', '表示回数', '表示'],
  authorFollowers: [
    'followers',
    'author_followers',
    'authorfollowers',
    'follower_count',
    'フォロワー',
    'フォロワー数',
  ],
} as const;

type ColumnName = keyof typeof COLUMN_ALIASES;

export class CsvFileBuzzPostSource implements BuzzPostSource {
  readonly name: string;

  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.name = `CSV file ${filePath}`;
  }

  async findPosts(): Promise<readonly BuzzPost[]> {
    const rows = parseCsv(await readFile(this.filePath, 'utf8'));
    const headerRow = rows[0];
    if (!headerRow) {
      throw new Error(`${this.filePath} is empty.`);
    }

    const columns = mapColumns(headerRow);
    if (columns.text === undefined) {
      throw new Error(
        `${this.filePath} has no text column. Expected one of: ${COLUMN_ALIASES.text.join(', ')}.`,
      );
    }

    const posts: BuzzPost[] = [];
    for (const [offset, row] of rows.slice(1).entries()) {
      const rowNumber = offset + 2;
      const text = readCell(row, columns.text);
      if (!text) continue; // Blank lines and spacer rows are common in hand-made sheets.

      try {
        posts.push(
          BuzzPost.of(
            {
              authorHandle: readCell(row, columns.authorHandle),
              text,
              url: readCell(row, columns.url),
              postedAt: readCell(row, columns.postedAt),
              language: readCell(row, columns.language),
              metrics: {
                likes: readNumber(row, columns.likes) ?? 0,
                reposts: readNumber(row, columns.reposts) ?? 0,
                replies: readNumber(row, columns.replies) ?? 0,
                quotes: readNumber(row, columns.quotes),
                bookmarks: readNumber(row, columns.bookmarks),
                impressions: readNumber(row, columns.impressions),
                authorFollowers: readNumber(row, columns.authorFollowers),
              },
            },
            `row-${rowNumber}`,
          ),
        );
      } catch (cause) {
        throw new Error(`${this.filePath} row ${rowNumber}: ${(cause as Error).message}`);
      }
    }

    return posts;
  }
}

function mapColumns(headerRow: readonly string[]): Partial<Record<ColumnName, number>> {
  const normalizedHeaders = headerRow.map((header) => normalizeHeader(header));
  const columns: Partial<Record<ColumnName, number>> = {};

  for (const [column, aliases] of Object.entries(COLUMN_ALIASES) as Array<
    [ColumnName, readonly string[]]
  >) {
    const index = normalizedHeaders.findIndex((header) =>
      aliases.some((alias) => header === normalizeHeader(alias)),
    );
    if (index >= 0) columns[column] = index;
  }

  return columns;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]/gu, '');
}

function readCell(row: readonly string[], index: number | undefined): string | undefined {
  if (index === undefined) return undefined;
  const value = row[index]?.trim();
  return value ? value : undefined;
}

function readNumber(row: readonly string[], index: number | undefined): number | undefined {
  const raw = readCell(row, index);
  if (raw === undefined) return undefined;

  // Sheets and the X UI both produce thousands separators and "12.3K" shorthand.
  const cleaned = raw.replace(/[,\s，]/gu, '');
  const shorthand = cleaned.match(/^([0-9]*\.?[0-9]+)\s*([kKmM万])$/u);
  if (shorthand) {
    const amount = Number(shorthand[1]);
    const unit = shorthand[2] as string;
    const multiplier = unit === '万' ? 10_000 : unit.toLowerCase() === 'k' ? 1_000 : 1_000_000;
    return Math.round(amount * multiplier);
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    throw new Error(`"${raw}" is not a number.`);
  }
  return value;
}
