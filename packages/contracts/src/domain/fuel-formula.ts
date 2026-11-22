/**
 * The safe expression language of first fuel formulas (spec 13.5 and 15.4):
 * a main or auxiliary engine fuel flow as a function of the segment speed
 * `speedKnot`, stored by the fleet service and evaluated by the emission
 * service. One grammar for both, so fleet never stores a formula that
 * emission refuses or evaluates differently. A formula is parsed into an AST;
 * nothing is ever evaluated with `eval` or `new Function`.
 *
 * Grammar (EBNF; whitespace between tokens is ignored):
 *
 * ```text
 * formula  = sum ;
 * sum      = product , { ( "+" | "-" ) , product } ;          (* left-associative *)
 * product  = unary , { ( "*" | "/" ) , unary } ;              (* left-associative *)
 * unary    = ( "+" | "-" ) , unary | power ;
 * power    = primary , [ ( "**" | "^" ) , unary ] ;           (* right-associative *)
 * primary  = number | "speedKnot" | call | "(" , sum , ")" ;
 * call     = [ "Math." ] , function , "(" , sum , { "," , sum } , ")" ;
 * function = "exp" | "log" | "ln" | "sqrt" | "pow" | "abs" | "min" | "max" ;
 * number   = digits , [ "." , [ digits ] ] , [ exponent ] | "." , digits , [ exponent ] ;
 * exponent = ( "e" | "E" ) , [ "+" | "-" ] , digits ;
 * ```
 *
 * Semantics are those of JavaScript, operation by operation (`+ - * /`,
 * `**`, `Math.*` on IEEE-754 doubles), so a formula that is valid JavaScript
 * gives bit-identical results. Deliberate differences: `^` is the power
 * operator (JavaScript: XOR, spec 15.4), `-a ** b` is accepted as
 * `-(a ** b)` (a syntax error in JavaScript), `log` and `ln` are both the
 * natural logarithm (`Math.log`), and number literals must be finite.
 */

/** The only variable of a formula: the segment speed in knots. */
export const FUEL_FORMULA_VARIABLE = 'speedKnot';

/**
 * Functions of the grammar with their arity (`'variadic'` = one or more
 * arguments); each may be written with or without the `Math.` prefix.
 */
export const FUEL_FORMULA_FUNCTIONS = Object.freeze({
  exp: 1,
  log: 1,
  ln: 1,
  sqrt: 1,
  pow: 2,
  abs: 1,
  min: 'variadic',
  max: 'variadic',
} as const);

/** A function name of the grammar. */
export type FuelFormulaFunction = keyof typeof FUEL_FORMULA_FUNCTIONS;

/** Limits of a first fuel formula (see {@link FUEL_FORMULA_LIMITS}). */
export interface FuelFormulaLimits {
  /** Longest formula, in characters (UTF-16 code units). */
  readonly maxLength: number;
  /**
   * Deepest nesting: every parenthesis, function call, sign and exponent is
   * one level deeper.
   */
  readonly maxDepth: number;
  /** Most tokens (numbers, identifiers, operators, parentheses and commas). */
  readonly maxTokens: number;
}

/**
 * Default limits of a first fuel formula, the fleet service's (its
 * `fuel_formulas` CHECK allows 500 characters): 500 characters, 32 levels of
 * nesting and 500 tokens, at or below the emission evaluator's former limits
 * (1000 characters, 64 levels), so every formula fleet stored before also
 * passes. The token limit never binds below 500 characters; it bounds the
 * work of callers that raise `maxLength`.
 */
export const FUEL_FORMULA_LIMITS: Readonly<FuelFormulaLimits> = Object.freeze({
  maxLength: 500,
  maxDepth: 32,
  maxTokens: 500,
});

/** A node of a parsed formula (see {@link parseFuelFormula}). */
export type FuelFormulaNode =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'variable'; readonly name: typeof FUEL_FORMULA_VARIABLE }
  | {
      readonly kind: 'unary';
      readonly operator: '+' | '-';
      readonly operand: FuelFormulaNode;
    }
  | {
      readonly kind: 'binary';
      /** `^` is the power operator (written `**` or `^` in the source). */
      readonly operator: '+' | '-' | '*' | '/' | '^';
      readonly left: FuelFormulaNode;
      readonly right: FuelFormulaNode;
    }
  | {
      readonly kind: 'call';
      readonly name: FuelFormulaFunction;
      readonly args: readonly FuelFormulaNode[];
    };

