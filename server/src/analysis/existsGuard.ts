// analysis/existsGuard.ts
// Whether a use runs only while what it reads exists: a global the workspace never declares (another
// macro creates it at run time), or an object-model field this firmware may not have, read under
// `exists()`. exists() of an unknown object-model field is false, not an error (ObjectModel::
// GetObjectValue with WantExists).
//
// The firmware evaluates the right side of `&&` only when the left is true, the right side of
// `||` only when the left is false, and only the chosen branch of `?:` (ExpressionParser::
// ParseInternal passes `evaluate && …` down). `&&` and `||` share one priority and group to the
// left, as in ast.ts: `a || b && c` is `(a || b) && c`.

import { Token, TokenType } from '../parser/types';
import { Lexer } from '../parser/lexer';
import { Node, parseExpression, parseList, unwrap } from './typecheck/ast';
import { lineIndent } from './utils';

/** Where a use is: the document lines, its 0-based line and the indent of that line. */
export interface UseSite { docLines?: string[]; line: number; indent: number }

/**
 * True when the use of `qualified` (`global.name`) at `usage` runs only while it exists:
 *  * on its own line, it is right of `exists(…) &&` or `!exists(…) ||`, or in the branch of
 *    `exists(…) ? … : …` that runs when the global exists;
 *  * it is in the body of an `if`, `elif` or `while` whose condition proves the global exists, or
 *    in an `elif`/`else` after an `if`/`elif` whose condition is true when it does not;
 *  * an earlier statement of an enclosing block is `if !exists(…)` whose body always ends the
 *    macro (`M99`, `abort`), or `while !exists(…)` without a `break`.
 * `tokens` are the tokens the use was found in, for when the document lines are not known.
 */
export function existsProven(tokens: Token[], usage: Token, qualified: string, site: UseSite): boolean {
    return proven(tokens, usage, arg => rootName(arg) === qualified, site);
}

/**
 * The same for an object-model path (`state.newField`, indexes as `[]`): `exists()` of it, or of
 * a path under it (`exists(move.axes[0].foo.bar)` proves `move.axes[].foo`), proves it. Indexes are
 * not compared: the fields of every element of an array are the same.
 */
export function omExistsProven(tokens: Token[], usage: Token, path: string, site: UseSite): boolean {
    return proven(tokens, usage, arg => {
        const p = pathOf(arg);
        return p !== null && (p === path || p.startsWith(`${path}.`) || p.startsWith(`${path}[`));
    }, site);
}

/** Whether an `exists()` argument proves what is used. */
type Matcher = (arg: Node) => boolean;

function proven(tokens: Token[], usage: Token, matches: Matcher, site: UseSite): boolean {
    const lineText = site.docLines?.[site.line];
    const roots = lineText !== undefined ? lineRoots(new Lexer(lineText, site.line).tokenize()) : [];
    if (lineText === undefined) {
        const n = parseExpression(cutComment(tokens));
        if (n) roots.push(n);
    }
    for (const r of roots) if (within(r, usage.start) && guards(r, usage.start, matches)) return true;
    if (!site.docLines) return false;
    return provenByBlocks(site.docLines, site.line, site.indent, matches);
}

// ── Conditions ───────────────────────────────────────────────────────────────

/** `n` being true means `x` exists. */
function whenTrue(n: Node, x: Matcher): boolean {
    n = unwrap(n);
    if (n.k === 'call' && n.name === 'exists') return n.args.length === 1 && x(n.args[0]);
    if (n.k === 'unary' && n.op === '!') return whenFalse(n.arg, x);
    if (n.k === 'binary' && n.op === '&&') return whenTrue(n.l, x) || whenTrue(n.r, x);
    if (n.k === 'binary' && n.op === '||') return whenTrue(n.l, x) && whenTrue(n.r, x);
    return false;
}

/** `n` being false means `x` exists. */
function whenFalse(n: Node, x: Matcher): boolean {
    n = unwrap(n);
    if (n.k === 'unary' && n.op === '!') return whenTrue(n.arg, x);
    if (n.k === 'binary' && n.op === '&&') return whenFalse(n.l, x) && whenFalse(n.r, x);
    if (n.k === 'binary' && n.op === '||') return whenFalse(n.l, x) || whenFalse(n.r, x);
    return false;
}

