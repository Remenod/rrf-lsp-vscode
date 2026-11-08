// analysis/typecheck/flow.ts
// Flow-sensitive typing of one document (SPEC §5, §8, §11).
//
// Blocks are rebuilt from indentation; local variables are typed along every
// path: `if`/`elif`/`else` join, `while` runs to a fixed point, `break` and
// `continue` carry their types to the loop exit and head, `abort` and `M99`
// end a path, and comparisons with null narrow.  Globals are flow-insensitive
// (their workspace type comes from outside) apart from null narrowing.

import { Lexer } from '../../parser/lexer';
import { Token, TokenType } from '../../parser/types';
import { lineIndent } from '../utils';
import { Node, parseExpression, parseList, unwrap } from './ast';
import { Ty, UNKNOWN, BOTTOM, union, lacksAll, describe, key, isUnknown, atoms, prim } from './types';
import { Typer, Scope, TypeDiag, CODE, MSG, narrowFacts, applyFact, NarrowFact, R } from './infer';
import { Version } from './versions';

// ── Statements ──────────────────────────────────────────────────────────────

interface Stmt {
    line: number;
    indent: number;
    text: string;
    tokens: Token[];
    lexOk: boolean;
    kids: Stmt[];
    cache?: unknown;
}

/** A document split into statements, with parse results cached across passes. */
export class Doc {
    readonly roots: Stmt[] = [];

    constructor(readonly lines: string[]) {
        const stack: Stmt[] = [];
        for (let i = 0; i < lines.length; i++) {
            const text = lines[i];
            const trimmed = text.trim();
            if (trimmed === '' || trimmed.startsWith(';')) continue;
            const lexer = new Lexer(text, i);
            const tokens = lexer.tokenize();
            const first = tokens[0];
            if (!first || first.type === TokenType.EOF || first.type === TokenType.Comment) continue;
            const s: Stmt = { line: i, indent: lineIndent(text), text, tokens, lexOk: lexer.errors.length === 0, kids: [] };
            while (stack.length && stack[stack.length - 1].indent >= s.indent) stack.pop();
            (stack.length ? stack[stack.length - 1].kids : this.roots).push(s);
            stack.push(s);
        }
    }
}

const first = (s: Stmt) => s.tokens[0].type;
const cut = (toks: Token[]) => {
    const i = toks.findIndex(t => t.type === TokenType.EOF || t.type === TokenType.Comment);
    return i < 0 ? toks : toks.slice(0, i);
};

function cached<T>(s: Stmt, make: () => T): T {
    if (s.cache === undefined) s.cache = s.lexOk ? make() : null;
    return s.cache as T;
}

const condition = (s: Stmt) => cached(s, () => parseExpression(cut(s.tokens.slice(1))));

interface Decl { name: string; nameTok: Token; expr: Node | null }
const declaration = (s: Stmt) => cached<Decl | null>(s, () => {
    const [, nameTok, eq] = s.tokens;
    if (nameTok?.type !== TokenType.Identifier || eq?.type !== TokenType.Eq) return null;
    return { name: nameTok.value, nameTok, expr: parseExpression(s.tokens.slice(3)) };
});

interface Assign { target: Token; scope: 'var' | 'global'; name: string; indexes: Array<Node | null>; expr: Node | null }
const assignment = (s: Stmt) => cached<Assign | null>(s, () => {
    const target = s.tokens[1];
    if (target?.type !== TokenType.Identifier) return null;
    const m = /^(var|global)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(target.value);
    if (!m) return null;
    const indexes: Array<Node | null> = [];
    let i = 2;
    while (s.tokens[i]?.type === TokenType.LBracket) {
        let depth = 1;
        const from = i + 1;
        i++;
        while (i < s.tokens.length && depth > 0) {
            if (s.tokens[i].type === TokenType.LBracket) depth++;
            if (s.tokens[i].type === TokenType.RBracket) depth--;
            i++;
        }
        indexes.push(parseExpression(s.tokens.slice(from, i - 1)));
    }
    if (s.tokens[i]?.type !== TokenType.Eq) return null;
    return { target, scope: m[1] as 'var' | 'global', name: m[2], indexes, expr: parseExpression(s.tokens.slice(i + 1)) };
});

