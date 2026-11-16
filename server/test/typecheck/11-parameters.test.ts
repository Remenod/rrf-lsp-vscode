// SPEC §12: braced values of G/M/T parameters against how the firmware reads the letter.
//
// The expectations below are transcribed independently from RepRapFirmware ExpressionParser.cpp
// (ConvertToFloat, ConvertToInteger, ConvertToUnsigned, ConvertToDriverId, ParseArray) and
// StringParser.cpp (ReadFloatValue, ReadIValue, ReadUIValue, ReadDriverIdValue, GetQuotedString),
// identical in tags 3.5.4, 3.6.4 and 3.7.0 except where a test says otherwise.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rule, guard, CODE, expectTypes, expectNoTypes, typeDiags } from './contract';
import { src } from '../helpers/harness';

/** One letter per kind, read that way on every firmware line. */
const LETTER: Record<string, { line: string; letter: string }> = {
  float: { line: 'G1 X', letter: 'X' },
  int: { line: 'M104 S200 T', letter: 'T' },
  bool: { line: 'M118 S"x" D', letter: 'D' },
  uint: { line: 'M106 S1 P', letter: 'P' },
  driver: { line: 'M569 S1 P', letter: 'P' },
  'float[]': { line: 'M92 E', letter: 'E' },
  'int[]': { line: 'M106 P0 H', letter: 'H' },
  'uint[]': { line: 'M569 P0 Y', letter: 'Y' },
  'driver[]': { line: 'M584 E', letter: 'E' },
  string: { line: 'M98 P', letter: 'P' },
  any: { line: 'M291 P"x" S4 K', letter: 'K' },
};

/** Values by type, as written inside the braces. */
const VALUE: Record<string, string> = {
  int: '1', uint: '4294967295', float: '1.5', string: '"a"', bool: 'true', null: 'null', char: "'a'",
  datetime: 'datetime(0)', 'int array': '1, 2', 'float array': 'vector(2, 1.5)', 'string array': '"a", "b"',
  'nested array': 'vector(2, vector(1, 0))',
};

/** Which value types each kind accepts, and the firmware's text for the others. */
const ACCEPTS: Record<string, { ok: string[]; firmware: string }> = {
  float: { ok: ['int', 'uint', 'float'], firmware: 'expected numeric operand' },
  int: { ok: ['int', 'uint'], firmware: 'expected integer value' },
  bool: { ok: ['int', 'uint'], firmware: 'expected integer value' },
  uint: { ok: ['int', 'uint'], firmware: 'expected non-negative integer' },
  driver: { ok: ['int', 'uint', 'float', 'int array', 'float array'], firmware: 'expected driver ID' },
  'float[]': { ok: ['int', 'uint', 'float', 'int array', 'float array'], firmware: 'expected numeric operand' },
  'int[]': { ok: ['int', 'uint', 'int array'], firmware: 'expected integer value' },
  'uint[]': { ok: ['int', 'uint', 'int array'], firmware: 'expected non-negative integer' },
  'driver[]': { ok: ['int', 'uint', 'float', 'int array', 'float array'], firmware: 'expected driver ID' },
  string: { ok: Object.keys(VALUE), firmware: '' },
  any: { ok: Object.keys(VALUE), firmware: '' },
};

