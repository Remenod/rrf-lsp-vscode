// analysis/typecheck/index.ts
// Entry points of the type checker: diagnostics for a document, inferred types
// for hover, and the workspace-wide types of globals.  Results are cached per
// SymbolTable generation, so a workspace scan solves the globals once.

import { SymbolTable } from '../symbolTable';
import { Doc, runFlow, FlowResult, Contribution, widenElements } from './flow';
import { Ty, UNKNOWN, BOTTOM, union, key, isBottom, isUnknown } from './types';
import { TypeDiag } from './infer';
import { Version, parseVersion } from './versions';

export { TypeDiag } from './infer';
export { display as displayType } from './types';
export type { Ty } from './types';

/** Contributions of one document to the globals, for the global values it read while running. */
interface Memo { reads: Array<[string, string]>; contributions: Contribution[] }
interface DocEntry { text: string; doc: Doc; results: Map<string, FlowResult>; memo: Memo[] }
interface Solved {
    types: Map<string, Ty>;
    /** The texts the solution was computed from: every document that mentions `global`. */
    basis: Map<string, string>;
}
interface Cache {
    generation: number;
    globals: Solved | null;
    /** The previous generation's solution, reused while no global-relevant text changed. */
    previous: Solved | null;
    docs: Map<string, DocEntry>;
}

const caches = new WeakMap<SymbolTable, Cache>();

function cacheFor(st: SymbolTable): Cache {
    let c = caches.get(st);
    if (!c || c.generation !== st.generation) {
        // Parsed documents stay valid across generations; only flow results depend on the workspace.
        const docs = new Map<string, DocEntry>();
        for (const [uri, e] of c?.docs ?? []) docs.set(uri, { text: e.text, doc: e.doc, results: new Map(), memo: e.memo });
        c = { generation: st.generation, globals: null, previous: c?.globals ?? c?.previous ?? null, docs };
        caches.set(st, c);
    }
    return c;
}

function docFor(c: Cache, uri: string, text: string): DocEntry {
    let e = c.docs.get(uri);
    if (!e || e.text !== text) {
        e = { text, doc: new Doc(text.split(/\r?\n/)), results: new Map(), memo: [] };
        c.docs.set(uri, e);
    }
    return e;
}

const MAX_GLOBAL_PASSES = 10;
const MEMO_PER_DOC = 12;

/**
 * Run one document for its contributions. A document's contributions depend only
 * on its text and on the global values it reads, so runs are memoised on those
 * reads: after an edit only the edited document (and those reading globals whose
 * value changed) run again.
 */
function contributionsOf(e: DocEntry, read: (name: string) => Ty): Contribution[] {
    const hit = e.memo.find(m => m.reads.every(([n, k]) => key(read(n)) === k));
    if (hit) return hit.contributions;
    const reads = new Map<string, string>();
    const contributions: Contribution[] = [];
    runFlow(e.doc, {
        version: null,
        globals: n => { const t = read(n); reads.set(n, key(t)); return t; },
        report: false,
        record: false,
        contribute: k => contributions.push(k),
    });
    e.memo.unshift({ reads: [...reads], contributions });
    if (e.memo.length > MEMO_PER_DOC) e.memo.pop();
    return contributions;
}

/**
 * Workspace types of every declared global (SPEC TC-GLB-01..04): the union of
 * all declarations, `set`s and recognised persistence writes, solved as a
 * least fixed point starting from bottom.
 */
