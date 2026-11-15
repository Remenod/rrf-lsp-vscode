// analysis/typecheck/ast.ts
// Expression trees for the type checker, built from lexer tokens.
//
// The grammar mirrors ExpressionParser::ParseInternal (and the syntax layer in
// parser/expression.ts): binary priorities ?(1) ^(2) &|(3) comparisons(4)
// +-(5) */(6), unary operators at 10, `{a}` is a plain value and `{a,}` an
// array.  The parser is total: on anything it cannot read it returns null and
// never throws — syntax errors are the syntax layer's job, and lines that have
// them get no type diagnostics anyway (TC-DIAG-06).

import { Token, TokenType } from '../../parser/types';

export interface Span { start: number; end: number }

export type BinOp = '^' | '&&' | '||' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '+' | '-' | '*' | '/';
export type UnOp = '-' | '+' | '!' | '#';

export type Node =
    | { k: 'num'; s: Span; text: string; tt: TokenType }
    | { k: 'str'; s: Span; text: string }
    | { k: 'char'; s: Span; text: string }
    | { k: 'const'; s: Span; name: string }
    | { k: 'ident'; s: Span; name: string }
    | { k: 'field'; s: Span; base: Node; name: string }
    | { k: 'index'; s: Span; base: Node; index: Node }
    | { k: 'call'; s: Span; name: string; nameS: Span; args: Node[] }
    | { k: 'unary'; s: Span; op: UnOp; opS: Span; arg: Node }
    | { k: 'binary'; s: Span; op: BinOp; l: Node; r: Node }
    | { k: 'cond'; s: Span; c: Node; a: Node; b: Node }
    | { k: 'paren'; s: Span; e: Node }
    | { k: 'brace'; s: Span; items: Node[]; array: boolean }
    | { k: 'opaque'; s: Span };

const BIN: ReadonlyMap<TokenType, [BinOp, number]> = new Map([
    [TokenType.Ternary, ['==', 1]],            // '?': the op is unused, cond nodes are built instead
    [TokenType.Caret, ['^', 2]],
    [TokenType.And, ['&&', 3]],
    [TokenType.Or, ['||', 3]],
    [TokenType.NEq, ['!=', 4]],
    [TokenType.Eq, ['==', 4]],
    [TokenType.EqEq, ['==', 4]],
    [TokenType.Lt, ['<', 4]],
    [TokenType.Gt, ['>', 4]],
    [TokenType.LtEq, ['<=', 4]],
    [TokenType.GtEq, ['>=', 4]],
    [TokenType.Plus, ['+', 5]],
    [TokenType.Minus, ['-', 5]],
    [TokenType.Star, ['*', 6]],
    [TokenType.Slash, ['/', 6]],
]);

const UNARY_PRIORITY = 10;
const MAX_DEPTH = 400;

class Fail extends Error { }

const isWordConst = (t: Token) => t.type >= TokenType.True && t.type <= TokenType.Input;

class Parser {
    private pos = 0;
    private depth = 0;
    constructor(private readonly toks: Token[]) { }

    private cur(): Token { return this.toks[this.pos] ?? { type: TokenType.EOF, value: '', line: 0, start: 0, end: 0 }; }
    private next(): Token { const t = this.cur(); this.pos++; return t; }
    private expect(tt: TokenType): Token {
        const t = this.cur();
        if (t.type !== tt) throw new Fail();
        this.pos++;
        return t;
    }
    skip(): void { this.pos++; }
    get atEnd(): boolean {
        const t = this.cur().type;
        return t === TokenType.EOF || t === TokenType.Comment;
    }
    get here(): TokenType { return this.cur().type; }

    expr(priority = 0): Node {
        if (++this.depth > MAX_DEPTH) throw new Fail();
        try {
            let left = this.unary();
            for (; ;) {
                const t = this.cur();
                const b = BIN.get(t.type);
                if (!b || b[1] <= priority) return left;
                this.pos++;
                if (t.type === TokenType.Ternary) {
                    const a = this.expr(b[1]);
                    this.expect(TokenType.Colon);
                    const alt = this.expr(b[1] - 1);
                    left = { k: 'cond', s: { start: left.s.start, end: alt.s.end }, c: left, a, b: alt };
                    continue;
                }
                const right = this.expr(b[1]);
                left = { k: 'binary', s: { start: left.s.start, end: right.s.end }, op: b[0], l: left, r: right };
            }
        } finally {
            this.depth--;
        }
    }

    private unary(): Node {
        const t = this.cur();
        switch (t.type) {
            case TokenType.Minus:
            case TokenType.Plus:
            case TokenType.Not: {
                this.pos++;
                const arg = this.expr(UNARY_PRIORITY);
                const op: UnOp = t.type === TokenType.Minus ? '-' : t.type === TokenType.Plus ? '+' : '!';
                return { k: 'unary', s: { start: t.start, end: arg.s.end }, op, opS: span(t), arg };
            }
            case TokenType.Hash: {
                this.pos++;
                const o = this.cur();
                let arg: Node;
                if (o.type === TokenType.Identifier || isWordConst(o)) arg = this.identifierExpr();
                else if (o.type === TokenType.FunctionName) arg = this.call();
                else if (o.type === TokenType.StringLit || o.type === TokenType.LParen || o.type === TokenType.LBrace || o.type === TokenType.LBracket) arg = this.expr(UNARY_PRIORITY);
                else throw new Fail();
                return { k: 'unary', s: { start: t.start, end: arg.s.end }, op: '#', opS: span(t), arg };
            }
            default:
                return this.primary();
        }
    }

