// Self-tests for the reference model: if these fail the specs below are meaningless.
// Every expectation is a hand-derived fact from ExpressionParser.cpp.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { binary, unary, ALL_TYPES, BINARY_OPS, Ty, Result } from './model';

const T = (r: Result) => ('ok' in r ? r.ok : 'ERR');

describe('oracle: arithmetic', () => {
  const rows: Array<[string, Ty, Ty, string]> = [
    ['+', 'int', 'int', 'int'], ['+', 'int', 'float', 'float'], ['+', 'float', 'int', 'float'], ['+', 'float', 'float', 'float'],
    ['+', 'string', 'string', 'ERR'], ['+', 'int', 'string', 'ERR'], ['+', 'bool', 'bool', 'ERR'], ['+', 'int', 'bool', 'ERR'],
    ['+', 'null', 'int', 'ERR'], ['+', 'array', 'int', 'ERR'], ['+', 'char', 'int', 'ERR'],
    ['+', 'datetime', 'int', 'datetime'], ['+', 'datetime', 'float', 'ERR'], ['+', 'datetime', 'datetime', 'ERR'], ['+', 'int', 'datetime', 'ERR'],
    ['-', 'datetime', 'datetime', 'int'], ['-', 'datetime', 'int', 'datetime'],
    ['*', 'int', 'int', 'int'], ['*', 'int', 'float', 'float'], ['*', 'string', 'int', 'ERR'],
    ['/', 'int', 'int', 'float'], ['/', 'float', 'int', 'float'], ['/', 'string', 'int', 'ERR'], ['/', 'bool', 'bool', 'ERR'],
  ];
  for (const [op, a, b, want] of rows) it(`${a} ${op} ${b} -> ${want}`, () => assert.equal(T(binary(op, a, b)), want));
});

describe('oracle: concatenation accepts everything', () => {
  for (const a of ALL_TYPES) for (const b of ALL_TYPES) {
    it(`${a} ^ ${b} -> string`, () => assert.equal(T(binary('^', a, b)), 'string'));
  }
});

describe('oracle: logic needs booleans, not truthy integers', () => {
  for (const op of ['&&', '||']) {
    it(`bool ${op} bool`, () => assert.equal(T(binary(op, 'bool', 'bool')), 'bool'));
    for (const t of ALL_TYPES.filter(x => x !== 'bool')) {
      it(`${t} ${op} bool is an error`, () => assert.equal(T(binary(op, t, 'bool')), 'ERR'));
      it(`bool ${op} ${t} is an error`, () => assert.equal(T(binary(op, 'bool', t)), 'ERR'));
    }
  }
});

describe('oracle: comparison', () => {
  const rows: Array<[string, Ty, Ty, string]> = [
    ['<', 'int', 'int', 'bool'], ['<', 'int', 'float', 'bool'], ['<', 'bool', 'bool', 'bool'], ['<', 'datetime', 'datetime', 'bool'],
    ['<', 'string', 'string', 'ERR'], ['<', 'char', 'char', 'ERR'], ['<', 'int', 'string', 'ERR'], ['<', 'int', 'bool', 'ERR'],
    ['<', 'null', 'null', 'ERR'], ['<', 'array', 'array', 'ERR'], ['<', 'null', 'int', 'ERR'],
    ['==', 'int', 'int', 'bool'], ['==', 'int', 'float', 'bool'], ['==', 'string', 'string', 'bool'], ['==', 'bool', 'bool', 'bool'],
    ['==', 'int', 'string', 'ERR'], ['==', 'int', 'bool', 'ERR'], ['==', 'string', 'char', 'bool'], ['==', 'char', 'char', 'ERR'],
    ['==', 'array', 'array', 'ERR'], ['==', 'null', 'null', 'bool'], ['==', 'int', 'null', 'bool'], ['==', 'null', 'string', 'bool'],
    ['==', 'datetime', 'datetime', 'bool'], ['==', 'datetime', 'string', 'bool'], ['==', 'datetime', 'int', 'ERR'],
    ['!=', 'int', 'string', 'ERR'], ['!=', 'string', 'string', 'bool'], ['!=', 'array', 'null', 'bool'],
  ];
  for (const [op, a, b, want] of rows) it(`${a} ${op} ${b} -> ${want}`, () => assert.equal(T(binary(op, a, b)), want));

  it('== and != agree on which operand pairs are legal', () => {
    for (const a of ALL_TYPES) for (const b of ALL_TYPES) {
      assert.equal(T(binary('==', a, b)), T(binary('!=', a, b)), `${a} ${b}`);
    }
  });
  it('< and <= agree; > and >= agree', () => {
    for (const a of ALL_TYPES) for (const b of ALL_TYPES) {
      assert.equal(T(binary('<', a, b)), T(binary('<=', a, b)));
      assert.equal(T(binary('>', a, b)), T(binary('>=', a, b)));
    }
  });
});

describe('oracle: unary', () => {
  const rows: Array<[string, Ty, string]> = [
    ['-', 'int', 'int'], ['-', 'float', 'float'], ['-', 'string', 'ERR'], ['-', 'bool', 'ERR'], ['-', 'null', 'ERR'],
    ['+', 'int', 'int'], ['+', 'datetime', 'int'], ['+', 'string', 'ERR'],
    ['!', 'bool', 'bool'], ['!', 'int', 'ERR'], ['!', 'null', 'ERR'], ['!', 'string', 'ERR'],
    ['#', 'string', 'int'], ['#', 'array', 'int'], ['#', 'int', 'ERR'], ['#', 'null', 'ERR'], ['#', 'char', 'ERR'],
  ];
  for (const [op, a, want] of rows) it(`${op}${a} -> ${want}`, () => assert.equal(T(unary(op, a)), want));
});

describe('oracle: completeness', () => {
  it('every operator is defined for every type pair (no exceptions thrown)', () => {
    for (const op of BINARY_OPS) for (const a of ALL_TYPES) for (const b of ALL_TYPES) {
      assert.doesNotThrow(() => binary(op, a, b), `${a} ${op} ${b}`);
    }
  });
});
