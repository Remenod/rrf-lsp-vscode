// SPEC §4: operators. The matrices are generated from model.ts (itself checked by oracle.test.ts):
// every operator × every left type × every right type, for both the diagnostic and the result type.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  rule, guard, CODE, Code, Expect, typeDiags, matchDiagnostics, expectTypes, expectNoTypes,
  typeOfExpr, expectType, canonType,
} from './contract';
import {
  ALL_TYPES, LITERAL, MENTION, BINARY_OPS, BinOp, LOGIC_OPS, UNARY_OPS, UnOp, Ty, binary, unary, isErr, MSG,
} from './model';
import { src } from '../helpers/harness';

const H = 'move.axes[0].homed';

const RULE_OF: Record<BinOp, string> = {
  '+': 'TC-ARITH-01', '-': 'TC-ARITH-01', '*': 'TC-ARITH-01', '/': 'TC-ARITH-03', '^': 'TC-CAT-01',
  '&&': 'TC-BOOL-01', '||': 'TC-BOOL-01', '<': 'TC-CMP-01', '>': 'TC-CMP-01', '<=': 'TC-CMP-01', '>=': 'TC-CMP-01',
  '==': 'TC-EQ-02', '!=': 'TC-EQ-02',
};

/** Source and expected diagnostics for `echo L op R`. */
function binaryCase(op: BinOp, a: Ty, b: Ty): { text: string; expr: string; expected: Expect[] } {
  // && needs a true left operand and || a false one, or the right operand is skipped (TC-SC-01).
  const left = a === 'bool' ? (op === '||' ? 'false' : 'true') : LITERAL[a];
  const right = LITERAL[b];
  const expr = `${left} ${op} ${right}`;
  const text = `echo ${expr}`;
  const lStart = 5, lEnd = lStart + left.length, rStart = lEnd + op.length + 2, rEnd = rStart + right.length;
  const expected: Expect[] = [];
  if (LOGIC_OPS.has(op)) {
    if (a !== 'bool') expected.push({ code: CODE.boolean, at: { line: 0, start: lStart, end: lEnd }, firmware: MSG.boolean, mentions: [MENTION[a]] });
    if (b !== 'bool') expected.push({ code: CODE.boolean, at: { line: 0, start: rStart, end: rEnd }, firmware: MSG.boolean, mentions: [MENTION[b]] });
  } else {
    const r = binary(op, a, b);
    if (isErr(r)) expected.push({ code: CODE.operand, at: { line: 0, start: lStart, end: rEnd }, firmware: r.err, mentions: [MENTION[a], MENTION[b]] });
  }
  return { text, expr, expected };
}

describe('operator matrix: diagnostics (every op × left × right)', () => {
  for (const op of BINARY_OPS) {
    for (const a of ALL_TYPES) {
      const id = RULE_OF[op];
      const body = () => {
        const problems: string[] = [];
        for (const b of ALL_TYPES) {
          const c = binaryCase(op, a, b);
          for (const p of matchDiagnostics(c.text, typeDiags(c.text), c.expected)) problems.push(`${c.text}: ${p}`);
        }
        assert.deepEqual(problems, []);
      };
      // A row in which nothing may be reported passes today; register it as a live guard, not a todo.
      const anyExpected = ALL_TYPES.some(b => binaryCase(op, a, b).expected.length > 0);
      if (!anyExpected) guard(id, `'${op}' with left ${a}: never reported`, body);
      else rule(id, `'${op}' with left ${a}`, body);
    }
  }
});

describe('operator matrix: result types', () => {
  for (const op of BINARY_OPS) {
    for (const a of ALL_TYPES) {
      if (ALL_TYPES.every(b => isErr(binary(op, a, b)))) continue;   // nothing to type in this row
      rule(RULE_OF[op], `'${op}' with left ${a}: result types`, () => {
        const problems: string[] = [];
        for (const b of ALL_TYPES) {
          const r = binary(op, a, b);
          if (isErr(r)) continue;
          const { expr } = binaryCase(op, a, b);
          const got = typeOfExpr(expr);
          if (got !== canonType(r.ok)) problems.push(`${expr}: ${got} != ${r.ok}`);
        }
        assert.deepEqual(problems, []);
      });
    }
  }
});

