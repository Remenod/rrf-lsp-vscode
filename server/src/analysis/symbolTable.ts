// analysis/symbolTable.ts
// Tracks var., global., and param. variable declarations across open documents.

import { Token, TokenType } from '../parser/types';
import { Lexer } from '../parser/lexer';

export type VarScope = 'var' | 'global' | 'param';

export interface VariableDecl {
    name: string;
    scope: VarScope;
    uri: string;
    line: number;
    col: number;
    inferredType?: string;   // 'int' | 'float' | 'bool' | 'string' | 'array' | 'unknown'
}

export class SymbolTable {
    // global. vars are shared across all files
    private globals = new Map<string, VariableDecl>();
    // var. locals are per-file
    private locals = new Map<string, Map<string, VariableDecl>>();  // uri → name → decl
    // param. declarations (per file)
    private params = new Map<string, Map<string, VariableDecl>>();

    // ── Scan a whole document ─────────────────────────────────────────────────
    indexDocument(uri: string, text: string): void {
        // Clear old entries for this document
        this.locals.set(uri, new Map());
        this.params.set(uri, new Map());
        const localMap = this.locals.get(uri)!;
        const paramMap = this.params.get(uri)!;

        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const tokens = new Lexer(line, i).tokenize();
            if (!tokens.length) continue;

            const first = tokens[0];

            // var <name> = ...
            if (first.type === TokenType.Var && tokens[1]?.type === TokenType.Identifier) {
                const name = tokens[1].value;
                const decl: VariableDecl = {
                    name, scope: 'var', uri, line: i, col: tokens[1].start,
                    inferredType: inferTypeFromTokens(tokens, 3),
                };
                localMap.set(name, decl);
            }

            // global <name> = ...
            else if (first.type === TokenType.Global && tokens[1]?.type === TokenType.Identifier) {
                const name = tokens[1].value;
                const decl: VariableDecl = {
                    name, scope: 'global', uri, line: i, col: tokens[1].start,
                    inferredType: inferTypeFromTokens(tokens, 3),
                };
                this.globals.set(name, decl);
            }

            // param <name> = ...   (macro parameter with default)
            else if (first.type === TokenType.Param && tokens[1]?.type === TokenType.Identifier) {
                const name = tokens[1].value;
                const decl: VariableDecl = {
                    name, scope: 'param', uri, line: i, col: tokens[1].start,
                    inferredType: inferTypeFromTokens(tokens, 3),
                };
                paramMap.set(name, decl);
            }
        }
    }

    // ── Remove document ───────────────────────────────────────────────────────
    removeDocument(uri: string): void {
        this.locals.delete(uri);
        this.params.delete(uri);
        // Remove globals that were defined in this document
        for (const [name, decl] of this.globals) {
            if (decl.uri === uri) this.globals.delete(name);
        }
    }

    // ── Completions ───────────────────────────────────────────────────────────
    getLocalCompletions(uri: string): VariableDecl[] {
        return [...(this.locals.get(uri)?.values() ?? [])];
    }

    getGlobalCompletions(): VariableDecl[] {
        return [...this.globals.values()];
    }

    getParamCompletions(uri: string): VariableDecl[] {
        return [...(this.params.get(uri)?.values() ?? [])];
    }

    getAllCompletions(uri: string): VariableDecl[] {
        return [
            ...this.getLocalCompletions(uri),
            ...this.getGlobalCompletions(),
            ...this.getParamCompletions(uri),
        ];
    }

    // ── Lookup ────────────────────────────────────────────────────────────────
    lookupVar(name: string, uri: string): VariableDecl | undefined {
        return this.locals.get(uri)?.get(name);
    }

    lookupGlobal(name: string): VariableDecl | undefined {
        return this.globals.get(name);
    }

    lookupParam(name: string, uri: string): VariableDecl | undefined {
        return this.params.get(uri)?.get(name);
    }

    // Resolve "var.foo", "global.bar", "param.baz"
    resolveQualified(qualified: string, uri: string): VariableDecl | undefined {
        if (qualified.startsWith('var.')) return this.lookupVar(qualified.slice(4), uri);
        if (qualified.startsWith('global.')) return this.lookupGlobal(qualified.slice(7));
        if (qualified.startsWith('param.')) return this.lookupParam(qualified.slice(6), uri);
        return undefined;
    }

    // Check unknown variable reference (for diagnostics)
    isKnownVar(qualified: string, uri: string): boolean {
        return this.resolveQualified(qualified, uri) !== undefined;
    }
}

// ── Simple type inference from the RHS tokens ─────────────────────────────────
// token index is the first token after '='
function inferTypeFromTokens(tokens: Token[], startIdx: number): string {
    const t = tokens[startIdx];
    if (!t || t.type === TokenType.EOF) return 'unknown';

    switch (t.type) {
        case TokenType.Integer:
        case TokenType.HexInteger:
        case TokenType.BinInteger: return 'int';
        case TokenType.Float: return 'float';
        case TokenType.StringLit: return 'string';
        case TokenType.CharLit: return 'char';
        case TokenType.True:
        case TokenType.False: return 'bool';
        case TokenType.LBracket:
        case TokenType.LBrace: return 'array';
        default: return 'unknown';
    }
}
