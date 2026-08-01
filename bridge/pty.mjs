// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — pty (interactive real-TTY session manager)
// The DATA-PLANE engine adapter behind the bridge's single WS /stream channel.
// Owns one node-pty session per interactive terminal: spawn a real login shell /
// a full TUI, bridge its bytes to a WebSocket, and reap it deterministically on
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
import { isDestructive } from './platform/shell-guard.mjs';

// Guarded native import — the daemon keeps booting even if node-pty isn't built.
let ptySpawn = null;
try { ({ spawn: ptySpawn } = await import('node-pty')); } catch { ptySpawn = null; }

const NOT_INSTALLED = 'node-pty not installed — run `npm install` in bridge/ (needs prebuilt binary or Xcode CLT)';

const MAX_SESSIONS = 24;                       // concurrent interactive TTYs (iT: workspaces × split panes)
const MAX_DIM = 1000;                          // clamp absurd cols/rows
const IDLE_MS = 30 * 60 * 1000;                // no I/O for 30 min while ATTACHED → reap
const DETACH_MS = 60 * 60 * 1000;              // detached (window closed) with no reattach for 60 min → reap
const LIFETIME_MS = 12 * 60 * 60 * 1000;       // hard cap: 12 h per session (the one backstop across attach⇄detach)
const RING_CAP = 256 * 1024;                   // scrollback replayed on reattach (bytes)
const HIGH_WATER = 4 * 1024 * 1024;            // ws buffered > 4 MiB → pause pty
const LOW_WATER = 1 * 1024 * 1024;             // drained < 1 MiB → resume pty
const WS_CONNECTING = 0, WS_OPEN = 1;

const VALID_SIGNALS = new Set([
  'SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT',
  'SIGTSTP', 'SIGCONT', 'SIGWINCH', 'SIGUSR1', 'SIGUSR2',
]);

// session (Phase 4 — the SESSION owns the lifecycle, a ws is just a temporary attach):
// { id, pty, cmd, cols, rows, startedAt, alive, ws, persist, ring[], ringBytes,
//   idleTimer, detachTimer, lifeTimer, drainTimer, paused, dataSub }
const sessions = new Map();

// ── session lifecycle helpers ───────────────────────────────────────────────
function clearTimers(s) {
  for (const k of ['idleTimer', 'detachTimer', 'lifeTimer']) { if (s[k]) { clearTimeout(s[k]); s[k] = null; } }
  if (s.drainTimer) { clearInterval(s.drainTimer); s.drainTimer = null; }
}

// Scrollback ring: keep the last ~RING_CAP bytes as WHOLE onData chunks (never slice a
// chunk — a cut multibyte/escape byte would corrupt the top of the replayed screen).
function pushRing(s, chunk) {
  const bytes = Buffer.byteLength(chunk);
  if (bytes >= RING_CAP) { const tail = chunk.length > RING_CAP ? chunk.slice(-RING_CAP) : chunk; s.ring = [tail]; s.ringBytes = Buffer.byteLength(tail); return; }
  s.ring.push(chunk); s.ringBytes += bytes;
  while (s.ringBytes > RING_CAP && s.ring.length > 1) s.ringBytes -= Buffer.byteLength(s.ring.shift());
}

// idle clock only runs while ATTACHED; a detached session is capped by detachTimer + lifeTimer.
function armIdle(s) {
  if (!s.ws) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => endSession(s, 'idle timeout'), IDLE_MS);
  s.idleTimer.unref?.();
}

// backpressure lives on the session (only one ws attaches at a time). Critically, a
// detached session must NOT stay paused — else onData stops and the ring goes stale.
function resumeIfDrained(s) {
  if (s.drainTimer) return;
  s.drainTimer = setInterval(() => {
    if (!s.ws || (s.ws.bufferedAmount || 0) <= LOW_WATER) {
      clearInterval(s.drainTimer); s.drainTimer = null;
      if (s.paused) { s.paused = false; try { s.pty.resume?.(); } catch {} }
    }
  }, 50);
  s.drainTimer.unref?.();
}
function maybePause(s) {
  if (s.paused || !s.ws) return;
  if ((s.ws.bufferedAmount || 0) > HIGH_WATER) { s.paused = true; try { s.pty.pause?.(); } catch {} resumeIfDrained(s); }
}

