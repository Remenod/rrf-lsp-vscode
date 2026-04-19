// analysis/rename.ts
// Builds a WorkspaceEdit for renaming a var / global / param symbol.
//
// • var / param  → edits in the current file only (these are file-scoped).
// • global       → edits across ALL known files (globals are workspace-scoped).

import { RenameParams, WorkspaceEdit, TextEdit } from 'vscode-languageserver/node';
import { Lexer } from '../parser/lexer';
import { findTokenAtChar, resolveVariableToken } from './utils';
import { findOccurrencesInDoc } from './occurrences';

/**
 * @param params       Standard LSP RenameParams (position + newName).
 * @param currentText  Text of the document that triggered the rename.
 * @param currentUri   URI of that document.
 * @param allDocs      All documents known to the server (uri → text).
 *                     For var/param the map is not used beyond the current file.
 */
export function buildRenameEdit(
    params: RenameParams,
    currentText: string,
    currentUri: string,
    allDocs: Map<string, string>,
): WorkspaceEdit | null {
    // ── 1. Identify the symbol under the cursor ────────────────────────────────
    const lines = currentText.split(/\r?\n/);
    const lineText = lines[params.position.line] ?? '';
    const tokens = new Lexer(lineText, params.position.line).tokenize();

    const found = findTokenAtChar(tokens, params.position.character);
    if (!found) return null;

    const resolved = resolveVariableToken(tokens, found.idx);
    if (!resolved) return null;

    const { scope, baseName } = resolved;

    // Strip any accidental scope prefix the user may have typed in the new-name box.
    const newBaseName = params.newName.replace(/^(var|global|param)\./, '').trim();
    if (!newBaseName) return null;

    // ── 2. Decide which files to search ───────────────────────────────────────
    //  global → workspace-wide (all indexed files)
    //  var / param → current file only (lexically scoped)
    const docsToSearch: Map<string, string> =
        scope === 'global'
            ? allDocs
            : new Map([[currentUri, currentText]]);

    // ── 3. Collect edits ───────────────────────────────────────────────────────
    const changes: Record<string, TextEdit[]> = {};

    for (const [uri, text] of docsToSearch) {
        const spans = findOccurrencesInDoc(text, scope, baseName);
        if (spans.length === 0) continue;

        changes[uri] = spans.map(s =>
            TextEdit.replace(
                {
                    start: { line: s.line, character: s.start },
                    end: { line: s.line, character: s.end },
                },
                // Declaration token holds only the bare name; usage token is qualified.
                s.isDeclaration ? newBaseName : `${scope}.${newBaseName}`,
            ),
        );
    }

    if (Object.keys(changes).length === 0) return null;
    return { changes };
}
