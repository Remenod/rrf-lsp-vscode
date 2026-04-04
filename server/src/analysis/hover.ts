// analysis/hover.ts
// Token-based hover provider.  Replaces the raw-regex approach in the original server.ts.

import { Token, TokenType } from '../parser/types';
import { FUNCTION_SIGNATURES, NAMED_CONSTANT_DOCS, META_COMMAND_DOCS } from '../data/signatures';
import { SymbolTable } from './symbolTable';
import { MarkupKind, Hover } from 'vscode-languageserver/node';

interface GCodeDoc { title: string; description: string; anchor: string }
type DocDB = Record<string, GCodeDoc>;

export function buildHover(
    tokens: Token[],
    character: number,
    lineNumber: number,
    gcodeData: DocDB,
    metaData: DocDB,
    operatorsData: DocDB,
    functionsData: DocDB,
    symbolTable: SymbolTable,
    documentUri: string,
): Hover | null {

    // Find the token under the cursor
    const tok = tokens.find(t =>
        t.type !== TokenType.EOF &&
        t.type !== TokenType.Comment &&
        character >= t.start &&
        character <= t.end
    );

    if (!tok) return null;

    const range = {
        start: { line: lineNumber, character: tok.start },
        end: { line: lineNumber, character: tok.end },
    };

    const md = (value: string): Hover => ({ contents: { kind: MarkupKind.Markdown, value }, range });

    // ── Literals ──────────────────────────────────────────────────────────────
    switch (tok.type) {
        case TokenType.StringLit: {
            const len = tok.value.length - 2; // minus quotes (approx)
            return md(`### String Literal\n---\n**Value:** \`${tok.value}\`\n\nStrings are limited to **100 characters**. Use \`""\` to embed a double-quote.`);
        }
        case TokenType.CharLit:
            return md(`### Character Literal\n---\n**Value:** \`${tok.value}\`\n\n*(Supported in RRF 3.5.0 and later)*`);

        case TokenType.Integer:
            return md(`### Integer Literal\n---\n**Value:** \`${tok.value}\`\n\nDecimal integer.`);
        case TokenType.HexInteger:
            return md(`### Integer Literal (Hexadecimal)\n---\n**Value:** \`${tok.value}\`\n\nEquivalent decimal: \`${parseInt(tok.value, 16)}\``);
        case TokenType.BinInteger:
            return md(`### Integer Literal (Binary)\n---\n**Value:** \`${tok.value}\`\n\nEquivalent decimal: \`${parseInt(tok.value.slice(2), 2)}\``);
        case TokenType.Float:
            return md(`### Float Literal\n---\n**Value:** \`${tok.value}\`\n\n${tok.value.toLowerCase().includes('e') ? 'Scientific notation.' : 'Fixed-point decimal.'}`);

        // ── Named constants ──────────────────────────────────────────────────────
        case TokenType.True:
        case TokenType.False:
        case TokenType.Null:
        case TokenType.Pi:
        case TokenType.Iterations:
        case TokenType.Line:
        case TokenType.Result:
        case TokenType.Input: {
            const name = tok.value.toLowerCase();
            const doc = NAMED_CONSTANT_DOCS[name] ?? '';
            return md(`### \`${name}\`\n---\n${doc}`);
        }

        // ── G/M/T codes ──────────────────────────────────────────────────────────
        case TokenType.GCode: {
            const key = tok.value.toUpperCase();
            const data = gcodeData[key];
            if (!data) return null;
            return md(formatGCodeDoc(key, data, 'https://docs.duet3d.com/User_manual/Reference/Gcodes'));
        }
        case TokenType.TCode: {
            const data = gcodeData['T'];
            if (!data) return null;
            return md(formatGCodeDoc('T', data, 'https://docs.duet3d.com/User_manual/Reference/Gcodes'));
        }

        // ── Functions ─────────────────────────────────────────────────────────────
        case TokenType.FunctionName: {
            const name = tok.value.toLowerCase();
            // First try JSON data file, then built-in signatures
            const jsonDoc = functionsData[name] ?? functionsData[tok.value];
            if (jsonDoc) {
                return md(formatGCodeDoc(name, jsonDoc, 'https://docs.duet3d.com/User_manual/Reference/Gcode_meta_commands'));
            }
            const sig = FUNCTION_SIGNATURES[name];
            if (sig) return md(formatFunctionDoc(sig));
            return null;
        }

        // ── Meta keywords ─────────────────────────────────────────────────────────
        case TokenType.If:
        case TokenType.Elif:
        case TokenType.Else:
        case TokenType.While:
        case TokenType.Break:
        case TokenType.Continue:
        case TokenType.Abort:
        case TokenType.Var:
        case TokenType.Global:
        case TokenType.Set:
        case TokenType.Echo:
        case TokenType.Param:
        case TokenType.Skip: {
            const name = tok.value.toLowerCase();
            const mData = META_COMMAND_DOCS[name];
            const jsonDoc = metaData[name] ?? metaData[tok.value];
            if (jsonDoc) {
                return md(formatGCodeDoc(name, jsonDoc, 'https://docs.duet3d.com/User_manual/Reference/Gcode_meta_commands'));
            }
            if (mData) {
                return md(`### \`${name}\` — ${mData.title}\n---\n**Syntax:** \`${mData.syntax}\`\n\n${mData.doc}`);
            }
            return null;
        }

        // ── Operators ─────────────────────────────────────────────────────────────
        case TokenType.EqEq:
        case TokenType.NEq:
        case TokenType.LtEq:
        case TokenType.GtEq:
        case TokenType.And:
        case TokenType.Or:
        case TokenType.Ternary:
        case TokenType.Not:
        case TokenType.Plus:
        case TokenType.Minus:
        case TokenType.Star:
        case TokenType.Slash:
        case TokenType.Caret:
        case TokenType.Hash:
        case TokenType.Lt:
        case TokenType.Gt:
        case TokenType.Eq: {
            const opKey = operatorLookupKey(tok);
            const data = operatorsData[opKey];
            if (data) {
                return md(formatGCodeDoc(`"${tok.value}"`, data, 'https://docs.duet3d.com/User_manual/Reference/Gcode_meta_commands'));
            }
            return null;
        }

        // ── Variables (Identifier) ────────────────────────────────────────────────
        case TokenType.Identifier: {
            const v = symbolTable.resolveQualified(tok.value, documentUri);
            if (v) {
                return md(
                    `### \`${v.scope}.${v.name}\`\n` +
                    `---\n` +
                    `**Scope:** \`${v.scope}\`  \n` +
                    `**Type:** \`${v.inferredType ?? 'unknown'}\`  \n` +
                    `**Declared at:** line ${v.line + 1}`
                );
            }
            return null;
        }

        default:
            return null;
    }
}