/** Variables of a formula evaluation. */
export interface FuelFormulaContext {
  /** Segment speed, knots. */
  readonly speedKnot: number;
}

/**
 * A formula outside the grammar or the limits. `message` ends with
 * ` at position <position>`; `reason` is the message without it.
 */
export class FuelFormulaSyntaxError extends Error {
  override readonly name = 'FuelFormulaSyntaxError';

  constructor(
    /** What is wrong, e.g. `Unknown identifier "speed"`. */
    readonly reason: string,
    /** Zero-based character offset of the problem. */
    readonly position: number,
  ) {
    super(`${reason} at position ${position}`);
  }
}

type TokenKind = 'number' | 'identifier' | 'operator' | '(' | ')' | ',' | 'end';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly position: number;
}

const NUMBER_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENTIFIER_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/;
const WHITESPACE = /\s/;
const MATH_PREFIX = 'Math.';

function isFunctionName(name: string): name is FuelFormulaFunction {
  return Object.hasOwn(FUEL_FORMULA_FUNCTIONS, name);
}

function tokenize(source: string, maxTokens: number): Token[] {
  const tokens: Token[] = [];
  const push = (token: Token): void => {
    if (tokens.length >= maxTokens) {
      throw new FuelFormulaSyntaxError(
        `More than ${maxTokens} tokens`,
        token.position,
      );
    }
    tokens.push(token);
  };
  let index = 0;
  while (index < source.length) {
    const character = source.charAt(index);
    if (WHITESPACE.test(character)) {
      index += 1;
      continue;
    }
    const rest = source.slice(index);
    const number = NUMBER_PATTERN.exec(rest);
    if (number !== null) {
      push({ kind: 'number', text: number[0], position: index });
      index += number[0].length;
      continue;
    }
    const identifier = IDENTIFIER_PATTERN.exec(rest);
    if (identifier !== null) {
      push({ kind: 'identifier', text: identifier[0], position: index });
      index += identifier[0].length;
      continue;
    }
    if (rest.startsWith('**')) {
      push({ kind: 'operator', text: '**', position: index });
      index += 2;
      continue;
    }
    if ('+-*/^'.includes(character)) {
      push({ kind: 'operator', text: character, position: index });
    } else if (character === '(' || character === ')' || character === ',') {
      push({ kind: character, text: character, position: index });
    } else {
      throw new FuelFormulaSyntaxError(
        `Unexpected character ${JSON.stringify(character)}`,
        index,
      );
    }
    index += 1;
  }
  tokens.push({ kind: 'end', text: '', position: source.length });
  return tokens;
}

