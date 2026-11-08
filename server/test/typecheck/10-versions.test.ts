// SPEC §10 and TC-CFG-03: what exists on which firmware.
// Tables from the upstream tags (NamedEnum(Function, …) / NamedEnum(NamedConstant, …)).

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rule, guard, CODE, expectTypes, expectNoTypes, typeDiags, typeOfExpr, expectType } from './contract';
import { FUNCTIONS_INTRODUCED, MSG } from './model';
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

/** The last version before `v` that the tests use as "too old". */
const BEFORE: Record<string, string> = {
  '3.4.0': '3.3', '3.5.0': '3.4.6', '3.6.0-beta.4': '3.6.0-beta.3', '3.6.0-rc.2': '3.6.0-rc.1', '3.6.0-rc.3': '3.6.0-rc.2',
};

describe('TC-VER-01: function availability', () => {
  guard('TC-VER-01', 'the call table covers every function the server knows', () => {
    assert.deepEqual(Object.keys(CALL).sort(), [...FUNCTION_NAMES].sort());
  });
  for (const { version, names } of FUNCTIONS_INTRODUCED) {
    for (const fn of names) {
      const text = `echo ${CALL[fn]}`;
      if (BEFORE[version]) {
        rule('TC-VER-01', `${fn}: unknown on ${BEFORE[version]}`, () => {
          expectTypes(text, [{ code: CODE.version, at: fn, firmware: MSG.unknownFunction, mentions: [version] }], { rrfVersion: BEFORE[version] });
        });
      }
      guard('TC-VER-01', `${fn}: available on ${version}`, () => {
        const ds = typeDiags(text, { rrfVersion: version }).filter(d => d.code === CODE.version);
        assert.deepEqual(ds.map(d => d.message), []);
      });
    }
  }
  rule('TC-VER-01', 'the 22IDEX target (3.5.4) rejects exactly the five newer functions', () => {
    const rejected = Object.keys(CALL).filter(fn => typeDiags(`echo ${CALL[fn]}`, { rrfVersion: '3.5.4' }).some(d => d.code === CODE.version));
    assert.deepEqual(rejected.sort(), ['drop', 'find', 'round', 'square', 'take']);
  });
});

describe('TC-VER-02: named constants', () => {
  rule('TC-VER-02', 'input needs 3.5.0', () => {
    expectTypes('echo input', [{ code: CODE.version, at: 'input', mentions: ['3.5.0'] }], { rrfVersion: '3.4.6' });
  });
  guard('TC-VER-02', 'input on 3.5.0, the other constants everywhere', () => {
    expectNoTypes('echo input', { rrfVersion: '3.5.0' });
    expectNoTypes('echo true, false, null, pi, line, result', { rrfVersion: '3.3' });
  });
});

describe('TC-VER-03: string indexing on bracketed expressions (blocked by the syntax layer)', () => {
  rule('TC-VER-03', 'an error before 3.6.0-beta.4, a char from then on', () => {
    expectTypes('echo ("abc")[0]', [{ code: CODE.index, at: '("abc")', firmware: 'left operand of [ ] is not an array' }], { rrfVersion: '3.5.4' });
    expectNoTypes('echo ("abc")[0]', { rrfVersion: '3.6.0-beta.4' });
    expectType(typeOfExpr('("abc")[0]'), 'char', 'string index (hover uses the newest table)');
  });
});

describe('TC-VER-04 / 05 / 06: neutral, newest and shape', () => {
  guard('TC-VER-04', 'no version: every known function is accepted', () => {
    for (const fn of Object.keys(CALL)) {
      assert.deepEqual(typeDiags(`echo ${CALL[fn]}`).filter(d => d.code === CODE.version).map(d => d.message), [], fn);
    }
  });
  guard('TC-VER-04', 'no version: version-dependent outcomes are not reported', () => expectNoTypes('echo ("abc")[0]'));
  rule('TC-VER-04', 'no version: newer functions are typed by the newest table', () => {
    expectType(typeOfExpr('round(2.5)'), 'int', 'round');
  });
  guard('TC-VER-05', 'versions beyond the newest table use the newest table', () => {
    for (const v of ['3.7', '3.7.0-beta.1', '4.0']) {
      assert.deepEqual(typeDiags('echo round(1.5)\necho take("ab", 1)', { rrfVersion: v }).filter(d => d.code === CODE.version).map(d => d.message), [], v);
    }
  });
  rule('TC-VER-06', 'diagnostic shape', () => {
    expectTypes('echo round(1.5) + 1', [{ code: CODE.version, at: 'round', severity: 'error', firmware: MSG.unknownFunction, mentions: ['3.6.0-rc.3', '3.5.4'] }], { rrfVersion: '3.5.4' });
  });
  rule('TC-VER-06', 'the result of an unavailable function is unknown (no cascade)', () => {
    expectTypes('echo round(1.5) + "a"', [{ code: CODE.version, at: 'round' }], { rrfVersion: '3.5.4' });
  });
});

describe('TC-CFG-03: version strings', () => {
  const unknownOn = (v: string, fn: string) => typeDiags(`echo ${CALL[fn]}`, { rrfVersion: v }).some(d => d.code === CODE.version);
  rule('TC-CFG-03', 'X.Y means X.Y.0', () => {
    assert.equal(unknownOn('3.5', 'vector'), false);
    assert.equal(unknownOn('3.4', 'vector'), true);
  });
  rule('TC-CFG-03', 'pre-release ordering alpha < beta < rc < release', () => {
    assert.equal(unknownOn('3.6.0-alpha.2', 'take'), true);
    assert.equal(unknownOn('3.6.0-beta.4', 'take'), false);
    assert.equal(unknownOn('3.6.0-rc.2', 'round'), true);
    assert.equal(unknownOn('3.6.0-rc.3', 'round'), false);
    assert.equal(unknownOn('3.6.0', 'round'), false);
  });
  rule('TC-CFG-03', 'unknown suffixes are ignored: 3.5.4-vm.1 is 3.5.4', () => {
    assert.equal(unknownOn('3.5.4-vm.1', 'round'), true);
    assert.equal(unknownOn('3.5.4-vm.1', 'vector'), false);
  });
});
