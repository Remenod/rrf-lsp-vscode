// A small printer workspace written for the tests. Every file is ordinary RRF 3.5 G-code of the
// kind a machine runs: globals declared in one file, read, changed and persisted in others.
// Tests that need many files at once use it: no false positives, timing, and independence from
// the order files are indexed in.

import { Diagnostic } from 'vscode-languageserver/node';
import { SymbolTable } from '../../src/analysis/symbolTable';
import { computeDiagnostics, DiagnosticsOptions } from '../../src/analysis/diagnostics';
import { defaultArgCheckConfig } from '../../src/analysis/argCheckConfig';
import { src } from './harness';

export const WORKSPACE: Readonly<Record<string, string>> = {
  'untitled:sys/globals.g': src(
    '; Persistent settings, declared once at startup',
    'if !exists(global.probeOffsetZ)',
    '  global probeOffsetZ = 0.0',
    'if !exists(global.purgeLength)',
    '  global purgeLength = 25',
    'if !exists(global.enclosureHot)',
    '  global enclosureHot = true',
    'if !exists(global.bedMode)',
    '  global bedMode = "auto"',
    'if !exists(global.nozzleWipeCount)',
    '  global nozzleWipeCount = 3',
    'if !exists(global.lastToolTemps)',
    '  global lastToolTemps = {0, 0}',
    'if !exists(global.fanBoost)',
    '  global fanBoost = null',
    'if !exists(global.servoAngle)',
    '  global servoAngle = 90',
    'M98 P"0:/sys/saved/settings.g"',
  ),
  'untitled:sys/saved/settings.g': src(
    '; Written by the macros below',
    'set global.probeOffsetZ = -0.12',
    'set global.bedMode = "manual"',
    'set global.servoAngle = 92',
  ),
  'untitled:macros/Adjust Probe Offset': src(
    '; Nudge the probe Z offset by S millimetres and keep the result',
    'if !exists(param.S)',
    '  abort "Adjust Probe Offset: missing S parameter"',
    'var step = param.S',
    'if var.step > 1 || var.step < -1',
    '  M291 P{"Step " ^ var.step ^ " mm is too large"} R"Probe offset" S2',
    '  M99',
    'set global.probeOffsetZ = global.probeOffsetZ + var.step',
    'echo >"0:/sys/saved/probe-offset.g" "set global.probeOffsetZ = " ^ global.probeOffsetZ',
    'echo "Probe offset is now", global.probeOffsetZ, "mm"',
  ),
  'untitled:macros/Purge Line': src(
    'var len = global.purgeLength',
    'if var.len <= 0',
    '  M99',
    'G90',
    'G1 X5 Y5 F6000',
    'G1 Z0.3 F600',
    'M83',
    'G1 X{5 + var.len * 4} E{var.len} F1200',
    'G1 E{-0.8} F2400',
    'G1 Z{0.3 + 2} F600',
  ),
  'untitled:macros/Heat Enclosure': src(
    '; Heat the enclosure and wait until it is within 2 degrees of the target',
    'if !exists(param.T)',
    '  abort "Heat Enclosure: missing T"',
    'set global.enclosureHot = null',
    'M141 S{param.T}',
    'var waited = 0',
    'while true',
    '  if heat.chamberHeaters[0] < 0',
    '    set global.enclosureHot = false',
    '    break',
    '  if abs(heat.heaters[heat.chamberHeaters[0]].current - param.T) < 2',
    '    set global.enclosureHot = true',
    '    break',
    '  if var.waited > 1800',
    '    abort "Enclosure did not reach " ^ param.T ^ "C in 30 minutes"',
    '  G4 S10',
    '  set var.waited = var.waited + 10',
    'echo "Enclosure hot after", var.waited, "s"',
  ),
  'untitled:macros/Toggle Bed Mode': src(
    '; Switch between automatic and manual bed levelling and keep the choice',
    'if global.bedMode == "auto"',
    '  set global.bedMode = "manual"',
    'else',
    '  set global.bedMode = "auto"',
    'echo >"0:/sys/saved/bed-mode.g" "set global.bedMode = """ ^ global.bedMode ^ """"',
    'M291 P{"Bed levelling is now " ^ global.bedMode} R"Bed" S1 T3',
  ),
  'untitled:macros/Servo Angle Up': src(
    'set global.servoAngle = global.servoAngle + 1',
    'echo >"0:/sys/saved/servo-angle.g" "set global.servoAngle = "^{global.servoAngle}^" ; set by the servo-angle macros"',
    'M280 P0 S{global.servoAngle}',
  ),
  'untitled:macros/Servo Angle Down': src(
    'set global.servoAngle = global.servoAngle - 1',
    'echo >"0:/sys/saved/servo-angle.g" "set global.servoAngle = "^{global.servoAngle}^" ; set by the servo-angle macros"',
    'M280 P0 S{global.servoAngle}',
  ),
  'untitled:macros/Save Fan Boost': src(
    '; Keep the fan boost of the active tool in a per-tool file',
    'if state.currentTool < 0',
    '  abort "No tool selected"',
    'var boost = 0.2',
    'if exists(param.B)',
    '  set var.boost = param.B',
    'echo >{"0:/sys/saved/fan-boost-" ^ state.currentTool ^ ".g"} "set global." ^ "fanBoost" ^ " = " ^ var.boost',
  ),
  'untitled:sys/tpost0.g': src(
    'M116 P0',
    'M106 P0 S{0.5 + global.fanBoost * 1}',
  ),
  'untitled:macros/Report Axes': src(
    'var homed = 0',
    'while iterations < #move.axes',
    '  if !move.axes[iterations].visible',
    '    continue',
    '  if move.axes[iterations].homed',
    '    set var.homed = var.homed + 1',
    '  echo move.axes[iterations].letter ^ ": " ^ move.axes[iterations].machinePosition',
    'echo var.homed, "of", #move.axes, "axes homed"',
  ),
  'untitled:macros/Load Filament': src(
    'if state.currentTool < 0',
    '  M291 P"Select a tool first" R"Load filament" S2',
    '  M99',
    'var t = state.currentTool',
    'var temp = 220',
    'if exists(param.S)',
    '  set var.temp = param.S',
    'M291 P{"Heat tool " ^ var.t ^ " to " ^ var.temp ^ "C?"} R"Load filament" S4 K{"Yes","No"}',
    'if input == 1',
    '  M99',
    'M568 P{var.t} S{var.temp} A2',
    'M116 P{var.t}',
    'M83',
    'G1 E{global.purgeLength} F300',
    'echo >"0:/sys/saved/temps.g" "set global.lastToolTemps = {" ^ var.temp ^ ", " ^ var.temp ^ "}"',
  ),
  'untitled:macros/Wipe Nozzle': src(
    'var passes = max(1, min(global.nozzleWipeCount, 10))',
    'var x0 = move.axes[0].min + 5',
    'var x1 = var.x0 + 40',
    'G1 Y{move.axes[1].max - 2} F6000',
    'while iterations < var.passes',
    '  G1 X{mod(iterations, 2) == 0 ? var.x1 : var.x0} F9000',
    'G1 Y{move.axes[1].max - 20} F6000',
  ),
  'untitled:macros/Status': src(
    'var s = "Idle"',
    'if state.status == "processing"',
    '  set var.s = "Printing " ^ floor(job.rawExtrusion) ^ " mm"',
    'elif state.status == "paused"',
    '  set var.s = "Paused"',
    'var up = floor(state.upTime / 3600)',
    'echo var.s ^ ", up " ^ var.up ^ " h, " ^ #tools ^ " tools"',
    'if global.enclosureHot != null && global.enclosureHot',
    '  echo "Enclosure hot"',
    'var offsets = vector(#tools, 0.0)',
    'echo "Offsets for", #var.offsets, "tools:", var.offsets',
  ),
};

