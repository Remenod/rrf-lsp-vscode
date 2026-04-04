// server.ts — RRF G-code / meta-command LSP server
// Features: Hover · Diagnostics · Completions · Signature Help · Semantic Tokens

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  HoverParams,
  Hover,
  MarkupKind,
  CompletionParams,
  CompletionItem,
  CompletionItemKind,
  SignatureHelpParams,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  DiagnosticSeverity,
  Diagnostic,
  SemanticTokensParams,
  SemanticTokens,
  SemanticTokensBuilder,
  TextDocumentChangeEvent,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';

import { Lexer } from './parser/lexer';
import { Token, TokenType, FUNCTION_NAMES, NAMED_CONSTANTS, META_KEYWORDS, SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } from './parser/types';
import { validateLine } from './parser/expression';
import { SymbolTable } from './analysis/symbolTable';
import { buildHover } from './analysis/hover';
import { FUNCTION_SIGNATURES, META_COMMAND_DOCS } from './data/signatures';

// ── Connection setup ──────────────────────────────────────────────────────────
const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments<TextDocument>(TextDocument);
const symbolTable = new SymbolTable();

// ── Load JSON data files ──────────────────────────────────────────────────────
interface GCodeDoc { title: string; description: string; anchor: string }
type DocDB = Record<string, GCodeDoc>;

function loadJson<T>(relPath: string, label: string): T {
  const absPath = path.join(__dirname, relPath);
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8')) as T;
  } catch (e) {
    connection.console.error(`Failed to load ${label}: ${e}`);
    return {} as T;
  }
}

const gcodeData: DocDB = loadJson('../data/gcode-commands.json', 'G-code dictionary');
const metaData: DocDB = loadJson('../data/gcode-meta-commands.json', 'meta-commands dictionary');
const operatorsData: DocDB = loadJson('../data/gcode-operators.json', 'operators dictionary');
const functionsData: DocDB = loadJson('../data/gcode-functions.json', 'functions dictionary');

// ── Initialize ────────────────────────────────────────────────────────────────
connection.onInitialize((_params: InitializeParams): InitializeResult => {
  connection.console.log('RRF LSP initializing…');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['.', ' ', '(', '{'],
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [','],
      },
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: SEMANTIC_TOKEN_TYPES,
          tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
        },
        full: true,
      },
    },
  };
});

connection.onInitialized(() => connection.console.log('RRF LSP ready.'));

// ── Document lifecycle → symbol table + diagnostics ───────────────────────────
documents.onDidOpen(e => onDocumentChange(e.document));
documents.onDidChangeContent(e => onDocumentChange(e.document));
documents.onDidClose((e: TextDocumentChangeEvent<TextDocument>) => {
  symbolTable.removeDocument(e.document.uri);
});

function onDocumentChange(doc: TextDocument): void {
  symbolTable.indexDocument(doc.uri, doc.getText());
  publishDiagnostics(doc);
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
function publishDiagnostics(doc: TextDocument): void {
  const text = doc.getText();
  const lines = text.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];

  for (let i = 0; i < lines.length; i++) {
    const tokens = new Lexer(lines[i], i).tokenize();
    const errors = validateLine(tokens, lines[i]);

    for (const err of errors) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: err.line, character: err.start },
          end: { line: err.line, character: err.end },
        },
        message: err.message,
        source: 'rrf-gcode',
      });
    }

    // Warn about deprecated >>> operator
    for (const tok of tokens) {
      if (tok.type === TokenType.TripleGt) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: {
            start: { line: i, character: tok.start },
            end: { line: i, character: tok.end },
          },
          message: '>>> is a deprecated redirect operator. Use echo with > redirection instead.',
          source: 'rrf-gcode',
        });
      }
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

// ── Hover ─────────────────────────────────────────────────────────────────────
connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const line = lines[params.position.line] ?? '';
  const tokens = new Lexer(line, params.position.line).tokenize();

  return buildHover(
    tokens, params.position.character, params.position.line,
    gcodeData, metaData, operatorsData, functionsData,
    symbolTable, params.textDocument.uri,
  );
});

