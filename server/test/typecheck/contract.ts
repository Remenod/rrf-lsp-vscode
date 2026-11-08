// The test-side contract of the type checker (see SPEC.md "The interface the tests assume").
//
//  * typeDiags()      — diagnostics that exist with the checker ON and not with it OFF.
//  * expectTypes()    — exact assertion on those diagnostics (code, range, severity, message).
//  * typeAt()         — the inferred type at a position, read from hover.
//  * rule() / guard() — gated spec tests / always-live regression guards.

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { lint, lex, readData, LintOptions } from '../helpers/harness';
import { buildHover } from '../../src/analysis/hover';
import { SymbolTable } from '../../src/analysis/symbolTable';
import { IMPLEMENTED } from './implemented';

// ── Diagnostic codes (TC-DIAG-01) ─────────────────────────────────────────────

export const CODE = {
  operand: 'rrf-type-operand',
  boolean: 'rrf-type-boolean',
  argument: 'rrf-type-argument',
  index: 'rrf-type-index',
  value: 'rrf-type-value',
  version: 'rrf-version',
  skipped: 'rrf-skipped-operand',
} as const;
export type Code = typeof CODE[keyof typeof CODE];
export const ALL_CODES: ReadonlySet<string> = new Set(Object.values(CODE));

// ── Gating ────────────────────────────────────────────────────────────────────

export const STRICT = process.env.RRF_TC_STRICT === '1';