/** The workspace repeated `copies` times under distinct folders (same globals), for timing. */
export function scaledWorkspace(copies: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < copies; i++) {
    for (const [uri, text] of Object.entries(WORKSPACE)) out[uri.replace('untitled:', `untitled:copy${i}/`)] = text;
  }
  return out;
}

export interface WorkspaceResult { uri: string; text: string; diagnostics: Diagnostic[] }

export interface WorkspaceLintOptions {
  typeCheck?: { enabled: boolean };
  rrfVersion?: string;
  reverseIndexOrder?: boolean;
}

/** Lint every file the way the server does after its workspace scan: every file is indexed first. */
export function lintWorkspace(docs: Readonly<Record<string, string>> = WORKSPACE, opts: WorkspaceLintOptions = {}): WorkspaceResult[] {
  const entries = Object.entries(docs);
  const symbolTable = new SymbolTable();
  const order = opts.reverseIndexOrder ? [...entries].reverse() : entries;
  for (const [uri, text] of order) symbolTable.indexDocument(uri, text);
  const argCheckConfig = defaultArgCheckConfig();
  return entries.map(([uri, text]) => ({
    uri,
    text,
    diagnostics: computeDiagnostics(uri, text, {
      symbolTable, argCheckConfig, maxLineLength: 255,
      ...(opts.typeCheck ? { typeCheck: opts.typeCheck } : {}),
      ...(opts.rrfVersion !== undefined ? { rrfVersion: opts.rrfVersion } : {}),
    } as DiagnosticsOptions),
  }));
}
