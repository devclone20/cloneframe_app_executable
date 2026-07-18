// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — pty (interactive real-TTY session manager)
// The DATA-PLANE engine adapter behind the bridge's single WS /stream channel.
// Owns one node-pty session per interactive terminal: spawn a real login shell /
// tmux / TUI, bridge its bytes to a WebSocket, and reap it deterministically on
// close. The CONTROL plane (POST /mod/pty {fn,args}) drives open/write/resize/
// signal/kill/list; attach(ws,hello) is the live duplex bridge.
//
// SECURITY: node-pty is spawned as argv (cmd, args[]) — no `sh -c`, no string
// interpolation — so there is no shell-injection surface here. The same
// catastrophic-pattern guard used by /shell is still applied to the initial
// command line as defence-in-depth for callers that pass a raw shell command.
// Every session is capped (MAX_SESSIONS), idle-reaped, and lifetime-capped; a
// runaway process is throttled by per-socket backpressure so it can't flood the
// WS. All guards on the WS UPGRADE (localOnly + Host + Origin + token) live in
// hub-bridge.mjs and gate this module before attach() is ever reached.
//
// RESILIENCE: node-pty is a NATIVE module and may be absent (e.g. no prebuilt for
// a very new Node, no Xcode CLT). Importing this file must NEVER crash the daemon:
// the import is guarded and every function degrades to a clear, friendly error.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import fs from 'node:fs';

// Guarded native import — the daemon keeps booting even if node-pty isn't built.
let ptySpawn = null;
try { ({ spawn: ptySpawn } = await import('node-pty')); } catch { ptySpawn = null; }

const NOT_INSTALLED = 'node-pty not installed — run `npm install` in bridge/ (needs prebuilt binary or Xcode CLT)';

const MAX_SESSIONS = 24;                       // concurrent interactive TTYs (iT: workspaces × split panes)
const MAX_DIM = 1000;                          // clamp absurd cols/rows
const IDLE_MS = 30 * 60 * 1000;                // no I/O for 30 min → reap
const LIFETIME_MS = 12 * 60 * 60 * 1000;       // hard cap: 12 h per session
const HIGH_WATER = 4 * 1024 * 1024;            // ws buffered > 4 MiB → pause pty
const LOW_WATER = 1 * 1024 * 1024;             // drained < 1 MiB → resume pty
const WS_CONNECTING = 0, WS_OPEN = 1;

const VALID_SIGNALS = new Set([
  'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT',
  'SIGTSTP', 'SIGCONT', 'SIGWINCH', 'SIGUSR1', 'SIGUSR2',
]);

// { id, pty, cmd, cols, rows, startedAt, alive }
const sessions = new Map();

// ── guards / normalisers ────────────────────────────────────────────────────

// Verbatim catastrophic-pattern guard from hub-bridge.mjs /shell — blocked always.
function isDestructive(line) {
  const s = String(line || '');
  return /\brm\s+-[a-z]*[rf][a-z]*\s+(\/\*{0,2}(\s|$)|~(\/|\s|$)|\$HOME)/.test(s)
    || /\bmkfs\b/.test(s)
    || /\bdd\b[^\n]*of=\/dev\//.test(s)
    || /:\(\)\s*\{\s*:\|:/.test(s);
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
  return process.env.HOME || homedir();
}

function buildEnv(env) {
  const base = { ...process.env };
  if (env && typeof env === 'object') for (const [k, v] of Object.entries(env)) base[k] = String(v);
  if (!base.TERM) base.TERM = 'xterm-color';
  return base;
}

function normalizeSignal(sig) {
  const raw = String(sig || 'SIGTERM').toUpperCase();
  const full = raw.startsWith('SIG') ? raw : 'SIG' + raw;
  return VALID_SIGNALS.has(full) ? full : 'SIGTERM';
}

// SIGHUP first (what closing a terminal does — reaps the foreground group), then
// escalate to a SIGKILL of the whole process group for any straggler children.
function reap(pty) {
  const pid = pty && pty.pid;
  try { pty.kill('SIGHUP'); } catch {}
  if (!pid) return;
  const t = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }, 2000);
  t.unref?.();
}

// ── control plane ───────────────────────────────────────────────────────────

function open({ cmd, args = [], cwd, cols = 80, rows = 24, env } = {}) {
  if (!ptySpawn) return { ok: false, error: NOT_INSTALLED };
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'cmd required' };
  if (!Array.isArray(args)) return { ok: false, error: 'args must be an array' };
  if (!args.every(a => typeof a === 'string' && a.length <= 4000 && !a.includes('\0'))) return { ok: false, error: 'bad args' };
  if (sessions.size >= MAX_SESSIONS) return { ok: false, error: `session cap reached (${MAX_SESSIONS})` };

  const line = [cmd, ...args].join(' ');
  if (isDestructive(line)) return { ok: false, error: 'refused: catastrophic pattern blocked for safety' };

  const c = clampDim(cols, 80), r = clampDim(rows, 24);
  let pty;
  try {
    pty = ptySpawn(cmd, args, { name: 'xterm-color', cols: c, rows: r, cwd: resolveCwd(cwd), env: buildEnv(env) });
  } catch (e) {
    return { ok: false, error: 'spawn failed: ' + (e && e.message || String(e)) };
  }

  const id = randomBytes(9).toString('hex');
  const sess = { id, pty, cmd: line.slice(0, 200), cols: c, rows: r, startedAt: Date.now(), alive: true };
  try { pty.onExit(() => { sess.alive = false; }); } catch {}
  sessions.set(id, sess);
  return { ok: true, id };
}