export function isImplemented(id: string): boolean {
  for (const p of IMPLEMENTED) {
    if (p === id) return true;
    if (p.endsWith('*') && id.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/** A spec test: `todo` until the rule is listed in implemented.ts (or RRF_TC_STRICT=1). */
export function rule(id: string, title: string, fn: () => void): void {
  const live = STRICT || isImplemented(id);
  it(`${id} ${title}`, live ? {} : { todo: `${id} not implemented` }, fn);
}

/** Always live: true today, must stay true once the checker exists. */
export function guard(id: string, title: string, fn: () => void): void {
  it(`${id} [guard] ${title}`, fn);
}

// ── Linting with the checker on/off ───────────────────────────────────────────

export interface TcOptions {
  rrfVersion?: string;
  extraDocs?: Record<string, string>;
  file?: string;
  maxLineLength?: number;
}

export function lintTc(text: string, opts: TcOptions = {}, enabled: boolean | 'omit' = true): Diagnostic[] {
  const o: LintOptions = { ...opts, typeCheck: enabled };
  return lint(text, o);
}

const key = (d: Diagnostic) =>
  [d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character,
    d.severity, d.code ?? '', d.message].join('\u0001');

/** Multiset difference a \ b by full diagnostic identity. */
export function diffDiagnostics(a: Diagnostic[], b: Diagnostic[]): Diagnostic[] {
  const counts = new Map<string, number>();
  for (const d of b) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
  const out: Diagnostic[] = [];
  for (const d of a) {
    const k = key(d);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else out.push(d);
  }
  return out;
}

/** Diagnostics produced by the type checker: (checker on) \ (checker off). */
export function typeDiags(text: string, opts: TcOptions = {}): Diagnostic[] {
  return diffDiagnostics(lintTc(text, opts, true), lintTc(text, opts, false));
}

/** Diagnostics the checker REMOVED or CHANGED: must always be empty (TC-CFG-04). */
export function lostDiags(text: string, opts: TcOptions = {}): Diagnostic[] {
  return diffDiagnostics(lintTc(text, opts, false), lintTc(text, opts, true));
}

// ── Locating ranges ───────────────────────────────────────────────────────────

export interface Span { line: number; start: number; end: number }

/**
 * Find `needle` in `text`. With `line` the search is restricted to that (0-based) line;
 * `occurrence` picks the n-th match (0-based) in document order.
 */
export function locate(text: string, needle: string, line?: number, occurrence = 0): Span {
  const lines = text.split(/\r?\n/);
  let seen = 0;
  for (let l = 0; l < lines.length; l++) {
    if (line !== undefined && l !== line) continue;
    let from = 0;
    for (;;) {
      const at = lines[l].indexOf(needle, from);
      if (at < 0) break;
      if (seen === occurrence) return { line: l, start: at, end: at + needle.length };
      seen++;
      from = at + 1;
    }
  }
  throw new Error(`locate: ${JSON.stringify(needle)} (occurrence ${occurrence}${line !== undefined ? `, line ${line}` : ''}) not found`);
}

// ── Exact expectations ────────────────────────────────────────────────────────

export interface Expect {
  code: Code;
  /** Substring that must be exactly the diagnostic range, or an explicit span. */
  at: string | Span;
  line?: number;
  occurrence?: number;
  /** Firmware runtime text; the message must contain it wrapped in double quotes. */
  firmware?: string | RegExp;
  /** Further message requirements, e.g. operand type names. */
  mentions?: Array<string | RegExp>;
  /** Defaults to 'error'. */
  severity?: 'error' | 'warning';
}

const SEV: Record<'error' | 'warning', DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
};

export function describeDiag(d: Diagnostic): string {
  const r = d.range;
  return `[${d.code ?? '-'} sev${d.severity} L${r.start.line}:${r.start.character}-${r.end.character}] ${d.message}`;
}

function messageOk(e: Expect, msg: string): string | null {
  if (e.firmware !== undefined) {
    const ok = typeof e.firmware === 'string'
      ? msg.includes(`"${e.firmware}"`)
      : e.firmware.test(msg);
    if (!ok) return `message lacks firmware text ${typeof e.firmware === 'string' ? `"${e.firmware}"` : e.firmware}`;
  }
  for (const m of e.mentions ?? []) {
    const ok = typeof m === 'string' ? new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(msg) : m.test(msg);
    if (!ok) return `message does not mention ${m}`;
  }
  return null;
}

/** Match `actual` against `expected` exactly (same count, every expectation met once). */
export function matchDiagnostics(text: string, actual: Diagnostic[], expected: Expect[]): string[] {
  const problems: string[] = [];
  const pool = [...actual];
  for (const e of expected) {
    const span = typeof e.at === 'string' ? locate(text, e.at, e.line, e.occurrence) : e.at;
    const idx = pool.findIndex(d =>
      d.code === e.code &&
      d.range.start.line === span.line && d.range.end.line === span.line &&
      d.range.start.character === span.start && d.range.end.character === span.end);
    if (idx < 0) {
      problems.push(`missing ${e.code} at L${span.line}:${span.start}-${span.end} (${JSON.stringify(typeof e.at === 'string' ? e.at : '')})`);
      continue;
    }
    const d = pool.splice(idx, 1)[0];
    if (d.severity !== SEV[e.severity ?? 'error']) problems.push(`${describeDiag(d)}: severity should be ${e.severity ?? 'error'}`);
    if (d.source !== 'rrf-gcode') problems.push(`${describeDiag(d)}: source should be 'rrf-gcode'`);
    const m = messageOk(e, d.message);
    if (m) problems.push(`${describeDiag(d)}: ${m}`);
  }
  for (const d of pool) problems.push(`unexpected ${describeDiag(d)}`);
  return problems;
}

/**
 * TC-DIAG-06 makes an expectation on a line that already carries an error unsatisfiable. Such a
 * test is blocked by another layer (usually the syntax validator), not by the type checker:
 * fail loudly with a recognisable prefix instead of a misleading "missing diagnostic".
 */
export function assertNotBlocked(text: string, lines: Iterable<number>, opts: TcOptions = {}): void {
  const want = new Set(lines);
  const blocking = lintTc(text, opts, false)
    .filter(d => d.severity === DiagnosticSeverity.Error && want.has(d.range.start.line));
  if (blocking.length) {
    throw new Error(`BLOCKED by an existing diagnostic: ${blocking.map(describeDiag).join(' | ')}`);
  }
}

/** Assert the type checker reports exactly `expected` for `text`. */
export function expectTypes(text: string, expected: Expect[], opts: TcOptions = {}): void {
  assertNotBlocked(text, expected.map(e => (typeof e.at === 'string' ? locate(text, e.at, e.line, e.occurrence) : e.at).line), opts);
  const problems = matchDiagnostics(text, typeDiags(text, opts), expected);
  assert.deepEqual(problems, [], `for:\n${text}`);
}

/** Assert the type checker reports nothing for `text`. */
export function expectNoTypes(text: string, opts: TcOptions = {}): void {
  const extra = typeDiags(text, opts);
  assert.deepEqual(extra.map(describeDiag), [], `for:\n${text}`);
}

// ── Types read from hover (TC-TYPE-03) ────────────────────────────────────────

const ORDER = ['int', 'uint', 'float', 'bool', 'string', 'char', 'datetime', 'array', 'object', 'null', 'unknown'];

/**
 * Canonical form of a displayed type: members de-duplicated and sorted, `number` expanded,
 * `array` == `array<unknown>`, any `unknown` member collapses the union to `unknown`.
 */
export function canonType(display: string): string {
  let pos = 0;
  const s = display.trim();
  const ws = () => { while (s[pos] === ' ') pos++; };
  function parseUnion(): string[] {
    const members: string[] = [];
    for (;;) {
      ws();
      members.push(...parseAtom());
      ws();
      if (s[pos] === '|') { pos++; continue; }
      return members;
    }
  }
  function parseAtom(): string[] {
    ws();
    const m = /^[a-z]+/.exec(s.slice(pos));
    if (!m) throw new Error(`canonType: bad type ${JSON.stringify(display)} at ${pos}`);
    pos += m[0].length;
    const name = m[0];
    if (name === 'number') return ['int', 'uint', 'float'];
    if (name === 'array') {
      ws();
      if (s[pos] === '<') {
        pos++;
        const inner = normalise(parseUnion());
        ws();
        if (s[pos] !== '>') throw new Error(`canonType: missing '>' in ${JSON.stringify(display)}`);
        pos++;
        return [`array<${inner}>`];
      }
      return ['array<unknown>'];
    }
    if (!ORDER.includes(name)) throw new Error(`canonType: unknown type name ${JSON.stringify(name)} in ${JSON.stringify(display)}`);
    return [name];
  }
  function normalise(members: string[]): string {
    if (members.includes('unknown')) return 'unknown';
    const uniq = [...new Set(members)];
    const rank = (t: string) => ORDER.indexOf(t.startsWith('array<') ? 'array' : t);
    uniq.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return uniq.join(' | ');
  }
  const out = normalise(parseUnion());
  ws();
  if (pos !== s.length) throw new Error(`canonType: trailing text in ${JSON.stringify(display)}`);
  return out;
}

const DATA = {
  gcode: readData('gcode-commands.json'),
  meta: readData('gcode-meta-commands.json'),
  ops: readData('gcode-operators.json'),
  fns: readData('gcode-functions.json'),
};

const TYPE_RE = /Type: `([^`]*)`/;
export const URI = 'untitled:test.g';

/**
 * Raw hover markdown at the `occurrence`-th `needle` on `line` (cursor one char inside it).
 * Hover is version-neutral (newest table, SPEC TC-TYPE-03): passing `rrfVersion` is a test bug.
 */
export function hoverText(text: string, line: number, needle: string, occurrence = 0, opts: TcOptions = {}): string | null {
  if (opts.rrfVersion !== undefined) throw new Error('hoverText: hover is version-neutral; do not pass rrfVersion');
  const st = new SymbolTable();
  for (const [u, t] of Object.entries(opts.extraDocs ?? {})) st.indexDocument(u, t);
  st.indexDocument(URI, text);
  const lines = text.split(/\r?\n/);
  const span = locate(text, needle, line, occurrence);
  const l = lines[line];
  const indent = l.length - l.trimStart().length;
  const h = buildHover(lex(l, line), span.start + 1, line, DATA.gcode, DATA.meta, DATA.ops, DATA.fns, st, URI, indent, lines);
  if (!h) return null;
  const c: any = h.contents;
  return typeof c === 'string' ? c : c.value ?? null;
}

/** Canonical inferred type at a position, or null when hover shows no `Type:` field. */
export function typeAt(text: string, line: number, needle: string, occurrence = 0, opts: TcOptions = {}): string | null {
  const h = hoverText(text, line, needle, occurrence, opts);
  const m = h ? TYPE_RE.exec(h) : null;
  return m ? canonType(m[1]) : null;
}

/** Type of an expression: `var t__ = <expr>` then hover `var.t__` on the next line. */
export function typeOfExpr(expr: string, opts: TcOptions & { prelude?: string[] } = {}): string | null {
  const pre = opts.prelude ?? [];
  const text = [...pre, `var t__ = ${expr}`, 'echo var.t__'].join('\n');
  assertNotBlocked(text, [pre.length], opts);
  return typeAt(text, pre.length + 1, 'var.t__', 0, opts);
}

/** Assert hover type equality in canonical form. */
export function expectType(actual: string | null, expected: string, context: string): void {
  assert.equal(actual, canonType(expected), context);
}