interface Echo { redirect: boolean; file: Node | null; items: Node[] | null }
const echo = (s: Stmt) => cached<Echo>(s, () => {
    let i = 1;
    let redirect = false;
    let file: Node | null = null;
    const r = s.tokens[1]?.type;
    if (r === TokenType.Gt || r === TokenType.DoubleGt || r === TokenType.TripleGt) {
        redirect = true;
        i = 2;
        const f = s.tokens[2];
        if (f?.type === TokenType.StringLit) i = 3;
        else if (f?.type === TokenType.LBrace) {
            let depth = 0;
            const from = i;
            for (; i < s.tokens.length; i++) {
                const tt = s.tokens[i].type;
                if (tt === TokenType.EOF || tt === TokenType.Comment) break;
                if (tt === TokenType.LBrace) depth++;
                if (tt === TokenType.RBrace && --depth === 0) { i++; break; }
            }
            file = parseExpression(s.tokens.slice(from, i));
        }
    }
    return { redirect, file, items: parseList(s.tokens.slice(i)) };
});

/** The `{…}` expressions of a G/M/T command line, braces included. */
const gcodeGroups = (s: Stmt) => cached<Array<Node | null>>(s, () => {
    const out: Array<Node | null> = [];
    let depth = 0;
    let from = -1;
    for (let i = 0; i < s.tokens.length; i++) {
        const tt = s.tokens[i].type;
        if (tt === TokenType.EOF || tt === TokenType.Comment) break;
        if (tt === TokenType.LBrace && depth++ === 0) from = i;
        else if (tt === TokenType.RBrace && depth > 0 && --depth === 0) out.push(parseExpression(s.tokens.slice(from, i + 1)));
    }
    return out;
});

const abortMessage = (s: Stmt) => cached(s, () => parseExpression(cut(s.tokens.slice(1))));

// ── Environments ────────────────────────────────────────────────────────────

interface Env {
    vars: Map<string, Ty>;
    /** Null-narrowed globals (overrides of the workspace type). */
    globals: Map<string, Ty>;
}
type Flow = Env | null;

const clone = (e: Env): Env => ({ vars: new Map(e.vars), globals: new Map(e.globals) });

function join(flows: Flow[]): Flow {
    const live = flows.filter((f): f is Env => f !== null);
    if (live.length === 0) return null;
    if (live.length === 1) return clone(live[0]);
    const out: Env = { vars: new Map(), globals: new Map() };
    for (const [name] of live[0].vars) {
        if (live.every(e => e.vars.has(name))) out.vars.set(name, union(...live.map(e => e.vars.get(name)!)));
    }
    for (const [name] of live[0].globals) {
        if (live.every(e => e.globals.has(name))) out.globals.set(name, union(...live.map(e => e.globals.get(name)!)));
    }
    return out;
}

function sameEnv(a: Env, b: Env): boolean {
    if (a.vars.size !== b.vars.size || a.globals.size !== b.globals.size) return false;
    for (const [n, t] of a.vars) { const u = b.vars.get(n); if (u === undefined || key(u) !== key(t)) return false; }
    for (const [n, t] of a.globals) { const u = b.globals.get(n); if (u === undefined || key(u) !== key(t)) return false; }
    return true;
}

/** Widen element types `depth` levels down with `t` (indexed assignment, TC-FLOW-08). */
export function widenElements(arr: Ty, depth: number, t: Ty): Ty {
    if (isUnknown(arr)) return arr;
    return arr.map(a => {
        if (typeof a === 'string') return a;
        const elem = depth <= 1 ? union(a.elem, t) : widenElements(a.elem, depth - 1, t);
        return { ...a, elem };
    });
}

// ── The walk ────────────────────────────────────────────────────────────────

export interface Contribution {
    name: string;
    /** `assign`: the global may hold `t`; `elem`: its elements `depth` levels down may. */
    kind: 'assign' | 'elem';
    depth: number;
    t: Ty;
}

