// SymbolTable: indexing, scope-aware lookup, duplicate detection, inferred types.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolTable } from '../../src/analysis/symbolTable';

const U = 'file:///t.g';
const lines = (t: string) => t.split('\n');
function table(text: string, uri = U): SymbolTable {
  const st = new SymbolTable();
  st.indexDocument(uri, text);
  return st;
}

describe('symbols: indexing', () => {
  it('records var and global declarations with position and indent', () => {
    const st = table('var a = 1\nif true\n  var b = 2\nglobal g = 3');
    const a = st.lookupVar('a', U)!;
    assert.equal(a.line, 0);
    assert.equal(a.indent, 0);
    assert.equal(a.scope, 'var');
    const b = st.lookupVar('b', U)!;
    assert.equal(b.line, 2);
    assert.equal(b.indent, 2);
    assert.equal(st.lookupGlobal('g')!.scope, 'global');
  });

  it('re-indexing replaces the previous contents of that document only', () => {
    const st = new SymbolTable();
    st.indexDocument('file:///a.g', 'global g = 1');
    st.indexDocument('file:///b.g', 'global h = 1');
    st.indexDocument('file:///a.g', 'global i = 1');
    assert.equal(st.lookupGlobal('g'), undefined);
    assert.ok(st.lookupGlobal('h'));
    assert.ok(st.lookupGlobal('i'));
  });

  it('removeDocument forgets its globals and locals', () => {
    const st = new SymbolTable();
    st.indexDocument('file:///a.g', 'var a = 1\nglobal g = 1');
    st.removeDocument('file:///a.g');
    assert.equal(st.lookupGlobal('g'), undefined);
    assert.equal(st.lookupVar('a', 'file:///a.g'), undefined);
    assert.equal(st.getAllIndexedUris().has('file:///a.g'), false);
  });

  it('globals from several files are all kept (duplicate detection across files)', () => {
    const st = new SymbolTable();
    st.indexDocument('file:///a.g', 'global g = 1');
    st.indexDocument('file:///b.g', 'global g = 2');
    assert.equal(st.getAllGlobalDecls('g').length, 2);
    assert.equal(st.getGlobalDeclsInFile('g', 'file:///a.g').length, 1);
  });

  it('declaration-looking text in comments and strings is ignored', () => {
    const st = table('; var ghost = 1\necho "var ghost2 = 1"');
    assert.equal(st.lookupVar('ghost', U), undefined);
    assert.equal(st.lookupVar('ghost2', U), undefined);
  });

  it('handles CRLF', () => {
    const st = table('var a = 1\r\nvar b = 2\r\n');
    assert.ok(st.lookupVar('a', U));
    assert.ok(st.lookupVar('b', U));
  });

  it('indexing empty text is fine', () => {
    assert.doesNotThrow(() => table(''));
  });
});

describe('symbols: lookupVarAtLine respects block closure', () => {
  const doc = ['var top = 1', 'if true', '  var inner = 2', '  echo 1', 'echo 2', 'if true', '  echo 3'].join('\n');
  const st = table(doc);
  const L = lines(doc);
  const find = (name: string, line: number, indent: number) =>
    st.lookupVarAtLine(name, U, line, indent, L);

  it('top-level var visible everywhere after it', () => {
    assert.ok(find('top', 1, 0));
    assert.ok(find('top', 3, 2));
    assert.ok(find('top', 6, 2));
  });
  it('inner var visible inside its block', () => assert.ok(find('inner', 3, 2)));
  it('inner var NOT visible after dedent', () => assert.equal(find('inner', 4, 0), undefined));
  it('inner var NOT visible in a sibling block', () => assert.equal(find('inner', 6, 2), undefined));
  it('the declaring line sees its own variable unless strictBefore is set', () => {
    assert.ok(find('top', 0, 0));
  });
  it('strictBefore excludes the declaring line itself', () => {
    assert.equal(st.lookupVarAtLine('top', U, 0, 0, L, true), undefined);
  });
  it('unknown name', () => assert.equal(find('nope', 3, 2), undefined));
});

