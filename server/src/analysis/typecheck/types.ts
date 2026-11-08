// analysis/typecheck/types.ts
// The type lattice of RRF expressions (SPEC TC-TYPE-01..03).
//
// A type is either `unknown` (absorbs everything) or a union of atoms.  The
// empty union is *bottom* — "no value seen yet"; it only appears while the
// workspace global types are being solved and is displayed as `unknown`.

export type Prim = 'int' | 'uint' | 'float' | 'bool' | 'string' | 'char' | 'datetime' | 'object' | 'null';

export interface ArrayAtom {
    readonly kind: 'array';
    readonly elem: Ty;
    /** Heap arrays (literals, vector, fileread, variables) vs object-model collections. */
    readonly heap: boolean;
    /** Statically known length, when every contributing array had the same one. */
    readonly len?: number;
}

export type Atom = Prim | ArrayAtom;
export type Ty = 'unknown' | readonly Atom[];

export const UNKNOWN: Ty = 'unknown';
export const BOTTOM: Ty = [];

/** Atom kinds as the operator tables see them (heap and object-model arrays alike). */
export type Kind = Prim | 'array';

const PRIM_ORDER: Prim[] = ['int', 'uint', 'float', 'bool', 'string', 'char', 'datetime', 'object', 'null'];

/** Nesting beyond this depth is widened to `array<unknown>` so solving always terminates. */
const MAX_ARRAY_DEPTH = 4;

export const isUnknown = (t: Ty): t is 'unknown' => t === 'unknown';
export const isBottom = (t: Ty): boolean => t !== 'unknown' && t.length === 0;
export const kindOf = (a: Atom): Kind => (typeof a === 'string' ? a : 'array');

export function prim(...ps: Prim[]): Ty {
    return union(...ps.map(p => [p] as Ty));
}

export const NUMBER: Ty = ['int', 'uint', 'float'];

export function arrayOf(elem: Ty, heap = true, len?: number): Ty {
    return [{ kind: 'array', elem: depthLimit(elem, MAX_ARRAY_DEPTH - 1), heap, len }];
}

function depthLimit(t: Ty, depth: number): Ty {
    if (t === 'unknown') return t;
    if (!t.some(a => typeof a !== 'string')) return t;
    if (depth <= 0) return t.map(a => (typeof a === 'string' ? a : { ...a, elem: UNKNOWN }));
    return t.map(a => (typeof a === 'string' ? a : { ...a, elem: depthLimit(a.elem, depth - 1) }));
}

/** Union of types; `unknown` absorbs, arrays merge per heap flag. */
export function union(...ts: Ty[]): Ty {
    const prims = new Set<Prim>();
    const arrays = new Map<boolean, { elems: Ty[]; len: number | undefined | null }>();
    for (const t of ts) {
        if (t === 'unknown') return UNKNOWN;
        for (const a of t) {
            if (typeof a === 'string') { prims.add(a); continue; }
            const cur = arrays.get(a.heap);
            if (!cur) arrays.set(a.heap, { elems: [a.elem], len: a.len });
            else {
                cur.elems.push(a.elem);
                if (cur.len !== a.len) cur.len = null;
            }
        }
    }
    const out: Atom[] = PRIM_ORDER.filter(p => prims.has(p));
    for (const heap of [true, false]) {
        const a = arrays.get(heap);
        if (!a) continue;
        out.push({ kind: 'array', elem: union(...a.elems), heap, len: a.len === null ? undefined : a.len });
    }
    return out;
}

export function atoms(t: Ty): readonly Atom[] {
    return t === 'unknown' ? [] : t;
}

export function hasKind(t: Ty, ...ks: Kind[]): boolean {
    return t !== 'unknown' && t.some(a => ks.includes(kindOf(a)));
}

/** True when the type certainly has none of the kinds (unknown and bottom never qualify). */
export function lacksAll(t: Ty, ...ks: Kind[]): boolean {
    return t !== 'unknown' && t.length > 0 && !t.some(a => ks.includes(kindOf(a)));
}

/** Keep only the atoms matching the predicate. */
export function filter(t: Ty, keep: (a: Atom) => boolean): Ty {
    return t === 'unknown' ? t : t.filter(keep);
}

/** Stable identity of a type, for fixed points and caches. */
export function key(t: Ty): string {
    if (t === 'unknown') return '?';
    return t.map(a => (typeof a === 'string' ? a : `[${a.heap ? 'h' : 'o'}${a.len ?? ''}:${key(a.elem)}]`)).join('|');
}

export const sameTy = (a: Ty, b: Ty): boolean => key(a) === key(b);

/** Display form used by hover (TC-TYPE-03). Bottom shows as `unknown`. */
export function display(t: Ty): string {
    if (t === 'unknown' || t.length === 0) return 'unknown';
    const parts: string[] = [];
    const ps = t.filter((a): a is Prim => typeof a === 'string');
    const isNumber = ps.includes('int') && ps.includes('uint') && ps.includes('float');
    if (isNumber) parts.push('number');
    for (const p of ps) {
        if (isNumber && (p === 'int' || p === 'uint' || p === 'float')) continue;
        parts.push(p);
    }
    for (const a of t) {
        if (typeof a === 'string') continue;
        parts.push(a.elem === 'unknown' ? 'array' : `array<${display(a.elem)}>`);
    }
    return parts.join(' | ');
}

/** Short name for messages: the displayed union, never `number` (messages name the members). */
export function describe(t: Ty): string {
    if (t === 'unknown' || t.length === 0) return 'unknown';
    return t.map(a => (typeof a === 'string' ? a : (a.elem === 'unknown' ? 'array' : `array<${describe(a.elem)}>`))).join(' | ');
}