export interface FlowOptions {
    version: Version | null;
    globals(name: string): Ty;
    report: boolean;
    record: boolean;
    contribute?: (c: Contribution) => void;
}

export interface FlowResult {
    diagnostics: TypeDiag[];
    /** line → column → type of the var./global./param. reference starting there. */
    types: Map<number, Map<number, Ty>>;
}

interface Loop { breaks: Flow[]; continues: Flow[] }
interface Ctx { loop: Loop | null; silent: boolean }

const MAX_LOOP_PASSES = 8;
const ABORT_NOTE = ` — the printer still aborts, but shows "invalid expression after 'abort'" instead of this message`;

class Walker {
    readonly result: FlowResult = { diagnostics: [], types: new Map() };

    constructor(private readonly opts: FlowOptions) { }

    private typer(s: Stmt, ctx: Ctx, note?: string): Typer {
        const silent = ctx.silent;
        return new Typer({
            line: s.line,
            lineText: s.text,
            version: this.opts.version,
            note,
            report: silent || !this.opts.report ? null : d => this.result.diagnostics.push(d),
            record: silent || !this.opts.record ? null : (col, t) => this.recordType(s.line, col, t),
        });
    }

    private recordType(line: number, col: number, t: Ty): void {
        let m = this.result.types.get(line);
        if (!m) this.result.types.set(line, m = new Map());
        m.set(col, t);
    }

    private scope(env: Env): Scope {
        return {
            local: n => env.vars.get(n),
            global: n => env.globals.get(n) ?? this.opts.globals(n),
        };
    }

    private infer(s: Stmt, n: Node, env: Env, ctx: Ctx, note?: string): R {
        return this.typer(s, ctx, note).infer(n, this.scope(env));
    }

    private narrow(env: Env, cond: Node | null, truthy: boolean): Env {
        const out = clone(env);
        if (!cond) return out;
        const facts: NarrowFact[] = narrowFacts(cond, truthy);
        for (const f of facts) {
            if (f.key.startsWith('var.')) {
                const n = f.key.slice(4);
                const t = out.vars.get(n);
                if (t !== undefined) out.vars.set(n, applyFact(t, f.toNull));
            } else {
                const n = f.key.slice(7);
                out.globals.set(n, applyFact(out.globals.get(n) ?? this.opts.globals(n), f.toNull));
            }
        }
        return out;
    }

    run(roots: Stmt[]): void {
        this.seq(roots, { vars: new Map(), globals: new Map() }, { loop: null, silent: false });
    }

    /** A nested block: variables declared inside go out of scope at its end. */
    private block(stmts: Stmt[], env: Env, ctx: Ctx): Flow {
        const out = this.seq(stmts, clone(env), ctx);
        if (!out) return null;
        for (const name of [...out.vars.keys()]) if (!env.vars.has(name)) out.vars.delete(name);
        return out;
    }

    private seq(stmts: Stmt[], env: Env, ctx: Ctx): Flow {
        let cur: Flow = env;
        let last: Env = env;
        for (let i = 0; i < stmts.length; i++) {
            const s = stmts[i];
            // Code after a path ends is still checked, with the types it would have had.
            const here = cur ?? clone(last);
            const tt = first(s);
            let next: Flow;
            if (tt === TokenType.If) {
                let j = i + 1;
                while (j < stmts.length && first(stmts[j]) === TokenType.Elif) j++;
                if (j < stmts.length && first(stmts[j]) === TokenType.Else) j++;
                next = this.ifChain(stmts.slice(i, j), here, ctx);
                i = j - 1;
            } else if (tt === TokenType.Elif || tt === TokenType.Else) {
                // A stray elif/else (reported by the syntax layer): check its block.
                if (tt === TokenType.Elif) this.condition(s, here, ctx);
                next = join([this.block(s.kids, here, ctx), here]);
            } else if (tt === TokenType.While) {
                next = this.loop(s, here, ctx);
            } else {
                next = this.statement(s, here, ctx);
                if (s.kids.length && next) next = this.block(s.kids, next, ctx);
            }
            if (cur) { if (next) last = next; cur = next; }
        }
        return cur;
    }