    private primary(): Node {
        const t = this.cur();
        switch (t.type) {
            case TokenType.LParen: {
                this.pos++;
                const e = this.expr(0);
                const close = this.expect(TokenType.RParen);
                return this.trailing({ k: 'paren', s: { start: t.start, end: close.end }, e });
            }
            case TokenType.LBrace: {
                this.pos++;
                const items = [this.expr(0)];
                let trailingComma = false;
                while (this.cur().type === TokenType.Comma) {
                    this.pos++;
                    if (this.cur().type === TokenType.RBrace) { trailingComma = true; break; }
                    items.push(this.expr(0));
                }
                const close = this.expect(TokenType.RBrace);
                return this.trailing({ k: 'brace', s: { start: t.start, end: close.end }, items, array: items.length > 1 || trailingComma });
            }
            case TokenType.LBracket: {
                // Accepted by the syntax layer; not an RRF value we can type.
                this.pos++;
                let depth = 1;
                let end = t.end;
                while (depth > 0) {
                    const n = this.next();
                    if (n.type === TokenType.EOF || n.type === TokenType.Comment) throw new Fail();
                    if (n.type === TokenType.LBracket) depth++;
                    if (n.type === TokenType.RBracket) depth--;
                    end = n.end;
                }
                return { k: 'opaque', s: { start: t.start, end } };
            }
            case TokenType.Integer:
            case TokenType.HexInteger:
            case TokenType.BinInteger:
            case TokenType.Float:
                this.pos++;
                return this.trailing({ k: 'num', s: span(t), text: t.value, tt: t.type });
            case TokenType.StringLit:
                if (t.unclosed) throw new Fail();
                this.pos++;
                return this.trailing({ k: 'str', s: span(t), text: unquote(t.value) });
            case TokenType.CharLit:
                this.pos++;
                return this.trailing({ k: 'char', s: span(t), text: t.value });
            case TokenType.FunctionName:
                return this.call();
            case TokenType.Identifier:
                return this.identifierExpr();
            default:
                if (isWordConst(t)) {
                    this.pos++;
                    return this.trailing({ k: 'const', s: span(t), name: t.value.toLowerCase() });
                }
                throw new Fail();
        }
    }

    private call(): Node {
        const nameTok = this.next();
        const name = nameTok.value.toLowerCase();
        this.expect(TokenType.LParen);
        const args: Node[] = [];
        if (name === 'exists') {
            if (this.cur().type === TokenType.Hash) this.pos++;
            args.push(this.identifierExpr());
        } else if (this.cur().type !== TokenType.RParen) {
            args.push(this.expr(0));
            while (this.cur().type === TokenType.Comma) {
                this.pos++;
                args.push(this.expr(0));
            }
        }
        const close = this.expect(TokenType.RParen);
        return this.trailing({ k: 'call', s: { start: nameTok.start, end: close.end }, name, nameS: span(nameTok), args });
    }

    private identifierExpr(): Node {
        const t = this.next();
        if (t.type === TokenType.Identifier) return this.trailing({ k: 'ident', s: span(t), name: t.value });
        if (isWordConst(t)) return this.trailing({ k: 'const', s: span(t), name: t.value.toLowerCase() });
        throw new Fail();
    }

    /** Postfix chain: `[index]` and `.field` (field names may lex as functions or constants). */
    private trailing(base: Node): Node {
        let n = base;
        for (; ;) {
            const t = this.cur();
            if (t.type === TokenType.LBracket) {
                this.pos++;
                const index = this.expr(0);
                const close = this.expect(TokenType.RBracket);
                n = { k: 'index', s: { start: n.s.start, end: close.end }, base: n, index };
            } else if (t.type === TokenType.Dot) {
                this.pos++;
                const f = this.next();
                if (f.type !== TokenType.Identifier && f.type !== TokenType.FunctionName && !isWordConst(f)) throw new Fail();
                n = { k: 'field', s: { start: n.s.start, end: f.end }, base: n, name: f.value };
            } else {
                return n;
            }
        }
    }
}

function span(t: Token): Span { return { start: t.start, end: t.end }; }

/** The text of a string literal token: outer quotes removed, `""` unescaped. */
export function unquote(raw: string): string {
    const inner = raw.length >= 2 && raw.endsWith('"') ? raw.slice(1, -1) : raw.slice(1);
    return inner.replace(/""/g, '"');
}

function meaningful(tokens: Token[]): Token[] {
    const out: Token[] = [];
    for (const t of tokens) {
        if (t.type === TokenType.EOF || t.type === TokenType.Comment) break;
        out.push(t);
    }
    return out;
}

/** One complete expression, or null. */
export function parseExpression(tokens: Token[]): Node | null {
    const toks = meaningful(tokens);
    if (toks.length === 0) return null;
    try {
        const p = new Parser(toks);
        const n = p.expr(0);
        return p.atEnd ? n : null;
    } catch {
        return null;
    }
}

/** A comma-separated list (echo items), or null. A trailing comma is allowed. */
export function parseList(tokens: Token[]): Node[] | null {
    const toks = meaningful(tokens);
    if (toks.length === 0) return [];
    try {
        const p = new Parser(toks);
        const items = [p.expr(0)];
        while (p.here === TokenType.Comma) {
            p.skip();
            if (p.atEnd) break;
            items.push(p.expr(0));
        }
        return p.atEnd ? items : null;
    } catch {
        return null;
    }
}

/** Strip transparent wrappers: parentheses and single-value braces. */
export function unwrap(n: Node): Node {
    for (; ;) {
        if (n.k === 'paren') n = n.e;
        else if (n.k === 'brace' && !n.array) n = n.items[0];
        else return n;
    }
}
