// analysis/hover.ts

import { Hover, MarkupKind } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';
import { SymbolTable } from './symbolTable';
import { isValidOmPath, getOmPathInfo, isOmIndexAvailable, OmTarget } from './objectModelIndex';
import { typeAtPosition, globalType, displayType, paramType, paramCallers, CallSite } from './typecheck';
import { commandKey, isBuiltIn } from './gcodeParams';
import { getSdRootForUri, uriToFsPath } from './argValidators';
import * as path from 'path';

interface GCodeDoc { title: string; description: string; anchor?: string }
type DocDB = Record<string, GCodeDoc>;

const META_DOCS_URL = 'https://docs.duet3d.com/User_manual/Reference/Gcode_meta_commands';

export function buildHover(
    tokens: Token[],
    character: number,
    lineNum: number,
    gcodeData: DocDB,
    metaData: DocDB,
    operatorsData: DocDB,
    functionsData: DocDB,
    symbolTable: SymbolTable,
    uri: string,
    lineIndent: number = 0,
    // Full document lines — lets var lookups respect block closure, so hovering
    // a var whose block already ended reports it as undeclared (matching the
    // diagnostics) instead of pointing at the dead declaration.
    docLines?: string[],
    /** Firmware line and SBC setting for object-model paths. */
    omTarget?: OmTarget,
): Hover | null {
    const tokIdx = tokens.findIndex(t => t.start <= character && character < t.end);
    if (tokIdx === -1) return null;
    const tok = tokens[tokIdx];

    // Inferred type at this exact position (flow-sensitive), as shown in the `Type:` field.
    const lines = docLines ?? symbolTable.getText(uri)?.split(/\r?\n/);
    const inferred = (fallback: string | undefined): string => {
        const t = lines ? typeAtPosition(symbolTable, uri, lines, lineNum, tok.start) : undefined;
        return t !== undefined ? displayType(t) : fallback ?? 'unknown';
    };

    const formatHoverWithAnchor = (title: string, data: GCodeDoc, baseUrl: string = META_DOCS_URL): Hover => {
        const anchorLink = data.anchor ? `\n\n[Documentation](${baseUrl}${data.anchor})` : '';
        return mkHover(`### **${title == "*" ? "\\*" : title}** — ${data.title}\n\n${anchorLink}\n\n${data.description}`);
    };

    switch (tok.type) {
        // ── G / M codes ───────────────────────────────────────────────────────
        case TokenType.GCode: {
            const data = gcodeData[tok.value.toUpperCase()];
            const command = commandKey(tok.value);
            if (!data && command && !isBuiltIn(command)) {
                // GCodes::TryMacroFile: a command the firmware does not have runs the macro of its name.
                return mkHover(`**${tok.value}**\n\nNot a firmware command: it runs the macro \`sys/${command}.g\` if that exists, ` +
                    `with every parameter letter passed as \`param.<letter>\`.`);
            }
            if (!data) return mkHover(`**${tok.value}**\n\n*No documentation found.*`);
            const anchor = data.anchor
                ? `\n\n[Documentation](https://docs.duet3d.com/en/User_manual/Reference/Gcodes${data.anchor})`
                : '';
            return mkHover(`### **${tok.value}** — ${data.title}\n\n${anchor}\n\n${data.description}`);
        }

        case TokenType.TCode: {
            const data = gcodeData["T"];
            if (!data) return mkHover(`**${tok.value}**\n\n*No documentation found.*`);
            const anchor = data.anchor
                ? `\n\n[Documentation](https://docs.duet3d.com/en/User_manual/Reference/Gcodes${data.anchor})`
                : '';
            return mkHover(`### **T** — ${data.title}\n\n${anchor}\n\n${data.description}`);
        }

        case TokenType.FunctionName: {
            // Could be a function call OR a field name after [n]. (e.g. "max" in axes[0].max).
            // Check if it is preceded by a Dot to disambiguate.
            if (tokIdx > 0 && tokens[tokIdx - 1]?.type === TokenType.Dot) {
                // Treat as an OM field — reconstruct path
                const fullPath = reconstructOmPath(tokens, tokIdx);
                return buildOmHover(fullPath, omTarget);
            }
            const data = functionsData[tok.value.toLowerCase()];
            if (!data) return mkHover(`**${tok.value}()**\n\n*No documentation found.*`);
            return formatHoverWithAnchor(tok.value, data);
        }

        // ── Meta keywords & Named constants ───────────────────────────────────
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
        case TokenType.Skip:
        case TokenType.True:
        case TokenType.False:
        case TokenType.Null:
        case TokenType.Pi:
        case TokenType.Iterations:
        case TokenType.Line:
        case TokenType.Result:
        case TokenType.Input: {
            const key = tok.value.toLowerCase();
            const data = metaData[key];
            if (!data) return mkHover(`### **${tok.value}** — meta command / constant`);
            return formatHoverWithAnchor(tok.value, data);
        }

        // ── Identifiers: var.x, global.x, param.x, object model paths ─────────
        case TokenType.Identifier: {
            const val = tok.value;

            // ── Declaration context: `var foo = …`  or  `global foo = …` ────────
            //
            // When the cursor is on the bare name that immediately follows a var /
            // global keyword, the token value is the plain identifier (e.g. "foo"),
            // NOT the qualified form ("var.foo").  Without this guard the code falls
            // through to reconstructOmPath → buildOmHover which always produces the
            // false-positive "Unknown Object Model path" warning.
            {
                const prevTok = tokIdx > 0 ? tokens[tokIdx - 1] : null;
                if (prevTok?.type === TokenType.Var) {
                    const decl = symbolTable.lookupVarAtLine(val, uri, lineNum, lineIndent, docLines);
                    if (decl) {
                        return mkHover(
                            `**var.${val}**\n\nScope: \`var\` · Type: \`${inferred(decl.inferredType)}\` · Declared at line ${decl.line + 1} (indent ${decl.indent})`
                        );
                    }
                    return mkHover(`**var.${val}**\n\nScope: \`var\` · Declaration`);
                }
                if (prevTok?.type === TokenType.Global) {
                    const decl = symbolTable.lookupGlobal(val);
                    if (decl) {
                        return mkHover(
                            `**global.${val}**\n\nScope: \`global\` · Type: \`${displayType(globalType(symbolTable, val))}\` · Declared in \`${shortUri(decl.uri)}\` at line ${decl.line + 1}`
                        );
                    }
                    return mkHover(`**global.${val}**\n\nScope: \`global\` · Declaration`);
                }
            }

            if (val.startsWith('var.')) {
                const name = val.slice(4);
                const decl = symbolTable.lookupVarAtLine(name, uri, lineNum, lineIndent, docLines);
                if (!decl) {
                    return mkHover(`**${val}**\n\n⚠️ *Undeclared variable — no \`var ${name} = ...\` found in scope.*`);
                }
                return mkHover(
                    `**${val}**\n\nScope: \`var\` · Type: \`${inferred(decl.inferredType)}\` · Declared at line ${decl.line + 1} (indent ${decl.indent})`
                );
            }

            if (val.startsWith('global.')) {
                const name = val.slice(7);
                const decl = symbolTable.lookupGlobal(name);
                if (!decl) {
                    return mkHover(
                        `**${val}**\n\nType: \`unknown\` · *Not declared in any open file — may be declared in a closed macro or created at runtime.*`
                    );
                }
                return mkHover(
                    `**${val}**\n\nScope: \`global\` · Type: \`${inferred(displayType(globalType(symbolTable, name)))}\` · Declared in \`${shortUri(decl.uri)}\` at line ${decl.line + 1}`
                );
            }

            if (val.startsWith('param.')) {
                const name = val.slice(6);
                return mkHover(`**${val}**\n\nMacro parameter · Type: \`${inferred(displayType(paramType(symbolTable, uri, name)))}\`` +
                    `\n\n${paramSources(paramCallers(symbolTable, uri), name, uri)}\n\n` +
                    `⚠️ *Macro parameters cannot be renamed — the letter is determined by the G-code word at the call site.*`);
            }

            // Bare identifier — reconstruct the full OM path from token context
            const fullPath = reconstructOmPath(tokens, tokIdx);
            return buildOmHover(fullPath, omTarget);
        }

        // ── Operators ─────────────────────────────────────────────────────────
        case TokenType.Plus:
        case TokenType.Minus:
        case TokenType.Star:
        case TokenType.Slash:
        case TokenType.Caret:
        case TokenType.Eq:
        case TokenType.EqEq:
        case TokenType.NEq:
        case TokenType.Lt:
        case TokenType.Gt:
        case TokenType.LtEq:
        case TokenType.GtEq:
        case TokenType.And:
        case TokenType.Or:
        case TokenType.Not:
        case TokenType.Ternary:
        case TokenType.Hash:
        case TokenType.DoubleGt:
        case TokenType.TripleGt: {
            const data = operatorsData[tok.value];
            if (!data) return null;
            return formatHoverWithAnchor(tok.value, data);
        }

        default:
            return null;
    }
}