    private condition(s: Stmt, env: Env, ctx: Ctx): Node | null {
        const cond = condition(s);
        if (!cond) return null;
        const r = this.infer(s, cond, env, ctx);
        if (!r.failed && lacksAll(r.t, 'bool')) {
            const at = cond.k === 'brace' && !cond.array ? cond.items[0] : cond;
            if (!ctx.silent && this.opts.report) {
                this.result.diagnostics.push({
                    line: s.line, start: at.s.start, end: at.s.end, code: CODE.boolean, severity: 'error',
                    message: `'${s.tokens[0].value}' needs a Boolean condition, got ${describe(r.t)}: the firmware stops with "${MSG.boolean}"`,
                });
            }
        }
        return cond;
    }

    private ifChain(chain: Stmt[], env: Env, ctx: Ctx): Flow {
        const outs: Flow[] = [];
        let rest: Env | null = env;
        for (const s of chain) {
            if (!rest) break;
            if (first(s) === TokenType.Else) {
                outs.push(this.block(s.kids, rest, ctx));
                rest = null;
                continue;
            }
            const cond = this.condition(s, rest, ctx);
            outs.push(this.block(s.kids, this.narrow(rest, cond, true), ctx));
            rest = this.narrow(rest, cond, false);
        }
        if (rest) outs.push(rest);
        return join(outs);
    }

    private loop(s: Stmt, env: Env, ctx: Ctx): Flow {
        const cond = condition(s);
        let head = clone(env);
        for (let pass = 0; pass < MAX_LOOP_PASSES; pass++) {
            const loop: Loop = { breaks: [], continues: [] };
            const quiet: Ctx = { loop, silent: true };
            this.condition(s, head, quiet);
            const end = this.block(s.kids, this.narrow(head, cond, true), quiet);
            const next = join([env, end, ...loop.continues])!;
            if (sameEnv(next, head)) break;
            if (pass === MAX_LOOP_PASSES - 1) {
                for (const [n, t] of next.vars) if (key(t) !== key(head.vars.get(n) ?? UNKNOWN)) next.vars.set(n, UNKNOWN);
            }
            head = next;
        }
        const loop: Loop = { breaks: [], continues: [] };
        const final: Ctx = { loop, silent: ctx.silent };
        this.condition(s, head, final);
        this.block(s.kids, this.narrow(head, cond, true), final);
        return join([this.narrow(head, cond, false), ...loop.breaks]);
    }

    private statement(s: Stmt, env: Env, ctx: Ctx): Flow {
        switch (first(s)) {
            case TokenType.Var: {
                const d = declaration(s);
                if (!d) return env;
                const r = d.expr ? this.infer(s, d.expr, env, ctx) : { t: UNKNOWN };
                const t = r.failed ? UNKNOWN : r.t;
                const out = clone(env);
                out.vars.set(d.name, t);
                if (!ctx.silent && this.opts.record) this.recordType(s.line, d.nameTok.start, t);
                return out;
            }
            case TokenType.Global: {
                const d = declaration(s);
                if (!d) return env;
                const r = d.expr ? this.infer(s, d.expr, env, ctx) : { t: UNKNOWN };
                this.opts.contribute?.({ name: d.name, kind: 'assign', depth: 0, t: r.failed ? UNKNOWN : r.t });
                return env;
            }
            case TokenType.Set:
                return this.assign(s, env, ctx);
            case TokenType.Echo: {
                const e = echo(s);
                if (!e) return env;
                if (e.file) this.infer(s, e.file, env, ctx);
                const items = (e.items ?? []).map(n => ({ n, r: this.infer(s, n, env, ctx) }));
                if (e.redirect && this.opts.contribute && e.items) this.persistence(s, items, env, ctx);
                return env;
            }
            case TokenType.Abort: {
                const m = abortMessage(s);
                if (m) this.infer(s, m, env, ctx, ABORT_NOTE);
                return null;
            }
            case TokenType.Break:
            case TokenType.Continue:
                if (!ctx.loop) return env;
                (first(s) === TokenType.Break ? ctx.loop.breaks : ctx.loop.continues).push(clone(env));
                return null;
            case TokenType.GCode:
            case TokenType.TCode: {
                for (const g of gcodeGroups(s) ?? []) if (g) this.infer(s, g, env, ctx);
                return s.tokens[0].value.toUpperCase() === 'M99' ? null : env;
            }
            default:
                return env;
        }
    }

