import { describe, expect, it } from 'vitest';

import {
  evaluateFuelFormula,
  FUEL_FORMULA_FUNCTIONS,
  FUEL_FORMULA_LIMITS,
  FUEL_FORMULA_VARIABLE,
  type FuelFormulaNode,
  FuelFormulaSyntaxError,
  parseFuelFormula,
  validateFuelFormula,
} from './fuel-formula.js';

const SPEED: FuelFormulaNode = { kind: 'variable', name: 'speedKnot' };
const num = (value: number): FuelFormulaNode => ({ kind: 'number', value });

/** The limits of the emission evaluator before it used this grammar. */
const FORMER_EMISSION_LIMITS = {
  maxLength: 1000,
  maxDepth: 64,
  maxTokens: 1000,
} as const;

/** Limits large enough for every generated formula of the property test. */
const UNBOUNDED = { maxLength: 100_000, maxDepth: 1_000, maxTokens: 100_000 };

/** The error of an invalid formula (fails the test when it parses). */
function errorOf(
  source: string,
  limits?: Parameters<typeof parseFuelFormula>[1],
): FuelFormulaSyntaxError {
  try {
    parseFuelFormula(source, limits);
  } catch (error) {
    if (error instanceof FuelFormulaSyntaxError) return error;
    throw error;
  }
  throw new Error(`"${source}" parsed`);
}

const evaluate = (source: string, speedKnot: number): number =>
  evaluateFuelFormula(source, { speedKnot });

/** `formula` evaluated as JavaScript (trusted test input only). */
function javascript(formula: string): (speedKnot: number) => number {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- reference semantics of trusted test formulas
  return new Function('speedKnot', `return (${formula});`) as (
    speedKnot: number,
  ) => number;
}

describe('fuel formula limits and vocabulary', () => {
  it('uses the limits of the fleet service, at or below the former emission ones', () => {
    expect(FUEL_FORMULA_LIMITS).toEqual({
      maxLength: 500,
      maxDepth: 32,
      maxTokens: 500,
    });
    expect(Object.isFrozen(FUEL_FORMULA_LIMITS)).toBe(true);
    expect(FUEL_FORMULA_LIMITS.maxLength).toBeLessThanOrEqual(
      FORMER_EMISSION_LIMITS.maxLength,
    );
    expect(FUEL_FORMULA_LIMITS.maxDepth).toBeLessThanOrEqual(
      FORMER_EMISSION_LIMITS.maxDepth,
    );
    expect(FUEL_FORMULA_VARIABLE).toBe('speedKnot');
    expect(Object.keys(FUEL_FORMULA_FUNCTIONS)).toEqual([
      'exp',
      'log',
      'ln',
      'sqrt',
      'pow',
      'abs',
      'min',
      'max',
    ]);
  });

  it('refuses limits that are not positive integers', () => {
    for (const limits of [
      { maxLength: 0 },
      { maxDepth: -1 },
      { maxTokens: 1.5 },
      { maxLength: Number.NaN },
    ]) {
      expect(() => parseFuelFormula('1', limits)).toThrow(RangeError);
      expect(() => validateFuelFormula('1', limits)).toThrow(RangeError);
    }
  });
});

