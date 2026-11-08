// TYPE-CHECK SPECIFICATION (not implemented yet — every test here is `todo`).
//
// Each test generates source from the reference model (model.ts, itself transcribed from the
// firmware) and asserts the language server reports an error exactly when the firmware would throw.
// `todo` tests run and report but never fail the suite; delete the flag once a rule is implemented.
//
// Rules of the game for the implementation:
//   * FALSE POSITIVES ARE WORSE THAN MISSES. The spec's `clean` direction must pass first: these
//     macros run on hardware, so a type error reported on valid code is a bug.
//   * Unknown types (object model values, params, results of unknown calls) must never be reported.
//   * The target firmware version must be a parameter (see versions.test.ts).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lint, errorsOf, msgs } from '../helpers/harness';
import {
  ALL_TYPES, BINARY_OPS, UNARY_OPS, LITERAL, Ty, binary, unary, conditionOk, FORK_FUNCTIONS, isNumeric,
} from './model';

const TODO = { todo: 'type check not implemented' };
const typeErrors = (text: string) => errorsOf(lint(text, { rrfVersion: '3.5.4' }));

/** Collect every disagreement between the model and the server, report them all at once. */
function crossCheck(cases: Array<{ src: string; wantError: boolean }>): void {
  const bad = cases.filter(c => (typeErrors(c.src).length > 0) !== c.wantError)
    .map(c => `${c.wantError ? 'MISSED ' : 'FALSE POSITIVE '}${c.src}`);
  assert.deepEqual(bad, [], `${bad.length} of ${cases.length} cases disagree with the firmware model`);
}

describe('type check: binary operators x operand types', () => {
  for (const op of BINARY_OPS) {
    it(`'${op}' over all ${ALL_TYPES.length}x${ALL_TYPES.length} literal operand pairs`, TODO, () => {
      const cases = [];
      for (const a of ALL_TYPES) for (const b of ALL_TYPES) {
        // Short-circuit operators skip the right operand when the left decides the result; make the
        // left side always force evaluation of the right.
        const left = op === '&&' ? (a === 'bool' ? 'true' : LITERAL[a]) : op === '||' ? (a === 'bool' ? 'false' : LITERAL[a]) : LITERAL[a];
        cases.push({ src: `echo ${left} ${op} ${LITERAL[b]}`, wantError: 'err' in binary(op, a, b) });
      }
      crossCheck(cases);
    });
  }
});

describe('type check: unary operators x operand type', () => {
  for (const op of UNARY_OPS) {
    it(`unary '${op}'`, TODO, () => {
      const cases = ALL_TYPES.map(t => {
        const operand = op === '#' || op === '-' || op === '+' || op === '!' ? `(${LITERAL[t]})` : LITERAL[t];
        return { src: `echo ${op}${operand}`, wantError: 'err' in unary(op, t) };
      });
      crossCheck(cases);
    });
  }
});

describe('type check: conditions (if / elif / while) must be Boolean', () => {
  for (const kw of ['if', 'elif', 'while']) {
    it(`${kw} <each type>`, TODO, () => {
      const cases = ALL_TYPES.map(t => ({
        src: kw === 'elif' ? `if true\n  echo 1\nelif ${LITERAL[t]}\n  echo 2` : `${kw} ${LITERAL[t]}\n  echo 1`,
        wantError: !conditionOk(t),
      }));
      crossCheck(cases);
    });
  }
  it('ternary condition must be Boolean', TODO, () => {
    crossCheck(ALL_TYPES.map(t => ({ src: `echo ${LITERAL[t]} ? 1 : 2`, wantError: t !== 'bool' })));
  });
  it('a comparison result is accepted as a condition', TODO, () => {
    assert.deepEqual(msgs(typeErrors('if 1 < 2\n  echo 1')), []);
    assert.deepEqual(msgs(typeErrors('if "a" == "b"\n  echo 1')), []);
  });
});

