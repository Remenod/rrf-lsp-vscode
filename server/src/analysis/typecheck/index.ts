// analysis/typecheck/index.ts
// Entry points of the type checker: diagnostics for a document, inferred types for hover, the
// workspace-wide types of globals and the types of macro parameters from their callers.
// Results are cached per SymbolTable generation, so a workspace scan solves the workspace once.

import * as path from 'path';
import { SymbolTable } from '../symbolTable';
import { getSdRootForUri, resolveRrfPathToDisk, uriToFsPath } from '../argValidators';
import { Doc, runFlow, FlowResult, Contribution, Callee, docCalls, widenElements } from './flow';
import { Ty, UNKNOWN, BOTTOM, union, key, isBottom, isUnknown, prim } from './types';
import { TypeDiag } from './infer';
import { Version, parseVersion } from './versions';

export { TypeDiag } from './infer';
export { display as displayType } from './types';
export type { Ty } from './types';

/** Contributions of one document, for the global values and parameter types it read while running. */
interface Memo { reads: Array<[string, string]>; contributions: Contribution[] }
interface DocEntry { text: string; doc: Doc; results: Map<string, FlowResult>; memo: Memo[] }

/** A place that runs a macro file with parameters: a line of a document, or the firmware itself. */
export interface CallSite {
    /** The calling document; null when the firmware runs the macro (an event, a probe). */
    uri: string | null;
    line: number;
    /** The letters it passes. */
    letters: string[];
    /** Why the firmware runs it, for a firmware call. */
    note?: string;
}

interface Solved {
    globals: Map<string, Ty>;
    /** Callee (by fileKey) → letter → union of what its callers pass. */
    params: Map<string, Map<string, Ty>>;
    /** Callee (by fileKey) → its callers. A file with none is not known to be called: its parameters are unknown. */
    callers: Map<string, CallSite[]>;
    /** Letters passed by calls of a file the server cannot tell (`M98 P{…}`), which may be any. */
    dynamic: Map<string, Ty>;
    /** The texts the solution was computed from, and the documents there were. */
    basis: Map<string, string>;
    uris: string;
}
interface Cache {
    generation: number;
    solved: Solved | null;
    /** The previous generation's solution, reused while no relevant text changed. */
    previous: Solved | null;
    docs: Map<string, DocEntry>;
    /** Call targets already resolved on disk, valid while the set of documents stays the same. */
    resolved: { uris: string; map: Map<string, string | null> };
}

const caches = new WeakMap<SymbolTable, Cache>();

