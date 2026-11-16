// analysis/gcodeParams.ts
// How the firmware reads each parameter letter of each G/M/T command, one file per firmware line
// (server/data/gcode-params-3.5.json, -3.6.json, -3.7.json), generated from the RepRapFirmware
// sources by scripts/gcode-params-gen.py.
//
// Each command maps letters to the kinds they are read as: float, int, uint, bool, string, ip,
// mac, driver, any, and lists of those (`float[]`). Two letters are special: `axes` stands for
// every axis letter, `?` for a read whose letter the generator could not tell (it may be any
// letter of the command). A fractional command (M569.1) has an entry of its own; one without
// an entry is not read by the firmware itself (a macro file, or an unsupported fraction).
// `sbc` lists the commands DuetSoftwareFramework reads itself on a single-board computer.

import * as fs from 'fs';
import * as path from 'path';
import { Version } from './typecheck/versions';
import { Token, TokenType } from '../parser/types';

interface LineData {
    commands: Map<string, Record<string, string>>;
    sbc: Set<string>;
    /** Commands whose letters the generator cannot all account for. */
    open: Set<string>;
    /** Letters every run needs ("P|S": either), and letters a present letter needs. */
    required: Map<string, string[]>;
    requires: Map<string, Record<string, string[]>>;
}

const LINES: readonly Version[] = ['3.5', '3.6', '3.7'];
let data: Map<Version, LineData> | null = null;

/** Letters that can name an axis (GCodes::AllowedAxisLetters, upper case). */
export const AXIS_LETTERS: ReadonlySet<string> = new Set('XYZUVWABCD');

/** server/data, found from this file whether it runs from out/ or out-test/. */
function dataDir(): string | null {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = path.join(dir, 'data');
        if (fs.existsSync(path.join(candidate, 'gcode-params-3.6.json'))) return candidate;
        dir = path.dirname(dir);
    }
    return null;
}

function load(): Map<Version, LineData> {
    if (data) return data;
    data = new Map();
    const dir = dataDir();
    if (!dir) return data;
    for (const line of LINES) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, `gcode-params-${line}.json`), 'utf8')) as {
                commands?: Record<string, Record<string, string>>; sbc?: string[]; open?: Record<string, string[]>;
                required?: Record<string, string[]>; requires?: Record<string, Record<string, string[]>>;
            };
            data.set(line, {
                commands: new Map(Object.entries(raw.commands ?? {})), sbc: new Set(raw.sbc ?? []),
                open: new Set(Object.keys(raw.open ?? {})), required: new Map(Object.entries(raw.required ?? {})),
                requires: new Map(Object.entries(raw.requires ?? {})),
            });
        } catch {
            // A missing or broken file leaves that line out.
        }
    }
    return data;
}

/** The firmware lines there is data for. */
export function paramLines(): Version[] {
    return LINES.filter(l => load().has(l));
}

/**
 * The table key of a command word: `G01` → `G1`, `m569.1` → `M569.1`, `T0` / `T` → `T`;
 * null for anything else.
 */
export function commandKey(word: string): string | null {
    const m = /^([GMT])(-?\d*)(?:\.(\d+))?$/i.exec(word);
    if (!m) return null;
    const letter = m[1].toUpperCase();
    if (letter === 'T') return 'T';
    if (!m[2] || m[2].startsWith('-')) return null;
    return `${letter}${parseInt(m[2], 10)}${m[3] !== undefined ? `.${parseInt(m[3], 10)}` : ''}`;
}

/**
 * The kinds `letter` of `command` is read as on `line`, or undefined when the firmware does not
 * read it there (no such command or letter, or a command DuetSoftwareFramework reads itself when
 * `sbc` is on). An axis letter also gets the kinds of `axes`; a letter that is read also gets the
 * kinds of `?`.
 */
export function paramKinds(command: string, letter: string, line: Version, sbc = false): string[] | undefined {
    const d = load().get(line);
    if (!d) return undefined;
    if (sbc && d.sbc.has(command.split('.')[0])) return undefined;
    const e = d.commands.get(command);
    if (!e) return undefined;
    const kinds = new Set<string>();
    const add = (k: string | undefined) => k?.split('|').forEach(x => kinds.add(x));
    add(e[letter]);
    if (AXIS_LETTERS.has(letter)) add(e.axes);
    if (kinds.size === 0) return undefined;
    add(e['?']);
    return [...kinds].sort();
}

/**
 * Whether some firmware line implements `command` itself. A G or M command none does runs the
 * macro file of its name (GCodes::TryMacroFile): `M1234` runs sys/M1234.g. A fraction of a
 * command the firmware has counts as the command's.
 */
export function isBuiltIn(command: string): boolean {
    const base = command.split('.')[0];
    for (const d of load().values()) if (d.commands.has(command) || d.commands.has(base)) return true;
    return false;
}

/** What a line's table says about a command, or undefined when the line does not have it. */
export interface CommandInfo {
    /** Every letter the command reads or looks at, `axes` and `?` included. */
    letters: ReadonlySet<string>;
    /** The generator could not account for every letter: no letter is unknown. */
    open: boolean;
    required: readonly string[];
    requires: Readonly<Record<string, string[]>>;
}

export function commandInfo(command: string, line: Version, sbc = false): CommandInfo | undefined {
    const d = load().get(line);
    const e = d?.commands.get(command);
    if (!d || !e || (sbc && d.sbc.has(command.split('.')[0]))) return undefined;
    return {
        letters: new Set(Object.keys(e)), open: d.open.has(command),
        required: d.required.get(command) ?? [], requires: d.requires.get(command) ?? {},
    };
}

/**
 * The commands of a line as token ranges [start, end): a G or M word outside quotes and braces
 * starts the next command, a T further on is a parameter (StringParser::FindParameters).
 */
export function commandSegments(t: Token[]): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let depth = 0;
    let start = 0;
    let i = 0;
    for (; i < t.length; i++) {
        const tt = t[i].type;
        if (tt === TokenType.EOF || tt === TokenType.Comment) break;
        if (tt === TokenType.LBrace) depth++;
        else if (tt === TokenType.RBrace && depth > 0) depth--;
        else if (tt === TokenType.GCode && depth === 0 && i > start) { out.push([start, i]); start = i; }
    }
    out.push([start, i]);
    return out;
}

