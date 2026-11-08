// Reference model of RepRapFirmware's expression typing — the ORACLE for the type-check specs.
//
// Transcribed by hand from ExpressionParser.cpp of the Vision Miner fork (RRF 3.5.4 line):
//   ParseInternal            unary/binary operators            (lines ~194-640)
//   BalanceNumericTypes      + - * min max mod pow             (~833)
//   BalanceTypes             comparison / equality             (~1074)
//   Convert*                 implicit conversions              (~1127-1285)
//   ApplyLengthOperator      '#'                               (~1286)
//   ParseIdentifierExpression  per-function operand handling   (~1470-1850)
//
// Only the types a literal can have are modelled. 'datetime' comes from datetime().
// Short-circuit evaluation ('&&' '||' '?:' with `evaluate == false`) is NOT modelled: specs only
// use operand values that force evaluation of both sides.

export type Ty = 'int' | 'float' | 'bool' | 'string' | 'char' | 'array' | 'null' | 'datetime';
export const ALL_TYPES: Ty[] = ['int', 'float', 'bool', 'string', 'char', 'array', 'null', 'datetime'];

/** A source snippet that evaluates to each type. */
export const LITERAL: Record<Ty, string> = {
  int: '1',
  float: '1.5',
  bool: 'true',
  string: '"s"',
  char: "'c'",
  array: 'vector(2, 0)',
  null: 'null',
  datetime: 'datetime(0)',
};

export type Result = { ok: Ty } | { err: string };
const ok = (t: Ty): Result => ({ ok: t });
const err = (m: string): Result => ({ err: m });
export const isNumeric = (t: Ty) => t === 'int' || t === 'float';

function balanceNumeric(a: Ty, b: Ty): Result {
  if (!isNumeric(a) || !isNumeric(b)) return err('expected numeric operands');
  return ok(a === 'float' || b === 'float' ? 'float' : 'int');
}

const isStringy = (t: Ty) => t === 'string';
const hasNoLiterals = (t: Ty) => t === 'char' || t === 'datetime';

/** BalanceTypes + the switch used by < > <= >= and == !=. Returns the common type or an error. */
function balanceForCompare(a: Ty, b: Ty): { common: Ty } | { err: string } {
  if (a === b) return { common: a };
  if (isStringy(a) && isStringy(b)) return { common: 'string' };
  if (a === 'float' && b !== 'float') return isNumeric(b) ? { common: 'float' } : { err: 'expected numeric operand' };
  if (b === 'float' && a !== 'float') return isNumeric(a) ? { common: 'float' } : { err: 'expected numeric operand' };
  if (isStringy(b) && hasNoLiterals(a)) return { common: 'string' };
  if (isStringy(a) && hasNoLiterals(b)) return { common: 'string' };
  return { err: 'cannot convert operands to same type' };
}

export function binary(op: string, a: Ty, b: Ty): Result {
  switch (op) {
    case '+':
    case '-':
      if (a === 'datetime') {
        if (b === 'int') return ok('datetime');
        if (op === '-' && b === 'datetime') return ok('int');
        return err('invalid operand types');
      }
      return balanceNumeric(a, b);
    case '*':
      return balanceNumeric(a, b);
    case '/':
      return isNumeric(a) && isNumeric(b) ? ok('float') : err('expected numeric operand');
    case '^':
      return ok('string');
    case '&&':
    case '||':
      return a === 'bool' && b === 'bool' ? ok('bool') : err('expected Boolean operand');
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const c = balanceForCompare(a, b);
      if ('err' in c) return err(c.err);
      return ['int', 'float', 'datetime', 'bool'].includes(c.common)
        ? ok('bool') : err('expected numeric or Boolean operands to comparison operator');
    }
    case '==':
    case '!=': {
      if (a === 'null' || b === 'null') return ok('bool');
      const c = balanceForCompare(a, b);
      if ('err' in c) return err(c.err);
      return ['int', 'float', 'datetime', 'bool', 'string'].includes(c.common)
        ? ok('bool') : err('unexpected operand type to equality operator');
    }
  }
  throw new Error(`unknown operator ${op}`);
}

