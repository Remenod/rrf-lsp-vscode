// Shared low-level helpers used across all analysis modules.
// Centralises logic that was previously copy-pasted into server.ts,
// symbolTable.ts, hover.ts, rename.ts, and expression.ts.

import { Token, TokenType } from '../parser/types';

// ── String helpers ─────────────────────────────────────────────────────────────

/** Count leading whitespace characters on a line (spaces or tabs). */
export function lineIndent(line: string): number {
    let i = 0;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
    return i;
}

// ── Token helpers ──────────────────────────────────────────────────────────────

/**
 * Find the token whose span contains `character`.
 * Returns the token and its index in the array, or null if no match.
 */
export function findTokenAtChar(
    tokens: Token[],
    character: number,
): { tok: Token; idx: number } | null {
    const idx = tokens.findIndex(t => t.start <= character && character < t.end);
    if (idx === -1) return null;
    return { tok: tokens[idx], idx };
}

// ── Qualified-name helpers ─────────────────────────────────────────────────────

export type VarScopeStr = 'var' | 'global' | 'param';

/**
 * Split a qualified identifier like "var.foo", "global.bar", "param.baz"
 * into its scope prefix and bare name.
 * Returns null for plain identifiers that have no known scope prefix.
 */
export function splitQualified(
    value: string,
): { scope: VarScopeStr; baseName: string } | null {
    if (value.startsWith('var.')) return { scope: 'var', baseName: value.slice(4) };
    if (value.startsWith('global.')) return { scope: 'global', baseName: value.slice(7) };
    if (value.startsWith('param.')) return { scope: 'param', baseName: value.slice(6) };
    return null;
}

/**
 * Given a token and its index in the token stream, determine the scope and
 * base name of the variable it refers to.
 *
 * Handles two forms:
 *   • Qualified usage:   `var.foo`   → { scope: 'var', baseName: 'foo' }
 *   • Declaration form:  `var foo`   → { scope: 'var', baseName: 'foo' }
 *                          (cursor on 'foo', previous token is the keyword)
 *
 * Returns null for tokens that are not variable references.
 */
export function resolveVariableToken(
    tokens: Token[],
    tokIdx: number,
): { scope: VarScopeStr; baseName: string } | null {
    const tok = tokens[tokIdx];
    if (tok.type !== TokenType.Identifier) return null;

    // Qualified usage: var.x / global.x / param.x
    const qualified = splitQualified(tok.value);
    if (qualified) return qualified;

    // Declaration form: keyword immediately before bare name
    const prev = tokIdx > 0 ? tokens[tokIdx - 1] : null;
    if (
        prev &&
        (prev.type === TokenType.Var ||
            prev.type === TokenType.Global ||
            prev.type === TokenType.Param)
    ) {
        return {
            scope: prev.value.toLowerCase() as VarScopeStr,
            baseName: tok.value,
        };
    }

    return null;
}