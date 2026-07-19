// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — keeper (the "iT Keeper": tmux-less session persistence)
// A dependency-light, PERSISTENT terminal-session keeper whose sessions SURVIVE
// the disconnection of their clients — our own answer to `tmux new -A` without
// depending on tmux being installed on the box. It runs in TWO roles from ONE
// file:
//   (A) a standalone CLI: `node keeper.mjs <cmd> …` — the persistent session
//       daemon plus attach clients. Runs LOCALLY (spawned by the bridge) and
//       REMOTELY (deployed to a VM, driven over `ssh -tt … -- node keeper.mjs
//       attach <id>`).
//   (B) an importable module `export const Keeper` giving the bridge a small
//       management API (list / kill / rename / ensure) — the bridge calls
//       Keeper.ensure(id) to guarantee a live daemon BEFORE it spawns a
//       `keeper attach <id>` child.
//
// PERSISTENCE (the whole point): the login-shell PTY lives inside a DETACHED
// daemon process. A client attaches over a UNIX socket; when that client goes
// away the PTY KEEPS RUNNING. The daemon is spawned detached + unref'd with
// stdio:'ignore', so it also survives the bridge (its parent) dying — it holds
// no reference to any parent stdio.
//
// SECURITY: every spawn is argv-only — `ptySpawn(shell, ['-l'], …)` and
// `spawn(node, [thisFile,'_daemon',id,…])` — never `sh -c`, never string
// interpolation, so there is no shell-injection surface. Every id/name/cwd is
// validated. The storage dir is 0700, sockets + meta files are 0600. `_`-prefixed
// module methods are server-only (the bridge's /mod RPC refuses fn[0]==='_').
//
// RESILIENCE: node-pty is a NATIVE module and may be absent (no prebuilt for a
// very new Node, no Xcode CLT). Importing this file must NEVER crash the daemon
// or the bridge: the import is guarded, `available()` reports it, and `_daemon`
// records the failure into <id>.json and exits cleanly.
// ─────────────────────────────────────────────────────────────────────────────
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn as cpSpawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Guarded native import — the daemon keeps booting even if node-pty isn't built.
let ptySpawn = null;
try { ({ spawn: ptySpawn } = await import('node-pty')); } catch { ptySpawn = null; }

const NOT_INSTALLED = 'node-pty not installed — run `npm install` in bridge/ (needs prebuilt binary or Xcode CLT)';

// ── caps / limits ────────────────────────────────────────────────────────────
const RING_CAP = 256 * 1024;                 // scrollback replayed on attach (bytes) — WHOLE chunks only
const MAX_DIM = 1000;                         // clamp absurd cols/rows
const LIFETIME_MS = 24 * 60 * 60 * 1000;      // hard cap: reap any daemon after 24 h (the one backstop that always fires)
const DETACH_IDLE_MS = 12 * 60 * 60 * 1000;   // DETACHED (no client) with ZERO pty I/O for 12 h → reap (favours persistence)
const DETACH_CHECK_MS = 60 * 1000;            // how often the detached-idle backstop wakes to check
const ATTACH_POLL_MS = 100;                   // poll cadence while waiting for a fresh daemon's socket
const ATTACH_WAIT_MS = 3000;                  // give a spawning daemon up to ~3 s to bind its socket
const CONNECT_PROBE_MS = 500;                 // per-probe timeout when testing "is the socket connectable?"
const DEFAULT_COLS = 80, DEFAULT_ROWS = 24;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 40;

const VALID_SIGNALS = new Set([
  'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT',
  'SIGTSTP', 'SIGCONT', 'SIGWINCH', 'SIGUSR1', 'SIGUSR2',
]);

const __filename = fileURLToPath(import.meta.url);

// ── storage ──────────────────────────────────────────────────────────────────
// ~/.clone-frame-hub/keeper/  (0700).  Per session: <id>.sock + <id>.json (0600).
function homeDir() { return process.env.HOME || os.homedir(); }
function keeperDir() { return path.join(homeDir(), '.clone-frame-hub', 'keeper'); }
function ensureDir() {
  const d = keeperDir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch {}
  return d;
}
// The socket lives in a SHORT, per-user tmp dir under a HASHED name so the full path stays
// well under the unix-socket sun_path limit (~104 bytes) for ANY id length or HOME depth. The
// hash folds in HOME so different users never collide on a shared /tmp. Meta keeps its readable
// <id>.json name in ~/.clone-frame-hub/keeper/ (regular files have no such length limit).
function sockDir() { return path.join(os.tmpdir(), 'cfhub-keeper'); }
function ensureSockDir() { try { fs.mkdirSync(sockDir(), { recursive: true, mode: 0o700 }); fs.chmodSync(sockDir(), 0o700); } catch {} return sockDir(); }
function sockPath(id) { const h = createHash('sha1').update(homeDir() + '\0' + id).digest('hex').slice(0, 20); return path.join(sockDir(), h + '.sock'); }
function metaPath(id) { return path.join(keeperDir(), id + '.json'); }

