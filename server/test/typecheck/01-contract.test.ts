// SPEC §1–2: settings, diagnostic shape, ranges, suppression, the type lattice and its display.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  rule, guard, CODE, ALL_CODES, lintTc, typeDiags, lostDiags, expectTypes, expectNoTypes,
  typeAt, typeOfExpr, expectType, hoverText,
} from './contract';
import { src } from '../helpers/harness';

/** A non-constant Boolean (object-model leaf) — keeps conditions out of constant folding. */
const H = 'move.axes[0].homed';

describe('TC-CFG: settings', () => {
  guard('TC-CFG-01', 'checker off: no diagnostic carries a type-check code', () => {
    for (const t of ['echo "a" + 1', 'if 1\n  echo 1', 'echo abs("x")', 'echo round(1.5)']) {
      for (const v of [undefined, '3.5.4']) {
        const ds = lintTc(t, { rrfVersion: v }, false);
        assert.deepEqual(ds.filter(d => ALL_CODES.has(String(d.code))).map(d => d.message), [], t);
      }
    }
  });
  rule('TC-CFG-01', 'omitting the option means enabled', () => {
    const ds = lintTc('echo "a" + 1', {}, 'omit');
    assert.ok(ds.some(d => d.code === CODE.operand), JSON.stringify(ds.map(d => d.message)));
  });
  rule('TC-CFG-01', 'enabled: the obvious error is reported', () => {
    assert.ok(typeDiags('echo "a" + 1').length === 1);
  });

  guard('TC-CFG-02', 'version-neutral values never produce rrf-version diagnostics', () => {
    for (const v of [undefined, '', 'garbage', '3', 'v3.5', '3.2.9', '2.05', '3.x']) {
      const ds = typeDiags('echo round(1.5)\necho square(2)\necho take("abc", 1)\necho input', { rrfVersion: v });
      assert.deepEqual(ds.filter(d => d.code === CODE.version).map(d => d.message), [], String(v));
    }
  });
  rule('TC-CFG-02', 'a malformed version behaves exactly like no version', () => {
    const t = 'echo round(1.5)\necho "a" + 1';
    assert.deepEqual(typeDiags(t, { rrfVersion: 'garbage' }).map(d => d.message), typeDiags(t).map(d => d.message));
    assert.equal(typeDiags(t).length, 1);
  });

  guard('TC-CFG-04', 'the checker never removes or changes another diagnostic', () => {
    const samples = [
      'echo 1 +', 'G1 X10 X20', 'echo var.nope', 'M117 ' + 'x'.repeat(300), 'if 1\n  break',
      'var a = 1\nvar a = 2', 'echo nonsense', 'echo abs(1, 2)', 'echo "a" + 1', 'echo #10',
      'set param.A = 1', 'else\n  echo 1', 'echo exists(var.x) && var.x > 1',
    ];
    for (const t of samples) for (const v of [undefined, '3.5.4']) {
      assert.deepEqual(lostDiags(t, { rrfVersion: v }).map(d => d.message), [], t);
    }
  });
});

