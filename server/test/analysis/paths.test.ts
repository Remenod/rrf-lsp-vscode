// File-path validation against a throw-away SD card.
// Covers every registered command/parameter, default folders, tail paths, functions,
// dynamic bypass, ignore globs and the master switches.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lint, makeSd, msgs, has, warningsOf, SdTree } from '../helpers/harness';
import { PATH_NOT_FOUND_CODE, resolveRrfPathToDisk } from '../../src/analysis/argValidators';
import * as path from 'path';

let sd: SdTree;
let file: string;

before(() => {
  sd = makeSd({
    'sys/config.g': '',
    'sys/homeall.g': '',
    'sys/probe.g': '',
    'sys/heightmap.csv': '',
    'sys/accelerometer/': '',
    'sys/lib/a.g': '',
    'macros/Tool.g': '',
    'macros/sub/inner.g': '',
    'gcodes/test.gcode': '',
    'gcodes/dir/': '',
    'www/index.html': '',
    'firmware/Duet3Firmware_MB6HC.bin': '',
    'data.csv': '',
    'mesh/': '',
  });
  file = sd.at('macros/under-test.g');
});
after(() => sd.cleanup());

const L = (text: string, extra = {}) => lint(text, { file, ...extra });
const notFound = (ds: ReturnType<typeof L>) => ds.filter(d => d.code === PATH_NOT_FOUND_CODE);

type Row = [cmd: string, existing: string, missing: string];

describe('paths: parameter-based commands — existing passes, missing warns', () => {
  const rows: Row[] = [
    ['M98 P', 'M98 P"homeall.g"', 'M98 P"nope.g"'],
    ['M98 P (volume)', 'M98 P"0:/sys/homeall.g"', 'M98 P"0:/sys/nope.g"'],
    ['M98 P (leading slash)', 'M98 P"/sys/homeall.g"', 'M98 P"/sys/nope.g"'],
    ['M98 P (macros)', 'M98 P"/macros/Tool.g"', 'M98 P"/macros/Missing.g"'],
    ['M36.2 P', 'M36.2 P"heightmap.csv"', 'M36.2 P"nope.csv"'],
    ['M375 P', 'M375 P"heightmap.csv"', 'M375 P"nope.csv"'],
    ['M20 P', 'M20 P"0:/gcodes"', 'M20 P"0:/nodir"'],
    ['M36.1 P', 'M36.1 P"test.gcode"', 'M36.1 P"nope.gcode"'],
    ['M37 P', 'M37 P"test.gcode"', 'M37 P"nope.gcode"'],
    ['M471 S', 'M471 S"data.csv" T"moved.csv"', 'M471 S"nope.csv" T"moved.csv"'],
    ['M472 P', 'M472 P"data.csv"', 'M472 P"nope.csv"'],
    ['M505 P', 'M505 P"lib"', 'M505 P"nodir"'],
    ['M505.1 P', 'M505.1 P"/www"', 'M505.1 P"/nodir"'],
    ['M997 P', 'M997 P"Duet3Firmware_MB6HC.bin"', 'M997 P"missing.bin"'],
    ['G29 P (load)', 'G29 S1 P"heightmap.csv"', 'G29 S1 P"nope.csv"'],
  ];
  for (const [name, ok, bad] of rows) {
    it(`${name}: existing target is silent`, () => {
      assert.deepEqual(msgs(notFound(L(ok))), [], ok);
    });
    it(`${name}: missing target warns`, () => {
      const ds = notFound(L(bad));
      assert.equal(ds.length, 1, `${bad} -> ${JSON.stringify(msgs(ds))}`);
      assert.equal(ds[0].severity, 2);
    });
  }
});

describe('paths: parent-exists commands (create / save / log)', () => {
  const rows: Array<[string, string, string]> = [
    ['M374 P', 'M374 P"newmap.csv"', 'M374 P"nodir/newmap.csv"'],
    ['M470 P', 'M470 P"mesh/newdir"', 'M470 P"nodir/newdir"'],
    ['M471 T', 'M471 S"data.csv" T"mesh/moved.csv"', 'M471 S"data.csv" T"nodir/moved.csv"'],
    ['M929 P', 'M929 P"mesh/log.txt"', 'M929 P"nodir/log.txt"'],
    ['M956 F', 'M956 F"out.csv"', 'M956 F"nodir/out.csv"'],
    ['G29 S3 P', 'G29 S3 P"new.csv"', 'G29 S3 P"nodir/new.csv"'],
  ];
  for (const [name, ok, bad] of rows) {
    it(`${name}: target need not exist when parent does`, () => {
      assert.deepEqual(msgs(notFound(L(ok))), [], ok);
    });
    it(`${name}: missing parent warns`, () => {
      const ds = notFound(L(bad));
      assert.equal(ds.length, 1, `${bad} -> ${JSON.stringify(msgs(ds))}`);
      assert.match(ds[0].message, /Parent directory not found/);
    });
  }

  it('M470 bare name creates under the SD root, whose parent always exists', () => {
    assert.deepEqual(msgs(notFound(L('M470 P"freshdir"'))), []);
  });
});

