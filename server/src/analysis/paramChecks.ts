// analysis/paramChecks.ts
// Parameter letters of G/M/T commands against what the firmware reads (server/data/gcode-params-*.json):
//  * a letter the command never reads or looks at — the firmware ignores it (warning);
//  * a letter every run of the command needs (GCodeBuffer::MustSee, GetLimited…Value) is missing,
//    or a present letter needs another — the firmware stops with "missing parameter 'S'" (error);
//  * a number written after a letter that the firmware cannot read (`M106 P-1`: error) or reads only
//    in part (`G4 P1.5` is P1, `M260 A0x7F` is A0: warning), as StringParser::ReadIValue,
//    ReadUIValue, ReadFloatValue and ReadDriverIdValue read a value that does not start with '{'.
//
// Only what the tables can vouch for is reported: commands the firmware reads with a macro
// (M98 P…, a plain G29, G32, a command it does not have), commands that take the rest of the line
// as text, and commands the generator could not follow everywhere ("open") are left alone. With no
// target line, a letter is unknown only when no line reads it, and required only when every line
// requires it.

import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';
import { Version } from './typecheck/versions';
import { AXIS_LETTERS, CommandInfo, commandInfo, commandKey, commandSegments, paramKinds, paramLines, segmentWords } from './gcodeParams';

export const PARAM_UNKNOWN_CODE = 'rrf-param-unknown';
export const PARAM_MISSING_CODE = 'rrf-param-missing';
export const PARAM_VALUE_CODE = 'rrf-param-value';

const range = (line: number, start: number, end: number) => Range.create(line, start, line, end);

interface Letter { letter: string; start: number; end: number }

/** The parameter letters of a command segment, or null when its letters cannot be told apart. */
function segmentLetters(t: Token[], start: number, end: number, command: string, lines: Version[], sbc: boolean): Letter[] | null {
    const { words, stopped } = segmentWords(t, start, end, command, lines, sbc);
    if (stopped) return null;
    return words.map(i => {
        let j = i + 1;
        while (j < end && t[j].type !== TokenType.GCodeWord) j++;
        return { letter: t[i].value.toUpperCase(), start: t[i].start, end: t[j - 1].end };
    });
}

/** Diagnostics for the parameter letters of one G/M/T line. */
export function paramDiagnostics(tokens: Token[], line: number, version: Version | null, sbc: boolean): Diagnostic[] {
    const head = tokens[0];
    if (!head || (head.type !== TokenType.GCode && head.type !== TokenType.TCode)) return [];
    const lines = version ? [version] : paramLines();
    const out: Diagnostic[] = [];
    for (const [start, end] of commandSegments(tokens)) {
        const word = tokens[start];
        const command = commandKey(word.value);
        if (!command) continue;
        const infos = lines.map(l => commandInfo(command, l, sbc));
        // A line without the command runs a macro for it, or does not support the fraction.
        if (!infos.length || infos.some(i => !i)) continue;
        const info = infos as CommandInfo[];
        const letters = segmentLetters(tokens, start, end, command, lines, sbc);
        if (!letters) continue;
        const present = new Set(letters.map(l => l.letter));
        const where = version ? `RRF ${version}` : 'RRF 3.5, 3.6 or 3.7';

        if (!info.some(i => i.open)) {
            for (const l of letters) {
                const read = info.some(i => i.letters.has(l.letter) || (AXIS_LETTERS.has(l.letter) && i.letters.has('axes')));
                if (read) continue;
                out.push({
                    severity: DiagnosticSeverity.Warning, range: range(line, l.start, l.end), source: 'rrf-gcode', code: PARAM_UNKNOWN_CODE,
                    message: `${command} does not read parameter ${l.letter} in ${where}, so the firmware ignores it`,
                });
            }
        }

        // Numbers written without {…}. With a single-board computer DuetSoftwareFramework parses them
        // (BinaryParser), which this does not model.
        if (!sbc && !info.some(i => i.open)) {
            for (const w of segmentWords(tokens, start, end, command, lines, sbc).words) {
                const v = numberAfter(tokens, w, end);
                const d = v && numberDiagnostic(command, tokens[w].value.toUpperCase(), v, line, lines);
                if (d) out.push(d);
            }
        }

        const missing = (alts: string) => !alts.split('|').some(a => present.has(a));
        const firmware = (alts: string) => `the firmware stops with "missing parameter '${alts.split('|')[0]}'"`;
        const needs = (alts: string) => alts.split('|').join(' or ');
        for (const alts of info[0].required) {
            if (!info.every(i => i.required.includes(alts)) || !missing(alts)) continue;
            out.push({
                severity: DiagnosticSeverity.Error, range: range(line, word.start, word.end), source: 'rrf-gcode', code: PARAM_MISSING_CODE,
                message: `${command} needs parameter ${needs(alts)}: ${firmware(alts)}`,
            });
        }
        for (const l of letters) {
            for (const alts of info[0].requires[l.letter] ?? []) {
                if (!info.every(i => (i.requires[l.letter] ?? []).includes(alts)) || !missing(alts)) continue;
                out.push({
                    severity: DiagnosticSeverity.Error, range: range(line, l.start, l.end), source: 'rrf-gcode', code: PARAM_MISSING_CODE,
                    message: `with parameter ${l.letter}, ${command} also needs ${needs(alts)}: ${firmware(alts)}`,
                });
            }
        }
    }
    return out;
}