describe('parseFuelFormula: the legacy samples (Postman 3.7)', () => {
  it('parses the main-engine regression with JavaScript precedence', () => {
    expect(
      parseFuelFormula(
        '-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197',
      ),
    ).toEqual({
      kind: 'binary',
      operator: '-',
      left: {
        kind: 'binary',
        operator: '+',
        left: {
          kind: 'binary',
          operator: '*',
          left: { kind: 'unary', operator: '-', operand: num(0.0382) },
          right: { kind: 'binary', operator: '^', left: SPEED, right: num(2) },
        },
        right: {
          kind: 'binary',
          operator: '*',
          left: num(0.8658),
          right: SPEED,
        },
      },
      right: num(0.0197),
    });
  });

  it('parses the auxiliary-engine regression with Math.exp', () => {
    expect(parseFuelFormula('1.5103 * Math.exp(-0.064 * speedKnot)')).toEqual({
      kind: 'binary',
      operator: '*',
      left: num(1.5103),
      right: {
        kind: 'call',
        name: 'exp',
        args: [
          {
            kind: 'binary',
            operator: '*',
            left: { kind: 'unary', operator: '-', operand: num(0.064) },
            right: SPEED,
          },
        ],
      },
    });
  });

  it('evaluates the samples like the legacy JavaScript', () => {
    expect(
      evaluate('-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197', 12),
    ).toBe(-0.0382 * 12 ** 2 + 0.8658 * 12 - 0.0197);
    expect(
      evaluate('-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197', 12),
    ).toBeCloseTo(4.8691, 10);
    expect(evaluate('1.5103 * Math.exp(-0.064 * speedKnot)', 12)).toBe(
      1.5103 * Math.exp(-0.064 * 12),
    );
  });
});

