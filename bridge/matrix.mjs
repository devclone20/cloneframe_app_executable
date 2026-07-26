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
import { spawn, execFile } from 'node:child_process';
import Permissions from './permissions.mjs';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

const DIR = path.join(os.homedir(), '.clone-frame-hub');
const PIDFILE = path.join(DIR, 'matrix-engine.pid');
const LOGFILE = path.join(DIR, 'matrix-engine.log');
const CRASHFILE = path.join(DIR, 'matrix-engine.crashed');
const API = 'http://127.0.0.1:52415';
const DEFAULT_BIN = path.join(os.homedir(), 'exo', '.venv', 'bin', 'exo');

// Engine config (matrix.json) on the shared atomic JSON store: dir 0700 /
// file 0600, tmp-write-then-rename, read-per-call, never logs. The container is
// a free-form object ({enginePath?}); the per-field coercion below (enginePath's
// string/trim guard) stays this module's job, exactly as before. Read-per-call
// is already safe here — the sole mutation (setEnginePath) reads, mutates and
// writes in one shot, and no path relies on unsaved in-memory config.
const cfgStore = openStore({ name: 'matrix', shape: {}, root: hubRoot() });

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch { /* exists */ } }
function loadCfg() { return cfgStore.read(); }
function saveCfg(c) { cfgStore.write(c); } // throws on write failure — callers wrap

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
function writePidAtomic(pid) {
  const tmp = PIDFILE + '.tmp';
  fs.writeFileSync(tmp, String(pid), { mode: 0o600 });
  fs.renameSync(tmp, PIDFILE);
}

// Honest crash reporting: when a pid WE recorded is found dead with the API down,
// leave a marker (with the log tail) so the UI can say "engine crashed" instead of
// showing an eternal "Loading…". Cleared on the next successful start()/stop().
function logTail(n = 6) {
  try {
    const buf = fs.readFileSync(LOGFILE, 'utf8');
    const tail = buf.length > 32768 ? buf.slice(-32768) : buf;
    return tail.split('\n').filter(Boolean).slice(-n);
  } catch { return []; }
}
function writeCrash(pid) {
  try { fs.writeFileSync(CRASHFILE, JSON.stringify({ pid, at: new Date().toISOString(), logTail: logTail() }), { mode: 0o600 }); } catch { /* best effort */ }
}
function readCrash() {
  try { return JSON.parse(fs.readFileSync(CRASHFILE, 'utf8')); } catch { return null; }
}
function clearCrash() { try { fs.unlinkSync(CRASHFILE); } catch { /* gone */ } }

// Resolve the pid listening on the engine port — the only honest way to identify
// an engine this bridge did not start (external / survived a previous bridge).
function portPid() {
  return new Promise((res) => {
    execFile('/usr/sbin/lsof', ['-t', '-iTCP:52415', '-sTCP:LISTEN'], { timeout: 4000 }, (err, out) => {
      const n = parseInt(String(out || '').trim().split('\n')[0], 10);
      res(Number.isInteger(n) && n > 1 ? n : null);
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiUp(timeoutMs = 900) {
  try {
    const r = await fetch(API + '/node_id', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

async function status() {
  const pid = readPid();
  const owned = pid !== null && pidAlive(pid);
  const up = await apiUp();
  if (pid !== null && !owned) {
    if (!up) writeCrash(pid); // we started it and it died — say so, don't just forget
    clearPid();
  }
  return {
    running: up,
    ownedPid: owned ? pid : null,       // non-null only when WE started it
    externalPid: up && !owned ? await portPid() : null,
    crashed: up ? null : readCrash(),   // {pid, at, logTail} until the next start
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
  try { writePidAtomic(child.pid); } catch { /* stop() will refuse without it — still report */ }
  clearCrash(); // a fresh start supersedes any previous crash report
  // wait briefly for the API so the caller gets an honest first status
  for (let i = 0; i < 12; i++) {
    if (await apiUp(700)) return { ok: true, pid: child.pid, up: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: true, pid: child.pid, up: false, note: 'spawned — API not up yet, keep polling' };
}

async function stop(opts = {}) {
  if (!Permissions.can('matrix')) return { ok: false, error: 'matrix permission is off' };
  const force = opts && opts.force === true;
  let pid = readPid();
  if (pid !== null && !pidAlive(pid)) { clearPid(); pid = null; }
  if (pid === null) {
    if (!(await apiUp())) return { ok: false, error: 'engine is not running' };
    // External engine (not started by this bridge). Only an explicit force from the
    // owner's confirm takes it over — resolved by port, the one honest identity it has.
    if (!force) return { ok: false, external: true, error: 'engine was not started by MATRIX — use RESTART UNDER APP to take it over' };
    pid = await portPid();
    if (pid === null) return { ok: false, error: 'cannot resolve the external engine pid' };
  }
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  for (let i = 0; i < 8; i++) {
    if (!pidAlive(pid)) { clearPid(); clearCrash(); return { ok: true, pid }; }
    await sleep(350);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
  clearPid();
  clearCrash();
  return { ok: true, forced: true, pid };
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
