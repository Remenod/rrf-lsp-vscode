// SPEC §8: flow-sensitive types of local variables, observed through hover at each use.

import { describe } from 'node:test';
import { rule, guard, CODE, typeAt, expectType, expectTypes, expectNoTypes } from './contract';
import { src } from '../helpers/harness';

const C = 'move.axes[0].homed';   // a condition the checker cannot fold
const D = 'move.axes[1].homed';

/** Type of `var.x` at the n-th line containing it (0-based line index into the text). */
const at = (text: string, line: number, needle = 'var.x') => typeAt(text, line, needle);

describe('TC-FLOW-01 / 02: declarations and assignments', () => {
  rule('TC-FLOW-01', 'the declaration fixes the initial type', () => {
    const t = src('var x = 2.5', 'echo var.x');
    expectType(at(t, 1), 'float', 'decl');
  });
  rule('TC-FLOW-02', 'set changes the type from the next use on', () => {
    const t = src('var x = 1', 'echo var.x', 'set var.x = "s"', 'echo var.x', 'set var.x = {1,}', 'echo var.x');
    expectType(at(t, 1), 'int', 'before set');
    expectType(at(t, 3), 'string', 'after first set');
    expectType(at(t, 5), 'array<int>', 'after second set');
  });
  rule('TC-FLOW-02', 'the right-hand side sees the old type', () => {
    const t = src('var x = 1', 'set var.x = var.x ^ "!"', 'echo var.x');
    expectType(typeAt(t, 1, 'var.x', 1), 'int', 'rhs of set');
    expectType(at(t, 2), 'string', 'after');
  });
  rule('TC-FLOW-02', 'errors follow the current type', () => {
    expectTypes(src('var x = 1', 'set var.x = "s"', 'echo var.x + 1'), [{ code: CODE.operand, at: 'var.x + 1', line: 2 }]);
    expectNoTypes(src('var x = "s"', 'set var.x = 1', 'echo var.x + 1'));
  });
});

describe('TC-FLOW-03: if / elif / else join', () => {
  rule('TC-FLOW-03', 'without else the pre-if type survives', () => {
    const t = src('var x = 1', `if ${C}`, '  set var.x = "s"', 'echo var.x');
    expectType(at(t, 3), 'int | string', 'join');
  });
  rule('TC-FLOW-03', 'with else only branch types', () => {
    const t = src('var x = 1', `if ${C}`, '  set var.x = "a"', `elif ${D}`, '  set var.x = 2.5', 'else', '  set var.x = true', 'echo var.x');
    expectType(at(t, 7), 'string | float | bool', 'all branches assign');
  });
  rule('TC-FLOW-03', 'a branch that does not assign keeps the incoming type', () => {
    const t = src('var x = 1', `if ${C}`, '  set var.x = "a"', 'else', '  echo 0', 'echo var.x');
    expectType(at(t, 5), 'int | string', 'else without set');
  });
  rule('TC-FLOW-03', 'literal conditions are not folded for flow', () => {
    const t = src('var x = 1', 'if true', '  set var.x = "a"', 'echo var.x');
    expectType(at(t, 3), 'int | string', 'if true');
  });
  guard('TC-FLOW-03', 'a join with one valid member is not an error', () => {
    expectNoTypes(src('var x = 1', `if ${C}`, '  set var.x = "s"', 'echo var.x + 1'));
  });
});

describe('TC-FLOW-04: loops', () => {
  rule('TC-FLOW-04', 'the loop head joins the entry and the end of the body', () => {
    const t = src('var x = 1', 'while iterations < 3', '  echo var.x', '  set var.x = "s"', 'echo var.x');
    expectType(at(t, 2), 'int | string', 'inside, before the set');
    expectType(at(t, 4), 'int | string', 'after the loop');
  });
  rule('TC-FLOW-04', 'continue paths flow back to the head', () => {
    const t = src('var x = 1', 'while iterations < 3', `  if ${C}`, '    set var.x = "s"', '    continue', '  echo var.x');
    expectType(at(t, 5), 'int | string', 'after an if that continues');
  });
  rule('TC-FLOW-04', 'break paths flow to after the loop', () => {
    const t = src('var x = 1', 'while iterations < 3', `  if ${C}`, '    set var.x = "s"', '    break', '  set var.x = 2.5', 'echo var.x');
    expectType(at(t, 6), 'int | float | string', 'after the loop');
  });
  rule('TC-FLOW-04', 'a fixed point over several iterations', () => {
    const t = src('var x = 1', 'var y = 1', 'while iterations < 3', '  set var.y = var.x', '  set var.x = "s"', 'echo var.y');
    expectType(typeAt(t, 5, 'var.y'), 'int | string', 'y picks up x from the previous pass');
  });
  guard('TC-FLOW-04', 'no false positive from a loop-carried type', () => {
    expectNoTypes(src('var x = 1', 'while iterations < 3', '  echo var.x + 1', '  set var.x = "s"'));
  });
});

