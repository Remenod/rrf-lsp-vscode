// analysis/typecheck/infer.ts
// Types one expression tree and reports the errors the firmware would raise.
//
// Transcribed from RepRapFirmware ExpressionParser.cpp (tag 3.5.4-vm.1):
// ParseInternal, BalanceNumericTypes, BalanceTypes, ApplyLengthOperator and
// ParseIdentifierExpression.  Only *definite* errors are reported
// (TC-DIAG-08): every combination of the operands' possible types must fail,
// and an `unknown` operand never fails.

import { Node, BinOp, Span, unwrap } from './ast';
import {
    Ty, Kind, Atom, UNKNOWN, BOTTOM, NUMBER, prim, arrayOf, union, atoms, kindOf, isUnknown, isBottom,
    lacksAll, hasKind, describe,
} from './types';
import { Version, functionMissing, constantMissing, stringIndexing } from './versions';
import { omType } from './om';

// ── Diagnostic codes and firmware texts ─────────────────────────────────────

export const CODE = {
    operand: 'rrf-type-operand',
    boolean: 'rrf-type-boolean',
    argument: 'rrf-type-argument',
    index: 'rrf-type-index',
    value: 'rrf-type-value',
    version: 'rrf-version',
    skipped: 'rrf-skipped-operand',
} as const;
export type Code = typeof CODE[keyof typeof CODE];

export const MSG = {
    numericOperand: 'expected numeric operand',
    numericOperands: 'expected numeric operands',
    invalidOperandTypes: 'invalid operand types',
    boolean: 'expected Boolean operand',
    cannotConvert: 'cannot convert operands to same type',
    comparison: 'expected numeric or Boolean operands to comparison operator',
    equality: 'unexpected operand type to equality operator',
    compareObjects: 'cannot compare objects',
    unaryMinus: "expected numeric value after '-'",
    unaryPlus: "expected numeric or enumeration value after '+'",
    length: 'operand of # is not an array or string',
    notArray: 'operand is not an array',
    noElements: 'array has no elements',
    positiveInt: 'expected positive integer',
    nonNegativeInt: 'expected non-negative integer',
    toDateTime: "can't convert value to DateTime",
    badDateString: 'string is not a valid date and time',
    stringOperand: 'expected string operand',
    charOperand: 'expected character operand',
    integerExpr: 'expected integer expression',
    indexRange: 'Index out of range',
    unknownFunction: 'unknown function',
    notArrayOrString: 'first operand of function is not an array or string',
    notString: 'first operand of function is not a string',
    incompatible: 'incompatible operand types',
    leftNotArray: 'left operand of [ ] is not an array',
    arrayExpected: 'Expected an array expression',
} as const;

export interface TypeDiag {
    line: number;
    start: number;
    end: number;
    code: Code;
    message: string;
    severity: 'error' | 'warning';
}

/**
 * Evaluation mode of an operand (SPEC §9): `yes` — evaluated; `maybe` — the
 * firmware may skip it (right of `&&`/`||`, a `?:` branch); `no` — always
 * skipped (decided by a literal).  Skipped operands are parsed with
 * evaluate == false: most errors vanish, but identifiers read as null and a
 * few checks run unconditionally.
 */
export type Mode = 'yes' | 'maybe' | 'no';

export interface Scope {
    /** Type of `var.<name>` here; undefined when it is not declared. */
    local(name: string): Ty | undefined;
    global(name: string): Ty;
}

export interface InferOptions {
    line: number;
    lineText: string;
    version: Version | null;
    /** null: type silently (fixed-point passes, global solving). */
    report: ((d: TypeDiag) => void) | null;
    /** Called with the type of every var./global./param. reference, for hover. */
    record: ((start: number, t: Ty) => void) | null;
    /** Message suffix for errors inside an `abort` message (TC-STMT-03). */
    note?: string;
}

type Const = { num: number } | { str: string } | { bool: boolean } | { nul: true };

export interface R {
    t: Ty;
    v?: Const;
    /** The node (or a part of it) already produced an error: parents stay silent (TC-DIAG-05). */
    failed?: boolean;
}

const FAILED: R = { t: UNKNOWN, failed: true };

// ── Narrowing (TC-FLOW-09) ──────────────────────────────────────────────────

export interface NarrowFact { key: string; toNull: boolean }

/** What a condition being `truthy` tells about `var.`/`global.` values compared with null. */
export function narrowFacts(n: Node, truthy: boolean): NarrowFact[] {
    const e = unwrap(n);
    if (e.k === 'unary' && e.op === '!') return narrowFacts(e.arg, !truthy);
    if (e.k !== 'binary') return [];
    if (e.op === '&&') return truthy ? [...narrowFacts(e.l, true), ...narrowFacts(e.r, true)] : [];
    if (e.op === '||') return truthy ? [] : [...narrowFacts(e.l, false), ...narrowFacts(e.r, false)];
    if (e.op !== '==' && e.op !== '!=') return [];
    const l = unwrap(e.l), r = unwrap(e.r);
    const isNull = (x: Node) => x.k === 'const' && x.name === 'null';
    const subject = isNull(r) ? l : isNull(l) ? r : null;
    if (!subject || subject.k !== 'ident') return [];
    if (!subject.name.startsWith('var.') && !subject.name.startsWith('global.')) return [];
    const equalsNull = e.op === '==';
    return [{ key: subject.name, toNull: equalsNull === truthy }];
}

