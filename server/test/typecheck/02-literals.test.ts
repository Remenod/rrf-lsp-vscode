// SPEC §3: literals, named constants, braces and parentheses.

import { describe } from 'node:test';
import { rule, guard, typeOfExpr, typeAt, expectType, expectNoTypes } from './contract';
import { src } from '../helpers/harness';

function types(rows: Array<[string, string]>): void {
  for (const [e, t] of rows) expectType(typeOfExpr(e), t, e);
}

describe('TC-LIT-01: numeric literals (NumericConverter::FitsInInt32 / FitsInUint32)', () => {
  rule('TC-LIT-01', 'decimal integers by range', () => types([
    ['0', 'int'], ['7', 'int'], ['2147483647', 'int'],
    ['2147483648', 'uint'], ['3000000000', 'uint'], ['4294967295', 'uint'],
    ['4294967296', 'float'], ['99999999999', 'float'],
  ]));
  rule('TC-LIT-01', 'a decimal point or an exponent always means float', () => types([
    ['1.0', 'float'], ['0.5', 'float'], ['1e3', 'float'], ['1E3', 'float'], ['2.5e-2', 'float'], ['100.000', 'float'],
  ]));
  rule('TC-LIT-01', 'hex and binary follow the same ranges', () => types([
    ['0xFF', 'int'], ['0x7FFFFFFF', 'int'], ['0x80000000', 'uint'], ['0xFFFFFFFF', 'uint'],
    ['0b0', 'int'], ['0b101', 'int'],
  ]));
  rule('TC-LIT-01', 'unary minus keeps int and float', () => types([['-1', 'int'], ['-1.5', 'float'], ['- -2', 'int']]));
  guard('TC-LIT-01', 'no literal on its own is ever a type error', () => {
    for (const l of ['0', '2147483647', '2147483648', '4294967296', '1e3', '0xFFFFFFFF', '0b11', '1.0']) {
      expectNoTypes(`echo ${l}`);
      expectNoTypes(`var t = ${l}`);
    }
  });
});

describe('TC-LIT-02: strings and characters', () => {
  rule('TC-LIT-02', 'string and char literals', () => types([
    ['"s"', 'string'], ['""', 'string'], ['"a""b"', 'string'], ['"\'A"', 'string'], ["'c'", 'char'], ["','", 'char'],
  ]));
});

describe('TC-LIT-03: named constants', () => {
  rule('TC-LIT-03', 'true, false, null, pi, line, result', () => types([
    ['true', 'bool'], ['false', 'bool'], ['null', 'null'], ['pi', 'float'], ['line', 'int'], ['result', 'int'],
  ]));
  rule('TC-LIT-03', 'iterations inside a loop is int', () => {
    expectType(typeAt(src('while iterations < 3', '  var t = iterations', '  echo var.t'), 2, 'var.t'), 'int', 'iterations');
  });
  rule('TC-LIT-03', 'input is unknown (M291 mode decides)', () => types([['input', 'unknown']]));
});

describe('TC-LIT-04: braces and parentheses', () => {
  rule('TC-LIT-04', '{a} is a plain value, not an array', () => types([['{1}', 'int'], ['{"s"}', 'string'], ['{(1.5)}', 'float']]));
  rule('TC-LIT-04', 'a trailing comma makes a one-element array', () => types([['{1,}', 'array<int>'], ['{"s",}', 'array<string>']]));
  rule('TC-LIT-04', 'array literals collect their element types', () => types([
    ['{1, 2}', 'array<int>'],
    ['{1, 2.5}', 'array<int | float>'],
    ['{1, "a"}', 'array<int | string>'],
    ['{true, null}', 'array<bool | null>'],
    ['{{1, 2}, {3,}}', 'array<array<int>>'],
    ['{1, {2,}}', 'array<int | array<int>>'],
    ['{move.axes[0].homed, false}', 'array<bool>'],
  ]));
  rule('TC-LIT-04', 'parentheses are transparent', () => types([['(1)', 'int'], ['((("s")))', 'string'], ['({1, 2})', 'array<int>']]));
  rule('TC-LIT-04', '#{…} needs no parentheses', () => types([['#{1, 2}', 'int']]));
});
