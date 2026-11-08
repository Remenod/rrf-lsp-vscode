// Self-tests for the reference model. Every row is a hand-derived fact from ExpressionParser.cpp;
// if one fails, the generated spec tests built on the model are wrong.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  binary, unary, balanceTypes, balanceNumeric, ALL_TYPES, BINARY_OPS, UNARY_OPS, Ty, Result, MSG,
  FN_3_5_4, FUNCTIONS_INTRODUCED, compareVersions, introducedIn,
} from './model';
import { FUNCTION_NAMES } from '../../src/parser/types';

const R = (r: Result) => ('ok' in r ? r.ok : `ERR ${r.err}`);

describe('oracle: BalanceNumericTypes', () => {
  const rows: Array<[Ty, Ty, string]> = [
    ['int', 'int', 'int'], ['int', 'float', 'float'], ['float', 'int', 'float'],
    ['uint', 'int', 'float'], ['int', 'uint', 'float'], ['uint', 'uint', 'float'],
    ['int', 'string', `ERR ${MSG.numericOperands}`], ['string', 'int', `ERR ${MSG.numericOperands}`],
    ['float', 'string', `ERR ${MSG.numericOperand}`], ['string', 'float', `ERR ${MSG.numericOperand}`],
    ['uint', 'string', `ERR ${MSG.numericOperand}`], ['bool', 'bool', `ERR ${MSG.numericOperands}`],
    ['null', 'int', `ERR ${MSG.numericOperands}`], ['object', 'int', `ERR ${MSG.numericOperands}`],
    ['datetime', 'float', `ERR ${MSG.numericOperand}`],
  ];
  for (const [a, b, want] of rows) it(`${a}, ${b} -> ${want}`, () => assert.equal(R(balanceNumeric(a, b)), want));
});

describe('oracle: BalanceTypes', () => {
  const rows: Array<[Ty, Ty, string]> = [
    ['int', 'int', 'int'], ['int', 'float', 'float'], ['uint', 'int', 'float'], ['uint', 'uint', 'float'],
    ['string', 'string', 'string'], ['string', 'char', 'string'], ['char', 'string', 'string'],
    ['datetime', 'string', 'string'], ['char', 'char', 'char'],
    ['int', 'string', `ERR ${MSG.cannotConvert}`], ['int', 'bool', `ERR ${MSG.cannotConvert}`],
    ['uint', 'string', `ERR ${MSG.numericOperand}`], ['bool', 'float', `ERR ${MSG.numericOperand}`],
    ['object', 'int', `ERR ${MSG.cannotConvert}`], ['object', 'float', `ERR ${MSG.numericOperand}`],
    ['array', 'int', `ERR ${MSG.cannotConvert}`], ['datetime', 'int', `ERR ${MSG.cannotConvert}`],
  ];
  for (const [a, b, want] of rows) {
    it(`${a}, ${b} -> ${want}`, () => {
      const r = balanceTypes(a, b);
      assert.equal('err' in r ? `ERR ${r.err}` : r.common, want);
    });
  }
});

describe('oracle: operators', () => {
  const rows: Array<[typeof BINARY_OPS[number], Ty, Ty, string]> = [
    ['+', 'datetime', 'int', 'datetime'], ['+', 'datetime', 'uint', 'datetime'],
    ['+', 'datetime', 'float', `ERR ${MSG.invalidOperandTypes}`], ['+', 'datetime', 'datetime', `ERR ${MSG.invalidOperandTypes}`],
    ['+', 'int', 'datetime', `ERR ${MSG.numericOperands}`], ['-', 'datetime', 'datetime', 'int'],
    ['-', 'datetime', 'int', 'datetime'], ['*', 'datetime', 'int', `ERR ${MSG.numericOperands}`],
    ['/', 'int', 'int', 'float'], ['/', 'uint', 'int', 'float'], ['/', 'string', 'int', `ERR ${MSG.numericOperand}`],
    ['^', 'array', 'object', 'string'], ['^', 'null', 'null', 'string'],
    ['&&', 'bool', 'bool', 'bool'], ['&&', 'int', 'bool', `ERR ${MSG.boolean}`], ['||', 'bool', 'null', `ERR ${MSG.boolean}`],
    ['<', 'bool', 'bool', 'bool'], ['<', 'string', 'string', `ERR ${MSG.comparison}`], ['<', 'char', 'char', `ERR ${MSG.comparison}`],
    ['<', 'null', 'null', `ERR ${MSG.comparison}`], ['<', 'object', 'object', `ERR ${MSG.comparison}`],
    ['<', 'datetime', 'string', `ERR ${MSG.comparison}`], ['<', 'uint', 'int', 'bool'],
    ['==', 'uint', 'string', `ERR ${MSG.numericOperand}`], ['==', 'bool', 'float', `ERR ${MSG.numericOperand}`],
    ['==', 'bool', 'int', `ERR ${MSG.cannotConvert}`], ['==', 'object', 'object', `ERR ${MSG.compareObjects}`],
    ['==', 'object', 'int', `ERR ${MSG.cannotConvert}`], ['==', 'object', 'null', 'bool'],
    ['==', 'char', 'char', `ERR ${MSG.equality}`], ['==', 'array', 'array', `ERR ${MSG.equality}`],
    ['==', 'string', 'char', 'bool'], ['==', 'datetime', 'string', 'bool'], ['==', 'datetime', 'datetime', 'bool'],
    ['==', 'null', 'array', 'bool'], ['!=', 'string', 'int', `ERR ${MSG.cannotConvert}`],
  ];
  for (const [op, a, b, want] of rows) it(`${a} ${op} ${b} -> ${want}`, () => assert.equal(R(binary(op, a, b)), want));

  it('== and != agree everywhere; < agrees with <=, > with >=', () => {
    for (const a of ALL_TYPES) for (const b of ALL_TYPES) {
      assert.equal(R(binary('==', a, b)), R(binary('!=', a, b)));
      assert.equal(R(binary('<', a, b)), R(binary('<=', a, b)));
      assert.equal(R(binary('>', a, b)), R(binary('>=', a, b)));
    }
  });
  it('^ never fails', () => {
    for (const a of ALL_TYPES) for (const b of ALL_TYPES) assert.equal(R(binary('^', a, b)), 'string');
  });
  it('every operator is total over the type set', () => {
    for (const op of BINARY_OPS) for (const a of ALL_TYPES) for (const b of ALL_TYPES) assert.doesNotThrow(() => binary(op, a, b));
    for (const op of UNARY_OPS) for (const a of ALL_TYPES) assert.doesNotThrow(() => unary(op, a));
  });
});

