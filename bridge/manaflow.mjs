// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — Manaflow (agent-workflow tool) lifecycle control-plane
// Adapted control-plane for Manaflow / cmux (github.com/manaflow-ai/manaflow), MIT —
// run unmodified from source. Manaflow lives in its own integration folder: the
// upstream is cloned into integrations/manaflow/src and its Bun deps installed there
// (see integrations/manaflow/install.sh), keeping the upstream LICENSE intact.
//
// UNLIKE exo, Manaflow is NOT a single self-contained local server: it is a Bun
// monorepo of ~5 services (Vite client :5173 · server :9776 · www :9779 · self-hosted
// Convex :9777) that needs Docker running and a (free) Stack Auth cloud project. So
// this module also REPORTS PREREQUISITES (bun/docker/src/.env) so the UI can guide
// setup instead of failing silently. The web UI (:5173) has no X-Frame-Options, so it
// embeds in the INTEGRATIONS tab like exo; the auth flow has a top-level fallback.
//
// THE BOUNDARY: the browser NEVER opens :5173 via fetch. It speaks only POST /mod/
// manaflow {fn,args} → getMod('manaflow')[fn](...). The only Manaflow-origin contact
// is the <iframe> src (a browsing-context navigation, allowed — cross-origin, cannot
// read the HUB token). SECURITY: every spawn is spawn(argv,{shell:false}) — no shell,
// no interpolation. Zero deps: node built-ins + global fetch. Every export is wrapped
// and never throws. A reachable Manaflow is ADOPTED, never double-spawned.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(BRIDGE_DIR); // the clone-frame-hub app root (parent of bridge/)
const PORT = 5173;                     // Manaflow's Vite web-client port (verified from scripts/dev.sh)
const HOST = '127.0.0.1';

// Server-only (underscore ⇒ auto-rejected by handleMod): resolves every on-disk path.
function _config() {
  const HOME = path.join(ROOT, 'integrations', 'manaflow');
  return {
    ROOT, HOME,
    SRC: path.join(HOME, 'src'),                 // upstream monorepo (cloned by install.sh)
    INSTALL_SH: path.join(HOME, 'install.sh'),
    DEV_SH: path.join(HOME, 'src', 'scripts', 'dev.sh'),
    ENV: path.join(HOME, 'src', '.env'),
    LOG: path.join(HOME, '.manaflow.log'),
    PIDFILE: path.join(HOME, '.manaflow.pid'),
    CONVEX_PIDFILE: path.join(HOME, '.convex.pid'),
    CONVEX_SETUP_SH: path.join(HOME, 'convex-setup.sh'),
    CONVEX_LOCAL_ENV: path.join(HOME, 'src', 'packages', 'convex', '.env.local'),
    CONVEX_MARKER: path.join(HOME, '.convex-bootstrapped'),
    PORT, HOST,
  };
}

// ── tiny helpers (mirrors exo.mjs) ───────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _readPid() { try { const s = fs.readFileSync(_config().PIDFILE, 'utf8').trim(); const n = parseInt(s, 10); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; } }
function _alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
// Resolve a binary PATH-independently (GUI launches have a minimal PATH): check known
// install dirs first, then fall back to the real `which` executable.
const _HOME = process.env.HOME || '';
const _BIN_PATHS = {
  bun: [_HOME + '/.bun/bin/bun', '/opt/homebrew/bin/bun', '/usr/local/bin/bun'],
  docker: ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker'],
  // dev.sh is a bash script (#!/bin/bash — uses set -m, export -f, BASH_SOURCE, arrays).
  // Prefer a modern Homebrew bash, fall back to the macOS system bash (3.2, sufficient here).
  bash: ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash'],
};
function _binPath(bin) { for (const p of (_BIN_PATHS[bin] || [])) { try { if (p && fs.existsSync(p)) return p; } catch {} } return null; }
function _which(bin) {
  if (_binPath(bin)) return Promise.resolve(true);
  return new Promise((res) => { let c; try { c = spawn('/usr/bin/which', [bin], { shell: false }); } catch { return res(false); } c.on('error', () => res(false)); c.on('close', (code) => res(code === 0)); });
}

