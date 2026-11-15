// SPEC §9: what the firmware does with the operand it skips (evaluate == false).

import { describe } from 'node:test';
import { rule, guard, CODE, expectTypes, expectNoTypes } from './contract';
import { MSG } from './model';

const C = 'move.axes[0].homed';

describe('TC-SC-01: a literal deciding operand suppresses evaluation-dependent errors', () => {
  guard('TC-SC-01', 'the skipped operand is parsed but not evaluated', () => {
    for (const e of [
      'false && ("a" + 1 > 0)', 'true || "a" * 2 > 0', 'true ? 1 : "a" + 1', 'false ? "a" + 1 : 1',
      'false && abs("x") > 0', 'false && 1', 'true || null', 'false && !5', 'true ? 0 : #(5.5) > 1',
    ]) expectNoTypes(`echo ${e}`);
  });
  rule('TC-SC-01', 'the same operands are reported when they do run', () => {
    expectTypes('echo true && ("a" + 1 > 0)', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo false ? 1 : "a" + 1', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo true && 1', [{ code: CODE.boolean, at: '1' }]);
  });
  rule('TC-SC-01', 'errors the firmware raises unconditionally are still reported', () => {
    expectTypes('echo false && -"a" == 1', [{ code: CODE.operand, at: '-"a"', firmware: MSG.unaryMinus }]);
    expectTypes('echo true || random(0) > 1', [{ code: CODE.value, at: '0', occurrence: 0, firmware: MSG.positiveInt }]);
    expectTypes('echo false && datetime(1.5) > datetime(0)', [{ code: CODE.argument, at: '1.5', firmware: MSG.toDateTime }]);
    expectTypes('echo false && max(5) > 1', [{ code: CODE.argument, at: '5', firmware: MSG.notArray }]);
  });
});

describe('TC-SC-02: a non-literal deciding operand checks both sides', () => {
  rule('TC-SC-02', 'right of && / ||, both branches of ?:', () => {
    expectTypes(`echo ${C} && "a" + 1 > 0`, [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes(`echo ${C} || 1`, [{ code: CODE.boolean, at: '1', occurrence: 0 }]);
    expectTypes(`echo ${C} ? "a" * 2 : true * 3`, [{ code: CODE.operand, at: '"a" * 2' }, { code: CODE.operand, at: 'true * 3' }]);
  });
});
