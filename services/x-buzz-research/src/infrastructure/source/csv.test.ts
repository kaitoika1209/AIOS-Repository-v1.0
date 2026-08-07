import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';

describe('parseCsv', () => {
  it('parses a plain table', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps commas and newlines inside quoted fields', () => {
    expect(parseCsv('text,likes\n"一行目\n二行目, ですね",10')).toEqual([
      ['text', 'likes'],
      ['一行目\n二行目, ですね', '10'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('text\n"彼は""はい""と言った"')).toEqual([['text'], ['彼は"はい"と言った']]);
  });

  it('ignores a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toHaveLength(2);
  });

  it('normalises CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    expect(parseCsv('﻿text,likes\nhi,1')[0]?.[0]).toBe('text');
  });

  it('preserves empty fields', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('rejects an unbalanced quote rather than silently truncating', () => {
    expect(() => parseCsv('text\n"unterminated')).toThrow(/unbalanced double quote/u);
  });
});