function write(id, data) {
  const s = sessions.get(String(id));
  if (!s) return { ok: false, error: 'no such session' };
  try { s.pty.write(Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '')); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function resize(id, cols, rows) {
  const s = sessions.get(String(id));
  if (!s) return { ok: false, error: 'no such session' };
  const c = clampDim(cols, s.cols), r = clampDim(rows, s.rows);
  try { s.pty.resize(c, r); s.cols = c; s.rows = r; return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function signal(id, sig) {
  const s = sessions.get(String(id));
  if (!s) return { ok: false, error: 'no such session' };
  try { s.pty.kill(normalizeSignal(sig)); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function kill(id) {
  const key = String(id);
  const s = sessions.get(key);
  if (!s) return { ok: false, error: 'no such session' };
  reap(s.pty);
  s.alive = false;
  sessions.delete(key);
  return { ok: true };
}

function list() {
  return [...sessions.values()].map(s => ({
    id: s.id, cmd: s.cmd, cols: s.cols, rows: s.rows, alive: !!s.alive, startedAt: s.startedAt,
  }));
}

// ── data plane ──────────────────────────────────────────────────────────────

// Bind a node-pty session to a WebSocket (the `ws` package). Reuses hello.id if it
// names a live session, else opens a fresh one from the handshake. Wires:
//   pty.onData → ws.send            (raw terminal bytes out, with backpressure)
//   ws message → pty.write | resize | signal   (keystrokes OR a small JSON control)
//   pty.onExit → ws.close           (process ended → close the socket)
//   ws close   → kill(id)           (tab closed → reap the child process group)
// plus an idle timeout and a hard lifetime cap. Never throws: on any setup failure
// it closes the socket with a status code and returns a friendly error.
function attach(ws, hello = {}) {
  if (!ws || typeof ws.send !== 'function' || typeof ws.on !== 'function') return { ok: false, error: 'invalid ws' };
  if (!ptySpawn) { try { ws.close(1011, 'node-pty not installed'); } catch {} return { ok: false, error: NOT_INSTALLED }; }

  let sess = (hello && hello.id && sessions.has(String(hello.id))) ? sessions.get(String(hello.id)) : null;
  if (!sess) {
    const cmd = (typeof hello.cmd === 'string' && hello.cmd.trim()) ? hello.cmd : (process.env.SHELL || 'zsh');
    const opened = open({ cmd, args: hello.args, cwd: hello.cwd, cols: hello.cols, rows: hello.rows, env: hello.env });
    if (!opened.ok) { try { ws.close(1011, String(opened.error || 'open failed').slice(0, 120)); } catch {} return opened; }
    sess = sessions.get(opened.id);
  }

  const id = sess.id;
  const pty = sess.pty;
  let closed = false, paused = false, idleTimer = null, drainTimer = null, lifeTimer = null, dataSub = null, exitSub = null;

  const teardown = (reason) => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (lifeTimer) clearTimeout(lifeTimer);
    if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
    try { dataSub && dataSub.dispose && dataSub.dispose(); } catch {}
    try { exitSub && exitSub.dispose && exitSub.dispose(); } catch {}
    kill(id);
    try { if (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING) ws.close(1000, String(reason || 'closed').slice(0, 120)); } catch {}
  };

  const bumpIdle = () => {
    if (closed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => teardown('idle timeout'), IDLE_MS);
    idleTimer.unref?.();
  };

  // backpressure: if the socket's send buffer grows, pause the PTY until it drains.
  const resumeIfDrained = () => {
    if (drainTimer) return;
    drainTimer = setInterval(() => {
      if (closed || (ws.bufferedAmount || 0) <= LOW_WATER) {
        clearInterval(drainTimer); drainTimer = null;
        if (paused && !closed) { paused = false; try { pty.resume?.(); } catch {} }
      }
    }, 50);
    drainTimer.unref?.();
  };
  const maybePause = () => {
    if (paused || closed) return;
    if ((ws.bufferedAmount || 0) > HIGH_WATER) { paused = true; try { pty.pause?.(); } catch {} resumeIfDrained(); }
  };

  try { dataSub = pty.onData(d => { if (closed) return; bumpIdle(); try { if (ws.readyState === WS_OPEN) ws.send(d); } catch {} maybePause(); }); } catch {}
  try { exitSub = pty.onExit(() => teardown('process exited')); } catch {}

  ws.on('message', (raw, isBinary) => {
    if (closed) return;
    bumpIdle();
    if (!isBinary) {
      const str = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (str.length && str[0] === '{') {
        let ctrl = null; try { ctrl = JSON.parse(str); } catch {}
        if (ctrl && typeof ctrl === 'object') {
          if (ctrl.resize && typeof ctrl.resize === 'object') { resize(id, ctrl.resize.cols, ctrl.resize.rows); return; }
          if (typeof ctrl.signal === 'string') { signal(id, ctrl.signal); return; }
        }
        // parseable-but-unrecognized or invalid JSON → treat as literal keystrokes
      }
      try { pty.write(str); } catch {}
      return;
    }
    try { pty.write(raw.toString('utf8')); } catch {}
  });
  ws.on('close', () => teardown('ws closed'));
  ws.on('error', () => teardown('ws error'));

  lifeTimer = setTimeout(() => teardown('lifetime cap'), LIFETIME_MS);
  lifeTimer.unref?.();
  bumpIdle();

  return { ok: true, id };
}

export const Pty = { available: () => !!ptySpawn, sessions, open, write, resize, signal, kill, list, attach };
export default Pty;