export function applyFact(t: Ty, toNull: boolean): Ty {
    if (isUnknown(t)) return t;
    const out = t.filter(a => (a === 'null') === toNull);
    return out.length === 0 ? UNKNOWN : out;
}

export function narrowScope(scope: Scope, facts: NarrowFact[]): Scope {
    if (facts.length === 0) return scope;
    const apply = (k: string, t: Ty | undefined): Ty | undefined => {
        if (t === undefined) return t;
        let out = t;
        for (const f of facts) if (f.key === k) out = applyFact(out, f.toNull);
        return out;
    };
    return {
        local: n => apply(`var.${n}`, scope.local(n)),
        global: n => apply(`global.${n}`, scope.global(n))!,
    };
}

// ── Operator tables ─────────────────────────────────────────────────────────

type AR = { ok: Ty } | { err: string };

const isNum = (k: Kind) => k === 'int' || k === 'uint' || k === 'float';

/** BalanceNumericTypes: uint becomes float first; then float wins; int with int stays int. */
function balanceNumeric(a: Kind, b: Kind): AR {
    const x = a === 'uint' ? 'float' : a;
    const y = b === 'uint' ? 'float' : b;
    if (x === 'float') return isNum(y) ? { ok: prim('float') } : { err: MSG.numericOperand };
    if (y === 'float') return isNum(x) ? { ok: prim('float') } : { err: MSG.numericOperand };
    if (x === 'int' && y === 'int') return { ok: prim('int') };
    return { err: MSG.numericOperands };
}

/** Types without a literal form: they balance against strings by conversion to string. */
const noLiterals = (k: Kind) => k === 'char' || k === 'datetime';

/** BalanceTypes, step by step. */
function balanceTypes(a: Kind, b: Kind): { c: Kind } | { err: string } {
    const x = a === 'uint' ? 'float' : a;
    const y = b === 'uint' ? 'float' : b;
    if (x === y) return { c: x };
    if (x === 'float') return isNum(y) ? { c: 'float' } : { err: MSG.numericOperand };
    if (y === 'float') return isNum(x) ? { c: 'float' } : { err: MSG.numericOperand };
    if (y === 'string' && noLiterals(x)) return { c: 'string' };
    if (x === 'string' && noLiterals(y)) return { c: 'string' };
    return { err: MSG.cannotConvert };
}

function binaryKinds(op: BinOp, a: Kind, b: Kind): AR {
    switch (op) {
        case '+':
        case '-':
            if (a === 'datetime') {
                if (b === 'int' || b === 'uint') return { ok: prim('datetime') };
                if (op === '-' && b === 'datetime') return { ok: prim('int') };
                return { err: MSG.invalidOperandTypes };
            }
            return balanceNumeric(a, b);
        case '*':
            return balanceNumeric(a, b);
        case '/':
            return isNum(a) && isNum(b) ? { ok: prim('float') } : { err: MSG.numericOperand };
        case '^':
            return { ok: prim('string') };
        case '<': case '>': case '<=': case '>=': {
            const c = balanceTypes(a, b);
            if ('err' in c) return c;
            return ['int', 'float', 'datetime', 'bool'].includes(c.c) ? { ok: prim('bool') } : { err: MSG.comparison };
        }
        case '==': case '!=': {
            if (a === 'null' || b === 'null') return { ok: prim('bool') };
            const c = balanceTypes(a, b);
            if ('err' in c) return c;
            if (c.c === 'object') return { err: MSG.compareObjects };
            return ['int', 'float', 'datetime', 'bool', 'string'].includes(c.c) ? { ok: prim('bool') } : { err: MSG.equality };
        }
        case '&&': case '||':
            return a === 'bool' && b === 'bool' ? { ok: prim('bool') } : { err: MSG.boolean };
    }
}

/** Result type of an operator whatever its operands are, when it has one. */
function fixedResult(op: BinOp): Ty {
    switch (op) {
        case '^': return prim('string');
        case '/': return prim('float');
        case '<': case '>': case '<=': case '>=': case '==': case '!=': case '&&': case '||': return prim('bool');
        default: return UNKNOWN;
    }
}

function kinds(t: Ty): Kind[] {
    return [...new Set(atoms(t).map(kindOf))];
}

/** Every combination of the operand kinds: the union of successes, or the first error. */
function combine(op: BinOp, l: Ty, r: Ty): AR {
    if (isUnknown(l) || isUnknown(r)) return { ok: fixedResult(op) };
    if (isBottom(l) || isBottom(r)) return { ok: BOTTOM };
    const oks: Ty[] = [];
    let first: string | undefined;
    for (const a of kinds(l)) for (const b of kinds(r)) {
        const res = binaryKinds(op, a, b);
        if ('ok' in res) oks.push(res.ok); else first ??= res.err;
    }
    return oks.length ? { ok: union(...oks) } : { err: first! };
}

