import type { BuzzPatternAnalysis, TraitPattern } from '../domain/buzz-pattern-analysis.ts';
import type { BuzzPost } from '../domain/buzz-post.ts';

/** Renders an analysis as a Markdown report a person can read and act on. */
export function formatResearchReport(analysis: BuzzPatternAnalysis): string {
  return [
    '# X buzz research',
    '',
    formatSummary(analysis),
    '',
    '## Signature patterns',
    '',
    formatSignaturePatterns(analysis),
    '',
    '## Length and shape',
    '',
    formatLengthProfile(analysis),
    '',
    '## Ranking',
    '',
    formatRanking(analysis),
    '',
    '## Hooks from the top cohort',
    '',
    formatHooks(analysis),
    '',
    '## All traits',
    '',
    formatAllTraits(analysis),
    '',
  ].join('\n');
}

function formatSummary(analysis: BuzzPatternAnalysis): string {
  const confidences = analysis.rankedPosts.map((post) => post.score().confidence);
  const lowConfidence = confidences.filter((confidence) => confidence === 'low').length;

  const lines = [
    `- Posts analyzed: **${analysis.rankedPosts.length}**`,
    `- Top cohort: **${analysis.topPosts.length}** posts (median buzz score ${analysis.topMedianScore})`,
    `- Median buzz score across the set: **${analysis.medianScore}**`,
  ];

  if (lowConfidence > 0) {
    lines.push(
      `- ⚠️ ${lowConfidence} post(s) had neither impressions nor follower counts, so they were ` +
        'ranked on raw interaction volume alone. Adding those numbers materially improves the ranking.',
    );
  }

  return lines.join('\n');
}

function formatSignaturePatterns(analysis: BuzzPatternAnalysis): string {
  if (analysis.signaturePatterns.length === 0) {
    return [
      'No trait stood out in the top cohort. The high performers are structurally similar to the',
      'rest of the set, which usually means the difference is in the topic or the timing rather',
      'than the format — or that the reference set is too small or too uniform.',
    ].join('\n');
  }

  return [
    '| Pattern | In top cohort | Across set | Lift |',
    '| --- | --- | --- | --- |',
    ...analysis.signaturePatterns.map(
      (pattern) =>
        `| ${pattern.label} | ${formatShare(pattern.topShare)} (${pattern.topCount}/${analysis.topPosts.length}) ` +
        `| ${formatShare(pattern.overallShare)} | ${formatLift(pattern)} |`,
    ),
  ].join('\n');
}

function formatLengthProfile(analysis: BuzzPatternAnalysis): string {
  const { lengthProfile } = analysis;
  return [
    '| Measure | Top cohort | Whole set |',
    '| --- | --- | --- |',
    `| Median weighted length | ${lengthProfile.topMedianWeightedLength} | ${lengthProfile.overallMedianWeightedLength} |`,
    `| Median line count | ${lengthProfile.topMedianLineCount} | ${lengthProfile.overallMedianLineCount} |`,
    '',
    'Weighted length is how X counts a post: Japanese characters and emoji cost 2, Latin characters',
    'cost 1, and the limit is 280.',
  ].join('\n');
}

function formatRanking(analysis: BuzzPatternAnalysis): string {
  return [
    '| # | Score | Confidence | Author | Strongest signal | Excerpt |',
    '| --- | --- | --- | --- | --- | --- |',
    ...analysis.rankedPosts.map((post, index) => formatRankingRow(post, index)),
  ].join('\n');
}

function formatRankingRow(post: BuzzPost, index: number): string {
  const score = post.score();
  const strongest = score.strongestSignal();
  const signal = strongest ? strongest.label.replace(/\s*\(.*\)$/u, '') : '—';
  return (
    `| ${index + 1} | ${score.value} | ${score.confidence} | ${escapeCell(post.describeAuthor())} ` +
    `| ${escapeCell(signal)} | ${escapeCell(post.excerpt(90))} |`
  );
}

function formatHooks(analysis: BuzzPatternAnalysis): string {
  if (analysis.hooks.length === 0) return '_No hooks available._';
  return analysis.hooks.map((hook) => `- ${hook}`).join('\n');
}

function formatAllTraits(analysis: BuzzPatternAnalysis): string {
  return [
    '| Trait | In top cohort | Across set |',
    '| --- | --- | --- |',
    ...analysis.allPatterns.map(
      (pattern) =>
        `| ${pattern.label} | ${formatShare(pattern.topShare)} | ${formatShare(pattern.overallShare)} |`,
    ),
  ].join('\n');
}

function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function formatLift(pattern: TraitPattern): string {
  if (!Number.isFinite(pattern.lift)) return 'only in top';
  return `${pattern.lift.toFixed(1)}x`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\n/gu, ' ');
}