// Convex's `"use node"` actions require a SUPPORTED Node.js (18/20/22/24). The system
// node may be too new (e.g. v26). Find a keg-only Homebrew LTS node and prefer it so
// `node` resolves to a version convex accepts. Returns its bin dir or null.
const _NODE_COMPAT_DIRS = [
  '/opt/homebrew/opt/node@22/bin', '/opt/homebrew/opt/node@24/bin',
  '/opt/homebrew/opt/node@20/bin', '/opt/homebrew/opt/node@18/bin',
  '/usr/local/opt/node@22/bin', '/usr/local/opt/node@24/bin',
];
function _nodeCompatDir() { for (const d of _NODE_COMPAT_DIRS) { try { if (fs.existsSync(d + '/node')) return d; } catch {} } return null; }

// dev.sh calls `bun`/`bunx`, the N-API build needs the Rust toolchain, and convex needs a
// supported node — but a GUI-launched bridge inherits a minimal PATH (no ~/.bun/bin, no
// ~/.cargo/bin, no keg node). Build a spawn env whose PATH is prepended with the dirs those
// tools actually live in, so "Launch" works regardless of how the bridge was started.
function _augmentedEnv(extra = {}) {
  const bunBin = _binPath('bun');
  const dirs = [];
  const nodeDir = _nodeCompatDir();
  if (nodeDir) dirs.push(nodeDir);                        // supported node@22/24 FIRST (before v26 in /opt/homebrew/bin)
  if (bunBin) dirs.push(path.dirname(bunBin));           // ~/.bun/bin
  dirs.push(_HOME + '/.cargo/bin');                        // rustc/cargo for @napi-rs/cli build
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  const seen = new Set();
  const prefix = dirs.filter((d) => d && !seen.has(d) && (seen.add(d), true));
  const cur = process.env.PATH || '';
  const PATH = prefix.join(':') + (cur ? ':' + cur : '');
  return { ...process.env, PATH, ...extra };
}

// capture argv output (no shell); resolves {code,out}
function _capture(file, args, opts = {}) {
  return new Promise((resolve) => {
    let child, out = '';
    const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch {} resolve({ code: -1, out }); }, opts.timeout || 6000);
    try { child = spawn(file, args, { shell: false, windowsHide: true, cwd: opts.cwd }); }
    catch (e) { clearTimeout(timer); resolve({ code: -1, out: String(e && e.message || e) }); return; }
    if (child.stdout) child.stdout.on('data', (d) => { out += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, out }); });
  });
}

// ── loopback readiness probe (Manaflow analogue of exo's GET /models) ─────────
async function _fetchMana(pathname, timeoutMs = 1500) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch('http://' + HOST + ':' + PORT + pathname, { signal: ctl.signal, redirect: 'manual' }); clearTimeout(to); return r; }
  catch (e) { clearTimeout(to); return null; }
}
async function _reachable(timeoutMs = 1500) {
  // any HTTP response from the Vite client (200 or a redirect to /sign-in) means it's up
  try { const r = await _fetchMana('/', timeoutMs); return !!(r && r.status > 0); } catch { return false; }
}
async function _pollReachable(waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  if (await _reachable(1500)) return true;
  while (Date.now() < deadline) { await _sleep(1200); if (await _reachable(1500)) return true; }
  return false;
}