function unaryKind(op: '-' | '+' | '!' | '#', k: Kind): AR {
    switch (op) {
        case '-': return k === 'int' || k === 'float' ? { ok: prim(k) } : { err: MSG.unaryMinus };
        case '+':
            if (k === 'int' || k === 'float') return { ok: prim(k) };
            if (k === 'uint' || k === 'datetime') return { ok: prim('int') };
            return { err: MSG.unaryPlus };
        case '!': return k === 'bool' ? { ok: prim('bool') } : { err: MSG.boolean };
        case '#': return k === 'string' || k === 'array' ? { ok: prim('int') } : { err: MSG.length };
    }
}

function combineUnary(op: '-' | '+' | '!' | '#', t: Ty): AR {
    if (isUnknown(t)) return { ok: op === '!' ? prim('bool') : op === '#' ? prim('int') : UNKNOWN };
    if (isBottom(t)) return { ok: BOTTOM };
    const oks: Ty[] = [];
    let first: string | undefined;
    for (const k of kinds(t)) {
        const res = unaryKind(op, k);
        if ('ok' in res) oks.push(res.ok); else first ??= res.err;
    }
    return oks.length ? { ok: union(...oks) } : { err: first! };
}

// ── Literals ────────────────────────────────────────────────────────────────

/** NumericConverter: Int32 range → int, Uint32 range → uint, otherwise float. */
function numberLiteral(text: string): { t: Ty; v: number } {
    const lower = text.toLowerCase();
    let v: number;
    if (lower.startsWith('0x')) v = parseInt(lower.slice(2), 16);
    else if (lower.startsWith('0b')) v = parseInt(lower.slice(2), 2);
    else v = Number(text);
    const isFloat = !/^0[xb]/.test(lower) && /[.e]/.test(lower);
    if (isFloat) return { t: prim('float'), v };
    if (v <= 2147483647) return { t: prim('int'), v };
    if (v <= 4294967295) return { t: prim('uint'), v };
    return { t: prim('float'), v };
}

/** SafeStrptime as used by datetime(): `N-N-NTN:N:N`, N = blanks, optional sign, digits. */
const DATE_RE = /^([ \t]*[+-]?\d+)-([ \t]*[+-]?\d+)-([ \t]*[+-]?\d+)T([ \t]*[+-]?\d+):([ \t]*[+-]?\d+):([ \t]*[+-]?\d+)/;

const QUALIFIED = /^(var|global|param)\./;

/** An identifier expression: a name with optional `[i]` / `.field` steps. */
function identRoot(n: Node): (Node & { k: 'ident' }) | null {
    let e = n;
    for (; ;) {
        if (e.k === 'ident') return e;
        if (e.k === 'index' || e.k === 'field') e = e.base;
        else return null;
    }
}

/** Normalised object-model path (`move.axes[].homed`) of an identifier expression. */
function omPath(n: Node): string | null {
    if (n.k === 'ident') return QUALIFIED.test(n.name) ? null : n.name;
    if (n.k === 'field') { const b = omPath(n.base); return b === null ? null : `${b}.${n.name}`; }
    if (n.k === 'index') { const b = omPath(n.base); return b === null ? null : `${b}[]`; }
    return null;
}

/** Operands that read as null in a skipped operand: identifiers, `(identifier)`, `#identifier`. */
function readsNullWhenSkipped(n: Node): boolean {
    if (n.k === 'paren') return readsNullWhenSkipped(n.e);
    if (n.k === 'unary' && n.op === '#') return readsNullWhenSkipped(n.arg);
    return identRoot(n) !== null;
}

// ── The typer ───────────────────────────────────────────────────────────────

export class Typer {
    constructor(private readonly o: InferOptions) { }

    private text(s: Span): string { return this.o.lineText.slice(s.start, s.end); }

    private emit(code: Code, s: Span, message: string, severity: 'error' | 'warning' = 'error'): void {
        if (!this.o.report) return;
        const note = this.o.note && severity === 'error' && code !== CODE.skipped ? this.o.note : '';
        this.o.report({ line: this.o.line, start: s.start, end: s.end, code, message: message + note, severity });
    }

    /** An evaluation-dependent error: not raised when the operand is skipped. */
    private fail(mode: Mode, code: Code, s: Span, message: string): R {
        if (mode !== 'no') this.emit(code, s, message);
        return FAILED;
    }

