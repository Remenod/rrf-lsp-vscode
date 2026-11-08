// Editor features: hover, rename, references, go-to-definition for paths, path completion, code actions.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'url';
import { CodeActionKind, Diagnostic } from 'vscode-languageserver/node';
import { lex, readData, makeSd, SdTree, lint } from '../helpers/harness';
import { buildHover } from '../../src/analysis/hover';
import { buildRenameEdit } from '../../src/analysis/rename';
import { buildReferences } from '../../src/analysis/references';
import { pathLocationAtCursor } from '../../src/analysis/pathDefinition';
import { buildPathCompletions } from '../../src/analysis/pathCompletion';
import { buildCodeActions, CMD_ADD_PATH_IGNORE, CMD_SET_MAX_LINE_LENGTH, LINE_TOO_LONG_CODE } from '../../src/analysis/codeActions';
import { PATH_NOT_FOUND_CODE } from '../../src/analysis/argValidators';
import { SymbolTable } from '../../src/analysis/symbolTable';

const gcode = readData('gcode-commands.json');
const meta = readData('gcode-meta-commands.json');
const ops = readData('gcode-operators.json');
const fns = readData('gcode-functions.json');
const URI = 'file:///t.g';

function hoverAt(text: string, line: number, ch: number): string | null {
  const st = new SymbolTable();
  st.indexDocument(URI, text);
  const lines = text.split('\n');
  const l = lines[line];
  const indent = l.length - l.trimStart().length;
  const h = buildHover(lex(l, line), ch, line, gcode, meta, ops, fns, st, URI, indent, lines);
  if (!h) return null;
  const c: any = h.contents;
  return typeof c === 'string' ? c : c.value ?? JSON.stringify(c);
}

describe('hover', () => {
  it('G/M code shows title and documentation link', () => {
    const h = hoverAt('M291 S1', 0, 1)!;
    assert.match(h, /M291/);
    assert.match(h, /docs\.duet3d\.com/);
  });
  it('every documented command hovers without throwing', () => {
    for (const code of Object.keys(gcode).filter(k => k !== '_meta').slice(0, 300)) {
      assert.doesNotThrow(() => hoverAt(`${code} S1`, 0, 1), code);
    }
  });
  it('T code hovers with the T entry', () => assert.match(hoverAt('T0', 0, 0)!, /\*\*T\*\*/));
  it('function name', () => assert.match(hoverAt('echo abs(1)', 0, 6)!, /abs/));
  it('meta keyword', () => assert.ok(hoverAt('if true', 0, 0)));
  it('named constant', () => assert.ok(hoverAt('echo true', 0, 6)));
  it('operator', () => assert.ok(hoverAt('echo 1 + 2', 0, 7) !== undefined));
  it('declared var shows scope, inferred type and line', () => {
    const h = hoverAt('var a = 1\necho var.a', 1, 7)!;
    assert.match(h, /Scope: `var`/);
    assert.match(h, /Type: `int`/);
    assert.match(h, /line 1/);
  });
  it('var in a closed block is not resolved to the dead declaration', () => {
    const h = hoverAt('if true\n  var a = 1\necho var.a', 2, 7)!;
    assert.doesNotMatch(h ?? '', /Declared at line 2/);
  });
  it('global declared in the same file', () => assert.match(hoverAt('global g = 1\necho global.g', 1, 8)!, /Scope: `global`/));
  it('object model path', () => assert.ok(hoverAt('echo move.axes[0].homed', 0, 7)));
  it('declaration site of var gives declaration hover', () => assert.match(hoverAt('var abc = 1', 0, 5)!, /var\.abc/));
  it('comments and whitespace have no hover', () => {
    assert.equal(hoverAt('; hello', 0, 3), null);
    assert.equal(hoverAt('G1 X1', 0, 2), null);
  });
  it('cursor past the end of the line is null', () => assert.equal(hoverAt('G1', 0, 50), null));
  it('GCode parameter letters have no hover', () => assert.equal(hoverAt('G1 X10', 0, 3), null));
});

const rename = (text: string, line: number, ch: number, newName: string, docs?: Map<string, string>) =>
  buildRenameEdit({ textDocument: { uri: URI }, position: { line, character: ch }, newName }, text, URI, docs ?? new Map([[URI, text]]));
