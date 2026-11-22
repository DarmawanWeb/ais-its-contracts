import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { MethodologyCatalog } from '../../src/references/catalog.js';
import { CATALOG_ID_PATTERN } from '../../src/references/ids.js';

/**
 * Checks the methodology catalog against the code that implements it
 * (spec 17): every `implemented` method names an existing module and symbol
 * that carries its `@method` TSDoc tag, and every `@method` tag in the code
 * names a catalog method that is marked `implemented`.
 *
 * `implementedBy.module` is `<path>[#<symbol>][ (<remark>)]`: a path relative
 * to the root of `implementedBy.service` (e.g. `src/domain/cii.ts`), an
 * optional declared symbol (`attainedCii`, or `Class.member` for a member of
 * a class or object) and an optional free-text remark in parentheses.
 */

/** Machine readable codes of the problems found by {@link verifyImplementations}. */
export const IMPLEMENTATION_ISSUE_CODES = {
  /** A `@method` tag names an id that is not in the catalog. */
  UNKNOWN_METHOD: 'unknown_method',
  /** A `@method` tag is not followed by a well-formed catalog id. */
  MALFORMED_TAG: 'malformed_tag',
  /** A method carries `@method` tags in the code but is not `implemented`. */
  STALE_STATUS: 'stale_status',
  /** An `implemented` method has no `implementedBy`. */
  MISSING_IMPLEMENTATION: 'missing_implementation',
  /** `implementedBy.service` is neither a scanned service nor a package. */
  UNKNOWN_SERVICE: 'unknown_service',
  /** `implementedBy.module` is not `<path>[#<symbol>][ (<remark>)]`. */
  MALFORMED_MODULE: 'malformed_module',
  /** The module file of `implementedBy` does not exist. */
  MISSING_MODULE: 'missing_module',
  /** The symbol of `implementedBy` is not declared in its module. */
  MISSING_SYMBOL: 'missing_symbol',
  /** The module (or symbol) of `implementedBy` does not carry the method's `@method` tag. */
  MISSING_TAG: 'missing_tag',
} as const;

/** A code of {@link IMPLEMENTATION_ISSUE_CODES}. */
export type ImplementationIssueCode =
  (typeof IMPLEMENTATION_ISSUE_CODES)[keyof typeof IMPLEMENTATION_ISSUE_CODES];

/** A problem found by {@link verifyImplementations}. */
export interface ImplementationIssue {
  readonly code: ImplementationIssueCode;
  /** Method concerned, or `null` for a malformed tag. */
  readonly methodId: string | null;
  /**
   * Where: `<service>/<path>:<line>` for a tag, `<service>/<path>` for a
   * module, `methods.json#<id>` for a catalog entry.
   */
  readonly location: string;
  readonly message: string;
}

/** A `@method` tag of a source file. */
export interface MethodTag {
  /** The token after `@method` (a method id when well-formed). */
  readonly id: string;
  /** One-based line of the tag. */
  readonly line: number;
  /**
   * Declaration documented by the comment holding the tag: `name` for a
   * top-level declaration, `Container.name` for a member; `null` for a
   * module-level comment (e.g. a file header followed by imports).
   */
  readonly symbol: string | null;
}

/** What {@link scanSource} found in a source file. */
export interface SourceScan {
  readonly tags: readonly MethodTag[];
  /** Declared symbols: top-level names and `Container.member` names. */
  readonly declarations: ReadonlySet<string>;
}

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;

/** A top-level (or local) declaration; group 1 is its name. */
const DECLARATION = new RegExp(
  String.raw`^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?` +
    String.raw`(?:function\s*\*?|class|interface|type|const\s+enum|enum|const|let|var|namespace)\s+(${IDENTIFIER})`,
);

/** A member of a class, interface or object literal; group 1 is its name. */
const MEMBER = new RegExp(
  String.raw`^(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|accessor|get|set)\s+)*` +
    String.raw`\*?\s*(${IDENTIFIER})\s*[?!]?\s*(?:<[^>]*>)?\s*[(:=]`,
);

/** Keywords that start a statement, never a member. */
const STATEMENT_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'throw',
  'await',
  'yield',
  'new',
  'case',
  'catch',
  'else',
  'do',
  'try',
  'delete',
  'typeof',
  'void',
  'super',
  'this',
]);

