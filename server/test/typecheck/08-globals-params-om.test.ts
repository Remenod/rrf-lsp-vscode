// SPEC §11: globals (workspace-wide), macro parameters, object-model values.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rule, guard, CODE, typeAt, expectType, expectTypes, expectNoTypes, typeOfExpr, lintTc } from './contract';
import { MSG } from './model';
import { src } from '../helpers/harness';
import { WORKSPACE } from '../helpers/workspace';

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

describe('TC-GLB-02: persistence writes (globals saved to a file that runs again later)', () => {
  const decl = { 'untitled:globals.g': 'global g = 0.0', 'untitled:seed.g': 'set global.g = 0.0' };
  rule('TC-GLB-02', '"set global.X = " ^ E contributes T(E)', () => {
    const docs = { ...decl, 'untitled:adjust.g': src('var v = 2', 'echo >"0:/sys/saved/G.g" "set global.g = " ^ var.v') };
    expectType(tg(docs), 'int | float', 'int written by echo');
  });
  rule('TC-GLB-02', 'the ^{…} spelling is recognised too', () => {
    const docs = { ...decl, 'untitled:adjust.g': 'echo >"0:/sys/saved/G.g" "set global.g = "^{true}' };
    expectType(tg(docs), 'float | bool', 'braced');
  });
  rule('TC-GLB-02', 'a string E is written unquoted and contributes unknown', () => {
    const docs = { ...decl, 'untitled:adjust.g': src('var v = "x"', 'echo >"0:/sys/saved/G.g" "set global.g = " ^ var.v') };
    expectType(tg(docs), 'unknown', 'string written unquoted');
  });
  rule('TC-GLB-02', 'a literal write contributes the literal type, doubled quotes included', () => {
    expectType(tg({ ...decl, 'untitled:reset.g': 'echo >"0:/sys/saved/G.g" "set global.g = 0"' }), 'int | float', 'literal 0');
    expectType(tg({ 'untitled:globals.g': 'global g = "auto"', 'untitled:m.g': 'echo >"0:/sys/saved/G.g" "set global.g = ""manual"""' }), 'string', 'quoted literal');
  });
  rule('TC-GLB-02', 'any other write that assigns the global makes it unknown', () => {
    const gen = src('echo >"0:/sys/generated/Reset.g" "var n = 5"', 'echo >>"0:/sys/generated/Reset.g" " set global.g = var.n"');
    expectType(tg({ ...decl, 'untitled:gen.g': gen }), 'unknown', 'generated code');
  });
  rule('TC-GLB-02', 'writes with a computed global name are ignored', () => {
    const mig = 'echo >{"0:/sys/saved/X.g"} "set global." ^ "g" ^ " = " ^ "zzz"';
    expectType(tg({ ...decl, 'untitled:migrate.g': mig }), 'float', 'computed name');
  });
  rule('TC-GLB-02', 'write shapes: leading blanks, comments, the quoted wrapper', () => {
    const w = (expr: string, ...pre: string[]) => tg({ ...decl, 'untitled:w.g': src(...pre, `echo >"0:/sys/saved/G.g" ${expr}`) });
    expectType(w('"  set global.g = " ^ var.v', 'var v = true'), 'float | bool', 'leading blanks');
    expectType(w('"set global.g = " ^ var.v ^ "; every " ^ var.v ^ " layers"', 'var v = 2'), 'int | float', 'comment piece after the value');
    expectType(w('"set global.g = 0 ; disabled"'), 'int | float', 'comment inside a literal write');
    expectType(w('"set global.g = "^{global.g}^" ; note"'), 'float', 'backup idiom with a comment');
    expectType(w('"set global.g = """^{var.m}^""""', 'var m = 5'), 'float | string', 'quoted wrapper');
  });
  rule('TC-GLB-02', 'non-literal text and extra pieces are "other" writes', () => {
    const w = (expr: string, ...pre: string[]) => tg({ ...decl, 'untitled:w.g': src(...pre, `echo >"0:/sys/saved/G.g" ${expr}`) });
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

describe('TC-GLB-04: a global that is only ever null is unknown', () => {
  const NULL_DECL = { 'untitled:globals.g': 'global g = null' };
  rule('TC-GLB-04', 'null declarations, sets and literal writes only', () => {
    expectType(typeOfExpr('null'), 'null', 'control: null itself is typed');
    expectType(tg({ 'untitled:globals.g': 'global g = 1' }), 'int', 'control: a non-null declaration is typed');
    expectType(tg(NULL_DECL), 'unknown', 'declaration only');
    expectType(tg({
      ...NULL_DECL,
      'untitled:end.g': 'set global.g = null',
      'untitled:reset.g': 'echo >"0:/sys/saved/G.g" "set global.g = null"',
    }), 'unknown', 'declaration, set and literal write');
  });
  rule('TC-GLB-04', 'the backup idiom and computed-name writes add no visible value', () => {
    expectType(typeOfExpr('null'), 'null', 'control: null itself is typed');
    const backup = 'echo >"0:/sys/saved/G.g" "set global.g = "^{global.g}';
    expectType(tg({ 'untitled:globals.g': 'global g = 1', 'untitled:backup.g': backup }), 'int', 'control: backup of a non-null global');
    expectType(tg({ ...NULL_DECL, 'untitled:backup.g': backup }), 'unknown', 'backup idiom');
    const computed = src('var n = "g"', 'var d = 2.5', 'echo >"0:/sys/saved/G.g" "set global."^{var.n}^" = "^{var.d}');
    expectType(tg({ ...NULL_DECL, 'untitled:computed.g': computed }), 'unknown', 'computed name');
  });
  rule('TC-GLB-04', 'any non-null visible value keeps the union', () => {
    expectType(tg({ ...NULL_DECL, 'untitled:a.g': 'set global.g = 5' }), 'null | int', 'set');
    const adjust = src('var v = 2.5', 'echo >"0:/sys/saved/G.g" "set global.g = " ^ var.v');
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

describe('TC-GLB: the globals of a whole workspace', () => {
  const at = (name: string) => typeAt(`echo global.${name}`, 0, `global.${name}`, 0, { extraDocs: WORKSPACE });
  rule('TC-GLB-04', 'a global declared null and given a number only by a computed-name write is unknown', () => {
    expectType(at('fanBoost'), 'unknown', 'fanBoost');
  });
  rule('TC-GLB-02', 'a nullable flag keeps its union: declared true, set to null, false and true', () => {
    expectType(at('enclosureHot'), 'bool | null', 'enclosureHot');
  });
  rule('TC-GLB-02', 'a string persisted through the quoted wrapper stays a string', () => {
    expectType(at('bedMode'), 'string', 'bedMode');
  });
  rule('TC-GLB-01', 'a counter changed by ±1 and persisted with the backup idiom stays int', () => {
    expectType(at('servoAngle'), 'int', 'servoAngle');
  });
  rule('TC-GLB-03', 'a global that a parameter flows into is unknown', () => {
    expectType(at('probeOffsetZ'), 'unknown', 'probeOffsetZ');
  });
  rule('TC-GLB-02', 'a persistence write with extra pieces after the value makes the global unknown', () => {
    expectType(at('lastToolTemps'), 'unknown', 'lastToolTemps');
  });
  rule('TC-GLB-01', 'a global only declared and read keeps its declared type', () => {
    expectType(at('purgeLength'), 'int', 'purgeLength');
    expectType(at('nozzleWipeCount'), 'int', 'nozzleWipeCount');
  });
});

describe('TC-PRM-01: macro parameters', () => {
  rule('TC-PRM-01', 'param.X is unknown, exists(param.X) is bool', () => {
    expectType(typeOfExpr('param.S'), 'unknown', 'param');
    expectType(typeOfExpr('exists(param.S)'), 'bool', 'exists(param)');
  });
  guard('TC-PRM-01', 'a param works wherever some type would', () => {
    for (const e of ['param.A + 1', 'param.A && true', '-param.A', 'abs(param.A)', 'vector(param.N, 0)', '#param.A', 'param.A == 1', 'param.A[0]'])
      expectNoTypes(`echo ${e}`);
    expectNoTypes('if param.A\n  echo 1');
  });
});

describe('TC-OM: object-model values', () => {
  rule('TC-OM-01', 'leaf types from the model', () => {
    const rows: Array<[string, string]> = [
      ['move.axes[0].homed', 'bool'],
      ['move.axes[0].letter', 'char'],              // GetAxisLetters()[i]: one character
      ['move.axes[0].max', 'float'],
      ['move.axes[1].min', 'float'],           // a field named like a function
      ['heat.heaters[0].current', 'float'],
      ['state.status', 'string'],
      ['state.currentTool', 'int'],
      ['state.upTime', 'int'],
      ['job.file.size', 'uint'],
      ['move.currentMove', 'object'],
      ['move.axes', 'array<object>'],
      ['tools[0].offsets', 'array<float>'],
      ['state.time', 'datetime'],
      ['network.interfaces[0].actualIP', 'unknown'],   // an IP address: not a type the checker knows
    ];
    for (const [p, t] of rows) expectType(typeOfExpr(p), t, p);
  });
  rule('TC-OM-01', 'definite errors on typed leaves', () => {
    expectTypes('echo move.axes[0].homed + 1', [{ code: CODE.operand, at: 'move.axes[0].homed + 1', firmware: MSG.numericOperands }]);
    expectTypes('echo move.axes[0].letter * 2', [{ code: CODE.operand, at: 'move.axes[0].letter * 2' }]);
    expectTypes('echo heat.heaters[0].current + "C"', [{ code: CODE.operand, at: 'heat.heaters[0].current + "C"', firmware: /"expected numeric operands?"/ }]);
    expectTypes('if state.status\n  echo 1', [{ code: CODE.boolean, at: 'state.status' }]);
  });
  guard('TC-OM-01', 'common uses of typed numbers are fine', () => {
    for (const e of ['-heat.heaters[0].current', 'abs(move.axes[0].max)', 'vector(state.currentTool, 0)', 'random(state.upTime)',
      'move.axes[state.currentTool]', 'move.axes[0].max + 1', 'move.axes[1].min < 5', 'state.currentTool == -1'])
      expectNoTypes(`echo ${e}`);
  });
  guard('TC-OM-02', 'paths outside the model are unknown', () => {
    for (const e of ['state.noSuchField - 1', 'state.noSuchField && true', 'boards[0].noSuchField * 2'])
      expectNoTypes(`echo ${e}`);
  });
  rule('TC-OM-02', 'and hover says so', () => expectType(typeOfExpr('state.noSuchField'), 'unknown', 'not in the model'));
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
    expectType(typeOfExpr('#state.upTime'), 'int', '#int leaf');
    expectType(typeOfExpr('#move.axes[0].max'), 'float', '#float leaf');
    expectType(typeOfExpr('#state.status'), 'int', '#string leaf');
  });
  guard('TC-OM-05', '# directly before an object-model leaf is never an error', () => {
    expectNoTypes('echo #move.axes[0].homed\necho #state.upTime\necho #move.currentMove');
  });
  rule('TC-OM-05', 'with parentheses it is an ordinary length operator', () => {
    expectTypes('echo #(move.axes[0].homed)', [{ code: CODE.operand, at: '#(move.axes[0].homed)', firmware: MSG.length }]);
  });
});

describe('TC-OM-06..08: bitmaps, firmware lines, SBC fields', () => {
  const unknownPaths = (t: string, opts: { rrfVersion?: string; sbc?: boolean } = {}) =>
    lintTc(t, opts).filter(d => /is not a known Object Model path/.test(d.message)).length;
  rule('TC-OM-06', 'a bitmap is an int bit mask; an element is the number of a set bit', () => {
    expectType(typeOfExpr('fans[0].thermostatic.sensors'), 'int', 'bare');
    expectType(typeOfExpr('fans[0].thermostatic.sensors[0]'), 'int', 'element');
    expectType(typeOfExpr('#fans[0].thermostatic.sensors'), 'int', 'count');
    expectNoTypes('echo fans[0].thermostatic.sensors + 1');
  });
  rule('TC-OM-01', 'an index taken from a float field is an error', () => {
    expectTypes('echo move.axes[move.axes[0].max]', [{ code: CODE.index, at: 'move.axes[0].max', firmware: MSG.integerExpr }]);
  });
  rule('TC-OM-07', 'paths follow the target firmware line; with none, any line', () => {
    assert.equal(unknownPaths('echo move.shaping.durations', { rrfVersion: '3.5' }), 0);
    assert.equal(unknownPaths('echo move.shaping.durations', { rrfVersion: '3.6' }), 1);
    assert.equal(unknownPaths('echo move.shaping.delays', { rrfVersion: '3.5' }), 1);
    assert.equal(unknownPaths('echo move.shaping.delays'), 0);
    assert.equal(unknownPaths('echo move.shaping.durations'), 0);
  });
  rule('TC-OM-07', 'names are spelled as the firmware spells them', () => {
    assert.equal(unknownPaths('echo job.build.m486Names'), 0);
    assert.equal(unknownPaths('echo job.build.m486names'), 1);
    assert.equal(unknownPaths('echo seqs.volChanges'), 0);
  });
  rule('TC-OM-08', 'fields of a single-board computer exist only with rrfgcode.sbc', () => {
    assert.equal(unknownPaths('echo sbc.cpu.avgLoad'), 1);
    assert.equal(unknownPaths('echo sbc.cpu.avgLoad', { sbc: true }), 0);
    assert.equal(unknownPaths('echo job.layers', { sbc: true }), 0);
    assert.equal(unknownPaths('echo job.layers'), 1);
    // Typed only with an SBC: an int|null core count is not a condition.
    expectTypes('if sbc.cpu.numCores\n  echo 1', [{ code: CODE.boolean, at: 'sbc.cpu.numCores' }], { sbc: true });
    expectNoTypes('if sbc.cpu.numCores\n  echo 1');
  });
});
