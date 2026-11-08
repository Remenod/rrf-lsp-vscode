// SPEC §6: functions — argument types, result types, statically known values.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  rule, guard, CODE, Expect, typeDiags, matchDiagnostics, expectTypes, expectNoTypes, typeOfExpr, expectType, canonType,
} from './contract';
import { ALL_TYPES, MENTION, MSG, FN_3_5_4, validArg, argLiteral, Ty } from './model';
import { src } from '../helpers/harness';

const H = 'move.axes[0].homed';

function call(fn: string, args: string[]): { text: string; spans: Array<{ line: number; start: number; end: number }> } {
  const head = `echo ${fn}(`;
  const spans = [];
  let col = head.length;
  for (const a of args) {
    spans.push({ line: 0, start: col, end: col + a.length });
    col += a.length + 2;
  }
  return { text: `${head}${args.join(', ')})`, spans };
}

describe('TC-FN-01: argument-type matrix (every function × position × type)', () => {
  for (const [fn, spec] of Object.entries(FN_3_5_4)) {
    const acceptsAll = spec.args.every(a => ALL_TYPES.every(t => a.check(t) === null));
    (acceptsAll ? guard : rule)('TC-FN-01', `${fn}()${acceptsAll ? ': accepts every type' : ''}`, () => {
      const problems: string[] = [];
      for (let pos = 0; pos < spec.arity; pos++) {
        for (const t of ALL_TYPES) {
          const args = Array.from({ length: spec.arity }, (_, i) => (i === pos ? argLiteral(fn, t) : validArg(fn, i)));
          const c = call(fn, args);
          const msg = spec.args[pos].check(t);
          const expected: Expect[] = msg === null ? [] : [{ code: CODE.argument, at: c.spans[pos], firmware: msg, mentions: [MENTION[t]] }];
          for (const p of matchDiagnostics(c.text, typeDiags(c.text), expected)) problems.push(`${c.text}: ${p}`);
        }
      }
      assert.deepEqual(problems, []);
    });
  }
});

describe('TC-FN-02: result-type matrix', () => {
  for (const [fn, spec] of Object.entries(FN_3_5_4)) {
    rule('TC-FN-02', `${fn}() result`, () => {
      const problems: string[] = [];
      for (let pos = 0; pos < spec.arity; pos++) {
        for (const t of ALL_TYPES) {
          if (spec.args[pos].check(t) !== null) continue;
          const argTypes: Ty[] = Array.from({ length: spec.arity }, (_, i) => (i === pos ? t : (fn === 'fileread' ? (['string', 'int', 'int', 'char'] as Ty[])[i] : 'int')));
          const args = Array.from({ length: spec.arity }, (_, i) => (i === pos ? argLiteral(fn, t) : validArg(fn, i)));
          const expr = `${fn}(${args.join(', ')})`;
          const want = canonType(spec.result(argTypes));
          const got = typeOfExpr(expr);
          if (got !== want) problems.push(`${expr}: ${got} != ${want}`);
        }
      }
      assert.deepEqual(problems, []);
    });
  }
  rule('TC-FN-02', 'exists and fileexists are bool', () => {
    expectType(typeOfExpr('exists(move.axes[0])'), 'bool', 'exists');
    expectType(typeOfExpr('exists(var.nothing)'), 'bool', 'exists var');
    expectType(typeOfExpr('fileexists("0:/sys/config.g")'), 'bool', 'fileexists');
  });
  rule('TC-FN-02', 'single-argument max/min yields the element type', () => {
    expectType(typeOfExpr('max({1, 2, 3})'), 'int', 'max int array');
    expectType(typeOfExpr('min({1, 2.5})'), 'int | float', 'min mixed array');
    expectType(typeOfExpr('max(vector(3, 1.5))'), 'float', 'max vector');
  });
  rule('TC-FN-02', 'multi-argument max/min balances like arithmetic', () => {
    expectType(typeOfExpr('max(1, 2, 3)'), 'int', 'ints');
    expectType(typeOfExpr('max(1, 2.5, 3)'), 'float', 'float wins');
    expectType(typeOfExpr('min(3000000000, 1)'), 'float', 'uint becomes float');
  });
});