// The one true teardown: clear timers, reap the child, drop from the map, close the ws.
function endSession(s, reason) {
  if (!s || !sessions.has(s.id)) return;
  clearTimers(s);
  try { s.dataSub && s.dataSub.dispose && s.dataSub.dispose(); } catch {}
  reap(s.pty);
  s.alive = false;
  sessions.delete(s.id);
  if (s.ws) { try { if (s.ws.readyState === WS_OPEN || s.ws.readyState === WS_CONNECTING) s.ws.close(1000, String(reason || 'closed').slice(0, 120)); } catch {} }
}

// ── guards / normalisers ────────────────────────────────────────────────────

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

function open(opts = {}) {
  // `opts || {}`: JSON has no `undefined`, so an omitted options bag arrives over RPC as
  // null — and a `= {}` default only ever fires for undefined. Without this the destructure
  // throws a V8 internal ("Cannot destructure property …") instead of answering the call.
  const { cmd, args = [], cwd, cols = 80, rows = 24, env, id } = opts || {};
  if (!ptySpawn) return { ok: false, error: NOT_INSTALLED };
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, error: 'cmd required' };
  if (!Array.isArray(args)) return { ok: false, error: 'args must be an array' };
  if (!args.every(a => typeof a === 'string' && a.length <= 4000 && !a.includes('\0'))) return { ok: false, error: 'bad args' };
  if (sessions.size >= MAX_SESSIONS) {
    // free a slot by reaping the oldest DETACHED session before hard-failing (a wall of
    // detached zombies must never starve new terminals).
    const victim = [...sessions.values()].filter(s => !s.ws).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (victim) endSession(victim, 'evicted — session cap');
    if (sessions.size >= MAX_SESSIONS) return { ok: false, error: `session cap reached (${MAX_SESSIONS})` };
  }

  const line = [cmd, ...args].join(' ');
  if (isDestructive(line)) return { ok: false, error: 'refused: catastrophic pattern blocked for safety' };

  const c = clampDim(cols, 80), r = clampDim(rows, 24);
  let pty;
  try {
    pty = ptySpawn(cmd, args, { name: 'xterm-color', cols: c, rows: r, cwd: resolveCwd(cwd), env: buildEnv(env) });
  } catch (e) {
    return { ok: false, error: 'spawn failed: ' + (e && e.message || String(e)) };
  }

  // a client may supply a stable id (Phase 4 reattach); else mint an unguessable one.
  const sid = (typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id) && !sessions.has(id)) ? id : randomBytes(9).toString('hex');
  const sess = {
    id: sid, pty, cmd: line.slice(0, 200), cols: c, rows: r, startedAt: Date.now(), alive: true,
    ws: null, persist: false, ring: [], ringBytes: 0,
    idleTimer: null, detachTimer: null, lifeTimer: null, drainTimer: null, paused: false, dataSub: null,
  };
  sessions.set(sid, sess);
  // ONE central onData: fill the scrollback ring ALWAYS, forward to the attached ws when
  // present, and keep the idle clock alive. This runs whether attached or detached.
  try { sess.dataSub = pty.onData(d => { pushRing(sess, d); armIdle(sess); if (sess.ws && sess.ws.readyState === WS_OPEN) { try { sess.ws.send(d); } catch {} maybePause(sess); } }); } catch {}
  try { pty.onExit(() => endSession(sess, 'process exited')); } catch {}
  // lifeTimer is the sole backstop across attach⇄detach cycles — armed exactly ONCE here,
  // never re-armed or cleared by attach/reattach, and it reaps even while detached.
  sess.lifeTimer = setTimeout(() => endSession(sess, 'lifetime cap'), LIFETIME_MS);
  sess.lifeTimer.unref?.();
  armIdle(sess);
  return { ok: true, id: sid };
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
  const s = sessions.get(String(id));
  if (!s) return { ok: false, error: 'no such session' };
  endSession(s, 'killed');
  return { ok: true };
}

// Reap a whole WINDOW's worth of sessions in one call.
//
// Closing an iT window has to reach sessions its live sockets cannot: a tab whose socket
// dropped hours ago is DETACHED — still running, still holding its port, with no channel
// left to carry a {kill:true} over. The window knows every session id it opened, so it
// names them here. Unknown ids are not an error: a session that already exited is exactly
// the outcome asked for, and the caller closing a window should not have to care which of
// its tabs the idle reaper got to first.
function killMany(ids) {
  if (!Array.isArray(ids)) return { ok: false, error: 'ids must be an array' };
  let killed = 0;
  for (const id of ids.slice(0, MAX_SESSIONS * 4)) {
    const s = sessions.get(String(id));
    if (s) { endSession(s, 'window closed'); killed++; }
  }
  return { ok: true, killed, asked: ids.length };
}

