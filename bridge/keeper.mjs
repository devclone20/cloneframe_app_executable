// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — keeper (the "iT Keeper": our own session persistence)
// A dependency-light, PERSISTENT terminal-session keeper whose sessions SURVIVE
// the disconnection of their clients — the app's own persistence engine, with
// nothing external to install or attach to. It runs in TWO roles from ONE
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
// validated. Meta files are 0600 in a 0700 dir. `_`-prefixed module methods are
// server-only (the bridge's /mod RPC refuses fn[0]==='_').
//
// SOCKET TRUST (B10 fix): the unix socket lives under `os.tmpdir()`, which on
// Linux is the SHARED, world-writable /tmp — so `ensureSockDir()` verifies the
// directory is a real, non-symlink, uid-owned, 0700 dir before EVERY use and
// throws rather than silently trusting a pre-created one (see its own comment).
// On top of that, every session now carries a per-session secret: the daemon's
// socket refuses any client whose first message isn't `{"auth":"<secret>"}`
// (see `makeAuthGate`), so even a squatter who won a directory race still can't
// pass as our daemon. Sessions from a PREVIOUS build have no secret in their
// meta — clients skip the auth frame for those (see cliAttach) so it is never
// mistyped into a live shell as a keystroke. `CFHUB_KEEPER_SOCK_DIR` overrides
// the socket directory for tests, in the same trust tier as `CLONE_FRAME_HUB_ROOT`
// (see bridge/platform/hub-root.mjs) — a process able to set the bridge's env
// can already do far more than redirect where its sockets live.
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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hubPath } from './platform/hub-root.mjs';

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
const UNAUTH_TIMEOUT_MS = 5000;               // server: drop a connection that never completes the auth handshake
const ATTACH_AUTH_MS = 5000;                  // client: give up waiting for the daemon's auth ack
const MAX_AUTH_LINE = 4096;                   // guard: refuse to buffer an unterminated "line" forever
const DEFAULT_COLS = 80, DEFAULT_ROWS = 24;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 40;

const VALID_SIGNALS = new Set([
  'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT',
  'SIGTSTP', 'SIGCONT', 'SIGWINCH', 'SIGUSR1', 'SIGUSR2',
]);

const __filename = fileURLToPath(import.meta.url);

// ── storage ──────────────────────────────────────────────────────────────────
// Meta lives under the hub-root seam (0700 dir, 0600 files) so tests can isolate
// it via CLONE_FRAME_HUB_ROOT like every other domain module. Production is
// byte-identical to before: with the env unset, hubPath('keeper') resolves to
// exactly ~/.clone-frame-hub/keeper.
function homeDir() { return process.env.HOME || os.homedir(); }
function keeperDir() { return hubPath('keeper'); }
function ensureDir() {
  const d = keeperDir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch {}
  return d;
}
// The socket lives in a SHORT, per-user tmp dir under a HASHED name so the full path stays
// well under the unix-socket sun_path limit (~104 bytes) for ANY id length or HOME depth. The
// hash folds in HOME (NOT hubRoot — a real session must resolve to the same socket path it
// always has, regardless of the test-only hub-root override) so different users never collide
// on a shared /tmp. Meta keeps its readable <id>.json name under keeperDir() (regular files
// have no such length limit).
// `CFHUB_KEEPER_SOCK_DIR` is a test-only override — same trust tier as CLONE_FRAME_HUB_ROOT.
function sockDir() {
  const override = process.env.CFHUB_KEEPER_SOCK_DIR;
  return (override && override.trim()) ? override : path.join(os.tmpdir(), 'cfhub-keeper');
}
// `os.tmpdir()` is SHARED and world-writable on Linux. A local attacker can pre-create
// `cfhub-keeper` before we ever run; the old code's mkdir-then-chmod, wrapped in ONE
// swallow-everything try/catch, then silently kept using whatever was already there
// (mkdir no-ops on EEXIST, chmod's EPERM was swallowed too). This is the ONE check that
// actually stops that attack: it REFUSES — throws, never proceeds — unless the directory
// is real (not a symlink), owned by us, and carries no group/other bits.
//
// Deliberately NO auto-repair-then-proceed: an `mkdirSync(…,{mode:0o700})` we just issued
// ourselves can only ever come out AT MOST as strict as 0700 (umask can narrow bits, never
// widen them), so the only way this dir is ever found loose is if it already existed with
// that looseness BEFORE this call — i.e. exactly the state a squatter would leave. Silently
// chmod-ing that back to 0700 and continuing would erase the evidence and use the directory
// anyway; refusing outright is the honest response to a directory whose current state we
// cannot trust, even one we happen to own.
function ensureSockDir() {
  const d = sockDir();
  try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); }
  catch (e) { if (!e || e.code !== 'EEXIST') throw new Error(`keeper: cannot create socket dir ${d}: ${(e && e.message) || e}`); }
  const st = statForGuard(d);
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const uidOk = myUid === null || st.uid === myUid;
  if (!(st.isDirectory() && !st.isSymbolicLink() && uidOk && (st.mode & 0o077) === 0)) {
    throw new Error(`keeper: refusing socket dir ${d} — not a private (uid-owned, 0700, non-symlink) directory; a local attacker may have pre-created it. Remove or fix its permissions and retry.`);
  }
  return d;
}
function statForGuard(d) {
  try { return fs.lstatSync(d); }
  catch (e) { throw new Error(`keeper: cannot stat socket dir ${d}: ${(e && e.message) || e}`); }
}
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

