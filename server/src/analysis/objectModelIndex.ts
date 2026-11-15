// analysis/objectModelIndex.ts
// The object model the server checks paths and types against, one file per firmware line
// (server/data/om-3.5.json, om-3.6.json, om-3.7.json), generated from the RepRapFirmware
// sources by scripts/om-gen.py. Fields that only exist with a single-board computer
// (DuetSoftwareFramework) are a separate section of each file, used when `rrfgcode.sbc` is on.
//
// With a target line only that line counts; with none, a path is valid when any line has it
// and its type is the union over the lines.

import * as fs from 'fs';
import * as path from 'path';
import { parseVersion, Version } from './typecheck/versions';

export interface OmTarget {
    /** `rrfgcode.rrfVersion`: '3.5', '3.6' or '3.7'; anything else means every line. */
    version?: string | null;
    /** `rrfgcode.sbc`: include the fields only a single-board computer provides. */
    sbc?: boolean;
}

export interface OmPathInfo {
    /** Normalised path with [] for array elements, e.g. "move.axes[].homed" */
    path: string;
    /** Kinds joined with '|': int, uint, float, bool, string, char, datetime, object, array, bitmap, null, unknown. */
    type: string;
    /** True if the path is an array (subscriptable). */
    isArray: boolean;
}

interface LineData { paths: Map<string, string>; sbc: Map<string, string> }

const LINES: readonly Version[] = ['3.5', '3.6', '3.7'];
let data: Map<Version, LineData> | null = null;

/** server/data, found from this file whether it runs from out/ or out-test/. */
function dataDir(): string | null {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'data');
        if (fs.existsSync(path.join(candidate, 'om-3.6.json'))) return candidate;
        dir = path.dirname(dir);
    }
    return null;
}

function load(): Map<Version, LineData> {
    if (data) return data;
    data = new Map();
    const dir = dataDir();
    if (!dir) return data;
    for (const line of LINES) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, `om-${line}.json`), 'utf8')) as {
                paths?: Record<string, string>; sbc?: Record<string, string>;
            };
            data.set(line, { paths: new Map(Object.entries(raw.paths ?? {})), sbc: new Map(Object.entries(raw.sbc ?? {})) });
        } catch {
            // A missing or broken file leaves that line out.
        }
    }
    return data;
}

function linesFor(target?: OmTarget): LineData[] {
    const all = load();
    const v = parseVersion(target?.version ?? undefined);
    const picked = v ? [all.get(v)] : LINES.map(l => all.get(l));
    return picked.filter((d): d is LineData => d !== undefined);
}

/** Union of kinds; `unknown` absorbs everything but null. */
function merge(types: string[]): string {
    const ks = new Set(types.flatMap(t => t.split('|')));
    if (ks.has('unknown')) return ks.has('null') ? 'unknown|null' : 'unknown';
    return [...ks].sort().join('|');
}

function typeOf(norm: string, target?: OmTarget): string | undefined {
    const found: string[] = [];
    for (const d of linesFor(target)) {
        const t = d.paths.get(norm) ?? (target?.sbc ? d.sbc.get(norm) : undefined);
        if (t !== undefined) found.push(t);
    }
    return found.length ? merge(found) : undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True if the path is a known Object Model path. Array indices normalised automatically. */
export function isValidOmPath(path: string, target?: OmTarget): boolean {
    return typeOf(normalisePath(path), target) !== undefined;
}

/** Metadata for an OM path, or undefined if unknown. */
export function getOmPathInfo(path: string, target?: OmTarget): OmPathInfo | undefined {
    const norm = normalisePath(path);
    const type = typeOf(norm, target);
    return type === undefined ? undefined : { path: norm, type, isArray: type.split('|').includes('array') };
}

/** True when the generated object-model data could be loaded. */
export function isOmIndexAvailable(): boolean {
    return load().size > 0;
}

/** All known OM paths (for completions). */
export function allOmPaths(target?: OmTarget): OmPathInfo[] {
    const names = new Set<string>();
    for (const d of linesFor(target)) {
        for (const p of d.paths.keys()) names.add(p);
        if (target?.sbc) for (const p of d.sbc.keys()) names.add(p);
    }
    return [...names].sort().filter(p => !p.endsWith('[]')).map(p => getOmPathInfo(p, target)!);
}

/** Replace concrete array indices with [] for normalised key lookup. */
function normalisePath(path: string): string {
    return path.replace(/\[\d+\]/g, '[]');
}
