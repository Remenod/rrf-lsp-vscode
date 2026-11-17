// Variable scope: a `var` lives until the end of the block it was declared in.
// Also: exists() guards, globals across files, param., bare object-model identifiers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expectDiag, expectSilent, expectClean } from '../helpers/cases';
import { src, lint, msgs, warningsOf, errorsOf, has } from '../helpers/harness';
import { isOmIndexAvailable } from '../../src/analysis/objectModelIndex';

describe('scope: var visibility', () => {
  expectSilent([
    src('var a = 1', 'echo var.a'),
    src('var a = 1', 'if true', '  echo var.a'),
    src('var a = 1', 'while iterations < 1', '  set var.a = var.a + 1'),
    src('if true', '  var a = 1', '  echo var.a'),
    src('if true', '  var a = 1', '  if true', '    echo var.a'),
    src('var a = 1', 'if true', '  if true', '    set var.a = 2'),
    src('var a = 1', 'var b = var.a + 1', 'echo var.b'),
    src('var a = 1', 'G1 X{var.a}'),
    src('var a = 1', 'M291 P{"v=" ^ var.a} S1'),
    src('var a = {1,2}', 'echo var.a[0]'),
    src('var a = {1,2}', 'echo #var.a'),
  ]);

  expectDiag([
    [src('echo var.a'), /undefined variable 'var\.a'/],
    [src('if true', '  var a = 1', 'echo var.a'), /undefined variable 'var\.a'/],
    [src('if true', '  var a = 1', 'else', '  echo var.a'), /undefined variable 'var\.a'/],
    [src('while iterations < 1', '  var a = 1', 'echo var.a'), /undefined variable 'var\.a'/],
    [src('if true', '  var a = 1', 'if true', '  echo var.a'), /undefined variable 'var\.a'/],
    [src('echo var.a', 'var a = 1'), /undefined variable 'var\.a'/],
    [src('var a = 1', 'G1 X{var.b}'), /undefined variable 'var\.b'/],
    [src('var a = 1', 'if var.b > 0', '  echo 1'), /undefined variable 'var\.b'/],
    [src('var a = 1', 'echo var.a, var.b'), /undefined variable 'var\.b'/],
    [src('var a = var.a'), /undefined variable 'var\.a'/],
  ]);

  it('scope ends exactly at dedent, not before', () => {
    const ds = lint(src('if true', '  var a = 1', '  echo var.a', 'echo var.a'));
    const errs = errorsOf(ds);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].range.start.line, 3);
  });

  it('blank lines and comments do not end a block', () => {
    const ds = lint(src('if true', '  var a = 1', '', '  ; note', '  echo var.a'));
    assert.deepEqual(msgs(errorsOf(ds)), []);
  });

  it('a macro cannot see another file\'s locals', () => {
    const ds = lint('echo var.a', { extraDocs: { 'untitled:other.g': 'var a = 1' } });
    assert.ok(has(ds, /undefined variable 'var\.a'/));
  });
});

describe('scope: duplicate declarations', () => {
  expectDiag([
    [src('var a = 1', 'var a = 2'), /already declared/],
    [src('var a = 1', 'if true', '  var a = 2'), /already declared/],
    [src('if true', '  var a = 1', '  var a = 2'), /already declared/],
    [src('var a = 1', 'while iterations < 1', '  if true', '    var a = 2'), /already declared/],
  ]);
  expectSilent([
    src('if true', '  var a = 1', 'if true', '  var a = 2'.replace('  var', '  var')),
    src('while iterations < 2', '  var a = 1', 'while iterations < 2', '  var a = 2'),
    src('var a = 1', 'var b = 2'),
  ]);
});