describe('parseFuelFormula: grammar', () => {
  it('treats ^ like ** (power, spec 15.4) and both as right-associative', () => {
    expect(parseFuelFormula('2 ^ 3 ** 2')).toEqual({
      kind: 'binary',
      operator: '^',
      left: num(2),
      right: { kind: 'binary', operator: '^', left: num(3), right: num(2) },
    });
    expect(parseFuelFormula('speedKnot^2')).toEqual(
      parseFuelFormula('speedKnot ** 2'),
    );
  });

  it('binds a leading minus weaker than the power: -x ** 2 = -(x²)', () => {
    expect(parseFuelFormula('-speedKnot ** 2')).toEqual({
      kind: 'unary',
      operator: '-',
      operand: { kind: 'binary', operator: '^', left: SPEED, right: num(2) },
    });
    expect(parseFuelFormula('2 ** -1')).toEqual({
      kind: 'binary',
      operator: '^',
      left: num(2),
      right: { kind: 'unary', operator: '-', operand: num(1) },
    });
  });

  it('accepts every function with or without Math., and every number form', () => {
    for (const source of [
      'exp(speedKnot)',
      'Math.log(speedKnot + 1)',
      'ln(speedKnot + 1)',
      'Math.ln(2)',
      'sqrt(speedKnot)',
      'pow(speedKnot, 2)',
      'Math.pow(speedKnot, 0.5)',
      'abs(-speedKnot)',
      'min(speedKnot, 12)',
      'Math.max(0.5, speedKnot, 3)',
      '.5 + 1. + 1e-3 + 2.5E+2',
      '  ( speedKnot\t*\n2 )  ',
      '+speedKnot',
      '0.5',
    ]) {
      expect(validateFuelFormula(source), source).toEqual({
        valid: true,
        errors: [],
      });
    }
  });

  it('refuses code and unknown identifiers', () => {
    for (const [source, message] of [
      ['eval(1)', 'Unknown identifier "eval"'],
      ['eval("1")', 'Unexpected character "\\""'],
      ['process.exit(1)', 'Unknown identifier "process.exit"'],
      ['Math.random()', 'Unknown identifier "Math.random"'],
      ['Math.PI * speedKnot', 'Unknown identifier "Math.PI"'],
      ['constructor', 'Unknown identifier "constructor"'],
      ['toString(1)', 'Unknown identifier "toString"'],
      ['speed', 'Unknown identifier "speed"'],
      ['speed * 2', 'Unknown identifier "speed"'],
      ['speedKnot; 1', 'Unexpected character ";"'],
      ['speedKnot = 1', 'Unexpected character "="'],
      ['`1`', 'Unexpected character "`"'],
      ['`${1}`', 'Unexpected character "`"'],
      ["'1'", `Unexpected character "'"`],
      ['[1]', 'Unexpected character "["'],
      ['speedKnot % 2', 'Unexpected character "%"'],
      ['speedKnot & 1', 'Unexpected character "&"'],
    ] as const) {
      expect(errorOf(source).message, source).toContain(message);
    }
    expect(errorOf('speed').message).toContain(
      'allowed: speedKnot and the functions exp, log, ln, sqrt, pow, abs, min, max',
    );
  });

  it('refuses malformed expressions with the position', () => {
    expect(errorOf('speedKnot *')).toMatchObject({
      position: 11,
      reason: 'Unexpected end of formula',
      message: 'Unexpected end of formula at position 11',
    });
    expect(errorOf('0.5 * speedKnot +').message).toContain(
      'Unexpected end of formula',
    );
    expect(errorOf('(speedKnot').message).toContain('Expected ")"');
    expect(errorOf('(1 + 2').message).toContain('Expected ")"');
    expect(errorOf('speedKnot)').position).toBe(9);
    expect(errorOf('1 + 2)')).toMatchObject({ position: 5 });
    expect(errorOf('2 speedKnot').message).toContain('Unexpected "speedKnot"');
    expect(errorOf('exp speedKnot').message).toContain('Expected "("');
    expect(errorOf('min()').message).toContain('Unexpected ")"');
    expect(errorOf('* 2').position).toBe(0);
    expect(errorOf('1 + foo').position).toBe(4);
  });

  it('checks the arity of the functions', () => {
    expect(errorOf('pow(2)').message).toContain(
      'pow() takes 2 arguments, got 1',
    );
    expect(errorOf('exp(1, 2)').message).toContain(
      'exp() takes 1 argument, got 2',
    );
    expect(errorOf('pow(2)').position).toBe(0);
  });

  it('refuses empty, overlong, deeply nested and out-of-range formulas', () => {
    expect(errorOf('').message).toContain('Empty formula');
    expect(errorOf('   ').message).toContain('Empty formula');
    expect(errorOf('1+'.repeat(FUEL_FORMULA_LIMITS.maxLength))).toMatchObject({
      reason: `Longer than ${FUEL_FORMULA_LIMITS.maxLength} characters`,
      position: FUEL_FORMULA_LIMITS.maxLength,
    });
    const deep = (levels: number): string =>
      `${'('.repeat(levels)}1${')'.repeat(levels)}`;
    expect(() =>
      parseFuelFormula(deep(FUEL_FORMULA_LIMITS.maxDepth)),
    ).not.toThrow();
    expect(errorOf(deep(FUEL_FORMULA_LIMITS.maxDepth + 1)).message).toContain(
      'Nested deeper than 32 levels',
    );
    expect(
      errorOf('-'.repeat(FUEL_FORMULA_LIMITS.maxDepth + 1) + '1').message,
    ).toContain('Nested deeper than');
    expect(errorOf('1e999').message).toContain('Number 1e999 is out of range');
  });

  it('limits the depth of power chains like any other nesting', () => {
    const chain = (terms: number): string =>
      Array.from({ length: terms }, () => '1').join('^');
    expect(() =>
      parseFuelFormula(chain(FUEL_FORMULA_LIMITS.maxDepth + 1)),
    ).not.toThrow();
    expect(errorOf(chain(FUEL_FORMULA_LIMITS.maxDepth + 2)).message).toContain(
      'Nested deeper than',
    );
    expect(errorOf(chain(70)).message).toContain('Nested deeper than');
    expect(
      errorOf(
        `speedKnot${' ** -speedKnot'.repeat(FUEL_FORMULA_LIMITS.maxDepth)}`,
      ).message,
    ).toContain('Nested deeper than');
  });

  it('applies custom limits, the token limit included', () => {
    const sum = `${'1+'.repeat(300)}1`;
    expect(errorOf(sum).message).toContain('Longer than 500 characters');
    expect(() =>
      parseFuelFormula(sum, { maxLength: 1000, maxTokens: 601 }),
    ).not.toThrow();
    expect(errorOf(sum, { maxLength: 1000, maxTokens: 600 })).toMatchObject({
      reason: 'More than 600 tokens',
      position: 600,
    });
    expect(errorOf('(((1)))', { maxDepth: 2 }).message).toContain(
      'Nested deeper than 2 levels',
    );
  });
});

