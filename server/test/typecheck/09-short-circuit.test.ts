// SPEC §9: what the firmware does with the operand it skips (evaluate == false).

import { describe } from 'node:test';
import { rule, guard, CODE, expectTypes, expectNoTypes } from './contract';
import { MSG } from './model';
import { src } from '../helpers/harness';

const C = 'move.axes[0].homed';
const DECLS = ['var x = 5', 'var s = "2024-01-01T00:00:00"', 'var arr = {1, 2}', 'var n = 3'];
const withDecls = (...lines: string[]) => src(...DECLS, ...lines);
const L = DECLS.length;   // line index of the first statement after the declarations

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

describe('TC-SC-03: operands that throw exactly when they are skipped (SHOULD)', () => {
  const warn = (at: string, firmware: string, extra: RegExp[] = []) =>
    ({ code: CODE.skipped, at, line: L, severity: 'warning' as const, firmware, mentions: extra });

  rule('TC-SC-03', 'unary minus on a variable after &&', () => {
    expectTypes(withDecls(`if ${C} && -var.x < 0`, '  echo 1'), [warn('-var.x', MSG.unaryMinus, [/0 - var\.x/])]);
  });
  rule('TC-SC-03', '|| and both ?: branches', () => {
    expectTypes(withDecls(`echo ${C} || -var.x < 0`), [warn('-var.x', MSG.unaryMinus)]);
    expectTypes(withDecls(`echo ${C} ? -var.x : var.x`), [warn('-var.x', MSG.unaryMinus)]);
    expectTypes(withDecls(`echo ${C} ? var.x : -var.x`), [warn('-var.x', MSG.unaryMinus)]);
  });
  rule('TC-SC-03', 'nested deeper inside the skipped operand', () => {
    expectTypes(withDecls(`echo ${C} && (1 + -var.x) < 0`), [warn('-var.x', MSG.unaryMinus)]);
    expectTypes(withDecls(`G1 X{${C} ? -var.x : 0}`), [warn('-var.x', MSG.unaryMinus)]);
  });
  rule('TC-SC-03', 'parenthesised identifiers, #identifier, unary plus', () => {
    expectTypes(withDecls(`echo ${C} && -(var.x) < 0`), [warn('-(var.x)', MSG.unaryMinus)]);
    expectTypes(withDecls(`echo ${C} && -#var.arr < 0`), [warn('-#var.arr', MSG.unaryMinus)]);
    expectTypes(withDecls(`echo ${C} && +var.x > 0`), [warn('+var.x', MSG.unaryPlus)]);
  });
  rule('TC-SC-03', 'parameters, globals and object-model values are null too', () => {
    expectTypes(src(`echo ${C} && -param.A < 0`), [{ code: CODE.skipped, at: '-param.A', severity: 'warning' }]);
    expectTypes(src(`echo ${C} && -move.axes[0].max < 0`), [{ code: CODE.skipped, at: '-move.axes[0].max', severity: 'warning' }]);
  });
  rule('TC-SC-03', 'random, datetime and single-argument max/min of an identifier', () => {
    expectTypes(withDecls(`echo ${C} && random(var.n) > 0`), [warn('random(var.n)', MSG.positiveInt)]);
    expectTypes(withDecls(`echo ${C} && datetime(var.s) > datetime(0)`), [warn('datetime(var.s)', MSG.toDateTime)]);
    expectTypes(withDecls(`echo ${C} && max(var.arr) > 0`), [warn('max(var.arr)', MSG.notArray)]);
  });
  rule('TC-SC-03', 'a literal that always skips turns the hazard into a definite error', () => {
    expectTypes(withDecls('echo false && -var.x < 0'), [{ code: CODE.skipped, at: '-var.x', line: L, severity: 'error', firmware: MSG.unaryMinus }]);
  });
});

describe('TC-SC-04: fileread opens the file even when skipped (SHOULD)', () => {
  rule('TC-SC-04', 'fileread in a skippable operand', () => {
    expectTypes(`echo fileexists("0:/sys/data.csv") && fileread("0:/sys/data.csv", 0, 1, ',') != null`,
      [{ code: CODE.skipped, at: 'fileread("0:/sys/data.csv", 0, 1, \',\')', severity: 'warning' }]);
  });
});

describe('TC-SC-05: safe forms are never flagged', () => {
  guard('TC-SC-05', 'rewrites, literals, left operands, statement level, if blocks', () => {
    for (const t of [
      `echo ${C} && 0 - var.x < 0`,
      `echo ${C} && var.x * -1 < 0`,
      `echo ${C} && abs(var.x) > 0`,
      `echo ${C} && max(var.x, 0) > 0`,
      `echo ${C} && -1 < var.x`,
      `echo ${C} && random(10) > 0`,
      `echo ${C} && datetime(0) < datetime(1)`,
      `echo ${C} ? 0 - var.x : var.x`,
      `echo -var.x < 0 && ${C}`,
      'echo -var.x',
      `if ${C}\n  echo -var.x`,
      `echo ${C} && #var.arr > 0`,
      `echo ${C} && fileexists("0:/sys/config.g")`,
    ]) expectNoTypes(withDecls(t));
  });
});
