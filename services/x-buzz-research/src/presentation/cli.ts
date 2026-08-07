import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { composePostDrafts } from '../application/compose-post-drafts.usecase.ts';
import { researchBuzzPosts } from '../application/research-buzz-posts.usecase.ts';
import type { BuzzPatternAnalysis } from '../domain/buzz-pattern-analysis.ts';
import { createPostBrief, DEFAULT_DRAFT_COUNT, type PostLanguage } from '../domain/post-brief.ts';
import { ClaudePostComposer } from '../infrastructure/composer/claude.post-composer.ts';
import { createBuzzPostSource } from '../infrastructure/source/buzz-post-source.factory.ts';
import { formatDraftReport } from './draft-report.formatter.ts';
import { formatResearchReport } from './research-report.formatter.ts';

const USAGE = `x-buzz — research what performs on X, then draft posts from the patterns.

Usage:
  x-buzz research --input <file> [options]
  x-buzz compose  --input <file> --topic <text> [options]

Commands:
  research   Rank a collected set of posts and report what the top performers share.
             Fully local — no API key required.
  compose    Run the research, then draft new posts grounded in it. Needs ANTHROPIC_API_KEY.

Common options:
  --input <file>     Collected posts, .json or .csv. Required.
  --top <n>          Size of the top cohort to measure patterns against.
                     Defaults to the best third of the set (minimum 3).
  --out <file>       Write the Markdown report here instead of stdout.

research options:
  --json <file>      Also write the analysis as JSON.

compose options:
  --topic <text>     What to post about. Required.
  --count <n>        Number of drafts. Default ${DEFAULT_DRAFT_COUNT}.
  --language <ja|en> Draft language. Default ja.
  --audience <text>  Who the post is for.
  --goal <text>      What the post should achieve.
  --tone <text>      Desired voice.
  --account <text>   Context about the posting account.
  --include <text>   Must appear in the draft. Repeatable.
  --avoid <text>     Must not appear in the draft. Repeatable.

Examples:
  x-buzz research --input samples/buzz-posts.sample.json --out out/research.md
  x-buzz compose  --input samples/buzz-posts.sample.csv \\
                  --topic "個人開発の収益化で最初にやるべきこと" --count 5
`;

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  const options = parseOptions(rest);

  switch (command) {
    case 'research':
      return runResearch(options);
    case 'compose':
      return runCompose(options);
    default:
      throw new Error(`Unknown command "${command}". Run \`x-buzz help\` for usage.`);
  }
}

async function runResearch(options: Options): Promise<number> {
  const analysis = await analyze(options);
  await emit(formatResearchReport(analysis), options.single('out'));

  const jsonPath = options.single('json');
  if (jsonPath) {
    await writeToFile(jsonPath, `${JSON.stringify(toSerializableAnalysis(analysis), null, 2)}\n`);
    process.stderr.write(`Analysis written to ${jsonPath}\n`);
  }

  return 0;
}

async function runCompose(options: Options): Promise<number> {
  const topic = options.single('topic');
  if (!topic) {
    throw new Error('`compose` needs --topic.');
  }

  const language = options.single('language') ?? 'ja';
  if (language !== 'ja' && language !== 'en') {
    throw new Error(`--language must be "ja" or "en". Received "${language}".`);
  }

  const brief = createPostBrief({
    topic,
    language: language as PostLanguage,
    draftCount: options.integer('count') ?? DEFAULT_DRAFT_COUNT,
    audience: options.single('audience'),
    goal: options.single('goal'),
    tone: options.single('tone'),
    accountContext: options.single('account'),
    mustInclude: options.many('include'),
    mustAvoid: options.many('avoid'),
  });

  // Built before the analysis runs so a missing API key fails immediately
  // rather than after the reference set has been read and scored.
  const composer = new ClaudePostComposer();

  const analysis = await analyze(options);
  process.stderr.write(
    `Analyzed ${analysis.rankedPosts.length} posts. Composing ${brief.draftCount} drafts…\n`,
  );

  const result = await composePostDrafts({ composer, analysis, brief });

  await emit(formatDraftReport(brief, result), options.single('out'));
  return 0;
}

async function analyze(options: Options): Promise<BuzzPatternAnalysis> {
  const input = options.single('input');
  if (!input) {
    throw new Error('--input is required. Point it at a .json or .csv file of collected posts.');
  }

  return researchBuzzPosts({
    source: createBuzzPostSource(input),
    topCount: options.integer('top'),
  });
}

/**
 * A flat, stable projection of the analysis. Kept separate from the domain
 * objects so a JSON consumer is not coupled to their internal shape.
 */
function toSerializableAnalysis(analysis: BuzzPatternAnalysis) {
  return {
    medianScore: analysis.medianScore,
    topMedianScore: analysis.topMedianScore,
    lengthProfile: analysis.lengthProfile,
    signaturePatterns: analysis.signaturePatterns,
    allPatterns: analysis.allPatterns,
    hooks: analysis.hooks,
    posts: analysis.rankedPosts.map((post, index) => ({
      rank: index + 1,
      id: post.id,
      authorHandle: post.authorHandle,
      url: post.url,
      text: post.text,
      score: post.score().value,
      confidence: post.score().confidence,
      signals: post.score().signals,
      structure: post.structure(),
    })),
  };
}

async function emit(content: string, outPath: string | undefined): Promise<void> {
  if (!outPath) {
    process.stdout.write(content);
    return;
  }
  await writeToFile(outPath, content);
  process.stderr.write(`Report written to ${outPath}\n`);
}

async function writeToFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

interface Options {
  single(name: string): string | undefined;
  many(name: string): string[] | undefined;
  integer(name: string): number | undefined;
}

/**
 * Parses `--name value` pairs. A flag may repeat, which is how --include and
 * --avoid accept more than one value.
 */
function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string[]>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument "${token}". Options take the form --name value.`);
    }

    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option --${name} needs a value.`);
    }
    index += 1;

    const existing = values.get(name);
    if (existing) existing.push(value);
    else values.set(name, [value]);
  }

  return {
    single(name) {
      const found = values.get(name);
      if (!found) return undefined;
      if (found.length > 1) {
        throw new Error(`Option --${name} was given more than once.`);
      }
      return found[0];
    },
    many(name) {
      return values.get(name);
    },
    integer(name) {
      const raw = this.single(name);
      if (raw === undefined) return undefined;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Option --${name} must be a positive integer. Received "${raw}".`);
      }
      return parsed;
    },
  };
}
