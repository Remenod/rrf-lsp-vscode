// Lexer: token classification, literals, meta context, G-code parameter mode.
// Mirrors the scanning rules of ExpressionParser.cpp / StringParser.cpp.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lex, types, shape, lexErrors, readData } from '../helpers/harness';
import { TokenType as T, FUNCTION_NAMES, NAMED_CONSTANTS, META_KEYWORDS } from '../../src/parser/types';

describe('lexer: numeric literals', () => {
  const cases: Array<[string, T, string]> = [
    ['0', T.Integer, '0'],
    ['42', T.Integer, '42'],
    ['007', T.Integer, '007'],
    ['3.14', T.Float, '3.14'],
    ['0.5', T.Float, '0.5'],
    ['1e3', T.Float, '1e3'],
    ['1e-3', T.Float, '1e-3'],
    ['2.5e+2', T.Float, '2.5e+2'],
    ['0xFF', T.HexInteger, '0xFF'],
    ['0xdeadBEEF', T.HexInteger, '0xdeadBEEF'],
    ['0b1010', T.BinInteger, '0b1010'],
    ['0b0', T.BinInteger, '0b0'],
  ];
  for (const [src, type, value] of cases) {
    it(`echo ${src} -> ${T[type]}`, () => {
      const toks = lex(`echo ${src}`);
      assert.equal(toks[0].type, T.Echo);
      assert.equal(toks[1].type, type);
      assert.equal(toks[1].value, value);
    });
  }

  it('records 0-based line and half-open columns', () => {
    const toks = lex('echo 123', 7);
    assert.equal(toks[1].line, 7);
    assert.equal(toks[1].start, 5);
    assert.equal(toks[1].end, 8);
  });
});

describe('lexer: string and char literals', () => {
  it('plain string', () => {
    const [, s] = lex('echo "hello"');
    assert.equal(s.type, T.StringLit);
    assert.equal(s.value, '"hello"');
    assert.equal(s.unclosed, undefined);
  });

  it('empty string', () => {
    const [, s] = lex('echo ""');
    assert.equal(s.type, T.StringLit);
    assert.equal(s.value, '""');
  });

  it('doubled quote is an escape and is recorded as a 2-char span', () => {
    const [, s] = lex('echo "a""b"');
    assert.equal(s.type, T.StringLit);
    assert.equal(s.value, '"a""b"');
    assert.equal(s.escapes?.length, 1);
    assert.equal(s.escapes![0].end - s.escapes![0].start, 2);
  });

  it('two escapes in one literal', () => {
    const [, s] = lex('echo "a""b""c"');
    assert.equal(s.escapes?.length, 2);
  });

  it('semicolon inside a string is not a comment', () => {
    const toks = types('echo "a;b"');
    assert.deepEqual(toks, [T.Echo, T.StringLit]);
  });

  it('unclosed string is flagged', () => {
    const toks = lex('echo "abc');
    const s = toks.find(t => t.type === T.StringLit)!;
    assert.equal(s.unclosed, true);
  });

  it('backslash is NOT an escape character (RRF uses doubled quotes)', () => {
    const [, s] = lex('echo "a\\"');
    assert.equal(s.type, T.StringLit);
    assert.equal(s.value, '"a\\"');
    assert.notEqual(s.unclosed, true);
  });

  it('char literal', () => {
    const [, c] = lex("echo 'A'");
    assert.equal(c.type, T.CharLit);
    assert.equal(c.value, "'A'");
  });

  it('char literal for a delimiter', () => {
    assert.deepEqual(types("echo ','"), [T.Echo, T.CharLit]);
  });
});

describe('lexer: named constants', () => {
  for (const name of NAMED_CONSTANTS) {
    it(`'${name}' is a named constant inside an expression`, () => {
      const [, t] = lex(`echo ${name}`);
      const expected: Record<string, T> = {
        true: T.True, false: T.False, null: T.Null, pi: T.Pi,
        iterations: T.Iterations, line: T.Line, result: T.Result, input: T.Input,
      };
      assert.equal(t.type, expected[name]);
    });
  }
});