export const BINARY_OPS = ['+', '-', '*', '/', '^', '&&', '||', '<', '>', '<=', '>=', '==', '!='];

export function unary(op: string, a: Ty): Result {
  switch (op) {
    case '-': return isNumeric(a) ? ok(a) : err("expected numeric value after '-'");
    case '+': return isNumeric(a) ? ok(a) : a === 'datetime' ? ok('int') : err("expected numeric or enumeration value after '+'");
    case '!': return a === 'bool' ? ok('bool') : err('expected Boolean operand');
    case '#': return a === 'string' || a === 'array' ? ok('int') : err('operand of # is not an array or string');
  }
  throw new Error(`unknown unary ${op}`);
}
export const UNARY_OPS = ['-', '+', '!', '#'];

export function ternaryCondition(c: Ty): Result {
  return c === 'bool' ? ok('bool') : err('expected Boolean operand');
}

/** `if` / `elif` / `while` conditions are converted with ConvertToBool. */
export const conditionOk = (t: Ty) => t === 'bool';

// ── Functions ────────────────────────────────────────────────────────────────

export interface FnSpec {
  min: number;
  max: number;
  /** Per-argument predicate (index clamps to the last entry for variadics). */
  args: Array<(t: Ty) => boolean>;
  result: (args: Ty[]) => Ty;
  /** Literal values needed to avoid unrelated runtime errors (e.g. random(0)). */
  validLiterals?: string[];
}

const num = isNumeric;
const any = () => true;
const floatFn: FnSpec = { min: 1, max: 1, args: [num], result: () => 'float' };

/** Functions that exist in the Vision Miner fork (RRF 3.5.4 line). */
export const FORK_FUNCTIONS: Record<string, FnSpec> = {
  abs: { min: 1, max: 1, args: [num], result: a => a[0] },
  acos: floatFn, asin: floatFn, atan: floatFn, cos: floatFn, sin: floatFn, tan: floatFn,
  exp: floatFn, log: floatFn, sqrt: floatFn, degrees: floatFn, radians: floatFn,
  atan2: { min: 2, max: 2, args: [num, num], result: () => 'float' },
  ceil: { min: 1, max: 1, args: [num], result: () => 'int' },
  floor: { min: 1, max: 1, args: [num], result: () => 'int' },
  isnan: { min: 1, max: 1, args: [num], result: () => 'bool' },
  mod: { min: 2, max: 2, args: [num, num], result: a => (a.includes('float') ? 'float' : 'int') },
  pow: { min: 2, max: 2, args: [num, num], result: a => (a[0] === 'int' && a[1] === 'int' ? 'int' : 'float') },
  max: { min: 1, max: Infinity, args: [num], result: a => (a.includes('float') ? 'float' : 'int') },
  min: { min: 1, max: Infinity, args: [num], result: a => (a.includes('float') ? 'float' : 'int') },
  random: { min: 1, max: 1, args: [t => t === 'int'], result: () => 'int' },
  datetime: { min: 1, max: 1, args: [t => t === 'int' || t === 'string' || t === 'datetime'], result: () => 'datetime' },
  fileexists: { min: 1, max: 1, args: [any], result: () => 'bool' },
  fileread: { min: 4, max: 4, args: [t => t === 'string', t => t === 'int', t => t === 'int', t => t === 'char'], result: () => 'array' },
  vector: { min: 2, max: 2, args: [t => t === 'int', any], result: () => 'array' },
  exists: { min: 1, max: 1, args: [any], result: () => 'bool' },
};

/**
 * Functions the language server knows (gcode-functions.json / FUNCTION_NAMES) that are NOT in the
 * fork's ExpressionParser.cpp. On a 3.5.4 printer a call fails with "unknown function".
 */
export const NEWER_THAN_FORK = ['round', 'square', 'find', 'take', 'drop'];

/** Function set per target firmware. Versions are compared numerically, major.minor[.patch]. */
export const FUNCTIONS_BY_VERSION: Array<{ from: string; names: string[] }> = [
  { from: '3.5.0', names: Object.keys(FORK_FUNCTIONS) },
  // Placeholder: the release that introduced NEWER_THAN_FORK is intentionally NOT asserted here;
  // confirm it against the Duet3D release notes before wiring the real table.
];