describe('unary matrix (every op × operand)', () => {
  const RULE: Record<UnOp, string> = { '-': 'TC-UN-01', '+': 'TC-UN-02', '!': 'TC-BOOL-02', '#': 'TC-UN-03' };
  for (const op of UNARY_OPS) {
    rule(RULE[op], `unary '${op}': diagnostics`, () => {
      const problems: string[] = [];
      for (const t of ALL_TYPES) {
        const expr = `${op}(${LITERAL[t]})`;
        const text = `echo ${expr}`;
        const r = unary(op, t);
        const code: Code = op === '!' ? CODE.boolean : CODE.operand;
        const expected: Expect[] = isErr(r) ? [{ code, at: expr, firmware: r.err, mentions: [MENTION[t]] }] : [];
        for (const p of matchDiagnostics(text, typeDiags(text), expected)) problems.push(`${text}: ${p}`);
      }
      assert.deepEqual(problems, []);
    });
    rule(RULE[op], `unary '${op}': result types`, () => {
      const problems: string[] = [];
      for (const t of ALL_TYPES) {
        const r = unary(op, t);
        if (isErr(r)) continue;
        const expr = `${op}(${LITERAL[t]})`;
        const got = typeOfExpr(expr);
        if (got !== canonType(r.ok)) problems.push(`${expr}: ${got} != ${r.ok}`);
      }
      assert.deepEqual(problems, []);
    });
  }
});

describe('TC-ARITH: arithmetic specifics', () => {
  rule('TC-ARITH-01', 'the classic mistakes', () => {
    expectTypes('echo "5" + 1', [{ code: CODE.operand, at: '"5" + 1', firmware: MSG.numericOperands }]);
    expectTypes('echo true + 1', [{ code: CODE.operand, at: 'true + 1', firmware: MSG.numericOperands }]);
    expectTypes('echo null * 2', [{ code: CODE.operand, at: 'null * 2', firmware: MSG.numericOperands }]);
    expectTypes("echo 'a' - 1", [{ code: CODE.operand, at: "'a' - 1", firmware: MSG.numericOperands }]);
    expectTypes('echo 2.5 * "x"', [{ code: CODE.operand, at: '2.5 * "x"', firmware: MSG.numericOperand }]);
  });
  guard('TC-ARITH-01', 'numeric mixes are fine', () => {
    for (const e of ['1 + 2', '1 + 2.5', '2.5 - 1', '3 * 4', '1e3 * 2', '0xFF + 0b1', '-1 + -2', '1 - -1'])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-ARITH-02', 'uint arithmetic is float', () => {
    expectType(typeOfExpr('3000000000 + 1'), 'float', 'uint + int');
    expectType(typeOfExpr('3000000000 * 3000000000'), 'float', 'uint * uint');
    expectType(typeOfExpr('2147483648 - 1'), 'float', 'uint - int');
  });
  rule('TC-ARITH-03', 'division is always float, never a zero check', () => {
    expectType(typeOfExpr('10 / 2'), 'float', '10 / 2');
    expectType(typeOfExpr('1 / 0'), 'float', '1 / 0');
    expectTypes('echo "a" / 2', [{ code: CODE.operand, at: '"a" / 2', firmware: MSG.numericOperand }]);
  });
  guard('TC-ARITH-03', 'division by zero is a value, not a type error', () => expectNoTypes('echo 1 / 0\necho 1.5 / 0'));
  rule('TC-ARITH-04', 'datetime arithmetic', () => {
    expectType(typeOfExpr('datetime(0) + 60'), 'datetime', 'dt + int');
    expectType(typeOfExpr('datetime(0) + 3000000000'), 'datetime', 'dt + uint');
    expectType(typeOfExpr('datetime(100) - 60'), 'datetime', 'dt - int');
    expectType(typeOfExpr('datetime(100) - datetime(40)'), 'int', 'dt - dt');
    expectTypes('echo datetime(0) + 1.5', [{ code: CODE.operand, at: 'datetime(0) + 1.5', firmware: MSG.invalidOperandTypes }]);
    expectTypes('echo datetime(0) + datetime(0)', [{ code: CODE.operand, at: 'datetime(0) + datetime(0)', firmware: MSG.invalidOperandTypes }]);
    expectTypes('echo 5 + datetime(0)', [{ code: CODE.operand, at: '5 + datetime(0)', firmware: MSG.numericOperands }]);
    expectTypes('echo datetime(0) * 2', [{ code: CODE.operand, at: 'datetime(0) * 2', firmware: MSG.numericOperands }]);
  });
  rule('TC-ARITH-05', 'string + string suggests ^', () => {
    expectTypes('echo "a" + "b"', [{ code: CODE.operand, at: '"a" + "b"', firmware: MSG.numericOperands, mentions: [/'\^'|\^/] }]);
  });
});

