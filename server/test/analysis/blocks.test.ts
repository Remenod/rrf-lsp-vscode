// Block structure from indentation (StringParser): mixed spaces and tabs, block lines with
// nothing under them, and parameter values that the firmware reads differently from how they look.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { lint, src, makeSd } from '../helpers/harness';
import { blockDiagnostics } from '../../src/analysis/blocks';
import { lineIndent } from '../../src/analysis/utils';
import { collectRrfFiles } from '../../src/analysis/rrfFiles';

const MIXED = /both space and tab characters used to indent blocks/;
const EMPTY = /has no indented block/;
const at = (text: string, re: RegExp) => lint(text).filter(d => re.test(d.message)).map(d => d.range.start.line);

describe('indentation is counted as the firmware counts it', () => {
  it('a space adds 1, a tab moves to the next multiple of 4', () => {
    assert.equal(lineIndent('    x'), 4);
    assert.equal(lineIndent('\tx'), 4);
    assert.equal(lineIndent('  \tx'), 4);
    assert.equal(lineIndent('\t  x'), 6);
    assert.equal(lineIndent('\t\tx'), 8);
    assert.equal(lineIndent('x'), 0);
  });
  it('a tab-indented block under a space-indented line is still deeper', () => {
    assert.deepEqual(at(src('if true', '\techo 1'), EMPTY), []);
    assert.deepEqual(at(src('  if true', '\techo 1'), EMPTY), []);
  });
});

describe('mixed spaces and tabs', () => {
  it('warned once, where the firmware warns', () => {
    const t = src('if true', '  echo 1', '\techo 2', '\techo 3', 'if true', '  echo 4', '\techo 5');
    assert.deepEqual(at(t, MIXED), [2]);
    const d = lint(t).find(x => MIXED.test(x.message))!;
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.match(d.message, /"both space and tab characters used to indent blocks at\/before line 3"/);
  });
  it('a space block and a tab block separated by an unindented command are fine', () => {
    assert.deepEqual(at(src('if true', '  echo 1', 'echo 0', 'if true', '\techo 2'), MIXED), []);
  });
  it('both kinds in one line count', () => {
    assert.deepEqual(at(src('if true', '\t  echo 1'), MIXED), [1]);
  });
  it('only spaces or only tabs, or no meta command, are fine', () => {
    assert.deepEqual(at(src('if true', '  echo 1', '  if true', '    echo 2'), MIXED), []);
    assert.deepEqual(at(src('if true', '\techo 1', '\tif true', '\t\techo 2'), MIXED), []);
    assert.deepEqual(blockDiagnostics(['G28', '  G1 X1', '\tG1 Y1']), []);
  });
  it('comment and blank lines are not counted', () => {
    assert.deepEqual(at(src('if true', '  echo 1', '\t; note', '', '  echo 2'), MIXED), []);
  });
});

describe('block lines with nothing indented under them', () => {
  it('if with the next line at the same depth', () => {
    const t = src('if move.axes[2].homed', 'G28 Z');
    assert.deepEqual(at(t, EMPTY), [0]);
    const d = lint(t).find(x => EMPTY.test(x.message))!;
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.deepEqual([d.range.start.character, d.range.end.character], [0, 2]);
  });
  it('nested if that lost its indentation', () => {
    assert.deepEqual(at(src('if true', '    if move.axes[2].homed', '    G28 Z'), EMPTY), [1]);
  });
  it('if, elif and else at the end of a file or before a blank line and a dedent', () => {
    assert.deepEqual(at(src('if true', '  echo 1', 'else'), EMPTY), [2]);
    assert.deepEqual(at(src('if input == 0', '', 'M98 P"x.g"'), EMPTY), [0]);
    assert.deepEqual(at(src('if true', '  echo 1', 'elif false', 'echo 2'), EMPTY), [2]);
  });
  it('while says the loop repeats', () => {
    const d = lint(src('while true', 'echo 1')).find(x => EMPTY.test(x.message))!;
    assert.match(d.message, /'while' has no indented block: the loop does nothing/);
  });
  it('a comment is a body (an intended no-op)', () => {
    assert.deepEqual(at(src('if input == 0', '  ; keep the defaults', 'elif input == 1', '  echo 1'), EMPTY), []);
  });
  it('ordinary blocks are fine', () => {
    assert.deepEqual(at(src('if true', '  echo 1', 'elif false', '  echo 2', 'else', '  echo 3', 'while iterations < 2', '  echo 4'), EMPTY), []);
  });
});

describe('parameter values the firmware reads differently', () => {
  it("X-{…} is an error: the firmware sees '-' and no number", () => {
    for (const t of ['G1 E-{1} F600', 'G1 X+{1}']) {
      const d = lint(t).find(x => /is not a number/.test(x.message));
      assert.ok(d, t);
      assert.equal(d!.severity, DiagnosticSeverity.Error);
      assert.match(d!.message, /"expected number after '[EX]'"/);
    }
  });
  it('signs on numbers and inside braces are fine', () => {
    for (const t of ['G1 X-10 Y+3', 'G1 X{-1} E{-0.5}']) assert.deepEqual(lint(t).map(d => d.message), [], t);
  });
  it("'^' after a quoted value is a warning", () => {
    const d = lint('var f = "x"\nM291 P"Log: " ^ var.f S2').find(x => /not part of it/.test(x.message))!;
    assert.equal(d.severity, DiagnosticSeverity.Warning);
    assert.match(d.message, /write P\{"Log: " \^ …\}/);
  });
  it('a whole expression in braces, and raw-text commands, are fine', () => {
    assert.deepEqual(lint('var f = "x"\nM291 P{"Log: " ^ var.f} S2').map(d => d.message), []);
    assert.deepEqual(lint('M117 "a" ^ b').filter(d => /not part of it/.test(d.message)), []);
  });
});

describe('workspace files', () => {
  it('a macro may have any name, as long as it is G-code', () => {
    const sd = makeSd({
      'macros/Upgrade to 4.0.1': 'M291 P"Updating" S1\nvar a = 1\necho var.a\n',
      'macros/notes.txt': 'shopping list\nmilk\neggs\n',
      'sys/backup.1': 'M291 P"x" S1\nvar a = 1\necho var.a\n',
    });
    try {
      const rel = collectRrfFiles(sd.root).map(f => decodeURIComponent(f.uri).slice(decodeURIComponent(`file://${sd.root}/`).length)).sort();
      assert.ok(rel.includes('macros/Upgrade to 4.0.1'), rel.join(', '));
      assert.ok(!rel.includes('macros/notes.txt'));
      assert.ok(!rel.includes('sys/backup.1'));
    } finally {
      sd.cleanup();
    }
  });
});