describe('type check: functions x argument types', () => {
  for (const [fn, spec] of Object.entries(FORK_FUNCTIONS)) {
    if (fn === 'exists' || fn === 'fileread') continue;     // path/OM semantics covered elsewhere
    it(`${fn}(): every type in every argument position`, TODO, () => {
      const cases: Array<{ src: string; wantError: boolean }> = [];
      const arity = spec.min;
      for (let pos = 0; pos < arity; pos++) {
        for (const t of ALL_TYPES) {
          const okFor = (i: number): string => {
            const accept = spec.args[Math.min(i, spec.args.length - 1)];
            const pick = ALL_TYPES.find(x => accept(x) && x !== 'null' && x !== 'array');
            return LITERAL[pick ?? 'int'];
          };
          const args = Array.from({ length: arity }, (_, i) => (i === pos ? LITERAL[t] : okFor(i)));
          const accept = spec.args[Math.min(pos, spec.args.length - 1)];
          cases.push({ src: `echo ${fn}(${args.join(', ')})`, wantError: !accept(t) });
        }
      }
      crossCheck(cases);
    });
  }

  it('numeric-only functions accept both int and float', TODO, () => {
    for (const fn of ['abs', 'sin', 'sqrt', 'floor', 'ceil', 'isnan', 'degrees']) {
      assert.deepEqual(msgs(typeErrors(`echo ${fn}(1)`)), [], fn);
      assert.deepEqual(msgs(typeErrors(`echo ${fn}(1.5)`)), [], fn);
    }
  });
  it('min/max over an array operand is legal', TODO, () => {
    assert.deepEqual(msgs(typeErrors('echo max(vector(3, 1))')), []);
  });
  it('fileread: (string, int, int, char) only', TODO, () => {
    assert.deepEqual(msgs(typeErrors("echo fileread(\"f.csv\", 0, 10, ',')")), []);
    assert.ok(typeErrors("echo fileread(1, 0, 10, ',')").length > 0);
    assert.ok(typeErrors('echo fileread("f.csv", 0, 10, ",")').length > 0, 'delimiter must be a char, not a string');
    assert.ok(typeErrors('echo fileread("f.csv", "0", 10, \',\')').length > 0);
  });
});

describe('type check: static facts the firmware enforces at parse time', () => {
  const rows: Array<[string, boolean, string]> = [
    ['echo random(0)', true, 'random() needs a positive integer'],
    ['echo random(-1)', true, 'random() needs a positive integer'],
    ['echo random(1.5)', true, 'random() takes an integer'],
    ['echo random(10)', false, 'ok'],
    ['echo vector(-1, 0)', true, 'vector() size must be non-negative'],
    ['echo vector(2.5, 0)', true, 'vector() size must be an integer'],
    ['echo fileread("f", -1, 1, \',\')', true, 'offset must be non-negative'],
    ['echo 1 / 0', false, 'division by zero is a runtime value, not a type error'],
    ['echo mod(5, 0)', false, 'int mod by zero yields 0 in the firmware'],
  ];
  for (const [text, bad, why] of rows) {
    it(`${text} -> ${bad ? 'error' : 'clean'} (${why})`, TODO, () => {
      assert.equal(typeErrors(text).length > 0, bad);
    });
  }
});

describe('type check: variables carry their type', () => {
  const decl = (init: string, use: string) => `var x = ${init}\n${use}`;
  const rows: Array<[string, string, boolean, string]> = [
    ['1', 'echo var.x + 1', false, 'int + int'],
    ['1', 'echo var.x + "s"', true, 'int + string'],
    ['"s"', 'echo var.x + 1', true, 'string + int'],
    ['"s"', 'echo var.x ^ 1', false, 'concatenation'],
    ['true', 'if var.x\n  echo 1', false, 'bool condition'],
    ['1', 'if var.x\n  echo 1', true, 'int condition'],
    ['1.5', 'echo abs(var.x)', false, 'float abs'],
    ['"s"', 'echo abs(var.x)', true, 'string abs'],
    ['{1,2}', 'echo #var.x', false, 'length of array'],
    ['1', 'echo #var.x', true, 'length of int'],
    ['1 + 2.5', 'echo var.x + 1', false, 'inferred float'],
    ['"a" ^ 1', 'echo var.x * 2', true, 'concatenation yields string'],
  ];
  for (const [init, use, bad, why] of rows) {
    it(`var x = ${init}; ${use.replace(/\n/g, ' ⏎ ')} -> ${bad ? 'error' : 'clean'} (${why})`, TODO, () => {
      assert.equal(typeErrors(decl(init, use)).length > 0, bad);
    });
  }
});

