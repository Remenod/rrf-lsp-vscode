// Opt-in: lint an RRF configuration of your own.
//
//   RRF_CONFIG_DIR=/path/to/config npm run test:config
//
// Point RRF_CONFIG_DIR at any RRF SD-card tree (sys/, macros/, filaments/ …) or a repository
// holding one, wherever it came from. Files are found the way the server's workspace scan finds
// them, except print jobs under gcodes/; `rrfgcode.*` settings come from
// <dir>/.vscode/settings.json when present. Without
// RRF_CONFIG_DIR every test here is skipped, so `npm test` passes on a fresh clone.
//
// A configuration that runs on a printer should lint clean, so a failure lists findings to
// triage: each is a false positive of the server or a real bug in the configuration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostic, DiagnosticSeverity as Sev } from 'vscode-languageserver/node';
import { TokenType as T } from '../../src/parser/types';
import { lex, readData } from '../helpers/harness';
import { configSkip, configFiles, configSettings, lintConfig, lintAlone, ConfigResult } from '../helpers/config';
import { diffDiagnostics, describeDiag } from '../typecheck/contract';

const skip = configSkip;
let cached: ConfigResult[] | undefined;
const results = () => (cached ??= lintConfig());
const where = (r: ConfigResult, d: Diagnostic) => `${r.rel}:${d.range.start.line + 1} ${d.message}`;

/** The largest files, up to 64 KB each: the mutation tests lint a file once per cut or per line. */
const largest = (n: number) => [...configFiles()].filter(f => f.text.length <= 65536).sort((a, b) => b.text.length - a.text.length).slice(0, n);

/** Diagnostics the type checker adds to (or, with `lost`, removes from) the rest of the server's. */
function checkerDelta(rrfVersion: string | null, lost = false): string[] {
  const on = lintConfig({ typeCheck: { enabled: true }, rrfVersion });
  const off = lintConfig({ typeCheck: { enabled: false }, rrfVersion });
  const [a, b] = lost ? [off, on] : [on, off];
  return a.flatMap((r, i) => diffDiagnostics(r.diagnostics, b[i].diagnostics).map(d => `${r.rel}: ${describeDiag(d)}`));
}

describe('configuration: files', { skip }, () => {
  it('holds RRF G-code files', () => {
    assert.ok(configFiles().length > 0, 'no RRF files found');
  });
});

describe('configuration: robustness', { skip }, () => {
  it('lints every file without throwing', () => {
    cached = undefined;
    assert.equal(results().length, configFiles().length);
  });

  it('every diagnostic range lies inside its line', () => {
    const bad: string[] = [];
    for (const r of results()) {
      const lines = r.text.split(/\r?\n/);
      for (const d of r.diagnostics) {
        const line = lines[d.range.start.line];
        if (line === undefined || d.range.start.character < 0 || d.range.end.character > line.length + 1
          || (d.range.end.line === d.range.start.line && d.range.end.character < d.range.start.character)) {
          bad.push(`${where(r, d)} ${JSON.stringify(d.range)}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  it('CRLF line endings give identical diagnostics', () => {
    for (const f of configFiles().filter((_, i) => i % 7 === 0).slice(0, 25)) {
      const lf = lintAlone(f, f.text).map(d => d.message).sort();
      const crlf = lintAlone(f, f.text.replace(/\r?\n/g, '\r\n')).map(d => d.message).sort();
      assert.deepEqual(crlf, lf, f.rel);
    }
  });

  it('truncating a file at arbitrary points never throws', () => {
    for (const f of largest(6)) {
      for (let k = 1; k <= 40; k++) {
        const cut = Math.floor((f.text.length * k) / 41);
        assert.doesNotThrow(() => lintAlone(f, f.text.slice(0, cut)), `${f.rel} @${cut}`);
      }
    }
  });

  it('deleting one character from each line never throws', () => {
    const f = largest(1)[0];
    if (!f) return;
    const lines = f.text.split('\n');
    for (let i = 0; i < Math.min(lines.length, 500); i++) {
      if (lines[i].length < 2) continue;
      const mutated = lines.slice();
      const at = (i * 7) % lines[i].length;
      mutated[i] = lines[i].slice(0, at) + lines[i].slice(at + 1);
      assert.doesNotThrow(() => lintAlone(f, mutated.join('\n')), `${f.rel}:${i + 1}`);
    }
  });

  it('every line lexes to non-overlapping tokens ending in EOF, none of them Unknown', () => {
    const bad: string[] = [];
    for (const f of configFiles()) {
      f.text.split(/\r?\n/).forEach((line, i) => {
        const toks = lex(line, i);
        if (toks[toks.length - 1]?.type !== T.EOF) bad.push(`${f.rel}:${i + 1} no EOF`);
        let prev = 0;
        for (const t of toks.filter(x => x.type !== T.EOF)) {
          if (t.start < prev) bad.push(`${f.rel}:${i + 1} overlap at ${t.value}`);
          if (t.type === T.Unknown) bad.push(`${f.rel}:${i + 1} unknown token ${JSON.stringify(t.value)}`);
          prev = t.end;
        }
      });
    }
    assert.deepEqual(bad, []);
  });
});

describe('configuration: findings to triage', { skip }, () => {
  it('no Error diagnostics', () => {
    const errs = results().flatMap(r => r.diagnostics.filter(d => d.severity === Sev.Error).map(d => where(r, d)));
    assert.deepEqual(errs, []);
  });

  it('every G/M code used has documentation (hover works)', () => {
    const docs = readData('gcode-commands.json');
    const used = new Set(configFiles().flatMap(f => f.text.split(/\r?\n/).flatMap((l, i) => lex(l, i)))
      .filter(t => t.type === T.GCode).map(t => t.value.toUpperCase()));
    assert.deepEqual([...used].filter(c => !docs[c]).sort(), []);
  });

  it('warnings, by message (informational)', t => {
    const counts = new Map<string, number>();
    for (const r of results()) for (const d of r.diagnostics) {
      if (d.severity !== Sev.Warning) continue;
      const k = d.message.replace(/'[^']*'/g, "'…'").slice(0, 80);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) t.diagnostic(`${String(n).padStart(4)}  ${k}`);
  });
});

describe('configuration: type checker', { skip }, () => {
  it('adds no diagnostics, rrfVersion unset', () => assert.deepEqual(checkerDelta(null), []));

  it('adds no diagnostics with the settings\' rrfVersion', { skip: skip || (configSettingsVersion() ? false : 'rrfgcode.rrfVersion is not set') }, () => {
    assert.deepEqual(checkerDelta(configSettingsVersion()!), []);
  });

  it('removes none of the other diagnostics', () => assert.deepEqual(checkerDelta(null, true), []));

  it('gives the same diagnostics whatever order the files are indexed in', () => {
    const fwd = lintConfig({ typeCheck: { enabled: true } }).map(r => r.diagnostics.map(describeDiag));
    const rev = lintConfig({ typeCheck: { enabled: true }, reverseIndexOrder: true }).map(r => r.diagnostics.map(describeDiag));
    assert.deepEqual(rev, fwd);
  });

  it('lints in under 3x the time it takes without the checker', () => {
    const t0 = Date.now(); lintConfig({ typeCheck: { enabled: false } }); const off = Date.now() - t0;
    const t1 = Date.now(); lintConfig({ typeCheck: { enabled: true } }); const on = Date.now() - t1;
    assert.ok(on <= 3 * off + 300, `on ${on} ms vs off ${off} ms`);
  });
});

function configSettingsVersion(): string | undefined {
  return skip ? undefined : configSettings().rrfVersion;
}