describe('TC-DIAG: diagnostic shape', () => {
  rule('TC-DIAG-01', 'codes and source', () => {
    const cases: Array<[string, string]> = [
      ['echo "a" + 1', CODE.operand],
      ['if 1\n  echo 1', CODE.boolean],
      ['echo abs("x")', CODE.argument],
      ['var a = {1, 2}\necho var.a[1.5]', CODE.index],
      ['echo random(0)', CODE.value],
    ];
    for (const [t, code] of cases) {
      const ds = typeDiags(t);
      assert.equal(ds.length, 1, `${t}: ${JSON.stringify(ds.map(d => d.message))}`);
      assert.equal(ds[0].code, code, t);
      assert.equal(ds[0].source, 'rrf-gcode', t);
    }
    const v = typeDiags('echo round(1.5)', { rrfVersion: '3.5.4' });
    assert.equal(v[0]?.code, CODE.version);
  });

  rule('TC-DIAG-02', 'type errors are errors', () => {
    expectTypes('echo "a" + 1', [{ code: CODE.operand, at: '"a" + 1', severity: 'error' }]);
  });

  rule('TC-DIAG-03', 'message quotes the firmware text and names the types', () => {
    expectTypes('echo "a" + 1', [{ code: CODE.operand, at: '"a" + 1', firmware: 'expected numeric operands', mentions: ['string', 'int'] }]);
    expectTypes('echo 1.5 + "a"', [{ code: CODE.operand, at: '1.5 + "a"', firmware: 'expected numeric operand', mentions: ['float', 'string'] }]);
    expectTypes('if 1\n  echo 1', [{ code: CODE.boolean, at: '1', line: 0, firmware: 'expected Boolean operand', mentions: ['int'] }]);
    expectTypes('echo abs("x")', [{ code: CODE.argument, at: '"x"', firmware: 'expected numeric operand', mentions: ['string'] }]);
  });

  rule('TC-DIAG-04', 'range: binary covers the whole sub-expression, spacing included', () => {
    expectTypes('echo "a"   +   1', [{ code: CODE.operand, at: '"a"   +   1' }]);
    expectTypes('echo (("a" + 1))', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo 2 * (true + 1)', [{ code: CODE.operand, at: 'true + 1' }]);
  });
  rule('TC-DIAG-04', 'range: unary, logic operand, condition, argument, index, non-array base', () => {
    expectTypes('echo -"a"', [{ code: CODE.operand, at: '-"a"' }]);
    expectTypes('echo true && 1', [{ code: CODE.boolean, at: '1' }]);
    expectTypes('if  1 + 1  ; trailing comment\n  echo 1', [{ code: CODE.boolean, at: '1 + 1' }]);
    expectTypes('echo abs( "x" )', [{ code: CODE.argument, at: '"x"' }]);
    expectTypes('var a = {1, 2}\necho var.a["k"]', [{ code: CODE.index, at: '"k"', line: 1 }]);
    expectTypes('var n = 5\necho var.n[0]', [{ code: CODE.index, at: 'var.n', line: 1 }]);
  });
  rule('TC-DIAG-04', 'range: the diagnostic is on the line of the expression, also inside G-code braces', () => {
    expectTypes('G1 X10\nG1 X{"a" + 1} Y2', [{ code: CODE.operand, at: '"a" + 1', line: 1 }]);
  });

  rule('TC-DIAG-05', 'one diagnostic per root cause', () => {
    expectTypes('echo ("a" + 1) * 2', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo abs("a" + 1)', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo !("a" + 1)', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo -("a" + 1) + "b"', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('if ("a" + 1) > 2\n  echo 1', [{ code: CODE.operand, at: '"a" + 1' }]);
  });
  rule('TC-DIAG-05', 'independent errors on one line are all reported', () => {
    expectTypes('echo "a" + 1, true * 2', [
      { code: CODE.operand, at: '"a" + 1' },
      { code: CODE.operand, at: 'true * 2' },
    ]);
  });

  guard('TC-DIAG-06', 'no type diagnostics on lines that already have an error', () => {
    for (const t of [
      'echo "a" + 1 +',            // dangling operator
      'echo ("a" + 1',             // unclosed bracket
      'echo abs("a", 2)',          // arity
      'echo #10 + "a"',            // '#' on a numeric literal
      'echo var.undef + "a"',      // undefined variable
      'echo "a" + 1 "b"',          // missing separator
      'echo "abc',                 // lexer: unclosed string
    ]) expectNoTypes(t);
  });

  guard('TC-DIAG-07', 'values the server cannot see are unknown and never reported', () => {
    for (const t of [
      'echo foo(1) + "a"',
      'echo state.vmFeatureLevel + "a"',
      'echo nonsense.path * 2',
      'if exists(var.never)\n  echo var.never + "a"',
      'echo global.notDeclaredAnywhere + "a"',
      'echo param.A + "a"',
      'echo input + "a"',
    ]) expectNoTypes(t);
  });

  guard('TC-DIAG-08', 'a union operand with one succeeding member is not reported', () => {
    expectNoTypes(src('var x = 1', `if ${H}`, '  set var.x = "s"', 'echo var.x + 1'));
    expectNoTypes(`echo (${H} ? 1 : "a") + 1`);
    expectNoTypes(`if ${H} ? true : 1\n  echo 1`);
    expectNoTypes('echo -heat.heaters[0].current');           // number = int | uint | float
    expectNoTypes('echo abs(move.axes[0].max)');
  });
  rule('TC-DIAG-08', 'a union operand whose members all fail is reported', () => {
    expectTypes(src('var x = "a"', `if ${H}`, '  set var.x = true', 'echo var.x + 1'),
      [{ code: CODE.operand, at: 'var.x + 1', line: 3 }]);
    expectTypes(`echo (${H} ? "a" : "b") + 1`, [{ code: CODE.operand, at: `(${H} ? "a" : "b") + 1` }]);
  });
});

describe('TC-TYPE: lattice and display', () => {
  rule('TC-TYPE-01', 'one value of every type', () => {
    const rows: Array<[string, string]> = [
      ['1', 'int'], ['3000000000', 'uint'], ['1.5', 'float'], ['true', 'bool'], ['"s"', 'string'],
      ["'c'", 'char'], ['datetime(0)', 'datetime'], ['vector(2, 0)', 'array<int>'], ['move.axes[0]', 'object'],
      ['null', 'null'],
    ];
    for (const [e, t] of rows) expectType(typeOfExpr(e), t, e);
  });
  rule('TC-TYPE-02', 'unknown absorbs unions', () => {
    expectType(typeOfExpr(`${H} ? param.A : 1`), 'unknown', 'param branch');
    expectType(typeOfExpr(`${H} ? 1 : state.vmFeatureLevel`), 'unknown', 'unknown OM branch');
  });
  rule('TC-TYPE-03', 'unions are displayed with |', () => {
    const h = hoverText(src(`var t = ${H} ? 1 : "a"`, 'echo var.t'), 1, 'var.t') ?? '';
    assert.match(h, /Type: `[a-z<> |]+`/);
    expectType(typeAt(src(`var t = ${H} ? 1 : "a"`, 'echo var.t'), 1, 'var.t'), 'string | int', 'ternary');
    expectType(typeOfExpr('heat.heaters[0].current'), 'number', 'OM number');
  });
  rule('TC-TYPE-04', 'param hover shows Type: unknown', () => {
    expectType(typeAt('echo param.A', 0, 'param.A'), 'unknown', 'param');
  });
});