const refs = (text: string, line: number, ch: number, docs?: Map<string, string>) =>
  buildReferences({ textDocument: { uri: URI }, position: { line, character: ch }, context: { includeDeclaration: true } }, text, URI, docs ?? new Map([[URI, text]]));

describe('rename', () => {
  it('renames declaration and every use of a var', () => {
    const t = 'var a = 1\nset var.a = var.a + 1\necho var.a';
    const e = rename(t, 2, 7, 'b')!;
    const edits = e.changes![URI];
    assert.equal(edits.length, 4);
    // The declaration site holds the bare name; qualified uses are replaced whole.
    assert.deepEqual(edits.map(x => x.newText).sort(), ['b', 'var.b', 'var.b', 'var.b']);
  });
  it('keeps the var. prefix in qualified uses', () => {
    const edits = rename('var a = 1\necho var.a', 1, 7, 'zz')!.changes![URI];
    assert.ok(edits.some(e => e.newText === 'var.zz'));
  });
  it('does not touch a same-named variable in another scope', () => {
    const t = 'if true\n  var a = 1\n  echo var.a\nif true\n  var a = 2\n  echo var.a';
    const edits = rename(t, 2, 9, 'x')!.changes![URI];
    assert.ok(edits.every(e => e.range.start.line <= 2), JSON.stringify(edits.map(e => e.range.start.line)));
  });
  it('does not rename inside strings or comments', () => {
    const t = 'var a = 1\necho "var.a" ; var.a\necho var.a';
    const edits = rename(t, 2, 7, 'q')!.changes![URI];
    assert.ok(edits.every(e => e.range.start.line !== 1));
  });
  it('globals are renamed across files', () => {
    const other = 'urn:other.g';
    const docs = new Map([[URI, 'global g = 1\necho global.g'], [other, 'echo global.g']]);
    const e = rename(docs.get(URI)!, 1, 10, 'h', docs)!;
    assert.ok(e.changes![URI].length >= 2);
    assert.ok(e.changes![other].length >= 1);
  });
  it('not on a variable -> null', () => {
    assert.equal(rename('echo 1', 0, 5, 'x'), null);
    assert.equal(rename('G28', 0, 1, 'x'), null);
  });
});

describe('references', () => {
  it('finds declaration and uses', () => {
    const r = refs('var a = 1\nset var.a = 2\necho var.a', 2, 7);
    assert.equal(r.length, 3);
  });
  it('same name in a sibling scope is excluded', () => {
    const t = 'if true\n  var a = 1\n  echo var.a\nif true\n  var a = 2\n  echo var.a';
    const r = refs(t, 2, 9);
    assert.ok(r.every(l => l.range.start.line <= 2));
  });
  it('global references span files', () => {
    const docs = new Map([[URI, 'global g = 1\necho global.g'], ['urn:b.g', 'echo global.g']]);
    const r = refs(docs.get(URI)!, 1, 10, docs);
    assert.ok(new Set(r.map(l => l.uri)).size === 2);
  });
  it('not a variable -> empty', () => assert.deepEqual(refs('G28', 0, 1), []));
});