// ── detached install/launch jobs (single in-memory lock, teed to .manaflow.log) ─
let jobState = { running: false, kind: null, jobId: null, startedAt: 0 };
function _step(logStream, file, args, opts = {}) {
  return new Promise((resolve) => {
    logStream.write('\n$ ' + file + ' ' + args.join(' ') + '\n');
    let child;
    try { child = spawn(file, args, { shell: false, windowsHide: true, cwd: opts.cwd || _config().HOME, env: opts.env || process.env }); }
    catch (e) { logStream.write('spawn error: ' + e.message + '\n'); resolve(-1); return; }
    if (child.stdout) child.stdout.pipe(logStream, { end: false });
    if (child.stderr) child.stderr.pipe(logStream, { end: false });
    child.on('error', (e) => { logStream.write('error: ' + e.message + '\n'); resolve(-1); });
    child.on('close', (code) => resolve(code == null ? -1 : code));
  });
}
function _runJob(kind, task) {
  if (jobState.running) return { ok: false, error: 'a ' + jobState.kind + ' job is already running', jobId: jobState.jobId };
  const jobId = randomBytes(6).toString('hex');
  jobState = { running: true, kind, jobId, startedAt: Date.now() };
  (async () => {
    let logStream = null;
    try {
      fs.mkdirSync(_config().HOME, { recursive: true });
      logStream = fs.createWriteStream(_config().LOG, { flags: 'a' });
      logStream.on('error', () => {});
      logStream.write('\n[' + kind + '] job ' + jobId + ' started ' + new Date().toISOString() + '\n');
      await task(logStream);
      logStream.write('\n[' + kind + '] job ' + jobId + ' finished\n');
    } catch (e) { try { if (logStream) logStream.write('\n[' + kind + '] error: ' + String(e && e.message || e) + '\n'); } catch {} }
    finally { try { if (logStream) logStream.end(); } catch {} jobState = { running: false, kind: null, jobId: null, startedAt: 0 }; }
  })();
  return { ok: true, jobId };
}

