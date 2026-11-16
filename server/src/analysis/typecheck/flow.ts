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
import { checkParamValue, checkLiteralValue, LiteralForm } from './params';
import { commandKey, isBuiltIn } from '../gcodeParams';
import { stringLiteralText } from '../argValidators';

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

/** A `{…}` expression of a G/M/T command line (braces included) and the parameter it is the value of. */
interface GValue {
    node: Node | null;
    /** Token index of its `{`. */
    at: number;
    /** The command word it belongs to: the line may hold several (`G91 G1 Z{…} G90`). */
    command: string;
    /** The parameter letter, or null when the value belongs to none (`M117 {…}`). */
    letter: string | null;
    /** An element after `:` (`X1:{…}`), not the start of the value. */
    element: boolean;
    /** A letter of `M98 P…` other than P, or of a plain `G29`: a parameter of the called macro, of any type. */
    macroArg: boolean;
}

/**
 * The macro file a command runs with its letters as parameters (GCodes::DoFileMacroWithParameters):
 * an RRF path (relative paths are under /sys), or a file the server cannot tell (`M98 P{…}`).
 */
export type Callee = { file: string } | { dynamic: true };

/** A call of a macro file: each letter and its value (a braced value's `{` token index, or the parsed tokens). */
interface MacroCall {
    callee: Callee;
    args: Array<{ letter: string; at: number; node: Node | null }>;
}

/** An unbraced parameter value (`F"test"`, `Y40`, `Ythermistor`), or a quoted element after `:`. */
interface GLiteral {
    command: string; letter: string; element: boolean; form: LiteralForm; text: string;
    start: number; end: number; macroArg: boolean;
}

interface GLine { values: GValue[]; calls: MacroCall[]; literals: GLiteral[] }

const NUMBER_START = new Set([TokenType.Integer, TokenType.Float, TokenType.HexInteger, TokenType.BinInteger, TokenType.Minus, TokenType.Plus]);

/** The end index (exclusive) of the run of tokens that touch each other from t[i]. */
function adjacentRun(t: Token[], i: number, end: number): number {
    let j = i + 1;
    while (j < end && t[j].start === t[j - 1].end && t[j].type !== TokenType.EOF && t[j].type !== TokenType.Comment) j++;
    return j;
}

/** The letter whose value the token at `i` continues, walking back over `1:{…}:` elements. */
function valueLetter(tokens: Token[], i: number): string | null {
    let depth = 0;
    for (let j = i - 1; j >= 0; j--) {
        const tt = tokens[j].type;
        if (tt === TokenType.RBrace) depth++;
        else if (tt === TokenType.LBrace) depth--;
        else if (depth > 0) continue;
        else if (tt === TokenType.GCodeWord) return tokens[j].value.toUpperCase();
        else if (tt !== TokenType.Colon && tt !== TokenType.Integer && tt !== TokenType.Float &&
            tt !== TokenType.HexInteger && tt !== TokenType.BinInteger && tt !== TokenType.Minus && tt !== TokenType.Plus) return null;
    }
    return null;
}

/**
 * The commands of a line as token ranges [start, end): a G or M word outside quotes and braces
 * starts the next command, a T further on is a parameter (StringParser::FindParameters).
 */
function commandSegments(t: Token[]): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    for (; i < t.length; i++) {
        const tt = t[i].type;
        if (tt === TokenType.EOF || tt === TokenType.Comment) break;
        if (tt === TokenType.LBrace) depth++;
        else if (tt === TokenType.RBrace && depth > 0) depth--;
        else if (tt === TokenType.GCode && depth === 0 && i > start) { out.push([start, i]); start = i; }
    }
    out.push([start, i]);
    return out;
}

/** Token types a parameter value of a macro call may start with (StringParser::AddParameters). */
const VALUE_START = new Set([TokenType.Integer, TokenType.Float, TokenType.HexInteger, TokenType.BinInteger,
    TokenType.StringLit, TokenType.LBrace, TokenType.Minus, TokenType.Plus]);

