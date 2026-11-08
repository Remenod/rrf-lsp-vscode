// Reference model of RepRapFirmware expression typing — the ORACLE behind the generated spec tests.
//
// Hand-transcribed from the fork the printers run (tag 3.5.4-vm.1):
//   ExpressionParser::ParseInternal          unary and binary operators
//   ExpressionParser::BalanceNumericTypes    + - * mod pow min max
//   ExpressionParser::BalanceTypes           < > <= >= == !=
//   ExpressionParser::Convert*               implicit conversions
//   ExpressionParser::ApplyLengthOperator    #
//   ExpressionParser::ParseIdentifierExpression  per-function operand handling
//   NumericConverter::FitsInInt32/Uint32     literal typing
//
// Error texts are the exact strings passed to ThrowParseException.
// The model describes EVALUATED operands; skipped operands (evaluate == false) are SPEC.md §9.

export type Ty = 'int' | 'uint' | 'float' | 'bool' | 'string' | 'char' | 'datetime' | 'array' | 'object' | 'null';
export const ALL_TYPES: Ty[] = ['int', 'uint', 'float', 'bool', 'string', 'char', 'datetime', 'array', 'object', 'null'];

/** A source snippet whose value has each type. Every snippet is valid on its own. */
export const LITERAL: Record<Ty, string> = {
  int: '1',
  uint: '3000000000',
  float: '1.5',
  bool: 'true',
  string: '"s"',
  char: "'c'",
  datetime: 'datetime(0)',
  array: 'vector(2, 0)',
  object: 'move.axes[0]',
  null: 'null',
};

/** Names the checker's messages are expected to use for each type (TC-DIAG-03). */
export const MENTION: Record<Ty, RegExp> = {
  int: /\bint\b/,
  uint: /\buint\b|unsigned/,
  float: /\bfloat\b/,
  bool: /\bbool\b/,
  string: /\bstring\b/,
  char: /\bchar\b/,
  datetime: /\bdatetime\b/,
  array: /\barray\b/,
  object: /\bobject\b/,
  null: /\bnull\b/,
};

export type Result = { ok: string } | { err: string };
const ok = (t: string): Result => ({ ok: t });
const err = (m: string): Result => ({ err: m });
export const isErr = (r: Result): r is { err: string } => 'err' in r;

/** Accepted by ConvertToFloat. */
export const toFloatOk = (t: Ty) => t === 'int' || t === 'uint' || t === 'float';
const isString = (t: Ty) => t === 'string';
/** ExpressionParser::TypeHasNoLiterals (the subset expressible here). */
const hasNoLiterals = (t: Ty) => t === 'char' || t === 'datetime';

export const MSG = {
  numericOperand: 'expected numeric operand',
  numericOperands: 'expected numeric operands',
  invalidOperandTypes: 'invalid operand types',
  boolean: 'expected Boolean operand',
  cannotConvert: 'cannot convert operands to same type',
  comparison: 'expected numeric or Boolean operands to comparison operator',
  equality: 'unexpected operand type to equality operator',
  compareObjects: 'cannot compare objects',
  unaryMinus: "expected numeric value after '-'",
  unaryPlus: "expected numeric or enumeration value after '+'",
  length: 'operand of # is not an array or string',
  notArray: 'operand is not an array',
  noElements: 'array has no elements',
  positiveInt: 'expected positive integer',
  nonNegativeInt: 'expected non-negative integer',
  toDateTime: "can't convert value to DateTime",
  badDateString: 'string is not a valid date and time',
  stringOperand: 'expected string operand',
  charOperand: 'expected character operand',
  integerExpr: 'expected integer expression',
  indexRange: 'Index out of range',
  unknownFunction: 'unknown function',
} as const;

/** BalanceNumericTypes: returns the balanced type or the thrown text. */
export function balanceNumeric(a: Ty, b: Ty): Result {
  const a1: Ty = a === 'uint' ? 'float' : a;
  const b1: Ty = b === 'uint' ? 'float' : b;
  if (a1 === 'float') return toFloatOk(b1) ? ok('float') : err(MSG.numericOperand);
  if (b1 === 'float') return toFloatOk(a1) ? ok('float') : err(MSG.numericOperand);
  if (a1 === 'int' && b1 === 'int') return ok('int');
  return err(MSG.numericOperands);
}

