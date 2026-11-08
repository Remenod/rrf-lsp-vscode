// SPEC §11: globals (workspace-wide), macro parameters, object-model values.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rule, guard, CODE, typeAt, expectType, expectTypes, expectNoTypes, typeOfExpr } from './contract';
import { MSG } from './model';
import { src } from '../helpers/harness';

const USE = 'echo global.g';
const tg = (docs: Record<string, string>, use = USE) => typeAt(use, 0, 'global.g', 0, { extraDocs: docs });

describe('TC-GLB-01: union over every declaration and assignment in the workspace', () => {
  rule('TC-GLB-01', 'declaration only', () => {
    expectType(tg({ 'untitled:globals.g': 'global g = 1' }), 'int', 'decl');
  });
  rule('TC-GLB-01', 'declaration plus sets in other files', () => {
    expectType(tg({ 'untitled:globals.g': 'global g = 1', 'untitled:a.g': 'set global.g = 2.5', 'untitled:b.g': 'set global.g = 3' }), 'int | float', 'union');
  });
  rule('TC-GLB-01', 'flow-insensitive: a set later in the same file still counts at an earlier use', () => {
    const t = src('global g = 1', 'echo global.g', 'set global.g = "s"');
    expectType(typeAt(t, 1, 'global.g'), 'int | string', 'same file');
  });
  rule('TC-GLB-01', 'conditional declaration idiom', () => {
    expectType(tg({ 'untitled:globals.g': 'if !exists(global.g)\n  global g = false' }), 'bool', 'guarded decl');
  });
  rule('TC-GLB-01', 'definite errors on globals', () => {
    expectTypes('echo global.g * 2', [{ code: CODE.operand, at: 'global.g * 2', firmware: MSG.numericOperands }],
      { extraDocs: { 'untitled:globals.g': 'global g = "text"' } });
    expectTypes('if global.g\n  echo 1', [{ code: CODE.boolean, at: 'global.g' }],
      { extraDocs: { 'untitled:globals.g': 'global g = 0' } });
  });
  guard('TC-GLB-01', 'a union with one valid member is silent', () => {
    expectNoTypes('echo global.g + 1', { extraDocs: { 'untitled:globals.g': 'global g = 1', 'untitled:a.g': 'set global.g = "s"' } });
  });
});

describe('TC-GLB-02: persistence writes (the sys/user/variables idiom)', () => {
  const decl = { 'untitled:globals.g': 'global g = 0.0', 'untitled:seed.g': 'set global.g = 0.0' };
  rule('TC-GLB-02', '"set global.X = " ^ E contributes T(E)', () => {
    const docs = { ...decl, 'untitled:adjust.g': src('var v = 2', 'echo >"0:/sys/user/variables/G.g" "set global.g = " ^ var.v') };
    expectType(tg(docs), 'int | float', 'int written by echo');
  });
  rule('TC-GLB-02', 'the ^{…} spelling is recognised too', () => {
    const docs = { ...decl, 'untitled:adjust.g': 'echo >"0:/sys/user/variables/G.g" "set global.g = "^{true}' };
    expectType(tg(docs), 'float | bool', 'braced');
  });
  rule('TC-GLB-02', 'a string E is written unquoted and contributes unknown', () => {
    const docs = { ...decl, 'untitled:adjust.g': src('var v = "x"', 'echo >"0:/sys/user/variables/G.g" "set global.g = " ^ var.v') };
    expectType(tg(docs), 'unknown', 'string written unquoted');
  });
  rule('TC-GLB-02', 'a literal write contributes the literal type, doubled quotes included', () => {
    expectType(tg({ ...decl, 'untitled:reset.g': 'echo >"0:/sys/user/variables/G.g" "set global.g = 0"' }), 'int | float', 'literal 0');
    expectType(tg({ 'untitled:globals.g': 'global g = "auto"', 'untitled:m.g': 'echo >"0:/sys/user/variables/G.g" "set global.g = ""manual"""' }), 'string', 'quoted literal');
  });
  rule('TC-GLB-02', 'any other write that assigns the global makes it unknown', () => {
    const gen = src('echo >"0:/sys/user/actions/Reset.g" "var n = 5"', 'echo >>"0:/sys/user/actions/Reset.g" " set global.g = var.n"');
    expectType(tg({ ...decl, 'untitled:gen.g': gen }), 'unknown', 'generated code');
  });
  rule('TC-GLB-02', 'writes with a computed global name are ignored (decision D-5)', () => {
    const mig = 'echo >{"0:/sys/user/variables/X.g"} "set global." ^ "g" ^ " = " ^ "zzz"';
    expectType(tg({ ...decl, 'untitled:migrate.g': mig }), 'float', 'computed name');
  });
  guard('TC-GLB-02', 'reading the global inside an echo is not a write', () => {
    expectNoTypes('echo >"0:/log.txt" "value " ^ global.g', { extraDocs: decl });
  });
});

