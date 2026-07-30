// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — MATRIX: the local engine and the models it owns
//
// Two jobs, one module, because they are the same subject: the process that serves
// the local cluster (exo-compatible API on port 52415) and the weights that process
// reads off this machine's disk.
//
// WHAT THIS MODULE REFUSES TO GUESS
//
//   Which process is the engine. A pid alone is not an identity: pids are recycled,
//   and signalling a recycled one kills a stranger. Every signal here is preceded by
//   a command-line check against the binary we recorded at spawn time, plus exo's own
//   locked pidfile as a second witness.
//
//   What is a model. Not "every directory under a models root" — that reading turned
//   a folder the owner parked next to their weights into a row with a DELETE button.
//   A directory is a model only when it is named the way exo names them AND carries
//   weights. Nothing else is ever listed, and nothing else is ever removed.
//
//   Which machine a model is on. The bridge can only see THIS one. Deletes are scoped
//   to the local node unless the caller explicitly asks for the whole cluster.
//
// SECURITY
//   - gated by the 'matrix' permission (default OFF, its own gate — NOT unlocked by
//     the master switch, mirroring ssh: spawning a resident daemon and erasing model
//     weights are both deliberate owner choices)
//   - the engine itself binds 0.0.0.0 with no authentication (exo hardcodes it:
//     api/main.py `cfg.bind = ["0.0.0.0:<port>"]`). We cannot change that from here,
//     so status() reports it as `lanExposed` and the UI says so out loud rather than
//     repeating a comfortable "127.0.0.1".
//   - state files live under hubRoot(), the same seam as every other store, so a test
//     can never write to the developer's real configuration.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import Permissions from './permissions.mjs';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

const API = 'http://127.0.0.1:52415';
const PORT = 52415;
const HOME = os.homedir();
const DEFAULT_BIN = path.join(HOME, 'exo', '.venv', 'bin', 'exo');
const LOG_MAX = 8 * 1024 * 1024;   // rotate past this; a year of engine output is not a log
const LOG_TAIL = 64 * 1024;        // never read more than this, whatever the file size

// Resolved per call, like every other store: hubRoot() honours CLONE_FRAME_HUB_ROOT.
// These were verbatim os.homedir() joins, which relocated half this module under test
// and left the other half writing to the real home.
const stateDir = () => hubRoot();
const pidFile = () => path.join(stateDir(), 'matrix-engine.pid');
const logFile = () => path.join(stateDir(), 'matrix-engine.log');
const crashFile = () => path.join(stateDir(), 'matrix-engine.crashed');

// Engine config (matrix.json) on the shared atomic JSON store: dir 0700 / file 0600,
// tmp-write-then-rename, read-per-call, never logs.
const cfgStore = openStore({ name: 'matrix', shape: {}, root: hubRoot() });

function ensureDir() { try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); } catch { /* exists */ } }
function loadCfg() { return cfgStore.read(); }
function saveCfg(c) { cfgStore.write(c); } // throws on write failure — callers wrap

function enginePath() {
  const cfg = loadCfg();
  return typeof cfg.enginePath === 'string' && cfg.enginePath.trim() ? cfg.enginePath.trim() : DEFAULT_BIN;
}
function binOk(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── who is the engine ────────────────────────────────────────────────────────
// The pidfile carries the binary we spawned, not just a number, so a recycled pid
// can be recognised as a stranger before anything is signalled.

/** @returns {{pid:number, bin:string|null, startedAt:number|null}|null} */
function readPid() {
  let raw; try { raw = fs.readFileSync(pidFile(), 'utf8').trim(); } catch { return null; }
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && Number.isInteger(j.pid) && j.pid > 1) return { pid: j.pid, bin: j.bin || null, startedAt: j.startedAt || null };
  } catch { /* the old format was a bare integer — still readable */ }
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 1 ? { pid: n, bin: null, startedAt: null } : null;
}
function writePidAtomic(rec) {
  const tmp = pidFile() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, pidFile());
}
function clearPid() { try { fs.unlinkSync(pidFile()); } catch { /* gone */ } }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }

