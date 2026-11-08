// analysis/typecheck/versions.ts
// Target firmware versions (`rrfgcode.rrfVersion`, SPEC TC-CFG-02/03, §10).
//
// Tables come from the upstream tags' NamedEnum(Function, …) and
// NamedEnum(NamedConstant, …) declarations in ExpressionParser.cpp.

export interface Version {
    /** The string the user configured (for messages). */
    readonly text: string;
    readonly parts: readonly number[];
}

const PRE = { alpha: 0, beta: 1, rc: 2 } as const;
const RELEASE = 3;

/**
 * `X.Y`, `X.Y.Z`, `X.Y.Z-alpha.N|beta.N|rc.N`; any other suffix (the fork's
 * `3.5.4-vm.1`) is ignored.  Empty, malformed or pre-3.3 strings are
 * version-neutral and yield null.
 */
export function parseVersion(raw: string | undefined): Version | null {
    if (!raw) return null;
    const text = raw.trim();
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-(alpha|beta|rc)\.(\d+))?(?:[-+][0-9A-Za-z.-]*)?$/.exec(text);
    if (!m) return null;
    const pre = m[4] ? PRE[m[4] as keyof typeof PRE] : RELEASE;
    const v: Version = { text, parts: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), pre, Number(m[5] ?? 0)] };
    return compare(v, at('3.3.0')) < 0 ? null : v;
}

function at(s: string): Version {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(s)!;
    const pre = m[4] ? PRE[m[4] as keyof typeof PRE] : RELEASE;
    return { text: s, parts: [Number(m[1]), Number(m[2]), Number(m[3]), pre, Number(m[5] ?? 0)] };
}

export function compare(a: Version, b: Version): number {
    for (let i = 0; i < a.parts.length; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
    return 0;
}

const FUNCTIONS_ADDED: Record<string, string> = {
    datetime: '3.4.0',
    ceil: '3.5.0', exp: '3.5.0', fileexists: '3.5.0', fileread: '3.5.0', log: '3.5.0', pow: '3.5.0', vector: '3.5.0',
    drop: '3.6.0-beta.4', find: '3.6.0-beta.4', take: '3.6.0-beta.4',
    square: '3.6.0-rc.2',
    round: '3.6.0-rc.3',
};

const CONSTANTS_ADDED: Record<string, string> = {
    input: '3.5.0',
};

export const STRING_INDEXING_FROM = '3.6.0-beta.4';

/** The version that added `name`, when the target predates it; null when available. */
function missing(table: Record<string, string>, name: string, v: Version | null): string | null {
    const added = table[name];
    if (!v || !added) return null;
    return compare(v, at(added)) < 0 ? added : null;
}

export const functionMissing = (name: string, v: Version | null) => missing(FUNCTIONS_ADDED, name, v);
export const constantMissing = (name: string, v: Version | null) => missing(CONSTANTS_ADDED, name, v);

/** Whether bracketed strings can be indexed: true / false, or null when version-neutral. */
export function stringIndexing(v: Version | null): boolean | null {
    if (!v) return null;
    return compare(v, at(STRING_INDEXING_FROM)) >= 0;
}