describe('TC-CAT-01: concatenation', () => {
  guard('TC-CAT-01', '^ accepts everything', () => {
    for (const e of ['"x" ^ {1, 2}', '"x" ^ null', 'move.axes[0] ^ ""', 'true ^ false', "'c' ^ 1.5", '1 ^ 2', 'datetime(0) ^ ""'])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-CAT-01', '^ yields string', () => {
    expectType(typeOfExpr('1 ^ 2'), 'string', '1 ^ 2');
    expectType(typeOfExpr('null ^ null'), 'string', 'null ^ null');
  });
});

describe('TC-BOOL: logic', () => {
  rule('TC-BOOL-01', 'one diagnostic per non-Boolean operand', () => {
    expectTypes('echo true && 1', [{ code: CODE.boolean, at: '1', firmware: MSG.boolean }]);
    expectTypes('echo 1 && 2', [{ code: CODE.boolean, at: '1' }, { code: CODE.boolean, at: '2' }]);
    expectTypes('echo 1 & true', [{ code: CODE.boolean, at: '1' }]);
    expectTypes('echo false | "a"', [{ code: CODE.boolean, at: '"a"' }]);
    expectTypes('echo false || null', [{ code: CODE.boolean, at: 'null' }]);
  });
  rule('TC-BOOL-01', 'no truthiness for variables either', () => {
    expectTypes(src('var n = 5', `if var.n && ${H}`, '  echo 1'), [{ code: CODE.boolean, at: 'var.n', line: 1 }]);
    expectTypes(src('var s = "x"', `if ${H} || var.s`, '  echo 1'), [{ code: CODE.boolean, at: 'var.s', line: 1 }]);
  });
  rule('TC-BOOL-01', 'result is bool', () => expectType(typeOfExpr(`${H} && ${H}`), 'bool', '&&'));
  rule('TC-BOOL-02', "'!' needs a Boolean and binds tighter than ==", () => {
    expectTypes('echo !1', [{ code: CODE.boolean, at: '!1', firmware: MSG.boolean }]);
    expectTypes('echo !1 == 2', [{ code: CODE.boolean, at: '!1' }]);
    expectTypes('echo !null', [{ code: CODE.boolean, at: '!null' }]);
  });
  guard('TC-BOOL-02', 'well-formed negations', () => {
    for (const e of ['!(1 == 2)', '!!true', `!${H}`, '!(1 < 2) && true']) expectNoTypes(`echo ${e}`);
  });
});

describe('TC-CMP: ordering comparisons', () => {
  rule('TC-CMP-01', 'messages follow BalanceTypes step by step', () => {
    expectTypes('echo "a" < "b"', [{ code: CODE.operand, at: '"a" < "b"', firmware: MSG.comparison }]);
    expectTypes('echo 1 < "a"', [{ code: CODE.operand, at: '1 < "a"', firmware: MSG.cannotConvert }]);
    expectTypes('echo 1.5 < "a"', [{ code: CODE.operand, at: '1.5 < "a"', firmware: MSG.numericOperand }]);
    expectTypes('echo 3000000000 > "a"', [{ code: CODE.operand, at: '3000000000 > "a"', firmware: MSG.numericOperand }]);
    expectTypes('echo null < 1', [{ code: CODE.operand, at: 'null < 1', firmware: MSG.cannotConvert }]);
  });
  guard('TC-CMP-01', 'legal comparisons', () => {
    for (const e of ['1 < 2', '1 < 2.5', '3000000000 > 1', 'true > false', 'datetime(1) > datetime(0)', '1.5 >= 1', 'iterations < 3'.replace('iterations', '0')])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-CMP-02', 'chained comparisons evaluate left to right', () => {
    expectTypes('echo 1 < 2 < 3', [{ code: CODE.operand, at: '1 < 2 < 3', firmware: MSG.cannotConvert, mentions: ['bool', 'int'] }]);
    expectTypes('echo 1 == 1 == 1', [{ code: CODE.operand, at: '1 == 1 == 1', firmware: MSG.cannotConvert }]);
  });
  guard('TC-CMP-02', 'a chain that compares bool with bool is fine', () => expectNoTypes('echo 1 < 2 == true\necho (1 < 2) == (3 > 2)'));
});