describe('oracle: unary', () => {
  const rows: Array<[typeof UNARY_OPS[number], Ty, string]> = [
    ['-', 'int', 'int'], ['-', 'float', 'float'], ['-', 'uint', `ERR ${MSG.unaryMinus}`], ['-', 'datetime', `ERR ${MSG.unaryMinus}`],
    ['+', 'uint', 'int'], ['+', 'datetime', 'int'], ['+', 'bool', `ERR ${MSG.unaryPlus}`],
    ['!', 'bool', 'bool'], ['!', 'int', `ERR ${MSG.boolean}`],
    ['#', 'string', 'int'], ['#', 'array', 'int'], ['#', 'char', `ERR ${MSG.length}`], ['#', 'object', `ERR ${MSG.length}`],
  ];
  for (const [op, a, want] of rows) it(`${op}${a} -> ${want}`, () => assert.equal(R(unary(op, a)), want));
});

describe('oracle: functions', () => {
  it('abs rejects uint, sin accepts it', () => {
    assert.equal(FN_3_5_4.abs.args[0].check('uint'), MSG.numericOperand);
    assert.equal(FN_3_5_4.sin.args[0].check('uint'), null);
  });
  it('fileread offset rejects uint (Int32 check), vector size rejects uint and float', () => {
    assert.equal(FN_3_5_4.fileread.args[1].check('uint'), MSG.nonNegativeInt);
    assert.equal(FN_3_5_4.vector.args[0].check('uint'), MSG.nonNegativeInt);
    assert.equal(FN_3_5_4.vector.args[0].check('float'), MSG.nonNegativeInt);
  });
  it('datetime accepts int, uint, datetime, string only', () => {
    const okTypes = ['int', 'uint', 'datetime', 'string'];
    for (const t of ALL_TYPES) assert.equal(FN_3_5_4.datetime.args[0].check(t) === null, okTypes.includes(t), t);
  });
});

describe('oracle: versions', () => {
  it('ordering per TC-CFG-03', () => {
    const order = ['3.3', '3.4.0', '3.5.0', '3.5.4', '3.6.0-alpha.2', '3.6.0-beta.4', '3.6.0-rc.2', '3.6.0-rc.3', '3.6.0', '3.6.1', '3.7'];
    for (let i = 1; i < order.length; i++) assert.ok(compareVersions(order[i - 1], order[i]) < 0, `${order[i - 1]} < ${order[i]}`);
    assert.equal(compareVersions('3.5', '3.5.0'), 0);
    assert.equal(compareVersions('3.5.4-vm.1', '3.5.4'), 0, 'unknown suffixes are ignored');
  });
  it('the version table covers exactly the functions the server knows', () => {
    const tabled = FUNCTIONS_INTRODUCED.flatMap(i => i.names).sort();
    assert.deepEqual(tabled, [...FUNCTION_NAMES].sort());
  });
  it('the 3.5.4 typing table covers exactly the functions available in 3.5.4 except exists', () => {
    const avail = FUNCTIONS_INTRODUCED.filter(i => compareVersions(i.version, '3.5.4') <= 0).flatMap(i => i.names).filter(f => f !== 'exists').sort();
    assert.deepEqual(Object.keys(FN_3_5_4).sort(), avail);
  });
  it('spot checks', () => {
    assert.equal(introducedIn('datetime'), '3.4.0');
    assert.equal(introducedIn('vector'), '3.5.0');
    assert.equal(introducedIn('round'), '3.6.0-rc.3');
  });
});