describe('type check: assignment with set', () => {
  // RRF variables are dynamically typed: `set` may change the type. These are NOT errors;
  // the spec pins that the checker must not invent a static-typing rule.
  const clean = [
    'var x = 1\nset var.x = "now a string"',
    'var x = 1\nset var.x = 1.5',
    'var x = true\nset var.x = 0',
    'var x = {1,2}\nset var.x = 3',
  ];
  clean.forEach(text => it(`type may change: ${JSON.stringify(text)}`, () => {
    assert.deepEqual(msgs(typeErrors(text)), []);
  }));

  it('after a type-changing set the checker must use the NEW type (or give up)', TODO, () => {
    assert.deepEqual(msgs(typeErrors('var x = 1\nset var.x = "s"\necho var.x ^ "t"')), []);
    assert.ok(typeErrors('var x = 1\nset var.x = "s"\necho var.x * 2').length > 0);
  });

  it('indexed assignment needs an array', TODO, () => {
    assert.ok(typeErrors('var x = 1\nset var.x[0] = 2').length > 0);
    assert.deepEqual(msgs(typeErrors('var x = {1,2}\nset var.x[0] = 2')), []);
  });
  it('array index must be an integer', TODO, () => {
    assert.ok(typeErrors('var x = {1,2}\necho var.x["a"]').length > 0);
    assert.ok(typeErrors('var x = {1,2}\necho var.x[1.5]').length > 0);
    assert.deepEqual(msgs(typeErrors('var x = {1,2}\necho var.x[1]')), []);
  });
});

describe('type check: object model values', () => {
  const rows: Array<[string, boolean, string]> = [
    ['echo move.axes[0].homed && true', false, 'bool && bool'],
    ['echo move.axes[0].homed + 1', true, 'bool + int'],
    ['echo move.axes[0].letter + 1', true, 'string + int'],
    ['echo move.axes[0].max + 1', false, 'float + int'],
    ['echo heat.heaters[0].current * 2', false, 'float * int'],
    ['echo #move.axes', false, 'length of OM array'],
    ['echo #move.axes[0].homed', true, 'length of bool'],
    ['if move.axes[0].homed\n  echo 1', false, 'bool condition'],
    ['if move.axes[0].max\n  echo 1', true, 'float condition'],
    ['if state.status == "idle"\n  echo 1', false, 'string compare'],
    ['if state.status == 1\n  echo 1', true, 'string == int'],
    ['if state.currentTool == -1\n  echo 1', false, 'int compare'],
    ['if heat.heaters[0] == 1\n  echo 1', true, 'cannot compare objects'],
  ];
  for (const [text, bad, why] of rows) {
    it(`${text.replace(/\n/g, ' ⏎ ')} -> ${bad ? 'error' : 'clean'} (${why})`, TODO, () => {
      assert.equal(typeErrors(text).length > 0, bad);
    });
  }
});

describe('type check: G-code parameter values', () => {
  const rows: Array<[string, boolean, string]> = [
    ['G1 X{1+2}', false, 'numeric'],
    ['G1 X{"a"}', true, 'numeric parameter given a string'],
    ['G1 X{true}', true, 'numeric parameter given a bool'],
    ['M98 P{"a.g"}', false, 'string parameter'],
    ['M98 P{1}', true, 'path parameter given an int'],
    ['M291 S{"2"}', true, 'S is an integer'],
    ['M291 R{"t"} P{"m"} S{2}', false, 'ok'],
    ['M104 S{"hot"}', true, 'temperature must be numeric'],
  ];
  for (const [text, bad, why] of rows) {
    it(`${text} -> ${bad ? 'error' : 'clean'} (${why})`, TODO, () => {
      assert.equal(typeErrors(text).length > 0, bad);
    });
  }
});

describe('type check: must stay quiet (no false positives)', () => {
  // These are valid on hardware. They already pass, and must keep passing once checks are added.
  const quiet = [
    'echo 1 + 2.5',
    'echo "a" ^ 1',
    'echo true ^ "x"',
    'echo null ^ "x"',
    'echo 1 == 1.0',
    'echo "a" == null',
    'echo !(1 == 2)',
    'echo -1.5',
    "echo 'c' ^ \"s\"",
    'echo #"abc" + 1',
    'echo abs(-1)',
    'echo max(1, 2.5)',
    'echo sqrt(4)',
    'echo 10 / 4',
    'echo mod(7, 2)',
    'echo pow(2, 8)',
    'var x = 1\nset var.x = var.x + 1',
    'if 1 == 1 && 2 == 2\n  echo 1',
    'echo move.axes[0].homed',
    'echo true ? "a" : "b"',
    'echo (1 < 2) ? 1 : 2',
    'echo datetime(0) + 5',
    'echo datetime(5) - datetime(3)',
  ];
  for (const text of quiet) {
    it(`${JSON.stringify(text)}`, () => {
      assert.deepEqual(msgs(typeErrors(text)), []);
    });
  }

  it('unknown types are never reported: params and untyped OM leaves', () => {
    for (const t of ['echo param.A + 1', 'echo param.A + "s"', 'if param.A\n  echo 1', 'echo abs(param.A)', 'echo global.undeclared * 2']) {
      assert.deepEqual(msgs(typeErrors(t)).filter(m => !/global/.test(m)), [], t);
    }
  });
  void isNumeric;
});