    infer(n: Node, scope: Scope, mode: Mode = 'yes'): R {
        switch (n.k) {
            case 'num': {
                const { t, v } = numberLiteral(n.text);
                return { t, v: { num: v } };
            }
            case 'str': return { t: prim('string'), v: { str: n.text } };
            case 'char': return { t: prim('char') };
            case 'const': return this.constant(n);
            case 'opaque': return { t: UNKNOWN };
            case 'paren': return this.infer(n.e, scope, mode);
            case 'brace': {
                const items = n.items.map(i => this.infer(i, scope, mode));
                if (!n.array) return items[0];
                const elem = items.some(i => i.failed) ? UNKNOWN : union(...items.map(i => i.t));
                return { t: arrayOf(elem, true, items.length) };
            }
            case 'ident': return this.ident(n, scope);
            case 'field': return this.field(n, scope, mode);
            case 'index': return this.index(n, scope, mode);
            case 'call': return this.call(n, scope, mode);
            case 'unary': return this.unary(n, scope, mode);
            case 'binary': return this.binary(n, scope, mode);
            case 'cond': return this.conditional(n, scope, mode);
        }
    }

    private constant(n: Node & { k: 'const' }): R {
        switch (n.name) {
            case 'true': return { t: prim('bool'), v: { bool: true } };
            case 'false': return { t: prim('bool'), v: { bool: false } };
            case 'null': return { t: prim('null'), v: { nul: true } };
            case 'pi': return { t: prim('float') };
            case 'iterations': case 'line': case 'result': return { t: prim('int') };
            case 'input': {
                const added = constantMissing('input', this.o.version);
                if (added) {
                    this.emit(CODE.version, n.s,
                        `'input' is not available on RepRapFirmware ${this.o.version!.text}: it was added in ${added} ` +
                        `(the firmware reports "unknown value 'input'")`);
                    return FAILED;
                }
                return { t: UNKNOWN };
            }
            default: return { t: UNKNOWN };
        }
    }

    private ident(n: Node & { k: 'ident' }, scope: Scope): R {
        let t: Ty;
        if (n.name.startsWith('var.')) t = scope.local(n.name.slice(4)) ?? UNKNOWN;
        else if (n.name.startsWith('global.')) t = scope.global(n.name.slice(7));
        else if (n.name.startsWith('param.')) t = UNKNOWN;
        else return { t: omType(n.name) };
        this.o.record?.(n.s.start, t);
        return { t };
    }

    private field(n: Node & { k: 'field' }, scope: Scope, mode: Mode): R {
        const base = this.infer(n.base, scope, mode);
        if (base.failed) return FAILED;
        const path = omPath(n);
        return { t: path === null ? UNKNOWN : omType(path) };
    }

    private requireInt(idx: R, at: Node, mode: Mode, text: string): boolean {
        if (idx.failed || !lacksAll(idx.t, 'int')) return true;
        this.fail(mode, CODE.index, at.s, `index must be an integer, got ${describe(idx.t)}: the firmware stops with "${text}"`);
        return false;
    }

    private index(n: Node & { k: 'index' }, scope: Scope, mode: Mode): R {
        const root = identRoot(n.base);
        if (root) return this.identIndex(n, root, scope, mode);
        // A bracketed expression: `{1, 2}[0]`, `(var.a)[0]`, `("abc")[0]`.
        const base = this.infer(n.base, scope, mode);
        const idx = this.infer(n.index, scope, mode);
        if (n.base.k === 'call') return { t: UNKNOWN };   // the firmware cannot index a function result
        if (!this.requireInt(idx, n.index, mode, MSG.nonNegativeInt)) return FAILED;
        if (idx.v && 'num' in idx.v && idx.v.num < 0) {
            return this.fail(mode, CODE.value, n.index.s, `negative index ${idx.v.num}: the firmware stops with "${MSG.nonNegativeInt}"`);
        }
        if (base.failed || idx.failed) return FAILED;
        const strings = stringIndexing(this.o.version);
        const allowed: Kind[] = strings === false ? ['array'] : ['array', 'string'];
        if (lacksAll(base.t, ...allowed)) {
            return this.fail(mode, CODE.index, n.base.s,
                `cannot index ${describe(base.t)}${strings === false && hasKind(base.t, 'string') ? ` (string indexing needs RepRapFirmware 3.6.0-beta.4)` : ''}: ` +
                `the firmware stops with "${MSG.leftNotArray}"`);
        }
        return { t: this.elements(base.t, strings !== false) };
    }

    private elements(t: Ty, withStrings: boolean): Ty {
        if (isUnknown(t)) return UNKNOWN;
        const out: Ty[] = [];
        for (const a of t) {
            if (typeof a !== 'string') out.push(a.elem);
            else if (a === 'string' && withStrings) out.push(prim('char'));
        }
        return union(...out);
    }

