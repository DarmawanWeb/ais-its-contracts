/**
 * Verifies the methodology catalog against the code (spec 17): every
 * `implemented` method of `docs/references/methods.json` names an existing
 * module and symbol (`implementedBy`) that carries its `@method` tag, and every
 * `@method` tag below `<root>/src` names a catalog method marked `implemented`.
 * Fails (exit code 1) on any problem, e.g. in the CI of the central repository.
 *
 * Usage: `tsx scripts/verify-references.ts [--services <dir>] [--from <dir>]
 * [--package <name>=<dir> ...]`. Every subdirectory of `--services` (default:
 * `services` of the central repository) is a root named by the directory;
 * this package is the root `contracts`; `--package` adds further roots (e.g.
 * `--package nest=../nest`). `--from` is the catalog directory (default:
 * `docs/references` of the central repository).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  serviceRoots,
  verifyImplementations,
} from './lib/implementations-verify.js';
import { readCatalog } from './lib/references-sync.js';

const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CENTRAL_DIR = path.resolve(PACKAGE_DIR, '../../../..');

/** `name=dir` of a `--package` option, or `null` when malformed. */
function parsePackageOption(value: string): [string, string] | null {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) return null;
  return [value.slice(0, separator), path.resolve(value.slice(separator + 1))];
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      services: { type: 'string' },
      from: { type: 'string' },
      package: { type: 'string', multiple: true, default: [] },
    },
  });
  const sourceDir = path.resolve(
    values.from ?? path.join(CENTRAL_DIR, 'docs/references'),
  );
  const servicesDir = path.resolve(
    values.services ?? path.join(CENTRAL_DIR, 'services'),
  );

  const read = await readCatalog(sourceDir);
  switch (read.kind) {
    case 'missing':
      console.error(
        `Methodology catalog not found:\n${read.files.join('\n')}\nRun inside the central repository or pass --from <dir>.`,
      );
      return 1;
    case 'invalid':
      console.error(
        `Methodology catalog in ${sourceDir} is invalid:\n${read.issues
          .map((issue) => `- ${issue.field}: ${issue.message}`)
          .join('\n')}`,
      );
      return 1;
    case 'valid':
      break;
  }

  let roots: Map<string, string>;
  try {
    roots = await serviceRoots(servicesDir);
  } catch (error) {
    console.error(
      `Cannot read the services directory ${servicesDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  roots.set('contracts', PACKAGE_DIR);
  for (const option of values.package) {
    const entry = parsePackageOption(option);
    if (entry === null) {
      console.error(`--package expects <name>=<dir>, got "${option}"`);
      return 1;
    }
    roots.set(...entry);
  }

  const report = await verifyImplementations({ catalog: read.catalog, roots });
  const summary = `${report.implemented} implemented methods, ${report.tags.length} @method tags in ${roots.size} roots (${[...roots.keys()].sort().join(', ')})`;
  if (report.issues.length > 0) {
    console.error(
      `Methodology catalog and code disagree (${report.issues.length} problem(s); ${summary}):\n${report.issues
        .map((issue) => `- [${issue.code}] ${issue.location}: ${issue.message}`)
        .join('\n')}`,
    );
    return 1;
  }
  console.log(`Methodology catalog matches the code: ${summary}.`);
  return 0;
}

process.exitCode = await main();
