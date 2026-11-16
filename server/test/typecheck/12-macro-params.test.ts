// SPEC §7: macro parameters take the types their callers pass.
//
// From RepRapFirmware StringParser::AddParameters (each letter but M98's P is parsed as an
// expression), GCodes::TryMacroFile, DoFileMacroWithParameters (G29 → mesh.g, G32 → bed.g),
// GCodes::ProcessEvent with Event::GetParameters, and the deploy/retract probe macros; the same
// in tags 3.5.4, 3.6.4 and 3.7.0.

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { rule, guard, CODE, typeDiags, typeAt, hoverText, describeDiag, TcOptions } from './contract';
import { makeSd, src } from '../helpers/harness';

/**
 * An SD card holding `files`; `fn` gets the type diagnostics and hover types of one of them,
 * linted with every other file indexed, as in an open workspace.
 */
function onCard(files: Record<string, string>, fn: (card: {
  diags(rel: string, opts?: TcOptions): string[];
  type(rel: string, line: number, needle: string, occurrence?: number): string | null;
  hover(rel: string, line: number, needle: string): string;
}) => void): void {
  const sd = makeSd(files);
  try {
    const opts = (rel: string): TcOptions => ({
      file: sd.at(rel),
      extraDocs: Object.fromEntries(Object.entries(files).filter(([r]) => r !== rel && !r.endsWith('/'))
        .map(([r, t]) => [pathToFileURL(sd.at(r)).toString(), t])),
    });
    fn({
      diags: (rel, o = {}) => typeDiags(files[rel], { ...opts(rel), ...o }).map(describeDiag),
      type: (rel, line, needle, occurrence = 0) => typeAt(files[rel], line, needle, occurrence, opts(rel)),
      hover: (rel, line, needle) => hoverText(files[rel], line, needle, 0, opts(rel)) ?? '',
    });
  } finally {
    sd.cleanup();
  }
}

describe('TC-PRM-02: what the calls pass', () => {
  rule('TC-PRM-02', 'each letter has the type of its value', () => {
    onCard({
      'sys/config.g': src('var f = 1.5', 'M98 P"setup.g" S5 R1.5 T"abc" F{var.f} H-1 X0x10 Y{"a", "b"}'),
      'sys/setup.g': src('echo param.S, param.R, param.T, param.F, param.H, param.X, param.Y'),
    }, card => {
      assert.equal(card.type('sys/setup.g', 0, 'param.S'), 'int');
      assert.equal(card.type('sys/setup.g', 0, 'param.R'), 'float');
      assert.equal(card.type('sys/setup.g', 0, 'param.T'), 'string');
      assert.equal(card.type('sys/setup.g', 0, 'param.F'), 'float');
      assert.equal(card.type('sys/setup.g', 0, 'param.H'), 'int');
      assert.equal(card.type('sys/setup.g', 0, 'param.X'), 'int');
      assert.equal(card.type('sys/setup.g', 0, 'param.Y'), 'array<string>');
    });
  });
  rule('TC-PRM-02', 'a value the callee cannot use is reported in the callee', () => {
    onCard({
      'sys/config.g': 'M98 P"setup.g" T"abc"',
      'sys/setup.g': 'echo param.T * 2',
    }, card => {
      const d = card.diags('sys/setup.g');
      assert.equal(d.length, 1, d.join('\n'));
      assert.match(d[0], new RegExp(CODE.operand));
      assert.match(d[0], /string/);
    });
  });
  guard('TC-PRM-02', 'the union of every call', () => {
    onCard({
      'sys/config.g': src('M98 P"setup.g" T5', 'M98 P"setup.g" T"abc"'),
      'sys/setup.g': 'echo param.T * 2',
    }, card => {
      assert.deepEqual(card.diags('sys/setup.g'), []);
      assert.equal(card.type('sys/setup.g', 0, 'param.T'), 'int | string');
    });
  });
  rule('TC-PRM-02', 'the file a call runs: relative to /sys, absolute, on volume 0, any case', () => {
    onCard({
      'sys/config.g': src('M98 P"a.g" S1', 'M98 P"/macros/Do It" S"x"', 'M98 P"0:/sys/B.G" S1.5', 'M98 P{"a.g"} T1'),
      'sys/a.g': 'echo param.S, param.T',
      'macros/Do It': 'echo param.S',
      'sys/b.g': 'echo param.S',
    }, card => {
      assert.equal(card.type('sys/a.g', 0, 'param.S'), 'int');
      assert.equal(card.type('sys/a.g', 0, 'param.T'), 'int');
      assert.equal(card.type('macros/Do It', 0, 'param.S'), 'string');
      assert.equal(card.type('sys/b.g', 0, 'param.S'), 'float');
    });
  });
  rule('TC-PRM-02', 'a command the firmware does not have runs its macro, with every letter', () => {
    onCard({
      'sys/config.g': src('M1234 P"x" S2', 'G29 R1', 'G32 T3'),
      'sys/M1234.g': 'echo param.P, param.S',
      'sys/mesh.g': 'echo param.R',
      'sys/bed.g': 'echo param.T',
    }, card => {
      assert.equal(card.type('sys/M1234.g', 0, 'param.P'), 'string');
      assert.equal(card.type('sys/M1234.g', 0, 'param.S'), 'int');
      assert.equal(card.type('sys/mesh.g', 0, 'param.R'), 'int');
      assert.equal(card.type('sys/bed.g', 0, 'param.T'), 'int');
      assert.match(card.hover('sys/config.g', 0, 'M1234'), /runs the macro `sys\/M1234\.g`/);
    });
  });
  guard('TC-PRM-02', 'M98 does not pass its P; G29 S… and built-in commands run no macro', () => {
    onCard({
      'sys/config.g': src('M98 P"setup.g" S1', 'G29 S1 R"x"', 'M104 S"x"'),
      'sys/setup.g': 'echo param.P ^ ""',
      'sys/mesh.g': 'echo param.R * 2',
      'sys/M104.g': 'echo param.S * 2',
    }, card => {
      assert.deepEqual(card.diags('sys/setup.g'), []);
      assert.deepEqual(card.diags('sys/mesh.g'), []);
      assert.deepEqual(card.diags('sys/M104.g'), []);
      assert.equal(card.type('sys/M104.g', 0, 'param.S'), 'unknown');
    });
  });
  rule('TC-PRM-02', 'hover lists the calls', () => {
    onCard({
      'sys/config.g': src('M98 P"setup.g" S5', 'M98 P"setup.g"'),
      'sys/setup.g': 'echo param.S',
    }, card => {
      const h = card.hover('sys/setup.g', 0, 'param.S');
      assert.match(h, /Type: `int`/);
      assert.match(h, /`sys\/config\.g` line 1/);
      assert.match(h, /1 other call does not pass S/);
    });
  });
});

