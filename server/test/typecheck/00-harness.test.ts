// Live self-tests of the type-check harness: a broken helper would look exactly like an
// unimplemented or broken rule — these make sure it cannot.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import {
  canonType, diffDiagnostics, locate, matchDiagnostics, typeAt, typeOfExpr, typeDiags, lostDiags,
  hoverText, CODE, ALL_CODES, isImplemented, lintTc, Expect,
} from './contract';

const mk = (line: number, s: number, e: number, message: string, code?: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error): Diagnostic =>
  ({ range: { start: { line, character: s }, end: { line, character: e } }, message, code, severity, source: 'rrf-gcode' });

describe('harness: canonType', () => {
  const rows: Array<[string, string]> = [
    ['int', 'int'],
    ['string | int', 'int | string'],
    ['int|string', 'int | string'],
    ['number', 'int | uint | float'],
    ['float | number', 'int | uint | float'],
    ['array', 'array<unknown>'],
    ['array<unknown>', 'array<unknown>'],
    ['array<string | int>', 'array<int | string>'],
    ['array<array<number>>', 'array<array<int | uint | float>>'],
    ['int | unknown', 'unknown'],
    ['null | bool', 'bool | null'],
    ['object | array<int> | int', 'int | array<int> | object'],
  ];
  for (const [inp, want] of rows) it(`${inp} -> ${want}`, () => assert.equal(canonType(inp), want));
  it('rejects unknown names and malformed input', () => {
    assert.throws(() => canonType('integer'));
    assert.throws(() => canonType('array<int'));
    assert.throws(() => canonType('int string'));
  });
});

describe('harness: diffDiagnostics is a multiset difference', () => {
  const a = mk(0, 0, 1, 'x'), b = mk(0, 0, 1, 'y');
  it('removes matched entries once', () => {
    assert.equal(diffDiagnostics([a, a, b], [a]).length, 2);
    assert.equal(diffDiagnostics([a], [a, a]).length, 0);
  });
  it('any field difference counts', () => {
    assert.equal(diffDiagnostics([mk(0, 0, 2, 'x')], [a]).length, 1);
    assert.equal(diffDiagnostics([mk(0, 0, 1, 'x', 'c')], [a]).length, 1);
    assert.equal(diffDiagnostics([mk(0, 0, 1, 'x', undefined, DiagnosticSeverity.Warning)], [a]).length, 1);
  });
});

describe('harness: locate', () => {
  const text = 'echo 1 + 1\necho "a" + 1 + "a" + 1';
  it('first match in document order', () => assert.deepEqual(locate(text, '1'), { line: 0, start: 5, end: 6 }));
  it('restricted to a line', () => assert.deepEqual(locate(text, '"a"', 1), { line: 1, start: 5, end: 8 }));
  it('n-th occurrence', () => assert.deepEqual(locate(text, '"a" + 1', 1, 1), { line: 1, start: 15, end: 22 }));
  it('missing needle throws', () => assert.throws(() => locate(text, 'zzz')));
});

describe('harness: matchDiagnostics', () => {
  const text = 'echo "a" + 1';
  const good = mk(0, 5, 12, 'cannot apply \'+\' to string and int — RepRapFirmware: "expected numeric operands"', CODE.operand);
  const exp: Expect[] = [{ code: CODE.operand, at: '"a" + 1', firmware: 'expected numeric operands', mentions: ['string', 'int'] }];
  it('accepts an exact match', () => assert.deepEqual(matchDiagnostics(text, [good], [...exp]), []));
  it('rejects a wrong range', () => assert.equal(matchDiagnostics(text, [mk(0, 5, 8, good.message, CODE.operand)], [...exp]).length, 2));
  it('rejects a wrong code', () => assert.equal(matchDiagnostics(text, [{ ...good, code: CODE.boolean }], [...exp]).length, 2));
  it('rejects a wrong severity', () => assert.equal(matchDiagnostics(text, [{ ...good, severity: DiagnosticSeverity.Warning }], [...exp]).length, 1));
  it('firmware text must be quoted and exact', () => {
    const singular = { ...good, message: '"expected numeric operand" (string, int)' };
    assert.equal(matchDiagnostics(text, [singular], [...exp]).length, 1);
  });
  it('mentions are whole words', () => {
    const noInt = { ...good, message: '"expected numeric operands": string and integer' };
    assert.equal(matchDiagnostics(text, [noInt], [...exp]).length, 1);
  });
  it('extra and missing diagnostics are both reported', () => {
    assert.equal(matchDiagnostics(text, [good, good], [...exp]).length, 1);
    assert.equal(matchDiagnostics(text, [], [...exp]).length, 1);
  });
  it('works on a real diagnostic produced by the pipeline (line too long)', () => {
    const long = 'M117 ' + 'x'.repeat(300);
    const ds = lintTc(long, {}, false).filter(d => d.code === 'rrf-line-too-long');
    const problems = matchDiagnostics(long, ds, [{ code: 'rrf-line-too-long' as any, at: { line: 0, start: 255, end: 305 }, firmware: /GCode command too long/ }]);
    assert.deepEqual(problems, []);
  });
});

describe('harness: typeAt reads hover', () => {
  it('a case hover already gets right: var a = 1 -> int', () => {
    assert.equal(typeAt('var a = 1\necho var.a', 1, 'var.a'), 'int');
  });
  it('string and float declarations', () => {
    assert.equal(typeAt('var a = "s"\necho var.a', 1, 'var.a'), 'string');
    assert.equal(typeOfExpr('1.5'), 'float');
  });
  it('hover exists for the declaration name too', () => {
    assert.match(hoverText('var abc = 1', 0, 'abc') ?? '', /Type: `int`/);
  });
  it('undeclared variable has no Type field -> null', () => {
    assert.equal(typeAt('echo var.nope', 0, 'var.nope'), null);
  });
  it('locating a needle that is not on the line throws (a harness error, not a todo)', () => {
    assert.throws(() => typeAt('var a = 1\necho 1', 1, 'var.a'));
  });
});

describe('harness: baseline', () => {
  it('everything the checker adds carries a type-check code', () => {
    for (const t of ['echo "a" + 1', 'if 1\n  echo 1', 'echo abs("x")', 'var a = 1\necho var.a[0]', 'echo 1 +', 'G1 X10 X20']) {
      assert.deepEqual(typeDiags(t).filter(d => !ALL_CODES.has(String(d.code))).map(d => d.message), [], t);
    }
  });
  it('the checker removes nothing', () => {
    for (const t of ['echo 1 +', 'G1 X10 X20', 'echo var.nope', 'M117 ' + 'x'.repeat(300)]) {
      assert.deepEqual(lostDiags(t), [], t);
    }
  });
  it('gating prefixes', () => {
    assert.equal(isImplemented(['TC', 'NEVER', '99'].join('-')), false);
  });
});
