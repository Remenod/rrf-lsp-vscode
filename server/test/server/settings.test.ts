// The language server as an editor drives it: over stdio, with settings answered per workspace folder
// the way VS Code answers workspace/configuration (a folder's .vscode/settings.json applies to a
// request with that folder as scopeUri, not to a request without one).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { Diagnostic } from 'vscode-languageserver/node';
import { makeSd, SdTree, SERVER_ROOT } from '../helpers/harness';

const TEXT = ['echo round(10.5)', 'M569 S1', 'M558 K0 P8 U1', 'G1 X1 Q5', 'G4 P1.5'].join('\n');

/** VS Code's answers: the window has no target; the folder's own settings say `folder`. */
interface Answers { window: Record<string, unknown>; folder: Record<string, unknown> }

describe('settings reach the server per workspace folder', () => {
  let sd: SdTree;
  let child: cp.ChildProcess;
  let conn: MessageConnection;
  const answers: Answers = { window: { rrfVersion: '' }, folder: { rrfVersion: '3.5' } };
  const diags = new Map<string, Diagnostic[]>();
  let waiters: Array<() => void> = [];
  const folderUri = () => URI.file(sd.root).toString();
  const fileUri = (rel: string) => URI.file(sd.at(rel)).toString();

  const wait = (uri: string, pred: (d: Diagnostic[]) => boolean) => new Promise<Diagnostic[]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no matching diagnostics for ${uri}: ${JSON.stringify(diags.get(uri)?.map(d => d.message))}`)), 10000);
    const check = () => {
      const d = diags.get(uri);
      if (d && pred(d)) { clearTimeout(t); waiters = waiters.filter(w => w !== check); resolve(d); }
    };
    waiters.push(check);
    check();
  });
  const codes = (d: Diagnostic[]) => d.map(x => `${x.range.start.line + 1}:${x.code}`).sort();

  before(async () => {
    sd = makeSd({ 'macros/check': TEXT });
    child = cp.spawn(process.execPath, [path.join(SERVER_ROOT, 'out-test', 'src', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    conn = createMessageConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
    conn.onNotification('textDocument/publishDiagnostics', (p: { uri: string; diagnostics: Diagnostic[] }) => {
      diags.set(p.uri, p.diagnostics);
      for (const w of waiters) w();
    });
    conn.onRequest('workspace/configuration', (p: { items: Array<{ section?: string; scopeUri?: string }> }) => p.items.map(i => {
      const scope = i.scopeUri && i.scopeUri.startsWith(folderUri()) ? answers.folder : answers.window;
      const key = (i.section ?? '').replace(/^rrfgcode\./, '');
      return key in scope ? scope[key] : null;
    }));
    conn.onRequest('workspace/workspaceFolders', () => [{ uri: folderUri(), name: 'card' }]);
    conn.onRequest('client/registerCapability', () => null);
    conn.onNotification('window/logMessage', () => undefined);
    conn.listen();
    await conn.sendRequest('initialize', {
      processId: process.pid, rootUri: folderUri(), workspaceFolders: [{ uri: folderUri(), name: 'card' }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: true } } },
    });
    conn.sendNotification('initialized', {});
    conn.sendNotification('textDocument/didOpen', { textDocument: { uri: fileUri('macros/check'), languageId: 'rrf-gcode', version: 1, text: TEXT } });
  });

  after(async () => {
    await conn.sendRequest('shutdown').catch(() => undefined);
    conn.sendNotification('exit');
    conn.dispose();
    child.kill();
    sd.cleanup();
  });

  it("the folder's target line decides: round() and the letters follow RRF 3.5", async () => {
    const d = await wait(fileUri('macros/check'), x => x.some(y => y.code === 'rrf-version'));
    assert.deepEqual(codes(d), ['1:rrf-version', '2:rrf-param-missing', '3:rrf-param-unknown', '4:rrf-param-unknown', '5:rrf-param-value']);
    assert.match(d.find(x => x.code === 'rrf-version')!.message, /'round' is not available on RepRapFirmware 3\.5/);
  });

  it('a settings change re-checks the open documents', async () => {
    answers.folder = { rrfVersion: '3.7' };
    conn.sendNotification('workspace/didChangeConfiguration', { settings: null });
    const d = await wait(fileUri('macros/check'), x => !x.some(y => y.code === 'rrf-version'));
    assert.deepEqual(codes(d), ['4:rrf-param-unknown', '5:rrf-param-value']);
  });

  it('the parameter checks follow their own setting', async () => {
    answers.folder = { rrfVersion: '3.5', argCheck: { enabled: true, parameters: { enabled: false } } };
    conn.sendNotification('workspace/didChangeConfiguration', { settings: null });
    const d = await wait(fileUri('macros/check'), x => x.some(y => y.code === 'rrf-version'));
    assert.deepEqual(codes(d), ['1:rrf-version']);
  });

  it('with a single-board computer, numbers written without {…} are not checked', async () => {
    answers.folder = { rrfVersion: '3.7', sbc: true };
    conn.sendNotification('workspace/didChangeConfiguration', { settings: null });
    const d = await wait(fileUri('macros/check'), x => !x.some(y => y.code === 'rrf-version') && x.some(y => y.code === 'rrf-param-unknown'));
    assert.deepEqual(codes(d), ['4:rrf-param-unknown']);
  });
});