    private assign(s: Stmt, env: Env, ctx: Ctx): Flow {
        const a = assignment(s);
        if (!a) return env;
        const r = a.expr ? this.infer(s, a.expr, env, ctx) : { t: UNKNOWN };
        const t = r.failed ? UNKNOWN : r.t;
        const out = clone(env);
        if (a.indexes.length === 0) {
            if (a.scope === 'var') {
                if (out.vars.has(a.name)) out.vars.set(a.name, t);
            } else {
                out.globals.delete(a.name);
                this.opts.contribute?.({ name: a.name, kind: 'assign', depth: 0, t });
            }
            return out;
        }
        // Indexed assignment (TC-ARR-06): an array target, non-negative integer indices.
        const typer = this.typer(s, ctx);
        const scope = this.scope(env);
        const current = a.scope === 'var' ? env.vars.get(a.name) : scope.global(a.name);
        const report = (start: number, end: number, code: TypeDiag['code'], message: string) => {
            if (!ctx.silent && this.opts.report) this.result.diagnostics.push({ line: s.line, start, end, code, message, severity: 'error' });
        };
        if (current !== undefined && lacksAll(current, 'array')) {
            report(a.target.start, a.target.end, CODE.index,
                `'${a.target.value}' holds ${describe(current)}, not an array: the firmware stops with "${MSG.arrayExpected}"`);
        }
        for (const idx of a.indexes) {
            if (!idx) continue;
            const ir = typer.infer(idx, scope);
            if (ir.failed) continue;
            if (lacksAll(ir.t, 'int')) {
                report(idx.s.start, idx.s.end, CODE.index, `index must be a non-negative integer, got ${describe(ir.t)}: the firmware stops with "${MSG.nonNegativeInt}"`);
            } else if (ir.v && 'num' in ir.v && ir.v.num < 0) {
                report(idx.s.start, idx.s.end, CODE.value, `negative index ${ir.v.num}: the firmware stops with "${MSG.nonNegativeInt}"`);
            }
        }
        if (a.scope === 'var') {
            if (current !== undefined) out.vars.set(a.name, widenElements(current, a.indexes.length, t));
        } else {
            this.opts.contribute?.({ name: a.name, kind: 'elem', depth: a.indexes.length, t });
        }
        return out;
    }

    // ── Persistence writes: `echo >"…" "set global.X = " ^ E` (TC-GLB-02) ──

