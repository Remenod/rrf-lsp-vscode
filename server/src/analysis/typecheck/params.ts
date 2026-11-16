// analysis/typecheck/params.ts
// Braced values of G/M/T command parameters against how the firmware reads them (SPEC TC-GC-02..05).
//
// The getter of a letter (StringParser::ReadFloatValue, ReadIValue, ReadUIValue, ReadDriverIdValue,
// GetFloatArray …, the same in BinaryParser) evaluates `{…}` and converts the value with
// ExpressionParser::ConvertToFloat, ConvertToInteger, ConvertToUnsigned or ConvertToDriverId, or
// turns it into text (AppendAsString). Those conversions are the same in RepRapFirmware 3.5.4,
// 3.6.4 and 3.7.0. Only definite errors are reported: every possible type of the value fails every
// kind the letter is read as, on every firmware line in question.

import { Ty, Kind, atoms, isUnknown, isBottom, describe } from './types';
import { Version } from './versions';
import { paramKinds, paramLines } from '../gcodeParams';

interface Rule {
    /** Value kinds the conversion accepts; null: every value (it becomes text). */
    accepts: readonly Kind[] | null;
    /** What a single value must be, and what a list parameter's value may be. */
    need: string;
    needList: string;
    /** The firmware's error text; `list`: the value is read as a list. */
    firmware(line: Version, list: boolean): string;
}

const NUMBERS: readonly Kind[] = ['int', 'uint', 'float'];
const INTEGERS: readonly Kind[] = ['int', 'uint'];
const ANY: Rule = { accepts: null, need: '', needList: '', firmware: () => '' };

const RULES: Record<string, Rule> = {
    // ConvertToFloat: Float, Uint32, Uint64, Int32.
    float: {
        accepts: NUMBERS, need: 'a number', needList: 'a number or a list of numbers',
        firmware: () => 'expected numeric operand',
    },
    // ConvertToInteger: Int32, or a Uint32 that fits.
    int: {
        accepts: INTEGERS, need: 'an integer', needList: 'an integer or a list of integers',
        firmware: () => 'expected integer value',
    },
    // GCodeBuffer::TryGetBValue is GetIValue() > 0.
    bool: {
        accepts: INTEGERS, need: 'an integer (0 or 1)', needList: 'an integer (0 or 1)',
        firmware: () => 'expected integer value',
    },
    // ConvertToUnsigned: Uint32, or an Int32 that is not negative.
    uint: {
        accepts: INTEGERS, need: 'a non-negative integer', needList: 'a non-negative integer or a list of them',
        firmware: () => 'expected non-negative integer',
    },
    // 3.5 reads a single driver ID with ParseFloat, later lines and every list with ConvertToDriverId
    // (Int32, Float or a driver ID). A Uint32 is accepted here: whether an object-model value is
    // one at run time is not certain enough to report.
    driver: {
        accepts: NUMBERS, need: 'a driver number (such as 2 or 1.3)', needList: 'a driver number or a list of them',
        firmware: (line, list) => (line === '3.5' && !list ? 'expected numeric operand' : 'expected driver ID'),
    },
    string: ANY,
    any: ANY,
    // Addresses are read as text, and not from an expression before 3.7 or with a single-board
    // computer; that is not checked.
    ip: ANY,
    mac: ANY,
};

/** Whether some possible value of type `t` converts. `asList`: a list parameter's whole value. */
function fits(t: Ty, accepts: readonly Kind[], asList: boolean): boolean {
    return atoms(t).some(a => {
        if (typeof a === 'string') return accepts.includes(a);
        // ParseArray converts each element of an array value; an empty or unknown array is not a type error.
        if (!asList) return false;
        return isUnknown(a.elem) || isBottom(a.elem) || atoms(a.elem).some(e => typeof e === 'string' && accepts.includes(e));
    });
}

/**
 * Why no kind of a letter accepts `t` on one line, or null when one does. `element`: the value is
 * an element after `:` (`X1:{…}`), which only a list getter reads.
 */
function failure(kinds: string[], element: boolean, t: Ty, line: Version): string | null {
    // base kind -> read as a list (a letter read both ways, `driver|driver[]`, is described as a list)
    const bases = new Map<string, boolean>();
    let firmware: string | null = null;
    for (const k of kinds) {
        const list = k.endsWith('[]');
        const base = list ? k.slice(0, -2) : k;
        const rule = RULES[base];
        if (!rule || !rule.accepts) return null;
        if (element && !list) return null;
        const asList = list && !element;
        if (fits(t, rule.accepts, asList)) return null;
        bases.set(base, (bases.get(base) ?? false) || asList);
        // When the kinds fail with different texts, the first is quoted (TC-DIAG-03).
        firmware ??= rule.firmware(line, list);
    }
    if (firmware === null) return null;
    const needs = [...bases].map(([base, asList]) => (asList ? RULES[base].needList : RULES[base].need));
    return `needs ${[...new Set(needs)].join(' or ')}, got ${describe(t)}: the firmware stops with "${firmware}"`;
}

/**
 * The message for a braced value of `letter` on a `command` line that the firmware rejects, or null.
 * With no target line the value must be rejected on every line, and every line must read the letter.
 */
export function checkParamValue(command: string, letter: string, element: boolean, t: Ty, version: Version | null, sbc: boolean): string | null {
    if (isUnknown(t) || isBottom(t)) return null;
    const lines = version ? [version] : paramLines();
    let message: string | null = null;
    for (const line of lines) {
        const kinds = paramKinds(command, letter, line, sbc);
        if (!kinds) return null;
        message = failure(kinds, element, t, line);
        if (!message) return null;
    }
    return message && `parameter ${letter} of ${command} ${message}`;
}
