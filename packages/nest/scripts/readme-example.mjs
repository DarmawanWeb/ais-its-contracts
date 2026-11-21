#!/usr/bin/env node
/**
 * Verifies the "complete minimal service" of README.md as a consumer gets it:
 * every fenced block whose first line names a file (`// src/…`, `-- migrations/…`,
 * `// tsconfig.json`, `// vitest.config.ts`, `// test/…`) is written into a new
 * pnpm project, the README's own `pnpm add` commands are run with the packed
 * tarballs of this repository in place of the registry packages, then the
 * project is type-checked and built, `openapi.json` is exported without any
 * infrastructure, and its tests run (the integration test needs Docker).
 *
 *   node scripts/readme-example.mjs [targetDir] [--no-docker]
 *
 * Requires `pnpm build` of both packages first. Exit code 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = resolve(packageDir, '..', 'contracts');
const args = process.argv.slice(2);
const docker = !args.includes('--no-docker');
const target = resolve(
  args.find((arg) => !arg.startsWith('--')) ??
    join(tmpdir(), 'aisits-readme-example'),
);

const readme = readFileSync(join(packageDir, 'README.md'), 'utf8');
const FILE_LINE =
  /^(?:\/\/|--)\s+((?:src|test|migrations)\/[\w./-]+|tsconfig(?:\.build)?\.json|vitest\.config\.ts)(?:\s|$)/;

/** `[path, content]` of every README block that names its file. */
function exampleFiles() {
  const files = new Map();
  for (const match of readme.matchAll(/```[\w-]*\n([\s\S]*?)```/g)) {
    const body = match[1];
    const path = FILE_LINE.exec(body.split('\n', 1)[0] ?? '')?.[1];
    if (path === undefined) continue;
    if (files.has(path)) throw new Error(`README shows ${path} twice`);
    files.set(path, body);
  }
  return files;
}

/** The packages of the README's `pnpm add` commands: `{ prod, dev }`. */
function installCommands() {
  const block = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .find((body) => body.includes('pnpm add'));
  if (block === undefined) throw new Error('README has no pnpm add command');
  const commands = block.replaceAll('\\\n', ' ').split('\n');
  const prod = [];
  const dev = [];
  for (const command of commands) {
    const words = command.trim().split(/\s+/);
    if (words[0] !== 'pnpm' || words[1] !== 'add') continue;
    const isDev = words.includes('-D');
    for (const word of words.slice(2)) {
      if (word.startsWith('-')) continue;
      (isDev ? dev : prod).push(word);
    }
  }
  return { prod, dev };
}

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, {
    cwd: target,
    stdio: 'inherit',
    env: { ...process.env, TESTCONTAINERS_RYUK_DISABLED: 'true' },
    ...options,
  });
}

/** Packs a workspace package into `<target>/.packs` and returns the tarball path. */
function pack(dir) {
  const destination = join(target, '.packs');
  mkdirSync(destination, { recursive: true });
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: dir,
    stdio: 'ignore',
  });
  const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    .name.replace('@', '')
    .replace('/', '-');
  const tarball = readdirSync(destination).find(
    (file) => file.startsWith(name) && file.endsWith('.tgz'),
  );
  if (tarball === undefined) throw new Error(`pnpm pack of ${dir} failed`);
  return `file:./.packs/${tarball}`;
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const files = exampleFiles();
for (const required of [
  'tsconfig.json',
  'tsconfig.build.json',
  'migrations/0001_init.sql',
  'src/app.module.ts',
  'src/events/surveillance-events.repository.ts',
  'src/detectors/geofence.detector.ts',
]) {
  if (!files.has(required)) throw new Error(`README does not show ${required}`);
}
for (const [path, content] of files) {
  mkdirSync(dirname(join(target, path)), { recursive: true });
  writeFileSync(join(target, path), content);
}

const local = {
  '@darmawanweb/ais-its-contracts': pack(contractsDir),
  '@darmawanweb/ais-its-nest': pack(packageDir),
};
writeFileSync(
  join(target, 'package.json'),
  `${JSON.stringify(
    {
      name: 'aisits-readme-example',
      private: true,
      type: 'module',
      scripts: {
        build: 'tsc -p tsconfig.build.json',
        openapi: 'node dist/openapi.js',
        test: 'vitest run',
      },
      pnpm: { overrides: local },
    },
    null,
    2,
  )}\n`,
);
const { prod, dev } = installCommands();
const resolveLocal = (spec) => {
  const name = spec.replace(/(?<=.)@.*$/, '');
  return name in local ? `${name}@${local[name]}` : spec;
};
console.log(`README example: ${files.size} files in ${target}`);
run('pnpm', ['add', ...prod.map(resolveLocal)]);
run('pnpm', ['add', '-D', ...dev.map(resolveLocal)]);
run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']);
run('pnpm', ['run', 'build']);
run('pnpm', ['run', 'openapi']);
if (!existsSync(join(target, 'openapi.json')))
  throw new Error('openapi.json was not written');
run('pnpm', [
  'exec',
  'vitest',
  'run',
  ...(docker ? [] : ['--exclude', 'test/**']),
]);
console.log('\nREADME example verified.');
