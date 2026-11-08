// SPEC §7: arrays and indexing.

import { describe } from 'node:test';
import { rule, guard, CODE, expectTypes, expectNoTypes, typeOfExpr, typeAt, expectType } from './contract';
import { MSG } from './model';
import { src } from '../helpers/harness';

const A = 'var a = {10, 20, 30}';

describe('TC-ARR-01: element types', () => {
  rule('TC-ARR-01', 'elements of literals, vector and nested arrays', () => {
    expectType(typeOfExpr('var.a[0]', { prelude: [A] }), 'int', 'int literal array');
    expectType(typeOfExpr('var.a[1]', { prelude: ['var a = {1, "x"}'] }), 'int | string', 'mixed literal array');
    expectType(typeOfExpr('var.a[0]', { prelude: ['var a = vector(4, 2.5)'] }), 'float', 'vector');
    expectType(typeOfExpr('var.a[0]', { prelude: ['var a = {{1, 2}, {3,}}'] }), 'array<int>', 'nested');
    expectType(typeOfExpr('var.a[0][1]', { prelude: ['var a = {{1, 2}, {3,}}'] }), 'int', 'nested element');
    expectType(typeOfExpr('var.a[0]', { prelude: ["var a = fileread(\"data.csv\", 0, 3, ',')"] }), 'unknown', 'fileread');
  });
  rule('TC-ARR-01', 'element errors are found through the variable', () => {
    expectTypes(src('var a = {"x", "y"}', 'echo var.a[0] * 2'), [{ code: CODE.operand, at: 'var.a[0] * 2', line: 1, firmware: MSG.numericOperands }]);
  });
});

describe('TC-ARR-02: the index must be int', () => {
  rule('TC-ARR-02', 'float, uint, string and bool indices', () => {
    expectTypes(src(A, 'echo var.a[1.5]'), [{ code: CODE.index, at: '1.5', firmware: MSG.integerExpr, mentions: ['float'] }]);
    expectTypes(src(A, 'echo var.a[3000000000]'), [{ code: CODE.index, at: '3000000000', firmware: MSG.integerExpr }]);
    expectTypes(src(A, 'echo var.a["k"]'), [{ code: CODE.index, at: '"k"', firmware: MSG.integerExpr }]);
    expectTypes(src(A, 'echo var.a[true]'), [{ code: CODE.index, at: 'true', line: 1, firmware: MSG.integerExpr }]);
  });
  rule('TC-ARR-02', 'a division result is float, so it cannot index', () => {
    expectTypes(src(A, 'var n = 4', 'echo var.a[var.n / 2]'), [{ code: CODE.index, at: 'var.n / 2', firmware: MSG.integerExpr }]);
  });
  guard('TC-ARR-02', 'integer indices', () => {
    expectNoTypes(src(A, 'echo var.a[0]', 'echo var.a[#var.a - 1]', 'echo var.a[floor(5 / 2)]', 'while iterations < 3', '  echo var.a[iterations]'));
    expectNoTypes(src(A, 'echo var.a[param.I]'));
    expectNoTypes('echo move.axes[state.currentTool + 1].homed');
  });
});

describe('TC-ARR-03: indexing a non-array variable', () => {
  rule('TC-ARR-03', 'int, string and null variables', () => {
    for (const init of ['5', '"abc"', 'null', 'true']) {
      expectTypes(src(`var x = ${init}`, 'echo var.x[0]'), [{
        code: CODE.index, at: 'var.x', line: 1,
        firmware: "Cannot index into variable or parameter 'x' of non-array type",
      }]);
    }
  });
  rule('TC-ARR-03', 'strings are not indexable through variables, even on 3.6', () => {
    expectTypes(src('var s = "abc"', 'echo var.s[0]'), [{ code: CODE.index, at: 'var.s', line: 1 }], { rrfVersion: '3.6.1' });
  });
  guard('TC-ARR-03', 'params and unknown globals may hold arrays', () => {
    expectNoTypes('echo param.A[0]\necho global.notDeclared[1]');
  });
});