/** `move.axes[].homed` for `move.axes[0].homed`. */
function pathOf(n: Node): string | null {
    if (n.k === 'ident') return n.name;
    if (n.k === 'index') { const b = pathOf(n.base); return b === null ? null : `${b}[]`; }
    if (n.k === 'field') { const b = pathOf(n.base); return b === null ? null : `${b}.${n.name}`; }
    return null;
}

/** `global.a` for `global.a`, `global.a[0]` and `global.a[0].b`. */
function rootName(n: Node): string | null {
    while (n.k === 'index' || n.k === 'field') n = n.base;
    return n.k === 'ident' ? n.name.split('.').slice(0, 2).join('.') : null;
}

const within = (n: Node, at: number) => n.s.start <= at && at < n.s.end;

/** The use at offset `at` inside `n` is evaluated only when `x` exists. */
function guards(n: Node, at: number, x: Matcher): boolean {
    if (n.k === 'binary' && (n.op === '&&' || n.op === '||') && within(n.r, at)) {
        return (n.op === '&&' ? whenTrue(n.l, x) : whenFalse(n.l, x)) || guards(n.r, at, x);
    }
    if (n.k === 'cond') {
        if (within(n.a, at)) return whenTrue(n.c, x) || guards(n.a, at, x);
        if (within(n.b, at)) return whenFalse(n.c, x) || guards(n.b, at, x);
    }
    return children(n).some(c => within(c, at) && guards(c, at, x));
}

function children(n: Node): Node[] {
    switch (n.k) {
        case 'field': return [n.base];
        case 'index': return [n.base, n.index];
        case 'call': return n.args;
        case 'unary': return [n.arg];
        case 'binary': return [n.l, n.r];
        case 'cond': return [n.c, n.a, n.b];
        case 'paren': return [n.e];
        case 'brace': return n.items;
        default: return [];
    }
}

// ── Lines ────────────────────────────────────────────────────────────────────

function cutComment(t: Token[]): Token[] {
    const i = t.findIndex(x => x.type === TokenType.EOF || x.type === TokenType.Comment);
    return i < 0 ? t : t.slice(0, i);
}

/** End (exclusive) of the `{…}` group that starts at `from`. */
function braceEnd(t: Token[], from: number): number {
    let depth = 0;
    for (let i = from; i < t.length; i++) {
        if (t[i].type === TokenType.LBrace) depth++;
        else if (t[i].type === TokenType.RBrace && --depth === 0) return i + 1;
    }
    return t.length;
}

/** The expressions of a line, each evaluated on its own: a guard in one does not cover another. */
function lineRoots(all: Token[]): Node[] {
    const t = cutComment(all);
    const out: Array<Node | null> = [];
    switch (t[0]?.type) {
        case TokenType.If: case TokenType.Elif: case TokenType.While: case TokenType.Abort:
            out.push(parseExpression(t.slice(1)));
            break;
        case TokenType.Var: case TokenType.Global:
            if (t[2]?.type === TokenType.Eq) out.push(parseExpression(t.slice(3)));
            break;
        case TokenType.Set: {
            let depth = 0;
            for (let i = 2; i < t.length; i++) {
                const tt = t[i].type;
                if (tt === TokenType.LBracket) depth++;
                else if (tt === TokenType.RBracket) depth--;
                else if (tt === TokenType.Eq && depth === 0) { out.push(parseExpression(t.slice(i + 1))); break; }
            }
            break;
        }
        case TokenType.Echo: {
            let i = 1;
            const r = t[1]?.type;
            if (r === TokenType.Gt || r === TokenType.DoubleGt || r === TokenType.TripleGt) {
                i = 2;
                if (t[2]?.type === TokenType.StringLit) i = 3;
                else if (t[2]?.type === TokenType.LBrace) { i = braceEnd(t, 2); out.push(parseExpression(t.slice(2, i))); }
            }
            out.push(...(parseList(t.slice(i)) ?? []));
            break;
        }
        default:
            // A G/M/T command: every `{…}` value is an expression of its own.
            for (let i = 0; i < t.length; i++) {
                if (t[i].type !== TokenType.LBrace) continue;
                const end = braceEnd(t, i);
                out.push(parseExpression(t.slice(i, end)));
                i = end - 1;
            }
    }
    return out.filter((n): n is Node => n !== null);
}

