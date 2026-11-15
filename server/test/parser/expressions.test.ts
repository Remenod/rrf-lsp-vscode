// Expression syntax: operators, precedence, functions, indexing, brackets.
// Syntax only — type rules live in test/typecheck.

import { describe } from 'node:test';
import { expectClean, expectDiag } from '../helpers/cases';
import { FUNCTION_NAMES } from '../../src/parser/types';

// Argument-count ranges per firmware ExpressionParser::ParseIdentifierExpression.
// [min, max]  (max = Infinity for variadic).
export const ARITY: Record<string, [number, number]> = {
  abs: [1, 1], acos: [1, 1], asin: [1, 1], atan: [1, 1], atan2: [2, 2], ceil: [1, 1], cos: [1, 1],
  datetime: [1, 1], degrees: [1, 1], exists: [1, 1], exp: [1, 1], fileexists: [1, 1],
  fileread: [4, 4], floor: [1, 1], isnan: [1, 1], log: [1, 1], max: [1, Infinity], min: [1, Infinity],
  mod: [2, 2], pow: [2, 2], radians: [1, 1], random: [1, 1], sin: [1, 1], sqrt: [1, 1],
  tan: [1, 1], vector: [2, 2],
};

const argList = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1)).join(', ');

describe('expressions: valid forms', () => {
  expectClean([
    'echo 1',
    'echo 1 + 2',
    'echo 1 + 2 * 3',
    'echo (1 + 2) * 3',
    'echo -1',
    'echo - -1',
    'echo +1',
    'echo 10 / 4',
    'echo 1 - 2 - 3',
    'echo "a" ^ "b"',
    'echo "a" ^ 1 ^ "b"',
    'echo 1 == 1',
    'echo 1 != 2',
    'echo 1 < 2',
    'echo 1 > 2',
    'echo 1 <= 2',
    'echo 1 >= 2',
    'echo true && false',
    'echo true || false',
    'echo true & false',
    'echo true | false',
    'echo !true',
    'echo !(1 == 2)',
    'echo true ? 1 : 2',
    'echo true ? 1 : false ? 2 : 3',
    'echo (true ? 1 : 2) + 1',
    'echo #"abc"',
    'echo #(1 + 2)',
    'echo 1 == 1 && 2 == 2',
    'echo 0xFF',
    'echo 0b101',
    'echo 1e3',
    "echo 'x'",
    'echo null',
    'echo pi',
    'echo true',
    'echo false',
    'echo 1 == null',
    'echo null == null',
    'echo "a" == "b"',
    'echo {1 + 2}',
    'echo ((((1))))',
    'echo -(1 + 2)',
    'echo !!true',
    'echo (1)+(2)',
    'echo 1+2',
    'echo 1+-2',
    'echo   1   +   2   ',
    'echo move.axes[0].homed',
    'echo move.axes[0].machinePosition',
    'echo heat.heaters[1].current',
    'echo #move.axes',
    'echo move.axes[1+1].letter',
    'echo sensors.probes[0].value[0]',
    'echo state.status',
    'echo state.currentTool',
    'echo tools[0].name',
    'echo network.interfaces[0].actualIP',
  ]);

  expectClean([
    'var a = 1',
    'var a = 1.5',
    'var a = "s"',
    'var a = true',
    'var a = null',
    'var a = vector(3, 0)',
    'var a = {1, 2, 3}',
    'var a = {"x", "y"}',
    'var a = move.axes[0].min',
    'var a = 1 + 2',
    'var a = (1 + 2) * 3',
    'var a = #move.axes',
    'var a = exists(move.axes[0])',
    'var a = fileexists("sys/config.g")',
  ]);

  expectClean([
    'G1 X{1 + 2} Y{3}',
    'G1 X{move.axes[0].max - 10}',
    'M291 P{"a" ^ "b"} S1',
    'M117 { "hello" }',
    'M104 S{heat.heaters[1].active}',
    'M98 P{"sys/" ^ "a.g"}',
  ]);
});

describe('expressions: operators with missing operands', () => {
  for (const op of ['+', '-', '*', '/', '^', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '&', '|']) {
    expectDiag([[`echo 1 ${op}`, /dangling|expected an expression|unexpected/]]);
  }
  // Operators that cannot start an expression (unary + and - can).
  for (const op of ['*', '/', '^', '==', '<', '>', '&&', '||']) {
    expectDiag([[`echo ${op} 1`, /.+/]]);
  }

  expectDiag([
    ['echo !', /expected an expression after '!'/],
    ['echo -', /expected an expression after unary/],
    ['echo +', /expected an expression after unary/],
    ['echo 1 ?', /.+/],
    ['echo true ? 1', /.+/],
    ['echo true ? 1 :', /.+/],
    ['echo 1 ** 2', /.+/],
    ['echo 1 ! 2', /unexpected/],
    ['echo 1 2', /.+/],
    ['echo (1 2)', /.+/],
  ]);
});

