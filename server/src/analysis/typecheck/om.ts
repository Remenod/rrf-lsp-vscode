// analysis/typecheck/om.ts
// Object-model leaf types (SPEC TC-OM-01/02, TC-ARR-09), from the index built
// out of @duet3d/objectmodel.  The library types every number as `number`, so
// numbers are `int | uint | float`; leaves whose default is null carry no type
// information and are `unknown`.

import { allOmPaths, getOmPathInfo, isOmIndexAvailable } from '../objectModelIndex';
import { Ty, UNKNOWN, NUMBER, prim, arrayOf } from './types';

let elementPrefixes: Set<string> | null = null;

/** Normalised paths of collections whose elements have fields (`move.axes[]`). */
function hasFields(elementPath: string): boolean {
    if (!elementPrefixes) {
        elementPrefixes = new Set();
        for (const { path } of allOmPaths()) {
            let i = path.indexOf('[].');
            while (i >= 0) {
                elementPrefixes.add(path.slice(0, i + 2));
                i = path.indexOf('[].', i + 1);
            }
        }
    }
    return elementPrefixes.has(elementPath);
}

function elementType(collection: string): Ty {
    const element = `${collection}[]`;
    const info = getOmPathInfo(element);
    if (info) return leaf(info.type, info.isArray, element);
    return hasFields(element) ? prim('object') : UNKNOWN;
}

function leaf(type: string, isArray: boolean, path: string): Ty {
    if (isArray) return arrayOf(elementType(path), false);
    switch (type) {
        case 'boolean': return prim('bool');
        case 'string': return prim('string');
        case 'number': return NUMBER;
        case 'null': return UNKNOWN;
        case 'array': return arrayOf(UNKNOWN, false);
        case 'Date': return UNKNOWN;
        case 'undefined': case 'function': case 'bigint': case 'symbol': return UNKNOWN;
        default: return prim('object');
    }
}

const cache = new Map<string, Ty>();

/** Type of a normalised object-model path (`move.axes[].homed`); unknown paths are `unknown`. */
export function omType(path: string): Ty {
    if (!isOmIndexAvailable()) return UNKNOWN;
    const norm = path.replace(/\[\d*\]/g, '[]');
    const hit = cache.get(norm);
    if (hit) return hit;
    let t: Ty;
    if (norm.endsWith('[]')) {
        const collection = norm.slice(0, -2);
        const info = getOmPathInfo(collection);
        t = info?.isArray ? elementType(collection) : UNKNOWN;
    } else {
        const info = getOmPathInfo(norm);
        t = info ? leaf(info.type, info.isArray, norm) : UNKNOWN;
    }
    cache.set(norm, t);
    return t;
}