describe('paths: legacy tail-path commands', () => {
  const rows: Array<[string, string, string]> = [
    ['M23', 'M23 test.gcode', 'M23 nope.gcode'],
    ['M23 quoted', 'M23 "test.gcode"', 'M23 "nope.gcode"'],
    ['M30', 'M30 test.gcode', 'M30 nope.gcode'],
    ['M32', 'M32 test.gcode', 'M32 nope.gcode'],
    ['M36', 'M36 test.gcode', 'M36 nope.gcode'],
    ['M38', 'M38 test.gcode', 'M38 nope.gcode'],
  ];
  for (const [name, ok, bad] of rows) {
    it(`${name}: existing silent`, () => assert.deepEqual(msgs(notFound(L(ok))), [], ok));
    it(`${name}: missing warns`, () => assert.equal(notFound(L(bad)).length, 1, bad));
  }

  it('M28 validates the parent (/gcodes) of the file it will create', () => {
    assert.deepEqual(msgs(notFound(L('M28 generated.g'))), []);
    assert.equal(notFound(L('M28 nodir/generated.g')).length, 1);
  });

  it('bare names resolve under /gcodes, not the SD root', () => {
    assert.deepEqual(msgs(notFound(L('M32 test.gcode'))), []);
    assert.equal(notFound(L('M32 data.csv')).length, 1, 'data.csv lives at the root, not in /gcodes');
  });
});

describe('paths: default folders for bare relative names', () => {
  it('M98 -> /sys', () => {
    assert.deepEqual(msgs(notFound(L('M98 P"homeall.g"'))), []);
    assert.equal(notFound(L('M98 P"Tool.g"')).length, 1, 'macros/Tool.g is not under /sys');
  });
  it('M20 root of /gcodes via 0:/', () => {
    assert.deepEqual(msgs(notFound(L('M20 P"0:/gcodes/dir"'))), []);
  });
  it('M997 -> /firmware', () => {
    assert.deepEqual(msgs(notFound(L('M997 P"Duet3Firmware_MB6HC.bin"'))), []);
  });
  it('M956 -> /sys/accelerometer (parent exists)', () => {
    assert.deepEqual(msgs(notFound(L('M956 F"log.csv"'))), []);
  });
  it('M472 -> SD root', () => {
    assert.deepEqual(msgs(notFound(L('M472 P"data.csv"'))), []);
    assert.equal(notFound(L('M472 P"homeall.g"')).length, 1);
  });
});

describe('paths: a sys/ prefix is not special for M98', () => {
  it('M98 P"sys/homeall.g" resolves to /sys/sys/homeall.g, exactly as the firmware does', () => {
    const ds = notFound(L('M98 P"sys/homeall.g"'));
    assert.equal(ds.length, 1);
    assert.match(ds[0].message, /expected at 'sys\/sys\/homeall\.g'/);
  });
});

describe('paths: functions', () => {
  it('fileexists is never flagged, even when the target is missing', () => {
    assert.deepEqual(msgs(notFound(L('if fileexists("nope.g")\n  echo 1'))), []);
    assert.deepEqual(msgs(notFound(L('echo fileexists("sys/nope.g")'))), []);
  });
  it('fileexists resolves bare names under /sys (verified through go-to-def separately)', () => {
    assert.deepEqual(msgs(notFound(L('echo fileexists("probe.g")'))), []);
  });
  it('fileread is flagged when missing', () => {
    assert.equal(notFound(L("echo fileread(\"nope.csv\", 0, 10, ',')")).length, 1);
  });
  it('fileread resolves under the SD root', () => {
    assert.deepEqual(msgs(notFound(L("echo fileread(\"data.csv\", 0, 10, ',')"))), []);
  });
  it('fileread inside a G-code brace block is validated too', () => {
    assert.equal(notFound(L("M291 P{fileread(\"nope.csv\", 0, 1, ',')}")).length, 1);
  });
  it('dynamic first argument is skipped', () => {
    assert.deepEqual(msgs(notFound(L('var f = "x"\necho fileread(var.f, 0, 1, \',\')'))), []);
    assert.deepEqual(msgs(notFound(L("echo fileread(\"a\" ^ \"b\", 0, 1, ',')"))), []);
  });
});

describe('paths: dynamic values are never checked', () => {
  const dyn = [
    'M98 P{var.p}',
    'M98 P{"sys/" ^ "nope.g"}',
    'M472 P{global.p}',
    'M98 P{"nope.g"}',
  ];
  for (const d of dyn) {
    it(d, () => {
      const text = d.includes('var.p') ? `var p = "x"\n${d}` : d;
      assert.deepEqual(msgs(notFound(L(text))), []);
    });
  }
});

describe('paths: strings that are not paths are left alone', () => {
  const quiet = [
    'M291 P"Printer is ready" S1',
    'M117 "sys/nope.g"',
    'M550 P"my printer"',
    'M587 S"ssid" P"password/with/slash"',
    'echo "sys/nope.g"',
    'M118 S"sys/nope.g"',
  ];
  for (const q of quiet) it(q, () => assert.deepEqual(msgs(notFound(L(q))), []));
});