// ── Completions ───────────────────────────────────────────────────────────────
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const lines = doc.getText().split(/\r?\n/);
  const line = lines[params.position.line] ?? '';
  const prefix = line.slice(0, params.position.character);

  // var.<cursor>  →  local variable names
  if (/\bvar\.$/.test(prefix)) {
    return symbolTable.getLocalCompletions(params.textDocument.uri).map(v => ({
      label: v.name,
      kind: CompletionItemKind.Variable,
      detail: `var.${v.name} (${v.inferredType ?? 'unknown'})`,
      documentation: { kind: MarkupKind.Markdown, value: `Local variable declared at line ${v.line + 1}` },
    }));
  }

  // global.<cursor>  →  global variable names
  if (/\bglobal\.$/.test(prefix)) {
    return symbolTable.getGlobalCompletions().map(v => ({
      label: v.name,
      kind: CompletionItemKind.Variable,
      detail: `global.${v.name} (${v.inferredType ?? 'unknown'})`,
      documentation: { kind: MarkupKind.Markdown, value: `Global variable declared in \`${shortUri(v.uri)}\` at line ${v.line + 1}` },
    }));
  }

  // param.<cursor>  →  parameter names
  if (/\bparam\.$/.test(prefix)) {
    return symbolTable.getParamCompletions(params.textDocument.uri).map(v => ({
      label: v.name,
      kind: CompletionItemKind.Variable,
      detail: `param.${v.name} (${v.inferredType ?? 'unknown'})`,
      documentation: { kind: MarkupKind.Markdown, value: `Macro parameter declared at line ${v.line + 1}` },
    }));
  }

  // Context: inside { } expression — offer functions + constants + vars
  const inExpr = /\{[^}]*$/.test(prefix) || /(?:if|elif|while|set|echo|var\s+\w+\s*=)\s+\S*$/.test(prefix);

  const items: CompletionItem[] = [];

  // G/M codes — only at line start (not inside expressions)
  if (!inExpr && /^\s*$/.test(prefix)) {
    for (const [code, data] of Object.entries(gcodeData)) {
      items.push({
        label: code,
        kind: CompletionItemKind.Module,
        detail: data.title,
        documentation: { kind: MarkupKind.Markdown, value: data.description },
      });
    }
    // Meta commands
    for (const [name, info] of Object.entries(META_COMMAND_DOCS)) {
      items.push({
        label: name,
        kind: CompletionItemKind.Keyword,
        detail: info.title,
        documentation: { kind: MarkupKind.Markdown, value: `**Syntax:** \`${info.syntax}\`\n\n${info.doc}` },
        insertText: metaInsertText(name),
      });
    }
  }

  // Functions (inside expressions or at word start)
  for (const [name, sig] of Object.entries(FUNCTION_SIGNATURES)) {
    items.push({
      label: name,
      kind: CompletionItemKind.Function,
      detail: `${name}(${sig.params.map(p => p.name).join(', ')}) → ${sig.returnType}`,
      documentation: { kind: MarkupKind.Markdown, value: sig.doc },
      insertText: `${name}($0)`,
      insertTextFormat: 2, // snippet
    });
  }

  // Named constants
  for (const name of NAMED_CONSTANTS) {
    items.push({ label: name, kind: CompletionItemKind.Constant });
  }

  // All in-scope variables
  for (const v of symbolTable.getAllCompletions(params.textDocument.uri)) {
    items.push({
      label: `${v.scope}.${v.name}`,
      kind: CompletionItemKind.Variable,
      detail: `${v.scope}.${v.name} (${v.inferredType ?? 'unknown'})`,
    });
  }

  return items;
});

