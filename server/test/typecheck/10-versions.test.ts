// SPEC §10: what exists on which firmware line.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rule, guard, CODE, expectTypes, expectNoTypes, typeDiags, typeOfExpr, expectType } from './contract';
import { FUNCTIONS_FROM_3_6, MSG } from './model';
import { FUNCTION_NAMES } from '../../src/parser/types';

/** A call that is valid on every version where the function exists. */
const CALL: Record<string, string> = {
  abs: 'abs(-1)', acos: 'acos(1)', asin: 'asin(1)', atan: 'atan(1)', atan2: 'atan2(1, 1)', cos: 'cos(1)',
  degrees: 'degrees(1)', exists: 'exists(move.axes[0])', floor: 'floor(1.5)', isnan: 'isnan(1)', max: 'max(1, 2)',
  min: 'min(1, 2)', mod: 'mod(5, 2)', radians: 'radians(1)', random: 'random(5)', sin: 'sin(1)', sqrt: 'sqrt(4)',
  tan: 'tan(1)', datetime: 'datetime(0)', ceil: 'ceil(1.5)', exp: 'exp(1)', fileexists: 'fileexists("a.g")',
  fileread: "fileread(\"a.csv\", 0, 1, ',')", log: 'log(2)', pow: 'pow(2, 2)', vector: 'vector(1, 0)',
  drop: 'drop("abc", 1)', find: 'find("abc", \'b\')', take: 'take("abc", 1)', square: 'square(2)', round: 'round(1.5)',
};

describe('TC-VER-01: functions added in 3.6', () => {
  guard('TC-VER-01', 'the call table covers every function the server knows', () => {
    assert.deepEqual(Object.keys(CALL).sort(), [...FUNCTION_NAMES].sort());
  });
  for (const fn of FUNCTIONS_FROM_3_6) {
    rule('TC-VER-01', `${fn}: unknown on 3.5`, () => {
      expectTypes(`echo ${CALL[fn]}`, [{ code: CODE.version, at: fn, firmware: MSG.unknownFunction, mentions: ['3.6', '3.5'] }], { rrfVersion: '3.5' });
    });
  }
  for (const v of ['3.6', '3.7']) {
    guard('TC-VER-01', `every function is available on ${v}`, () => {
      for (const fn of Object.keys(CALL)) {
        assert.deepEqual(typeDiags(`echo ${CALL[fn]}`, { rrfVersion: v }).filter(d => d.code === CODE.version).map(d => d.message), [], fn);
      }
    });
  }
  rule('TC-VER-01', '3.5 rejects exactly the 3.6 functions', () => {
    const rejected = Object.keys(CALL).filter(fn => typeDiags(`echo ${CALL[fn]}`, { rrfVersion: '3.5' }).some(d => d.code === CODE.version));
    assert.deepEqual(rejected.sort(), [...FUNCTIONS_FROM_3_6].sort());
  });
  rule('TC-VER-01', 'the result of an unavailable function is unknown (no cascade)', () => {
    expectTypes('echo round(1.5) + "a"', [{ code: CODE.version, at: 'round' }], { rrfVersion: '3.5' });
  });
});

describe('TC-VER-02: string indexing on bracketed expressions', () => {
  rule('TC-VER-02', 'an error on 3.5, a char on 3.6 and 3.7', () => {
    expectTypes('echo ("abc")[0]', [{ code: CODE.index, at: '("abc")', firmware: 'left operand of [ ] is not an array' }], { rrfVersion: '3.5' });
    expectNoTypes('echo ("abc")[0]', { rrfVersion: '3.6' });
    expectNoTypes('echo ("abc")[0]', { rrfVersion: '3.7' });
    expectType(typeOfExpr('("abc")[0]'), 'char', 'string index (hover uses the newest table)');
  });
});

describe('TC-VER-03: no target', () => {
  guard('TC-VER-03', 'every known function is accepted', () => {
    for (const fn of Object.keys(CALL)) {
      assert.deepEqual(typeDiags(`echo ${CALL[fn]}`).filter(d => d.code === CODE.version).map(d => d.message), [], fn);
    }
  });
  guard('TC-VER-03', 'version-dependent outcomes are not reported', () => expectNoTypes('echo ("abc")[0]'));
  rule('TC-VER-03', 'newer functions are typed by the newest table', () => {
    expectType(typeOfExpr('round(2.5)'), 'int', 'round');
  });
});