describe('TC-GC-02: values converted as the firmware converts them', () => {
  for (const [kind, { line, letter }] of Object.entries(LETTER)) {
    for (const [type, value] of Object.entries(VALUE)) {
      const text = `${line}{${value}}`;
      if (ACCEPTS[kind].ok.includes(type)) {
        guard('TC-GC-02', `${kind} accepts ${type}: ${text}`, () => expectNoTypes(text));
      } else {
        rule('TC-GC-02', `${kind} rejects ${type}: ${text}`, () => {
          expectTypes(text, [{ code: CODE.argument, at: value, firmware: ACCEPTS[kind].firmware, mentions: [`parameter ${letter}`] }]);
        });
      }
    }
  }
  rule('TC-GC-02', 'the message names the parameter, the command, what it needs and the type given', () => {
    const [d] = typeDiags('G1 X{"10"}');
    assert.equal(d.message, 'parameter X of G1 needs a number, got string: the firmware stops with "expected numeric operand"');
    const [b] = typeDiags('M118 S"x" D{true}');
    assert.match(b.message, /needs an integer \(0 or 1\), got bool/);
  });
  guard('TC-GC-02', 'a value that may convert is not reported', () => {
    expectNoTypes(src('var x = 1', 'if move.axes[0].homed', '  set var.x = "a"', 'G1 X{var.x}'));
    expectNoTypes('G1 X{param.A}');
    expectNoTypes('G1 X{move.axes[0].userPosition}');
    expectNoTypes('M104 S200 T{state.currentTool}');
    expectNoTypes('M106 P{floor(1.5)} S1');
  });
  rule('TC-GC-02', 'a float where the firmware reads an integer', () => {
    expectTypes('M291 S{2.0} P"x"', [{ code: CODE.argument, at: '2.0', firmware: 'expected non-negative integer' }]);
    expectTypes('M568 P0 S{null}', [{ code: CODE.argument, at: 'null', firmware: 'expected numeric operand' }]);
  });
  rule('TC-GC-02', 'a division is a float, which an integer parameter rejects', () => {
    expectTypes(src('var t = 1000', 'G4 P{var.t / 2}'), [{ code: CODE.argument, at: 'var.t / 2', firmware: 'expected integer value' }]);
  });
  guard('TC-GC-02', 'a value that already has a type error is reported once', () => {
    expectTypes('G1 X{"a" + 1}', [{ code: CODE.operand, at: '"a" + 1' }]);
  });
});

describe('TC-GC-03: list parameters', () => {
  rule('TC-GC-03', 'an element after a colon is read as one value', () => {
    expectTypes('M92 E400:{"a"}', [{ code: CODE.argument, at: '"a"', firmware: 'expected numeric operand', mentions: [/needs a number, got string/] }]);
    expectTypes('M92 E{1}:{"a"}', [{ code: CODE.argument, at: '"a"' }]);
  });
  guard('TC-GC-03', 'well-formed lists', () => {
    for (const t of ['M92 E400:{420}', 'M92 E{400, 420}', 'M92 E{vector(2, 415)}', 'M92 E{move.extruders[0].stepsPerMm}', 'M106 P0 H{-1}'])
      expectNoTypes(t);
  });
  guard('TC-GC-03', 'a single-value parameter does not read past a colon', () => expectNoTypes('G1 X1:{"a"}'));
  rule('TC-GC-03', 'a list whose elements do not convert', () => {
    expectTypes('M92 E{"a", "b"}', [{ code: CODE.argument, at: '"a", "b"', mentions: ['a number or a list of numbers', /got array<string>/] }]);
  });
});

describe('TC-GC-04: which letters are checked', () => {
  rule('TC-GC-04', 'an axis letter is read as the command reads its axes', () => {
    expectTypes('G1 A{"x"}', [{ code: CODE.argument, at: '"x"', mentions: ['parameter A of G1'] }]);
    expectTypes('M584 Z{"x"}', [{ code: CODE.argument, at: '"x"', firmware: 'expected driver ID' }]);
  });
  guard('TC-GC-04', 'a letter the command does not read is not checked', () => {
    expectNoTypes('G1 X1 Q{"x"}');
    expectNoTypes('M1234 P{"x"}');
  });
  rule('TC-GC-04', 'a fractional command is checked against its own entry', () => {
    expectTypes('M569 P0 F{"x"}', [{ code: CODE.argument, at: '"x"', firmware: 'expected non-negative integer' }]);
    expectNoTypes('M569.5 P0 F{"log.csv"} S1');
  });
  guard('TC-GC-04', 'a fraction the firmware does not handle itself is not checked', () => {
    expectNoTypes('M569.99 P0 F{"x"}');
    expectNoTypes('M140.1 S{"x"}');
  });
  rule('TC-GC-04', 'T{…} is the tool number, an integer', () => {
    expectTypes('T{1.5}', [{ code: CODE.argument, at: '1.5', firmware: 'expected integer value', mentions: ['parameter T of T'] }]);
    expectNoTypes('T{state.currentTool}');
    expectNoTypes('T{-1}');
  });
  rule('TC-GC-04', 'M98 without P reads R; with P, every other letter is a parameter of the macro', () => {
    expectTypes('M98 R{"x"}', [{ code: CODE.argument, at: '"x"', firmware: 'expected non-negative integer' }]);
    expectNoTypes('M98 P"x.g" R{"abc"}');
    expectNoTypes('M98 P"x.g" S{true} A{null}');
    // G29 without S runs sys/mesh.g with its letters; with S it reads them itself.
    expectNoTypes('G29 K{true}');
    expectTypes('G29 S0 K{true}', [{ code: CODE.argument, at: 'true', firmware: 'expected non-negative integer' }]);
  });
  guard('TC-GC-04', 'a value outside any parameter is not checked', () => expectNoTypes('M117 {1 + 1}'));
  rule('TC-GC-04', 'on a line with several commands, a value belongs to the command before it', () => {
    expectTypes('G91 G1 Z{"x"} F600 G90', [{ code: CODE.argument, at: '"x"', mentions: ['parameter Z of G1'] }]);
    expectTypes('M98 P"x.g" G4 S{"a"}', [{ code: CODE.argument, at: '"a"', mentions: ['parameter S of G4'] }]);
  });
  guard('TC-GC-04', 'a later command keeps its own letters', () => {
    // S of M98 is a macro parameter, not the S of G4; T after G1 is a parameter of G1, not a tool change.
    expectNoTypes('G4 S1 M98 P"x.g" S{"abc"}');
    expectNoTypes('G1 X1 T{"x"}');
  });
});