function solveGlobals(st: SymbolTable, c: Cache): Map<string, Ty> {
    if (c.globals) return c.globals.types;
    const basis = new Map<string, string>();
    for (const [uri, text] of st.getIndexedTexts()) if (/\bglobal\b/.test(text)) basis.set(uri, text);
    const prev = c.previous;
    if (prev && prev.basis.size === basis.size && [...basis].every(([u, t]) => prev.basis.get(u) === t)) {
        c.globals = prev;
        return prev.types;
    }
    const declared = new Set(st.getGlobalNames());
    const docs = [...basis].map(([uri, text]) => docFor(c, uri, text));
    let env = new Map<string, Ty>();
    const read = (name: string): Ty => (declared.has(name) ? env.get(name) ?? BOTTOM : UNKNOWN);
    let converged = false;
    let previous = env;
    for (let pass = 0; pass < MAX_GLOBAL_PASSES; pass++) {
        const assigns = new Map<string, Ty[]>();
        const elems = new Map<string, Contribution[]>();
        const contribute = (k: Contribution) => {
            if (k.kind === 'assign') assigns.set(k.name, [...(assigns.get(k.name) ?? []), k.t]);
            else elems.set(k.name, [...(elems.get(k.name) ?? []), k]);
        };
        for (const e of docs) for (const k of contributionsOf(e, read)) contribute(k);
        const next = new Map<string, Ty>();
        for (const [name, ts] of assigns) {
            let t = union(...ts);
            for (const e of elems.get(name) ?? []) t = widenElements(t, e.depth, e.t);
            next.set(name, t);
        }
        previous = env;
        env = next;
        if (sameMap(previous, next)) { converged = true; break; }
    }
    const out = new Map<string, Ty>();
    for (const name of declared) {
        let t = env.get(name) ?? BOTTOM;
        if (!converged && key(t) !== key(previous.get(name) ?? BOTTOM)) t = UNKNOWN;
        // Only null is visible: the real value is written where the checker cannot see (TC-GLB-04).
        if (isBottom(t) || (!isUnknown(t) && t.every(a => a === 'null'))) t = UNKNOWN;
        out.set(name, t);
    }
    c.globals = { types: out, basis };
    return out;
}

function sameMap(a: Map<string, Ty>, b: Map<string, Ty>): boolean {
    if (a.size !== b.size) return false;
    for (const [n, t] of a) { const u = b.get(n); if (u === undefined || key(u) !== key(t)) return false; }
    return true;
}

function analyse(st: SymbolTable, uri: string, text: string, version: Version | null): FlowResult {
    const c = cacheFor(st);
    const globals = solveGlobals(st, c);
    const e = docFor(c, uri, text);
    const k = version?.text ?? '';
    let r = e.results.get(k);
    if (!r) {
        r = runFlow(e.doc, { version, globals: n => globals.get(n) ?? UNKNOWN, report: true, record: true });
        e.results.set(k, r);
    }
    return r;
}

/** Type diagnostics of a document (unfiltered: the caller applies TC-DIAG-06). */
export function typeDiagnostics(st: SymbolTable, uri: string, text: string, rrfVersion?: string): TypeDiag[] {
    return analyse(st, uri, text, parseVersion(rrfVersion)).diagnostics;
}

/** Inferred type of the var./global./param. reference (or `var` name) starting at line:col. */
export function typeAtPosition(st: SymbolTable, uri: string, docLines: string[], line: number, col: number): Ty | undefined {
    // Reuse the indexed text when it is the same document (it may use CRLF line ends).
    const indexed = st.getText(uri);
    const same = indexed !== undefined && sameLines(indexed.split(/\r?\n/), docLines);
    return analyse(st, uri, same ? indexed! : docLines.join('\n'), null).types.get(line)?.get(col);
}

function sameLines(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((l, i) => l === b[i]);
}

/** Workspace type of `global.<name>`. */
export function globalType(st: SymbolTable, name: string): Ty {
    return solveGlobals(st, cacheFor(st)).get(name) ?? UNKNOWN;
}

/**
 * Identity of the current workspace global types. When it changes, diagnostics
 * of other documents may change too (a global gained or lost a type).
 */
export function globalTypesSignature(st: SymbolTable): string {
    const types = solveGlobals(st, cacheFor(st));
    return [...types].map(([n, t]) => `${n}=${key(t)}`).sort().join(';');
}
