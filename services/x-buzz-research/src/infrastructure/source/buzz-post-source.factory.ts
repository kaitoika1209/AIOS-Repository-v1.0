import { extname } from 'node:path';
import type { BuzzPostSource } from '../../domain/buzz-post-source.ts';
import { CsvFileBuzzPostSource } from './csv-file.buzz-post-source.ts';
import { JsonFileBuzzPostSource } from './json-file.buzz-post-source.ts';

/**
 * Picks a source implementation from the file extension.
 *
 * When an X API adapter is added, this is the only place that has to learn
 * about it — the use cases depend on the port, not on these classes.
 */
export function createBuzzPostSource(filePath: string): BuzzPostSource {
  const extension = extname(filePath).toLowerCase();

  switch (extension) {
    case '.json':
      return new JsonFileBuzzPostSource(filePath);
    case '.csv':
      return new CsvFileBuzzPostSource(filePath);
    default:
      throw new Error(
        `Unsupported input "${filePath}". Use a .json or .csv file of collected posts.`,
      );
  }
}