// ── guards / normalisers ─────────────────────────────────────────────────────
function validId(id) { return typeof id === 'string' && ID_RE.test(id); }

// strip control chars, then clamp to NAME_MAX — a display label, never a path/arg.
function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, NAME_MAX);
}

function clampDim(v, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_DIM);
}

function resolveCwd(cwd) {
  try {
    if (typeof cwd === 'string' && cwd && fs.statSync(cwd).isDirectory()) return cwd;
  } catch {}
  return homeDir();
}

function normalizeSignal(sig) {
  const raw = String(sig || 'SIGTERM').toUpperCase();
  const full = raw.startsWith('SIG') ? raw : 'SIG' + raw;
  return VALID_SIGNALS.has(full) ? full : 'SIGTERM';
}

// EPERM means "alive but not ours to signal" — still counts as alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch { return null; }
}
function writeMeta(id, meta) {
  const p = metaPath(id);
  fs.writeFileSync(p, JSON.stringify(meta), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}
function cleanupStale(id) {
  try { fs.unlinkSync(metaPath(id)); } catch {}
  try { fs.unlinkSync(sockPath(id)); } catch {}
}

// Scan the dir → live sessions only, cleaning stale files for dead pids.
function scanSessions() {
  const dir = keeperDir();
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (!validId(id)) continue;
    const meta = readMeta(id);
    if (!meta || !pidAlive(meta.pid)) { cleanupStale(id); continue; }
    out.push({
      id: meta.id, name: meta.name, pid: meta.pid, shell: meta.shell,
      cwd: meta.cwd, startedAt: meta.startedAt, alive: true,
    });
  }
  return out;
}

// Is there a daemon actually accepting connections on <id>.sock right now?
function sockConnectable(id) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.connect(sockPath(id));
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
    const t = setTimeout(() => fin(false), CONNECT_PROBE_MS);
    t.unref?.();
  });
}
async function waitForSock(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await sockConnectable(id)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, ATTACH_POLL_MS));
  }
}

// Spawn the persistent daemon DETACHED + unref'd — argv only, stdio ignored, so it
// outlives its parent and holds no reference to parent stdio.
function spawnDaemonProcess(id, opts = {}) {
  const args = [__filename, '_daemon', id];
  if (opts.shell) args.push('--shell', String(opts.shell));
  if (opts.cwd) args.push('--cwd', String(opts.cwd));
  if (opts.name) args.push('--name', String(opts.name));
  if (opts.cols != null) args.push('--cols', String(opts.cols));
  if (opts.rows != null) args.push('--rows', String(opts.rows));
  const child = cpSpawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) CLI — daemon + clients
// ─────────────────────────────────────────────────────────────────────────────

