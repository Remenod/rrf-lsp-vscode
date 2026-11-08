// Real-world corpus: Vision Miner 22IDEX V4 SD-card firmware, release/4.2.0 at a pinned commit.
// Fetch with `npm run corpus:fetch` (see scripts/fetch-corpus.sh). Proprietary => never committed;
// every test here is skipped when the corpus is absent.
//
// These macros run on real hardware, so:
//   * any ERROR the language server reports on them is a false positive (or a real firmware bug — triage);
//   * the future type checker must add ZERO diagnostics here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { DiagnosticSeverity as Sev } from 'vscode-languageserver/node';
import { TokenType as T } from '../../src/parser/types';
import { lex, readData, SERVER_ROOT } from '../helpers/harness';
import { corpusAvailable, corpusFiles, corpusSha, lintCorpus, CORPUS_ROOT, CorpusResult } from '../helpers/corpus';
import { FORK_FUNCTIONS } from '../typecheck/model';

const PINNED_SHA = 'bfdc95eb2325039b9a63c8c78794c2a2ab87c771';
const skip = corpusAvailable() ? false : 'corpus not fetched — run `npm run corpus:fetch`';

describe('corpus: identity', { skip }, () => {
  it(`is the pinned commit ${PINNED_SHA.slice(0, 7)}`, () => {
    assert.equal(corpusSha(), PINNED_SHA);
  });
  it('is big enough to mean something', () => {
    const files = corpusFiles();
    assert.ok(files.length > 250, `${files.length} files`);
    const lines = files.reduce((n, f) => n + fs.readFileSync(f, 'utf8').split('\n').length, 0);
    assert.ok(lines > 15000, `${lines} lines`);
  });
  it('includes extensionless macro files with spaces in their names', () => {
    assert.ok(corpusFiles().some(f => /\/macros\/.* .*/.test(f) && !path.basename(f).includes('.')));
  });
});

let cached: CorpusResult[] | undefined;
const results = () => (cached ??= lintCorpus());