/** Recursive-descent parser over the token list (one instance per formula). */
class Parser {
  private index = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly maxDepth: number,
  ) {}

  parse(): FuelFormulaNode {
    const node = this.sum();
    const next = this.peek();
    if (next.kind !== 'end') throw this.unexpected(next);
    return node;
  }

  private sum(): FuelFormulaNode {
    let left = this.product();
    for (;;) {
      const operator = this.operator('+', '-');
      if (operator === undefined) return left;
      left = { kind: 'binary', operator, left, right: this.product() };
    }
  }

  private product(): FuelFormulaNode {
    let left = this.unary();
    for (;;) {
      const operator = this.operator('*', '/');
      if (operator === undefined) return left;
      left = { kind: 'binary', operator, left, right: this.unary() };
    }
  }

  private unary(): FuelFormulaNode {
    const operator = this.operator('+', '-');
    if (operator === undefined) return this.power();
    return this.nested(() => ({
      kind: 'unary',
      operator,
      operand: this.unary(),
    }));
  }

  private power(): FuelFormulaNode {
    const base = this.primary();
    if (this.operator('**', '^') === undefined) return base;
    // Every exponent is one level deeper, so a chain `1^1^…^1` is
    // depth-limited like parentheses, calls and signs.
    return {
      kind: 'binary',
      operator: '^',
      left: base,
      right: this.nested(() => this.unary()),
    };
  }

  private primary(): FuelFormulaNode {
    const token = this.advance();
    switch (token.kind) {
      case 'number': {
        const value = Number(token.text);
        if (!Number.isFinite(value)) {
          throw new FuelFormulaSyntaxError(
            `Number ${token.text} is out of range`,
            token.position,
          );
        }
        return { kind: 'number', value };
      }
      case 'identifier':
        return this.identifier(token);
      case '(': {
        const inner = this.nested(() => this.sum());
        this.expect(')');
        return inner;
      }
      case ',':
      case ')':
      case 'operator':
      case 'end':
        throw this.unexpected(token);
    }
  }

  private identifier(token: Token): FuelFormulaNode {
    if (token.text === FUEL_FORMULA_VARIABLE) {
      return { kind: 'variable', name: FUEL_FORMULA_VARIABLE };
    }
    const name = token.text.startsWith(MATH_PREFIX)
      ? token.text.slice(MATH_PREFIX.length)
      : token.text;
    if (!isFunctionName(name)) {
      throw new FuelFormulaSyntaxError(
        `Unknown identifier "${token.text}" (allowed: ${FUEL_FORMULA_VARIABLE} and the functions ` +
          `${Object.keys(FUEL_FORMULA_FUNCTIONS).join(', ')}, optionally prefixed with Math.)`,
        token.position,
      );
    }
    this.expect('(');
    const args = this.nested(() => {
      const list = [this.sum()];
      while (this.peek().kind === ',') {
        this.advance();
        list.push(this.sum());
      }
      return list;
    });
    this.expect(')');
    const arity = FUEL_FORMULA_FUNCTIONS[name];
    if (arity !== 'variadic' && args.length !== arity) {
      throw new FuelFormulaSyntaxError(
        `${name}() takes ${arity} argument${arity === 1 ? '' : 's'}, got ${args.length}`,
        token.position,
      );
    }
    return { kind: 'call', name, args };
  }

  /** Runs `parse` one nesting level deeper, refusing pathological nesting. */
  private nested<T>(parse: () => T): T {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      throw new FuelFormulaSyntaxError(
        `Nested deeper than ${this.maxDepth} levels`,
        this.peek().position,
      );
    }
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  /** Consumes the next token when it is one of the operators. */
  private operator<const Operator extends string>(
    ...operators: readonly Operator[]
  ): (Operator extends '**' ? '^' : Operator) | undefined {
    const token = this.peek();
    if (token.kind !== 'operator') return undefined;
    const match = operators.find((operator) => operator === token.text);
    if (match === undefined) return undefined;
    this.advance();
    // `**` is normalized to `^`; every other operator maps to itself.
    return (match === '**' ? '^' : match) as Operator extends '**'
      ? '^'
      : Operator;
  }

  private expect(kind: TokenKind): void {
    const token = this.advance();
    if (token.kind !== kind) {
      throw token.kind === 'end'
        ? new FuelFormulaSyntaxError(`Expected "${kind}"`, token.position)
        : new FuelFormulaSyntaxError(
            `Expected "${kind}" but found "${token.text}"`,
            token.position,
          );
    }
  }

  private peek(): Token {
    // The token list always ends with an `end` token, never consumed past.
    return this.tokens[this.index] ?? this.endToken();
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.index += 1;
    return token;
  }

  private endToken(): Token {
    return this.tokens.at(-1) ?? { kind: 'end', text: '', position: 0 };
  }

  private unexpected(token: Token): FuelFormulaSyntaxError {
    return token.kind === 'end'
      ? new FuelFormulaSyntaxError('Unexpected end of formula', token.position)
      : new FuelFormulaSyntaxError(
          `Unexpected "${token.text}"`,
          token.position,
        );
  }
}

/** The default limits overridden by `limits`, validated. */
function resolveLimits(
  limits: Partial<FuelFormulaLimits> | undefined,
): FuelFormulaLimits {
  const resolved = { ...FUEL_FORMULA_LIMITS, ...limits };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(
        `Fuel formula limit ${name} must be a positive integer`,
      );
    }
  }
  return resolved;
}

/**
 * Parses a first fuel formula (main or auxiliary engine fuel flow as a
 * function of `speedKnot`) into an AST, or throws why it is not in the safe
 * grammar. Parse once and evaluate the AST any number of times with
 * {@link evaluateFuelFormula}.
 *
 * The method evaluates `q = max(f(V_kn), 0.5)` per engine group in L/min;
 * this function implements the language half of it: which strings `f` may be.
 *
 * @method fuel.first_formula
 * @see docs/PLATFORM_SPEC.md 13.5 (grammar) and 15.4 (`^` means power, no `new Function`)
 * @param source - the formula, e.g. `-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197`
 * @param limits - overrides of {@link FUEL_FORMULA_LIMITS}
 * @returns the AST
 * @throws {FuelFormulaSyntaxError} when the formula is empty, longer than
 * `maxLength`, has more than `maxTokens` tokens, is nested deeper than
 * `maxDepth`, has a non-finite number or is outside the grammar.
 * @throws {RangeError} when a limit is not a positive integer.
 *
 * @example
 * parseFuelFormula('1.5103 * Math.exp(-0.064 * speedKnot)');
 * // { kind: 'binary', operator: '*', left: { kind: 'number', value: 1.5103 }, right: { kind: 'call', name: 'exp', … } }
 */