// ── Numbers written without {…} ──────────────────────────────────────────────
//
// RRFLibraries NumericConverter::Accumulate, as the readers call it (the same in 3.5–3.7):
// StrToI32 takes a sign; StrToU32 takes '+' but stops at '-'; SafeStrtof takes a sign, one '.'
// and an exponent. None takes 0x or 0b: only an expression in {…} reads hex and binary.

/** Where the number the reader of `kind` takes from s[i] ends, or -1 when it finds none. */
function scanNumber(s: string, i: number, kind: 'int' | 'uint' | 'float'): number {
    const float = kind === 'float';
    const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
    let k = i;
    if (s[k] === '+') k++;
    else if (s[k] === '-') {
        if (kind === 'uint') return -1;
        k++;
    }
    let digit = false;
    let point = false;
    for (; k < s.length; k++) {
        if (isDigit(s[k])) digit = true;
        else if (s[k] === '.' && float && !point) point = true;
        else break;
    }
    if (!digit) return -1;
    if (float && (s[k] === 'e' || s[k] === 'E')) {
        let e = k + 1;
        if (s[e] === '+' || s[e] === '-') e++;
        if (!isDigit(s[e])) return -1;                  // an E not followed by digits fails the whole number
        while (isDigit(s[e])) e++;
        k = e;
    }
    return k;
}

/** ReadDriverIdValue: a driver number, or a board address, '.' and a driver number. */
function scanDriver(s: string, i: number): number {
    const k = scanNumber(s, i, 'uint');
    return k >= 0 && s[k] === '.' ? scanNumber(s, k + 1, 'uint') : k;
}

/** How the reader of `kind` takes `s`: all of it, `read` characters of it, or nothing (failing at `at`). */
type Outcome = { k: 'ok' } | { k: 'none'; at: number } | { k: 'partial'; read: number };

function readAs(kind: string, s: string): Outcome {
    const list = kind.endsWith('[]');
    const base = list ? kind.slice(0, -2) : kind;
    const scan = base === 'int' || base === 'uint' || base === 'float' ? (j: number) => scanNumber(s, j, base)
        : base === 'driver' ? (j: number) => scanDriver(s, j) : null;
    if (!scan) return { k: 'ok' };                      // not read as a number: other checks' business
    // A list reader reads elements while a ':' follows (GetUnsignedArray and friends).
    for (let j = 0; ;) {
        const e = scan(j);
        if (e < 0) return { k: 'none', at: j };
        if (!list || s[e] !== ':') return e === s.length ? { k: 'ok' } : { k: 'partial', read: e };
        j = e + 1;
    }
}