/** BalanceTypes, step by step. Returns the common type or the thrown text. */
export function balanceTypes(a: Ty, b: Ty): { common: Ty } | { err: string } {
  const a1: Ty = a === 'uint' ? 'float' : a;
  const b1: Ty = b === 'uint' ? 'float' : b;
  if (a1 === b1 || (isString(a1) && isString(b1))) return { common: a1 };
  if (a1 === 'float') return toFloatOk(b1) ? { common: 'float' } : { err: MSG.numericOperand };
  if (b1 === 'float') return toFloatOk(a1) ? { common: 'float' } : { err: MSG.numericOperand };
  if (isString(b1) && hasNoLiterals(a1)) return { common: 'string' };
  if (isString(a1) && hasNoLiterals(b1)) return { common: 'string' };
  return { err: MSG.cannotConvert };
}

export const BINARY_OPS = ['+', '-', '*', '/', '^', '&&', '||', '<', '>', '<=', '>=', '==', '!='] as const;
export type BinOp = typeof BINARY_OPS[number];
export const LOGIC_OPS: ReadonlySet<string> = new Set(['&&', '||']);

export function binary(op: BinOp, a: Ty, b: Ty): Result {
  switch (op) {
    case '+':
    case '-':
      if (a === 'datetime') {
        if (b === 'int' || b === 'uint') return ok('datetime');
        if (op === '-' && b === 'datetime') return ok('int');
        return err(MSG.invalidOperandTypes);
      }
      return balanceNumeric(a, b);
    case '*':
      return balanceNumeric(a, b);
    case '/':
      if (!toFloatOk(a) || !toFloatOk(b)) return err(MSG.numericOperand);
      return ok('float');
    case '^':
      return ok('string');
    case '&&':
    case '||':
      return a === 'bool' && b === 'bool' ? ok('bool') : err(MSG.boolean);
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const c = balanceTypes(a, b);
      if ('err' in c) return err(c.err);
      return ['int', 'float', 'datetime', 'bool'].includes(c.common) ? ok('bool') : err(MSG.comparison);
    }
    case '==':
    case '!=': {
      if (a === 'null' || b === 'null') return ok('bool');
      const c = balanceTypes(a, b);
      if ('err' in c) return err(c.err);
      if (c.common === 'object') return err(MSG.compareObjects);
      return ['int', 'float', 'datetime', 'bool', 'string'].includes(c.common) ? ok('bool') : err(MSG.equality);
    }
  }
}

export const UNARY_OPS = ['-', '+', '!', '#'] as const;
export type UnOp = typeof UNARY_OPS[number];

export function unary(op: UnOp, a: Ty): Result {
  switch (op) {
    case '-': return a === 'int' || a === 'float' ? ok(a) : err(MSG.unaryMinus);
    case '+':
      if (a === 'int' || a === 'float') return ok(a);
      if (a === 'uint' || a === 'datetime') return ok('int');
      return err(MSG.unaryPlus);
    case '!': return a === 'bool' ? ok('bool') : err(MSG.boolean);
    case '#': return a === 'string' || a === 'array' ? ok('int') : err(MSG.length);
  }
}

/** ConvertToBool: if / elif / while / ?: / && / || / ! */
export const isBoolean = (t: Ty) => t === 'bool';

// ── Functions (3.5.4) ─────────────────────────────────────────────────────────

export interface ArgSpec {
  /** null = accepted, string = thrown text. */
  check(t: Ty): string | null;
}
export interface FnSpec {
  arity: number;              // the arity used by the generated tests
  args: ArgSpec[];
  /** Result type for accepted argument types. */
  result(args: Ty[]): string;
  /** Code for a rejected argument (always rrf-type-argument except where noted in SPEC). */
}

const accept = (pred: (t: Ty) => boolean, msg: string): ArgSpec => ({ check: t => (pred(t) ? null : msg) });
const anyArg: ArgSpec = { check: () => null };
const floatArg = accept(toFloatOk, MSG.numericOperand);
const floatFn = (): FnSpec => ({ arity: 1, args: [floatArg], result: () => 'float' });

/** Numeric pair balanced like BalanceNumericTypes with an `int` partner. */
const balancedWithInt = (): ArgSpec => ({
  check: t => {
    const r = balanceNumeric(t, 'int');
    return isErr(r) ? r.err : null;
  },
});

