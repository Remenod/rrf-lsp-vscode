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

  it('unknown OM path is a warning suggesting var.', () => {
    const ds = lint('echo nonsense');
    assert.ok(has(warningsOf(ds), /'nonsense' is not a known Object Model path — did you mean 'var\.nonsense'\?/));
  });

  it('typo in the head of a path is a warning', () => {
    assert.ok(has(warningsOf(lint('echo move.axess[0].homed')), /not a known Object Model path/));
    assert.ok(has(warningsOf(lint('echo move.zzz')), /not a known Object Model path/));
  });

  // The segment after an index (`[0].homedd`) is lexed as Dot + Identifier and skipped.
  it('typo AFTER an array index is a warning', { todo: 'fields following [n] are not validated' }, () => {
    assert.ok(has(warningsOf(lint('echo move.axes[0].homedd')), /not a known Object Model path/));
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