/**
 * Corpus shared by the fleet validator and the emission evaluator before
 * they used this grammar, with the verdict each of them gave.
 */
const SHARED_CORPUS = {
  /** Both accepted these. */
  bothAccept: [
    '-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197',
    '1.5103 * Math.exp(-0.064 * speedKnot)',
    'speedKnot',
    '2 ^ 3 ^ 2',
    '-speedKnot ** 2',
    '- - + speedKnot',
    '(((speedKnot)))',
    'Math.pow(speedKnot, 2) / Math.sqrt(4) + ln(2) - log(3)',
    'min(1) + max(1, 2, 3) + abs(-speedKnot)',
    '.5 + 1. + 1.e5 + 2E-3 + 10e+2',
    ' speedKnot\t*\n2 ',
    'speedKnot ** -1',
    'exp(exp(exp(speedKnot)))',
    Array.from({ length: 33 }, () => '1').join('^'),
  ],
  /** Both refused these. */
  bothRefuse: [
    '',
    '   ',
    'speedKnot +',
    'speedKnot speedKnot',
    '2speedKnot',
    'process.exit(1)',
    'Math.random()',
    'Math.PI',
    'Math.speedKnot',
    'speedKnot.x',
    'exp',
    'exp()',
    'min()',
    'pow(1)',
    'pow(1, 2, 3)',
    'sqrt(1, 2)',
    '(1',
    '1)',
    '1 ? 2 : 3',
    '1 % 2',
    'speedKnot = 2',
    '[1]',
    '1,2',
    '"1"',
    '1__proto__',
    'constructor',
    Array.from({ length: 70 }, () => '1').join('^'),
    `${'('.repeat(65)}1${')'.repeat(65)}`,
    `${'1+'.repeat(600)}1`,
    `${'('.repeat(100)}1${')'.repeat(100)}`,
    `${'-'.repeat(100)}1`,
    '1'.repeat(1001),
  ],
  /** Only emission accepted these: fleet's stricter limits (the defaults) refuse them. */
  onlyEmissionAccepted: [
    '1e999',
    `${'('.repeat(40)}1${')'.repeat(40)}`,
    `${'-'.repeat(40)}1`,
    Array.from({ length: 40 }, () => '1').join('^'),
    `${'1+'.repeat(300)}1`,
  ],
} as const;

describe('verdicts of the corpus shared by fleet and emission', () => {
  it.each(SHARED_CORPUS.bothAccept)('accepts %j', (formula) => {
    expect(validateFuelFormula(formula).valid).toBe(true);
  });

  it.each(SHARED_CORPUS.bothRefuse)('refuses %j', (formula) => {
    expect(validateFuelFormula(formula).valid).toBe(false);
    expect(
      validateFuelFormula(formula, FORMER_EMISSION_LIMITS).valid,
      'also with the former emission limits',
    ).toBe(false);
  });

  it.each(SHARED_CORPUS.onlyEmissionAccepted)(
    'refuses %j with the default limits',
    (formula) => {
      expect(validateFuelFormula(formula).valid).toBe(false);
    },
  );

  it('accepts the deeper and longer formulas with the former emission limits, but no infinite number', () => {
    const [infinite, ...rest] = SHARED_CORPUS.onlyEmissionAccepted;
    for (const formula of rest) {
      expect(validateFuelFormula(formula, FORMER_EMISSION_LIMITS).valid).toBe(
        true,
      );
    }
    expect(validateFuelFormula(infinite, FORMER_EMISSION_LIMITS).valid).toBe(
      false,
    );
  });
});