const NUMBER_TOKENS = new Set([TokenType.Integer, TokenType.Float, TokenType.HexInteger, TokenType.BinInteger,
    TokenType.Minus, TokenType.Plus, TokenType.Dot, TokenType.Colon]);

/** The number written right after the letter at t[w], with its range, or null when the value is not one. */
function numberAfter(t: Token[], w: number, end: number): { text: string; start: number; end: number } | null {
    let k = w + 1;
    if (k >= end || t[k].start !== t[w].end || !NUMBER_TOKENS.has(t[k].type) || t[k].type === TokenType.Colon) return null;
    let text = '';
    for (; k < end && NUMBER_TOKENS.has(t[k].type) && t[k].start === t[k - 1].end; k++) text += t[k].value;
    // `E-{…}` is the syntax checks' (a sign before an expression); an element after ':' that is a string
    // or an expression (`E400:"x"`, `E400:{…}`) is the type checks'.
    const touching = k < end && t[k].start === t[k - 1].end;
    if (touching && (t[k].type === TokenType.LBrace || text.endsWith(':'))) return null;
    return { text, start: t[w + 1].start, end: t[k - 1].end };
}

/** A diagnostic for a number the firmware cannot read, or reads only in part, for every line in `lines`. */
function numberDiagnostic(command: string, letter: string, v: { text: string; start: number; end: number }, line: number,
    lines: Version[]): Diagnostic | null {
    const outcomes: Outcome[] = [];
    const bases = new Set<string>();
    for (const l of lines) {
        const kinds = paramKinds(command, letter, l);
        if (!kinds) return null;
        for (const k of kinds) {
            outcomes.push(readAs(k, v.text));
            bases.add(k.replace(/\[\]$/, ''));
        }
    }
    if (outcomes.some(o => o.k === 'ok')) return null;
    const s = v.text;
    const head = `parameter ${letter} of ${command}`;
    const whole = [...bases].every(b => b === 'int' || b === 'uint' || b === 'driver');
    const none = outcomes.find((o): o is { k: 'none'; at: number } => o.k === 'none');
    const partial = outcomes.find((o): o is { k: 'partial'; read: number } => o.k === 'partial');
    if (!partial && none) {
        const after = none.at === 0 ? letter : s[none.at - 1];
        const stops = `the firmware stops with "expected number after '${after}'"`;
        const what = s[none.at] === '-' && [...bases].every(b => b === 'uint' || b === 'driver') ? 'cannot be negative'
            : s[none.at] === '.' && whole ? 'is a whole number'
                : 'needs a number';
        return {
            severity: DiagnosticSeverity.Error, range: range(line, v.start, v.end), source: 'rrf-gcode', code: PARAM_VALUE_CODE,
            message: `${head} ${what}, got ${s.endsWith(':') ? `'${s}'` : s}: ${stops}`,
        };
    }
    if (!partial) return null;
    const read = s.slice(0, partial.read);
    const rest = s.slice(partial.read);
    const message = /^[xXbB]/.test(rest) && read.endsWith('0')
        ? `${head} is read as a decimal number: the firmware reads ${letter}${s} as ${letter}${read} — only an expression reads hex or binary, write ${letter}{${s}}`
        : /^[.eE]/.test(rest) && whole
            ? `${head} is a whole number: the firmware reads ${letter}${s} as ${letter}${read} and ignores ${rest}`
            : `the firmware reads ${letter}${s} as ${letter}${read} and ignores ${rest}`;
    return { severity: DiagnosticSeverity.Warning, range: range(line, v.start, v.end), source: 'rrf-gcode', code: PARAM_VALUE_CODE, message };
}
