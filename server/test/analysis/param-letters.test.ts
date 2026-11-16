// Parameter letters against what the firmware reads (paramChecks.ts, server/data/gcode-params-*.json):
// a letter the command never reads is a warning; a letter every run needs (GCodeBuffer::MustSee,
// GetLimited…Value at the top of the command) is an error when missing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { lint, LintOptions } from '../helpers/harness';
import { PARAM_UNKNOWN_CODE, PARAM_MISSING_CODE } from '../../src/analysis/paramChecks';

const params = (text: string, opts: LintOptions = {}) =>
  lint(text, opts).filter(d => d.code === PARAM_UNKNOWN_CODE || d.code === PARAM_MISSING_CODE);
const show = (text: string, opts: LintOptions = {}) =>
  params(text, opts).map(d => `${d.code === PARAM_UNKNOWN_CODE ? 'unknown' : 'missing'} ${text.slice(d.range.start.character, d.range.end.character)}`);

describe('letters the command does not read', () => {
  it('are a warning on the letter and its value', () => {
    const [d] = params('G1 X1 Q5');
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.equal(d.code, PARAM_UNKNOWN_CODE);
    assert.deepEqual([d.range.start.character, d.range.end.character], [6, 8]);
    assert.match(d.message, /G1 does not read parameter Q in RRF 3\.5, 3\.6 or 3\.7, so the firmware ignores it/);
    assert.deepEqual(show('T0 X1'), ['unknown X1']);
    // RRF 3 sets the PWM frequency of a fan or pin with M950
    assert.deepEqual(show('M106 P0 S1 F500'), ['unknown F500']);
  });
  it('letters only looked at, axis letters and every letter a command reads are fine', () => {
    for (const t of ['G28 X Y', 'M17 X', 'M84 E0', 'M577 X S1', 'G1 A10 F600', 'M106 P0 S1 H1 T45', 'G10 P0 X0 Y0 Z0'])
      assert.deepEqual(show(t), [], t);
  });
  it('a letter one firmware line reads is not reported without a target', () => {
    // M558 U exists from 3.7
    assert.deepEqual(show('M558 K0 P8 U1'), []);
    assert.deepEqual(show('M558 K0 P8 U1', { rrfVersion: '3.5' }), ['unknown U1']);
    assert.match(params('M558 K0 P8 U1', { rrfVersion: '3.5' })[0].message, /in RRF 3\.5,/);
  });
  it('commands whose letters go to a macro, or that take the rest of the line, are not checked', () => {
    for (const t of ['M98 P"x.g" Q1', 'M1234 Q1', 'G29 Q1', 'G32 Z1', 'M117 X Y', 'M550 PMy Printer X1', 'M540 PDE:AD:BE:EF:CA:FE', 'G1 \'a10 Q1',
      // an unquoted word is the (wrong) value of Y, not the letters T, H, E, R …
      'M308 S1 Ythermistor T100000'])
      assert.deepEqual(show(t), [], t);
  });
  it('with a single-board computer, commands DuetSoftwareFramework reads itself are not checked', () => {
    assert.deepEqual(show('M929 P"log.txt" S1 Q2'), ['unknown Q2']);
    assert.deepEqual(show('M929 P"log.txt" S1 Q2', { sbc: true }), []);
  });
});

describe('letters the command needs', () => {
  it('a missing one is an error on the command', () => {
    const [d] = params('M42 P1');
    assert.equal(d.severity, DiagnosticSeverity.Error);
    assert.equal(d.code, PARAM_MISSING_CODE);
    assert.deepEqual([d.range.start.character, d.range.end.character], [0, 3]);
    assert.equal(d.message, `M42 needs parameter S: the firmware stops with "missing parameter 'S'"`);
    assert.deepEqual(show('M570 P5'), ['missing M570']);
    // S (a timeout) was read up to RRF 3.3 only
    assert.deepEqual(show('M570 H1 S5'), ['unknown S5']);
    assert.deepEqual(show('M291 S2'), ['missing M291']);
  });
  it('M471 renames S to T: a P is ignored and both are missing', () => {
    assert.deepEqual(show('M471 P"0:/sys/temp-network.g"'), ['unknown P"0:/sys/temp-network.g"', 'missing M471', 'missing M471']);
  });
  it('present letters, given as values or expressions, are fine', () => {
    for (const t of ['M42 P1 S0.5', 'M42 P{1} S{0.5}', 'M570 H1 P5 T15', 'M291 P"x" S2', 'M471 S"a.g" T"b.g"'])
      assert.deepEqual(show(t), [], t);
  });
  it('a letter some line does not need is not required without a target', () => {
    // M569 without P reports on 3.7, and stops with "missing parameter 'P'" on 3.5 and 3.6.
    assert.deepEqual(show('M569 S1'), []);
    assert.deepEqual(show('M569 S1', { rrfVersion: '3.5' }), ['missing M569']);
    assert.deepEqual(show('M569 S1', { rrfVersion: '3.7' }), []);
  });
  it('each command of a line is checked on its own letters', () => {
    assert.deepEqual(show('G4 S1 M42 P1'), ['missing M42']);
    assert.deepEqual(show('M42 P1 S1 G4 Q1'), ['unknown Q1']);
  });
});

describe('settings', () => {
  it('rrfgcode.argCheck.parameters.enabled and rrfgcode.argCheck.enabled turn the checks off', () => {
    assert.deepEqual(show('M42 P1 Q2', { argCheck: { parameters: { enabled: false } } }), []);
    assert.deepEqual(show('M42 P1 Q2', { argCheck: { enabled: false } }), []);
    assert.equal(show('M42 P1 Q2').length, 2);
  });
});