function cacheFor(st: SymbolTable): Cache {
    let c = caches.get(st);
    if (!c || c.generation !== st.generation) {
        // Parsed documents stay valid across generations; only flow results depend on the workspace.
        const docs = new Map<string, DocEntry>();
        for (const [uri, e] of c?.docs ?? []) docs.set(uri, { text: e.text, doc: e.doc, results: new Map(), memo: e.memo });
        c = { generation: st.generation, solved: null, previous: c?.solved ?? c?.previous ?? null, docs, resolved: c?.resolved ?? { uris: '', map: new Map() } };
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

const MAX_PASSES = 10;
const MEMO_PER_DOC = 12;

// ── Macro calls ─────────────────────────────────────────────────────────────

/**
 * Macros the firmware runs with parameters of its own (TC-PRM-03): event handlers
 * (Event::GetParameters and ProcessEvent: D, B and P are integers, S the event text; the names are
 * NamedEnum(EventType) of each line with `_` written `-`) and the probe macros (K, the probe number).
 */
const EVENT_MACROS = ['main-board-power-fail', 'expansion-reconnect', 'expansion-timeout', 'heater-fault', 'driver-error',
    'filament-error', 'driver-stall', 'driver-warning', 'mcu-temperature-warning', 'overvoltage', 'undervoltage',
    'board-temperature-warning', 'board-over-temperature'];
const INT = prim('int');
const FIRMWARE_CALLS = new Map<string, { note: string; args: Array<[string, Ty]> }>([
    ...EVENT_MACROS.map(n => [`sys/${n}.g`, { note: `the firmware runs it for a ${n.replace(/-/g, ' ')} event`, args: [['D', INT], ['B', INT], ['P', INT], ['S', prim('string')]] as Array<[string, Ty]> }] as const),
    ['sys/deployprobe.g', { note: 'the firmware runs it to deploy a Z probe', args: [['K', INT]] }],
    ['sys/retractprobe.g', { note: 'the firmware runs it to retract a Z probe', args: [['K', INT]] }],
]);

/**
 * The key a document's parameters are kept under: its lower-case file path. The SD card is not
 * case-sensitive, and the editor and the workspace scan need not spell a URI alike.
 */
function fileKey(uri: string): string {
    const p = uriToFsPath(uri);
    return p ? path.resolve(p).toLowerCase() : uri;
}

/** Keys of the indexed documents. */
function fileIndex(st: SymbolTable): Set<string> {
    return new Set([...st.getIndexedTexts().keys()].map(fileKey));
}

/** The key of the indexed document a call in `caller` runs, if it is in the workspace. */
function resolveCallee(caller: string, file: string, files: Set<string>): string | null {
    const sd = getSdRootForUri(caller);
    if (!sd) return null;
    const abs = resolveRrfPathToDisk(file, sd, { defaultRelativeDir: 'sys' });
    const k = abs ? path.resolve(abs).toLowerCase() : null;
    return k && files.has(k) ? k : null;
}

/** The firmware's calls of indexed documents. */
function firmwareCalls(st: SymbolTable): Map<string, { note: string; args: Array<[string, Ty]> }> {
    const out = new Map<string, { note: string; args: Array<[string, Ty]> }>();
    for (const uri of st.getIndexedTexts().keys()) {
        const p = uriToFsPath(uri);
        const sd = getSdRootForUri(uri);
        if (!p || !sd) continue;
        const rel = path.relative(sd, p).split(path.sep).join('/').toLowerCase();
        const call = FIRMWARE_CALLS.get(rel);
        if (call) out.set(fileKey(uri), call);
    }
    return out;
}

// ── Solving ─────────────────────────────────────────────────────────────────

interface Reader {
    global(name: string): Ty;
    param(uri: string, letter: string): Ty;
}

/**
 * Run one document for its contributions. They depend only on its text, the global values and
 * its own parameter types, so runs are memoised on those reads: after an edit only the edited
 * document (and those reading values that changed) run again.
 */
function contributionsOf(uri: string, e: DocEntry, read: Reader): Contribution[] {
    const value = (k: string) => (k.startsWith('g:') ? read.global(k.slice(2)) : read.param(uri, k.slice(2)));
    const hit = e.memo.find(m => m.reads.every(([k, t]) => key(value(k)) === t));
    if (hit) return hit.contributions;
    const reads = new Map<string, string>();
    const contributions: Contribution[] = [];
    const reading = (k: string) => { const t = value(k); reads.set(k, key(t)); return t; };
    runFlow(e.doc, {
        version: null,
        globals: n => reading(`g:${n}`),
        params: n => reading(`p:${n}`),
        report: false,
        record: false,
        contribute: k => contributions.push(k),
    });
    e.memo.unshift({ reads: [...reads], contributions });
    if (e.memo.length > MEMO_PER_DOC) e.memo.pop();
    return contributions;
}

const mayCall = (e: DocEntry) => docCalls(e.doc).length > 0;

/**
 * The workspace: types of every declared global (SPEC TC-GLB-01..04) — the union of all
 * declarations, `set`s and recognised persistence writes — and of the parameters of every macro
 * file (TC-PRM-01..05) — the union of what its callers pass. Solved together as a least fixed point
 * from bottom: a call passes values that depend on globals and on the caller's own parameters.
 */
function solve(st: SymbolTable, c: Cache): Solved {
    if (c.solved) return c.solved;
    const basis = new Map<string, string>();
    for (const [uri, text] of st.getIndexedTexts()) {
        if (/\bglobal\b/.test(text) || mayCall(docFor(c, uri, text))) basis.set(uri, text);
    }
    const uris = [...st.getIndexedTexts().keys()].sort().join('\n');
    const prev = c.previous;
    if (prev && prev.uris === uris && prev.basis.size === basis.size && [...basis].every(([u, t]) => prev.basis.get(u) === t)) {
        c.solved = prev;
        return prev;
    }
    const files = fileIndex(st);
    const firmware = firmwareCalls(st);
    const docs = [...basis].map(([uri, text]) => ({ uri, e: docFor(c, uri, text) }));

    // Who calls what does not depend on types.
    const callers = new Map<string, CallSite[]>();
    const add = (callee: string, site: CallSite) => callers.set(callee, [...(callers.get(callee) ?? []), site]);
    if (c.resolved.uris !== uris) c.resolved = { uris, map: new Map() };
    const resolved = c.resolved.map;
    const target = (caller: string, callee: Callee): string | null => {
        if (!('file' in callee)) return null;
        const k = `${caller}\n${callee.file}`;
        if (!resolved.has(k)) resolved.set(k, resolveCallee(caller, callee.file, files));
        return resolved.get(k)!;
    };
    for (const { uri, e } of docs) {
        for (const call of docCalls(e.doc)) {
            const t = target(uri, call.callee);
            if (t) add(t, { uri, line: call.line, letters: call.letters });
        }
    }
    for (const [uri, f] of firmware) add(uri, { uri: null, line: -1, letters: f.args.map(([l]) => l), note: f.note });

    const declared = new Set(st.getGlobalNames());
    let globals = new Map<string, Ty>();
    let params = new Map<string, Map<string, Ty>>();
    let dynamic = new Map<string, Ty>();
    const read: Reader = {
        global: name => (declared.has(name) ? globals.get(name) ?? BOTTOM : UNKNOWN),
        param: (uri, letter) => {
            const k = fileKey(uri);
            return callers.has(k) ? union(params.get(k)?.get(letter) ?? BOTTOM, dynamic.get(letter) ?? BOTTOM) : UNKNOWN;
        },
    };
    let converged = false;
    let previous = { globals, params, dynamic };
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const assigns = new Map<string, Ty[]>();
        const elems = new Map<string, Contribution[]>();
        const nextParams = new Map<string, Map<string, Ty>>();
        const nextDynamic = new Map<string, Ty>();
        const addParam = (uri: string, letter: string, t: Ty) => {
            let m = nextParams.get(uri);
            if (!m) nextParams.set(uri, m = new Map());
            m.set(letter, union(m.get(letter) ?? BOTTOM, t));
        };
        for (const [uri, f] of firmware) for (const [letter, t] of f.args) addParam(uri, letter, t);
        for (const { uri, e } of docs) {
            for (const k of contributionsOf(uri, e, read)) {
                if (k.kind === 'call') {
                    if (!('file' in k.callee)) {
                        for (const [letter, t] of k.args) nextDynamic.set(letter, union(nextDynamic.get(letter) ?? BOTTOM, t));
                        continue;
                    }
                    const t = target(uri, k.callee);
                    if (t) for (const [letter, ty] of k.args) addParam(t, letter, ty);
                } else if (k.kind === 'assign') assigns.set(k.name, [...(assigns.get(k.name) ?? []), k.t]);
                else elems.set(k.name, [...(elems.get(k.name) ?? []), k]);
            }
        }
        const nextGlobals = new Map<string, Ty>();
        for (const [name, ts] of assigns) {
            let t = union(...ts);
            for (const e of elems.get(name) ?? []) if (e.kind === 'elem') t = widenElements(t, e.depth, e.t);
            nextGlobals.set(name, t);
        }
        previous = { globals, params, dynamic };
        globals = nextGlobals;
        params = nextParams;
        dynamic = nextDynamic;
        if (sameMap(previous.globals, globals) && sameMap(previous.dynamic, dynamic) && sameParams(previous.params, params)) {
            converged = true;
            break;
        }
    }

    const outGlobals = new Map<string, Ty>();
    for (const name of declared) {
        let t = globals.get(name) ?? BOTTOM;
        if (!converged && key(t) !== key(previous.globals.get(name) ?? BOTTOM)) t = UNKNOWN;
        // Only null is visible: the real value is written where the checker cannot see (TC-GLB-04).
        if (isBottom(t) || (!isUnknown(t) && t.every(a => a === 'null'))) t = UNKNOWN;
        outGlobals.set(name, t);
    }
    if (!converged) {
        // What still changed in the last pass is not known (TC-PRM-05).
        for (const [uri, m] of params) {
            for (const [letter, t] of m) if (key(t) !== key(previous.params.get(uri)?.get(letter) ?? BOTTOM)) m.set(letter, UNKNOWN);
        }
        for (const [letter, t] of dynamic) if (key(t) !== key(previous.dynamic.get(letter) ?? BOTTOM)) dynamic.set(letter, UNKNOWN);
    }
    c.solved = { globals: outGlobals, params, callers, dynamic, basis, uris };
    return c.solved;
}

function sameMap(a: Map<string, Ty>, b: Map<string, Ty>): boolean {
    if (a.size !== b.size) return false;
    for (const [n, t] of a) { const u = b.get(n); if (u === undefined || key(u) !== key(t)) return false; }
    return true;
}

function sameParams(a: Map<string, Map<string, Ty>>, b: Map<string, Map<string, Ty>>): boolean {
    if (a.size !== b.size) return false;
    for (const [uri, m] of a) { const n = b.get(uri); if (!n || !sameMap(m, n)) return false; }
    return true;
}

/** Type of `param.<letter>` in document `uri`. */
function paramOf(s: Solved, uri: string, letter: string): Ty {
    const k = fileKey(uri);
    if (!s.callers.has(k)) return UNKNOWN;
    return union(s.params.get(k)?.get(letter) ?? BOTTOM, s.dynamic.get(letter) ?? BOTTOM);
}

function analyse(st: SymbolTable, uri: string, text: string, version: Version | null, sbc = false): FlowResult {
    const c = cacheFor(st);
    const s = solve(st, c);
    const e = docFor(c, uri, text);
    const k = `${version ?? ''}|${sbc ? 1 : 0}`;
    let r = e.results.get(k);
    if (!r) {
        r = runFlow(e.doc, {
            version, sbc, report: true, record: true,
            globals: n => s.globals.get(n) ?? UNKNOWN,
            params: n => paramOf(s, uri, n),
        });
        e.results.set(k, r);
    }
    return r;
}

/** Type diagnostics of a document (unfiltered: the caller applies TC-DIAG-06). */
export function typeDiagnostics(st: SymbolTable, uri: string, text: string, rrfVersion?: string, sbc?: boolean): TypeDiag[] {
    return analyse(st, uri, text, parseVersion(rrfVersion), sbc ?? false).diagnostics;
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
    return solve(st, cacheFor(st)).globals.get(name) ?? UNKNOWN;
}

/** Type of `param.<letter>` in document `uri`, from its callers (TC-PRM-01). */
export function paramType(st: SymbolTable, uri: string, letter: string): Ty {
    return paramOf(solve(st, cacheFor(st)), uri, letter);
}

/** The callers of document `uri`; empty when none in the workspace runs it. */
export function paramCallers(st: SymbolTable, uri: string): CallSite[] {
    return solve(st, cacheFor(st)).callers.get(fileKey(uri)) ?? [];
}

/**
 * Identity of the current workspace types of globals and macro parameters. When it changes,
 * diagnostics of other documents may change too (a global or a parameter gained or lost a type).
 */
export function globalTypesSignature(st: SymbolTable): string {
    const s = solve(st, cacheFor(st));
    const out = [...s.globals].map(([n, t]) => `${n}=${key(t)}`);
    for (const [uri, m] of s.params) for (const [l, t] of m) out.push(`${uri}#${l}=${key(t)}`);
    for (const uri of s.callers.keys()) out.push(`${uri}#called`);
    for (const [l, t] of s.dynamic) out.push(`*#${l}=${key(t)}`);
    return out.sort().join(';');
}