    private identIndex(n: Node & { k: 'index' }, root: Node & { k: 'ident' }, scope: Scope, mode: Mode): R {
        const base = this.infer(n.base, scope, mode);
        const idx = this.infer(n.index, scope, mode);
        if (!this.requireInt(idx, n.index, mode, MSG.integerExpr)) return FAILED;
        const qualified = QUALIFIED.exec(root.name);
        if (!qualified) {
            // Object-model collection.
            if (base.failed || idx.failed) return FAILED;
            const path = omPath(n);
            return { t: path === null ? UNKNOWN : omType(path) };
        }
        if (idx.v && 'num' in idx.v && idx.v.num < 0) {
            return this.fail(mode, CODE.value, n.index.s, `negative index ${idx.v.num}: the firmware stops with "${MSG.indexRange}"`);
        }
        if (base.failed || idx.failed) return FAILED;
        if (lacksAll(base.t, 'array')) {
            const name = root.name.slice(qualified[0].length);
            return this.fail(mode, CODE.index, root.s,
                `'${root.name}' holds ${describe(base.t)}, not an array: the firmware stops with ` +
                `"Cannot index into variable or parameter '${name}' of non-array type"`);
        }
        if (idx.v && 'num' in idx.v && !isUnknown(base.t)) {
            const arrays = base.t.filter(a => typeof a !== 'string') as Exclude<Atom, string>[];
            if (arrays.length === base.t.length && arrays.every(a => a.len !== undefined && idx.v && 'num' in idx.v && idx.v.num >= a.len)) {
                return this.fail(mode, CODE.value, n.index.s,
                    `index ${idx.v.num} is past the end of the array (length ${arrays[0].len}): the firmware stops with "${MSG.indexRange}"`);
            }
        }
        return { t: this.elements(base.t, false) };
    }

    private unary(n: Node & { k: 'unary' }, scope: Scope, mode: Mode): R {
        if (n.op === '#') return this.length(n, scope, mode);
        const arg = this.infer(n.arg, scope, mode);
        if ((n.op === '-' || n.op === '+') && mode !== 'yes' && readsNullWhenSkipped(n.arg)) {
            this.skippedHazard(n, mode, n.op === '-' ? MSG.unaryMinus : MSG.unaryPlus,
                `'${n.op}${this.text(n.arg.s)}' fails when this operand is skipped, because skipped identifiers read as null`,
                n.op === '-' ? `write '0 - ${this.text(n.arg.s)}' or '${this.text(n.arg.s)} * -1'` : `write '0 + ${this.text(n.arg.s)}'`);
            if (mode === 'no') return FAILED;
        }
        if (arg.failed) return FAILED;
        if (n.op === '!' && arg.v && 'bool' in arg.v) return { t: prim('bool'), v: { bool: !arg.v.bool } };
        const res = combineUnary(n.op, arg.t);
        if ('err' in res) {
            const code = n.op === '!' ? CODE.boolean : CODE.operand;
            const message = `'${n.op}' cannot be applied to ${describe(arg.t)}: the firmware stops with "${res.err}"`;
            // Unary minus and plus check their operand even when it is skipped (TC-SC-01).
            if (n.op === '!') return this.fail(mode, code, n.s, message);
            this.emit(code, n.s, message);
            return FAILED;
        }
        if (n.op === '-' && arg.v && 'num' in arg.v) return { t: res.ok, v: { num: -arg.v.num } };
        return { t: res.ok };
    }

    private length(n: Node & { k: 'unary' }, scope: Scope, mode: Mode): R {
        const a = n.arg;
        // `#` written directly before a function call or a named constant is ignored (TC-UN-05/06).
        if (a.k === 'call' || a.k === 'const') {
            const r = this.infer(a, scope, mode);
            this.emit(CODE.operand, n.opS,
                a.k === 'call'
                    ? `'#' before a function call has no effect: the firmware ignores it — write #(${this.text(a.s)})`
                    : `'#' before the constant '${a.name}' has no effect: the firmware ignores it`,
                'warning');
            return r;
        }
        const arg = this.infer(a, scope, mode);
        if (arg.failed) return FAILED;
        // `#` directly before an object-model path never fails (TC-OM-05).
        if (omPath(a) !== null && a.k !== 'paren') {
            if (isUnknown(arg.t)) return { t: UNKNOWN };
            const lengthy = arg.t.some(x => x === 'string' || typeof x !== 'string');
            const rest = arg.t.filter(x => x !== 'string' && typeof x === 'string');
            return { t: lengthy ? union(prim('int'), rest) : arg.t };
        }
        const res = combineUnary('#', arg.t);
        if ('err' in res) return this.fail(mode, CODE.operand, n.s, `'#' cannot be applied to ${describe(arg.t)}: the firmware stops with "${res.err}"`);
        return { t: res.ok };
    }

    private requireBool(r: R, at: Node, mode: Mode): void {
        if (r.failed || !lacksAll(r.t, 'bool')) return;
        this.fail(mode, CODE.boolean, at.s, `expected a Boolean, got ${describe(r.t)}: the firmware stops with "${MSG.boolean}"`);
    }

    /** Mode of an operand the firmware skips when `decider` has the literal value `skipOn`. */
    private dependentMode(mode: Mode, decider: R, skipOn: boolean): Mode {
        if (mode === 'no') return 'no';
        if (decider.v && 'bool' in decider.v) return decider.v.bool === skipOn ? 'no' : mode;
        return 'maybe';
    }