describe('scope: exists() guards', () => {
  // A guarded use of a never-in-scope variable is dead code -> warning, not error.
  const guardedInIf = src('if exists(var.zz)', '  echo var.zz');
  it('use under `if exists(var.x)` is a warning, not an error', () => {
    const ds = lint(guardedInIf);
    assert.deepEqual(msgs(errorsOf(ds)), []);
    assert.ok(warningsOf(ds).some(d => /exists\(\) guard is always false/.test(d.message)));
  });

  it('negated guard keeps the hard error', () => {
    const ds = lint(src('if !exists(var.zz)', '  echo var.zz'));
    assert.ok(has(errorsOf(ds), /undefined variable 'var\.zz'/));
  });

  it('else branch of a guard gets no protection', () => {
    const ds = lint(src('if exists(var.zz)', '  echo 1', 'else', '  echo var.zz'));
    assert.ok(has(errorsOf(ds), /undefined variable 'var\.zz'/));
  });

  it('same-line guard protects the right-hand side', () => {
    const ds = lint('if exists(var.zz) && var.zz > 5\n  echo 1');
    assert.deepEqual(msgs(errorsOf(ds)), []);
  });

  it('guard on a different variable does not protect', () => {
    const ds = lint(src('if exists(var.aa)', '  echo var.bb'));
    assert.ok(has(errorsOf(ds), /undefined variable 'var\.bb'/));
  });

  it('the exists() argument itself is never flagged', () => {
    assert.deepEqual(msgs(lint('echo exists(var.nothing)')), []);
    assert.deepEqual(msgs(lint('echo exists(global.nothing)')), []);
    assert.deepEqual(msgs(lint('echo exists(#var.nothing)')), []);
  });

  it('exists(move.axes[5]) on the object model is accepted', () => {
    assert.deepEqual(msgs(errorsOf(lint('if exists(move.axes[5])\n  echo 1'))), []);
  });
});

describe('scope: globals', () => {
  it('global declared in the same file resolves', () => {
    assert.deepEqual(msgs(lint(src('global g = 1', 'echo global.g'))), []);
  });

  it('global declared in another file resolves', () => {
    const ds = lint('echo global.g', { extraDocs: { 'untitled:globals.g': 'global g = 1' } });
    assert.deepEqual(msgs(ds), []);
  });

  it('unknown global is a warning, never an error', () => {
    const ds = lint('echo global.nope');
    assert.deepEqual(msgs(errorsOf(ds)), []);
    assert.ok(has(warningsOf(ds), /'global\.nope' not found in any open file/));
  });

  // A global another macro creates at run time is read under exists(): the firmware evaluates the
  // right side of && and || and a branch of ?: only when the left side or condition selects it.
  const quiet = (...lines: string[]) => assert.deepEqual(msgs(lint(src(...lines))), [], lines.join(' / '));
  const warns = (...lines: string[]) =>
    assert.ok(has(warningsOf(lint(src(...lines))), /'global\.hepafan' not found in any open file/), lines.join(' / '));

  it('an if, elif or while whose condition proves it exists covers its body', () => {
    quiet('if exists(global.hepafan)', '  echo global.hepafan');
    quiet('var f = "a.g"', 'var n = "fan"', 'if exists(global.hepafan)',
      '  echo >{var.f} "set global." ^ var.n ^ " = " ^ global.hepafan');
    quiet('if exists(global.hepafan) && global.hepafan > 0', '  set global.hepafan = 0');
    quiet('while exists(global.hepafan) && global.hepafan < 3', '  set global.hepafan = global.hepafan + 1');
    quiet('if exists(global.hepafan)', '  if global.hepafan > 0', '    echo global.hepafan');
    quiet('if false', '  echo 1', 'elif exists(global.hepafan)', '  echo global.hepafan');
    quiet('if exists(global.hepafan[0])', '  echo global.hepafan[0]');
    quiet('if (exists(global.hepafan) && true) && !false', '  echo global.hepafan');
  });

  it('&&, || and ?: on the line itself', () => {
    quiet('echo exists(global.hepafan) && global.hepafan');
    quiet('echo !exists(global.hepafan) || global.hepafan');
    quiet('echo exists(global.hepafan) ? global.hepafan : 0');
    quiet('echo !exists(global.hepafan) ? 0 : global.hepafan');
    quiet('M106 P0 S{exists(global.hepafan) ? global.hepafan : 0}');
    quiet('var x = exists(global.hepafan) && global.hepafan > 0');
    quiet('if !exists(global.hepafan) || global.hepafan == 0', '  M99');
  });

  it('the else of if !exists(…), and code after one that leaves the macro', () => {
    quiet('if !exists(global.hepafan)', '  echo "none"', 'else', '  echo global.hepafan');
    quiet('if !exists(global.hepafan)', '  echo "none"', 'elif global.hepafan > 0', '  echo global.hepafan');
    quiet('if !exists(global.hepafan)', '  echo "none"', '  M99', 'echo global.hepafan');
    quiet('if !exists(global.hepafan)', '  abort "no HEPA fan"', 'echo global.hepafan');
    quiet('if !exists(global.hepafan) || global.hepafan == 0', '  M99 ; nothing to do', 'echo global.hepafan');
    quiet('if !exists(global.hepafan)', '  M99', 'while true', '  echo global.hepafan', '  break');
    quiet('while !exists(global.hepafan)', '  G4 S1', 'echo global.hepafan');
  });

  it('a test that does not prove it keeps the warning', () => {
    warns('if !exists(global.hepafan)', '  echo global.hepafan');
    warns('if exists(global.hepafan) || true', '  echo global.hepafan');
    warns('if !(exists(global.hepafan) && true)', '  echo global.hepafan');
    warns('if exists(global.hepafan) == false', '  echo global.hepafan');
    // && and || share one priority: this is (true || exists(…)) && …
    warns('if true || exists(global.hepafan) && global.hepafan > 0', '  echo 1');
    warns('if exists(global.hepafan)', '  echo 1', 'else', '  echo global.hepafan');
    warns('if exists(global.hepafan)', '  echo 1', 'echo global.hepafan');
    warns('echo global.hepafan && exists(global.hepafan)');
    warns('echo exists(global.hepafan) || global.hepafan');
    warns('echo exists(global.hepafan) ? 0 : global.hepafan');
    // each echo item, and each {…} of a command, is evaluated on its own
    warns('echo exists(global.hepafan), global.hepafan');
    warns('G1 X{exists(global.hepafan) ? 1 : 0} Y{global.hepafan}');
  });

  it('an earlier if !exists(…) covers what follows only when its body always leaves', () => {
    warns('if !exists(global.hepafan)', '  echo "none"', 'echo global.hepafan');
    warns('if !exists(global.hepafan)', '  if true', '    M99', 'echo global.hepafan');
    warns('if !exists(global.hepafan) && true', '  M99', 'echo global.hepafan');
    warns('if !exists(global.hepafan)', '  M990', 'echo global.hepafan');
    warns('while !exists(global.hepafan)', '  break', 'echo global.hepafan');
    warns('if true', '  echo 1', 'elif !exists(global.hepafan)', '  M99', 'echo global.hepafan');
  });

  it('global.x[0] subscript resolves by base name', () => {
    assert.deepEqual(msgs(lint(src('global g = {1,2}', 'echo global.g[0]'))), []);
  });
});