describe('corpus: diagnostics', { skip }, () => {
  it('lints every file without throwing, quickly', () => {
    const t0 = Date.now();
    cached = undefined;
    const r = results();
    assert.equal(r.length, corpusFiles().length);
    assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  });

  it('reports ZERO errors (any error is a false positive or a real firmware bug)', () => {
    const errs = results().flatMap(r => r.diagnostics
      .filter(d => d.severity === Sev.Error)
      .map(d => `${r.rel}:${d.range.start.line + 1} ${d.message}`));
    assert.deepEqual(errs, []);
  });

  it('warning categories match the triaged baseline', () => {
    const cat = (m: string) =>
      /^'global\./.test(m) ? 'global-not-found'
        : /is not a known Object Model path/.test(m) ? 'unknown-om-path'
          : /exists\(\) guard is always false/.test(m) ? 'dead-exists-guard'
            : /File or directory not found|Directory not found|Parent directory not found/.test(m) ? 'path-not-found'
              : /duplicate parameter/.test(m) ? 'duplicate-param'
                : 'other:' + m.slice(0, 40);
    const counts: Record<string, number> = {};
    for (const r of results()) for (const d of r.diagnostics) {
      const k = cat(d.message);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    // Triage of the baseline (all warnings, no errors):
    //  unknown-om-path   state.vmFeatureLevel: fork-only object-model field (false positive), and each use is
    //                    reported TWICE (duplicate diagnostic) -> 3 uses = 6.
    //  global-not-found  one legacy migration macro ("Upgrade to 4.1.0") reads pre-4.1 globals that no longer exist.
    //  dead-exists-guard sys/mesh.g: var.centerX/centerY are declared in a nested block, so the guard is always false.
    //  path-not-found    sys/networktest.g calls a macro that does not exist in this release.
    assert.deepEqual(counts, {
      'unknown-om-path': 6,
      'global-not-found': 17,
      'dead-exists-guard': 4,
      'path-not-found': 1,
    });
  });

  it('known real firmware defects are still detected (guards against silently losing the check)', () => {
    const msgsFor = (rel: string) => results().find(r => r.rel === rel)!.diagnostics.map(d => d.message);
    assert.ok(msgsFor('sys/mesh.g').some(m => /var\.centerX' is never in scope/.test(m)));
    assert.ok(msgsFor('sys/networktest.g').some(m => /Enable Ethernet to PC Mode/.test(m)));
  });

  it('KNOWN BUG: the same diagnostic is not published twice', { todo: 'state.vmFeatureLevel is reported twice per use' }, () => {
    for (const r of results()) {
      const seen = new Set<string>();
      for (const d of r.diagnostics) {
        const k = `${d.range.start.line}:${d.range.start.character}:${d.message}`;
        assert.ok(!seen.has(k), `${r.rel}: duplicate ${k}`);
        seen.add(k);
      }
    }
  });

  it('every diagnostic range lies inside its line', () => {
    for (const r of results()) {
      const lines = r.text.split(/\r?\n/);
      for (const d of r.diagnostics) {
        const line = lines[d.range.start.line];
        assert.ok(line !== undefined, `${r.rel}: line ${d.range.start.line}`);
        assert.ok(d.range.start.character >= 0 && d.range.end.character <= line.length + 1,
          `${r.rel}:${d.range.start.line + 1} range ${JSON.stringify(d.range)} on a ${line.length}-char line`);
        assert.ok(d.range.end.character >= d.range.start.character);
      }
    }
  });
});

describe('corpus: robustness', { skip }, () => {
  it('CRLF line endings give identical diagnostics', () => {
    const sample = results().filter((_, i) => i % 7 === 0).slice(0, 25);
    for (const r of sample) {
      const lf = lintOne(r, r.text).map(d => d.message).sort();
      const crlf = lintOne(r, r.text.replace(/\n/g, '\r\n')).map(d => d.message).sort();
      assert.deepEqual(crlf, lf, r.rel);
    }
  });

  it('linting is deterministic', () => {
    const r = results()[3];
    assert.deepEqual(lintOne(r, r.text).map(d => d.message), lintOne(r, r.text).map(d => d.message));
  });

  it('truncating a file at arbitrary points never crashes the pipeline', () => {
    const big = [...results()].sort((a, b) => b.text.length - a.text.length).slice(0, 6);
    for (const r of big) {
      for (let k = 1; k <= 40; k++) {
        const cut = Math.floor((r.text.length * k) / 41);
        assert.doesNotThrow(() => lintOne(r, r.text.slice(0, cut)), `${r.rel} @${cut}`);
      }
    }
  });

  it('deleting a random character from each line never crashes the lexer or validator', () => {
    const r = results().find(x => x.rel === 'sys/start.g') ?? results()[0];
    const lines = r.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length < 2) continue;
      const mutated = lines.slice();
      const at = (i * 7) % lines[i].length;
      mutated[i] = lines[i].slice(0, at) + lines[i].slice(at + 1);
      assert.doesNotThrow(() => lintOne(r, mutated.join('\n')), `${r.rel}:${i + 1}`);
    }
  });

  it('every line lexes with a terminating EOF and non-overlapping tokens', () => {
    for (const r of results().slice(0, 60)) {
      r.text.split(/\r?\n/).forEach((line, i) => {
        const toks = lex(line, i);
        assert.equal(toks[toks.length - 1].type, T.EOF);
        let prev = 0;
        for (const t of toks.filter(x => x.type !== T.EOF)) {
          assert.ok(t.start >= prev, `${r.rel}:${i + 1} overlap at ${t.value}`);
          prev = t.end;
        }
      });
    }
  });
});

describe('corpus: language coverage', { skip }, () => {
  const tokens = () => results().flatMap(r => r.text.split(/\r?\n/).flatMap((l, i) => lex(l, i)));

  it('no token is lexed as Unknown', () => {
    assert.equal(tokens().filter(t => t.type === T.Unknown).length, 0);
  });

  it('every G/M code used in the release has documentation (hover would work)', () => {
    const docs = readData('gcode-commands.json');
    const missing = [...new Set(tokens().filter(t => t.type === T.GCode).map(t => t.value.toUpperCase()))].filter(c => !docs[c]);
    assert.deepEqual(missing, []);
  });

  it('only functions that exist in the 3.5.4 fork are used (and none of the post-3.5.4 ones)', () => {
    const used = new Set(tokens().filter(t => t.type === T.FunctionName).map(t => t.value.toLowerCase()));
    assert.deepEqual([...used].filter(f => !(f in FORK_FUNCTIONS)), []);
  });

  it('the corpus exercises the constructs the type checker will touch', () => {
    const all = tokens();
    const has = (t: T) => all.some(x => x.type === t);
    for (const t of [T.If, T.Elif, T.Else, T.While, T.Var, T.Global, T.Set, T.Echo, T.Abort, T.StringLit,
      T.Float, T.Integer, T.True, T.False, T.Caret, T.Ternary, T.Hash, T.FunctionName, T.GCodeWord]) {
      assert.ok(has(t), `corpus never uses ${T[t]}`);
    }
  });
});

describe('corpus: type-check regression guard', { skip }, () => {
  it('no diagnostic mentions types (the checker must add zero findings on shipping macros)', () => {
    const typeish = /\b(type|expected (numeric|Boolean|integer|a string)|cannot convert|operand)\b/i;
    const hits = results().flatMap(r => r.diagnostics
      .filter(d => typeish.test(d.message))
      .map(d => `${r.rel}:${d.range.start.line + 1} ${d.message}`));
    assert.deepEqual(hits, []);
  });
});

import { pathToFileURL } from 'url';
import { SymbolTable } from '../../src/analysis/symbolTable';
import { computeDiagnostics } from '../../src/analysis/diagnostics';
import { defaultArgCheckConfig } from '../../src/analysis/argCheckConfig';
import { CORPUS_SETTINGS } from '../helpers/corpus';

function lintOne(r: CorpusResult, text: string) {
  const uri = pathToFileURL(path.join(CORPUS_ROOT, r.rel)).toString();
  const st = new SymbolTable();
  st.indexDocument(uri, text);
  const cfg = defaultArgCheckConfig();
  cfg.paths.ignore = CORPUS_SETTINGS.ignore;
  return computeDiagnostics(uri, text, { symbolTable: st, argCheckConfig: cfg, maxLineLength: 255 });
}
void SERVER_ROOT;
