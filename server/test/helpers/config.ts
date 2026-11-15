// A configuration directory chosen by whoever runs the tests: RRF_CONFIG_DIR=<dir>.
// Any RRF SD-card tree (sys/, macros/, filaments/ …) or a repository holding one; where it came
// from does not matter, and nothing in this repository names one. Files are found the way the
// server's workspace scan finds them, except print jobs under gcodes/ (sliced files are megabytes of
// moves, not configuration); `rrfgcode.*` settings come from <dir>/.vscode/settings.json when it
// exists, as they would in VS Code with that folder open.

import * as fs from 'fs';
import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import { URI } from 'vscode-uri';
import { Diagnostic } from 'vscode-languageserver/node';
import { SymbolTable } from '../../src/analysis/symbolTable';
import { computeDiagnostics, DiagnosticsOptions } from '../../src/analysis/diagnostics';
import { ArgCheckConfig, normaliseArgCheckConfig } from '../../src/analysis/argCheckConfig';
import { collectRrfFiles } from '../../src/analysis/rrfFiles';

export const CONFIG_DIR: string | undefined = process.env.RRF_CONFIG_DIR ? path.resolve(process.env.RRF_CONFIG_DIR) : undefined;

/** Reason to skip the configuration tests, or false when RRF_CONFIG_DIR is set. */
export const configSkip: string | false = CONFIG_DIR ? false : 'set RRF_CONFIG_DIR to an RRF configuration directory to run';

export interface ConfigSettings {
  argCheckConfig: ArgCheckConfig;
  maxLineLength: number;
  typeCheckEnabled: boolean;
  /** `rrfgcode.rrfVersion`, or undefined when the settings do not set one. */
  rrfVersion: string | undefined;
}

export interface ConfigFile { uri: string; rel: string; text: string }
export interface ConfigResult extends ConfigFile { diagnostics: Diagnostic[] }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Merge `{"rrfgcode.argCheck.paths.ignore": […]}` and nested forms alike into one nested object. */
function nest(src: Record<string, unknown>, out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(src)) {
    const parts = k.split('.');
    let cur = out;
    for (const p of parts.slice(0, -1)) {
      if (!isObject(cur[p])) cur[p] = {};
      cur = cur[p] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (isObject(v)) {
      if (!isObject(cur[last])) cur[last] = {};
      nest(v, cur[last] as Record<string, unknown>);
    } else cur[last] = v;
  }
  return out;
}

let settingsCache: ConfigSettings | undefined;

export function configSettings(): ConfigSettings {
  if (settingsCache) return settingsCache;
  let raw: Record<string, unknown> = {};
  const file = path.join(requireDir(), '.vscode', 'settings.json');
  if (fs.existsSync(file)) {
    const errors: jsonc.ParseError[] = [];
    const parsed = jsonc.parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`${file}: invalid JSON (${errors.length} parse errors)`);
    raw = isObject(parsed) ? nest(parsed) : {};
  }
  const r = (raw.rrfgcode ?? {}) as Record<string, any>;
  const max = Number(r.maxLineLength);
  settingsCache = {
    argCheckConfig: normaliseArgCheckConfig(r.argCheck),
    maxLineLength: Number.isInteger(max) && max > 0 ? max : 255,
    typeCheckEnabled: r.typeCheck?.enabled !== false,
    rrfVersion: typeof r.rrfVersion === 'string' && r.rrfVersion.trim() !== '' ? r.rrfVersion : undefined,
  };
  return settingsCache;
}

function requireDir(): string {
  if (!CONFIG_DIR) throw new Error('RRF_CONFIG_DIR is not set');
  if (!fs.existsSync(CONFIG_DIR) || !fs.statSync(CONFIG_DIR).isDirectory()) throw new Error(`RRF_CONFIG_DIR: ${CONFIG_DIR} is not a directory`);
  if (!['sys', 'macros'].some(d => fs.existsSync(path.join(CONFIG_DIR!, d)))) {
    throw new Error(`RRF_CONFIG_DIR: ${CONFIG_DIR} has neither sys/ nor macros/ — point it at the root of an RRF configuration`);
  }
  return CONFIG_DIR;
}

let filesCache: ConfigFile[] | undefined;

/** Every RRF file of the configuration except print jobs (`gcodes/`), in a stable order. */
export function configFiles(): ConfigFile[] {
  if (filesCache) return filesCache;
  const root = requireDir();
  const jobs = URI.file(path.join(root, 'gcodes')).toString() + '/';
  filesCache = collectRrfFiles(root, uri => uri.startsWith(jobs))
    .map(({ uri, content }) => ({ uri, text: content, rel: path.relative(root, URI.parse(uri).fsPath).split(path.sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return filesCache;
}

export interface ConfigLintOptions {
  typeCheck?: { enabled: boolean };
  /** Overrides the settings' `rrfgcode.rrfVersion`; null means unset. */
  rrfVersion?: string | null;
  reverseIndexOrder?: boolean;
}

/** Lint the configuration the way the server does after its workspace scan: every file indexed first. */
export function lintConfig(opts: ConfigLintOptions = {}): ConfigResult[] {
  const files = configFiles();
  const s = configSettings();
  const symbolTable = new SymbolTable();
  for (const f of opts.reverseIndexOrder ? [...files].reverse() : files) symbolTable.indexDocument(f.uri, f.text);
  const rrfVersion = opts.rrfVersion === null ? undefined : opts.rrfVersion ?? s.rrfVersion;
  return files.map(f => ({ ...f, diagnostics: lintWith(symbolTable, f.uri, f.text, opts.typeCheck ?? { enabled: s.typeCheckEnabled }, rrfVersion) }));
}

/** Lint one text on its own (a fresh index holding only it), as if it were the file `f`. */
export function lintAlone(f: ConfigFile, text: string): Diagnostic[] {
  const symbolTable = new SymbolTable();
  symbolTable.indexDocument(f.uri, text);
  return lintWith(symbolTable, f.uri, text, { enabled: configSettings().typeCheckEnabled }, configSettings().rrfVersion);
}

function lintWith(symbolTable: SymbolTable, uri: string, text: string, typeCheck: { enabled: boolean }, rrfVersion: string | undefined): Diagnostic[] {
  const s = configSettings();
  return computeDiagnostics(uri, text, {
    symbolTable, argCheckConfig: s.argCheckConfig, maxLineLength: s.maxLineLength, typeCheck,
    ...(rrfVersion !== undefined ? { rrfVersion } : {}),
  } as DiagnosticsOptions);
}
