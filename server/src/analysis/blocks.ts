// analysis/blocks.ts
// Block structure, which RepRapFirmware takes from indentation (StringParser):
//  * spaces and tabs mixed in the indentation of one block — a space counts 1 and
//    a tab moves to the next multiple of 4, so the blocks may not be what they look
//    like; the firmware warns "both space and tab characters used to indent blocks";
//  * if / elif / else / while with nothing indented under it — the following
//    lines are not part of it.

import { ParseError } from '../parser/expression';
import { lineIndent } from './utils';

const META = /^(if|elif|else|while|var|global|set|echo|abort|break|continue|skip)\b/;
const BLOCK = /^(if|elif|else|while)\b/;

interface Line { index: number; lead: string; depth: number; rest: string; comment: boolean }

function split(text: string, index: number): Line | null {
  const lead = /^[ \t]*/.exec(text)![0];
  const rest = text.slice(lead.length).replace(/\r$/, '');
  if (rest.trim() === '') return null;
  return { index, lead, depth: lineIndent(lead), rest, comment: rest.startsWith(';') };
}

/** Warnings for one document, in line order. */
export function blockDiagnostics(lines: string[]): ParseError[] {
  const out: ParseError[] = [];
  const all = lines.map(split);

  // Mixed indentation, as StringParser::CheckForMixedSpacesAndTabs sees it: per file, once, after
  // a meta command has been seen; the record of seen spaces/tabs restarts at every unindented
  // command. Comment and blank lines are left out (the firmware may count their indentation too;
  // leaving them out can only miss a warning, never invent one).
  let seenMeta = false, space = false, tab = false;
  for (const l of all) {
    if (!l || l.comment) continue;
    if (META.test(l.rest)) seenMeta = true;
    if (l.lead.length === 0) { space = tab = false; continue; }
    space ||= l.lead.includes(' ');
    tab ||= l.lead.includes('\t');
    if (seenMeta && space && tab) {
      out.push({
        line: l.index, start: 0, end: l.lead.length, severity: 'warning',
        message: `both space and tab characters used to indent blocks: the firmware counts a space as 1 and ` +
          `a tab as a move to the next multiple of 4, so blocks may not be what they look like (it warns ` +
          `"both space and tab characters used to indent blocks at/before line ${l.index + 1}")`,
      });
      break;
    }
  }

  // A block keyword whose next non-blank line is not indented deeper. The firmware skips comment
  // lines (StringParser::CheckMetaCommand), so a comment no deeper than the keyword is passed over;
  // a deeper one counts as the body (an intended no-op).
  for (let k = 0; k < all.length; k++) {
    const l = all[k];
    if (!l || l.comment) continue;
    const kw = BLOCK.exec(l.rest)?.[1];
    if (!kw) continue;
    let next: Line | null = null;
    for (let j = k + 1; j < all.length && !next; j++) {
      const c = all[j];
      if (c && !(c.comment && c.depth <= l.depth)) next = c;
    }
    if (next && next.depth > l.depth) continue;
    out.push({
      line: l.index, start: l.lead.length, end: l.lead.length + kw.length, severity: 'warning',
      message: kw === 'while'
        ? `'while' has no indented block: the loop does nothing and repeats as long as the condition holds`
        : `'${kw}' has no indented block: the lines after it are not part of it and run anyway`,
    });
  }
  return out;
}
