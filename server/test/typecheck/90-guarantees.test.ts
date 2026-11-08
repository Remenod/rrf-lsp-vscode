// SPEC §13: no false positives on real macros, robustness. All guards: they hold today and must
// keep holding once the checker exists.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { guard, typeDiags, lintTc, diffDiagnostics, describeDiag, expectNoTypes } from './contract';
import { corpusAvailable, lintCorpus, CorpusResult } from '../helpers/corpus';
import { src } from '../helpers/harness';

const skip = corpusAvailable() ? false : 'corpus not fetched — run `npm run corpus:fetch`';

function corpusTypeDiags(rrfVersion?: string, reverseIndexOrder = false): string[] {
  const on = lintCorpus({ typeCheck: { enabled: true }, rrfVersion, reverseIndexOrder });
  const off = lintCorpus({ typeCheck: { enabled: false }, rrfVersion, reverseIndexOrder });
  const byRel = new Map(off.map(r => [r.rel, r]));
  return on.flatMap((r: CorpusResult) =>
    diffDiagnostics(r.diagnostics, byRel.get(r.rel)!.diagnostics).map(d => `${r.rel}: ${describeDiag(d)}`));
}

describe('TC-FP-01: the Vision Miner 4.2.0 corpus', { skip }, () => {
  guard('TC-FP-01', 'zero type diagnostics, version unset', () => assert.deepEqual(corpusTypeDiags(), []));
  guard('TC-FP-01', 'zero type diagnostics, rrfVersion 3.5.4', () => assert.deepEqual(corpusTypeDiags('3.5.4'), []));
  guard('TC-FP-01', 'the checker removes nothing from the corpus baseline', () => {
    const on = lintCorpus({ typeCheck: { enabled: true } });
    const off = lintCorpus({ typeCheck: { enabled: false } });
    const byRel = new Map(on.map(r => [r.rel, r]));
    const lost = off.flatMap(r => diffDiagnostics(r.diagnostics, byRel.get(r.rel)!.diagnostics).map(d => `${r.rel}: ${describeDiag(d)}`));
    assert.deepEqual(lost, []);
  });
});

describe('TC-FP-02: valid idioms stay silent', () => {
  const idioms: string[] = [
    src('if !exists(global.x)', '  global x = 0'),
    'var dir = move.axes[0].machinePosition > 0 ? 1 : -1',
    src('var dir = 1', 'G1 X{var.dir * 10} F{60 * 100}'),
    'M291 P{"Temp " ^ heat.heaters[1].current ^ "C"} R"Info" S1',
    src('while iterations < #move.axes', '  if move.axes[iterations].homed', '    continue', '  echo "axis", iterations, "not homed"'),
    src('var t = state.currentTool', 'if var.t >= 0', '  echo tools[var.t].name'),
    src('if fileexists("0:/sys/user/x.g")', '  M98 P"0:/sys/user/x.g"'),
    src('var v = 1.5', 'echo >"0:/sys/user/variables/X.g" "set global.x = " ^ var.v'),
    src("var r = fileread(\"0:/sys/version.txt\", 0, 2, ',')", 'if var.r[0] == "4"', '  echo 1'),
    src('var count = 0', 'set var.count = var.count + 1'),
    'if state.status == "processing" || state.status == "paused"\n  echo 1',
    src('var arr = vector(5, 0)', 'while iterations < #var.arr', '  set var.arr[iterations] = iterations * 2'),
    src('var code = 3', 'abort "Error: " ^ var.code'),
    'echo "pos", move.axes[0].machinePosition, move.axes[1].machinePosition',
    'if move.axes[2].homed && move.axes[2].machinePosition < 10\n  echo 1',
    'var s = exists(param.S) ? param.S : 0',
    'G10 P0 S{param.S} R{param.R}',
    'var elapsed = state.upTime - 5',
    src('while iterations < 4', '  if mod(iterations, 2) == 0', '    echo iterations'),
    'var avg = (move.axes[0].min + move.axes[0].max) / 2',
    src('var arr = {1, 2, 3, 4}', 'var idx = floor(#var.arr / 2)', 'echo var.arr[var.idx]'),
    'if heat.heaters[1].current > heat.heaters[1].active - 5\n  echo 1',
    'if sensors.probes[0].value[0] < 500\n  echo 1',
    'var z = {move.axes[2].machinePosition}',
    'M291 S4 K{"Yes","No"} R"Q" P"?"\nif input == 0\n  echo 1',
    'var safe = max(move.axes[2].min, 0)',
    'if !move.axes[0].homed || !move.axes[1].homed\n  G28',
    'echo {"a" ^ 1}',
    src('var s = ""', 'set var.s = var.s ^ "x"'),
    src('var hex = 0xFF', 'M42 P0 S{var.hex / 255}'),
    src('var x = null', 'if var.x != null', '  echo var.x + 1'),
    'if result == 0\n  echo 1',
    src('while true', '  if iterations > 5', '    break'),
    'var when = datetime("2024-01-01T00:00:00") + 3600',
    src('var p = {1.5, 2.5}', 'G1 X{var.p[0]} Y{var.p[1]}'),
    'M98 P"0:/sys/lib/logging/LogLine.g" S{"Tool " ^ state.currentTool ^ " ready"}',
    src('var e = {0,}', 'set var.e[0] = var.e[0] + 1'),
    'echo 1,',
    'var big = 3000000000 + 1',
    'if global.undeclaredSomewhere\n  echo 1',
    'echo exists(global.a) && global.a > 1',
    'if exists(move.axes[3]) && move.axes[3].homed\n  echo 1',
    'echo #state.status',
    'G1 X{max(move.axes[0].min, -10)}',
    'echo "x" ^ {1, 2}',
  ];
  for (const t of idioms) guard('TC-FP-02', JSON.stringify(t).slice(0, 90), () => expectNoTypes(t));
});

