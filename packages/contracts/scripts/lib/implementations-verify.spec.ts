import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type MethodologyCatalog,
  validateCatalog,
} from '../../src/references/catalog.js';
import type { MethodInput } from '../../src/references/schemas.js';
import {
  IMPLEMENTATION_ISSUE_CODES as CODES,
  parseImplementationModule,
  scanSource,
  serviceRoots,
  verifyImplementations,
} from './implementations-verify.js';

const PACKAGE_DIR = path.resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
);

const lines = (...text: string[]): string => text.join('\n');

describe('scanSource', () => {
  const source = lines(
    '/**',
    ' * Module header.',
    ' * @method mod.level',
    ' */',
    "import { x } from 'y';",
    '',
    '/**',
    ' * Documented function.',
    ' *',
    ' * @method a.top (a remark after the id)',
    ' * @methodology is another tag, not a method tag',
    ' */',
    'export function topLevel(): number {',
    '  return 1;',
    '}',
    '',
    '/** @method b.cls */',
    '@Injectable()',
    'export class Detector {',
    '  constructor(',
    '    @Inject(TOKEN) private readonly dep: Dep,',
    '  ) {}',
    '',
    '  /**',
    '   * @method c.member',
    '   */',
    '  @Get({',
    "    path: ':id',",
    '  })',
    '  async handle(input: string): Promise<void> {',
    '    if (input) {',
    '      run(input);',
    '    }',
    '  }',
    '',
    '  static fromJson(json: unknown): Detector {',
    '    return new Detector(json);',
    '  }',
    '}',
    '',
    '/** @method d.const */',
    'export const TABLE = Object.freeze({',
    '  /** @method e.entry */',
    '  first: 1,',
    '});',
    '// @method f.line',
    'const local = 2;',
    '/** Prose about the methodology page and `@method` tags. */',
    'export type Alias = string;',
    '/**',
    ' * @method',
    ' * @method Not-An-Id',
    ' */',
  );
  const scan = scanSource(source);

  it('attaches every tag to the declaration its comment documents', () => {
    expect(scan.tags).toEqual([
      { id: 'mod.level', line: 3, symbol: null },
      { id: 'a.top', line: 10, symbol: 'topLevel' },
      { id: 'b.cls', line: 17, symbol: 'Detector' },
      { id: 'c.member', line: 25, symbol: 'Detector.handle' },
      { id: 'd.const', line: 41, symbol: 'TABLE' },
      { id: 'e.entry', line: 43, symbol: 'TABLE.first' },
      { id: 'f.line', line: 46, symbol: 'local' },
      { id: '', line: 51, symbol: null },
      { id: 'Not-An-Id', line: 52, symbol: null },
    ]);
  });

  it('collects top-level declarations and members, not statements', () => {
    expect([...scan.declarations].sort()).toEqual([
      'Alias',
      'Detector',
      'Detector.constructor',
      'Detector.fromJson',
      'Detector.handle',
      'TABLE',
      'TABLE.first',
      'local',
      'topLevel',
    ]);
  });

  it('detaches tags from a comment followed by another doc comment', () => {
    const detached = scanSource(
      lines('/** @method one.a */', '', '/** Doc. */', 'export const y = 1;'),
    );
    expect(detached.tags).toEqual([{ id: 'one.a', line: 1, symbol: null }]);
  });
});

describe('parseImplementationModule', () => {
  it('parses a path, an optional symbol and an optional remark', () => {
    expect(parseImplementationModule('src/domain/cii.ts#attainedCii')).toEqual({
      path: 'src/domain/cii.ts',
      symbol: 'attainedCii',
      remark: null,
    });
    expect(
      parseImplementationModule(
        'src/shared/domain/coastline.ts#CoastlineGeometry.distanceM',
      ),
    ).toEqual({
      path: 'src/shared/domain/coastline.ts',
      symbol: 'CoastlineGeometry.distanceM',
      remark: null,
    });
    expect(
      parseImplementationModule(
        'src/domain/seemp/measures.ts#LEGACY_SEEMP_MEASURES (seemp_measures seed: lng)',
      ),
    ).toEqual({
      path: 'src/domain/seemp/measures.ts',
      symbol: 'LEGACY_SEEMP_MEASURES',
      remark: 'seemp_measures seed: lng',
    });
    expect(
      parseImplementationModule('data/coastline.geojson (loaded once)'),
    ).toEqual({
      path: 'data/coastline.geojson',
      symbol: null,
      remark: 'loaded once',
    });
  });

  it('refuses free text, absolute paths and paths leaving the root', () => {
    for (const module of [
      'cii_annual_manual table (fallback)',
      'seed:demo (demo vessel) + golden parity tests',
      '/abs/src/x.ts',
      '../other/src/x.ts',
      'src//x.ts',
      'src/x.ts#',
      'src/x.ts#a b',
      'src/x.ts#a..b',
      '',
    ]) {
      expect(parseImplementationModule(module), module).toBeNull();
    }
  });
});

/** A catalog method with the members verify reads. */
const method = (
  id: string,
  status: string,
  implementedBy: { service: string; module: string } | null,
): MethodInput => ({
  id,
  domain: 'geo',
  name: { id: id, en: id },
  summary: { id: id, en: id },
  status,
  implementedBy,
  needsCitation: true,
});

