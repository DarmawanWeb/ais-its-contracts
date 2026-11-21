#!/usr/bin/env node
/**
 * API report of the published package: every export (value or type) of
 * every public subpath, read from the built declaration files with the
 * TypeScript compiler. `node scripts/api-report.mjs` writes
 * `etc/api-report.json`; `--check` (CI) fails when the built API differs
 * from the committed report, so that accidental additions, removals and
 * value/type changes are reviewed (and semver decided) explicitly.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = join(root, 'etc', 'api-report.json');
const check = process.argv.includes('--check');

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const entries = Object.entries(manifest.exports)
  .filter(([, target]) => typeof target === 'object' && target.types)
  .map(([subpath, target]) => [subpath, join(root, target.types)]);

const program = ts.createProgram(
  entries.map(([, file]) => file),
  {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    skipLibCheck: true,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();

/** `value`, `type` or `value+type` (a class or an enum is both). */
function kindOf(symbol) {
  const target =
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const value = (target.flags & ts.SymbolFlags.Value) !== 0;
  const type = (target.flags & ts.SymbolFlags.Type) !== 0;
  return value && type ? 'value+type' : value ? 'value' : 'type';
}

const report = {};
for (const [subpath, file] of entries) {
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error(`Missing ${file}: build first`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  const exports =
    moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol);
  report[subpath] = Object.fromEntries(
    exports
      .map((symbol) => [symbol.getName(), kindOf(symbol)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
const text = `${JSON.stringify(report, null, 2)}\n`;

if (!check) {
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, text);
  const count = Object.values(report).reduce(
    (n, names) => n + Object.keys(names).length,
    0,
  );
  console.log(
    `API report: ${count} exports in ${entries.length} subpaths -> etc/api-report.json`,
  );
} else {
  const committed = JSON.parse(
    await readFile(reportFile, 'utf8').catch(() => '{}'),
  );
  const problems = [];
  for (const subpath of new Set([
    ...Object.keys(committed),
    ...Object.keys(report),
  ])) {
    const before = committed[subpath] ?? {};
    const after = report[subpath] ?? {};
    for (const name of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      if (before[name] === after[name]) continue;
      if (before[name] === undefined)
        problems.push(`+ ${subpath} ${name} (${after[name]})`);
      else if (after[name] === undefined)
        problems.push(`- ${subpath} ${name} (${before[name]})`);
      else
        problems.push(
          `~ ${subpath} ${name} (${before[name]} -> ${after[name]})`,
        );
    }
  }
  if (problems.length > 0) {
    console.error(
      `The public API differs from etc/api-report.json (${problems.length} change(s)):\n` +
        `${problems.join('\n')}\nReview the change (semver!), then run "pnpm api:report" and commit the report.`,
    );
    process.exit(1);
  }
  console.log('API report up to date');
}