describe('go-to-definition for paths and path completion', () => {
  let sd: SdTree;
  let file: string;
  let fileUri: string;
  before(() => {
    sd = makeSd({ 'sys/homeall.g': '', 'sys/probe.g': '', 'macros/Tool.g': '', 'gcodes/a.gcode': '', 'data.csv': '' });
    file = sd.at('macros/x.g');
    fileUri = pathToFileURL(file).toString();
  });
  after(() => sd.cleanup());

  const def = (line: string, ch: number) => pathLocationAtCursor(lex(line), ch, fileUri, line);

  it('M98 P"..." jumps to the macro', () => {
    const loc = def('M98 P"homeall.g"', 8);
    assert.ok(loc);
    assert.match(loc!.uri, /sys\/homeall\.g$/);
  });
  it('fileexists("probe.g") resolves under /sys', () => {
    const loc = def('if fileexists("probe.g")', 18);
    assert.match(loc?.uri ?? '', /sys\/probe\.g$/);
  });
  it('legacy tail path M32 test', () => {
    assert.match(def('M32 a.gcode', 6)?.uri ?? '', /gcodes\/a\.gcode$/);
  });
  it('missing target -> null', () => assert.equal(def('M98 P"nope.g"', 8), null));
  it('ordinary strings are not treated as paths', () => assert.equal(def('M291 P"Printer is ready" S1', 10), null));
  it('strict fallback: a string that looks like and IS a path', () => {
    assert.match(def('echo "sys/homeall.g"', 8)?.uri ?? '', /sys\/homeall\.g$/);
  });
  it('dynamic expressions are not resolved', () => assert.equal(def('M98 P{var.p}', 8), null));

  const names = (items: ReturnType<typeof buildPathCompletions>) => (items ?? []).map(i => i.label).sort();
  it('lists the default directory for M98', () => {
    const items = buildPathCompletions('', fileUri, { defaultRelativeDir: 'sys' });
    assert.ok(names(items).includes('homeall.g'));
    assert.ok(names(items).includes('probe.g'));
  });
  it('lists a typed directory', () => {
    assert.ok(names(buildPathCompletions('/macros/', fileUri)).includes('Tool.g'));
  });
  it('volume prefix is understood', () => {
    assert.ok(names(buildPathCompletions('0:/sys/', fileUri)).includes('homeall.g'));
  });
  it('unknown directory -> no items', () => {
    assert.deepEqual(names(buildPathCompletions('/nodir/', fileUri)), []);
  });
  // BUG: '../' climbs out of the SD root and lists whatever directory is above it (information leak).
  it('escaping the SD root is refused', { todo: 'completion lists directories outside the SD root' }, () => {
    for (const p of ['../', '../../', '/../', '0:/../']) {
      const items = buildPathCompletions(p, fileUri);
      assert.ok(!items || items.length === 0, `'${p}' listed ${items?.length} entries outside the SD card`);
    }
  });
  it('outside an SD tree there is nothing to complete', () => {
    assert.equal(buildPathCompletions('', 'file:///definitely/not/sd/x.g'), null);
  });
});

describe('code actions', () => {
  const mkDiag = (code: string, data: unknown): Diagnostic => ({
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    message: 'x', code, data,
  } as Diagnostic);
  const actions = (d: Diagnostic[]) => buildCodeActions({
    textDocument: { uri: URI }, range: d[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: d },
  });

  it('missing path offers ignore-file and ignore-directory', () => {
    const a = actions([mkDiag(PATH_NOT_FOUND_CODE, { relative: 'sys/x.g', absolute: '/sd/sys/x.g', sdRoot: '/sd' })]);
    assert.equal(a.length, 2);
    assert.ok(a.every(x => x.kind === CodeActionKind.QuickFix));
    assert.deepEqual(a.map(x => x.command?.command), [CMD_ADD_PATH_IGNORE, CMD_ADD_PATH_IGNORE]);
    assert.deepEqual(a.map(x => x.command?.arguments?.[0]).sort(), ['sys/**', 'sys/x.g']);
  });
  it('file at the SD root: no directory action (would silence everything)', () => {
    const a = actions([mkDiag(PATH_NOT_FOUND_CODE, { relative: 'x.g', absolute: '/sd/x.g', sdRoot: '/sd' })]);
    assert.equal(a.length, 1);
  });
  it('line too long offers raise-limit and disable', () => {
    const a = actions([mkDiag(LINE_TOO_LONG_CODE, { length: 300, max: 255 })]);
    assert.ok(a.length >= 2);
    assert.ok(a.every(x => x.command?.command === CMD_SET_MAX_LINE_LENGTH));
    assert.ok(a.some(x => x.command?.arguments?.[0] === 0), 'one action disables the check');
    assert.ok(a.some(x => Number(x.command?.arguments?.[0]) >= 300), 'one action raises the limit to fit');
  });
  it('unrelated diagnostics get no actions', () => {
    assert.deepEqual(actions([mkDiag('other', {})]), []);
    assert.deepEqual(actions([mkDiag(PATH_NOT_FOUND_CODE, undefined)]), []);
    assert.deepEqual(actions([mkDiag(PATH_NOT_FOUND_CODE, { relative: 1 })]), []);
  });
  it('actions line up with a real diagnostic produced by the pipeline', () => {
    const sd2 = makeSd();
    try {
      const ds = lint('M98 P"nope.g"', { file: sd2.at('macros/y.g') }).filter(d => d.code === PATH_NOT_FOUND_CODE);
      assert.ok(actions(ds).length >= 1);
    } finally { sd2.cleanup(); }
  });
});
