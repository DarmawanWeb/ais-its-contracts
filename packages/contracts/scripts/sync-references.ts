/**
 * Copies the methodology catalog of the central repository into the package
 * (spec 17): `docs/references/references.json` and `methods.json` are
 * validated (zod schemas, unique ids, no dangling `referenceIds`, every method
 * cites a source or is marked `needsCitation`) and written as the data modules
 * `src/references/data/{references,methods}.ts` behind `REFERENCES` / `METHODS`.
 *
 * Usage: `tsx scripts/sync-references.ts [--from <dir>] [--check]`. The source
 * directory defaults to `docs/references` of the central repository, in which
 * this repository is checked out at `packages/ais-its-contracts`. With
 * `--check` nothing is written and the exit code is 1 when the data modules
 * are outdated.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { syncReferences } from './lib/references-sync.js';

const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_SOURCE_DIR = path.resolve(
  PACKAGE_DIR,
  '../../../../docs/references',
);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  const sourceDir = path.resolve(values.from ?? DEFAULT_SOURCE_DIR);
  const outcome = await syncReferences({
    sourceDir,
    packageDir: PACKAGE_DIR,
    check: values.check,
  });

  switch (outcome.kind) {
    case 'missing':
      console.error(
        `Methodology catalog not found:\n${outcome.files.join('\n')}\nRun inside the central repository or pass --from <dir>.`,
      );
      return 1;
    case 'invalid':
      console.error(
        `Methodology catalog in ${sourceDir} is invalid:\n${outcome.issues
          .map((issue) => `- ${issue.field}: ${issue.message}`)
          .join('\n')}`,
      );
      return 1;
    case 'checked':
      if (outcome.changed.length > 0) {
        console.error(
          `Data modules are outdated; run "pnpm run references:sync".\n${outcome.changed.join('\n')}`,
        );
        return 1;
      }
      console.log(
        `Methodology data modules are up to date (${outcome.references} references, ${outcome.methods} methods).`,
      );
      return 0;
    case 'synced':
      console.log(
        `Synced ${outcome.references} references and ${outcome.methods} methods from ${sourceDir} (${outcome.changed.length} module(s) written).`,
      );
      return 0;
  }
}

process.exitCode = await main();