describe('TC-ROB: robustness', () => {
  guard('TC-ROB-01', 'random token soup never throws', () => {
    const vocab = ['var', 'set', 'if', 'echo', 'while', 'global', 'abort', 'var.x', 'global.g', 'param.A', 'move.axes', '[', ']',
      '(', ')', '{', '}', ',', '+', '-', '*', '/', '^', '&&', '||', '!', '?', ':', '==', '<', '#', '1', '2.5', '3000000000',
      '"s"', "'c'", 'true', 'null', 'abs', 'max', 'vector', 'fileread', 'random', 'datetime', 'iterations', 'G1', 'X', 'M98', 'P', '=', ';'];
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 600; i++) {
      const len = 1 + rnd(12);
      const line = Array.from({ length: len }, () => vocab[rnd(vocab.length)]).join(rnd(3) ? ' ' : '');
      for (const v of [undefined, '3.5.4']) {
        assert.doesNotThrow(() => lintTc(src('var x = 1', line), { rrfVersion: v }), line);
      }
    }
  });
  guard('TC-ROB-01', 'every prefix of a realistic macro lints without throwing', () => {
    const macro = src(
      'var a = {1, 2, 3}', 'var s = "x"', 'while iterations < #var.a', '  if var.a[iterations] > 1 && -var.a[0] < 0',
      '    set var.s = var.s ^ var.a[iterations]', '  elif move.axes[0].homed', '    continue', 'G1 X{var.a[0] * 2} F{max(1, 2)}',
      'echo >"0:/x.g" "set global.g = " ^ var.s', 'abort "done " ^ var.s');
    for (let i = 0; i <= macro.length; i += 3) assert.doesNotThrow(() => lintTc(macro.slice(0, i)), String(i));
  });
  guard('TC-ROB-02', 'the corpus lints in under 3x the time without the checker', () => {
    if (!corpusAvailable()) return;
    const t0 = Date.now(); lintCorpus({ typeCheck: { enabled: false } }); const off = Date.now() - t0;
    const t1 = Date.now(); lintCorpus({ typeCheck: { enabled: true } }); const on = Date.now() - t1;
    assert.ok(on <= 3 * off + 300, `on ${on} ms vs off ${off} ms`);
  });
  guard('TC-ROB-03', 'deterministic', () => {
    const t = src('var x = 1', 'if move.axes[0].homed', '  set var.x = "s"', 'echo var.x + 1, "a" + 1');
    assert.deepEqual(typeDiags(t).map(describeDiag), typeDiags(t).map(describeDiag));
  });
  guard('TC-ROB-03', 'independent of the order the workspace was indexed in', () => {
    if (!corpusAvailable()) return;
    assert.deepEqual(corpusTypeDiags(undefined, true), corpusTypeDiags(undefined, false));
  });
  guard('TC-ROB-04', 'deep nesting does not overflow', () => {
    assert.doesNotThrow(() => lintTc(`echo ${'('.repeat(200)}1${')'.repeat(200)} + 1`));
    assert.doesNotThrow(() => lintTc(`echo ${Array.from({ length: 100 }, (_, i) => `move.axes[0].homed ? ${i} :`).join(' ')} 0`));
    assert.doesNotThrow(() => lintTc(`echo ${Array.from({ length: 300 }, () => '1').join(' + ')}`));
    assert.doesNotThrow(() => lintTc(`echo ${'-'.repeat(2)}${'!'.repeat(150)}true`));
  });
});