// ── Object Model path reconstruction ─────────────────────────────────────────
//
// The lexer tokenises  sensors.probes[0].value[0]  as:
//   [Identifier "sensors.probes"] [LBracket] [Integer "0"] [RBracket]
//   [Dot] [Identifier "value"] [LBracket] [Integer "0"] [RBracket]
//
// When the user hovers over "value" (tokIdx=5), we need to walk backwards
// through the token stream and build the normalised OM path.
//
// Result for the example above: "sensors.probes[].value"
// (we include [] for the subscript of the segment BEFORE the dot, not after,
//  since the cursor token is the start of the next segment.)
function reconstructOmPath(tokens: Token[], tokIdx: number): string {
    const curTok = tokens[tokIdx];
    // Start with the current token's value (it may already contain dots: "sensors.probes")
    let segments: string[] = [curTok.value];

    let i = tokIdx - 1;

    while (i >= 0) {
        const t = tokens[i];

        if (t.type === TokenType.Dot) {
            // The segment before this dot may be an identifier possibly followed by [n]
            i--;
            // Walk back past any trailing subscript(s) of the previous segment
            let trailingIndex = '';
            while (i >= 0 && tokens[i].type === TokenType.RBracket) {
                trailingIndex = '[]' + trailingIndex;
                i--; // skip ]
                // skip the index expression
                let depth = 1;
                while (i >= 0 && depth > 0) {
                    if (tokens[i].type === TokenType.RBracket) depth++;
                    else if (tokens[i].type === TokenType.LBracket) depth--;
                    i--;
                }
            }
            // Now tokens[i] should be the identifier for this segment
            if (i >= 0 && (tokens[i].type === TokenType.Identifier || tokens[i].type === TokenType.FunctionName)) {
                segments.unshift(tokens[i].value + trailingIndex);
                i--;
            } else {
                break;
            }
        } else {
            break;
        }
    }

    return segments.join('.');
}