/** A `@method` tag at the start of a comment line; group 1 is the token. */
const TAG = /^(?:\/\*\*|\*|\/\/)?\s*@method(?![\w-])(?:\s+(\S+))?/;

/** Name declared by a line (without indentation), or `null`. */
function declaredName(text: string, indented: boolean): string | null {
  const declaration = DECLARATION.exec(text);
  if (declaration?.[1] !== undefined) return declaration[1];
  if (!indented) return null;
  const member = MEMBER.exec(text);
  const name = member?.[1];
  return name === undefined || STATEMENT_KEYWORDS.has(name) ? null : name;
}

/** Parenthesis balance of a line (strings are not parsed). */
function parenthesisBalance(text: string): number {
  let balance = 0;
  for (const character of text) {
    if (character === '(') balance += 1;
    else if (character === ')') balance -= 1;
  }
  return balance;
}

/** The token of a tag without a trailing comment end or punctuation. */
function tagToken(raw: string): string {
  return raw.replace(/\*\/$/, '').replace(/[.,;:]$/, '');
}

/**
 * Scans a TypeScript or JavaScript source for `@method` tags and declared
 * symbols. Line based (the code is expected to be formatted, one declaration
 * per line): a comment documents the declaration that directly follows it,
 * after blank lines and decorators; a member's container is the nearest
 * preceding less indented line.
 */
export function scanSource(source: string): SourceScan {
  const lines = source.split(/\r?\n/);
  const tags: MethodTag[] = [];
  const declarations = new Set<string>();
  /** Enclosing lines: indentation and declared name (null when none). */
  const scopes: { indent: number; name: string | null }[] = [];
  let pending: { id: string; line: number }[] = [];
  let inBlockComment = false;
  let decoratorBalance = 0;

  const flushModuleLevel = (): void => {
    for (const tag of pending) tags.push({ ...tag, symbol: null });
    pending = [];
  };

  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    const isCommentLine =
      inBlockComment || text.startsWith('/*') || text.startsWith('//');
    if (isCommentLine) {
      if (!inBlockComment && text.startsWith('/**')) {
        // A new doc comment: tags of an earlier one document no declaration.
        flushModuleLevel();
      }
      if (text.startsWith('/*')) inBlockComment = true;
      const tag = TAG.exec(text);
      if (tag !== null) {
        pending.push({ id: tagToken(tag[1] ?? ''), line: index + 1 });
      }
      if (text.includes('*/')) inBlockComment = false;
      continue;
    }
    if (text === '') continue;
    if (decoratorBalance > 0 || text.startsWith('@')) {
      decoratorBalance = Math.max(
        0,
        decoratorBalance + parenthesisBalance(text),
      );
      continue;
    }

    const indent = line.length - line.trimStart().length;
    while (scopes.length > 0 && (scopes.at(-1)?.indent ?? 0) >= indent) {
      scopes.pop();
    }
    const name = declaredName(text, indent > 0);
    let symbol: string | null = null;
    if (name !== null && indent === 0) {
      symbol = name;
    } else if (name !== null) {
      // A member of a named declaration; a name in an anonymous block (e.g. a
      // call statement in a function body) declares nothing.
      const container = scopes.at(-1)?.name;
      symbol =
        container === undefined || container === null
          ? null
          : `${container}.${name}`;
    }
    if (symbol !== null) declarations.add(symbol);
    for (const tag of pending) tags.push({ ...tag, symbol });
    pending = [];
    scopes.push({ indent, name: symbol === null ? null : name });
  }
  flushModuleLevel();
  return { tags, declarations };
}

/** A parsed `implementedBy.module`. */
export interface ImplementationModule {
  /** Path relative to the service root, e.g. `src/domain/cii.ts`. */
  readonly path: string;
  /** Declared symbol, e.g. `attainedCii` or `CoastlineGeometry.distanceM`. */
  readonly symbol: string | null;
  /** Free-text remark in parentheses. */
  readonly remark: string | null;
}

const MODULE_PATTERN = new RegExp(
  String.raw`^([\w@.\-/]+?)(?:#(${IDENTIFIER}(?:\.${IDENTIFIER})*))?(?:\s+\((.+)\))?$`,
);