describe('TC-FN-03..10: specific functions', () => {
  rule('TC-FN-03', 'abs rejects uint', () => {
    expectTypes('echo abs(3000000000)', [{ code: CODE.argument, at: '3000000000', firmware: MSG.numericOperand }]);
  });
  guard('TC-FN-03', 'abs of an object-model number is not definite (int | uint | float)', () => expectNoTypes('echo abs(heat.heaters[0].current)'));

  rule('TC-FN-04', 'single-argument max/min needs an array', () => {
    expectTypes('echo max(5)', [{ code: CODE.argument, at: '5', firmware: MSG.notArray }]);
    expectTypes('echo min("abc")', [{ code: CODE.argument, at: '"abc"', firmware: MSG.notArray }]);
    expectTypes(src('var n = 4', 'echo max(var.n)'), [{ code: CODE.argument, at: 'var.n', line: 1, firmware: MSG.notArray }]);
  });
  rule('TC-FN-04', 'statically empty array', () => {
    expectTypes('echo max(vector(0, 1))', [{ code: CODE.value, at: 'vector(0, 1)', firmware: MSG.noElements }]);
  });
  rule('TC-FN-04', 'array elements must be numeric', () => {
    expectTypes('echo max({1, "a"})', [{ code: CODE.argument, at: '{1, "a"}', firmware: /"expected numeric operands?"/ }]);
  });
  guard('TC-FN-04', 'arrays from literals, vector, fileread and variables', () => {
    expectNoTypes('echo max({1, 2})\necho min(vector(3, 2.5))\necho max(fileread("data.csv", 0, 3, \',\'))');
    expectNoTypes(src('var a = {3, 1, 2}', 'echo max(var.a)'));
    expectNoTypes('echo max(param.A)');
  });
  rule('TC-FN-05', 'SHOULD: object-model arrays are not heap arrays', () => {
    expectTypes('echo max(move.axes)', [{ code: CODE.argument, at: 'move.axes', firmware: MSG.notArray }]);
    expectTypes('echo min(tools[0].offsets)', [{ code: CODE.argument, at: 'tools[0].offsets', firmware: MSG.notArray }]);
  });

  rule('TC-FN-06', 'vector size', () => {
    expectTypes('echo vector(1.5, 0)', [{ code: CODE.argument, at: '1.5', firmware: MSG.nonNegativeInt }]);
    expectTypes('echo vector(10 / 2, 0)', [{ code: CODE.argument, at: '10 / 2', firmware: MSG.nonNegativeInt, mentions: ['float'] }]);
    expectTypes('echo vector(3000000000, 0)', [{ code: CODE.argument, at: '3000000000' }]);
    expectTypes('echo vector(-1, 0)', [{ code: CODE.value, at: '-1', firmware: MSG.nonNegativeInt }]);
  });
  guard('TC-FN-06', 'valid sizes', () => expectNoTypes('echo vector(0, 0)\necho vector(floor(10 / 2), 0)\necho vector(#move.axes, false)'));

  rule('TC-FN-07', 'random needs a positive integer', () => {
    expectTypes('echo random(0)', [{ code: CODE.value, at: '0', firmware: MSG.positiveInt }]);
    expectTypes('echo random(-3)', [{ code: CODE.value, at: '-3', firmware: MSG.positiveInt }]);
    expectTypes('echo random(2.5)', [{ code: CODE.argument, at: '2.5', firmware: MSG.positiveInt }]);
  });
  guard('TC-FN-07', 'valid and unknown limits', () => expectNoTypes('echo random(10)\necho random(3000000000)\necho random(param.N)\necho random(#move.axes)'));

  rule('TC-FN-08', 'malformed date strings', () => {
    for (const s of ['"2024-01-01"', '"yesterday"', '""', '"2024/01/01T00:00:00"', '"T00:00:00"'])
      expectTypes(`echo datetime(${s})`, [{ code: CODE.value, at: s, firmware: MSG.badDateString }]);
  });
  guard('TC-FN-08', 'SafeStrptime is lenient: single digits, blanks before numbers, signs and trailing text', () => {
    for (const s of ['"2024-01-01T00:00:00"', '"2024-1-1T1:2:3"', '"2024-01-01T00:00:00Z"', '"2024-01-01T00:00:00.123"',
      '"2024- 1-01T 1:02:03"', '" 2024-01-01T00:00:00"', '"2024-+1-01T00:00:00"'])
      expectNoTypes(`echo datetime(${s})`);
    expectNoTypes(src('var s = "x"', 'echo datetime(var.s)'));
  });
  rule('TC-FN-08', 'non-convertible types', () => {
    expectTypes('echo datetime(1.5)', [{ code: CODE.argument, at: '1.5', firmware: MSG.toDateTime }]);
    expectTypes('echo datetime(true)', [{ code: CODE.argument, at: 'true', firmware: MSG.toDateTime }]);
  });

  rule('TC-FN-09', 'fileread: delimiter is a char, offsets non-negative', () => {
    expectTypes('echo fileread("data.csv", 0, 1, ",")', [{ code: CODE.argument, at: '","', firmware: MSG.charOperand }]);
    expectTypes("echo fileread(\"data.csv\", -1, 1, ',')", [{ code: CODE.value, at: '-1', firmware: MSG.nonNegativeInt }]);
    expectTypes("echo fileread(\"data.csv\", 0, 2.5, ',')", [{ code: CODE.argument, at: '2.5', firmware: MSG.nonNegativeInt }]);
    expectTypes("echo fileread(5, 0, 1, ',')", [{ code: CODE.argument, at: '5', occurrence: 0, firmware: MSG.stringOperand }]);
  });
  rule('TC-FN-09', 'fileread elements are unknown', () => {
    expectType(typeOfExpr("fileread(\"data.csv\", 0, 1, ',')"), 'array<unknown>', 'fileread');
    expectNoTypes(src("var r = fileread(\"data.csv\", 0, 1, ',')", 'echo var.r[0] + 1', 'echo var.r[0] ^ "x"'));
  });

  rule('TC-FN-10', 'pow result type', () => {
    expectType(typeOfExpr('pow(2, 8)'), 'int', 'int, int');
    expectType(typeOfExpr('pow(2, -1)'), 'float', 'negative literal exponent');
    expectType(typeOfExpr('pow(2.0, 2)'), 'float', 'float base');
    expectType(typeOfExpr('pow(3000000000, 2)'), 'float', 'uint base');
    expectType(typeOfExpr('pow(2, var.n)', { prelude: ['var n = 3'] }), 'int', 'int exponent of unknown sign');
  });
});

