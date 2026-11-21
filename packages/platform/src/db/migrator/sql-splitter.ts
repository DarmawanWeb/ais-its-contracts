const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

function isIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && IDENTIFIER_CHAR.test(char);
}

/** End index (exclusive) of a quoted literal starting at `start`. */
function endOfQuoted(sql: string, start: number, quote: '"' | "'", backslashEscapes: boolean): number {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashEscapes && char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/** End index (exclusive) of a (nested) block comment starting at `start`. */
function endOfBlockComment(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length && depth > 0) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 2;
    } else if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return index;
}

/**
 * Splits a SQL script into statements at top-level semicolons, honouring
 * PostgreSQL lexical rules: `'…'` (with `''`), `E'…'` (backslash escapes),
 * `"…"` identifiers, `$tag$…$tag$` bodies, `--` line and nested `/* *\/`
 * block comments. Statements made only of comments and whitespace are
 * dropped; the others are trimmed and returned without the semicolon.
 *
 * Used for migrations marked `-- seemp:no-transaction`, whose statements must
 * run one by one (a multi-statement query is an implicit transaction).
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let hasCode = false;
  let index = 0;

  const flush = (end: number): void => {
    const statement = sql.slice(start, end).trim();
    if (hasCode && statement !== '') statements.push(statement);
    hasCode = false;
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index = endOfBlockComment(sql, index);
      continue;
    }
    if (char === "'") {
      const prefix = sql[index - 1];
      const escapeString =
        (prefix === 'E' || prefix === 'e') && !isIdentifierChar(sql[index - 2]);
      index = endOfQuoted(sql, index, "'", escapeString);
      hasCode = true;
      continue;
    }
    if (char === '"') {
      index = endOfQuoted(sql, index, '"', false);
      hasCode = true;
      continue;
    }
    if (char === '$' && !isIdentifierChar(sql[index - 1])) {
      const tag = DOLLAR_TAG.exec(sql.slice(index, index + 64))?.[0];
      if (tag !== undefined) {
        const close = sql.indexOf(tag, index + tag.length);
        index = close === -1 ? sql.length : close + tag.length;
        hasCode = true;
        continue;
      }
    }
    if (char === ';') {
      flush(index);
      index += 1;
      start = index;
      continue;
    }
    if (char !== undefined && !/\s/.test(char)) hasCode = true;
    index += 1;
  }
  flush(sql.length);
  return statements;
}