// ── Signature Help ─────────────────────────────────────────────────────────────
connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const lines = doc.getText().split(/\r?\n/);
  const lineText = lines[params.position.line] ?? '';
  const upToCursor = lineText.slice(0, params.position.character);

  // Walk backwards to find the innermost open function call
  let depth = 0;
  let funcStart = -1;
  for (let i = upToCursor.length - 1; i >= 0; i--) {
    const c = upToCursor[i];
    if (c === ')') { depth++; continue; }
    if (c === '(') {
      if (depth > 0) { depth--; continue; }
      funcStart = i;
      break;
    }
  }

  if (funcStart < 0) return null;

  // Extract function name (identifier immediately before '(')
  const beforeParen = upToCursor.slice(0, funcStart).trimEnd();
  const nameMatch = /([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(beforeParen);
  if (!nameMatch) return null;

  const funcName = nameMatch[1].toLowerCase();
  const sig = FUNCTION_SIGNATURES[funcName];
  if (!sig) return null;

  // Count commas at top-level (depth 0) inside the current call
  const inside = upToCursor.slice(funcStart + 1);
  let activeParam = 0;
  let d = 0;
  for (const c of inside) {
    if (c === '(' || c === '[' || c === '{') { d++; continue; }
    if (c === ')' || c === ']' || c === '}') { d--; continue; }
    if (c === ',' && d === 0) activeParam++;
  }
  activeParam = Math.min(activeParam, sig.params.length - 1);

  const label = `${sig.name}(${sig.params.map(p => p.name).join(', ')})`;
  const params2: ParameterInformation[] = sig.params.map(p => ({
    label: p.name,
    documentation: { kind: MarkupKind.Markdown, value: `*${p.type ?? 'any'}* — ${p.doc}` },
  }));

  return {
    signatures: [{
      label,
      documentation: { kind: MarkupKind.Markdown, value: sig.doc },
      parameters: params2,
    } as SignatureInformation],
    activeSignature: 0,
    activeParameter: activeParam,
  };
});

// ── Semantic Tokens ────────────────────────────────────────────────────────────
// Token type indices (must match SEMANTIC_TOKEN_TYPES order)
const ST = {
  keyword: 0,
  function: 1,
  variable: 2,
  number: 3,
  string: 4,
  operator: 5,
  parameter: 6,
  macro: 7,
  comment: 8,
};

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };

  const builder = new SemanticTokensBuilder();
  const lines = doc.getText().split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const tokens = new Lexer(lines[i], i).tokenize();
    for (const tok of tokens) {
      const st = semanticTypeFor(tok);
      if (st !== null) {
        builder.push(i, tok.start, tok.end - tok.start, st, 0);
      }
    }
  }

  return builder.build();
});

function semanticTypeFor(tok: Token): number | null {
  switch (tok.type) {
    // Meta keywords
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
      return ST.keyword;

    // Functions
    case TokenType.FunctionName:
      return ST.function;

    // Variables
    case TokenType.Identifier: {
      const v = tok.value;
      if (v.startsWith('var.') || v.startsWith('global.') || v.startsWith('param.'))
        return ST.variable;
      return null;
    }

    // Named constants / parameters
    case TokenType.True:
    case TokenType.False:
    case TokenType.Null:
    case TokenType.Pi:
    case TokenType.Iterations:
    case TokenType.Line:
    case TokenType.Result:
    case TokenType.Input:
      return ST.parameter;

    // Numbers
    case TokenType.Integer:
    case TokenType.HexInteger:
    case TokenType.BinInteger:
    case TokenType.Float:
      return ST.number;

    // Strings
    case TokenType.StringLit:
    case TokenType.CharLit:
      return ST.string;

    // Operators
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
      return ST.operator;

    // G/M/T codes
    case TokenType.GCode:
    case TokenType.TCode:
      return ST.macro;

    // Comments
    case TokenType.Comment:
      return ST.comment;

    default:
      return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function shortUri(uri: string): string {
  return uri.split('/').slice(-2).join('/');
}

function metaInsertText(name: string): string {
  switch (name) {
    case 'if': return 'if {$1}';
    case 'elif': return 'elif {$1}';
    case 'while': return 'while {$1}';
    case 'var': return 'var $1 = $2';
    case 'global': return 'global $1 = $2';
    case 'set': return 'set $1 = $2';
    case 'echo': return 'echo $1';
    case 'abort': return 'abort "$1"';
    case 'param': return 'param $1 = $2';
    default: return name;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
documents.listen(connection);
connection.listen();
