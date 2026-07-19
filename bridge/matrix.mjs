// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — MATRIX engine lifecycle
//
// Owns the PROCESS of the local distributed-AI-cluster engine ("MATRIX engine",
// exo-compatible API on 127.0.0.1:52415). The data plane (state/models/chat) is
// consumed by the UI directly; this module only starts/stops/reports the engine.
//
// Security: gated by the 'matrix' permission (default OFF, its own gate — NOT
// unlocked by the master switch, mirroring ssh: spawning/killing a daemon is a
// deliberate owner choice). stop() only ever kills a pid THIS module started
// (recorded in the pidfile) and verifies the pid still looks like our engine
// before signalling. Engine binary path is validated to an existing executable.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import Permissions from './permissions.mjs';

const DIR = path.join(os.homedir(), '.clone-frame-hub');
const PIDFILE = path.join(DIR, 'matrix-engine.pid');
const LOGFILE = path.join(DIR, 'matrix-engine.log');
const CFGFILE = path.join(DIR, 'matrix.json');
const API = 'http://127.0.0.1:52415';
const DEFAULT_BIN = path.join(os.homedir(), 'exo', '.venv', 'bin', 'exo');

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch { /* exists */ } }
function loadCfg() { try { return JSON.parse(fs.readFileSync(CFGFILE, 'utf8')) || {}; } catch { return {}; } }
function saveCfg(c) {
  ensureDir();
  const tmp = CFGFILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CFGFILE);
}

function enginePath() {
  const cfg = loadCfg();
  const p = typeof cfg.enginePath === 'string' && cfg.enginePath.trim() ? cfg.enginePath.trim() : DEFAULT_BIN;
  return p;
}
function binOk(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

function readPid() {
  try {
    const n = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function clearPid() { try { fs.unlinkSync(PIDFILE); } catch { /* gone */ } }

async function apiUp(timeoutMs = 900) {
  try {
    const r = await fetch(API + '/node_id', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

async function status() {
  const pid = readPid();
  const owned = pid !== null && pidAlive(pid);
  if (pid !== null && !owned) clearPid(); // stale pidfile from a previous boot
  return {
    running: await apiUp(),
    ownedPid: owned ? pid : null,       // non-null only when WE started it
    enginePath: enginePath(),
    engineFound: binOk(enginePath()),
    api: API,
  };
}

async function start() {
  if (!Permissions.can('matrix')) return { ok: false, error: 'matrix permission is off' };
  if (await apiUp()) return { ok: true, already: true };
  const bin = enginePath();
  if (!binOk(bin)) return { ok: false, error: 'engine not found at ' + bin + ' — set the path in matrix.json or install it' };
  ensureDir();
  let out;
  try { out = fs.openSync(LOGFILE, 'a', 0o600); } catch (e) { return { ok: false, error: 'cannot open engine log: ' + (e.message || e) }; }
  let child;
  try {
    child = spawn(bin, [], { cwd: path.dirname(path.dirname(path.dirname(bin))), detached: true, stdio: ['ignore', out, out] });
    child.unref();
  } catch (e) {
    try { fs.closeSync(out); } catch { /* already closed */ }
    return { ok: false, error: e.message || String(e) };
  }
  try { fs.closeSync(out); } catch { /* child holds its own fd */ }
  if (!child.pid) return { ok: false, error: 'spawn failed (no pid)' };
  try { fs.writeFileSync(PIDFILE, String(child.pid), { mode: 0o600 }); } catch { /* stop() will refuse without it — still report */ }
  // wait briefly for the API so the caller gets an honest first status
  for (let i = 0; i < 12; i++) {
    if (await apiUp(700)) return { ok: true, pid: child.pid, up: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: true, pid: child.pid, up: false, note: 'spawned — API not up yet, keep polling' };
}

async function stop() {
  if (!Permissions.can('matrix')) return { ok: false, error: 'matrix permission is off' };
  const pid = readPid();
  if (pid === null || !pidAlive(pid)) {
    clearPid();
    return { ok: false, error: (await apiUp()) ? 'engine was not started by MATRIX — stop it where you launched it' : 'engine is not running' };
  }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  for (let i = 0; i < 8; i++) {
    if (!pidAlive(pid)) { clearPid(); return { ok: true }; }
    await new Promise((r) => setTimeout(r, 350));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
  clearPid();
  return { ok: true, forced: true };
}

function logs(lines = 60) {
  const n = Math.max(1, Math.min(200, parseInt(lines, 10) || 60));
  try {
    const buf = fs.readFileSync(LOGFILE, 'utf8');
    const tail = buf.length > 65536 ? buf.slice(-65536) : buf;
    return { ok: true, lines: tail.split('\n').slice(-n) };
  } catch { return { ok: true, lines: [] }; }
}

function setEnginePath(p) {
  if (!Permissions.can('matrix')) return { ok: false, error: 'matrix permission is off' };
  if (typeof p !== 'string' || !path.isAbsolute(p.trim())) return { ok: false, error: 'absolute path required' };
  const clean = p.trim();
  if (!binOk(clean)) return { ok: false, error: 'not an executable file: ' + clean };
  const cfg = loadCfg();
  cfg.enginePath = clean;
  try { saveCfg(cfg); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  return { ok: true };
}

export const Matrix = { status, start, stop, logs, setEnginePath };
export default Matrix;