describe('evaluateFuelFormula: JavaScript semantics', () => {
  const speeds = [0, 0.5, 7.25, 12.979254311241013, 30];

  /** Valid JavaScript formulas and the same expression in TypeScript: results are bit-identical. */
  const formulas: readonly [string, (v: number) => number][] = [
    [
      '-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197',
      (v) => -0.0382 * v ** 2 + 0.8658 * v - 0.0197,
    ],
    [
      '1.5103 * Math.exp(-0.064 * speedKnot)',
      (v) => 1.5103 * Math.exp(-0.064 * v),
    ],
    [
      '0.012 * Math.pow(speedKnot, 3) + Math.sqrt(speedKnot) / 4 + 2',
      (v) => 0.012 * Math.pow(v, 3) + Math.sqrt(v) / 4 + 2,
    ],
    [
      'Math.max(0.8, 1.2 - 0.01 * speedKnot)',
      (v) => Math.max(0.8, 1.2 - 0.01 * v),
    ],
    [
      'Math.log(speedKnot + 1) * 3 + Math.abs(-2) + Math.min(speedKnot, 10) / 10',
      (v) => Math.log(v + 1) * 3 + Math.abs(-2) + Math.min(v, 10) / 10,
    ],
    ['(1 + 2) * (0.25 + speedKnot / 100)', (v) => (1 + 2) * (0.25 + v / 100)],
    ['2 ** 3 ** 0.5 - speedKnot / 2 / 3', (v) => 2 ** (3 ** 0.5) - v / 2 / 3],
    ['1e-3 * speedKnot ** -1.5 + .5 + 4.', (v) => 1e-3 * v ** -1.5 + 0.5 + 4],
    ['- -speedKnot + +1', (v) => v + 1],
    [
      'Math.min(speedKnot, 3, 1 + speedKnot / 10) * Math.max(1, speedKnot)',
      (v) => Math.min(v, 3, 1 + v / 10) * Math.max(1, v),
    ],
  ];

  it.each(formulas)(
    'evaluates %s exactly like JavaScript',
    (source, reference) => {
      const ast = parseFuelFormula(source);
      for (const v of speeds) {
        expect(
          Object.is(evaluateFuelFormula(ast, { speedKnot: v }), reference(v)),
          `${source} at ${v} kn`,
        ).toBe(true);
        expect(Object.is(evaluate(source, v), javascript(source)(v))).toBe(
          true,
        );
      }
    },
  );

  it('reads functions without Math., ln and log as the natural logarithm and ^ as power', () => {
    expect(evaluate('exp(1) + ln(speedKnot) + log(speedKnot)', 2)).toBe(
      Math.exp(1) + Math.log(2) + Math.log(2),
    );
    expect(evaluate('speedKnot ^ 2', 3)).toBe(9);
    expect(evaluate('2 ^ 3 ^ 2', 0)).toBe(512);
    expect(evaluate('-speedKnot ^ 2', 3)).toBe(-9);
    expect(evaluate('-speedKnot ** 2', 3)).toBe(-9);
    expect(evaluate('pow(speedKnot, 2)', 3)).toBe(9);
  });

  it('returns the raw IEEE-754 results', () => {
    expect(evaluate('log(speedKnot)', 0)).toBe(-Infinity);
    expect(evaluate('sqrt(speedKnot - 1)', 0)).toBeNaN();
    expect(evaluate('1 / speedKnot', 0)).toBe(Infinity);
    expect(Object.is(evaluate('-speedKnot', 0), -0)).toBe(true);
    expect(Object.is(evaluate('+speedKnot', -0), -0)).toBe(true);
    expect(evaluate('speedKnot', Number.NaN)).toBeNaN();
  });

  it('parses text with the default limits and reports syntax errors', () => {
    expect(() => evaluate('speedKnot +', 1)).toThrow(FuelFormulaSyntaxError);
    expect(() => evaluate(`${'('.repeat(40)}1${')'.repeat(40)}`, 1)).toThrow(
      'Nested deeper than 32 levels',
    );
  });
});

describe('validateFuelFormula', () => {
  it('reports instead of throwing', () => {
    expect(validateFuelFormula('speedKnot +')).toEqual({
      valid: false,
      errors: [
        { message: 'Unexpected end of formula at position 11', position: 11 },
      ],
    });
    expect(validateFuelFormula('speedKnot')).toEqual({
      valid: true,
      errors: [],
    });
  });
});

/** Deterministic PRNG (mulberry32) for reproducible generated formulas. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generator of formulas that are valid in this grammar and in JavaScript:
 * `Math.` functions, `**` only, no sign directly before a power, no leading
 * zeros (legacy octal literals).
 */
