/**
 * Minimal RFC 4180 CSV reader.
 *
 * Hand-collected reference sets routinely contain post text with commas,
 * newlines and quotes in it, so splitting on `,` is not an option and a real
 * (if small) parser is warranted.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let insideQuotes = false;
  let fieldStarted = false;

  const text = input.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n');

  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };

  const endRow = (): void => {
    endField();
    // A trailing newline would otherwise append a phantom single-empty-field row.
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;

    if (insideQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && !fieldStarted) {
      insideQuotes = true;
      fieldStarted = true;
    } else if (character === ',') {
      endField();
    } else if (character === '\n') {
      endRow();
    } else {
      field += character;
      fieldStarted = true;
    }
  }

  if (insideQuotes) {
    throw new Error('CSV ended inside a quoted field — check for an unbalanced double quote.');
  }
  if (field !== '' || row.length > 0) endRow();

  return rows;
}
