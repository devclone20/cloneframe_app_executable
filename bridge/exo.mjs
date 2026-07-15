// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — exo (LAB inference-cluster lifecycle + bounded data-plane)
// Adapted control-plane for exo (github.com/exo-explore/exo), Apache-2.0 — used
// unmodified via its CLI. exo lives in its own integration folder: the upstream
// source is cloned into integrations/exo/src and built into integrations/exo/.venv
// (see integrations/exo/install.sh), keeping its upstream LICENSE + NOTICE intact
// (Apache-2.0 §4); we only spawn its published CLI and proxy its loopback HTTP API.
// A pre-existing /Applications/exo.app is adopted as a fallback when not bundled.
//
// THE BOUNDARY: the browser NEVER opens :52415. It speaks only POST /mod/exo
// {fn,args} → getMod('exo')[fn](...args). This module owns the exo process on
// disk (detect/status/install/update/launch/stop/logs) and is the ONLY hop
// allowed to fetch exo's data-plane (api() — allowlisted paths, loopback only).
//
// SECURITY: command execution is spawn(argv, {shell:false}) only — no shell, no
// string interpolation. api() is a fixed allowlist over a fixed loopback origin
// (no SSRF surface). An already-reachable exo is ADOPTED, never double-spawned,
// and an externally-managed exo is never killed. Zero deps: node built-ins +
// global fetch. Every exported method is wrapped and never throws.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(BRIDGE_DIR); // the clone-frame-hub app root (parent of bridge/)
const PORT = 52415;
const HOST = '127.0.0.1'; // exo binds 0.0.0.0; the HUB only ever connects to loopback

// Server-only (underscore ⇒ auto-rejected by handleMod): resolves every on-disk path.
// exo lives in its OWN integration folder: integrations/exo/{src (upstream), .venv (runtime)}.
function _config() {
  const EXO_HOME = path.join(ROOT, 'integrations', 'exo');
  const EXO_DIR = path.join(EXO_HOME, 'src'); // upstream exo repo (pip install -e)
  return {
    ROOT,
    EXO_HOME,
    EXO_DIR,
    INSTALL_SH: path.join(EXO_HOME, 'install.sh'),
    VENV_BIN: path.join(EXO_HOME, '.venv', 'bin', 'exo'),
    PIP_BIN: path.join(EXO_HOME, '.venv', 'bin', 'pip'),
    LOG: path.join(EXO_HOME, '.exo.log'),
    PIDFILE: path.join(EXO_HOME, '.exo.pid'),
    PORT,
    HOST,
  };
}

// ── small helpers ────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _readPid() {
  try {
    const n = parseInt(String(fs.readFileSync(_config().PIDFILE, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}
// signal 0 = liveness probe, kills nothing.
function _alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

// Capture a short-lived command's output; never rejects (version/gitSha probes).
function _capture(file, args, { cwd = ROOT, timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    let out = '', done = false, child;
    try { child = spawn(file, args, { shell: false, windowsHide: true, cwd }); }
    catch { resolve({ code: -1, out: '' }); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out }); };
    const grab = (d) => { if (out.length < 8192) out += d.toString('utf8'); };
    if (child.stdout) child.stdout.on('data', grab);
    if (child.stderr) child.stderr.on('data', grab);
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code == null ? -1 : code));
  });
}

async function _gitSha() {
  const { code, out } = await _capture('git', ['-C', _config().EXO_DIR, 'rev-parse', '--short', 'HEAD'], { timeout: 3000 });
  return code === 0 ? out.trim() || null : null;
}
async function _version() {
  const C = _config();
  if (!fs.existsSync(C.VENV_BIN)) return null;
  const { code, out } = await _capture(C.VENV_BIN, ['--version'], { cwd: C.EXO_DIR, timeout: 5000 });
  return code === 0 ? out.trim() || null : null;
}

// ── loopback data-plane fetch (the ONLY code allowed to touch :52415) ─────────
async function _fetchExo(method, p, body, timeoutMs) {
  const C = _config();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch('http://' + C.HOST + ':' + C.PORT + p, {
      method,
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } finally { clearTimeout(t); }
}
async function _reachable(timeoutMs = 1500) {
  try { const r = await _fetchExo('GET', '/models', null, timeoutMs); return !!(r && r.ok); }
  catch { return false; }
}
async function _pollReachable(waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  if (await _reachable(1500)) return true;
  while (Date.now() < deadline) { await _sleep(750); if (await _reachable(1500)) return true; }
  return false;
}
async function _waitExit(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!_alive(pid)) return true; await _sleep(150); }
  return !_alive(pid);
}