describe('TC-GLB-03: unknown globals', () => {
  rule('TC-GLB-03', 'undeclared, or assigned from something unknown', () => {
    expectType(tg({}), 'unknown', 'undeclared');
    expectType(tg({ 'untitled:globals.g': 'global g = 1', 'untitled:a.g': 'set global.g = param.V' }), 'unknown', 'from param');
    expectType(tg({ 'untitled:globals.g': "global g = fileread(\"x.csv\", 0, 1, ',')" }), 'array<unknown>', 'fileread: an array of unknown elements');
    expectType(tg({ 'untitled:globals.g': 'global g = 1', 'untitled:a.g': 'set global.g = input' }), 'unknown', 'from input');
  });
  rule('TC-GLB-03', 'independent of the order files were indexed in', () => {
    const a = { 'untitled:1.g': 'global g = 1', 'untitled:2.g': 'set global.g = "s"' };
    const b = { 'untitled:2.g': 'set global.g = "s"', 'untitled:1.g': 'global g = 1' };
    assert.equal(tg(a), tg(b));
    expectType(tg(a), 'int | string', 'order a');
  });
});

describe('TC-PRM-01: macro parameters', () => {
  rule('TC-PRM-01', 'param.X is unknown, exists(param.X) is bool', () => {
    expectType(typeOfExpr('param.S'), 'unknown', 'param');
    expectType(typeOfExpr('exists(param.S)'), 'bool', 'exists(param)');
  });
  guard('TC-PRM-01', 'nothing involving a param is ever reported', () => {
    for (const e of ['param.A + "x"', 'param.A && true', '-param.A', 'abs(param.A)', 'vector(param.N, 0)', '#param.A', 'param.A == 1', 'param.A[0]'])
      expectNoTypes(`echo ${e}`);
    expectNoTypes('if param.A\n  echo 1');
  });
});

describe('TC-OM: object-model values', () => {
  rule('TC-OM-01', 'leaf types from the model', () => {
    const rows: Array<[string, string]> = [
      ['move.axes[0].homed', 'bool'],
      ['move.axes[0].letter', 'string'],
      ['move.axes[0].max', 'number'],
      ['move.axes[1].min', 'number'],          // a field named like a function
      ['heat.heaters[0].current', 'number'],
      ['state.status', 'string'],
      ['state.currentTool', 'number'],
      ['move.currentMove', 'object'],
      ['move.axes', 'array<object>'],
      ['state.time', 'unknown'],               // null default: no type information
      ['network.interfaces[0].actualIP', 'unknown'],
    ];
    for (const [p, t] of rows) expectType(typeOfExpr(p), t, p);
  });
  rule('TC-OM-01', 'definite errors on typed leaves', () => {
    expectTypes('echo move.axes[0].homed + 1', [{ code: CODE.operand, at: 'move.axes[0].homed + 1', firmware: MSG.numericOperands }]);
    expectTypes('echo move.axes[0].letter * 2', [{ code: CODE.operand, at: 'move.axes[0].letter * 2' }]);
    expectTypes('echo heat.heaters[0].current + "C"', [{ code: CODE.operand, at: 'heat.heaters[0].current + "C"', firmware: /"expected numeric operands?"/ }]);
    expectTypes('if state.status\n  echo 1', [{ code: CODE.boolean, at: 'state.status' }]);
  });
  guard('TC-OM-01', 'number = int | uint | float is never definite where one member works', () => {
    for (const e of ['-heat.heaters[0].current', 'abs(move.axes[0].max)', 'vector(state.currentTool, 0)', 'random(state.upTime)',
      'move.axes[state.currentTool]', 'move.axes[0].max + 1', 'move.axes[1].min < 5', 'state.currentTool == -1'])
      expectNoTypes(`echo ${e}`);
  });
  guard('TC-OM-02', 'paths outside the model are unknown (fork-only fields)', () => {
    for (const e of ['state.vmFeatureLevel + "x"', 'state.vmFeatureLevel && true', 'boards[0].vmThing * 2'])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-OM-02', 'and hover says so', () => expectType(typeOfExpr('state.vmFeatureLevel'), 'unknown', 'fork-only'));
  rule('TC-OM-03', 'objects in arithmetic', () => {
    expectTypes('echo move.axes[0] + 1', [{ code: CODE.operand, at: 'move.axes[0] + 1', firmware: MSG.numericOperands, mentions: ['object'] }]);
    expectTypes('echo -move.currentMove', [{ code: CODE.operand, at: '-move.currentMove', firmware: MSG.unaryMinus }]);
  });
  rule('TC-OM-04', '# on object-model arrays', () => {
    expectType(typeOfExpr('#move.axes'), 'int', '#move.axes');
    expectType(typeOfExpr('#tools[0].offsets'), 'int', '#tools[0].offsets');
    expectNoTypes('echo #heat.heaters - 1');
  });
  rule('TC-OM-05', '# directly before an object-model leaf returns the leaf unchanged', () => {
    expectType(typeOfExpr('#move.axes[0].homed'), 'bool', '#bool leaf');
    expectType(typeOfExpr('#state.upTime'), 'number', '#number leaf');
    expectType(typeOfExpr('#state.status'), 'int', '#string leaf');
  });
  guard('TC-OM-05', '# directly before an object-model leaf is never an error', () => {
    expectNoTypes('echo #move.axes[0].homed\necho #state.upTime\necho #move.currentMove');
  });
  rule('TC-OM-05', 'with parentheses it is an ordinary length operator', () => {
    expectTypes('echo #(move.axes[0].homed)', [{ code: CODE.operand, at: '#(move.axes[0].homed)', firmware: MSG.length }]);
  });
});