describe('TC-PRM-01 / TC-PRM-03: files nobody calls, letters nobody passes', () => {
  rule('TC-PRM-01', 'a file no file in the workspace runs has unknown parameters', () => {
    onCard({ 'macros/Button': 'echo param.S * 2' }, card => {
      assert.equal(card.type('macros/Button', 0, 'param.S'), 'unknown');
      assert.match(card.hover('macros/Button', 0, 'param.S'), /No file in the workspace runs this one/);
    });
  });
  guard('TC-PRM-03', 'a letter none of the calls passes has no value to check', () => {
    onCard({
      'sys/config.g': 'M98 P"setup.g" S1',
      'sys/setup.g': src('if exists(param.Q)', '  echo param.Q * 2', 'var q = param.Q', 'echo var.q + "a"'),
    }, card => {
      assert.deepEqual(card.diags('sys/setup.g'), []);
      assert.match(card.hover('sys/setup.g', 1, 'param.Q'), /None of the 1 call of this file passes Q/);
    });
  });
});

describe('TC-PRM-04: macros the firmware runs', () => {
  rule('TC-PRM-04', 'event macros get D, B and P as integers and S as text', () => {
    onCard({ 'sys/heater-fault.g': src('echo param.D, param.B, param.P, param.S', 'echo param.S * 2') }, card => {
      assert.equal(card.type('sys/heater-fault.g', 0, 'param.D'), 'int');
      assert.equal(card.type('sys/heater-fault.g', 0, 'param.S'), 'string');
      assert.equal(card.diags('sys/heater-fault.g').length, 1);
      assert.match(card.hover('sys/heater-fault.g', 0, 'param.D'), /heater fault event/);
    });
  });
  rule('TC-PRM-04', 'the probe macros get K, the probe number', () => {
    onCard({ 'sys/deployprobe.g': 'echo param.K', 'sys/retractprobe.g': 'echo param.K' }, card => {
      assert.equal(card.type('sys/deployprobe.g', 0, 'param.K'), 'int');
      assert.equal(card.type('sys/retractprobe.g', 0, 'param.K'), 'int');
    });
  });
});

describe('TC-PRM-05: a call of a computed file', () => {
  guard('TC-PRM-05', 'its letters may reach any called file', () => {
    onCard({
      'sys/config.g': src('var f = "setup.g"', 'M98 P"setup.g" S1', 'M98 P{var.f} S"x"'),
      'sys/setup.g': 'echo param.S * 2',
    }, card => {
      assert.deepEqual(card.diags('sys/setup.g'), []);
      assert.equal(card.type('sys/setup.g', 0, 'param.S'), 'int | string');
    });
  });
});

describe('TC-PRM-06: chains, recursion and narrowing', () => {
  rule('TC-PRM-06', 'a parameter passed on to another macro', () => {
    onCard({
      'sys/config.g': 'M98 P"a.g" S5',
      'sys/a.g': 'M98 P"b.g" T{param.S}',
      'sys/b.g': 'echo param.T + "x"',
    }, card => {
      assert.equal(card.type('sys/b.g', 0, 'param.T'), 'int');
      assert.equal(card.diags('sys/b.g').length, 1);
    });
  });
  guard('TC-PRM-06', 'a macro that calls itself', () => {
    onCard({
      'sys/config.g': 'M98 P"loop.g" N0',
      'sys/loop.g': src('if param.N < 3', '  M98 P"loop.g" N{param.N + 1}', 'echo param.N'),
    }, card => {
      assert.equal(card.type('sys/loop.g', 2, 'param.N'), 'int');
      assert.deepEqual(card.diags('sys/loop.g'), []);
    });
  });
  guard('TC-PRM-06', 'a comparison with null narrows a parameter', () => {
    onCard({
      'sys/config.g': src('M98 P"t.g" S{null}', 'M98 P"t.g" S"x"'),
      'sys/t.g': src('if param.S != null', '  echo param.S ^ "!"', 'echo param.S'),
    }, card => {
      assert.equal(card.type('sys/t.g', 1, 'param.S'), 'string');
      assert.equal(card.type('sys/t.g', 2, 'param.S'), 'string | null');
    });
  });
});

describe('TC-PRM-07: calls the server does not see', () => {
  guard('TC-PRM-07', 'a call in a file that is not indexed does not count', () => {
    const sd = makeSd({ 'gcodes/job.gcode': 'M98 P"setup.g" S5', 'sys/setup.g': 'echo param.S' });
    try {
      assert.equal(typeAt('echo param.S', 0, 'param.S', 0, { file: sd.at('sys/setup.g') }), 'unknown');
    } finally {
      sd.cleanup();
    }
  });
});
