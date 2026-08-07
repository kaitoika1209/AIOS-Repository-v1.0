import { describe, expect, it } from 'vitest';
import { analyzeStructure, isWithinPostLimit, weightedLengthOf } from './post-structure.ts';

describe('weightedLengthOf', () => {
  it('counts Latin characters as one unit', () => {
    expect(weightedLengthOf('hello')).toBe(5);
  });

  it('counts Japanese characters as two units', () => {
    expect(weightedLengthOf('こんにちは')).toBe(10);
  });

  it('counts emoji as two units', () => {
    expect(weightedLengthOf('🎉')).toBe(2);
  });

  it('allows 280 Latin characters but only 140 Japanese ones', () => {
    expect(isWithinPostLimit('a'.repeat(280))).toBe(true);
    expect(isWithinPostLimit('a'.repeat(281))).toBe(false);
    expect(isWithinPostLimit('あ'.repeat(140))).toBe(true);
    expect(isWithinPostLimit('あ'.repeat(141))).toBe(false);
  });
});

describe('analyzeStructure', () => {
  it('reads the opening line as the hook and ignores blank lines', () => {
    const structure = analyzeStructure('\n\n最初の一行\n\n次の段落');
    expect(structure.openingLine).toBe('最初の一行');
    expect(structure.lineCount).toBe(2);
    expect(structure.paragraphCount).toBe(2);
  });

  it('detects a list only when at least two lines are marked', () => {
    expect(analyzeStructure('・ひとつだけ\n本文').traits.hasList).toBe(false);
    expect(analyzeStructure('・ひとつ\n・ふたつ').traits.hasList).toBe(true);
    expect(analyzeStructure('1. ひとつ\n2. ふたつ').traits.hasList).toBe(true);
  });

  it('detects full-width question marks, hashtags and mentions', () => {
    const structure = analyzeStructure('なぜ売れないのか？ @someone #個人開発');
    expect(structure.traits.hasQuestion).toBe(true);
    expect(structure.traits.hasMention).toBe(true);
    expect(structure.traits.hasHashtag).toBe(true);
    expect(structure.hashtagCount).toBe(1);
  });

  it('recognises Japanese and English calls to action', () => {
    expect(analyzeStructure('参考になったら保存してください').traits.hasCallToAction).toBe(true);
    expect(analyzeStructure('Save this for later').traits.hasCallToAction).toBe(true);
    expect(analyzeStructure('今日は雨だった').traits.hasCallToAction).toBe(false);
  });

  it('classifies length against the weighted thresholds', () => {
    expect(analyzeStructure('短い').traits.isShort).toBe(true);
    expect(analyzeStructure('あ'.repeat(120)).traits.isLong).toBe(true);
  });

  it('treats CRLF input the same as LF', () => {
    expect(analyzeStructure('一行目\r\n二行目').lineCount).toBe(2);
  });
});
