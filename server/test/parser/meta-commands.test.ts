// Meta commands: var / global / set / echo / if / elif / else / while / break / continue / abort / param / skip.
// Each diagnostic site in parser/expression.ts has a triggering case and a near-miss that must stay quiet.

import { describe } from 'node:test';
import { expectClean, expectDiag, expectSilent } from '../helpers/cases';
import { src } from '../helpers/harness';

describe('var', () => {
  expectSilent([
    'var a = 1',
    'var a = "x"',
    'var some_name2 = 0',
    'var camelCase = 1',
    src('var a = 1', 'set var.a = var.a + 1'),
    'var iterations = 0',
    'var g1 = 0',
  ]);
  expectDiag([
    ['var', /expected a variable name after 'var'/],
    ['var 1 = 2', /expected a variable name after 'var'/],
    ['var a', /'var' declaration requires an initial value/],
    ['var a 1', /expected '=' after 'a'/],
    ['var a =', /expected an expression after '='/],
    ['var a == 1', /expected '=' after 'a'/],
    ['var a = 1 +', /dangling/],
    ['var a = var.a', /undefined variable 'var\.a'/],
    ['var a = var.b', /undefined variable 'var\.b'/],
    [src('var a = 1', 'var a = 2'), /already declared/],
    [src('var a = 1', 'if true', '  var a = 2'), /already declared/],
  ]);
  expectSilent([
    { name: 'same name in sibling blocks is fine', src: src('if true', '  var a = 1', 'if true', '  var a = 2') },
    { name: 'same name in separate if/else branches', src: src('if true', '  var a = 1', 'else', '  var a = 2') },
  ]);
});

describe('global', () => {
  expectSilent([
    'global g = 1',
    'global g = "s"',
    src('global g = 1', 'global g = 2'),   // duplicates intentionally not flagged
  ]);
  expectDiag([
    ['global', /expected a variable name after 'global'/],
    ['global g', /'global' declaration requires an initial value/],
    ['global g 1', /expected '=' after 'g'/],
    ['global g =', /expected an expression after '='/],
  ]);
});

describe('set', () => {
  expectSilent([
    src('var a = 1', 'set var.a = 2'),
    src('var a = 1', 'set var.a = var.a * 2'),
    src('global g = 1', 'set global.g = 2'),
    src('var a = {1,2,3}', 'set var.a[0] = 9'),
    src('var a = {{1,2},{3,4}}', 'set var.a[0][1] = 9'),
  ]);
  expectDiag([
    ['set', /expected 'var\.<name>' or 'global\.<name>' after 'set'/],
    ['set 5 = 1', /'set' can only assign to/],
    ['set x = 1', /'set' requires 'var\.<name>' or 'global\.<name>'/],
    ['set param.X = 1', /macro parameters are read-only/],
    ['set var.zzz = 1', /undefined variable 'var\.zzz'/],
    [src('var a = 1', 'set var.a'), /'set' requires an assignment/],
    [src('var a = 1', 'set var.a 3'), /expected '=' after 'var\.a'/],
    [src('var a = 1', 'set var.a ='), /expected an expression after '='/],
    [src('var a = 1', 'set var.a = var.nope'), /undefined variable 'var\.nope'/],
    ['set global.unknown = 1', /'global\.unknown' not found/],
  ]);
});

describe('echo', () => {
  expectSilent([
    'echo "hi"',
    'echo 1, 2, 3',
    'echo "a", "b"',
    'echo >"file.txt" "line"',
    'echo >>"file.txt" "line"',
    'echo >>>"file.txt" "line"',
    'echo >{"dir/" ^ "f.txt"} "line"',
    'echo',
  ]);
  expectDiag([
    ['echo >', /expected a quoted filename or \{expression\} after redirect operator/],
    ['echo > "f.txt" "x"', /no space allowed between '>' and the filename/],
    ['echo >> "f.txt" "x"', /no space allowed between '>>'/],
    ['echo >>> "f.txt" "x"', /no space allowed between '>>>'/],
    ['echo >foo "x"', /expected a quoted filename/],
    ['echo , 1', /.+/],
    ['echo 1 +', /dangling/],
  ]);
});

describe('echo: trailing comma', () => {
  // StringParser::ProcessEchoCommand skips a comma and stops at end of line, so a trailing comma is legal.
  expectSilent(['echo 1,', 'echo "a", "b",']);
});

describe('if / elif / else / while', () => {
  expectSilent([
    src('if true', '  echo "a"'),
    src('if 1 == 1', '  echo "a"', 'elif 2 == 2', '  echo "b"', 'else', '  echo "c"'),
    src('while true', '  break'),
    src('while iterations < 3', '  echo iterations'),
    src('if true', '  echo "a"', 'else', '  echo "b"'),
    src('if true', '  if false', '    echo "x"', '  else', '    echo "y"'),
  ]);
  expectDiag([
    ['if', /'if' requires a condition expression/],
    ['elif', /'elif' requires a condition expression/],
    ['while', /'while' requires a condition expression/],
    ['if 1 +', /dangling/],
    [src('if true', '  echo "a"', 'else true', '  echo "b"'), /'else' does not take a condition — did you mean 'elif true…'\?/],
    [src('else', '  echo "x"'), /'else' does not follow an 'if' or 'elif' block/],
    [src('elif true', '  echo "x"'), /'elif' does not follow an 'if' or 'elif' block/],
    [src('echo "x"', 'else', '  echo "y"'), /'else' does not follow/],
    [src('if true', '  echo "a"', 'echo "b"', 'else', '  echo "c"'), /'else' does not follow/],
    [src('if true', '  echo "a"', '  else', '    echo "c"'), /'else' does not follow/],
    [src('while true', '  echo "a"', 'else', '  echo "c"'), /'else' does not follow/],
  ]);
});

describe('break / continue / iterations', () => {
  expectSilent([
    src('while true', '  break'),
    src('while true', '  continue'),
    src('while true', '  if true', '    break'),
    src('while true', '  if true', '    continue'),
    src('while true', '  while true', '    break', '  break'),
    src('while iterations < 2', '  echo iterations'),
    src('while true', '  if iterations > 0', '    break'),
  ]);
  expectDiag([
    ['break', /'break' is not inside a 'while' loop/],
    ['continue', /'continue' is not inside a 'while' loop/],
    [src('if true', '  break'), /'break' is not inside a 'while' loop/],
    [src('while true', '  echo 1', 'break'), /'break' is not inside a 'while' loop/],
    [src('while true', '  echo 1', 'echo iterations'), /'iterations' may only be used inside a 'while' loop/],
    ['echo iterations', /'iterations' may only be used inside a 'while' loop/],
    [src('if true', '  echo iterations'), /'iterations' may only be used inside a 'while' loop/],
  ]);
});

describe('abort / skip / param', () => {
  expectSilent(['abort', 'abort "message"', 'abort "a" ^ "b"', 'skip']);
  expectDiag([
    ['abort 1 +', /dangling/],
    ['param X = 1', /'param' cannot be used as a declaration/],
    ['param', /'param' cannot be used as a declaration/],
  ]);
});

describe('unknown commands', () => {
  expectDiag([
    ['frobnicate', /unknown command 'frobnicate'/],
    ['hello world', /unknown command 'hello'/],
    ['x = 1', /unknown command 'x'/],
  ]);
  expectClean(['G28', 'M999', 'T0', '; comment', '', '   ']);
});

describe('indentation-defined blocks', () => {
  expectSilent([
    src('if true', '\techo "tab"'),
    src('while iterations < 1', '    echo "four"'),
  ]);
});
