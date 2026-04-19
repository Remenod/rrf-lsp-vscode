// Finds every span in a document where a scoped variable is referenced or declared.
// Used by both rename (to build TextEdits) and references (to build Locations).

import { Location, Range } from 'vscode-languageserver/node';
import { Lexer } from '../parser/lexer';
import { TokenType } from '../parser/types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface OccurrenceSpan {
    line: number;
    start: number;
    end: number;
    /**
     * True  → bare name after a scope keyword (`var foo`, `global foo`).
     * False → qualified usage (`var.foo`, `global.foo`).
     */
    isDeclaration: boolean;
}

// ── Core ───────────────────────────────────────────────────────────────────────

/**
 * Return every occurrence of `scope.baseName` in `docText`.
 *
 * Two token forms are matched:
 *   1. Qualified identifier:  `var.foo` / `global.foo` / `param.foo`
 *   2. Declaration keyword:   `var foo = …` / `global foo = …` / `param foo = …`
 */
export function findOccurrencesInDoc(
    docText: string,
    scope: string,
    baseName: string,
): OccurrenceSpan[] {
    const results: OccurrenceSpan[] = [];
    const qualifiedName = `${scope}.${baseName}`;
    const lines = docText.split(/\r?\n/);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const lineTokens = new Lexer(lines[lineIdx], lineIdx).tokenize();

        for (let j = 0; j < lineTokens.length; j++) {
            const t = lineTokens[j];
            if (t.type !== TokenType.Identifier) continue;

            if (t.value === qualifiedName) {
                // Qualified usage: `var.foo`
                results.push({ line: lineIdx, start: t.start, end: t.end, isDeclaration: false });
            } else if (t.value === baseName) {
                // Declaration form: keyword immediately before bare name
                const prev = j > 0 ? lineTokens[j - 1] : null;
                if (
                    prev &&
                    prev.value.toLowerCase() === scope &&
                    (prev.type === TokenType.Var ||
                        prev.type === TokenType.Global ||
                        prev.type === TokenType.Param)
                ) {
                    results.push({ line: lineIdx, start: t.start, end: t.end, isDeclaration: true });
                }
            }
        }
    }

    return results;
}

// ── Conversion helpers ─────────────────────────────────────────────────────────

/** Convert OccurrenceSpans to LSP Location objects. */
export function occurrencesToLocations(spans: OccurrenceSpan[], uri: string): Location[] {
    return spans.map(s =>
        Location.create(uri, Range.create(s.line, s.start, s.line, s.end)),
    );
}