describe('TC-FN-11: per-argument diagnostics; bad calls are unknown', () => {
  rule('TC-FN-11', 'every bad argument is reported on itself', () => {
    expectTypes('echo atan2("a", true)', [
      { code: CODE.argument, at: '"a"' },
      { code: CODE.argument, at: 'true' },
    ]);
    expectTypes('echo fileread(1, "x", 2.5, ",")', [
      { code: CODE.argument, at: '1', occurrence: 0 },
      { code: CODE.argument, at: '"x"' },
      { code: CODE.argument, at: '2.5' },
      { code: CODE.argument, at: '","' },
    ]);
  });
  rule('TC-FN-11', 'a call with a bad argument does not cascade', () => {
    expectTypes('echo abs("a") + "b"', [{ code: CODE.argument, at: '"a"' }]);
    expectTypes('if isnan("x")\n  echo 1', [{ code: CODE.argument, at: '"x"' }]);
  });
  rule('TC-FN-11', 'nested calls: the inner error only', () => {
    expectTypes('echo sqrt(abs("x"))', [{ code: CODE.argument, at: '"x"' }]);
    expectTypes('echo sqrt(abs(-4)) + 1', []);
  });
});

describe('TC-FN-12: post-3.5.4 functions (typed when available)', () => {
  rule('TC-FN-12', 'types with no version and with 3.6.1', () => {
    // Hover is version-neutral (newest table).
    expectType(typeOfExpr('square(3)'), 'float', 'square');
    expectType(typeOfExpr('round(2.5)'), 'int', 'round');
    expectType(typeOfExpr('take("abcdef", 3)'), 'string', 'take string');
    expectType(typeOfExpr('take({1, 2, 3}, 2)'), 'array<int>', 'take array');
    expectType(typeOfExpr('drop("abcdef", 3)'), 'string', 'drop');
    expectType(typeOfExpr('find("abc", \'b\')'), 'int', 'find');
    // Diagnostics do take the version: 3.6.1 has them all.
    expectNoTypes('echo square(3) + round(2.5) + find("abc", \'b\')\necho take("abc", 1) ^ drop("abc", 1)', { rrfVersion: '3.6.1' });
  });
  rule('TC-FN-12', 'argument errors', () => {
    expectTypes('echo square("x")', [{ code: CODE.argument, at: '"x"', firmware: MSG.numericOperand }]);
    expectTypes('echo take(5, 1)', [{ code: CODE.argument, at: '5', occurrence: 0, firmware: 'first operand of function is not an array or string' }]);
    expectTypes('echo take("abc", 1.5)', [{ code: CODE.argument, at: '1.5', firmware: MSG.nonNegativeInt }]);
    expectTypes('echo find({1, 2}, 1)', [{ code: CODE.argument, at: '{1, 2}', firmware: 'first operand of function is not a string' }]);
    expectTypes('echo find("abc", 1)', [{ code: CODE.argument, at: '1', occurrence: 0, firmware: 'incompatible operand types' }]);
  });
  void H;
});