describe('TC-FLOW-05: abort and M99 end a path (SHOULD)', () => {
  rule('TC-FLOW-05', 'abort', () => {
    const t = src('var x = "s"', `if ${C}`, '  set var.x = 1', '  abort "stop"', 'echo var.x');
    expectType(at(t, 4), 'string', 'the int path aborted');
  });
  rule('TC-FLOW-05', 'M99', () => {
    const t = src('var x = "s"', `if ${C}`, '  set var.x = 1', '  M99', 'echo var.x');
    expectType(at(t, 4), 'string', 'the int path returned');
  });
  rule('TC-FLOW-05', 'precision enables a definite error', () => {
    expectTypes(src('var x = "s"', `if ${C}`, '  set var.x = 1', '  abort', 'echo var.x * 2'), [{ code: CODE.operand, at: 'var.x * 2', line: 4 }]);
  });
});

describe('TC-FLOW-06 / 07 / 08: nesting, siblings, indexed assignment', () => {
  rule('TC-FLOW-06', 'a nested use sees the enclosing block\'s assignments', () => {
    const t = src('var x = 1', `if ${C}`, '  set var.x = "s"', '  echo var.x', `  if ${D}`, '    set var.x = 2.5', '  echo var.x', 'echo var.x');
    expectType(at(t, 3), 'string', 'after set in block');
    expectType(at(t, 6), 'string | float', 'after nested if');
    expectType(at(t, 7), 'int | string | float', 'after outer if');
  });
  rule('TC-FLOW-07', 'sibling blocks have independent variables of the same name', () => {
    const t = src(`if ${C}`, '  var y = 1', '  echo var.y', `if ${D}`, '  var y = "s"', '  echo var.y');
    expectType(typeAt(t, 2, 'var.y'), 'int', 'first block');
    expectType(typeAt(t, 5, 'var.y'), 'string', 'second block');
  });
  rule('TC-FLOW-08', 'indexed set widens the element type, the variable stays an array', () => {
    const t = src('var a = {1, 2}', 'set var.a[0] = "s"', 'echo var.a', 'var e = var.a[1]', 'echo var.e');
    expectType(typeAt(t, 2, 'var.a'), 'array<int | string>', 'array');
    expectType(typeAt(t, 4, 'var.e'), 'int | string', 'element');
  });
  guard('TC-FLOW-08', 'indexed set of another type is never an error', () => {
    expectNoTypes(src('var a = {1, 2}', 'set var.a[0] = "s"', 'set var.a[1] = {1,}', 'echo #var.a'));
  });
});

describe('TC-FLOW-09: null narrowing', () => {
  rule('TC-FLOW-09', '!= null removes null inside the guarded block and operand', () => {
    const t = src('var x = null', `if ${C}`, '  set var.x = 5', 'if var.x != null', '  echo var.x', 'echo var.x != null && var.x > 1');
    expectType(at(t, 4), 'int', 'inside if');
    expectType(typeAt(t, 5, 'var.x', 1), 'int', 'right of &&');
    expectType(at(t, 5), 'int | null', 'the guard itself');
  });
  rule('TC-FLOW-09', '== null narrows to null, and the else branch to non-null', () => {
    const t = src('var x = null', `if ${C}`, '  set var.x = "s"', 'if var.x == null', '  echo var.x', 'else', '  echo var.x');
    expectType(at(t, 4), 'null', 'then');
    expectType(at(t, 6), 'string', 'else');
  });
  rule('TC-FLOW-09', 'narrowing makes a definite error visible', () => {
    expectTypes(src('var x = null', `if ${C}`, '  set var.x = "s"', 'if var.x != null', '  echo var.x * 2'),
      [{ code: CODE.operand, at: 'var.x * 2', line: 4 }]);
  });
  guard('TC-FLOW-09', 'a branch narrowed to nothing is never reported', () => {
    expectNoTypes(src('var x = null', 'if var.x != null', '  echo var.x + 1'));
    expectNoTypes(src('var x = 5', 'if var.x == null', '  echo var.x + "a"'));
  });
});