describe('TC-ARR-04 / 05: literal indices out of range', () => {
  rule('TC-ARR-04', 'a negative literal index', () => {
    expectTypes(src(A, 'echo var.a[-1]'), [{ code: CODE.value, at: '-1', firmware: MSG.indexRange }]);
  });
  rule('TC-ARR-05', 'SHOULD: index past a known length', () => {
    expectTypes(src(A, 'echo var.a[3]'), [{ code: CODE.value, at: '3', line: 1, firmware: MSG.indexRange }]);
    expectTypes(src('var a = vector(2, 0)', 'echo var.a[2]'), [{ code: CODE.value, at: '2', line: 1, occurrence: 0, firmware: MSG.indexRange }]);
  });
  guard('TC-ARR-05', 'in-range literal indices and unknown lengths', () => {
    expectNoTypes(src(A, 'echo var.a[2]', 'echo var.a[0]'));
    expectNoTypes(src("var a = fileread(\"data.csv\", 0, 3, ',')", 'echo var.a[2]'));
    expectNoTypes(src('var n = 4', 'var a = vector(var.n, 0)', 'echo var.a[3]'));
  });
});

describe('TC-ARR-06: indexed assignment', () => {
  rule('TC-ARR-06', 'the target must hold an array', () => {
    expectTypes(src('var n = 1', 'set var.n[0] = 2'), [{ code: CODE.index, at: 'var.n', line: 1, firmware: 'Expected an array expression' }]);
    expectTypes(src('global g = "x"', 'set global.g[0] = 2'), [{ code: CODE.index, at: 'global.g', line: 1 }]);
  });
  rule('TC-ARR-06', 'the index must be a non-negative int', () => {
    expectTypes(src(A, 'set var.a[1.5] = 2'), [{ code: CODE.index, at: '1.5', firmware: MSG.nonNegativeInt }]);
    expectTypes(src(A, 'set var.a[-1] = 2'), [{ code: CODE.value, at: '-1', firmware: MSG.nonNegativeInt }]);
    expectTypes(src(A, 'set var.a["k"] = 2'), [{ code: CODE.index, at: '"k"', firmware: MSG.nonNegativeInt }]);
  });
  guard('TC-ARR-06', 'valid indexed assignments, any element type', () => {
    expectNoTypes(src(A, 'set var.a[0] = 1', 'set var.a[1] = "now a string"', 'set var.a[2] = {1, 2}'));
    expectNoTypes(src('var m = {{1, 2}, {3, 4}}', 'set var.m[1][0] = 9'));
  });
});

describe('TC-ARR-07: indexing a bracketed expression (blocked by the syntax layer)', () => {
  rule('TC-ARR-07', 'literal arrays and parenthesised arrays can be indexed', () => {
    expectType(typeOfExpr('{10, 20}[1]'), 'int', '{…}[i]');
    expectType(typeOfExpr('(var.a)[0]', { prelude: [A] }), 'int', '(var)[i]');
    expectNoTypes('echo {1, 2}[0]');
  });
  rule('TC-ARR-07', 'non-array base and bad indices', () => {
    expectTypes('echo (5)[0]', [{ code: CODE.index, at: '(5)', firmware: 'left operand of [ ] is not an array' }], { rrfVersion: '3.5.4' });
    expectTypes('echo {1, 2}[1.5]', [{ code: CODE.index, at: '1.5', firmware: MSG.nonNegativeInt }]);
    expectTypes('echo {1, 2}[-1]', [{ code: CODE.value, at: '-1', firmware: MSG.nonNegativeInt }]);
  });
});

describe('TC-ARR-08: nested indexing', () => {
  rule('TC-ARR-08', 'one index too many', () => {
    expectTypes(src(A, 'echo var.a[0][1]'), [{ code: CODE.index, at: 'var.a', line: 1 }]);
  });
  guard('TC-ARR-08', 'depth matches', () => expectNoTypes(src('var m = {{1, 2}, {3, 4}}', 'echo var.m[1][0] + 1')));
});

describe('TC-ARR-09: object-model arrays', () => {
  rule('TC-ARR-09', 'index must be int', () => {
    expectTypes('echo move.axes[1.5].homed', [{ code: CODE.index, at: '1.5', firmware: MSG.integerExpr }]);
    expectTypes('echo move.axes["x"]', [{ code: CODE.index, at: '"x"', firmware: MSG.integerExpr }]);
  });
  rule('TC-ARR-09', 'element types', () => {
    expectType(typeOfExpr('move.axes[0]'), 'object', 'element with fields');
    expectType(typeOfExpr('tools[0].offsets[0]'), 'unknown', 'element without known fields');
    expectType(typeOfExpr('move.axes[0].letter'), 'string', 'field of element');
  });
  guard('TC-ARR-09', 'index expressions from the object model are fine', () => {
    expectNoTypes('echo tools[state.currentTool].name\necho move.axes[#move.axes - 1].homed');
  });
  void typeAt;
});