    private binary(n: Node & { k: 'binary' }, scope: Scope, mode: Mode): R {
        if (n.op === '&&' || n.op === '||') {
            const l = this.infer(n.l, scope, mode);
            this.requireBool(l, n.l, mode);
            const rMode = this.dependentMode(mode, l, n.op === '||');
            const r = this.infer(n.r, narrowScope(scope, narrowFacts(n.l, n.op === '&&')), rMode);
            this.requireBool(r, n.r, rMode);
            if (l.v && 'bool' in l.v && r.v && 'bool' in r.v) {
                return { t: prim('bool'), v: { bool: n.op === '&&' ? l.v.bool && r.v.bool : l.v.bool || r.v.bool } };
            }
            return { t: prim('bool') };
        }
        const l = this.infer(n.l, scope, mode);
        const r = this.infer(n.r, scope, mode);
        if (l.failed || r.failed) return FAILED;
        const res = combine(n.op, l.t, r.t);
        if ('err' in res) {
            const hint = n.op === '+' && hasKind(l.t, 'string') && hasKind(r.t, 'string') ? ` — use '^' to join strings` : '';
            return this.fail(mode, CODE.operand, n.s,
                `'${n.op}' cannot be applied to ${describe(l.t)} and ${describe(r.t)}: the firmware stops with "${res.err}"${hint}`);
        }
        return { t: res.ok };
    }

    private conditional(n: Node & { k: 'cond' }, scope: Scope, mode: Mode): R {
        const c = this.infer(n.c, scope, mode);
        this.requireBool(c, n.c, mode);
        const aMode = this.dependentMode(mode, c, false);
        const bMode = this.dependentMode(mode, c, true);
        const a = this.infer(n.a, narrowScope(scope, narrowFacts(n.c, true)), aMode);
        const b = this.infer(n.b, narrowScope(scope, narrowFacts(n.c, false)), bMode);
        if (c.v && 'bool' in c.v) return c.v.bool ? a : b;
        if (a.failed || b.failed) return FAILED;
        return { t: union(a.t, b.t) };
    }

    // ── Functions ───────────────────────────────────────────────────────────

    private skippedHazard(n: Node, mode: Mode, firmware: string, what: string, fix: string): void {
        this.emit(CODE.skipped, n.s,
            `${what}: the firmware stops with "${firmware}" ${mode === 'no' ? 'every time' : 'whenever the operand is skipped'} — ${fix}`,
            mode === 'no' ? 'error' : 'warning');
    }

    private call(n: Node & { k: 'call' }, scope: Scope, mode: Mode): R {
        if (n.name === 'exists') return { t: prim('bool') };
        const added = functionMissing(n.name, this.o.version);
        const args = n.args.map(a => this.infer(a, scope, mode));
        if (added) {
            this.emit(CODE.version, n.nameS,
                `'${n.name}' is not available on RepRapFirmware ${this.o.version!.text}: it was added in ${added} ` +
                `(the firmware reports "${MSG.unknownFunction}")`);
            return FAILED;
        }
        if (n.name === 'fileread' && mode !== 'yes') {
            this.emit(CODE.skipped, n.s,
                `fileread() opens the file even when this operand is skipped, so a missing file still stops the macro ` +
                `— read it in a separate statement guarded by 'if'`, 'warning');
        }
        const single = n.args.length === 1 && readsNullWhenSkipped(n.args[0]) && mode !== 'yes';
        const hazard = (firmware: string) => {
            this.skippedHazard(n, mode, firmware,
                `'${this.text(n.s)}' fails when this operand is skipped, because skipped identifiers read as null`,
                `compute it in a separate statement guarded by 'if'`);
        };
        if (single && (n.name === 'random' || n.name === 'datetime' || n.name === 'max' || n.name === 'min')) {
            hazard(n.name === 'random' ? MSG.positiveInt : n.name === 'datetime' ? MSG.toDateTime : MSG.notArray);
            if (mode === 'no') return FAILED;
        }
        return new Builtin(this, n, args, mode).run();
    }

    /** @internal for Builtin */
    argError(mode: Mode, code: Code, at: Node, message: string, unconditional = false): void {
        if (unconditional) this.emit(code, at.s, message);
        else this.fail(mode, code, at.s, message);
    }
}

// ── Built-in functions (3.5.4 table plus the 3.6 additions) ─────────────────

const FLOAT_FUNCTIONS = new Set(['acos', 'asin', 'atan', 'cos', 'sin', 'tan', 'exp', 'log', 'sqrt', 'degrees', 'radians']);
const ARITY: Record<string, number> = {
    abs: 1, acos: 1, asin: 1, atan: 1, cos: 1, sin: 1, tan: 1, exp: 1, log: 1, sqrt: 1, degrees: 1, radians: 1,
    atan2: 2, floor: 1, ceil: 1, isnan: 1, mod: 2, pow: 2, random: 1, datetime: 1, fileexists: 1, fileread: 4,
    vector: 2, square: 1, round: 1, take: 2, drop: 2, find: 2,
};