describe('expressions: brackets', () => {
  expectDiag([
    ['echo (1 + 2', /unclosed '\('/],
    ['echo 1 + 2)', /unexpected '\)'/],
    ['echo {1 + 2', /unclosed '\{'/],
    ['echo 1 + 2}', /unexpected '\}'/],
    ['echo move.axes[0', /unclosed '\['/],
    ['echo move.axes]', /unexpected '\]'/],
    ['echo (1 + 2]', /.+/],
    ['echo [1 + 2)', /.+/],
    ['G1 X{1 + 2', /unclosed '\{'/],
    ['echo ()', /.+/],
  ]);
});

describe('expressions: unary operator chains', () => {
  expectClean(['echo -1', 'echo - -1', 'echo !true', 'echo !!true', 'echo -(-1)', 'echo -#"a"']);
  expectDiag([
    { src: 'echo ---1', match: /.+/, name: 'three consecutive unary minus is rejected' },
  ]);
  // The consecutive-operator lint only applies to sign operators; '!' recurses freely in the firmware.
  expectClean(['echo !!!true']);
});

describe('expressions: function arity (min-1, min, max, max+1)', () => {
  for (const fn of FUNCTION_NAMES) {
    const range = ARITY[fn];
    if (!range) continue;
    const [min, max] = range;
    // `exists` takes an object-model path, not a value, and fileread/fileexists have path semantics;
    // arity is still checked syntactically.
    const arg = (n: number) => (fn === 'exists' ? Array.from({ length: n }, () => 'move.axes[0]').join(', ') : argList(n));

    if (min > 1) {
      expectDiag([[`echo ${fn}(${arg(min - 1)})`, new RegExp(`'${fn}' requires at least ${min}`)]]);
    }
    if (min === 1) {
      expectDiag([[`echo ${fn}()`, /.+/]]);
    }
    // Known gap: exists(...) bypasses the generic arity check; the firmware reports "expected ')'".
    if (fn === 'exists') continue;
    expectClean([`echo ${fn}(${arg(min)})`]);
    if (Number.isFinite(max)) {
      expectDiag([[`echo ${fn}(${arg(max + 1)})`, new RegExp(`'${fn}' takes at most ${max}`)]]);
    } else {
      expectClean([`echo ${fn}(${arg(max === Infinity ? 6 : max)})`]);
    }
  }

  expectClean(['echo abs(abs(-1))', 'echo max(1, min(2, 3), 4)', 'echo max(1, 2)', 'echo min(1, 2, 3)',
    'echo atan2(1, 1)', 'echo pow(2, 8)', 'echo mod(7, 3)']);
});

describe('expressions: known gaps', () => {
  expectDiag([
    { src: 'echo exists(move.axes[0], move.axes[1])', match: /.+/, todo: "exists() with 2 operands is not rejected; firmware: expected ')'" },
  ]);
});

describe('expressions: function results and bracketed expressions', () => {
  expectDiag([
    // ExpressionParser cannot index a function result: echo/if fail ("expected ','" / extra characters) and
    // var/set silently DROP the index (no CheckForExtraCharacters), storing the whole array.
    { src: 'echo abs(1)[0]', match: /cannot be indexed/ },
    { src: "var r = fileread(\"a.csv\", 0, 2, ',')[0]", match: /silently drops the index/ },
  ]);
  // ParseExpectKet accepts trailing indexes after ( … ) and { … }.
  expectClean([
    'echo {1, 2}[0]',
    'var a = {1, 2}\necho (var.a)[1]',
    'echo {{1, 2}, {3,}}[0][1]',
    // '#' before a function call is legal and silently ignored by the firmware.
    'echo #abs(-5)',
  ]);
});

describe('expressions: unknown functions and identifiers', () => {
  expectDiag([
    ['echo foo(1)', /.+/],
    ['echo notafunction()', /.+/],
  ]);
});

describe('expressions: indexing', () => {
  expectClean([
    'echo move.axes[0].letter',
    'echo move.axes[0][1]'.replace('[0][1]', '[0].homed'),
    'echo sensors.probes[0].value[0]',
  ]);
  expectDiag([
    ['echo move.axes[].letter', /.+/],
    ['echo move.axes[0', /unclosed/],
  ]);
});

describe('expressions: ternary', () => {
  expectClean([
    'echo true ? 1 : 2',
    'echo (1 == 1) ? "y" : "n"',
    'echo true ? (false ? 1 : 2) : 3',
    'var x = true ? 1 : 2',
    'G1 X{true ? 1 : 2}',
  ]);
  expectDiag([
    ['echo true ? 1 2', /.+/],
    ['echo true : 1', /.+/],
  ]);
});