// ── api() allowlist ──────────────────────────────────────────────────────────
// A fixed set of exo data-plane routes over a fixed loopback origin. The strict
// charset (no '@', no '..', no scheme) plus prefix match closes the SSRF surface.
const _READ = new Set(['/state', '/models', '/v1/models']);
function _allow(method, p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) return false;
  if (!/^\/[A-Za-z0-9/_.?=&-]*$/.test(p)) return false;
  const pathOnly = p.split('?')[0];
  if (pathOnly.includes('..')) return false;
  if (method === 'GET') {
    if (_READ.has(pathOnly)) return true;
    if (pathOnly === '/instance' || pathOnly === '/instance/placement') return true;
    return pathOnly.startsWith('/instance/');
  }
  if (method === 'POST') return pathOnly === '/instance' || pathOnly === '/instance/placement';
  if (method === 'DELETE') {
    if (!pathOnly.startsWith('/instance/')) return false;
    const id = pathOnly.slice('/instance/'.length);
    return id.length > 0 && !id.includes('/'); // exactly DELETE /instance/:id
  }
  return false;
}

// ── detached install/update jobs (single in-memory lock, teed to .exo.log) ────
let jobState = { running: false, kind: null, jobId: null, startedAt: 0 };

function _step(logStream, file, args, opts = {}) {
  return new Promise((resolve) => {
    logStream.write('\n$ ' + file + ' ' + args.join(' ') + '\n');
    let child;
    try { child = spawn(file, args, { shell: false, windowsHide: true, cwd: opts.cwd || ROOT }); }
    catch (e) { logStream.write('spawn error: ' + e.message + '\n'); resolve(-1); return; }
    if (child.stdout) child.stdout.pipe(logStream, { end: false });
    if (child.stderr) child.stderr.pipe(logStream, { end: false });
    child.on('error', (e) => { logStream.write('error: ' + e.message + '\n'); resolve(-1); });
    child.on('close', (code) => resolve(code == null ? -1 : code));
  });
}

// Runs `task(logStream)` detached from the RPC; returns {ok,jobId} immediately.
function _runJob(kind, task) {
  if (jobState.running) return { ok: false, error: 'a ' + jobState.kind + ' job is already running', jobId: jobState.jobId };
  const jobId = randomBytes(6).toString('hex');
  jobState = { running: true, kind, jobId, startedAt: Date.now() };
  (async () => {
    let logStream = null;
    try {
      fs.mkdirSync(_config().EXO_DIR, { recursive: true });
      logStream = fs.createWriteStream(_config().LOG, { flags: 'a' });
      logStream.on('error', () => {}); // never let a log write crash the daemon
      logStream.write('\n[' + kind + '] job ' + jobId + ' started ' + new Date().toISOString() + '\n');
      await task(logStream);
      logStream.write('\n[' + kind + '] job ' + jobId + ' finished\n');
    } catch (e) {
      try { if (logStream) logStream.write('\n[' + kind + '] job ' + jobId + ' error: ' + String(e && e.message || e) + '\n'); } catch {}
    } finally {
      try { if (logStream) logStream.end(); } catch {}
      jobState = { running: false, kind: null, jobId: null, startedAt: 0 };
    }
  })();
  return { ok: true, jobId };
}

// ── public control-plane (every fn wrapped, never throws) ─────────────────────
// The exo desktop app (github.com/exo-explore/exo) as shipped for macOS — a valid,
// already-present install. If found we LAUNCH it (no download) instead of the venv path.
const _APP_CANDIDATES = ['/Applications/exo.app', (process.env.HOME || '') + '/Applications/exo.app'];
function _appPath() { for (const p of _APP_CANDIDATES) { try { if (p && fs.existsSync(p)) return p; } catch {} } return null; }