class Builtin {
    constructor(
        private readonly typer: Typer,
        private readonly n: Node & { k: 'call' },
        private readonly args: R[],
        private readonly mode: Mode,
    ) { }

    /** Literals are checked by random/datetime/max/min even in skipped operands (TC-SC-01). */
    private get literalChecksAlways(): boolean {
        return ['random', 'datetime', 'max', 'min'].includes(this.n.name);
    }

    private bad(i: number, code: Code, message: string): void {
        const node = this.n.args[i];
        const lit = ['num', 'str', 'char', 'const', 'brace'].includes(unwrap(node).k) || (unwrap(node).k === 'unary' && unwrap((unwrap(node) as Node & { k: 'unary' }).arg).k === 'num');
        this.typer.argError(this.mode, code, node, message, this.literalChecksAlways && lit && this.mode === 'no');
    }

    /** Reports the argument when none of its possible kinds is accepted; true when reported. */
    private need(i: number, ok: (k: Kind) => boolean, firmware: string, what: string): boolean {
        const a = this.args[i];
        if (!a || a.failed || isUnknown(a.t) || isBottom(a.t)) return false;
        if (kinds(a.t).some(ok)) return false;
        this.bad(i, CODE.argument, `${this.n.name}() ${what}, got ${describe(a.t)}: the firmware stops with "${firmware}"`);
        return true;
    }

    private literal(i: number): number | undefined {
        const v = this.args[i]?.v;
        return v && 'num' in v ? v.num : undefined;
    }

    private nonNegative(i: number): boolean {
        const v = this.literal(i);
        if (v === undefined || v >= 0) return false;
        this.bad(i, CODE.value, `${this.n.name}() argument ${i + 1} is negative (${v}): the firmware stops with "${MSG.nonNegativeInt}"`);
        return true;
    }

    private get anyFailed(): boolean { return this.args.some(a => a.failed); }

    run(): R {
        const { n, args } = this;
        const name = n.name;
        const want = ARITY[name];
        if (want !== undefined && args.length !== want) return { t: UNKNOWN };
        if (name === 'max' || name === 'min') return this.maxMin();
        if (FLOAT_FUNCTIONS.has(name)) return this.numeric([0], prim('float'));
        switch (name) {
            case 'abs': {
                if (this.need(0, k => k === 'int' || k === 'float', MSG.numericOperand, 'needs an int or float') || this.anyFailed) return FAILED;
                const t = args[0].t;
                return { t: isUnknown(t) ? UNKNOWN : union(...kinds(t).filter(k => k === 'int' || k === 'float').map(k => prim(k as 'int'))) };
            }
            case 'atan2': return this.numeric([0, 1], prim('float'));
            case 'floor': case 'ceil': case 'round': return this.numeric([0], prim('int'));
            case 'square': return this.numeric([0], prim('float'));
            case 'isnan': return this.numeric([0], prim('bool'));
            case 'mod': return this.balanced();
            case 'pow': {
                const r = this.balanced();
                if (r.failed || isUnknown(r.t)) return r;
                const e = this.literal(1);
                return e !== undefined && e < 0 ? { t: prim('float') } : r;
            }
            case 'random': {
                if (this.need(0, k => k === 'int' || k === 'uint', MSG.positiveInt, 'needs a positive integer')) return FAILED;
                const v = this.literal(0);
                if (v !== undefined && v <= 0) {
                    this.bad(0, CODE.value, `random() needs a positive limit, got ${v}: the firmware stops with "${MSG.positiveInt}"`);
                    return FAILED;
                }
                return this.anyFailed ? FAILED : { t: prim('int') };
            }
            case 'datetime': {
                if (this.need(0, k => k === 'int' || k === 'uint' || k === 'datetime' || k === 'string', MSG.toDateTime, 'needs an integer, a datetime or a date string')) return FAILED;
                const v = args[0].v;
                if (v && 'str' in v && !DATE_RE.test(v.str)) {
                    this.bad(0, CODE.value, `"${v.str}" is not a date like 2024-01-31T12:00:00: the firmware stops with "${MSG.badDateString}"`);
                    return FAILED;
                }
                return this.anyFailed ? FAILED : { t: prim('datetime') };
            }
            case 'fileexists': return { t: prim('bool') };
            case 'fileread': {
                let bad = this.need(0, k => k === 'string', MSG.stringOperand, 'needs a file name string');
                for (const i of [1, 2]) bad = (this.need(i, k => k === 'int', MSG.nonNegativeInt, `argument ${i + 1} needs a non-negative integer`) || this.nonNegative(i)) || bad;
                bad = this.need(3, k => k === 'char', MSG.charOperand, "needs a character delimiter like ','") || bad;
                return bad || this.anyFailed ? FAILED : { t: arrayOf(UNKNOWN, true) };
            }
            case 'vector': {
                if (this.need(0, k => k === 'int', MSG.nonNegativeInt, 'needs a non-negative integer size') || this.nonNegative(0) || this.anyFailed) return FAILED;
                const len = this.literal(0);
                return { t: arrayOf(args[1].t, true, len) };
            }
            case 'take': case 'drop': {
                let bad = this.need(0, k => k === 'array' || k === 'string', MSG.notArrayOrString, 'needs an array or a string');
                bad = this.need(1, k => k === 'int', MSG.nonNegativeInt, 'needs a non-negative integer count') || this.nonNegative(1) || bad;
                if (bad || this.anyFailed) return FAILED;
                const t = args[0].t;
                if (isUnknown(t)) return { t: UNKNOWN };
                const out: Ty[] = [];
                for (const a of t) {
                    if (a === 'string') out.push(prim('string'));
                    else if (typeof a !== 'string') out.push(arrayOf(a.elem, true));
                }
                return { t: union(...out) };
            }
            case 'find': {
                // The second operand is only compared once the first is known to be a string.
                const bad = this.need(0, k => k === 'string', MSG.notString, 'needs a string to search')
                    || this.need(1, k => k === 'char' || k === 'string', MSG.incompatible, 'needs a character or string to find');
                return bad || this.anyFailed ? FAILED : { t: prim('int') };
            }
            default:
                return { t: UNKNOWN };
        }
    }