describe('lexer: meta command keywords', () => {
  for (const [kw, type] of Object.entries(META_KEYWORDS)) {
    it(`'${kw}' at line start -> ${T[type]}`, () => {
      assert.equal(lex(`${kw} x`)[0].type, type);
    });
    // TODO(unverified): StringParser::CheckMetaCommand uses StringStartsWith(command, "if"), which
    // is believed to be a case-sensitive strncmp, so upper-case keywords would NOT be meta commands.
    // The lexer lower-cases before lookup. Confirm against RRFLibraries before enabling.
    it(`'${kw}' is case-sensitive: '${kw.toUpperCase()}' is not the keyword`, { todo: 'lexer lower-cases keywords; firmware likely does not' }, () => {
      assert.notEqual(lex(`${kw.toUpperCase()} x`)[0].type, type);
    });
  }

  it('indentation does not change classification', () => {
    assert.equal(lex('        if true')[0].type, T.If);
  });
});

describe('lexer: functions', () => {
  for (const fn of FUNCTION_NAMES) {
    it(`'${fn}' is a FunctionName when called`, () => {
      const toks = lex(`echo ${fn}(1)`);
      assert.equal(toks[1].type, T.FunctionName);
      assert.equal(toks[1].value, fn);
    });
  }

  it('the function table matches the documented signature data', () => {
    // Guard: types.ts and gcode-functions.json must describe the same set.
    const data = readData('gcode-functions.json');
    const documented = Object.keys(data).filter(k => k !== '_meta').sort();
    assert.deepEqual([...FUNCTION_NAMES].sort(), documented);
  });
});

describe('lexer: operators', () => {
  const ops: Array<[string, T]> = [
    ['+', T.Plus], ['-', T.Minus], ['*', T.Star], ['/', T.Slash], ['^', T.Caret],
    ['==', T.EqEq], ['!=', T.NEq], ['<', T.Lt], ['>', T.Gt], ['<=', T.LtEq], ['>=', T.GtEq],
    ['&&', T.And], ['||', T.Or], ['&', T.And], ['|', T.Or],
    ['?', T.Ternary], [':', T.Colon],
  ];
  for (const [op, type] of ops) {
    it(`'${op}' -> ${T[type]}`, () => {
      const toks = types(`echo 1 ${op} 2`);
      assert.ok(toks.includes(type), `expected ${T[type]} in ${toks.map(x => T[x]).join(',')}`);
    });
  }

  it('unary not and length operators', () => {
    assert.ok(types('echo !true').includes(T.Not));
    assert.ok(types('echo #"abc"').includes(T.Hash));
  });

  it('assignment equals is Eq, comparison is EqEq', () => {
    assert.equal(lex('var x = 1')[2].type, T.Eq);
    assert.equal(lex('echo 1 == 1')[2].type, T.EqEq);
  });

  it('>= is a single token, not > then =', () => {
    assert.deepEqual(types('echo 1 >= 2'), [T.Echo, T.Integer, T.GtEq, T.Integer]);
  });

  it('<= is a single token', () => {
    assert.deepEqual(types('echo 1 <= 2'), [T.Echo, T.Integer, T.LtEq, T.Integer]);
  });
});

describe('lexer: brackets and punctuation', () => {
  it('parens, braces, brackets', () => {
    const t = types('echo ({[1]})');
    assert.deepEqual(t, [T.Echo, T.LParen, T.LBrace, T.LBracket, T.Integer, T.RBracket, T.RBrace, T.RParen]);
  });

  it('dotted identifiers stay one token', () => {
    const [, id] = lex('echo move.axes[0].homed');
    assert.equal(id.type, T.Identifier);
  });

  it('var./global./param. qualified names are single Identifier tokens', () => {
    for (const q of ['var.x', 'global.y', 'param.Z']) {
      const toks = lex(`echo ${q}`);
      assert.equal(toks[1].type, T.Identifier, q);
      assert.equal(toks[1].value, q);
    }
  });
});

describe('lexer: comments', () => {
  it('comment-only line', () => {
    const t = lex('; just a comment');
    assert.equal(t[0].type, T.Comment);
  });

  it('trailing comment is a single Comment token', () => {
    const t = lex('G28 ; home');
    assert.equal(t.filter(x => x.type === T.Comment).length, 1);
  });

  it('empty and whitespace-only lines produce no real tokens', () => {
    assert.deepEqual(types(''), []);
    assert.deepEqual(types('    \t'), []);
  });
});