/** The macro a command segment runs with parameters, or null (TC-PRM-01). */
function macroCall(t: Token[], [start, end]: [number, number]): MacroCall | null {
    const word = t[start];
    if (word.type !== TokenType.GCode) return null;
    const command = commandKey(word.value);
    if (!command) return null;
    // The letters at brace depth 0, each with the token range of its value.
    const letters: Array<{ letter: string; from: number; to: number }> = [];
    let depth = 0;
    for (let i = start + 1; i < end; i++) {
        const tt = t[i].type;
        if (tt === TokenType.LBrace) depth++;
        else if (tt === TokenType.RBrace && depth > 0) depth--;
        else if (tt === TokenType.GCodeWord && depth === 0) {
            if (letters.length) letters[letters.length - 1].to = i;
            letters.push({ letter: t[i].value.toUpperCase(), from: i + 1, to: end });
        }
    }
    let callee: Callee;
    if (command === 'M98') {
        const p = letters.find(l => l.letter === 'P');
        if (!p) return null;
        const v = t.slice(p.from, p.to);
        const lit = v.length === 1 ? v[0] : v.length === 3 && v[0].type === TokenType.LBrace && v[2].type === TokenType.RBrace ? v[1] : null;
        const text = lit?.type === TokenType.StringLit ? stringLiteralText(lit) : null;
        callee = text ? { file: text.text } : { dynamic: true };
    } else if (command === 'G29') {
        if (letters.some(l => l.letter === 'S')) return null;     // G29 S… is built in; plain G29 runs mesh.g
        callee = { file: 'mesh.g' };
    } else if (command === 'G32') {
        callee = { file: 'bed.g' };
    } else if (!isBuiltIn(command)) {
        callee = { file: `${command}.g` };
    } else return null;
    const args: MacroCall['args'] = [];
    for (const l of letters) {
        if (command === 'M98' && l.letter === 'P') continue;      // M98 does not pass its P
        const v = t.slice(l.from, l.to);
        if (!v.length || !VALUE_START.has(v[0].type)) continue;  // "invalid value for parameter": the macro does not run
        args.push({ letter: l.letter, at: l.from, node: v[0].type === TokenType.LBrace ? null : parseExpression(v) });
    }
    return { callee, args };
}

const gcodeLine = (s: Stmt) => cached<GLine>(s, () => {
    const values: GValue[] = [];
    const literals: GLiteral[] = [];
    const t = s.tokens;
    const segs = commandSegments(t);
    const calls = segs.map(seg => macroCall(t, seg)).filter((c): c is MacroCall => c !== null);
    for (const [start, end] of segs) {
        const command = t[start]?.value ?? '';
        const key = commandKey(command);
        const has = (l: string) => t.slice(start + 1, end).some(x => x.type === TokenType.GCodeWord && x.value.toUpperCase() === l);
        // M98 P… and a plain G29 (which runs sys/mesh.g when it exists) pass their letters to a macro.
        const macroArgs = (key === 'M98' && has('P')) || (key === 'G29' && !has('S'));
        let depth = 0;
        let from = -1;
        for (let i = start; i < end; i++) {
            const tt = t[i].type;
            if (depth === 0 && i > start && tt !== TokenType.LBrace && tt !== TokenType.EOF && tt !== TokenType.Comment) {
                const before = t[i - 1];
                const atValue = before.type === TokenType.GCodeWord && t[i].start === before.end;
                const letter = atValue ? before.value.toUpperCase() : before.type === TokenType.Colon ? valueLetter(t, i) : null;
                const form: LiteralForm | null = tt === TokenType.StringLit ? 'quoted'
                    : before.type === TokenType.Colon ? null
                        : NUMBER_START.has(tt) ? 'number' : tt === TokenType.GCodeWord || tt === TokenType.Identifier ? 'word' : null;
                if (letter && form) {
                    const stop = form === 'quoted' ? i + 1 : adjacentRun(t, i, end);
                    literals.push({
                        command, letter, element: before.type === TokenType.Colon, form,
                        text: s.text.slice(t[i].start, t[stop - 1].end),
                        start: t[i].start, end: t[stop - 1].end, macroArg: macroArgs && letter !== 'P',
                    });
                }
            }
            if (tt === TokenType.LBrace && depth++ === 0) from = i;
            else if (tt === TokenType.RBrace && depth > 0 && --depth === 0) {
                const before = t[from - 1];
                let letter: string | null = null;
                let element = false;
                if (before?.type === TokenType.GCodeWord) letter = before.value.toUpperCase();
                // `T{…}` is read as `T T{…}` (StringParser::DecodeCommand).
                else if (from === 1 && before.type === TokenType.TCode && before.value.toUpperCase() === 'T') letter = 'T';
                else if (before?.type === TokenType.Colon) { letter = valueLetter(t, from); element = letter !== null; }
                values.push({ node: parseExpression(t.slice(from, i + 1)), at: from, command, letter, element, macroArg: macroArgs && letter !== 'P' });
            }
        }
    }
    return { values, calls, literals };
});