export const FN_3_5_4: Record<string, FnSpec> = {
  abs: { arity: 1, args: [accept(t => t === 'int' || t === 'float', MSG.numericOperand)], result: a => a[0] },
  acos: floatFn(), asin: floatFn(), atan: floatFn(), cos: floatFn(), sin: floatFn(), tan: floatFn(),
  exp: floatFn(), log: floatFn(), sqrt: floatFn(), degrees: floatFn(), radians: floatFn(),
  atan2: { arity: 2, args: [floatArg, floatArg], result: () => 'float' },
  floor: { arity: 1, args: [floatArg], result: () => 'int' },
  ceil: { arity: 1, args: [floatArg], result: () => 'int' },
  isnan: { arity: 1, args: [floatArg], result: () => 'bool' },
  mod: { arity: 2, args: [balancedWithInt(), balancedWithInt()], result: a => (a.every(t => t === 'int') ? 'int' : 'float') },
  pow: { arity: 2, args: [balancedWithInt(), balancedWithInt()], result: a => (a.every(t => t === 'int') ? 'int' : 'float') },
  max: { arity: 2, args: [balancedWithInt(), balancedWithInt()], result: a => (a.every(t => t === 'int') ? 'int' : 'float') },
  min: { arity: 2, args: [balancedWithInt(), balancedWithInt()], result: a => (a.every(t => t === 'int') ? 'int' : 'float') },
  random: { arity: 1, args: [accept(t => t === 'int' || t === 'uint', MSG.positiveInt)], result: () => 'int' },
  datetime: {
    arity: 1,
    args: [accept(t => t === 'int' || t === 'uint' || t === 'datetime' || t === 'string', MSG.toDateTime)],
    result: () => 'datetime',
  },
  fileexists: { arity: 1, args: [anyArg], result: () => 'bool' },
  fileread: {
    arity: 4,
    args: [
      accept(t => t === 'string', MSG.stringOperand),
      accept(t => t === 'int', MSG.nonNegativeInt),
      accept(t => t === 'int', MSG.nonNegativeInt),
      accept(t => t === 'char', MSG.charOperand),
    ],
    result: () => 'array<unknown>',
  },
  vector: { arity: 2, args: [accept(t => t === 'int', MSG.nonNegativeInt), anyArg], result: a => `array<${a[1] === 'array' ? 'array<int>' : a[1]}>` },
};

/**
 * Literal used for an argument position when the test varies another position. Must be
 * accepted AND value-valid (random needs > 0, datetime strings must parse, fileread needs a char).
 */
export function validArg(fn: string, pos: number): string {
  if (fn === 'fileread') return ['"data.csv"', '0', '1', "','"][pos];
  if (fn === 'datetime') return '0';
  if (fn === 'vector') return pos === 0 ? '2' : '0';
  return '1';
}

/** The literal for type `t` in a function-argument position (value-valid where the type is accepted). */
export function argLiteral(fn: string, t: Ty): string {
  if (fn === 'datetime' && t === 'string') return '"2024-01-01T00:00:00"';
  return LITERAL[t];
}

// ── Version tables (upstream tags, NamedEnum(Function, …)) ───────────────────

export interface Introduced { version: string; names: string[] }
export const FUNCTIONS_INTRODUCED: Introduced[] = [
  { version: '3.3.0', names: ['abs', 'acos', 'asin', 'atan', 'atan2', 'cos', 'degrees', 'exists', 'floor', 'isnan', 'max', 'min', 'mod', 'radians', 'random', 'sin', 'sqrt', 'tan'] },
  { version: '3.4.0', names: ['datetime'] },
  { version: '3.5.0', names: ['ceil', 'exp', 'fileexists', 'fileread', 'log', 'pow', 'vector'] },
  { version: '3.6.0-beta.4', names: ['drop', 'find', 'take'] },
  { version: '3.6.0-rc.2', names: ['square'] },
  { version: '3.6.0-rc.3', names: ['round'] },
];
export const CONSTANTS_INTRODUCED: Introduced[] = [
  { version: '3.3.0', names: ['false', 'iterations', 'line', 'null', 'pi', 'result', 'true'] },
  { version: '3.5.0', names: ['input'] },
];
export const STRING_INDEXING_FROM = '3.6.0-beta.4';

export function introducedIn(fn: string): string | undefined {
  return FUNCTIONS_INTRODUCED.find(i => i.names.includes(fn))?.version;
}

/** Semver-ish compare per TC-CFG-03 (alpha < beta < rc < release; unknown suffixes ignored). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-(alpha|beta|rc)\.(\d+))?/.exec(v);
    if (!m) throw new Error(`bad version ${v}`);
    const pre = m[4] ? { alpha: 0, beta: 1, rc: 2 }[m[4]]! : 3;
    return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), pre, Number(m[5] ?? 0)];
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
