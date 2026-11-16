// analysis/paramChecks.ts
// Parameter letters of G/M/T commands against what the firmware reads (server/data/gcode-params-*.json):
//  * a letter the command never reads or looks at — the firmware ignores it (warning);
//  * a letter every run of the command needs (GCodeBuffer::MustSee, GetLimited…Value) is missing,
//    or a present letter needs another — the firmware stops with "missing parameter 'S'" (error).
//
// Only what the tables can vouch for is reported: commands the firmware reads with a macro
// (M98 P…, a plain G29, G32, a command it does not have), commands that take the rest of the line
// as text, and commands the generator could not follow everywhere ("open") are left alone. With no
// target line, a letter is unknown only when no line reads it, and required only when every line
// requires it.

import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { Token, TokenType } from '../parser/types';
import { Version } from './typecheck/versions';
import { AXIS_LETTERS, CommandInfo, commandInfo, commandKey, commandSegments, paramLines, segmentWords } from './gcodeParams';

export const PARAM_UNKNOWN_CODE = 'rrf-param-unknown';
export const PARAM_MISSING_CODE = 'rrf-param-missing';

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