/** The macro calls of a document, without types: which files it runs (TC-PRM-01). */
export function docCalls(doc: Doc): Array<{ line: number; callee: Callee; letters: string[] }> {
    const out: Array<{ line: number; callee: Callee; letters: string[] }> = [];
    const walk = (stmts: Stmt[]) => {
        for (const s of stmts) {
            const tt = first(s);
            if (tt === TokenType.GCode) for (const c of gcodeLine(s)?.calls ?? []) out.push({ line: s.line, callee: c.callee, letters: c.args.map(a => a.letter) });
            walk(s.kids);
        }
    };
    walk(doc.roots);
    return out;
}

const abortMessage = (s: Stmt) => cached(s, () => parseExpression(cut(s.tokens.slice(1))));

// ── Environments ────────────────────────────────────────────────────────────

interface Env {
    vars: Map<string, Ty>;
    /** Null-narrowed globals (overrides of the workspace type). */
    globals: Map<string, Ty>;
    /** Null-narrowed macro parameters (overrides of what the callers pass). */
    params: Map<string, Ty>;
}
type Flow = Env | null;

const clone = (e: Env): Env => ({ vars: new Map(e.vars), globals: new Map(e.globals), params: new Map(e.params) });

function join(flows: Flow[]): Flow {
    const live = flows.filter((f): f is Env => f !== null);
    if (live.length === 0) return null;
    if (live.length === 1) return clone(live[0]);
    const out: Env = { vars: new Map(), globals: new Map(), params: new Map() };
    for (const [name] of live[0].vars) {
        if (live.every(e => e.vars.has(name))) out.vars.set(name, union(...live.map(e => e.vars.get(name)!)));
    }
    for (const [name] of live[0].globals) {
        if (live.every(e => e.globals.has(name))) out.globals.set(name, union(...live.map(e => e.globals.get(name)!)));
    }
    for (const [name] of live[0].params) {
        if (live.every(e => e.params.has(name))) out.params.set(name, union(...live.map(e => e.params.get(name)!)));
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

export type Contribution =
    | {
        name: string;
        /** `assign`: the global may hold `t`; `elem`: its elements `depth` levels down may. */
        kind: 'assign' | 'elem';
        depth: number;
        t: Ty;
    }
    /** A macro call on `line`: the file it runs and the type of each parameter it passes. */
    | { kind: 'call'; callee: Callee; line: number; args: Array<[string, Ty]> };

export interface FlowOptions {
    version: Version | null;
    sbc?: boolean;
    globals(name: string): Ty;
    /** Type of `param.<name>` in this document (TC-PRM-01); unknown when absent. */
    params?(name: string): Ty;
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
            sbc: this.opts.sbc,
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
            param: n => env.params.get(n) ?? this.opts.params?.(n) ?? UNKNOWN,
        };
    }

    private infer(s: Stmt, n: Node, env: Env, ctx: Ctx, note?: string): R {
        return this.typer(s, ctx, note).infer(n, this.scope(env));
    }

    /** The types a macro call passes (TC-PRM-01): a braced value as typed, an unbraced one parsed as the firmware does. */
    private call(s: Stmt, c: MacroCall, braced: Map<number, R>, env: Env, ctx: Ctx): void {
        const args: Array<[string, Ty]> = c.args.map(a => {
            const r = braced.get(a.at) ?? (a.node ? this.typer(s, { ...ctx, silent: true }).infer(a.node, this.scope(env)) : null);
            return [a.letter, !r || r.failed ? UNKNOWN : r.t];
        });
        this.opts.contribute!({ kind: 'call', callee: c.callee, line: s.line, args });
    }

    /** A braced parameter value the firmware rejects for its letter (TC-GC-02..05). */
    private parameter(s: Stmt, command: string, v: GValue, r: R, ctx: Ctx): void {
        if (ctx.silent || !this.opts.report || r.failed || !v.node || !v.letter) return;
        const message = checkParamValue(command, v.letter, v.element, r.t, this.opts.version, this.opts.sbc ?? false);
        if (!message) return;
        // The range is the expression inside the braces.
        const inner = v.node.k === 'brace' && v.node.items.length
            ? { start: v.node.items[0].s.start, end: v.node.items[v.node.items.length - 1].s.end }
            : v.node.s;
        this.result.diagnostics.push({ line: s.line, start: inner.start, end: inner.end, code: CODE.argument, severity: 'error', message });
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
            } else if (f.key.startsWith('param.')) {
                const n = f.key.slice(6);
                out.params.set(n, applyFact(out.params.get(n) ?? this.opts.params?.(n) ?? UNKNOWN, f.toNull));
            } else {
                const n = f.key.slice(7);
                out.globals.set(n, applyFact(out.globals.get(n) ?? this.opts.globals(n), f.toNull));
            }
        }
        return out;
    }

    run(roots: Stmt[]): void {
        this.seq(roots, { vars: new Map(), globals: new Map(), params: new Map() }, { loop: null, silent: false });
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
                // A declaration whose value fails stops the macro there: later lines see no value.
                const r = d.expr ? this.infer(s, d.expr, env, ctx) : null;
                const t = !r || r.failed ? BOTTOM : r.t;
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
                const g = gcodeLine(s);
                const braced = new Map<number, R>();
                for (const v of g?.values ?? []) {
                    if (!v.node) continue;
                    const r = this.infer(s, v.node, env, ctx);
                    braced.set(v.at, r);
                    const command = commandKey(v.command);
                    if (command && v.letter && !v.macroArg) this.parameter(s, command, v, r, ctx);
                }
                if (this.opts.contribute) for (const c of g?.calls ?? []) this.call(s, c, braced, env, ctx);
                if (!ctx.silent && this.opts.report) {
                    for (const q of g?.literals ?? []) {
                        const command = commandKey(q.command);
                        const message = command && !q.macroArg
                            ? checkLiteralValue(command, q.letter, q.element, q.form, q.text, this.opts.version, this.opts.sbc ?? false) : null;
                        if (message) this.result.diagnostics.push({ line: s.line, start: q.start, end: q.end, code: CODE.argument, severity: 'error', message });
                    }
                }
                return s.tokens[0].value.toUpperCase() === 'M99' ? null : env;
            }
            default:
                return env;
        }
    }

    private assign(s: Stmt, env: Env, ctx: Ctx): Flow {
        const a = assignment(s);
        if (!a) return env;
        const r = a.expr ? this.infer(s, a.expr, env, ctx) : null;
        // A failing value stops the macro at this line: for later lines of this file there is no
        // value (bottom); for the workspace type of a global it is simply not known.
        const dead = !r || r.failed;
        const t = dead ? UNKNOWN : r.t;
        const local = dead ? BOTTOM : r.t;
        const out = clone(env);
        if (a.indexes.length === 0) {
            if (a.scope === 'var') {
                if (out.vars.has(a.name)) out.vars.set(a.name, local);
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
            if (current !== undefined) out.vars.set(a.name, widenElements(current, a.indexes.length, local));
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
