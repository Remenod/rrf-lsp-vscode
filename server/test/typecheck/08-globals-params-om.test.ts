// SPEC §11: globals (workspace-wide), macro parameters, object-model values.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rule, guard, CODE, typeAt, expectType, expectTypes, expectNoTypes, typeOfExpr } from './contract';
import { MSG } from './model';
import { src } from '../helpers/harness';
import { corpusAvailable, corpusDocs } from '../helpers/corpus';

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
  rule('TC-GLB-01', 'assignments that read globals resolve as a least fixed point', () => {
    expectType(tg({ 'untitled:globals.g': 'global g = 170', 'untitled:ccw.g': 'set global.g = global.g + 1' }), 'int', 'self increment');
    expectType(tg({ 'untitled:globals.g': 'global g = 1', 'untitled:half.g': 'set global.g = global.g / 2' }), 'int | float', 'self division');
    const mutual = { 'untitled:globals.g': 'global g = 1\nglobal h = "s"', 'untitled:a.g': 'set global.g = global.h', 'untitled:b.g': 'set global.h = global.g' };
    expectType(tg(mutual), 'int | string', 'mutual');
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
  rule('TC-GLB-02', 'corpus shapes: leading blanks, comments, the quoted wrapper', () => {
    const w = (expr: string, ...pre: string[]) => tg({ ...decl, 'untitled:w.g': src(...pre, `echo >"0:/sys/user/variables/G.g" ${expr}`) });
    expectType(w('"  set global.g = " ^ var.v', 'var v = true'), 'float | bool', 'leading blanks');
    expectType(w('"set global.g = " ^ var.v ^ "; every " ^ var.v ^ " layers"', 'var v = 2'), 'int | float', 'comment piece after the value');
    expectType(w('"set global.g = 0 ; disabled"'), 'int | float', 'comment inside a literal write');
    expectType(w('"set global.g = "^{global.g}^" ; note"'), 'float', 'backup idiom with a comment');
    expectType(w('"set global.g = """^{var.m}^""""', 'var m = 5'), 'float | string', 'quoted wrapper');
  });
  rule('TC-GLB-02', 'non-literal text and extra pieces are "other" writes', () => {
    const w = (expr: string, ...pre: string[]) => tg({ ...decl, 'untitled:w.g': src(...pre, `echo >"0:/sys/user/variables/G.g" ${expr}`) });
    expectType(w('" set global.g = var.n"'), 'unknown', 'generated code');
    expectType(w('"set global.g = " ^ var.a ^ "," ^ var.b', 'var a = 1', 'var b = 2'), 'unknown', 'extra piece after the value');
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

describe('TC-GLB-04: a global that is only ever null is unknown (decision D-5)', () => {
  const NULL_DECL = { 'untitled:globals.g': 'global g = null' };
  rule('TC-GLB-04', 'null declarations, sets and literal writes only', () => {
    expectType(typeOfExpr('null'), 'null', 'control: null itself is typed');
    expectType(tg({ 'untitled:globals.g': 'global g = 1' }), 'int', 'control: a non-null declaration is typed');
    expectType(tg(NULL_DECL), 'unknown', 'declaration only');
    expectType(tg({
      ...NULL_DECL,
      'untitled:end.g': 'set global.g = null',
      'untitled:reset.g': 'echo >"0:/sys/user/variables/G.g" "set global.g = null"',
    }), 'unknown', 'declaration, set and literal write');
  });
  rule('TC-GLB-04', 'the backup idiom and computed-name writes add no visible value', () => {
    expectType(typeOfExpr('null'), 'null', 'control: null itself is typed');
    const backup = 'echo >"0:/sys/user/state/G.g" "set global.g = "^{global.g}';
    expectType(tg({ 'untitled:globals.g': 'global g = 1', 'untitled:backup.g': backup }), 'int', 'control: backup of a non-null global');
    expectType(tg({ ...NULL_DECL, 'untitled:backup.g': backup }), 'unknown', 'backup idiom');
    const tcr = src('var n = "g"', 'var d = 2.5', 'echo >"0:/sys/user/variables/G.g" "set global."^{var.n}^" = "^{var.d}');
    expectType(tg({ ...NULL_DECL, 'untitled:tcr.g': tcr }), 'unknown', 'computed name (the Tool Change Retraction shape)');
  });
  rule('TC-GLB-04', 'any non-null visible value keeps the union', () => {
    expectType(tg({ ...NULL_DECL, 'untitled:a.g': 'set global.g = 5' }), 'null | int', 'set');
    const adjust = src('var v = 2.5', 'echo >"0:/sys/user/variables/G.g" "set global.g = " ^ var.v');
    expectType(tg({ ...NULL_DECL, 'untitled:adjust.g': adjust }), 'null | float', 'persistence write');
  });
  rule('TC-GLB-04', 'local variables are not affected', () => {
    expectType(typeOfExpr('var.x', { prelude: ['var x = null'] }), 'null', 'local');
    expectTypes(src('var x = null', 'echo var.x * 2'), [{ code: CODE.operand, at: 'var.x * 2', line: 1 }]);
  });
  guard('TC-GLB-04', 'unguarded use of a null-only global is not reported', () => {
    const docs = { ...NULL_DECL, 'untitled:stop.g': 'set global.g = null' };
    expectNoTypes('G1 E{global.g * 2} F3000', { extraDocs: docs });
    expectNoTypes('if global.g > 0\n  echo 1', { extraDocs: docs });
    expectNoTypes('echo -global.g', { extraDocs: docs });
  });
});

describe('TC-GLB: real globals of the 4.2.0 corpus', { skip: corpusAvailable() ? false : 'corpus not fetched — run `npm run corpus:fetch`' }, () => {
  let docs: Record<string, string> | undefined;
  const at = (name: string) => typeAt(`echo global.${name}`, 0, `global.${name}`, 0, { extraDocs: docs ??= corpusDocs() });
  rule('TC-GLB-04', 'the four retraction distances are unknown (only null is visible)', () => {
    expectType(at('chamberWait'), 'bool | null', 'control: a nullable global keeps its type');
    for (const g of ['tool0RetractDistance', 'tool1RetractDistance', 'tool0ExtrudeDistance', 'tool1ExtrudeDistance']) {
      expectType(at(g), 'unknown', g);
    }
  });
  rule('TC-GLB-02', 'chamberWait is bool | null: declared true, written null/false/true by Wait for Chamber Temp', () => {
    expectType(at('chamberWait'), 'bool | null', 'chamberWait');
  });
  rule('TC-GLB-02', 'xCompMode is string: the quoted wrapper in Mesh Calibration/Reset', () => {
    expectType(at('xCompMode'), 'string', 'xCompMode');
  });
  rule('TC-GLB-01', 'probePickAngle is int: ±1 in the pickup-angle macros, backup write with a comment', () => {
    expectType(at('probePickAngle'), 'int', 'probePickAngle');
  });
  rule('TC-GLB-02', 'zOffset is unknown: Save Current Z - Offset writes generated code', () => {
    expectType(at('zOffset'), 'unknown', 'zOffset');
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
