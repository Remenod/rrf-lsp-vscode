// analysis/rrfFiles.ts
// Which files on disk are RRF G-code. Shared by the workspace scan in server.ts
// and by the tests that lint a whole configuration directory.

import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';

// Compared case-insensitively (extensions are lower-cased before lookup) and
// aligned with the language registration in package.json (.g/.gcode/.gc/.gco).
export const RRF_EXTENSIONS = new Set(['.g', '.gcode', '.gc', '.gco', '.macro', '.cfg']);

// Extensions that other ecosystems use too (e.g. Klipper's printer.cfg), so a
// file only counts as RRF G-code when its content also looks like it.
export const SNIFFED_EXTENSIONS = new Set(['.cfg', '.macro']);

/**
 * Returns true if `text` looks like RRF G-code / meta-command content.
 *
 * Used to classify files without a registered extension (e.g. `homedelta`,
 * `bed.g.bak`, or completely extensionless macros dropped in sys/).
 *
 * Heuristic: sample the first 30 non-blank lines; if ≥ 20 % of them start
 * with a recognisable G-code or meta-command pattern we treat the file as
 * RRF G-code.
 */
export function looksLikeGCode(text: string): boolean {
  const checked = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .slice(0, 30);

  if (checked.length === 0) return false;

  let hits = 0;
  for (const line of checked) {
    if (/^;/.test(line)) { hits++; continue; }                         // comment
    if (/^[GMTgmt]\d/.test(line)) { hits++; continue; }                // G/M/T code
    if (/^(var|global|set|if|elif|else|while|break|continue|abort|param|echo|skip)\b/i
      .test(line)) { hits++; continue; }                               // meta command
  }

  return hits >= Math.max(2, Math.floor(checked.length * 0.2));
}

/** RepRapFirmware treats every file in a macros folder as a macro, whatever its name ("Upgrade to 4.0.1"). */
function inMacrosFolder(filePath: string): boolean {
  return filePath.split(/[\\/]/).slice(0, -1).includes('macros');
}

/** Whether a file can be RRF G-code judging by its path alone; `isRrfFile` then decides on the content. */
export function mayBeRrfFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '' || RRF_EXTENSIONS.has(ext) || inMacrosFolder(filePath);
}

/**
 * Whether a file is RRF G-code: a registered extension, or — with no extension, an extension
 * other ecosystems share (.cfg/.macro) or any name inside a macros folder — content that looks like
 * G-code, so e.g. a Klipper printer.cfg or an image in macros/ is not indexed.
 */
export function isRrfFile(filePath: string, content: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (RRF_EXTENSIONS.has(ext) && !SNIFFED_EXTENSIONS.has(ext)) return true;
  return mayBeRrfFile(filePath) && looksLikeGCode(content);
}

/**
 * Collect all RRF files under `dir`. Hidden entries and node_modules are skipped,
 * and so is every file for which `skip(uri)` is true (the server passes the open
 * documents, whose diagnostics it handles separately).
 */
export function collectRrfFiles(dir: string, skip: (uri: string) => boolean = () => false): Array<{ uri: string; content: string }> {
  const results: Array<{ uri: string; content: string }> = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRrfFiles(fullPath, skip));
      continue;
    }

    if (!mayBeRrfFile(fullPath)) continue;

    const fileUri = URI.file(fullPath).toString();
    if (skip(fileUri)) continue;

    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    if (!isRrfFile(fullPath, content)) continue;

    results.push({ uri: fileUri, content });
  }
  return results;
}
