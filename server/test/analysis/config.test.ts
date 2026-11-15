// Settings normalisation and ignore-glob helpers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import {
  defaultArgCheckConfig, normaliseArgCheckConfig, isPathIgnored,
  makeIgnorePatternForFile, makeIgnorePatternForDir,
} from '../../src/analysis/argCheckConfig';

describe('config: normaliseArgCheckConfig', () => {
  const def = defaultArgCheckConfig();
  it('defaults are all-on, no ignores', () => {
    assert.deepEqual(def, { enabled: true, paths: { enabled: true, ignore: [] } });
  });
  const garbage: unknown[] = [undefined, null, 0, 1, 'x', true, [], () => 1];
  for (const g of garbage) {
    it(`non-object ${String(g)} falls back to defaults`, () => {
      assert.deepEqual(normaliseArgCheckConfig(g), def);
    });
  }
  it('partial config keeps other defaults', () => {
    assert.deepEqual(normaliseArgCheckConfig({ enabled: false }), { enabled: false, paths: { enabled: true, ignore: [] } });
    assert.deepEqual(normaliseArgCheckConfig({ paths: { enabled: false } }), { enabled: true, paths: { enabled: false, ignore: [] } });
  });
  it('wrong-typed fields are ignored', () => {
    assert.deepEqual(normaliseArgCheckConfig({ enabled: 'no', paths: { enabled: 1, ignore: 'x' } }), def);
  });
  it('non-string ignore entries are dropped', () => {
    assert.deepEqual(normaliseArgCheckConfig({ paths: { ignore: ['a', 1, null, 'b', {}] } }).paths.ignore, ['a', 'b']);
  });
});

describe('config: isPathIgnored', () => {
  const rows: Array<[string, string, boolean]> = [
    ['sys/a.g', 'sys/a.g', true],
    ['sys/a.g', 'sys/b.g', false],
    ['sys/a.g', 'sys/a.gx', false],
    ['sys/*.g', 'sys/a.g', true],
    ['sys/*.g', 'sys/lib/a.g', false],
    ['sys/**', 'sys/lib/deep/a.g', true],
    ['sys/**', 'sys/a.g', true],
    ['sys/**', 'macros/a.g', false],
    ['**', 'anything/at/all', true],
    ['**/a.g', 'x/y/a.g', true],
    ['**/a.g', 'a.g', true],
    ['{a,b}/x.g', 'a/x.g', true],
    ['{a,b}/x.g', 'b/x.g', true],
    ['{a,b}/x.g', 'c/x.g', false],
    ['{test*,tmp?}.g', 'testing.g', true],
    ['{test*,tmp?}.g', 'tmpx.g', true],
    ['{test*,tmp?}.g', 'tmpxy.g', false],
    ['a?.g', 'ab.g', true],
    ['a?.g', 'a/.g', false],
    ['[ab]x.g', 'ax.g', true],
    ['[ab]x.g', 'cx.g', false],
    ['file.with.dots', 'file.with.dots', true],
    ['file.with.dots', 'fileXwithXdots', false],
    ['a+b', 'a+b', true],
    ['(x)', '(x)', true],
    ['a^b', 'a^b', true],
    ['a$b', 'a$b', true],
    ['a|b', 'a|b', true],
    ['{unterminated', '{unterminated', true],
    ['[unterminated', '[unterminated', true],
  ];
  for (const [pattern, p, want] of rows) {
    it(`${JSON.stringify(pattern)} vs ${JSON.stringify(p)} -> ${want}`, () => {
      assert.equal(isPathIgnored(p, [pattern]), want);
    });
  }
  it('empty pattern list ignores nothing', () => assert.equal(isPathIgnored('a', []), false));
  it('any matching pattern wins', () => assert.equal(isPathIgnored('b', ['a', 'b']), true));
});

describe('config: ignore-pattern builders', () => {
  const root = path.join(path.sep, 'sd');
  it('file pattern is SD-root relative with forward slashes', () => {
    assert.equal(makeIgnorePatternForFile(path.join(root, 'sys', 'a.g'), root), 'sys/a.g');
  });
  it('dir pattern appends /**', () => {
    assert.equal(makeIgnorePatternForDir(path.join(root, 'sys', 'lib'), root), 'sys/lib/**');
  });
  it('dir pattern for the root itself collapses to **', () => {
    assert.equal(makeIgnorePatternForDir(root, root), '**');
  });
  it('built patterns match the thing they were built from', () => {
    const f = makeIgnorePatternForFile(path.join(root, 'sys', 'lib', 'a.g'), root);
    const d = makeIgnorePatternForDir(path.join(root, 'sys', 'lib'), root);
    assert.equal(isPathIgnored('sys/lib/a.g', [f]), true);
    assert.equal(isPathIgnored('sys/lib/b.g', [d]), true);
    assert.equal(isPathIgnored('sys/other.g', [d]), false);
  });
});