// ── prereq flags (BOOLEANS ONLY — never read/return the secret values) ────────
function _envText() { try { return fs.readFileSync(_config().ENV, 'utf8'); } catch { return ''; } }
function _envFlags() {
  // Parse real KEY=VALUE lines only — skip comments/blanks, strip quotes, ignore the
  // '…' placeholder. (A regex over the whole file wrongly matches commented example lines.)
  const vals = {};
  for (const line of _envText().split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/);
    if (m) { const v = m[2].trim().replace(/^["']|["']$/g, ''); if (v && v !== '…') vals[m[1]] = v; }
  }
  const has = (k) => !!(vals[k] || vals['NEXT_PUBLIC_' + k]);
  return {
    stackOk: has('STACK_PROJECT_ID') && has('STACK_PUBLISHABLE_CLIENT_KEY') && has('STACK_SECRET_SERVER_KEY'),
    convexOk: /^https?:\/\//.test(vals.CONVEX_URL || vals.NEXT_PUBLIC_CONVEX_URL || vals.CONVEX_SELF_HOSTED_URL || ''),
  };
}
// No-Docker Convex: the standalone convex-local-backend binary (Rust, no Docker),
// bundled into the source tree by install.sh — lets Manaflow run its DB WITHOUT Docker.
function _convexLocalBin() {
  const C = _config();
  const cands = [
    path.join(C.SRC, 'packages', 'cmux', 'src', 'convex', 'convex-bundle', 'convex-local-backend'),
    path.join(C.SRC, 'packages', 'convex', 'convex-local-backend'),
    path.join(C.HOME, 'convex-local-backend'),
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}
async function _dockerOk() {
  const has = await _which('docker'); if (!has) return false;
  const r = await _capture(_binPath('docker') || 'docker', ['info'], { timeout: 4000 }); return r.code === 0;
}

// ── public surface (mirrors exo: detect/status/install/launch/stop/logs) ──────
// Prereqs to START (no Docker): bun + a Convex URL (local binary or cloud) + Stack Auth
// keys. Docker is OPTIONAL — only for running agents in local sandboxes.
async function detect() {
  try {
    const C = _config();
    const srcPresent = fs.existsSync(path.join(C.SRC, '.git'));
    const nodeModules = fs.existsSync(path.join(C.SRC, 'node_modules'));
    const installed = srcPresent && nodeModules;
    const [bunOk, dockerOk] = await Promise.all([_which('bun'), _dockerOk()]);
    const { stackOk, convexOk } = _envFlags();
    const convexLocal = !!_convexLocalBin();
    return { installed, srcPresent, nodeModules, bunOk, convexOk, convexLocal, stackOk, dockerOk };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function status() {
  try {
    const C = _config();
    const srcPresent = fs.existsSync(path.join(C.SRC, '.git'));
    const nodeModules = fs.existsSync(path.join(C.SRC, 'node_modules'));
    const installed = srcPresent && nodeModules;
    const pid = _readPid();
    const running = _alive(pid);
    const reachable = await _reachable(1500);
    const [bunOk, dockerOk] = await Promise.all([_which('bun'), _dockerOk()]);
    const { stackOk, convexOk } = _envFlags();
    const convexLocal = !!_convexLocalBin();
    const externallyManaged = reachable && !running;
    return { installed, running, pid: running ? pid : null, port: C.PORT, reachable, bunOk, convexOk, convexLocal, stackOk, dockerOk, externallyManaged };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Runs the integration's own install.sh (clone → src/, bun install). Detached; poll logs().
function install() {
  try { return _runJob('install', async (logStream) => { await _step(logStream, 'zsh', [_config().INSTALL_SH]); }); }
  catch (e) { return { ok: false, error: e.message }; }
}

// Starts Manaflow's dev stack (scripts/dev.sh) detached — WITHOUT Docker
// (SKIP_DOCKER_BUILD=true). If the bundled convex-local-backend binary is present it is
// started first so Convex runs locally with no Docker either. Adopts an already-reachable one.
// One-time no-Docker Convex bootstrap (configure anonymous local deployment + push its env
// + deploy functions). Runs convex-setup.sh once, gated by a marker so later launches skip it
// (dev.sh's own `bunx convex dev` handles ongoing sync). Best-effort: a failure doesn't block
// the launch — dev.sh will keep retrying the push — but success writes the marker.
function _ensureConvexBootstrapped(C, logFd) {
  return new Promise((resolve) => {
    try { if (fs.existsSync(C.CONVEX_MARKER)) return resolve({ ok: true, skipped: true }); } catch {}
    if (!fs.existsSync(C.CONVEX_SETUP_SH)) return resolve({ ok: false, reason: 'no convex-setup.sh' });
    const bashBin = _binPath('bash') || '/bin/bash';
    let child;
    try {
      child = spawn(bashBin, [C.CONVEX_SETUP_SH], { cwd: C.HOME, stdio: ['ignore', logFd, logFd], windowsHide: true, env: _augmentedEnv() });
    } catch (e) { return resolve({ ok: false, reason: e.message }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, reason: 'timeout' }); }, 240000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { try { fs.writeFileSync(C.CONVEX_MARKER, 'ok\n'); } catch {} resolve({ ok: true }); }
      else resolve({ ok: false, reason: 'exit ' + code });
    });
  });
}

async function launch(opts = {}) {
  try {
    const C = _config();
    const waitMs = Number(opts.waitMs) || 90000; // Bun monorepo + local Convex + 5 services boot slowly
    if (await _reachable(1500)) {
      const pid = _readPid(); const ours = _alive(pid);
      return { ok: true, adopted: true, reachable: true, pid: ours ? pid : null, externallyManaged: !ours };
    }
    if (!fs.existsSync(path.join(C.SRC, '.git'))) return { ok: false, error: 'manaflow not installed — run install() first' };
    if (!fs.existsSync(C.DEV_SH)) return { ok: false, error: 'scripts/dev.sh missing in source' };
    fs.mkdirSync(C.HOME, { recursive: true });
    let logFd;
    try { logFd = fs.openSync(C.LOG, 'a'); } catch (e) { return { ok: false, error: 'cannot open log: ' + e.message }; }
    // No-Docker Convex data layer: bootstrap once (idempotent, gated by marker) before dev.sh.
    await _ensureConvexBootstrapped(C, logFd);
    // Convex is owned by dev.sh's own `bunx convex dev` (anonymous LOCAL mode, port 3210),
    // configured once by install() via the convex CLI (packages/convex/.env.local). We do NOT
    // spawn the standalone convex-local-backend binary — it would bind the wrong port (3210 vs
    // the app's NEXT_PUBLIC_CONVEX_URL) and fight the CLI. The augmented PATH gives dev.sh a
    // supported node so convex's "use node" actions deploy.
    let child;
    try {
      // own process group (detached) so stop() can reap the whole tree · SKIP_DOCKER_BUILD=true ⇒ no Docker
      // MUST run under bash (dev.sh is a bash script; zsh chokes on `set -m` / `export -f`).
      // augmented PATH so dev.sh finds bun/bunx and the N-API build finds the Rust toolchain.
      const bashBin = _binPath('bash') || '/bin/bash';
      // CONVEX_AGENT_MODE=anonymous ⇒ dev.sh's `bunx convex dev` runs the anonymous LOCAL
      // deployment (no login prompt) that install() configured, matching NEXT_PUBLIC_CONVEX_URL.
      child = spawn(bashBin, [C.DEV_SH], { cwd: C.SRC, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: _augmentedEnv({ SKIP_DOCKER_BUILD: 'true', CONVEX_AGENT_MODE: 'anonymous' }) });
    } catch (e) { try { fs.closeSync(logFd); } catch {} return { ok: false, error: 'spawn failed: ' + e.message }; }
    try { fs.closeSync(logFd); } catch {}
    if (!child.pid) return { ok: false, error: 'manaflow did not start' };
    child.unref();
    try { fs.writeFileSync(C.PIDFILE, String(child.pid), { mode: 0o600 }); } catch {}
    const reachable = await _pollReachable(waitMs);
    return { ok: reachable, pid: child.pid, reachable, adopted: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Reap the standalone convex-local-backend we started alongside dev.sh (separate group).
function _reapConvex() {
  try {
    const s = fs.readFileSync(_config().CONVEX_PIDFILE, 'utf8').trim();
    const p = parseInt(s, 10);
    if (Number.isInteger(p) && p > 0 && _alive(p)) {
      try { process.kill(p, 'SIGTERM'); } catch {}
    }
  } catch {}
  try { fs.unlinkSync(_config().CONVEX_PIDFILE); } catch {}
}

async function stop() {
  try {
    const pid = _readPid();
    if (!_alive(pid)) {
      if (await _reachable(1000)) return { ok: false, reason: 'externally managed' };
      try { fs.unlinkSync(_config().PIDFILE); } catch {}
      _reapConvex();
      return { ok: true, stopped: false };
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 12 && _alive(pid); i++) await _sleep(250);
    if (_alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    try { fs.unlinkSync(_config().PIDFILE); } catch {}
    _reapConvex();
    return { ok: true, stopped: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function logs({ sinceByte = 0, maxBytes = 65536 } = {}) {
  try {
    const C = _config();
    let size = 0; try { size = fs.statSync(C.LOG).size; } catch { return { text: '', size: 0, running: jobState.running }; }
    const start = Math.max(0, Math.min(Number(sinceByte) || 0, size));
    const len = Math.min(maxBytes, size - start);
    if (len <= 0) return { text: '', size, running: jobState.running };
    const fd = fs.openSync(C.LOG, 'r'); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start); fs.closeSync(fd);
    return { text: buf.toString('utf8'), size, running: jobState.running };
  } catch (e) { return { text: '', size: 0, error: e.message }; }
}

export const Manaflow = { detect, status, install, launch, stop, logs };
export default Manaflow;