describe('TC-EQ: equality', () => {
  guard('TC-EQ-01', 'null compares with everything', () => {
    for (const e of ['null == null', 'null == move.axes[0]', 'vector(2, 0) == null', '"a" != null', "null == 'c'", 'datetime(0) == null', '1 != null'])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-EQ-02', 'the classic mistakes', () => {
    expectTypes('echo "5" == 5', [{ code: CODE.operand, at: '"5" == 5', firmware: MSG.cannotConvert, mentions: ['string', 'int'] }]);
    expectTypes('echo 1 == true', [{ code: CODE.operand, at: '1 == true', firmware: MSG.cannotConvert }]);
    expectTypes('echo state.status == 1', [{ code: CODE.operand, at: 'state.status == 1', firmware: MSG.cannotConvert }]);
  });
  rule('TC-EQ-02', 'types the firmware cannot compare at all', () => {
    expectTypes("echo 'a' == 'a'", [{ code: CODE.operand, at: "'a' == 'a'", firmware: MSG.equality, mentions: ['char'] }]);
    expectTypes('echo {1, 2} == {1, 2}', [{ code: CODE.operand, at: '{1, 2} == {1, 2}', firmware: MSG.equality, mentions: ['array'] }]);
  });
  guard('TC-EQ-02', 'legal equalities', () => {
    for (const e of ["'a' == \"a\"", '1 == 1.0', '3000000000 == 3000000000', 'datetime(0) == "1970-01-01T00:00:00"', '"a" != "b"', 'true == false', 'state.status == "idle"'])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-EQ-03', 'object-model objects', () => {
    expectTypes('echo move.axes[0] == move.axes[1]', [{ code: CODE.operand, at: 'move.axes[0] == move.axes[1]', firmware: MSG.compareObjects }]);
    expectTypes('echo move.axes[0] == 1', [{ code: CODE.operand, at: 'move.axes[0] == 1', firmware: MSG.cannotConvert, mentions: ['object', 'int'] }]);
  });
  guard('TC-EQ-03', 'object == null is legal', () => expectNoTypes('echo move.axes[0] == null\necho heat.heaters[1] != null'));
});