// ── socket auth (per-session secret) ─────────────────────────────────────────
// Wire format, both directions: a single line of JSON terminated by '\n', e.g.
// `{"auth":"<secret>"}\n` / `{"auth":"ok"}\n`. Newline-delimited so a client or
// server can split "the handshake line" from "whatever real stream data was
// glued to it in the same TCP/pipe read" — the PTY stream may itself contain
// raw '\n' bytes, but the FIRST one in the connection is always the frame end
// because nothing else is written before it.

// Pure, so it is trivial to test the decision in isolation: does `line` (raw,
// pre-newline-split JSON text) prove knowledge of `secret`? Constant-time
// compare — this gates a live PTY, timing leaks are worth closing even locally.
function authLineOk(line, secret) {
  if (typeof secret !== 'string' || !secret) return false;
  let parsed;
  try { parsed = JSON.parse(line); } catch { return false; }
  if (!parsed || typeof parsed.auth !== 'string') return false;
  const got = Buffer.from(parsed.auth), want = Buffer.from(secret);
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

// Server-side gate: wraps a `net.createServer` connection handler so NOTHING —
// no PTY byte, no control verb, no ring replay — reaches `onAuthed(sock, leftover)`
// until the FIRST line on the wire is exactly `{"auth":"<secret>"}`. A wrong or
// missing frame (including one that never arrives — the UNAUTH_TIMEOUT_MS backstop)
// gets the socket destroyed with zero feedback beyond that. `leftover` is any bytes
// that arrived glued to the auth line in the same read — they are live client data,
// not part of the handshake, and must not be dropped. Exported (as `Keeper._makeAuthGate`)
// so a test can wire this exact function into a real `net.createServer`, with no PTY
// involved at all — this is production code, not a test-only reimplementation.
function makeAuthGate(secret, onAuthed) {
  return (sock) => {
    sock.on('error', () => {});
    let authed = false;
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { if (!authed) { try { sock.destroy(); } catch {} } }, UNAUTH_TIMEOUT_MS);
    timer.unref?.();
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const nl = buf.indexOf(0x0a);
      if (nl === -1) { if (buf.length > MAX_AUTH_LINE) { try { sock.destroy(); } catch {} } return; }
      const line = buf.slice(0, nl).toString('utf8');
      const leftover = buf.slice(nl + 1);
      if (!authLineOk(line, secret)) { try { sock.destroy(); } catch {} return; }
      authed = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      try { sock.write(JSON.stringify({ auth: 'ok' }) + '\n'); } catch {}
      onAuthed(sock, leftover);
    };
    sock.on('data', onData);
  };
}

