// Which functions exist depends on the firmware version. The language server's function list was
// built from newer documentation than the Vision Miner fork (RRF 3.5.4 line), so a macro can pass
// the editor check and still fail on the printer with "unknown function".
//
// Requirement from the maintainer: argument/type validation MUST take a target-version parameter
// (proposed setting `rrfgcode.rrfVersion`) and use a per-version function table.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTION_NAMES } from '../../src/parser/types';
import { lint, has, errorsOf } from '../helpers/harness';
import { FORK_FUNCTIONS, NEWER_THAN_FORK } from './model';

describe('versions: language server function list vs the 3.5.4 fork', () => {
  const lsp = [...FUNCTION_NAMES].sort();
  const fork = Object.keys(FORK_FUNCTIONS).sort();

  it('every function the fork defines is known to the language server', () => {
    assert.deepEqual(fork.filter(f => !FUNCTION_NAMES.has(f)), []);
  });

  it('the extra names are exactly the documented post-3.5.4 additions (pin the gap)', () => {
    assert.deepEqual(lsp.filter(f => !fork.includes(f)).sort(), [...NEWER_THAN_FORK].sort());
  });

  it('GAP: the server accepts functions the fork rejects', { todo: 'no per-version function table' }, () => {
    assert.deepEqual(lsp.filter(f => !fork.includes(f)), [], 'these pass the editor check but fail on a 3.5.4 printer');
  });
});

describe('versions: target-version setting (spec, not implemented)', () => {
  for (const fn of NEWER_THAN_FORK) {
    const call = fn === 'find' || fn === 'take' || fn === 'drop' ? `echo ${fn}("abc", 1)` : `echo ${fn}(1.5)`;

    it(`${fn}() is an error when targeting 3.5.4`, { todo: 'rrfVersion not implemented' }, () => {
      const ds = lint(call, { rrfVersion: '3.5.4' });
      assert.ok(has(errorsOf(ds), /unknown function/), JSON.stringify(ds.map(d => d.message)));
    });

    it(`${fn}() is accepted when targeting a release that has it`, { todo: 'rrfVersion not implemented' }, () => {
      assert.deepEqual(errorsOf(lint(call, { rrfVersion: '3.6.0' })).map(d => d.message), []);
    });
  }

  it('functions in the fork are accepted on every version', () => {
    for (const fn of Object.keys(FORK_FUNCTIONS).filter(f => f !== 'exists')) {
      const spec = FORK_FUNCTIONS[fn];
      const args = Array.from({ length: spec.min }, () => '1').join(', ');
      if (fn === 'fileread' || fn === 'random' || fn === 'datetime' || fn === 'vector') continue;
      assert.deepEqual(errorsOf(lint(`echo ${fn}(${args})`, { rrfVersion: '3.5.4' })).map(d => d.message), [], fn);
    }
  });

  it('default (no version) keeps today\'s behaviour: everything the server knows', () => {
    assert.deepEqual(errorsOf(lint('echo round(1.5)')).map(d => d.message), []);
  });
});