/** The command line of a pid, or '' when it cannot be read. */
function pidCommand(pid) {
  return new Promise((res) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 }, (err, out) => {
      res(err ? '' : String(out || '').trim());
    });
  });
}

/** exo writes its own locked pidfile — the one identity it publishes about itself. */
function exoPid() {
  try {
    const n = parseInt(fs.readFileSync(path.join(exoHome(), 'exo.pid'), 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch { return null; }
}

/**
 * Is this pid the engine we recorded? Two witnesses, either one suffices, both are
 * cheap: exo's own pidfile, or a command line that still names the binary we spawned.
 * A pid that answers neither is a stranger, and a stranger is never signalled.
 */
async function pidIsEngine(rec) {
  if (!rec || !pidAlive(rec.pid)) return false;
  if (exoPid() === rec.pid) return true;
  const cmd = await pidCommand(rec.pid);
  if (!cmd) return false;
  if (rec.bin && cmd.includes(rec.bin)) return true;
  return /(^|\/)exo(\s|$)/.test(cmd) || cmd.includes('/exo');
}

/**
 * Who is listening on the engine port, and on which address.
 * `lsof` through PATH first so this is not macOS-only; the absolute path is the
 * fallback because a hardened PATH may not carry it.
 * @returns {Promise<{pid:number|null, addr:string}>}
 */
function portListener() {
  const run = (cmd) => new Promise((res) => {
    execFile(cmd, ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN'], { timeout: 4000 }, (err, out) => res(err ? '' : String(out || '')));
  });
  return (async () => {
    let out = await run('lsof');
    if (!out) out = await run('/usr/sbin/lsof');
    if (!out) return { pid: null, addr: '' };
    for (const line of out.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 9) continue;
      const pid = parseInt(cols[1], 10);
      const name = cols[cols.length - 2] === '(LISTEN)' ? cols[cols.length - 3] : cols[cols.length - 2];
      return { pid: Number.isInteger(pid) && pid > 1 ? pid : null, addr: String(name || '') };
    }
    return { pid: null, addr: '' };
  })();
}

// Honest crash reporting: when a pid WE recorded is found dead with the API down,
// leave a marker (with the log tail) so the UI can say "engine crashed" instead of
// showing an eternal "Loading…". Cleared as soon as an engine is demonstrably alive.
function logTail(n = 6) {
  const lines = readTail().split('\n').filter(Boolean);
  return lines.slice(-n);
}
/** Read at most LOG_TAIL bytes off the end. The log is unbounded; the read must not be. */
function readTail() {
  let fd = null;
  try {
    fd = fs.openSync(logFile(), 'r');
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, LOG_TAIL);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    return buf.toString('utf8');
  } catch { return ''; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}
function rotateLog() {
  try {
    if (fs.statSync(logFile()).size > LOG_MAX) fs.renameSync(logFile(), logFile() + '.1');
  } catch { /* no log yet, or the rename lost a race — either way, keep going */ }
}
function writeCrash(pid) {
  try { fs.writeFileSync(crashFile(), JSON.stringify({ pid, at: new Date().toISOString(), logTail: logTail() }), { mode: 0o600 }); } catch { /* best effort */ }
}
function readCrash() {
  try { return JSON.parse(fs.readFileSync(crashFile(), 'utf8')); } catch { return null; }
}
function clearCrash() { try { fs.unlinkSync(crashFile()); } catch { /* gone */ } }

async function apiUp(timeoutMs = 900) {
  try {
    const r = await fetch(API + '/node_id', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}
async function engineJson(p, ms = 3000) {
  try {
    const r = await fetch(API + p, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function status() {
  const rec = readPid();
  const up = await apiUp();
  // Identity, not liveness: a live pid that is no longer the engine is a stranger who
  // inherited the number, and reporting it as ours arms a STOP button that kills them.
  const owned = rec !== null && await pidIsEngine(rec);
  if (rec !== null && !owned) {
    if (!up && pidAlive(rec.pid) === false) writeCrash(rec.pid); // ours, and it died — say so
    clearPid();
  }
  if (up) clearCrash(); // a running engine supersedes any crash report, however old
  const listener = up ? await portListener() : { pid: null, addr: '' };
  return {
    running: up,
    ownedPid: owned ? rec.pid : null,        // non-null only when WE started it AND it is still it
    externalPid: up && !owned ? listener.pid : null,
    externalResolved: up && !owned ? listener.pid !== null : null,
    // exo hardcodes a 0.0.0.0 bind and ships no host flag. Saying so is the only fix
    // available from here; pretending it is loopback is not.
    lanExposed: up ? /^(\*|0\.0\.0\.0|::)[:.]/.test(listener.addr) || /^\*:/.test(listener.addr) : null,
    listenAddr: listener.addr || null,
    crashed: up ? null : readCrash(),        // {pid, at, logTail} until the next start
    enginePath: enginePath(),
    engineFound: binOk(enginePath()),
    api: API,
  };
}

// A start already in flight. Without this, a double click spawns two engines: the
// loser dies, the pidfile points at a corpse, and the survivor becomes "external"
// — an engine the app can see and can never stop.
let starting = null;

async function start() {
  if (!Permissions.can('matrix')) return { ok: false, error: 'matrix permission is off' };
  if (starting) return starting;
  starting = (async () => {
    if (await apiUp()) return { ok: true, already: true };
    const rec = readPid();
    if (rec && await pidIsEngine(rec)) return { ok: true, already: true, pid: rec.pid, note: 'still coming up' };
    const bin = enginePath();
    if (!binOk(bin)) return { ok: false, error: 'engine not found at ' + bin + ' — install it, or point MATRIX at it in Settings' };
    ensureDir();
    rotateLog();
    let out;
    try { out = fs.openSync(logFile(), 'a', 0o600); } catch (e) { return { ok: false, error: 'cannot open engine log: ' + (e.message || e) }; }
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
    try { writePidAtomic({ pid: child.pid, bin, startedAt: Date.now() }); } catch { /* stop() will refuse without it — still report */ }
    clearCrash();
    for (let i = 0; i < 12; i++) {
      // The child dying is an answer too, and a faster one than the API timing out.
      if (!pidAlive(child.pid)) {
        writeCrash(child.pid); clearPid();
        return { ok: false, error: 'the engine exited while starting', logTail: logTail(12) };
      }
      if (await apiUp(700)) return { ok: true, pid: child.pid, up: true };
      await sleep(500);
    }
    // Alive but not serving yet: a cold MLX init legitimately takes longer than this.
    return { ok: true, pid: child.pid, up: false, note: 'spawned — API not up yet, keep polling' };
  })();
  try { return await starting; } finally { starting = null; }
}

async function stop(opts = {}) {
  if (!Permissions.can('matrix')) return { ok: false, error: 'matrix permission is off' };
  const force = opts && opts.force === true;
  let rec = readPid();
  let owned = false;
  if (rec !== null) {
    owned = await pidIsEngine(rec);
    if (!owned) { clearPid(); rec = null; } // a stranger holds that number now
  }
  let pid = rec ? rec.pid : null;
  if (pid === null) {
    if (!(await apiUp())) return { ok: false, error: 'engine is not running' };
    // External engine (not started by this bridge). Only an explicit force from the
    // owner's confirm takes it over — resolved by port, the one identity it has.
    if (!force) return { ok: false, external: true, error: 'engine was not started by MATRIX — use RESTART UNDER APP to take it over' };
    const listener = await portListener();
    if (listener.pid === null) return { ok: false, error: 'cannot resolve the external engine pid on this system' };
    pid = listener.pid;
  }

  try { process.kill(pid, 'SIGTERM'); }
  catch (e) {
    // ESRCH: it exited between the check and the signal. EPERM: not ours to signal —
    // either way the recorded pid is useless and must not stay armed on a button.
    clearPid();
    if (e && e.code === 'ESRCH') return { ok: true, pid, note: 'already gone' };
    return { ok: false, error: e.message || String(e) };
  }
  // exo tears down its own model runners on SIGTERM; killing it early orphans them
  // holding gigabytes of wired memory. Give it a real window before escalating.
  for (let i = 0; i < 60; i++) {
    if (!pidAlive(pid)) { clearPid(); clearCrash(); return { ok: true, pid }; }
    await sleep(350);
  }
  // Escalate to the whole process group, but only for an engine WE spawned detached —
  // it is the group leader, so this reaches the runners. An external pid may not be,
  // and -pid would then signal an unrelated group.
  try { process.kill(owned ? -pid : pid, 'SIGKILL'); } catch { /* raced to exit */ }
  await sleep(500);
  if (pidAlive(pid)) return { ok: false, error: 'the engine did not exit (pid ' + pid + ')', pid };
  clearPid();
  clearCrash();
  return { ok: true, forced: true, pid };
}

function logs(lines = 60) {
  const n = Math.max(1, Math.min(200, parseInt(lines, 10) || 60));
  const tail = readTail();
  return { ok: true, lines: tail ? tail.split('\n').slice(-n) : [] };
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

// ─────────────────────────────────────────────────────────────────────────────
// Local models — the DISK is the source of truth
//
// The engine reports what it has by replaying its own event log. Nothing in the app
// ever asked the filesystem, and that gap had teeth: a model you already owned went
// invisible whenever the log and the disk disagreed, and it could not be deleted at
// all while the engine was down.
//
// exo's layout (shared/constants.py + download/download_utils.delete_model):
//   <root>/<org>--<name>/          the weights                 (model id: "/" → "--")
//   <root>/caches/<org>--<name>/   the file-list metadata
// <root> is ~/.exo/models on macOS/Windows and XDG on Linux, overridable through
// EXO_HOME / EXO_DEFAULT_MODELS_DIR / EXO_MODELS_DIRS. EXO_MODELS_READ_ONLY_DIRS is
// never written to or deleted from — the engine honours that, and so does this.
// ─────────────────────────────────────────────────────────────────────────────
const HF_HUB = path.join(HOME, '.cache', 'huggingface', 'hub');
// A Hugging Face repo id: one optional org segment, no traversal. Anything that does
// not match this never gets joined onto a path, let alone removed.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
// Directory names that live under a models root and are NOT models.
const RESERVED = new Set(['caches', '.', '..']);
// A directory is a model when it carries weights. Nothing else is listed, and nothing
// else is removed — the alternative treated a folder the owner parked beside their
// weights as an owned model and offered to delete it.
const WEIGHT_FILE = /\.(safetensors|gguf|bin|npz|mlx)(\.partial)?$/i;
const MARKER_FILE = /^(config\.json|model_index\.json|params\.json)$/i;

const tilde = (p) => (p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p);
const expandHome = (p) => (String(p || '').startsWith('~/') ? path.join(HOME, String(p).slice(2)) : String(p || ''));
const colonDirs = (name) => String(process.env[name] || '').split(':').filter(Boolean).map((d) => path.resolve(expandHome(d)));
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function exoHome() {
  // Python's `Path.home() / EXO_HOME` discards the left side when the right is
  // absolute; path.join does not. path.resolve matches Python in both cases, and
  // without it an absolute EXO_HOME made every model invisible.
  if (process.env.EXO_HOME) return path.resolve(HOME, process.env.EXO_HOME);
  if (process.platform !== 'linux') return path.join(HOME, '.exo');
  return process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'exo') : path.join(HOME, '.local', 'share', 'exo');
}

/** Every directory that may hold weights on this machine — existing ones only, default first. */
function modelRoots() {
  const out = [];
  const add = (p) => { const r = path.resolve(p); if (r && !out.includes(r)) out.push(r); };
  add(process.env.EXO_DEFAULT_MODELS_DIR ? expandHome(process.env.EXO_DEFAULT_MODELS_DIR) : path.join(exoHome(), 'models'));
  for (const d of colonDirs('EXO_MODELS_DIRS')) add(d);
  for (const d of colonDirs('EXO_MODELS_READ_ONLY_DIRS')) add(d);
  // The engine has moved this home between versions. Probing costs one stat and keeps
  // a download made by an older build deletable instead of stranded forever.
  add(path.join(HOME, '.exo', 'models'));
  add(path.join(HOME, '.local', 'share', 'exo', 'models'));
  add(path.join(HOME, '.cache', 'exo', 'models'));
  return out.filter(isDir);
}

/**
 * Bytes, file count and completeness of a model tree. Symlinks are never followed:
 * they inflate the number and would let a link inside a models directory point the
 * purge outside it.
 * @returns {{bytes:number, files:number, weights:number, marker:boolean, partial:boolean}}
 */
function dirStats(dir) {
  let bytes = 0, files = 0, weights = 0, marker = false, partial = false;
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      try { bytes += fs.statSync(p).size; files++; } catch { continue; /* vanished mid-walk */ }
      if (e.name.endsWith('.partial')) partial = true;
      if (WEIGHT_FILE.test(e.name) && !e.name.endsWith('.partial')) weights++;
      if (MARKER_FILE.test(e.name)) marker = true;
    }
  };
  walk(dir, 0);
  return { bytes, files, weights, marker, partial };
}

/** Does this directory hold an exo model? Name shaped like one AND real weights inside. */
function looksLikeModel(name, stats) {
  if (RESERVED.has(name) || name.startsWith('.')) return false;
  return stats.weights > 0 || (stats.marker && stats.partial);
}

// A full recursive stat of every models root is not free, and syncModels asks for it on
// a 5s clock. Memoise — but key it on the roots' own mtimes, not just a timer: a model
// appearing or disappearing bumps its parent directory, so the cache is exact about the
// question it answers (which models exist) and only ever stale about their size.
let diskMemo = { at: 0, sig: '', val: null };
const DISK_TTL = 4000;
function invalidateDisk() { diskMemo = { at: 0, sig: '', val: null }; }
function rootsSig(roots) {
  return roots.map((r) => { try { return r + ':' + fs.statSync(r).mtimeMs; } catch { return r + ':0'; } }).join('|');
}

/**
 * What is actually on this machine's disk right now — independent of the engine.
 * @returns {{ok:true, roots:string[], models:{id,bytes,files,dirs,readOnly,partial,link}[]}}
 */
function localModels() {
  const now = Date.now();
  const roots = modelRoots();
  const sig = rootsSig(roots);
  if (diskMemo.val && diskMemo.sig === sig && now - diskMemo.at < DISK_TTL) return diskMemo.val;
  const ro = colonDirs('EXO_MODELS_READ_ONLY_DIRS');
  const byId = new Map();
  for (const root of roots) {
    let names; try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (RESERVED.has(name) || name.startsWith('.')) continue;
      const dir = path.join(root, name);
      let ls; try { ls = fs.lstatSync(dir); } catch { continue; }
      const id = name.includes('--') ? name.replace('--', '/') : name;
      const row = byId.get(id) || { id, bytes: 0, files: 0, dirs: [], readOnly: false, partial: false, link: false };
      // A symlinked model tree is not this machine's to free: removing the link frees
      // nothing, and reporting its size as freed is a fabrication.
      if (ls.isSymbolicLink()) {
        if (!isDir(dir)) continue;
        row.dirs.push(tilde(dir)); row.readOnly = true; row.link = true;
        byId.set(id, row);
        continue;
      }
      if (!ls.isDirectory()) continue;
      const stats = dirStats(dir);
      if (!looksLikeModel(name, stats)) continue;
      row.bytes += stats.bytes; row.files += stats.files; row.dirs.push(tilde(dir));
      if (stats.partial) row.partial = true;
      if (ro.includes(root)) row.readOnly = true;
      byId.set(id, row);
    }
  }
  const val = { ok: true, roots: roots.map(tilde), models: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) };
  diskMemo = { at: now, val };
  return val;
}

/**
 * Ask the engine to forget a model, then WAIT for its own removal to finish.
 *
 * The wait is not politeness. exo's delete_model walks the same directories with
 * shutil.rmtree(ignore_errors=False); deleting one out from under it raises
 * FileNotFoundError inside the engine and takes the whole daemon down — observed on
 * 2026-07-29, engine gone mid-delete. So the bridge never touches a path the engine
 * is still working on: it watches until progress stops, and only then sweeps.
 *
 * Scope: the LOCAL node only, unless allNodes is set. A button that says "this
 * machine" must not erase the weights on every Mac in the cluster.
 *
 * @param {string[]} watch — local paths the engine is expected to remove
 */
async function engineForget(modelId, watch = [], opts = {}) {
  const state = await engineJson('/state', 2500);
  if (!state) {
    // No answer is not the same as no engine. A wedged engine still holds the weights
    // open, and deleting under it is exactly the crash above. Attribute the silence:
    // an engine we can still name — ours by pidfile, or exo's own locked pidfile — is
    // alive and must be left alone. An unattributable silence is an absent engine.
    const rec = readPid();
    const ep = exoPid();
    const alive = await apiUp(1200)
      || (rec !== null && await pidIsEngine(rec))
      || (ep !== null && pidAlive(ep));
    return { reached: false, alive, known: false, nodes: 0, instances: 0, settled: false };
  }
  const dl = await engineJson('/models?status=downloaded', 2000);
  const known = !!dl && (dl.data || dl || []).some((m) => m && m.id === modelId);

  // Instance teardown stays cluster-wide: an instance may be sharded across nodes and
  // must come down as a whole before any node's weights go away.
  let instances = 0;
  for (const iid in (state.instances || {})) {
    const inner = state.instances[iid][Object.keys(state.instances[iid])[0]] || {};
    if ((inner.shardAssignments || {}).modelId !== modelId) continue;
    try {
      const r = await fetch(API + '/instance/' + encodeURIComponent(iid), { method: 'DELETE', signal: AbortSignal.timeout(4000) });
      if (r.ok) instances++;
    } catch { /* the disk sweep still runs */ }
  }

  const me = await engineJson('/node_id', 1500);           // a bare JSON string
  const all = Object.keys(state.downloads || {});
  const targets = opts.allNodes ? all : (typeof me === 'string' && me ? [me] : []);
  let nodes = 0;
  for (const nid of targets) {
    try {
      await fetch(API + '/download/cancel', {
        method: 'POST', signal: AbortSignal.timeout(4000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetNodeId: nid, modelId }),
      });
      // model ids carry a "/" — the engine's route takes them as a raw path segment
      const r = await fetch(API + '/download/' + encodeURIComponent(nid) + '/' + modelId, { method: 'DELETE', signal: AbortSignal.timeout(4000) });
      if (r.ok) nodes++;
    } catch { /* same */ }
  }

  // Progress-based, not wall-clock: a 40GB tree that is actively shrinking is never
  // cut off, and a tree nobody is touching is released after a short idle window.
  let settled = watch.length === 0;
  let lastSize = -1, idle = 0;
  for (let i = 0; i < 240 && !settled; i++) {
    await sleep(250);
    const live = watch.filter((p) => fs.existsSync(p));
    if (!live.length) { settled = true; break; }
    const size = live.reduce((a, p) => a + dirStats(p).bytes, 0);
    if (size !== lastSize) { lastSize = size; idle = 0; } else if (++idle >= 24) break; // 6s with no progress
  }
  return { reached: true, alive: true, known, nodes, instances, settled, scope: opts.allNodes ? 'cluster' : 'machine' };
}

/**
 * Remove a local model completely: its instance, its transfer, its weights, its
 * metadata cache, any Hugging Face copy, and its entry in the model registry.
 * Works with the engine down — that path is the whole point.
 *
 * @param {string} modelId
 * @param {{allNodes?:boolean}} opts — allNodes: also tell every other node to drop it
 */
async function purgeModel(modelId, opts = {}) {
  if (!Permissions.can('matrix')) return { ok: false, error: 'matrix permission is off' };
  const id = String(modelId || '').trim();
  if (!MODEL_ID.test(id)) return { ok: false, error: 'invalid model id' };
  const norm = id.replace(/\//g, '--');
  if (RESERVED.has(norm) || norm.startsWith('.')) return { ok: false, error: 'invalid model id' };

  // Positive membership: only something the scanner itself calls a model can be
  // deleted. Without this, any directory name that survives the regex became a path.
  invalidateDisk();
  const local = localModels().models.find((m) => m.id === id);
  if (!local) {
    const dl = await engineJson('/models?status=downloaded', 2000);
    const engineHasIt = !!dl && (dl.data || dl || []).some((m) => m && m.id === id);
    if (!engineHasIt) return { ok: true, freed: 0, removed: [], errors: [], notFound: true, registry: await syncModels() };
  }
  if (local && local.link) {
    return { ok: false, freed: 0, removed: [], readOnly: true, errors: [],
      error: id + ' is a link to weights stored elsewhere — remove it where it really lives' };
  }

  const roots = modelRoots();
  const readOnly = colonDirs('EXO_MODELS_READ_ONLY_DIRS');
  const targets = [];
  for (const root of roots) {
    if (readOnly.includes(root)) continue; // the engine never deletes from these; neither do we
    targets.push(path.join(root, norm), path.join(root, 'caches', norm));
  }
  // exo downloads into its own tree, but a tokenizer pulled through transformers/mlx
  // lands in the shared Hugging Face cache. Left behind, that is exactly the leftover
  // this function promises not to leave — and it is named in `removed`, never silent.
  if (isDir(HF_HUB)) targets.push(path.join(HF_HUB, 'models--' + norm), path.join(HF_HUB, '.locks', 'models--' + norm));

  // Measure BEFORE asking the engine to forget: when the engine wins the race it
  // deletes the weights itself, and a size read afterwards reported ~1KB for a 5MB
  // model. What we report has to be what actually left the machine, whoever removed it.
  const allowed = [...roots, HF_HUB];
  const planned = [];
  for (const t of targets) {
    const abs = path.resolve(t);
    // Belt: after resolution the path must still sit strictly inside a known root, its
    // own name must be the one we derived from the id, and it must not be a link.
    if (!allowed.some((r) => abs.startsWith(r + path.sep))) continue;
    if (path.basename(abs) !== norm && path.basename(abs) !== 'models--' + norm) continue;
    let ls; try { ls = fs.lstatSync(abs); } catch { continue; }
    if (ls.isSymbolicLink()) { planned.push({ abs, bytes: 0, link: true }); continue; }
    planned.push({ abs, bytes: dirStats(abs).bytes });
  }
  if (!planned.length) {
    // Everything this model has on disk sits in a read-only root, so nothing here can
    // remove it. Saying "deleted" would be the lie the old code told.
    if (local && local.readOnly) {
      return { ok: false, freed: 0, removed: [], readOnly: true, errors: [],
        error: id + ' lives in a read-only models directory (EXO_MODELS_READ_ONLY_DIRS) — the engine never deletes from it, and neither does MATRIX' };
    }
  }

  // The engine owns the model directories it created; the Hugging Face cache it never
  // touches. Watch only the former, so we wait for exactly what it is removing.
  const engine = await engineForget(id, planned.map((p) => p.abs).filter((a) => !a.startsWith(HF_HUB + path.sep)), opts);
  if (engine.alive && !engine.reached) {
    return { ok: false, freed: 0, removed: [], errors: [],
      error: 'the engine is running but did not answer — stop it from the MATRIX rail before deleting, so its files are not pulled out from under it', engine };
  }

  const removed = [], errors = [];
  let freed = 0;
  for (const { abs, bytes } of planned) {
    if (fs.existsSync(abs)) {
      try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e) { errors.push(tilde(abs) + ': ' + (e.message || e)); continue; }
      if (fs.existsSync(abs)) { errors.push(tilde(abs) + ': still there after removal'); continue; }
    }
    removed.push({ path: tilde(abs), bytes });
    freed += bytes;
  }

  invalidateDisk();
  const stillOnDisk = localModels().models.some((m) => m.id === id);
  const registry = await syncModels();
  return { ok: errors.length === 0 && !stillOnDisk, freed, removed, errors, stillOnDisk, engine, registry };
}

/**
 * Reconcile the MATRIX provider's model list in the models registry, so CODE · LAB ·
 * Brain · Harness offer exactly the local models that can answer.
 *
 * Two witnesses, union, never a replacement. The engine's list is its event-log
 * replay — the very source this module exists to stop trusting on its own — and the
 * disk is what the owner actually has. A model is dropped only when BOTH say it is
 * gone, and a default is cleared only on an authoritative answer. Earlier versions
 * emptied every picker on a single 3s timeout, and again on an engine that answered
 * with [] during the seconds after it booted.
 *
 * Deliberately NOT behind the matrix permission: it creates nothing without `ensure`,
 * reads only local sources, and its whole job is to keep the pickers honest — gating
 * it would leave a user with an external engine unable to see their own models.
 *
 * @param {{ensure?:boolean}} opts — ensure: create the provider if it is not registered
 */
async function syncModels(opts = {}) {
  let Models;
  try { ({ Models } = await import('./models.mjs')); } catch (e) { return { ok: false, error: 'models module off: ' + (e.message || e) }; }
  // Match on the field the chat relay keys off, oldest first, so a user-added local
  // provider on the same port can never steal the sync from the real MATRIX record.
  const find = () => Models.listProviders().filter((p) => p.provider === 'matrix')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0] || null;
  let prov = find();
  if (!prov && opts.ensure) {
    const r = Models.addProvider({ kind: 'local', provider: 'matrix', label: 'MATRIX Cluster', baseUrl: API + '/v1' });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'could not register the cluster' };
    prov = find();
  }
  if (!prov) return { ok: true, registered: false, models: [] };

  const dl = await engineJson('/models?status=downloaded');
  const engineIds = dl ? [...new Set((dl.data || dl || []).map((m) => m && m.id).filter(Boolean))] : null;
  const disk = new Set(localModels().models.filter((m) => !m.partial).map((m) => m.id));
  const before = (prov.models || []).slice().sort();

  let next;
  if (engineIds !== null) {
    next = [...new Set([...engineIds, ...disk])].sort();
  } else {
    // Engine down: keep what is still here. Never shrink to empty off a disk walk
    // alone — an unreadable root would otherwise clear every picker.
    const trimmed = before.filter((m) => disk.has(m));
    next = trimmed.length || !before.length ? trimmed : before;
  }

  const changed = next.length !== before.length || next.some((m, i) => m !== before[i]);
  if (changed) {
    const r = Models.setModels(prov.id, next);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'could not update the model list' };
  }
  // A default pointing at a model that is gone answers nothing. Clear it only on an
  // authoritative answer AND only when the disk agrees — an engine that has not
  // finished scanning must not cost the owner their chosen model.
  let cleared = 0;
  if (engineIds !== null) {
    const defs = Models.getDefaults();
    for (const cap of Object.keys(defs)) {
      const d = defs[cap];
      if (d && d.providerId === prov.id && !next.includes(d.model) && !disk.has(d.model)) {
        Models.setDefault(cap, { providerId: null }); cleared++;
      }
    }
  }
  const off = new Set(prov.disabledModels || []);
  return {
    ok: true, registered: true, id: prov.id, models: next, changed, cleared,
    engine: engineIds !== null,
    enabled: prov.enabled !== false,
    // What the pickers will really show: a disabled provider offers nothing, and a
    // disabled model is listed but never offered.
    offered: prov.enabled === false ? 0 : next.filter((m) => !off.has(m)).length,
  };
}

export const Matrix = { status, start, stop, logs, setEnginePath, localModels, purgeModel, syncModels };
export default Matrix;