describe('lexer: G/M/T codes', () => {
  const codes = ['G0', 'G1', 'G28', 'G29.1', 'G92', 'M0', 'M104', 'M291', 'M584', 'M591.1', 'M98', 'M999', 'T0', 'T1', 'T-1'];
  for (const c of codes) {
    it(`'${c}' is recognised as a command`, () => {
      const first = lex(c)[0];
      assert.ok(first.type === T.GCode || first.type === T.TCode, `${c} -> ${T[first.type]}`);
    });
  }

  it('lowercase g-code letters are accepted (RRF is case-insensitive for commands)', () => {
    assert.equal(lex('g1 x10')[0].type, T.GCode);
  });

  it('leading line number N123 does not hide the command', () => {
    const toks = lex('N10 G1 X5');
    assert.ok(toks.some(t => t.type === T.GCode));
  });

  it('parameters become GCodeWord + value', () => {
    assert.deepEqual(shape('G1 X10 Y-5.5 F3000'), [
      'GCode(G1)', 'GCodeWord(X)', 'Integer(10)', 'GCodeWord(Y)', 'Minus(-)', 'Float(5.5)', 'GCodeWord(F)', 'Integer(3000)',
    ]);
  });

  it('string parameter values', () => {
    assert.deepEqual(types('M98 P"sys/a.g"'), [T.GCode, T.GCodeWord, T.StringLit]);
  });

  it('braced expression parameter values', () => {
    assert.deepEqual(types('G1 X{1+2}'), [T.GCode, T.GCodeWord, T.LBrace, T.Integer, T.Plus, T.Integer, T.RBrace]);
  });

  it('letters inside braces are identifiers, not GCodeWord', () => {
    const toks = types('G1 X{var.a + b}');
    assert.equal(toks.filter(x => x === T.GCodeWord).length, 1);
  });

  it('each isolated parameter letter is a separate GCodeWord', () => {
    const toks = types('M291 S4 R"a" P"b" T5');
    assert.equal(toks.filter(x => x === T.GCodeWord).length, 4);
  });
});

describe('lexer: meta context overrides G-code recognition', () => {
  it('var g1 is ONE identifier', () => {
    const toks = lex('var g1 = 0');
    assert.equal(toks[1].type, T.Identifier);
    assert.equal(toks[1].value, 'g1');
  });

  it('var testg1 is ONE identifier', () => {
    assert.equal(lex('var testg1 = 1')[1].value, 'testg1');
  });

  it('global testm1 is ONE identifier', () => {
    assert.equal(lex('global testm1 = 1')[1].value, 'testm1');
  });

  for (const word of ['iterations', 'true', 'while', 'null', 'pi', 'if', 'result']) {
    it(`var ${word} declares a variable literally named '${word}'`, () => {
      const toks = lex(`var ${word} = 0`);
      assert.equal(toks[1].type, T.Identifier);
      assert.equal(toks[1].value, word);
    });
  }

  it('expectingVarName applies to global too', () => {
    assert.equal(lex('global while = 0')[1].type, T.Identifier);
  });

  it('M-code names inside an if condition are not commands', () => {
    assert.ok(!types('if var.m1 == 1').includes(T.GCode));
  });
});

describe('lexer: errors', () => {
  it('well-formed lines yield no lexer errors', () => {
    for (const l of ['G1 X1', 'var a = 1', 'echo "x"', 'M98 P"a.g"', '; c', '']) {
      assert.deepEqual(lexErrors(l), [], l);
    }
  });

  it('lexer errors carry a message and a valid span', () => {
    for (const e of lexErrors('echo \u0001')) {
      assert.ok(e.message.length > 0);
      assert.ok(e.end >= e.start);
    }
  });

  it('never throws on arbitrary input', () => {
    const junk = ['\u0000', '\\', '`', '@', '$', '~', '"', "'", '{', '}}', '((', '1.2.3', '0x', '0b', '0xZZ', '1e', '.', '..', '#', '\t\t;'];
    for (const j of junk) {
      assert.doesNotThrow(() => lex(`echo ${j}`), JSON.stringify(j));
      assert.doesNotThrow(() => lex(j), JSON.stringify(j));
      assert.doesNotThrow(() => lex(`G1 X${j}`), JSON.stringify(j));
    }
  });

  it('EOF token always terminates the stream', () => {
    for (const l of ['', 'G1', 'var x = 1', '; c']) {
      const t = lex(l);
      assert.equal(t[t.length - 1].type, T.EOF, l);
    }
  });

  it('token spans never overlap and stay inside the line', () => {
    const line = 'M291 S4 K{"a","b"} R"text" P{var.x + 1} F1 ; tail';
    let prevEnd = 0;
    for (const t of lex(line).filter(x => x.type !== T.EOF)) {
      assert.ok(t.start >= prevEnd, `${t.value} overlaps`);
      assert.ok(t.end <= line.length);
      prevEnd = t.end;
    }
  });
});