async function detect() {
  try {
    const C = _config();
    const app = _appPath();
    const venvBin = fs.existsSync(C.VENV_BIN);
    const installed = venvBin || !!app;
    const venv = fs.existsSync(path.join(C.EXO_HOME, '.venv'));   // built runtime in the integration folder
    const submodule = fs.existsSync(path.join(C.EXO_DIR, '.git')); // upstream source cloned into src/
    const reachable = await _reachable(1500);
    const externallyManaged = (reachable && !_alive(_readPid())) || (!venvBin && !!app);
    return { installed, appPath: app || null, binaryPath: venvBin ? C.VENV_BIN : (app || null), venv, submodule, externallyManaged };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function status() {
  try {
    const C = _config();
    const app = _appPath();
    const venvBin = fs.existsSync(C.VENV_BIN);
    const installed = venvBin || !!app;
    const pid = _readPid();
    const running = _alive(pid);
    const reachable = await _reachable(1500);
    const externallyManaged = (reachable && !running) || (!venvBin && !!app); // the app / an unmanaged exo
    const [gitSha, version] = await Promise.all([_gitSha(), _version()]);
    return { installed, appPath: app || null, running, pid: running ? pid : null, port: C.PORT, reachable, version, gitSha, externallyManaged };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Installs exo INTO its own folder (integrations/exo/: src/ + .venv/) by running that
// integration's own install.sh — the single source of truth (clone, not submodule, so
// it works even though clone-frame-hub isn't its own git repo). Detached; poll logs().
function install() {
  try {
    return _runJob('install', async (logStream) => {
      const C = _config();
      await _step(logStream, 'zsh', [C.INSTALL_SH]);
    });
  } catch (e) { return { ok: false, error: e.message }; }
}

// git pull + reinstall; if exo was running, restart it. Detached; poll logs().
function update() {
  try {
    return _runJob('update', async (logStream) => {
      const C = _config();
      const wasRunning = _alive(_readPid());
      const c1 = await _step(logStream, 'git', ['-C', C.EXO_DIR, 'pull', '--ff-only']);
      if (c1 !== 0) return;
      const c2 = await _step(logStream, C.PIP_BIN, ['install', '-e', C.EXO_DIR]);
      if (c2 !== 0) return;
      if (wasRunning) { logStream.write('\n[update] restarting exo\n'); await stop(); await launch(); }
    });
  } catch (e) { return { ok: false, error: e.message }; }
}

async function launch(opts = {}) {
  try {
    const C = _config();
    const port = Number(opts.port) || C.PORT;
    const waitMs = Number(opts.waitMs) || 20000;

    // Never double-spawn: a reachable exo is adopted (ours ⇒ managed, else external).
    if (await _reachable(1500)) {
      const pid = _readPid();
      const ours = _alive(pid);
      return { ok: true, adopted: true, reachable: true, pid: ours ? pid : null, externallyManaged: !ours };
    }
    if (!fs.existsSync(C.VENV_BIN)) {
      // No bundled venv — but if the exo desktop app is present, launch IT (it starts the :52415 server).
      const app = _appPath();
      if (app) {
        try {
          const opener = spawn('open', ['-g', app], { detached: true, stdio: 'ignore' });
          opener.on('error', () => {});
          opener.unref();
        } catch (e) { return { ok: false, error: 'could not open exo.app: ' + e.message }; }
        const reachable = await _pollReachable(waitMs);
        return { ok: reachable, reachable, adopted: false, viaApp: true, externallyManaged: true };
      }
      return { ok: false, error: 'exo not installed — run install() first' };
    }

    fs.mkdirSync(C.EXO_DIR, { recursive: true });
    let logFd;
    try { logFd = fs.openSync(C.LOG, 'a'); } catch (e) { return { ok: false, error: 'cannot open log: ' + e.message }; }
    let child;
    try {
      // Own process group (detached) so stop() can reap the whole MLX worker tree.
      child = spawn(C.VENV_BIN, ['--chatgpt-api-port', String(port), '--disable-tui'], {
        cwd: C.EXO_DIR, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
      });
    } catch (e) { try { fs.closeSync(logFd); } catch {} return { ok: false, error: 'spawn failed: ' + e.message }; }
    try { fs.closeSync(logFd); } catch {}
    if (!child.pid) return { ok: false, error: 'exo did not start' };
    child.unref();
    try { fs.writeFileSync(C.PIDFILE, String(child.pid), { mode: 0o600 }); } catch {}

    const reachable = await _pollReachable(waitMs);
    return { ok: reachable, pid: child.pid, reachable, adopted: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function stop() {
  try {
    const C = _config();
    const pid = _readPid();
    const ours = _alive(pid);
    if (!ours) {
      // Refuse to kill an exo we did not start (manually launched / another service).
      if (await _reachable(1500)) return { ok: false, reason: 'externally managed', stopped: false };
      try { if (fs.existsSync(C.PIDFILE)) fs.unlinkSync(C.PIDFILE); } catch {}
      return { ok: true, stopped: false, note: 'not running' };
    }
    const killGroup = (sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } };
    killGroup('SIGTERM');
    if (!(await _waitExit(pid, 3000))) killGroup('SIGKILL');
    try { fs.unlinkSync(C.PIDFILE); } catch {}
    return { ok: true, stopped: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Incremental tail for the LAB log console — poll with the returned `size` as sinceByte.
function logs({ sinceByte = 0, maxBytes = 65536 } = {}) {
  try {
    const C = _config();
    let size = 0;
    try { size = fs.statSync(C.LOG).size; } catch { return { text: '', size: 0, running: _alive(_readPid()) }; }
    const cap = Number(maxBytes) || 65536;
    const start = Math.max(0, Math.max(Number(sinceByte) || 0, size - cap));
    let text = '';
    if (size > start) {
      const fd = fs.openSync(C.LOG, 'r');
      try {
        const len = size - start;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, start);
        text = buf.subarray(0, read).toString('utf8');
      } finally { fs.closeSync(fd); }
    }
    return { text, size, running: _alive(_readPid()) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// The proxied data-plane. Returns parsed JSON on 2xx, else null — the front-end
// treats null as 'offline' and degrades exactly as it does today. NEVER throws.
async function api(method, p, body = null) {
  try {
    const m = String(method || 'GET').toUpperCase();
    if (!_allow(m, String(p || ''))) return null;
    const r = await _fetchExo(m, String(p), m === 'POST' ? body : null, 3000);
    if (!r || !r.ok) return null;
    const text = await r.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

export const Exo = { detect, status, install, update, launch, stop, logs, api };
export default Exo;