describe('TC-UN: unary specifics', () => {
  rule('TC-UN-01', 'unary minus', () => {
    expectTypes('echo -"a"', [{ code: CODE.operand, at: '-"a"', firmware: MSG.unaryMinus }]);
    expectTypes('echo -true', [{ code: CODE.operand, at: '-true', firmware: MSG.unaryMinus }]);
    expectTypes('echo -(3000000000)', [{ code: CODE.operand, at: '-(3000000000)', firmware: MSG.unaryMinus, mentions: [MENTION.uint] }]);
  });
  rule('TC-UN-02', 'unary plus converts uint and datetime to int', () => {
    expectType(typeOfExpr('+3000000000'), 'int', '+uint');
    expectType(typeOfExpr('+datetime(0)'), 'int', '+datetime');
    expectTypes('echo +"1"', [{ code: CODE.operand, at: '+"1"', firmware: MSG.unaryPlus }]);
  });
  rule('TC-UN-03', 'length of strings and arrays', () => {
    expectType(typeOfExpr('#"abc"'), 'int', '#string');
    expectType(typeOfExpr('#move.axes'), 'int', '#OM array');
    expectType(typeOfExpr('#(vector(3, 0))'), 'int', '#(array)');
    expectTypes(src('var n = 5', 'echo #var.n'), [{ code: CODE.operand, at: '#var.n', line: 1, firmware: MSG.length }]);
    expectTypes('echo #(true)', [{ code: CODE.operand, at: '#(true)', firmware: MSG.length }]);
  });
  rule('TC-UN-04', 'INT32_MIN and beyond cannot be written as negative literals', () => {
    expectTypes('echo -2147483648', [{ code: CODE.operand, at: '-2147483648', firmware: MSG.unaryMinus }]);
    expectTypes('echo -3000000000', [{ code: CODE.operand, at: '-3000000000', firmware: MSG.unaryMinus }]);
  });
  guard('TC-UN-04', 'the largest negative int that can be written', () => expectNoTypes('echo -2147483647\necho -2147483647 - 1\necho -4294967296'));
  rule('TC-UN-05', '# before a named constant is ignored by the firmware', () => {
    expectType(typeOfExpr('#true'), 'bool', '#true');
    expectType(typeOfExpr('#pi'), 'float', '#pi');
  });
  rule('TC-UN-05', '# before a function call is ignored (blocked: the syntax layer rejects #fn(…))', () => {
    expectType(typeOfExpr('#vector(3, 0)'), 'array<int>', '#vector(...)');
    expectType(typeOfExpr('#abs(-5)'), 'int', '#abs(...)');
  });
  rule('TC-UN-06', 'SHOULD: warn that # has no effect before a constant', () => {
    expectTypes('echo #true', [{ code: CODE.operand, at: '#', severity: 'warning' }]);
  });
  rule('TC-UN-06', 'SHOULD: … and before a call, where the real type still drives errors (blocked: syntax layer)', () => {
    expectTypes('echo #vector(3, 0) + 1', [
      { code: CODE.operand, at: '#', severity: 'warning', mentions: [/#\(/] },
      { code: CODE.operand, at: '#vector(3, 0) + 1', firmware: MSG.numericOperands, mentions: ['array'] },
    ]);
  });
  guard('TC-UN-06', 'no warning when parenthesised or applied to variables and strings', () => {
    for (const t of ['echo #(vector(3, 0))', 'echo #"abc"', 'var a = {1, 2}\necho #var.a', 'echo #move.axes', 'echo #{1, 2}'])
      expectNoTypes(t);
  });
});

describe('TC-TERN: conditional operator', () => {
  rule('TC-TERN-01', 'condition must be Boolean', () => {
    expectTypes('echo 1 ? 2 : 3', [{ code: CODE.boolean, at: '1', firmware: MSG.boolean }]);
    expectTypes('echo "x" ? 2 : 3', [{ code: CODE.boolean, at: '"x"' }]);
    expectTypes(src('var n = 0', 'echo var.n ? 1 : 2'), [{ code: CODE.boolean, at: 'var.n', line: 1 }]);
  });
  rule('TC-TERN-02', 'result is the union of the branches', () => {
    expectType(typeOfExpr(`${H} ? 1 : "a"`), 'int | string', 'mixed');
    expectType(typeOfExpr(`${H} ? 1 : 2.5`), 'int | float', 'numeric');
    expectType(typeOfExpr(`${H} ? null : {1,}`), 'null | array<int>', 'null');
  });
  rule('TC-TERN-02', 'a literal condition selects the branch', () => {
    expectType(typeOfExpr('true ? 1 : "a"'), 'int', 'true');
    expectType(typeOfExpr('false ? 1 : "a"'), 'string', 'false');
  });
  rule('TC-TERN-02', 'right-associative', () => {
    expectType(typeOfExpr(`${H} ? 1 : ${H} ? "a" : 2.5`), 'int | string | float', 'chain');
  });
});

describe('TC-PREC-01: precedence decides which sub-expression is reported', () => {
  guard('TC-PREC-01', 'legal because of precedence', () => {
    for (const e of ['"a" ^ 1 + 2', '1 + 2 ^ "a"', '"a" ^ 1 * 2', 'true && 1 < 2', '#"ab" + 1', '-1 + 2', `${H} ? 1 + 2 : 3 * 4`])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-PREC-01', 'reported on the tighter-binding sub-expression', () => {
    expectTypes('echo "a" + 1 ^ "b"', [{ code: CODE.operand, at: '"a" + 1' }]);
    expectTypes('echo "x" ^ "a" * 2', [{ code: CODE.operand, at: '"a" * 2' }]);
    expectTypes('echo 1 + 2 * "a"', [{ code: CODE.operand, at: '2 * "a"' }]);
    expectTypes('echo true && 1 + "a" > 0', [{ code: CODE.operand, at: '1 + "a"' }]);
  });
});