describe('TC-GC-05: text parameters accept every value', () => {
  // GetQuotedString / GetPossiblyQuotedString turn the value into text with AppendAsString.
  guard('TC-GC-05', 'string-valued parameters', () => {
    for (const t of ['M98 P{1}', 'M291 P{3.5} S1', 'M291 R{true} P"x" S1', 'M98 P{"a" ^ 1}', 'M950 J0 C{"io" ^ 1 ^ ".in"}', 'M308 S0 Y{null}',
      'M117 {vector(2, 0)}', 'M98 P"x.g" A{move.axes[0]}', 'M98 P"x.g" B{null}', 'echo >{1} "x"'])
      expectNoTypes(t);
  });
  guard('TC-GC-05', 'address parameters are not checked', () => {
    for (const t of ['M552 P{1}', 'M553 P{true}', 'M540 P{1.5}']) expectNoTypes(t);
  });
});

describe('TC-GC-06: firmware lines', () => {
  rule('TC-GC-06', 'with a target, that line decides', () => {
    // M581.1 exists from 3.7; on 3.5 and 3.6 the firmware runs a macro for it.
    expectTypes('M581.1 T{1.5} P"x"', [{ code: CODE.argument, at: '1.5' }], { rrfVersion: '3.7' });
    expectNoTypes('M581.1 T{1.5} P"x"', { rrfVersion: '3.6' });
  });
  guard('TC-GC-06', 'with no target, a letter one line does not read is not checked', () => {
    expectNoTypes('M581.1 T{1.5} P"x"');
  });
  rule('TC-GC-06', 'a single driver ID: 3.5 converts with ParseFloat, later lines with ConvertToDriverId', () => {
    expectTypes('M569 P{"x"} S1', [{ code: CODE.argument, at: '"x"', firmware: 'expected numeric operand' }], { rrfVersion: '3.5' });
    expectTypes('M569 P{"x"} S1', [{ code: CODE.argument, at: '"x"', firmware: 'expected driver ID' }], { rrfVersion: '3.6' });
  });
  rule('TC-GC-06', 'a letter read differently per line takes the target line', () => {
    // M308 D: GetUIValue on 3.5, TryGetBValue (GetIValue) from 3.6.
    expectTypes('M308 S0 D{1.5}', [{ code: CODE.argument, at: '1.5', firmware: 'expected non-negative integer' }], { rrfVersion: '3.5' });
    expectTypes('M308 S0 D{1.5}', [{ code: CODE.argument, at: '1.5', firmware: 'expected integer value' }], { rrfVersion: '3.7' });
  });
});

describe('TC-GC-07: single-board computer', () => {
  guard('TC-GC-07', 'commands DuetSoftwareFramework reads itself are not checked with rrfgcode.sbc', () => {
    expectNoTypes('M98 R{"x"}', { sbc: true });
    expectNoTypes('M929 S{"x"}', { sbc: true });
  });
  rule('TC-GC-07', 'other commands are checked with rrfgcode.sbc', () => {
    expectTypes('G1 X{"10"}', [{ code: CODE.argument, at: '"10"' }], { sbc: true });
  });
});