describe('symbols: isDuplicateVarDecl', () => {
  const dup = (text: string, name: string, line: number) => {
    const L = lines(text);
    const indent = L[line].length - L[line].trimStart().length;
    return table(text).isDuplicateVarDecl(name, U, line, indent, L);
  };
  it('same scope', () => assert.ok(dup('var a = 1\nvar a = 2', 'a', 1)));
  it('nested redeclaration', () => assert.ok(dup('var a = 1\nif true\n  var a = 2', 'a', 2)));
  it('first declaration is not a duplicate of itself', () => assert.equal(dup('var a = 1\nvar a = 2', 'a', 0), undefined));
  it('sibling blocks do not conflict', () => assert.equal(dup('if true\n  var a = 1\nif true\n  var a = 2', 'a', 3), undefined));
  it('after the block closed the name is free', () => assert.equal(dup('if true\n  var a = 1\nvar a = 2', 'a', 2), undefined));
  it('different names', () => assert.equal(dup('var a = 1\nvar b = 2', 'b', 1), undefined));
});

describe('symbols: inferred types of initialisers', () => {
  const typeOf = (init: string) => table(`var x = ${init}`).lookupVar('x', U)!.inferredType;

  const exact: Array<[string, string]> = [
    ['1', 'int'], ['0', 'int'], ['0xFF', 'int'], ['0b11', 'int'],
    ['1.5', 'float'], ['1e3', 'float'],
    ['"s"', 'string'],
    ["'c'", 'char'],
    ['true', 'bool'], ['false', 'bool'],
    ['{1,2}', 'array'],
  ];
  for (const [init, want] of exact) it(`${init} -> ${want}`, () => assert.equal(typeOf(init), want));

  // The whole initialiser is typed (RRF: ExpressionParser.cpp), on its own: no flow.
  const correct: Array<[string, string, string]> = [
    ['-1', 'int', 'unary minus keeps the operand type'],
    ['-1.5', 'float', 'unary minus keeps the operand type'],
    ['1 + 2', 'int', 'int + int'],
    ['1 + 2.5', 'float', 'int + float balances to float (BalanceNumericTypes)'],
    ['2.5 + 1', 'float', 'float + int'],
    ['10 / 2', 'float', '"/" always converts both operands to float'],
    ['1 == 1', 'bool', 'comparison'],
    ['1 < 2', 'bool', 'comparison'],
    ['true && false', 'bool', 'logical and'],
    ['!true', 'bool', 'logical not'],
    ['"a" ^ 1', 'string', '"^" concatenates anything to a string'],
    ['#"abc"', 'int', 'length operator'],
    ['abs(-1)', 'int', 'abs keeps int'],
    ['abs(-1.5)', 'float', 'abs keeps float'],
    ['sqrt(4)', 'float', 'sqrt returns float'],
    ['floor(2.5)', 'int', 'floor returns int when it fits'],
    ['vector(3, 0)', 'array', 'vector() builds an array'],
    ['null', 'null', 'null literal'],
    ['(1.5)', 'float', 'parenthesised'],
    ['true ? 1 : 2', 'int', 'ternary with equal branch types'],
    ['pi', 'float', 'named constant'],
    ['fileexists("a")', 'bool', 'fileexists returns bool'],
    ['isnan(1)', 'bool', 'isnan returns bool'],
    ['mod(7, 2)', 'int', 'int mod int'],
    ['max(1, 2.5)', 'float', 'max balances numeric types'],
    ['move.axes[0].min', 'number', 'object-model numbers are int | uint | float'],
  ];
  for (const [init, want, why] of correct) {
    it(`${init} -> ${want} (${why})`, () => {
      assert.equal(typeOf(init), want);
    });
  }

  it('unknown stays "unknown" rather than guessing', () => {
    assert.equal(typeOf('state.vmFeatureLevel'), 'unknown');
    assert.equal(typeOf('var.other + 1'), 'unknown');
  });
});
