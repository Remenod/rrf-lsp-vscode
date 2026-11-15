// analysis/typecheck/versions.ts
// Target firmware line (`rrfgcode.rrfVersion`): 3.5, 3.6 or 3.7, each meaning its
// latest release. The table comes from NamedEnum(Function, …) in
// src/GCodes/GCodeBuffer/ExpressionParser.cpp of RepRapFirmware 3.5.4, 3.6.4 and 3.7.0.

export type Version = '3.5' | '3.6' | '3.7';

const LINES: readonly Version[] = ['3.5', '3.6', '3.7'];

/** The configured line, or null (no target) for an empty or any other value. */
export function parseVersion(raw: string | undefined): Version | null {
    const t = raw?.trim() ?? '';
    return (LINES as readonly string[]).includes(t) ? (t as Version) : null;
}

/** Functions missing from 3.5; 3.6 and 3.7 have the same set. */
const FROM_3_6 = new Set(['drop', 'find', 'take', 'square', 'round']);

/** The line that added `name`, when the target predates it; null when available or no target. */
export function functionMissing(name: string, v: Version | null): Version | null {
    return v === '3.5' && FROM_3_6.has(name) ? '3.6' : null;
}

/** Whether bracketed strings can be indexed (3.6 and later), or null with no target. */
export function stringIndexing(v: Version | null): boolean | null {
    return v === null ? null : v !== '3.5';
}