function list() {
  return [...sessions.values()].map(s => ({
    id: s.id, cmd: s.cmd, cols: s.cols, rows: s.rows, alive: !!s.alive, startedAt: s.startedAt,
    attached: !!s.ws, persist: !!s.persist,
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
// The ws leaving: DETACH (keep the pty alive for a later reattach) when the session is
// persistent and still running, else KILL. Guarded so a superseded socket can't reap the
// live session.
function onWsGone(s) {
  s.ws = null;
  // a detached pty must keep flowing into the ring — never leave it paused.
  if (s.drainTimer) { clearInterval(s.drainTimer); s.drainTimer = null; }
  if (s.paused) { s.paused = false; try { s.pty.resume?.(); } catch {} }
  if (s.persist && s.alive && sessions.has(s.id)) {
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; } // idle only runs while attached
    if (!s.detachTimer) { s.detachTimer = setTimeout(() => endSession(s, 'detach timeout'), DETACH_MS); s.detachTimer.unref?.(); }
  } else {
    endSession(s, 'closed');
  }
}

function attach(ws, hello = {}) {
  if (!ws || typeof ws.send !== 'function' || typeof ws.on !== 'function') return { ok: false, error: 'invalid ws' };
  if (!ptySpawn) { try { ws.close(1011, 'node-pty not installed'); } catch {} return { ok: false, error: NOT_INSTALLED }; }

  // reattach only to a session that is still alive; a dead-but-not-yet-swept id opens fresh.
  let sess = (hello && hello.id && sessions.has(String(hello.id))) ? sessions.get(String(hello.id)) : null;
  if (sess && !sess.alive) sess = null;
  if (!sess) {
    const cmd = (typeof hello.cmd === 'string' && hello.cmd.trim()) ? hello.cmd : (process.env.SHELL || 'zsh');
    const opened = open({ cmd, args: hello.args, cwd: hello.cwd, cols: hello.cols, rows: hello.rows, env: hello.env, id: hello.id });
    if (!opened.ok) { try { ws.close(1011, String(opened.error || 'open failed').slice(0, 120)); } catch {} return opened; }
    sess = sessions.get(opened.id);
  }

  // last-writer-wins: kick any socket already attached to this session (e.g. an old window).
  if (sess.ws && sess.ws !== ws) { try { sess.ws.close(4000, 'replaced by a newer attach'); } catch {} }
  sess.ws = ws;
  sess.persist = !!hello.persist;
  if (sess.detachTimer) { clearTimeout(sess.detachTimer); sess.detachTimer = null; }
  armIdle(sess);
  const thisWs = ws, id = sess.id, pty = sess.pty;

  // REPLAY the scrollback SYNCHRONOUSLY (no await before it finishes, or a live onData
  // would interleave ahead of the old buffer), THEN resize — SIGWINCH repaints TUIs on top.
  if (sess.ring.length) { try { for (const chunk of sess.ring) { if (ws.readyState === WS_OPEN) ws.send(chunk); } } catch {} }
  resize(id, hello.cols, hello.rows);

  ws.on('message', (raw, isBinary) => {
    if (sess.ws !== thisWs || !sessions.has(id)) return; // stale socket after a takeover
    armIdle(sess);
    if (!isBinary) {
      const str = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (str.length && str[0] === '{') {
        let ctrl = null; try { ctrl = JSON.parse(str); } catch {}
        if (ctrl && typeof ctrl === 'object') {
          if (ctrl.resize && typeof ctrl.resize === 'object') { resize(id, ctrl.resize.cols, ctrl.resize.rows); return; }
          if (typeof ctrl.signal === 'string') { signal(id, ctrl.signal); return; }
          if (ctrl.kill === true) { endSession(sess, 'closed by client'); return; } // tab/pane closed on purpose
        }
        // parseable-but-unrecognized or invalid JSON → treat as literal keystrokes
      }
      try { pty.write(str); } catch {}
      return;
    }
    try { pty.write(raw.toString('utf8')); } catch {}
  });
  ws.on('close', () => { if (sess.ws === thisWs) onWsGone(sess); });
  ws.on('error', () => { if (sess.ws === thisWs) onWsGone(sess); });

  return { ok: true, id };
}

export const Pty = { available: () => !!ptySpawn, sessions, open, write, resize, signal, kill, killMany, list, attach };
export default Pty;