export function parseFuelFormula(
  source: string,
  limits?: Partial<FuelFormulaLimits>,
): FuelFormulaNode {
  const { maxLength, maxDepth, maxTokens } = resolveLimits(limits);
  if (source.length > maxLength) {
    throw new FuelFormulaSyntaxError(
      `Longer than ${maxLength} characters`,
      maxLength,
    );
  }
  if (source.trim() === '') {
    throw new FuelFormulaSyntaxError('Empty formula', 0);
  }
  return new Parser(tokenize(source, maxTokens), maxDepth).parse();
}

function callFunction(name: FuelFormulaFunction, args: number[]): number {
  const first = args[0] ?? Number.NaN;
  switch (name) {
    case 'exp':
      return Math.exp(first);
    case 'log':
    case 'ln':
      return Math.log(first);
    case 'sqrt':
      return Math.sqrt(first);
    case 'pow':
      return Math.pow(first, args[1] ?? Number.NaN);
    case 'abs':
      return Math.abs(first);
    case 'min':
      return Math.min(...args);
    case 'max':
      return Math.max(...args);
  }
}

function evaluateNode(
  node: FuelFormulaNode,
  context: FuelFormulaContext,
): number {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'variable':
      return context.speedKnot;
    case 'unary': {
      const operand = evaluateNode(node.operand, context);
      return node.operator === '-' ? -operand : operand;
    }
    case 'call':
      return callFunction(
        node.name,
        node.args.map((arg) => evaluateNode(arg, context)),
      );
    case 'binary': {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '^':
          return left ** right;
      }
    }
  }
}

/**
 * Evaluates a first fuel formula at a speed with JavaScript semantics
 * (bit-identical to the same formula evaluated as JavaScript, see the module
 * documentation). The result is the raw IEEE-754 value: it may be negative,
 * `NaN` or infinite (e.g. `log(0)`); the caller applies the method's floor
 * (`max(f, 0.5)`) and its own finiteness rule.
 *
 * @method fuel.first_formula
 * @param formula - an AST of {@link parseFuelFormula}, or the formula text
 * (parsed with the default limits)
 * @param context - the variables: `speedKnot` in knots
 * @returns the fuel flow f(V) as written in the formula (L/min by convention)
 * @throws {FuelFormulaSyntaxError} when `formula` is text outside the grammar.
 *
 * @example
 * const ast = parseFuelFormula('-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197');
 * evaluateFuelFormula(ast, { speedKnot: 12 }); // ≈ 4.8691 (L/min)
 */
export function evaluateFuelFormula(
  formula: FuelFormulaNode | string,
  context: FuelFormulaContext,
): number {
  const ast = typeof formula === 'string' ? parseFuelFormula(formula) : formula;
  return evaluateNode(ast, context);
}

/** A problem of a formula reported by {@link validateFuelFormula}. */
export interface FuelFormulaIssue {
  /** What is wrong, ending with ` at position <position>`. */
  readonly message: string;
  /** Zero-based character offset of the problem. */
  readonly position: number;
}

/** Result of {@link validateFuelFormula}: `errors` is empty exactly when `valid`. */
export type FuelFormulaValidation =
  | { readonly valid: true; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly [FuelFormulaIssue] };

/**
 * {@link parseFuelFormula} as a result instead of an exception, e.g. for
 * request validation that reports every invalid field at once. The parser
 * stops at the first problem, so `errors` holds at most one issue.
 *
 * @method fuel.first_formula
 * @param source - the formula text
 * @param limits - overrides of {@link FUEL_FORMULA_LIMITS}
 * @throws {RangeError} when a limit is not a positive integer.
 */
export function validateFuelFormula(
  source: string,
  limits?: Partial<FuelFormulaLimits>,
): FuelFormulaValidation {
  try {
    parseFuelFormula(source, limits);
    return { valid: true, errors: [] };
  } catch (error) {
    if (error instanceof FuelFormulaSyntaxError) {
      return {
        valid: false,
        errors: [{ message: error.message, position: error.position }],
      };
    }
    throw error;
  }
}