/**
 * Parses `implementedBy.module` (`<path>[#<symbol>][ (<remark>)]`).
 *
 * @returns the parts, or `null` when the value does not follow the format or
 * the path is absolute or leaves the service root.
 */
export function parseImplementationModule(
  module: string,
): ImplementationModule | null {
  const match = MODULE_PATTERN.exec(module);
  const modulePath = match?.[1];
  if (match === null || modulePath === undefined) return null;
  const segments = modulePath.split('/');
  if (
    modulePath.startsWith('/') ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    return null;
  }
  return {
    path: modulePath,
    symbol: match[2] ?? null,
    remark: match[3] ?? null,
  };
}

/** Extensions of the scanned source files. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
]);

/** Directories never scanned. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  '__fixtures__',
]);

/** Whether a file is a test or a declaration file (never scanned). */
function isSkippedFile(name: string): boolean {
  return (
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(name) || /\.d\.[cm]?ts$/.test(name)
  );
}

/** Source files below `directory` (relative posix paths, sorted). */
async function sourceFiles(
  directory: string,
  prefix: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(
          ...(await sourceFiles(path.join(directory, entry.name), relative)),
        );
      }
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
      !isSkippedFile(entry.name)
    ) {
      files.push(relative);
    }
  }
  return files;
}

/** Directories scanned for `@method` tags in every root, relative to it. */
export const SCANNED_DIRECTORIES = ['src'] as const;

/** Options of {@link verifyImplementations}. */
export interface VerifyImplementationsOptions {
  /** The validated catalog (e.g. `validateCatalog` of the JSON files). */
  readonly catalog: MethodologyCatalog;
  /**
   * Source root of every service or package, keyed by the name used in
   * `implementedBy.service` (e.g. `emission` → `services/emission`,
   * `contracts` → this package).
   */
  readonly roots: ReadonlyMap<string, string>;
}

/** A `@method` tag with the file holding it. */
export interface LocatedMethodTag extends MethodTag {
  /** Root name (service or package). */
  readonly service: string;
  /** Path relative to the root. */
  readonly file: string;
}

/** Result of {@link verifyImplementations}. */
export interface ImplementationReport {
  /** Every problem, in a stable order; empty when the catalog and the code agree. */
  readonly issues: readonly ImplementationIssue[];
  /** Every `@method` tag found. */
  readonly tags: readonly LocatedMethodTag[];
  /** Number of `implemented` methods checked. */
  readonly implemented: number;
}

