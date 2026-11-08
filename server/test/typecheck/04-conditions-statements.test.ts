// SPEC §5 and §12: conditions, statements, G-code command lines.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rule, guard, CODE, Expect, typeDiags, matchDiagnostics, expectTypes, expectNoTypes } from './contract';
import { ALL_TYPES, LITERAL, MENTION, MSG } from './model';
import { src } from '../helpers/harness';

describe('TC-COND-01: if / elif / while need a Boolean', () => {
  for (const kw of ['if', 'elif', 'while'] as const) {
    rule('TC-COND-01', `${kw} <every type>`, () => {
      const problems: string[] = [];
      for (const t of ALL_TYPES) {
        const lit = LITERAL[t];
        const text = kw === 'elif'
          ? src('if move.axes[0].homed', '  echo 1', `elif ${lit}`, '  echo 2')
          : src(`${kw} ${lit}`, '  echo 1');
        const line = kw === 'elif' ? 2 : 0;
        const expected: Expect[] = t === 'bool' ? [] : [{ code: CODE.boolean, at: lit, line, firmware: MSG.boolean, mentions: [MENTION[t]] }];
        for (const p of matchDiagnostics(text, typeDiags(text), expected)) problems.push(`${kw} ${lit}: ${p}`);
      }
      assert.deepEqual(problems, []);
    });
  }
  rule('TC-COND-01', 'the range is the whole condition, without a trailing comment', () => {
    expectTypes('if 1 + 2   ; note\n  echo 1', [{ code: CODE.boolean, at: '1 + 2' }]);
    expectTypes('while #"abc"\n  break', [{ code: CODE.boolean, at: '#"abc"' }]);
    expectTypes(src('var n = 3', 'while var.n', '  break'), [{ code: CODE.boolean, at: 'var.n', line: 1 }]);
  });
  guard('TC-COND-01', 'Boolean conditions', () => {
    for (const c of ['true', '1 < 2', 'move.axes[0].homed', '!move.axes[0].homed', 'state.status == "idle"',
      'exists(global.x)', 'fileexists("0:/sys/config.g")', 'isnan(1.5)', '1 == 1 && 2 == 2', 'iterations < 3'.replace('iterations', 'line')])
      expectNoTypes(`if ${c}\n  echo 1`);
    expectNoTypes(src('while iterations < 3', '  echo iterations'));
  });
});

describe('TC-COND-02: braced conditions', () => {
  rule('TC-COND-02', 'if {expr} is checked the same way', () => {
    expectTypes('if {1 + 2}\n  echo 1', [{ code: CODE.boolean, at: '1 + 2' }]);
  });
  guard('TC-COND-02', 'Boolean braced conditions', () => expectNoTypes('if {move.axes[0].homed}\n  echo 1\nwhile {iterations < 2}\n  echo 2'));
});

describe('TC-COND-03: literal-false blocks are not dead code for the checker', () => {
  rule('TC-COND-03', 'errors inside "if false" are still reported', () => {
    expectTypes(src('if false', '  echo "a" + 1'), [{ code: CODE.operand, at: '"a" + 1', line: 1 }]);
    expectTypes(src('while false', '  echo true * 2'), [{ code: CODE.operand, at: 'true * 2', line: 1 }]);
  });
});

describe('TC-STMT: statements', () => {
  guard('TC-STMT-01', 'echo accepts every type, also as a redirect file name', () => {
    for (const t of ALL_TYPES) {
      expectNoTypes(`echo ${LITERAL[t]}`);
      expectNoTypes(`echo ${LITERAL[t]}, ${LITERAL[t]}`);
      expectNoTypes(`echo >{${LITERAL[t]}} "line"`);
    }
  });
  rule('TC-STMT-01', 'echo items are still checked internally', () => {
    expectTypes('echo 1, "a" + 1, 3', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo >{"f" + 1} "x"', [{ code: CODE.operand, at: '"f" + 1' }]);
  });
  guard('TC-STMT-02', 'var / global / set accept every type and may change it', () => {
    for (const t of ALL_TYPES) {
      expectNoTypes(`var x = ${LITERAL[t]}`);
      expectNoTypes(`global g${t} = ${LITERAL[t]}`);
      for (const u of ALL_TYPES) expectNoTypes(src(`var x = ${LITERAL[t]}`, `set var.x = ${LITERAL[u]}`));
    }
  });
  rule('TC-STMT-02', 'right-hand sides are checked internally', () => {
    expectTypes('var x = "a" + 1', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes(src('var x = 1', 'set var.x = true * 2'), [{ code: CODE.operand, at: 'true * 2', line: 1 }]);
    expectTypes('global q = -"a"', [{ code: CODE.operand, at: '-"a"' }]);
  });
  rule('TC-STMT-03', 'a type error in an abort message is a warning', () => {
    expectTypes('abort "code " + 5', [{ code: CODE.operand, at: '"code " + 5', severity: 'warning', firmware: MSG.numericOperands }]);
  });
  guard('TC-STMT-03', 'well-formed abort messages', () => expectNoTypes('abort\nabort "x"\nabort "code " ^ 5\nabort 5'));
});

describe('TC-GC: G-code command lines', () => {
  rule('TC-GC-01', 'braced expressions on G/M/T lines are checked', () => {
    expectTypes('G1 X{"a" + 1}', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('M291 P"x" S{true * 2}', [{ code: CODE.operand, at: 'true * 2' }]);
    expectTypes('G1 X{1 ? 2 : 3}', [{ code: CODE.boolean, at: '1', occurrence: 1 }]);
    expectTypes('M104 S{abs("x")} T0', [{ code: CODE.argument, at: '"x"' }]);
    expectTypes('T{"a" + 1}', [{ code: CODE.operand, at: '"a" + 1' }]);
  });
  guard('TC-GC-02', 'parameter values are not checked against the parameter type in phase 1', () => {
    // String-valued parameters (GetQuotedString / AppendAsString) accept every type — this stays true in phase 2.
    for (const t of ['M98 P{1}', 'M291 P{3.5} S1', 'M291 R{true} P"x" S1', 'M117 {vector(2, 0)}', 'M98 P{"a" ^ 1}',
      'M98 P"x.g" A{move.axes[0]}', 'M98 P"x.g" B{null}', 'echo >{1} "x"'])
      expectNoTypes(t);
    // Numeric parameters are not checked yet (TC-GC-03 flips these).
    for (const t of ['G1 X{"10"}', 'G1 X{true}', 'M291 S{2.0} P"x"', 'M568 P0 S{null}']) expectNoTypes(t);
  });
  rule('TC-GC-03', 'PHASE 2: numeric parameters given a string or Boolean', () => {
    expectTypes('G1 X{"10"}', [{ code: CODE.argument, at: '"10"', firmware: MSG.numericOperand }]);
    expectTypes('G1 X{true}', [{ code: CODE.argument, at: 'true' }]);
  });
});