// `keeper _daemon <id> [--shell][--cwd][--cols][--rows][--name]` — INTERNAL.
// The persistent session daemon: owns ONE login-shell PTY and serves ONE active
// attach client at a time over a UNIX socket, surviving every client disconnect.
function runDaemon(id, flags) {
  if (!validId(id)) { process.stderr.write('invalid id\n'); process.exit(1); return; }
  ensureDir(); ensureSockDir();

  // node-pty absent → record it into <id>.json and exit cleanly (never crash).
  if (!ptySpawn) {
    try { writeMeta(id, { id, err: 'node-pty not installed' }); } catch {}
    process.exit(1);
    return;
  }

  const shell = (typeof flags.shell === 'string' && flags.shell.trim())
    ? flags.shell : (process.env.SHELL || '/bin/zsh');
  const cwd = resolveCwd(flags.cwd);
  const name = sanitizeName(flags.name) || id;
  let curCols = clampDim(flags.cols, DEFAULT_COLS);
  let curRows = clampDim(flags.rows, DEFAULT_ROWS);
  const startedAt = Date.now();

  let pty;
  try {
    pty = ptySpawn(shell, ['-l'], { name: 'xterm-color', cols: curCols, rows: curRows, cwd, env: process.env });
  } catch (e) {
    try { writeMeta(id, { id, err: 'spawn failed: ' + ((e && e.message) || String(e)) }); } catch {}
    process.exit(1);
    return;
  }

  const sp = sockPath(id);
  // Scrollback ring: keep the last ~RING_CAP bytes as WHOLE onData chunks (never
  // slice a chunk — a cut multibyte/escape byte corrupts the top of the replay).
  let ring = [];
  let ringBytes = 0;
  function pushRing(chunk) {
    const bytes = Buffer.byteLength(chunk);
    if (bytes >= RING_CAP) { const tail = chunk.length > RING_CAP ? chunk.slice(-RING_CAP) : chunk; ring = [tail]; ringBytes = Buffer.byteLength(tail); return; }
    ring.push(chunk); ringBytes += bytes;
    while (ringBytes > RING_CAP && ring.length > 1) ringBytes -= Buffer.byteLength(ring.shift());
  }

  let client = null;          // the SINGLE active attach client (a new one replaces it)
  let lastIO = Date.now();    // advanced by pty output (and client input while attached)
  let closing = false;

  // ── teardown ───────────────────────────────────────────────────────────────
  const cleanupFiles = () => { try { fs.unlinkSync(sp); } catch {} try { fs.unlinkSync(metaPath(id)); } catch {} };
  let finished = false;
  const finalize = (code) => {
    if (finished) return; finished = true;
    try { dataSub && dataSub.dispose && dataSub.dispose(); } catch {}
    if (client) { try { client.end(); } catch {} }
    try { server.close(); } catch {}
    cleanupFiles();
    process.exit(code);
  };
  // Graceful stop: SIGHUP the shell (what closing a terminal does); pty.onExit
  // finalizes, and a backstop force-kills the whole group + finalizes anyway.
  const requestShutdown = (reason) => {
    if (closing) return; closing = true;
    try { server.close(); } catch {}
    if (client) { try { client.write('\r\n[keeper] ' + reason + '\r\n'); } catch {} }
    const pid = pty && pty.pid;
    try { pty.kill('SIGHUP'); } catch {}
    const t = setTimeout(() => {
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
      finalize(0);
    }, 2000);
    t.unref?.();
  };

  // ── pty → ring + live client ────────────────────────────────────────────────
  let dataSub = null;
  try {
    dataSub = pty.onData((d) => {
      lastIO = Date.now();
      pushRing(d);
      if (client) { try { client.write(d); } catch {} }
    });
  } catch {}
  try { pty.onExit(() => { if (client) { try { client.write('\r\n[keeper] session ended\r\n'); } catch {} } finalize(0); }); } catch {}

  // ── inbound control / keystrokes ─────────────────────────────────────────────
  const onClientData = (buf) => {
    lastIO = Date.now();
    if (buf.length && buf[0] === 0x7b /* '{' */) {
      let ctrl = null;
      try { ctrl = JSON.parse(buf.toString('utf8')); } catch {}
      if (ctrl && typeof ctrl === 'object') {
        if (ctrl.resize && typeof ctrl.resize === 'object') {
          curCols = clampDim(ctrl.resize.cols, curCols); curRows = clampDim(ctrl.resize.rows, curRows);
          try { pty.resize(curCols, curRows); } catch {}
          return;
        }
        if (typeof ctrl.signal === 'string') { try { pty.kill(normalizeSignal(ctrl.signal)); } catch {} return; }
        if (ctrl.kill === true) { requestShutdown('killed by client'); return; }
      }
      // parseable-but-unrecognized or invalid JSON → treat as literal keystrokes
    }
    try { pty.write(buf.toString('utf8')); } catch {}
  };

  // ── the UNIX socket server ───────────────────────────────────────────────────
  try { fs.unlinkSync(sp); } catch {}   // unlink any stale sock BEFORE binding
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    // last-writer-wins: a NEW connection REPLACES the previous active client.
    if (client && client !== sock) {
      try { client.write('\r\n[keeper] detached — attached from elsewhere\r\n'); } catch {}
      try { client.end(); } catch {}
    }
    client = sock;
    // REPLAY the scrollback ring first, THEN go live.
    try { for (const chunk of ring) sock.write(chunk); } catch {}
    sock.on('data', onClientData);
    // Client disconnect: KEEP THE PTY RUNNING — this is the entire point.
    const detach = () => { if (client === sock) client = null; };
    sock.on('close', detach);
    sock.on('end', detach);
  });

  server.on('error', (e) => {
    // e.g. EADDRINUSE from a live daemon we didn't detect — record and bail, don't crash.
    try { writeMeta(id, { id, err: 'socket bind failed: ' + ((e && e.message) || String(e)) }); } catch {}
    try { pty.kill('SIGHUP'); } catch {}
    process.exit(1);
  });

  server.listen(sp, () => {
    try { fs.chmodSync(sp, 0o600); } catch {}
    // <id>.json with pid on start.
    try { writeMeta(id, { id, name, pid: process.pid, shell, cwd, startedAt }); } catch {}
  });

  // ── reap backstops (favour persistence, but never orphan forever) ────────────
  const lifeTimer = setTimeout(() => requestShutdown('lifetime cap'), LIFETIME_MS);
  lifeTimer.unref?.();
  const detachTimer = setInterval(() => {
    if (!client && (Date.now() - lastIO) >= DETACH_IDLE_MS) requestShutdown('detached idle cap');
  }, DETACH_CHECK_MS);
  detachTimer.unref?.();

  // ── remove sock + json on any exit ───────────────────────────────────────────
  process.on('exit', () => { try { cleanupFiles(); } catch {} });
  process.on('SIGTERM', () => requestShutdown('terminated'));
  process.on('SIGINT', () => requestShutdown('interrupted'));
}

