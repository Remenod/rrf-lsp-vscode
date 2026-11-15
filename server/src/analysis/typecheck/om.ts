// analysis/typecheck/om.ts
// Object-model leaf types (SPEC TC-OM-01/02, TC-ARR-09), from the data generated from the
// firmware's object-model tables (objectModelIndex). A bitmap reads as an int bit mask, and
// indexing it gives the number of a set bit, also an int; `unknown` kinds stay unknown.

import { getOmPathInfo, isOmIndexAvailable, OmTarget } from '../objectModelIndex';
import { Ty, UNKNOWN, prim, arrayOf, union, Prim } from './types';

const PRIMS: Record<string, Prim> = {
    int: 'int', uint: 'uint', float: 'float', bool: 'bool', string: 'string', char: 'char',
    datetime: 'datetime', object: 'object', null: 'null', bitmap: 'int',
};

function toTy(type: string, path: string, target: OmTarget | undefined): Ty {
    const kinds = type.split('|');
    if (kinds.includes('unknown')) return UNKNOWN;
    return union(...kinds.map(k => (k === 'array' ? arrayOf(element(path, target), false) : PRIMS[k] ? prim(PRIMS[k]) : UNKNOWN)));
}

function element(collection: string, target: OmTarget | undefined): Ty {
    const info = getOmPathInfo(`${collection}[]`, target);
    return info ? toTy(info.type, `${collection}[]`, target) : UNKNOWN;
}

const caches = new Map<string, Map<string, Ty>>();

/** Type of an object-model path (`move.axes[0].homed`); paths not in the model are `unknown`. */
export function omType(path: string, target?: OmTarget): Ty {
    if (!isOmIndexAvailable()) return UNKNOWN;
    const key = `${target?.version ?? ''}|${target?.sbc ? 1 : 0}`;
    let cache = caches.get(key);
    if (!cache) caches.set(key, cache = new Map());
    const norm = path.replace(/\[[^\]]*\]/g, '[]');
    const hit = cache.get(norm);
    if (hit) return hit;
    let t: Ty = UNKNOWN;
    if (norm.endsWith('[]')) {
        const collection = norm.slice(0, -2);
        const info = getOmPathInfo(collection, target);
        if (info) {
            const kinds = info.type.split('|').filter(k => k !== 'null');
            if (kinds.length === 1 && kinds[0] === 'bitmap') t = prim('int');
            else if (kinds.includes('array')) t = element(collection, target);
        }
    } else {
        const info = getOmPathInfo(norm, target);
        if (info) t = toTy(info.type, norm, target);
    }
    cache.set(norm, t);
    return t;
}
