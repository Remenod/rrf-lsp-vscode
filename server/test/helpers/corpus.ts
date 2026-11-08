// Access to the real-world corpus (see scripts/fetch-corpus.sh). Never committed.

import * as fs from 'fs';
import * as path from 'path';
import { SERVER_ROOT } from './harness';

export const CORPUS_ROOT = process.env.RRF_CORPUS_DIR ?? path.join(SERVER_ROOT, 'test', 'corpus', 'vm22-v4');
export const corpusAvailable = () => fs.existsSync(path.join(CORPUS_ROOT, 'sys', 'config.g'));
export const corpusSha = () => {
  try { return fs.readFileSync(path.join(CORPUS_ROOT, '.corpus-sha'), 'utf8').trim(); } catch { return 'unknown'; }
};

/** The `rrfgcode.*` settings the maintainers use in the canonical firmware clone's .vscode/settings.json. */
export const CORPUS_SETTINGS = {
  ignore: [
    'sys/daemon.g.bak', 'sys/daemon.g.off', 'sys/temp-network.g', 'sys/user/state/*',
    'sys/daemon.g.part', 'sys/version.txt',
  ],
};

/** G-code sources: every *.g, plus every extensionless file under macros/ (filename == UI label). */
export function corpusFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      const rel = path.relative(CORPUS_ROOT, abs).split(path.sep).join('/');
      if (/\.(md|json|csv|txt|png|jpg|bin|zip|gcode|ini|yml|yaml)$/i.test(e.name)) continue;
      if (rel.startsWith('.github/')) continue;
      if (e.name.endsWith('.g') || rel.startsWith('macros/') || rel.startsWith('filaments/')) out.push(abs);
    }
  };
  walk(CORPUS_ROOT);
  return out.sort();
}

import { pathToFileURL } from 'url';
import { Diagnostic } from 'vscode-languageserver/node';
import { SymbolTable } from '../../src/analysis/symbolTable';
import { computeDiagnostics } from '../../src/analysis/diagnostics';
import { defaultArgCheckConfig } from '../../src/analysis/argCheckConfig';

export interface CorpusResult { rel: string; text: string; diagnostics: Diagnostic[] }

/** Lint the whole corpus the way the server does after its workspace scan: every file indexed first. */
export function lintCorpus(): CorpusResult[] {
  const files = corpusFiles();
  const texts = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
  const symbolTable = new SymbolTable();
  for (const [f, t] of texts) symbolTable.indexDocument(pathToFileURL(f).toString(), t);
  const cfg = defaultArgCheckConfig();
  cfg.paths.ignore = CORPUS_SETTINGS.ignore;
  return files.map(f => ({
    rel: path.relative(CORPUS_ROOT, f).split(path.sep).join('/'),
    text: texts.get(f)!,
    diagnostics: computeDiagnostics(pathToFileURL(f).toString(), texts.get(f)!, { symbolTable, argCheckConfig: cfg, maxLineLength: 255 }),
  }));
}