const catalogOf = (methods: readonly MethodInput[]): MethodologyCatalog => {
  const result = validateCatalog({ references: [], methods });
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  return result.catalog;
};

describe('verifyImplementations', () => {
  let workDir: string;
  let servicesDir: string;
  let contractsDir: string;
  let brokenDir: string;
  let roots: Map<string, string>;

  const write = async (file: string, content: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'kit-implementations-'));
    servicesDir = path.join(workDir, 'services');
    contractsDir = path.join(workDir, 'contracts');
    brokenDir = path.join(workDir, 'broken');
    const alpha = path.join(servicesDir, 'alpha');
    await write(path.join(alpha, 'package.json'), '{}');
    await write(
      path.join(alpha, 'src/domain/rules.ts'),
      lines(
        '/**',
        ' * Rules of alpha.',
        ' * @method alpha.module',
        ' */',
        "import { z } from 'zod';",
        '',
        '/**',
        ' * @method alpha.rule',
        ' * @method iota.wrong_symbol',
        ' */',
        'export function ruleOf(value: number): number {',
        '  return value;',
        '}',
        '',
        '/** @method alpha.class */',
        'export class Klass {',
        '  run(): void {}',
        '}',
        '',
        '/** Untagged helper. */',
        'export function helper(): void {}',
      ),
    );
    // Tests and fixtures are not scanned.
    await write(
      path.join(alpha, 'src/domain/rules.spec.ts'),
      '/** @method spec.only */\nexport const x = 1;\n',
    );
    await write(
      path.join(alpha, 'src/__fixtures__/sample.ts'),
      '/** @method fixture.only */\nexport const y = 1;\n',
    );
    await write(
      path.join(servicesDir, 'beta/src/index.ts'),
      lines(
        '/** @method beta.planned */',
        'export function later(): void {}',
        '/** @method lambda.deprecated */',
        'export function old(): void {}',
      ),
    );
    await mkdir(path.join(servicesDir, 'not-a-service/docs'), {
      recursive: true,
    });
    await mkdir(path.join(servicesDir, '.hidden/src'), { recursive: true });
    await write(
      path.join(contractsDir, 'src/domain/geo.ts'),
      '/** @method contracts.geo */\nexport function distance(): number {\n  return 0;\n}\n',
    );
    await write(
      path.join(brokenDir, 'src/tags.ts'),
      lines(
        '/**',
        ' * @method',
        ' * @method Not-An-Id',
        ' * @method ghost.method',
        ' */',
        'export const nothing = 0;',
      ),
    );
    roots = await serviceRoots(servicesDir);
    roots.set('contracts', contractsDir);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const CONSISTENT: readonly MethodInput[] = [
    method('alpha.rule', 'implemented', {
      service: 'alpha',
      module: 'src/domain/rules.ts#ruleOf',
    }),
    method('alpha.class', 'implemented', {
      service: 'alpha',
      module: 'src/domain/rules.ts#Klass.run (the class carries the tag)',
    }),
    method('alpha.module', 'implemented', {
      service: 'alpha',
      module: 'src/domain/rules.ts',
    }),
    method('contracts.geo', 'implemented', {
      service: 'contracts',
      module: 'src/domain/geo.ts#distance',
    }),
    method('kappa.dropped', 'not_implemented', null),
    method('lambda.deprecated', 'deprecated', null),
    method('beta.planned', 'implemented', {
      service: 'beta',
      module: 'src/index.ts#later',
    }),
    method('iota.wrong_symbol', 'implemented', {
      service: 'alpha',
      module: 'src/domain/rules.ts#ruleOf',
    }),
  ];

  /** `CONSISTENT` with the entries of `replacements` swapped in by id. */
  const withChanges = (
    ...replacements: readonly MethodInput[]
  ): MethodInput[] => {
    const ids = new Set(replacements.map((entry) => entry.id));
    return [
      ...CONSISTENT.filter((entry) => !ids.has(entry.id)),
      ...replacements,
    ];
  };

  it('finds the service roots of a services directory', async () => {
    expect([...(await serviceRoots(servicesDir)).keys()]).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('accepts a catalog that agrees with the code', async () => {
    const report = await verifyImplementations({
      catalog: catalogOf(CONSISTENT),
      roots,
    });
    expect(report.issues).toEqual([]);
    expect(report.implemented).toBe(6);
    expect(report.tags.map((tag) => `${tag.service}:${tag.id}`)).toEqual([
      'alpha:alpha.module',
      'alpha:alpha.rule',
      'alpha:iota.wrong_symbol',
      'alpha:alpha.class',
      'beta:beta.planned',
      'beta:lambda.deprecated',
      'contracts:contracts.geo',
    ]);
  });

  it('reports every disagreement with a code, the method and where', async () => {
    const report = await verifyImplementations({
      catalog: catalogOf(
        withChanges(
          // A planned method that the code tags never passes.
          method('beta.planned', 'planned', {
            service: 'beta',
            module: 'src/index.ts#later',
          }),
          method('gamma.no_owner', 'implemented', null),
          method('delta.service', 'implemented', {
            service: 'delta',
            module: 'src/x.ts#x',
          }),
          method('eps.malformed', 'implemented', {
            service: 'alpha',
            module: 'cii_annual_manual table (fallback)',
          }),
          method('zeta.missing_module', 'implemented', {
            service: 'alpha',
            module: 'src/domain/missing.ts#x',
          }),
          method('eta.missing_symbol', 'implemented', {
            service: 'alpha',
            module: 'src/domain/rules.ts#nope',
          }),
          method('theta.untagged', 'implemented', {
            service: 'alpha',
            module: 'src/domain/rules.ts#helper',
          }),
          method('iota.wrong_symbol', 'implemented', {
            service: 'alpha',
            module: 'src/domain/rules.ts#helper',
          }),
        ),
      ),
      roots: new Map([...roots, ['broken', brokenDir]]),
    });
    expect(
      report.issues.map(({ code, methodId, location }) => ({
        code,
        methodId,
        location,
      })),
    ).toEqual([
      {
        code: CODES.MALFORMED_TAG,
        methodId: null,
        location: 'broken/src/tags.ts:2',
      },
      {
        code: CODES.MALFORMED_TAG,
        methodId: null,
        location: 'broken/src/tags.ts:3',
      },
      {
        code: CODES.UNKNOWN_METHOD,
        methodId: 'ghost.method',
        location: 'broken/src/tags.ts:4',
      },
      {
        code: CODES.STALE_STATUS,
        methodId: 'beta.planned',
        location: 'methods.json#beta.planned',
      },
      {
        code: CODES.MISSING_IMPLEMENTATION,
        methodId: 'gamma.no_owner',
        location: 'methods.json#gamma.no_owner',
      },
      {
        code: CODES.UNKNOWN_SERVICE,
        methodId: 'delta.service',
        location: 'methods.json#delta.service',
      },
      {
        code: CODES.MALFORMED_MODULE,
        methodId: 'eps.malformed',
        location: 'methods.json#eps.malformed',
      },
      {
        code: CODES.MISSING_MODULE,
        methodId: 'zeta.missing_module',
        location: 'alpha/src/domain/missing.ts',
      },
      {
        code: CODES.MISSING_SYMBOL,
        methodId: 'eta.missing_symbol',
        location: 'alpha/src/domain/rules.ts',
      },
      {
        code: CODES.MISSING_TAG,
        methodId: 'theta.untagged',
        location: 'alpha/src/domain/rules.ts',
      },
      {
        code: CODES.MISSING_TAG,
        methodId: 'iota.wrong_symbol',
        location: 'alpha/src/domain/rules.ts',
      },
    ]);
    const messages = report.issues.map((issue) => issue.message);
    expect(messages).toContain(
      'Method beta.planned is "planned" but tagged in beta/src/index.ts:1; mark it implemented with implementedBy',
    );
    expect(messages).toContain(
      'alpha/src/domain/rules.ts#helper does not carry @method iota.wrong_symbol (tagged on ruleOf)',
    );
    expect(messages).toContain(
      '@method is followed by "Not-An-Id", not a catalog method id',
    );
    expect(messages).toContain(
      '@method is followed by nothing, not a catalog method id',
    );
  });

  it('runs as the references:verify CLI (exit code 1 on any problem)', async () => {
    const run = promisify(execFile);
    const docs = path.join(workDir, 'docs');
    await mkdir(docs, { recursive: true });
    await writeFile(path.join(docs, 'references.json'), '[]');
    const cli = async (
      methods: readonly MethodInput[],
      ...extra: string[]
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      await writeFile(path.join(docs, 'methods.json'), JSON.stringify(methods));
      const args = [
        '--import',
        'tsx',
        path.join(PACKAGE_DIR, 'scripts/verify-references.ts'),
        '--services',
        servicesDir,
        '--from',
        docs,
        '--package',
        `contracts=${contractsDir}`,
        ...extra,
      ];
      try {
        const { stdout, stderr } = await run(process.execPath, args, {
          cwd: PACKAGE_DIR,
        });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failure = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        return failure;
      }
    };

    const success = await cli(CONSISTENT);
    expect(success).toMatchObject({ code: 0, stderr: '' });
    expect(success.stdout).toContain(
      'Methodology catalog matches the code: 6 implemented methods, 7 @method tags in 3 roots (alpha, beta, contracts).',
    );

    const failure = await cli(
      withChanges(
        method('theta.untagged', 'implemented', {
          service: 'alpha',
          module: 'src/domain/rules.ts#helper',
        }),
      ),
      '--package',
      `broken=${brokenDir}`,
    );
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(
      '- [missing_tag] alpha/src/domain/rules.ts: alpha/src/domain/rules.ts#helper does not carry @method theta.untagged',
    );
    expect(failure.stderr).toContain(
      '- [unknown_method] broken/src/tags.ts:4: @method ghost.method names no method of the catalog',
    );

    const usage = await cli(CONSISTENT, '--package', 'nameless');
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('--package expects <name>=<dir>');
  }, 60_000);
});