    private numeric(positions: number[], result: Ty): R {
        let bad = false;
        for (const i of positions) bad = this.need(i, isNum, MSG.numericOperand, 'needs a number') || bad;
        return bad || this.anyFailed ? FAILED : { t: result };
    }

    /** mod / pow / multi-argument max and min: BalanceNumericTypes across the arguments. */
    private balanced(): R {
        const { args } = this;
        let bad = false;
        for (let i = 0; i < args.length; i++) {
            const partner = args.find((_, j) => j !== i);
            const p: Kind = partner && !isUnknown(partner.t) && partner.t.length ? kindOf(partner.t[0]) : 'int';
            const a = args[i];
            if (a.failed || isUnknown(a.t) || isBottom(a.t)) continue;
            let first: string | undefined;
            const okAny = kinds(a.t).some(k => { const r = balanceNumeric(k, isNum(p) ? p : 'int'); if ('err' in r) first ??= r.err; return 'ok' in r; });
            if (!okAny) {
                this.bad(i, CODE.argument, `${this.n.name}() needs numbers, got ${describe(a.t)}: the firmware stops with "${first}"`);
                bad = true;
            }
        }
        if (bad || this.anyFailed) return FAILED;
        if (args.some(a => isUnknown(a.t))) return { t: UNKNOWN };
        if (args.some(a => isBottom(a.t))) return { t: BOTTOM };
        const canInt = args.every(a => hasKind(a.t, 'int'));
        const canFloat = args.some(a => hasKind(a.t, 'float', 'uint'));
        const out: Ty[] = [];
        if (canInt) out.push(prim('int'));
        if (canFloat) out.push(prim('float'));
        return { t: union(...out) };
    }

    private maxMin(): R {
        const { args, n } = this;
        if (args.length === 0) return { t: UNKNOWN };
        if (args.length > 1) return this.balanced();
        const a = args[0];
        if (a.failed) return FAILED;
        if (isUnknown(a.t) || isBottom(a.t)) return { t: a.t };
        const heap = a.t.filter(x => typeof x !== 'string' && x.heap) as Exclude<Atom, string>[];
        if (heap.length === 0) {
            this.bad(0, CODE.argument, `${n.name}() with one argument needs an array (a literal, vector(), fileread() or an array variable), got ${describe(a.t)}: the firmware stops with "${MSG.notArray}"`);
            return FAILED;
        }
        if (heap.every(x => x.len === 0)) {
            this.bad(0, CODE.value, `${n.name}() of an empty array: the firmware stops with "${MSG.noElements}"`);
            return FAILED;
        }
        const node = unwrap(n.args[0]);
        const elem = union(...heap.map(x => x.elem));
        const nonNumericItem = node.k === 'brace' && node.array
            ? node.items.some(item => this.itemLacksNumber(item))
            : lacksAll(elem, 'int', 'uint', 'float');
        if (nonNumericItem) {
            this.bad(0, CODE.argument, `${n.name}() needs numeric elements, got ${describe(a.t)}: the firmware stops with "${MSG.numericOperands}"`);
            return FAILED;
        }
        if (isUnknown(elem)) return { t: UNKNOWN };
        return { t: elem.filter(x => typeof x === 'string' && isNum(x)) };
    }

    private itemLacksNumber(item: Node): boolean {
        // Element types are already known through the array type; re-derive per item from the literal.
        const k = unwrap(item).k;
        if (k === 'str' || k === 'char') return true;
        if (k === 'const') {
            const name = (unwrap(item) as Node & { k: 'const' }).name;
            return name === 'true' || name === 'false' || name === 'null';
        }
        if (k === 'brace' && (unwrap(item) as Node & { k: 'brace' }).array) return true;
        return false;
    }
}

export { NUMBER };