describe('paths: resolver rejects unsafe forms', () => {
  const cases: Array<[string, string]> = [
    ['URL', 'http://example.com/a.g'],
    ['backslash', 'sys\\a.g'],
    ['null byte', 'sys/a\u0000.g'],
    ['escape root', '../../etc/passwd'],
    ['escape via sys', 'sys/../../x'],
  ];
  for (const [name, p] of cases) {
    it(name, () => assert.equal(resolveRrfPathToDisk(p, sd.root), null));
  }
  it('0:/sys/config.g, /sys/config.g, sys/config.g all land on the same file', () => {
    const want = path.join(sd.root, 'sys', 'config.g');
    assert.equal(resolveRrfPathToDisk('0:/sys/config.g', sd.root), want);
    assert.equal(resolveRrfPathToDisk('/sys/config.g', sd.root), want);
    assert.equal(resolveRrfPathToDisk('sys/config.g', sd.root), want);
  });
  it('relative-dir option applies only to bare names', () => {
    assert.equal(resolveRrfPathToDisk('a.g', sd.root, { defaultRelativeDir: 'sys' }), path.join(sd.root, 'sys', 'a.g'));
    assert.equal(resolveRrfPathToDisk('/a.g', sd.root, { defaultRelativeDir: 'sys' }), path.join(sd.root, 'a.g'));
  });
});

describe('paths: case-insensitive FAT semantics', () => {
  it('differing case still resolves to an existing file', () => {
    assert.deepEqual(msgs(notFound(L('M98 P"HOMEALL.G"'))), []);
    assert.deepEqual(msgs(notFound(L('M98 P"/Sys/HomeAll.g"'))), []);
  });
});

describe('paths: settings', () => {
  const missing = 'M98 P"nope.g"';
  it('argCheck.enabled=false silences everything', () => {
    assert.deepEqual(msgs(notFound(L(missing, { argCheck: { enabled: false } }))), []);
  });
  it('argCheck.paths.enabled=false silences path warnings', () => {
    assert.deepEqual(msgs(notFound(L(missing, { argCheck: { paths: { enabled: false } } }))), []);
  });
  it('function path checks respect paths.enabled', () => {
    const t = "echo fileread(\"nope.csv\", 0, 1, ',')";
    assert.deepEqual(msgs(notFound(L(t, { argCheck: { paths: { enabled: false } } }))), []);
  });

  const ignore: Array<[string, string, boolean]> = [
    ['exact file', 'sys/nope.g', true],
    ['exact file, other file still warns', 'sys/other.g', false],
    ['subtree', 'sys/**', true],
    ['subtree is directory-scoped', 'macros/**', false],
    ['direct children', 'sys/*.g', true],
    ['direct children only (not nested)', 'sys/*/*.g', false],
    ['alternation', '{sys,macros}/nope.g', true],
    ['alternation miss', '{macros,gcodes}/nope.g', false],
    ['question mark', 'sys/no?e.g', true],
    ['char class', 'sys/nop[a-f].g', true],
    ['char class miss', 'sys/nop[x-z].g', false],
    ['double star prefix', '**/nope.g', true],
  ];
  for (const [name, pattern, shouldIgnore] of ignore) {
    it(`ignore ${name}: ${pattern}`, () => {
      const ds = notFound(L(missing, { argCheck: { paths: { ignore: [pattern] } } }));
      assert.equal(ds.length, shouldIgnore ? 0 : 1);
    });
  }

  it('ignore applies to the user-written target for create commands', () => {
    const ds = notFound(L('M374 P"nodir/x.csv"', { argCheck: { paths: { ignore: ['sys/nodir/x.csv'] } } }));
    assert.equal(ds.length, 0);
  });
});

describe('paths: diagnostic payload', () => {
  it('carries relative/absolute/sdRoot for quick fixes', () => {
    const [d] = notFound(L('M98 P"nope.g"'));
    const data = (d as any).data;
    assert.equal(data.relative, 'sys/nope.g');
    assert.equal(data.sdRoot, sd.root);
    assert.equal(data.absolute, path.join(sd.root, 'sys', 'nope.g'));
  });

  it('range covers exactly the string contents', () => {
    const text = 'M98 P"nope.g"';
    const [d] = notFound(L(text));
    const slice = text.slice(d.range.start.character, d.range.end.character);
    assert.ok(slice === 'nope.g' || slice === '"nope.g"', slice);
  });

  it('no SD root => no path diagnostics at all', () => {
    const ds = lint('M98 P"nope.g"', { file: path.join('/', 'definitely', 'not', 'sd', 'x.g') });
    assert.deepEqual(msgs(ds.filter(d => d.code === PATH_NOT_FOUND_CODE)), []);
  });

  it('warning severity only (never error)', () => {
    assert.ok(warningsOf(L('M98 P"nope.g"')).length >= 1);
    assert.equal(has(L('M98 P"nope.g"'), /not found/), true);
  });
});