/** Whether a tag documents `symbol` (itself, its container or one of its members) or the module. */
function tagCovers(tag: MethodTag, symbol: string): boolean {
  return (
    tag.symbol === null ||
    tag.symbol === symbol ||
    symbol.startsWith(`${tag.symbol}.`) ||
    tag.symbol.startsWith(`${symbol}.`)
  );
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Verifies the catalog against the code of `roots`:
 *
 * - every `@method` tag below `<root>/src` (tests, declaration files and
 *   `__fixtures__` excluded) names a catalog method, and that method is
 *   `implemented` (a `planned` or `not_implemented` method that the code
 *   tags has a stale status);
 * - every `implemented` method has an `implementedBy` whose service is a
 *   root, whose module exists, whose symbol (when given) is declared in the
 *   module, and whose module or symbol carries `@method <id>`.
 */
export async function verifyImplementations(
  options: VerifyImplementationsOptions,
): Promise<ImplementationReport> {
  const issues: ImplementationIssue[] = [];
  const tags: LocatedMethodTag[] = [];
  const scans = new Map<string, SourceScan>();
  const methods = new Map(
    options.catalog.methods.map((method) => [method.id, method]),
  );

  const roots = [...options.roots.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [service, root] of roots) {
    for (const directory of SCANNED_DIRECTORIES) {
      for (const file of await sourceFiles(
        path.join(root, directory),
        directory,
      )) {
        const scan = scanSource(await readFile(path.join(root, file), 'utf8'));
        scans.set(`${service}/${file}`, scan);
        for (const tag of scan.tags) tags.push({ ...tag, service, file });
      }
    }
  }

  for (const tag of tags) {
    const location = `${tag.service}/${tag.file}:${tag.line}`;
    if (!CATALOG_ID_PATTERN.test(tag.id)) {
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.MALFORMED_TAG,
        methodId: null,
        location,
        message: `@method is followed by ${tag.id === '' ? 'nothing' : `"${tag.id}"`}, not a catalog method id`,
      });
      continue;
    }
    const method = methods.get(tag.id);
    if (method === undefined) {
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.UNKNOWN_METHOD,
        methodId: tag.id,
        location,
        message: `@method ${tag.id} names no method of the catalog`,
      });
    }
  }

  const taggedIds = new Set(tags.map((tag) => tag.id));
  let implemented = 0;
  for (const method of options.catalog.methods) {
    const location = `methods.json#${method.id}`;
    if (method.status !== 'implemented') {
      if (
        taggedIds.has(method.id) &&
        (method.status === 'planned' || method.status === 'not_implemented')
      ) {
        const where = tags
          .filter((tag) => tag.id === method.id)
          .map((tag) => `${tag.service}/${tag.file}:${tag.line}`);
        issues.push({
          code: IMPLEMENTATION_ISSUE_CODES.STALE_STATUS,
          methodId: method.id,
          location,
          message: `Method ${method.id} is "${method.status}" but tagged in ${where.join(', ')}; mark it implemented with implementedBy`,
        });
      }
      continue;
    }
    implemented += 1;
    const implementation = method.implementedBy;
    if (implementation === null) {
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.MISSING_IMPLEMENTATION,
        methodId: method.id,
        location,
        message: `Method ${method.id} is implemented but has no implementedBy`,
      });
      continue;
    }
    const root = options.roots.get(implementation.service);
    if (root === undefined) {
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.UNKNOWN_SERVICE,
        methodId: method.id,
        location,
        message: `implementedBy.service "${implementation.service}" of ${method.id} is not a scanned service or package`,
      });
      continue;
    }
    const module = parseImplementationModule(implementation.module);
    if (module === null) {
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.MALFORMED_MODULE,
        methodId: method.id,
        location,
        message: `implementedBy.module "${implementation.module}" of ${method.id} is not "<path>[#<symbol>][ (<remark>)]"`,
      });
      continue;
    }
    const moduleLocation = `${implementation.service}/${module.path}`;
    if (!(await isFile(path.join(root, module.path)))) {
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.MISSING_MODULE,
        methodId: method.id,
        location: moduleLocation,
        message: `Module ${moduleLocation} of ${method.id} does not exist`,
      });
      continue;
    }
    const scan =
      scans.get(moduleLocation) ??
      scanSource(await readFile(path.join(root, module.path), 'utf8'));
    const symbol = module.symbol;
    if (symbol !== null && !scan.declarations.has(symbol)) {
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.MISSING_SYMBOL,
        methodId: method.id,
        location: moduleLocation,
        message: `Symbol ${symbol} of ${method.id} is not declared in ${moduleLocation}`,
      });
      continue;
    }
    const own = scan.tags.filter((tag) => tag.id === method.id);
    const covered =
      symbol === null
        ? own.length > 0
        : own.some((tag) => tagCovers(tag, symbol));
    if (!covered) {
      const tagged = own.map((tag) => tag.symbol ?? '(module)');
      issues.push({
        code: IMPLEMENTATION_ISSUE_CODES.MISSING_TAG,
        methodId: method.id,
        location: moduleLocation,
        message:
          `${symbol === null ? moduleLocation : `${moduleLocation}#${symbol}`} does not carry @method ${method.id}` +
          (tagged.length > 0 ? ` (tagged on ${tagged.join(', ')})` : ''),
      });
    }
  }
  return { issues, tags, implemented };
}

/**
 * Source roots of a services directory: every subdirectory holding a
 * `package.json` or a `src` directory, keyed by its name.
 */
export async function serviceRoots(
  servicesDir: string,
): Promise<Map<string, string>> {
  const roots = new Map<string, string>();
  const entries = await readdir(servicesDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const root = path.join(servicesDir, entry.name);
    if (
      (await isFile(path.join(root, 'package.json'))) ||
      (await stat(path.join(root, 'src')).then(
        (info) => info.isDirectory(),
        () => false,
      ))
    ) {
      roots.set(entry.name, root);
    }
  }
  return roots;
}
