// analysis/diagnostics.ts
// Pure diagnostics pipeline: text in, LSP Diagnostics out.  No connection, no
// global state — everything configurable arrives through DiagnosticsOptions.

import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { Lexer } from '../parser/lexer';
import { validateLine, DiagnosticContext } from '../parser/expression';
import { SymbolTable } from './symbolTable';
import { isValidOmPath, isOmIndexAvailable } from './objectModelIndex';
import { validateGCodeArgs, validateFunctionPathArgs, getSdRootForUri } from './argValidators';
import { ArgCheckConfig } from './argCheckConfig';
import { LINE_TOO_LONG_CODE } from './codeActions';
import { lineIndent } from './utils';

export interface DiagnosticsOptions {
  symbolTable: SymbolTable;
  argCheckConfig: ArgCheckConfig;
  /** 0 disables the line-length check. */
  maxLineLength: number;
}

function mkRange(sl: number, sc: number, el: number, ec: number): Range {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

interface CommandPart { text: string; start: number; end: number }

/**
 * Extract the part of a line that actually lands in the firmware's G-code
 * buffer: strips leading whitespace, an `N<digits>` line number, a trailing
 * `*<digits>` checksum and everything from an unquoted `;` on.  Returns null
 * for blank and comment-only lines.
 */
export function commandPartOfLine(lineText: string): CommandPart | null {
  // Comment start: the first ';' outside a "…" string.  A doubled "" escape
  // toggles the string state twice, so the tracking stays correct.
  let inString = false;
  let end = lineText.length;
  for (let i = 0; i < lineText.length; i++) {
    const c = lineText[i];
    if (c === '"') inString = !inString;
    else if (c === ';' && !inString) { end = i; break; }
  }

  let start = 0;
  while (start < end && (lineText[start] === ' ' || lineText[start] === '\t')) start++;

  const lineNumber = /^[Nn]\d+[ \t]*/.exec(lineText.slice(start, end));
  if (lineNumber) start += lineNumber[0].length;

  while (end > start && (lineText[end - 1] === ' ' || lineText[end - 1] === '\t')) end--;
  const checksum = /\*\d+$/.exec(lineText.slice(start, end));
  if (checksum) {
    end -= checksum[0].length;
    while (end > start && (lineText[end - 1] === ' ' || lineText[end - 1] === '\t')) end--;
  }

  if (end <= start) return null;
  return { text: lineText.slice(start, end), start, end };
}

/**
 * Compute diagnostics for any URI + text pair.
 *
 * Factored out of publishDiagnostics so it can be called for background
 * (non-open) files discovered during the workspace scan.
 */
export function computeDiagnostics(uri: string, text: string, opts: DiagnosticsOptions): Diagnostic[] {
  const { symbolTable, argCheckConfig, maxLineLength } = opts;
  const lines = text.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];

  const omChecker = isOmIndexAvailable() ? isValidOmPath : undefined;

  // Resolve the SD root once per document.  validateGCodeArgs reuses this
  // for every G/M/T line so we don't repeatedly walk the filesystem.
  const sdRoot = getSdRootForUri(uri);

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];

    // Line-length check runs before tokenization so it is reported even for
    // lines that also contain lexer errors.  Only the command part is measured
    // (in UTF-8 bytes, matching the firmware buffer) — comments, indentation,
    // N line numbers and *checksums are excluded because the firmware never
    // stores them.
    if (maxLineLength > 0) {
      const part = commandPartOfLine(lineText);
      const bytes = part ? Buffer.byteLength(part.text, 'utf8') : 0;
      if (part && bytes > maxLineLength) {
        // Column where the byte budget runs out (the range is expressed in
        // UTF-16 columns even though the limit is measured in UTF-8 bytes).
        let overflowCol = part.start;
        let used = 0;
        for (const ch of part.text) {
          used += Buffer.byteLength(ch, 'utf8');
          if (used > maxLineLength) break;
          overflowCol += ch.length;
        }
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: mkRange(i, overflowCol, i, part.end),
          message:
            `Command is ${bytes} bytes long, exceeding rrfgcode.maxLineLength (${maxLineLength}). ` +
            `RepRapFirmware rejects commands longer than its input buffer with "GCode command too long".`,
          source: 'rrf-gcode',
          code: LINE_TOO_LONG_CODE,
          data: { length: bytes, max: maxLineLength },
        });
      }
    }

    const indent = lineIndent(lineText);
    const lexer = new Lexer(lineText, i);
    const tokens = lexer.tokenize();

    for (const e of lexer.errors) {
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: mkRange(e.line, e.start, e.line, e.end),
        message: e.message,
        source: 'rrf-gcode',
      });
    }

    if (lexer.errors.length > 0) continue;

    const ctx: DiagnosticContext = {
      symbolTable, uri, line: i, indent,
      isValidOmPath: omChecker,
      docLines: lines,
    };

    for (const err of validateLine(tokens, lineText, ctx)) {
      const sev = err.severity === 'warning' ? DiagnosticSeverity.Warning
        : err.severity === 'information' ? DiagnosticSeverity.Information
          : DiagnosticSeverity.Error;
      diagnostics.push({
        severity: sev,
        range: mkRange(err.line, err.start, err.line, err.end),
        message: err.message,
        source: 'rrf-gcode',
      });
    }

    diagnostics.push(...validateGCodeArgs(
      tokens,
      lineText,
      uri,
      sdRoot,
      argCheckConfig,
    ));

    // Path-taking functions (fileexists/fileread) can appear on any line, not
    // just G/M/T command lines, so they are validated separately.
    diagnostics.push(...validateFunctionPathArgs(tokens, sdRoot, argCheckConfig));
  }

  return diagnostics;
}