// Client-side half of the same handshake: write the auth frame, then wait for the
// daemon's one-line ack. `cb(ok, leftover)` — `leftover` is live-stream bytes that
// rode in on the same read as the ack and must be forwarded, not discarded.
function authenticateSocket(sock, secret, cb) {
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const nl = buf.indexOf(0x0a);
    if (nl === -1) {
      // a peer that streams forever without a newline (broken or hostile) must not be
      // allowed to grow this buffer without bound while the caller's own timeout ticks.
      if (buf.length > MAX_AUTH_LINE) { sock.removeListener('data', onData); try { sock.destroy(); } catch {} cb(false, Buffer.alloc(0)); }
      return;
    }
    sock.removeListener('data', onData);
    const line = buf.slice(0, nl).toString('utf8');
    const leftover = buf.slice(nl + 1);
    let ok = false;
    try { const j = JSON.parse(line); ok = !!j && j.auth === 'ok'; } catch {}
    cb(ok, leftover);
  };
  sock.on('data', onData);
  try { sock.write(JSON.stringify({ auth: secret }) + '\n'); }
  catch { sock.removeListener('data', onData); cb(false, Buffer.alloc(0)); }
}

// Is there a daemon actually accepting connections on <id>.sock right now — and,
// when the session has a secret, does it actually KNOW it? The bare `connect`-then-
// resolve(true) this used to be could not tell OUR daemon from anything else
// squatting the path; completing the handshake narrows that a lot, but it does NOT
// eliminate the TOCTOU: a squatter could still win the window between this probe
// resolving and the real connect a caller makes right after. The private-directory
// check in ensureSockDir() is what actually removes the attacker — this probe only
// makes a "yes" mean something.
function sockConnectable(id) {
  return new Promise((resolve) => {
    let dirOk = true;
    try { ensureSockDir(); } catch { dirOk = false; }
    if (!dirOk) { resolve(false); return; } // can't verify the dir → treat as "not our daemon", never throw from a boolean probe
    let done = false;
    const meta = readMeta(id);
    const secret = meta && typeof meta.secret === 'string' ? meta.secret : null;
    const s = net.connect(sockPath(id));
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => {
      if (!secret) { fin(true); return; } // legacy pre-auth session — connect-only signal, narrower guarantee (see comment above)
      authenticateSocket(s, secret, (ok) => fin(ok));
    });
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
  try { ensureDir(); ensureSockDir(); }
  catch (e) {
    // A hostile pre-created socket dir must stop the daemon before it ever binds —
    // record why (so `keeper` callers can surface it) and exit cleanly, never crash.
    try { writeMeta(id, { id, err: (e && e.message) || String(e) }); } catch {}
    process.stderr.write((e && e.message) || String(e)); process.stderr.write('\n');
    process.exit(1);
    return;
  }

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
  const secret = randomBytes(24).toString('base64url'); // minted once per daemon; lives only in the 0600 meta file

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
  // Every connection is auth-gated FIRST (see makeAuthGate): last-writer-wins,
  // ring replay, and onClientData below only ever run for an authenticated sock.
  const server = net.createServer(makeAuthGate(secret, (sock, leftover) => {
    // last-writer-wins: a NEW connection REPLACES the previous active client.
    if (client && client !== sock) {
      try { client.write('\r\n[keeper] detached — attached from elsewhere\r\n'); } catch {}
      try { client.end(); } catch {}
    }
    client = sock;
    // REPLAY the scrollback ring first, THEN go live.
    try { for (const chunk of ring) sock.write(chunk); } catch {}
    sock.on('data', onClientData);
    if (leftover.length) onClientData(leftover); // bytes glued to the auth line — real client input, not part of the handshake
    // Client disconnect: KEEP THE PTY RUNNING — this is the entire point.
    const detach = () => { if (client === sock) client = null; };
    sock.on('close', detach);
    sock.on('end', detach);
  }));

  server.on('error', (e) => {
    // e.g. EADDRINUSE from a live daemon we didn't detect — record and bail, don't crash.
    try { if (typeof prevUmask === 'number') process.umask(prevUmask); } catch {} // restore even on a failed bind
    try { writeMeta(id, { id, err: 'socket bind failed: ' + ((e && e.message) || String(e)) }); } catch {}
    try { pty.kill('SIGHUP'); } catch {}
    process.exit(1);
  });

  try {
    ensureSockDir();               // re-verify right before bind — closes the gap between the
    fs.unlinkSync(sp);             // startup check above and the actual listen() a moment later
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) {
      try { writeMeta(id, { id, err: (e && e.message) || String(e) }); } catch {}
      try { pty.kill('SIGHUP'); } catch {}
      process.exit(1);
      return;
    }
  }
  // Node cannot create-and-chmod a unix socket file atomically — there is always a
  // window between the file appearing and our chmod running. Narrowing the process
  // umask for the listen() call itself is the closest Node gets: the socket is
  // created 0700 from the start instead of the platform default, and the explicit
  // chmod below is a backstop, not the primary control.
  const prevUmask = process.umask(0o077);
  server.listen(sp, () => {
    process.umask(prevUmask);
    try { fs.chmodSync(sp, 0o600); } catch {}
    // <id>.json with pid + secret on start.
    try { writeMeta(id, { id, name, pid: process.pid, shell, cwd, startedAt, secret }); } catch {}
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
  try { ensureSockDir(); }
  catch (e) { process.stderr.write('attach error: ' + ((e && e.message) || e) + '\n'); process.exit(2); return; }
  // BACKWARD COMPAT: a daemon from a PREVIOUS build wrote no `secret` — sending an
  // auth frame to it would just be typed into the user's live shell as input, so
  // when meta has none we send NOTHING and behave exactly as before this change.
  const meta = readMeta(id);
  const secret = meta && typeof meta.secret === 'string' ? meta.secret : null;
  const sock = net.connect(sockPath(id));
  let raw = false, connected = false, exited = false;

  const restore = () => { if (raw && process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch {} raw = false; } };
  const done = (code) => { if (exited) return; exited = true; restore(); try { sock.destroy(); } catch {} process.exit(code); };
  const sendResize = () => { try { sock.write(JSON.stringify({ resize: { cols: process.stdout.columns || DEFAULT_COLS, rows: process.stdout.rows || DEFAULT_ROWS } })); } catch {} };
  const startPipe = (leftover) => {
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); raw = true; } catch {} }
    process.stdin.resume();
    process.stdin.pipe(sock);
    if (leftover && leftover.length) process.stdout.write(leftover); // bytes glued to the ack — real session output
    sock.pipe(process.stdout);
    if (process.stdin.isTTY) { sendResize(); process.on('SIGWINCH', sendResize); }
  };

  sock.on('connect', () => {
    connected = true;
    if (!secret) { startPipe(); return; }
    const authTimer = setTimeout(() => { process.stderr.write('keeper: authentication timed out\n'); done(2); }, ATTACH_AUTH_MS);
    authTimer.unref?.();
    authenticateSocket(sock, secret, (ok, leftover) => {
      clearTimeout(authTimer);
      if (!ok) { process.stderr.write('keeper: authentication failed\n'); done(2); return; }
      startPipe(leftover);
    });
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

// `keeper run <id> [flags]` — attach-or-create (idempotent).
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
    'iT Keeper — persistent terminal sessions',
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

  // server-only: test seams (B10). Each wraps a real internal so a test exercises the
  // EXACT production code path — never a reimplementation that could pass with the
  // fix reverted. None of these are reachable via /mod RPC (fn[0]==='_' is refused).
  _sockDir() { return sockDir(); },
  _sockPath(id) { return sockPath(id); },
  _ensureSockDir() { return ensureSockDir(); },
  _sockConnectable(id) { return sockConnectable(id); },
  _makeAuthGate(secret, onAuthed) { return makeAuthGate(secret, onAuthed); },
  _authenticateSocket(sock, secret, cb) { return authenticateSocket(sock, secret, cb); },
  _authLineOk(line, secret) { return authLineOk(line, secret); },
  _keeperDir() { return keeperDir(); },
  _ensureDir() { return ensureDir(); },
  _metaPath(id) { return metaPath(id); },
  _readMeta(id) { return readMeta(id); },
  _writeMeta(id, meta) { return writeMeta(id, meta); },
};
export default Keeper;

// ── CLI-vs-import detection ───────────────────────────────────────────────────
// Only run the CLI when invoked directly (`node keeper.mjs …`), never on import.
let isCLI = false;
try { isCLI = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch {}
if (isCLI) main(process.argv.slice(2));