    private persistence(s: Stmt, items: Array<{ n: Node; r: R }>, env: Env, ctx: Ctx): void {
        const contribute = this.opts.contribute!;
        const mentioned = (text: string) => {
            for (const m of text.matchAll(/global\.([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/g)) {
                contribute({ name: m[1], kind: 'assign', depth: 0, t: UNKNOWN });
            }
        };
        const allTexts = (n: Node): string[] => {
            const out: string[] = [];
            const walk = (x: Node) => {
                if (x.k === 'str') out.push(x.text);
                else if (x.k === 'binary') { walk(x.l); walk(x.r); }
                else if (x.k === 'paren') walk(x.e);
                else if (x.k === 'brace') x.items.forEach(walk);
            };
            walk(n);
            return out;
        };
        if (items.length !== 1) {
            for (const { n } of items) allTexts(n).forEach(mentioned);
            return;
        }
        const pieces = concatPieces(items[0].n);
        const head = pieces[0];
        const HEAD = /^[ \t]*set[ \t]+global\.([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)[ \t]*/;
        const m = head && head.k === 'str' ? HEAD.exec(head.text) : null;
        if (!m) {
            allTexts(items[0].n).forEach(mentioned);
            return;
        }
        const name = m[1];
        const rest = (head as Node & { k: 'str' }).text.slice(m[0].length);
        const t = this.writtenType(s, name, rest, pieces.slice(1), env, ctx);
        if (t !== null) contribute({ name, kind: 'assign', depth: 0, t });
    }

    /** Type the written line gives `global.<name>`; null when it contributes nothing (backup idiom). */
    private writtenType(s: Stmt, name: string, rest: string, after: Node[], env: Env, ctx: Ctx): Ty | null {
        // Nothing after the value, or a string piece that starts a `;` comment (and everything after it).
        const commentOnly = (pieces: Node[]) => {
            if (pieces.length === 0) return true;
            const p = pieces[0];
            if (p.k !== 'str') return false;
            if (/^[ \t]*;/.test(p.text)) return true;
            return pieces.length === 1 && /^[ \t]*$/.test(p.text);
        };
        if (rest.trim() === '' && !/;/.test(rest)) {
            const [hole, ...tail] = after;
            if (!hole || hole.k === 'str' || !commentOnly(tail)) return UNKNOWN;
            const v = unwrap(hole);
            if (v.k === 'ident' && v.name === `global.${name}`) return null;
            const r = this.infer(s, hole, env, { ...ctx, silent: true });
            return writtenValue(r.failed ? UNKNOWN : r.t);
        }
        if (rest.trim() === '"') {
            const [hole, close, ...tail] = after;
            if (!hole || hole.k === 'str' || !close || close.k !== 'str' || !close.text.startsWith('"')) return UNKNOWN;
            const afterQuote = close.text.slice(1);
            if (!/^[ \t]*(;.*)?$/.test(afterQuote) || (tail.length && !/^[ \t]*;/.test(afterQuote))) return UNKNOWN;
            return prim('string');
        }
        // A literal written inside the string itself; a `;` there starts a comment.
        const lit = splitComment(rest);
        if (!lit.comment && after.length) return UNKNOWN;
        return literalText(lit.value.trim());
    }
}

/** Pieces of a left-associative `^` chain. */
function concatPieces(n: Node): Node[] {
    if (n.k === 'binary' && n.op === '^') return [...concatPieces(n.l), n.r];
    if (n.k === 'paren') return concatPieces(n.e);
    return [n];
}

/** What a value turns into when written unquoted into a file and read back by `set`. */
function writtenValue(t: Ty): Ty {
    if (isUnknown(t)) return t;
    if (atoms(t).some(a => typeof a !== 'string' || a === 'string' || a === 'char' || a === 'datetime' || a === 'object')) return UNKNOWN;
    return t;
}

function splitComment(text: string): { value: string; comment: boolean } {
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') inString = !inString;
        else if (text[i] === ';' && !inString) return { value: text.slice(0, i), comment: true };
    }
    return { value: text, comment: false };
}

/** Type of a literal as text (`0`, `1.5`, `true`, `null`, `"manual"`); unknown otherwise. */
function literalText(v: string): Ty {
    if (v === 'true' || v === 'false') return prim('bool');
    if (v === 'null') return prim('null');
    if (/^"(?:[^"]|"")*"$/.test(v)) return prim('string');
    const m = /^([+-]?)(0x[0-9a-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(v);
    if (!m) return UNKNOWN;
    const body = m[2].toLowerCase();
    if (!/^0[xb]/.test(body) && /[.e]/.test(body)) return prim('float');
    const n = body.startsWith('0x') ? parseInt(body.slice(2), 16) : body.startsWith('0b') ? parseInt(body.slice(2), 2) : Number(body);
    if (n <= 2147483647) return prim('int');
    if (n <= 4294967295) return m[1] === '-' ? UNKNOWN : prim('uint');
    return prim('float');
}

/** Type one document. */
export function runFlow(doc: Doc, opts: FlowOptions): FlowResult {
    const w = new Walker(opts);
    w.run(doc.roots);
    return w.result;
}

export { BOTTOM };