// ── Object Model hover ────────────────────────────────────────────────────────
function buildOmHover(path: string, omTarget?: OmTarget): Hover {
    const omRef = '\n\nSee [Object Model reference](https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Reference).';
    // Normalise [n] → [] for lookup
    const normPath = path.replace(/\[\d+\]/g, '[]');

    if (!isOmIndexAvailable()) {
        return mkHover(`**${path}**\n\nObject Model path — resolved at runtime by RepRapFirmware.${omRef}`);
    }

    if (isValidOmPath(normPath, omTarget)) {
        const info = getOmPathInfo(normPath, omTarget);
        const typeStr = info ? ` · Type: \`${info.type.split('|').join(' | ')}\`` : '';
        return mkHover(`**${path}**\n\nObject Model path${typeStr}${omRef}`);
    }

    return mkHover(
        `**${path}**\n\n⚠️ *Unknown Object Model path — not found in the static schema.*\n\nIf this is a plugin-provided property it will be resolved at runtime.${omRef}`
    );
}

function mkHover(md: string): Hover {
    return { contents: { kind: MarkupKind.Markdown, value: md } };
}

/** Where `param.<name>` gets its values: the calls of this file in the workspace (TC-PRM-01..03). */
function paramSources(callers: CallSite[], name: string, uri: string): string {
    if (callers.length === 0) {
        return `No file in the workspace runs this one, so the value is whatever the caller passes: ` +
            `\`M98 P"${rrfPath(uri)}" ${name}10\` gives \`param.${name}\` = 10.`;
    }
    const where = (c: CallSite) => (c.uri === null ? c.note ?? 'the firmware runs it' : `\`${shortUri(c.uri)}\` line ${c.line + 1}`);
    const passing = callers.filter(c => c.letters.includes(name));
    const others = callers.length - passing.length;
    const shown = passing.slice(0, 5).map(c => `* ${where(c)}`);
    if (passing.length > shown.length) shown.push(`* … and ${passing.length - shown.length} more`);
    const head = passing.length
        ? `Passed by ${passing.length === 1 ? 'this call' : `these ${passing.length} calls`}:\n\n${shown.join('\n')}`
        : `None of the ${callers.length} call${callers.length === 1 ? '' : 's'} of this file passes ${name}: \`exists(param.${name})\` is false there.`;
    return passing.length && others ? `${head}\n\n${others} other call${others === 1 ? '' : 's'} do${others === 1 ? 'es' : ''} not pass ${name}.` : head;
}

function shortUri(uri: string): string {
    return uri.split('/').slice(-2).map(p => { try { return decodeURIComponent(p); } catch { return p; } }).join('/');
}

/** The file as the firmware names it (`/macros/Do It`), or its short name outside an SD card. */
function rrfPath(uri: string): string {
    const file = uriToFsPath(uri);
    const sd = getSdRootForUri(uri);
    if (!file || !sd) return shortUri(uri);
    return '/' + path.relative(sd, file).split(path.sep).join('/');
}