describe('scope: param.', () => {
  expectSilent([
    'echo param.A',
    'G1 X{param.X}',
    'if exists(param.A)\n  echo param.A',
    'echo exists(param.Q)',
  ]);
  expectDiag([['set param.A = 1', /macro parameters are read-only/]]);
});

describe('scope: bare identifiers are checked against the object model', () => {
  it('object model index is available in the test environment', () => {
    // If this fails every OM assertion below is vacuous; install @duet3d/objectmodel.
    assert.equal(isOmIndexAvailable(), true);
  });

  expectSilent([
    'echo move.axes[0].homed',
    'echo state.status',
    'echo heat.heaters[0].current',
    'echo sensors.probes[0].value',
    'echo tools[0].active',
    'echo job.file.fileName',
    'echo network.name',
  ]);

  it('an unknown single word is a warning suggesting var.', () => {
    const ds = lint('echo nonsense');
    assert.ok(has(warningsOf(ds), /'nonsense' is not a known Object Model path — did you mean 'var\.nonsense'\?/));
  });

  it('a typo in a path suggests the known path, not var.', () => {
    const w = (t: string) => msgs(warningsOf(lint(t))).join(' | ');
    assert.match(w('echo move.axess[0].homed'), /'move\.axess\[0\]\.homed' is not a known Object Model path — did you mean 'move\.axes\[0\]\.homed'\?/);
    assert.match(w('echo move.axess'), /did you mean 'move\.axes'\?/);
    assert.doesNotMatch(w('echo move.axess'), /var\./);
    assert.match(w('echo move.zzz'), /'move\.zzz' is not a known Object Model path: 'move' has no field 'zzz'/);
  });

  it('a field after an index is checked', () => {
    const w = (t: string) => msgs(warningsOf(lint(t))).join(' | ');
    assert.match(w('echo move.axes[0].homedd'), /did you mean 'move\.axes\[0\]\.homed'\?/);
    assert.match(w('echo move.axes[0].noSuchField'), /'move\.axes\[0\]' has no field 'noSuchField'/);
    assert.match(w('echo tools[state.currentTool].nme'), /did you mean 'tools\[state\.currentTool\]\.name'\?/);
    assert.match(w('echo move.axes[0].microstepping.valu'), /did you mean 'move\.axes\[0\]\.microstepping\.value'\?/);
    assert.match(w('echo move.axes.homed'), /'move\.axes' has no field 'homed'/);
    // the range is the field
    const [d] = warningsOf(lint('echo move.axes[0].homedd'));
    assert.deepEqual([d.range.start.character, d.range.end.character], [18, 24]);
  });

  it('what follows a value of unknown type or an object without listed fields is not checked', () => {
    for (const t of ['echo move.axes[0].homed', 'echo move.axes[0].microstepping.value', 'echo heat.heaters[0].sensor + 1',
      'echo tools[state.currentTool].name', 'echo boards[0].inductiveSensor.foo', 'echo state.status[0]'])
      assert.deepEqual(msgs(lint(t)).filter(m => /Object Model/.test(m)), [], t);
  });

  // exists() of an unknown field is false, not an error (ObjectModel::GetObjectValue with WantExists):
  // a macro tests whether this firmware has a field before it reads it.
  const omWarnings = (...lines: string[]) => msgs(warningsOf(lint(src(...lines)))).filter(m => /Object Model/.test(m));
  it('a field that exists() tests is not reported, and neither is what the test guards', () => {
    for (const lines of [
      ['var fwOk = exists(state.newField) && state.newField >= 1'],
      ['var f = true', 'if var.f && !(exists(state.newField) && state.newField >= 1)', '  echo 1'],
      ['if exists(state.newField)', '  echo state.newField'],
      ['if !exists(state.newField)', '  M99', 'echo state.newField'],
      ['echo exists(move.axes[0].newField) ? move.axes[0].newField : 0'],
      // a deeper path proves the one above it; indexes are not compared
      ['if exists(move.axes[0].newField.sub)', '  echo move.axes[1].newField'],
    ]) assert.deepEqual(omWarnings(...lines), [], lines.join(' / '));
  });
  it('outside the test, or for another field, the warning stays', () => {
    assert.equal(omWarnings('echo state.newField').length, 1);
    assert.equal(omWarnings('echo exists(state.newField), state.newField').length, 1);
    assert.equal(omWarnings('if exists(state.newField)', '  echo state.otherField').length, 1);
    assert.equal(omWarnings('if exists(state.newField)', '  echo 1', 'else', '  echo state.newField').length, 1);
  });
  it('a typo or an unknown root inside exists() is still a warning: the test is always false', () => {
    assert.match(omWarnings('echo exists(move.axess)').join(), /'move\.axess' is not a known Object Model path, so exists\(\) of it is always false — did you mean 'move\.axes'\?/);
    assert.match(omWarnings('echo exists(move.axes[0].homedd)').join(), /did you mean 'move\.axes\[0\]\.homed'\?/);
    assert.match(omWarnings('echo exists(nonsense)').join(), /did you mean 'var\.nonsense'\?/);
  });

  it('array indices of any value normalise to []', () => {
    assert.deepEqual(msgs(lint('echo move.axes[7].homed')), []);
    assert.deepEqual(msgs(lint('echo move.axes[12].homed')), []);
  });

  it('bare G-code parameter letters outside braces are never OM lookups', () => {
    assert.deepEqual(msgs(lint('M291 R"x" P"y" S1 K{"a","b"}')), []);
  });
});

describe('scope: G-code lines see declared variables', () => {
  expectClean([
    src('var x = 1', 'G1 X{var.x} Y{var.x + 1}'),
    src('var s = "a.g"', 'M98 P{var.s}'),
  ]);
  expectDiag([[src('G1 X{var.q}'), /undefined variable 'var\.q'/]]);
});