// `keeper attach <id>` — attach client: pipe stdin↔socket↔stdout, forward resize.
function cliAttach(id) {
  if (!validId(id)) { process.stderr.write('invalid id\n'); process.exit(2); return; }
  const sock = net.connect(sockPath(id));
  let raw = false, connected = false, exited = false;

  const restore = () => { if (raw && process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} raw = false; } };
  const done = (code) => { if (exited) return; exited = true; restore(); try { sock.destroy(); } catch {} process.exit(code); };
  const sendResize = () => { try { sock.write(JSON.stringify({ resize: { cols: process.stdout.columns || DEFAULT_COLS, rows: process.stdout.rows || DEFAULT_ROWS } })); } catch {} };

  sock.on('connect', () => {
    connected = true;
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); raw = true; } catch {} }
    process.stdin.resume();
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
    if (process.stdin.isTTY) { sendResize(); process.on('SIGWINCH', sendResize); }
  });
  sock.on('error', (e) => {
    if (!connected) {
      if (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) { process.stderr.write('no such session\n'); return done(2); }
      process.stderr.write('attach error: ' + ((e && e.message) || e) + '\n'); return done(2);
    }
    done(0); // post-connect socket error == the session/daemon went away → detach
  });
  sock.on('close', () => done(0));
  process.stdin.on('end', () => done(0));  // stdin closed → detach (pty survives)
  process.on('exit', restore);             // always restore the terminal
}

// `keeper run <id> [flags]` — attach-or-create (idempotent, like `tmux new -A`).
async function cliRun(id, flags) {
  if (!validId(id)) { process.stderr.write('invalid id\n'); process.exit(2); return; }
  ensureDir();
  const meta = readMeta(id);
  const live = meta && pidAlive(meta.pid) && await sockConnectable(id);
  if (live) { cliAttach(id); return; }
  if (!meta || !pidAlive(meta.pid)) cleanupStale(id);  // dead pid → sweep before respawn
  spawnDaemonProcess(id, flags);
  if (!(await waitForSock(id, ATTACH_WAIT_MS))) {
    const err = readMeta(id);
    process.stderr.write('failed to start session' + (err && err.err ? ': ' + err.err : '') + '\n');
    process.exit(1);
    return;
  }
  cliAttach(id);
}

// `keeper list [--json]` — live sessions only; stale files for dead pids swept.
function cliList(flags) {
  const sessions = scanSessions();
  if (flags.json) { process.stdout.write(JSON.stringify(sessions) + '\n'); return; }
  if (!sessions.length) { process.stdout.write('no live sessions\n'); return; }
  for (const s of sessions) {
    process.stdout.write(`${s.id}\t${s.name || ''}\tpid=${s.pid}\t${s.shell || ''}\t${s.cwd || ''}\n`);
  }
}