// ── Format helpers ─────────────────────────────────────────────────────────────
function formatGCodeDoc(command: string, doc: GCodeDoc, baseUrl: string): string {
    return [
        `### ${command}: ${doc.title}`,
        `##### [View in Duet3D Documentation](${baseUrl}${doc.anchor})`,
        `---`,
        doc.description,
    ].join('\n\n');
}

function formatFunctionDoc(sig: FUNCTION_SIGNATURES[string]): string {
    const paramList = sig.params.map(p => p.name).join(', ');
    const paramDocs = sig.params
        .map(p => `- \`${p.name}\` *(${p.type ?? 'any'})*: ${p.doc}`)
        .join('\n');
    return [
        `### \`${sig.name}(${paramList})\` → \`${sig.returnType}\``,
        `---`,
        sig.doc,
        paramDocs ? `\n**Parameters:**\n${paramDocs}` : '',
    ].filter(Boolean).join('\n\n');
}

// Map token type → operator lookup key for the JSON data files
function operatorLookupKey(tok: Token): string {
    switch (tok.type) {
        case TokenType.And: return '&&';
        case TokenType.Or: return '||';
        case TokenType.Eq: return '==';
        case TokenType.EqEq: return '==';
        default: return tok.value;
    }
}

// Re-export type for import convenience
type FUNCTION_SIGNATURES = typeof FUNCTION_SIGNATURES;