const isBlank = (text: string) => { const s = text.trim(); return s === '' || s.startsWith(';'); };
const keyword = (text: string) => /^([a-z]+)\b/i.exec(text.trim())?.[1].toLowerCase() ?? '';

/** The condition of an `if`, `elif` or `while` line. */
function condition(docLines: string[], l: number): Node | null {
    const t = cutComment(new Lexer(docLines[l], l).tokenize());
    const k = t[0]?.type;
    return k === TokenType.If || k === TokenType.Elif || k === TokenType.While ? parseExpression(t.slice(1)) : null;
}

/** The lines of the block under line `l` (indent `ind`) that are at the block's own indent. */
function bodyStatements(docLines: string[], l: number, ind: number): string[] {
    const out: string[] = [];
    let bodyIndent = -1;
    for (let k = l + 1; k < docLines.length; k++) {
        const text = docLines[k];
        if (isBlank(text)) continue;
        const i = lineIndent(text);
        if (i <= ind) break;
        if (bodyIndent < 0) bodyIndent = i;
        if (i === bodyIndent) out.push(text);
    }
    return out;
}

/** Every run of the block under line `l` ends the macro: a statement of its own is M99 or abort. */
function bodyLeaves(docLines: string[], l: number, ind: number): boolean {
    for (const s of bodyStatements(docLines, l, ind)) {
        const k = keyword(s);
        if (k === 'break' || k === 'continue') return false;
        if (k === 'abort' || /^m99(?![0-9.])/i.test(s.trim())) return true;
    }
    return false;
}

/** A `break` anywhere under line `l`. */
function bodyBreaks(docLines: string[], l: number, ind: number): boolean {
    for (let k = l + 1; k < docLines.length; k++) {
        if (isBlank(docLines[k])) continue;
        if (lineIndent(docLines[k]) <= ind) return false;
        if (keyword(docLines[k]) === 'break') return true;
    }
    return false;
}

/** Line `l` is an `elif` or `else`: it runs only when the conditions above it in its chain are false. */
function earlierBranchesProve(docLines: string[], l: number, ind: number, x: Matcher): boolean {
    for (let k = l - 1; k >= 0; k--) {
        if (isBlank(docLines[k])) continue;
        const i = lineIndent(docLines[k]);
        if (i > ind) continue;
        if (i < ind) return false;
        const kw = keyword(docLines[k]);
        if (kw !== 'if' && kw !== 'elif') return false;
        const c = condition(docLines, k);
        if (c && whenFalse(c, x)) return true;
        if (kw === 'if') return false;
    }
    return false;
}

function provenByBlocks(docLines: string[], line: number, indent: number, x: Matcher): boolean {
    if (keyword(docLines[line] ?? '') === 'elif' && earlierBranchesProve(docLines, line, indent, x)) return true;
    let cur = indent;
    for (let l = line - 1; l >= 0; l--) {
        const text = docLines[l];
        if (text === undefined || isBlank(text)) continue;
        const ind = lineIndent(text);
        if (ind > cur) continue;
        const kw = keyword(text);
        if (ind === cur) {
            // An earlier statement of the same block.
            const c = kw === 'if' || kw === 'while' ? condition(docLines, l) : null;
            if (c && whenFalse(c, x) && (kw === 'if' ? bodyLeaves(docLines, l, ind) : !bodyBreaks(docLines, l, ind))) return true;
            continue;
        }
        // The header of the block the use is in.
        const c = kw === 'if' || kw === 'elif' || kw === 'while' ? condition(docLines, l) : null;
        if (c && whenTrue(c, x)) return true;
        if ((kw === 'elif' || kw === 'else') && earlierBranchesProve(docLines, l, ind, x)) return true;
        cur = ind;
    }
    return false;
}