function formulaGenerator(seed: number): (depth: number) => string {
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => {
    const value = values[Math.floor(next() * values.length)];
    if (value === undefined) throw new Error('empty choice');
    return value;
  };
  const space = (): string => pick(['', ' ', ' ', '\t']);
  const numbers = [
    '0',
    '1',
    '2',
    '3',
    '12',
    '0.5',
    '0.0382',
    '0.8658',
    '1.5103',
    '.25',
    '4.',
    '1e-3',
    '2.5E+2',
    '1.e2',
    '7e1',
    '0.064',
  ];
  const sum = (depth: number): string => {
    const terms = 1 + Math.floor(next() * (depth > 0 ? 3 : 1));
    let text = product(depth);
    for (let index = 1; index < terms; index += 1) {
      // The space keeps a binary operator away from a sign ("- -1", not "--1").
      text += `${space()}${pick(['+', '-'])} ${product(depth)}`;
    }
    return text;
  };
  const product = (depth: number): string => {
    const factors = 1 + Math.floor(next() * (depth > 0 ? 3 : 1));
    let text = unary(depth);
    for (let index = 1; index < factors; index += 1) {
      text += `${space()}${pick(['*', '/'])} ${unary(depth)}`;
    }
    return text;
  };
  const unary = (depth: number): string => {
    if (depth > 0 && next() < 0.2) {
      // A sign never touches another sign ("--" is a JavaScript decrement)
      // and never precedes a power (a JavaScript syntax error).
      const operand =
        next() < 0.5 ? primary(depth - 1) : `(${power(depth - 1)})`;
      return `${pick(['-', '+'])} ${operand}`;
    }
    return power(depth);
  };
  const power = (depth: number): string => {
    const base = primary(depth);
    if (depth > 0 && next() < 0.25) {
      const exponent =
        next() < 0.3 ? `-${primary(depth - 1)}` : power(depth - 1);
      return `${base}${space()}**${space()}${exponent}`;
    }
    return base;
  };
  const primary = (depth: number): string => {
    const roll = next();
    if (depth <= 0 || roll < 0.35) return pick(numbers);
    if (roll < 0.6) return FUEL_FORMULA_VARIABLE;
    if (roll < 0.75) return `(${space()}${sum(depth - 1)}${space()})`;
    const name = pick(['exp', 'log', 'sqrt', 'pow', 'abs', 'min', 'max']);
    const arity =
      name === 'pow'
        ? 2
        : name === 'min' || name === 'max'
          ? 1 + Math.floor(next() * 3)
          : 1;
    const args = Array.from({ length: arity }, () => sum(depth - 1));
    return `Math.${name}(${args.join(`,${space()}`)})`;
  };
  return sum;
}

describe('property: generated JavaScript formulas evaluate bit-identically', () => {
  const speeds = [0, 0.5, 1, 7.25, 12.979254311241013, 30, -3];

  it('matches JavaScript for 2 000 generated formulas', () => {
    const generate = formulaGenerator(20_261_122);
    let compared = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const formula = generate(4);
      const ast = parseFuelFormula(formula, UNBOUNDED);
      const reference = javascript(formula);
      for (const speedKnot of speeds) {
        const actual = evaluateFuelFormula(ast, { speedKnot });
        const expected = reference(speedKnot);
        if (!Object.is(actual, expected)) {
          throw new Error(
            `${formula} at ${speedKnot} kn: ${actual} instead of ${expected}`,
          );
        }
        compared += 1;
      }
    }
    expect(compared).toBe(2_000 * speeds.length);
  });

  it('reads ^ exactly like ** in generated formulas', () => {
    const generate = formulaGenerator(7);
    for (let index = 0; index < 300; index += 1) {
      const formula = generate(4);
      expect(
        parseFuelFormula(formula.replaceAll('**', '^'), UNBOUNDED),
      ).toEqual(parseFuelFormula(formula, UNBOUNDED));
    }
  });
});
