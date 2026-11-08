// Shared test harness: lint a snippet through the real diagnostics pipeline.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { Lexer } from '../../src/parser/lexer';
import { Token, TokenType } from '../../src/parser/types';
import { SymbolTable } from '../../src/analysis/symbolTable';
import { computeDiagnostics, DiagnosticsOptions } from '../../src/analysis/diagnostics';
import { ArgCheckConfig, defaultArgCheckConfig } from '../../src/analysis/argCheckConfig';
import { invalidateSdRootCache } from '../../src/analysis/argValidators';

/** server/ directory (this file compiles to server/out-test/test/helpers). */
export const SERVER_ROOT = path.resolve(__dirname, '..', '..', '..');
export const DATA_DIR = path.join(SERVER_ROOT, 'data');

export function readData(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
}

// ── Lexer helpers ─────────────────────────────────────────────────────────────

export function lex(line: string, lineNo = 0): Token[] {
  return new Lexer(line, lineNo).tokenize();
}

/** Token types without the trailing EOF. */
export function types(line: string): TokenType[] {
  return lex(line).filter(t => t.type !== TokenType.EOF).map(t => t.type);
}

/** `Name(value)` pairs, handy for readable assertions. */
export function shape(line: string): string[] {
  return lex(line)
    .filter(t => t.type !== TokenType.EOF)
    .map(t => `${TokenType[t.type]}(${t.value})`);
}

export function lexErrors(line: string) {
  const l = new Lexer(line, 0);
  l.tokenize();
  return l.errors;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export interface LintOptions {
  maxLineLength?: number;
  argCheck?: Partial<ArgCheckConfig> & { paths?: Partial<ArgCheckConfig['paths']> };
  /** File path to lint as (inside an SD tree for path checks). Defaults to a bare virtual URI. */
  file?: string;
  /** Target firmware version, e.g. '3.5.4' (type-check spec, `rrfgcode.rrfVersion`). */
  rrfVersion?: string;
  /**
   * Type checker on/off (type-check spec, `rrfgcode.typeCheck.enabled`). The harness defaults to
   * OFF so the syntax/scope suites keep testing exactly what they were written for; the
   * type-check suites switch it on explicitly. `'omit'` leaves the option out entirely.
   */
  typeCheck?: boolean | 'omit';
  /** Extra documents to index into the symbol table (for cross-file globals). */
  extraDocs?: Record<string, string>;
}

const VIRTUAL_URI = 'untitled:test.g';

export function lint(text: string, opts: LintOptions = {}): Diagnostic[] {
  const symbolTable = new SymbolTable();
  const uri = opts.file ? pathToFileURL(opts.file).toString() : VIRTUAL_URI;
  for (const [u, t] of Object.entries(opts.extraDocs ?? {})) symbolTable.indexDocument(u, t);
  symbolTable.indexDocument(uri, text);
  const base = defaultArgCheckConfig();
  const o: DiagnosticsOptions & { typeCheck?: { enabled: boolean }; rrfVersion?: string } = {
    symbolTable,
    maxLineLength: opts.maxLineLength ?? 255,
    argCheckConfig: {
      enabled: opts.argCheck?.enabled ?? base.enabled,
      paths: {
        enabled: opts.argCheck?.paths?.enabled ?? base.paths.enabled,
        ignore: opts.argCheck?.paths?.ignore ?? base.paths.ignore,
      },
    },
  };
  if (opts.typeCheck !== 'omit') o.typeCheck = { enabled: opts.typeCheck ?? false };
  if (opts.rrfVersion !== undefined) o.rrfVersion = opts.rrfVersion;
  return computeDiagnostics(uri, text, o as DiagnosticsOptions);
}

export const msgs = (ds: Diagnostic[]) => ds.map(d => d.message);
export const errorsOf = (ds: Diagnostic[]) => ds.filter(d => d.severity === DiagnosticSeverity.Error);
export const warningsOf = (ds: Diagnostic[]) => ds.filter(d => d.severity === DiagnosticSeverity.Warning);

/** Source lines joined; indentation is preserved as written. */
export const src = (...lines: string[]) => lines.join('\n');

/** True if any diagnostic message matches the pattern. */
export function has(ds: Diagnostic[], pattern: RegExp | string): boolean {
  return ds.some(d => (typeof pattern === 'string' ? d.message.includes(pattern) : pattern.test(d.message)));
}

// ── Temporary SD-card tree ────────────────────────────────────────────────────

export interface SdTree {
  root: string;
  /** Absolute path of a file inside the tree. */
  at(rel: string): string;
  cleanup(): void;
}

/**
 * Build a throw-away SD card.  Keys ending in `/` create directories, other
 * keys create files with the given content.  `sys/config.g` is always present
 * so the directory is recognised as an SD root.
 */
export function makeSd(files: Record<string, string> = {}): SdTree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rrf-sd-'));
  const all: Record<string, string> = { 'sys/config.g': '', ...files };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(root, rel);
    if (rel.endsWith('/')) {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  invalidateSdRootCache();
  return {
    root,
    at: rel => path.join(root, rel),
    cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); invalidateSdRootCache(); },
  };
}