// `keeper kill <id>` — SIGTERM the daemon; best-effort cleanup.
function cliKill(id) {
  if (!validId(id)) { process.stderr.write('invalid id\n'); process.exit(2); return; }
  const meta = readMeta(id);
  if (meta && pidAlive(meta.pid)) { try { process.kill(meta.pid, 'SIGTERM'); } catch {} }
  else cleanupStale(id);
  process.stdout.write('ok\n');
}

function usage() {
  process.stderr.write([
    'iT Keeper — persistent terminal sessions (tmux-less)',
    'usage:',
    '  keeper run <id> [--shell <sh>] [--cwd <dir>] [--name <n>] [--cols <n>] [--rows <n>]   attach-or-create',
    '  keeper attach <id>                                                                     attach to a live session',
    '  keeper list [--json]                                                                   list live sessions',
    '  keeper kill <id>                                                                        stop a session',
    '',
  ].join('\n'));
}

// Minimal `--flag value` / `--flag` parser (no external deps).
function parseArgv(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main(argv) {
  const cmd = argv[0];
  const { flags, positional } = parseArgv(argv.slice(1));
  switch (cmd) {
    case '_daemon': return runDaemon(positional[0], flags);
    case 'attach': return cliAttach(positional[0]);
    case 'run': return cliRun(positional[0], flags);
    case 'list': return cliList(flags);
    case 'kill': return cliKill(positional[0]);
    default: usage(); process.exit(cmd ? 1 : 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) Module API — the bridge-side management surface.
// Public methods have NO underscore (reachable via /mod RPC); `_`-prefixed
// methods are server-only (the bridge's handleMod refuses fn[0]==='_').
// ─────────────────────────────────────────────────────────────────────────────
export const Keeper = {
  available() { return { ok: true, ptyAvailable: !!ptySpawn }; },

  list() {
    try { return { ok: true, sessions: scanSessions() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  },

  kill(id) {
    if (!validId(id)) return { ok: false, error: 'invalid id' };
    try {
      const meta = readMeta(id);
      if (meta && pidAlive(meta.pid)) { try { process.kill(meta.pid, 'SIGTERM'); } catch {} }
      else cleanupStale(id);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  },

  rename(id, name) {
    if (!validId(id)) return { ok: false, error: 'invalid id' };
    const meta = readMeta(id);
    if (!meta) return { ok: false, error: 'no such session' };
    meta.name = sanitizeName(name) || meta.name || id;
    try { writeMeta(id, meta); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  },

  // server-only: launch a detached daemon for `id` (does NOT wait for it).
  _spawnDaemon(id, opts = {}) {
    if (!validId(id)) return { ok: false, error: 'invalid id' };
    if (!ptySpawn) return { ok: false, error: NOT_INSTALLED };
    try {
      ensureDir();
      spawnDaemonProcess(id, { shell: opts.shell, cwd: opts.cwd, name: opts.name, cols: opts.cols, rows: opts.rows });
      return { ok: true, id };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  },

  // attach-or-create at the module level: return the live session or spawn one and
  // wait for its socket. The bridge calls this BEFORE spawning `keeper attach`.
  async ensure(id, opts = {}) {
    if (!validId(id)) return { ok: false, error: 'invalid id' };
    if (!ptySpawn) return { ok: false, error: NOT_INSTALLED };
    try {
      ensureDir();
      const meta = readMeta(id);
      if (meta && pidAlive(meta.pid) && await sockConnectable(id)) return { ok: true, id, created: false };
      if (!meta || !pidAlive(meta.pid)) cleanupStale(id);
      const spawned = this._spawnDaemon(id, opts);
      if (!spawned.ok) return spawned;
      if (!(await waitForSock(id, ATTACH_WAIT_MS))) {
        const err = readMeta(id);
        return { ok: false, error: 'daemon did not start' + (err && err.err ? ': ' + err.err : ' (socket never appeared)') };
      }
      return { ok: true, id, created: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  },

  // server-only: absolute path to THIS file, so the bridge can spawn `node <path> attach <id>`.
  _keeperPath() { return __filename; },
};
export default Keeper;

// ── CLI-vs-import detection ───────────────────────────────────────────────────
// Only run the CLI when invoked directly (`node keeper.mjs …`), never on import.
let isCLI = false;
try { isCLI = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch {}
if (isCLI) main(process.argv.slice(2));
