import path from 'node:path';

import { format, resolveConfig } from 'prettier';

/**
 * Formats generated text with the repository Prettier configuration, as if it
 * were saved at `filepath` (the extension selects the parser).
 */
export async function prettify(
  filepath: string,
  text: string,
): Promise<string> {
  const absolute = path.resolve(filepath);
  const options = (await resolveConfig(absolute)) ?? {};
  return format(text, { ...options, filepath: absolute });
}
