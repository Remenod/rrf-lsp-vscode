// Parameter letters against what the firmware reads (paramChecks.ts, server/data/gcode-params-*.json):
// a letter the command never reads is a warning; a letter every run needs (GCodeBuffer::MustSee,
// GetLimited…Value at the top of the command) is an error when missing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { lint, LintOptions } from '../helpers/harness';
import { PARAM_UNKNOWN_CODE, PARAM_MISSING_CODE, PARAM_VALUE_CODE } from '../../src/analysis/paramChecks';

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

// StringParser reads a value that does not start with '{' with RRFLibraries NumericConverter:
// StrToI32 (a sign), StrToU32 (no '-'), SafeStrtof (a sign, '.', an exponent); none reads 0x or 0b.
describe('numbers written without {…}', () => {
  const values = (text: string, opts: LintOptions = {}) => lint(text, opts).filter(d => d.code === PARAM_VALUE_CODE);
  const one = (text: string) => {
    const ds = values(text);
    assert.equal(ds.length, 1, `${text}: ${JSON.stringify(ds.map(d => d.message))}`);
    return ds[0];
  };
  it('a number the reader cannot start is an error', () => {
    const d = one('M106 P-1 S1');
    assert.equal(d.severity, DiagnosticSeverity.Error);
    assert.deepEqual([d.range.start.character, d.range.end.character], [6, 8]);
    assert.equal(d.message, `parameter P of M106 cannot be negative, got -1: the firmware stops with "expected number after 'P'"`);
    assert.match(one('M584 X0.1 Y-1').message, /parameter Y of M584 cannot be negative/);
    assert.match(one('G4 P.5').message, /parameter P of G4 is a whole number, got \.5: the firmware stops with "expected number after 'P'"/);
    // a list reader reads on after ':'
    assert.match(one('M563 P0 D0:').message, /got '0:': the firmware stops with "expected number after ':'"/);
  });
  it('a number the reader takes only in part is a warning', () => {
    const d = one('G4 P1.5');
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.equal(d.message, 'parameter P of G4 is a whole number: the firmware reads P1.5 as P1 and ignores .5');
    assert.match(one('M563 P0 D0:1.5').message, /reads D0:1\.5 as D0:1 and ignores \.5/);
    assert.match(one('M260 A0x7F B1').message, /reads A0x7F as A0 — only an expression reads hex or binary, write A\{0x7F\}/);
    assert.match(one('G1 X0b11').message, /reads X0b11 as X0/);
    assert.match(one('G1 X1.5.3').message, /reads X1\.5\.3 as X1\.5 and ignores \.3/);
    // M906 reads one current for an axis and a list only for E
    assert.match(one('M906 Y1800:1800').message, /reads Y1800:1800 as Y1800 and ignores :1800/);
  });
  it('what some reader takes whole is fine', () => {
    for (const t of ['G4 S1.5', 'G4 P+2', 'G1 X1e3 Y-.5', 'M106 P0 H-1', 'M563 P0 D0:-1', 'M569 P0.1 S-1', 'M584 X0.1:0.2',
      'M906 E600:600', 'M260 A{0x7F}', 'G1 E-{1}', 'M98 P"x.g" A1.5', 'M1234 A0x7F', 'M92 E400:{2*200}', 'M92 E400:"x"'])
      assert.deepEqual(values(t).map(d => d.message), [], t);
  });
  it('with a single-board computer DuetSoftwareFramework parses the numbers: not checked', () => {
    assert.deepEqual(values('G4 P1.5', { sbc: true }), []);
  });
});

describe('settings', () => {
  it('rrfgcode.argCheck.parameters.enabled and rrfgcode.argCheck.enabled turn the checks off', () => {
    assert.deepEqual(show('M42 P1 Q2', { argCheck: { parameters: { enabled: false } } }), []);
    assert.deepEqual(show('M42 P1 Q2', { argCheck: { enabled: false } }), []);
    assert.equal(show('M42 P1 Q2').length, 2);
  });
});
