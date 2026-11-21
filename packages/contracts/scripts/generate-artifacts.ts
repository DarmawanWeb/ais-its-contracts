/**
 * Generates the derived, committed artifacts of the contracts package:
 *
 * - `schemas/<event type>.json` — JSON Schema (draft 2020-12) of every event
 *   payload, plus `schemas/event-envelope.json`;
 * - `asyncapi.json` — AsyncAPI 3.0 document (channels, messages, operations);
 * - the catalog tables of `README.md` (events, streams, consumers, permissions).
 *
 * Usage: `tsx scripts/generate-artifacts.ts [--check]`. With `--check` nothing
 * is written and the exit code is 1 when an artifact is missing or outdated.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';
import * as z from 'zod';

import { buildAsyncApiDocument } from './lib/asyncapi.js';
import { jsonSchemaFiles } from './lib/json-schemas.js';
import {
  README_SECTIONS,
  replaceGeneratedSection,
} from './lib/readme-catalog.js';

const PACKAGE_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCHEMAS_DIR = 'schemas';

const PackageJsonSchema = z.object({ version: z.string().min(1) });

async function prettify(relativePath: string, text: string): Promise<string> {
  const filepath = path.join(PACKAGE_DIR, relativePath);
  const options = (await resolveConfig(filepath)) ?? {};
  return format(text, { ...options, filepath });
}

async function readIfExists(relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(PACKAGE_DIR, relativePath), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Every generated file (relative path → formatted content). */
async function renderArtifacts(): Promise<Map<string, string>> {
  const packageJson = PackageJsonSchema.parse(
    JSON.parse(await readFile(path.join(PACKAGE_DIR, 'package.json'), 'utf8')),
  );
  const artifacts = new Map<string, string>();

  for (const [file, schema] of jsonSchemaFiles()) {
    const relativePath = path.posix.join(SCHEMAS_DIR, file);
    artifacts.set(
      relativePath,
      await prettify(relativePath, JSON.stringify(schema)),
    );
  }

  const asyncapi = buildAsyncApiDocument({ version: packageJson.version });
  artifacts.set(
    'asyncapi.json',
    await prettify('asyncapi.json', JSON.stringify(asyncapi)),
  );

  let readme = (await readIfExists('README.md')) ?? '';
  for (const [name, render] of Object.entries(README_SECTIONS)) {
    readme = replaceGeneratedSection(readme, name, render());
  }
  artifacts.set('README.md', await prettify('README.md', readme));
  return artifacts;
}

/** Generated schema files that no longer correspond to an event type. */
async function staleSchemaFiles(
  artifacts: Map<string, string>,
): Promise<string[]> {
  const existing = await readdir(path.join(PACKAGE_DIR, SCHEMAS_DIR)).catch(
    () => [],
  );
  return existing
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.posix.join(SCHEMAS_DIR, file))
    .filter((file) => !artifacts.has(file));
}

async function main(): Promise<number> {
  const check = process.argv.includes('--check');
  const artifacts = await renderArtifacts();
  const stale = await staleSchemaFiles(artifacts);

  const changed: string[] = [];
  for (const [relativePath, content] of artifacts) {
    if ((await readIfExists(relativePath)) !== content)
      changed.push(relativePath);
  }

  if (check) {
    const problems = [
      ...changed.map((file) => `outdated: ${file}`),
      ...stale.map((file) => `stale: ${file}`),
    ];
    if (problems.length > 0) {
      console.error(
        `Generated artifacts are not up to date; run "pnpm run schemas".\n${problems.join('\n')}`,
      );
      return 1;
    }
    console.log(`All ${artifacts.size} generated artifacts are up to date.`);
    return 0;
  }

  await mkdir(path.join(PACKAGE_DIR, SCHEMAS_DIR), { recursive: true });
  for (const relativePath of changed) {
    const content = artifacts.get(relativePath);
    if (content !== undefined) {
      await writeFile(path.join(PACKAGE_DIR, relativePath), content);
    }
  }
  for (const relativePath of stale) {
    await rm(path.join(PACKAGE_DIR, relativePath));
  }
  console.log(
    `Generated ${artifacts.size} artifacts (${changed.length} written, ${stale.length} removed).`,
  );
  return 0;
}

process.exitCode = await main();
