// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — Tmux Orchestrator (agent-crew control-plane)
// Adapted control-plane for Tmux-Orchestrator (github.com/Jedward23/Tmux-Orchestrator, MIT).
// It has NO web UI / port — it's a pattern over `tmux send-keys`. So this drives tmux
// directly and the INTEGRATIONS tab renders a NATIVE control panel (no iframe).
//
// THE BOUNDARY: the browser never runs tmux. It speaks only POST /mod/tmuxorch {fn,args}.
// SECURITY: every tmux call is spawn('tmux', argv, {shell:false}) — arg arrays only, no
// shell, no string interpolation. All crew sessions are namespaced `cf-*`; kill/list are
// hard-scoped to cf-* (never kill-server, never touches the user's own sessions). Session/
// window/target names are validated against a strict charset before any command. send() uses
// send-keys -l (literal) + a separate Enter. Zero deps: node built-ins only. Never throws.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(BRIDGE_DIR);

function _config() {
  const HOME = path.join(ROOT, 'integrations', 'tmux-orchestrator');
  const RUNTIME = path.join(os.homedir(), '.clone-frame-hub');
  return {
    ROOT, HOME, RUNTIME,
    SRC: path.join(HOME, 'src'),
    INSTALL_SH: path.join(HOME, 'install.sh'),
    LOG: path.join(HOME, '.tmuxorch.log'),
    CHECKINS: path.join(RUNTIME, 'tmuxorch.json'),
  };
}

// ── tmux primitive: spawn('tmux', argv, {shell:false}) — capped, timed, never rejects ────
const _TMUX_PATHS = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
function _tmuxBin() { for (const p of _TMUX_PATHS) { try { if (fs.existsSync(p)) return p; } catch {} } return 'tmux'; }
function _tmux(args, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    let out = '', done = false, child;
    try { child = spawn(_tmuxBin(), args, { shell: false, windowsHide: true }); }
    catch (e) { resolve({ code: -1, out: String(e && e.message || e) }); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    const fin = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code: code == null ? -1 : code, out }); };
    const grab = (d) => { if (out.length < 262144) out += d.toString('utf8'); };
    if (child.stdout) child.stdout.on('data', grab);
    if (child.stderr) child.stderr.on('data', grab);
    child.on('error', () => fin(-1));
    child.on('close', (code) => fin(code));
  });
}

// ── strict validation (the injection firewall) ───────────────────────────────
const _RE = /^[A-Za-z0-9_-]{1,40}$/;
function _okName(s) { return typeof s === 'string' && _RE.test(s) && s[0] !== '-'; }
function _slug(project) {
  const s = String(project || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34);
  return s ? 'cf-' + s : null;
}
function _okSession(s) { return typeof s === 'string' && s.startsWith('cf-') && _okName(s); }
function _okTarget(t) {
  if (typeof t !== 'string') return false;
  const [sess, rest] = t.split(':');
  if (!_okSession(sess)) return false;
  if (rest == null) return true;
  const win = rest.split('.')[0];
  return _okName(win) || /^[0-9]{1,3}$/.test(win);
}
function _okCwd(cwd) { try { if (cwd && path.isAbsolute(cwd) && fs.existsSync(cwd)) return cwd; } catch {} return os.homedir(); }
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── detached install job (mirror exo/manaflow) ───────────────────────────────
let jobState = { running: false, jobId: null };
function _step(logStream, file, args) {
  return new Promise((resolve) => {
    logStream.write('\n$ ' + file + ' ' + args.join(' ') + '\n');
    let child;
    try { child = spawn(file, args, { shell: false, windowsHide: true, cwd: _config().HOME }); }
    catch (e) { logStream.write('spawn error: ' + e.message + '\n'); resolve(-1); return; }
    if (child.stdout) child.stdout.pipe(logStream, { end: false });
    if (child.stderr) child.stderr.pipe(logStream, { end: false });
    child.on('error', (e) => { logStream.write('error: ' + e.message + '\n'); resolve(-1); });
    child.on('close', (code) => resolve(code == null ? -1 : code));
  });
}
function _runJob(kind, task) {
  if (jobState.running) return { ok: false, error: 'a job is already running', jobId: jobState.jobId };
  const jobId = randomBytes(6).toString('hex');
  jobState = { running: true, jobId };
  (async () => {
    let logStream = null;
    try {
      fs.mkdirSync(_config().HOME, { recursive: true });
      logStream = fs.createWriteStream(_config().LOG, { flags: 'a' });
      logStream.on('error', () => {});
      logStream.write('\n[' + kind + '] job ' + jobId + ' started ' + new Date().toISOString() + '\n');
      await task(logStream);
      logStream.write('\n[' + kind + '] finished\n');
    } catch (e) { try { if (logStream) logStream.write('\n[' + kind + '] error: ' + String(e && e.message || e) + '\n'); } catch {} }
    finally { try { if (logStream) logStream.end(); } catch {} jobState = { running: false, jobId: null }; }
  })();
  return { ok: true, jobId };
}

// ── check-in registry (persisted, re-armed on boot) ──────────────────────────
const _timers = new Map();
function _readCheckins() { try { return JSON.parse(fs.readFileSync(_config().CHECKINS, 'utf8')); } catch { return []; } }
function _writeCheckins(list) { try { fs.mkdirSync(_config().RUNTIME, { recursive: true }); fs.writeFileSync(_config().CHECKINS, JSON.stringify(list), { mode: 0o600 }); } catch {} }
function _arm(c) {
  const ms = c.fireAt - Date.now();
  const fire = async () => { _timers.delete(c.id); const list = _readCheckins().filter((x) => x.id !== c.id); _writeCheckins(list); try { await send(c.target, 'CHECK-IN: ' + c.note); } catch {} };
  if (ms <= 0) { fire(); return; }
  const t = setTimeout(fire, Math.min(ms, 2147483000)); if (t.unref) t.unref(); _timers.set(c.id, t);
}

// ── public surface ───────────────────────────────────────────────────────────
async function detect() {
  try {
    const C = _config();
    const v = await _tmux(['-V'], { timeout: 3000 });
    const tmuxOk = v.code === 0;
    const srcPresent = fs.existsSync(path.join(C.SRC, '.git'));
    return { tmuxOk, installed: srcPresent, srcPresent, version: tmuxOk ? v.out.trim() : null };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function status() {
  try {
    const C = _config();
    const v = await _tmux(['-V'], { timeout: 3000 });
    const tmuxOk = v.code === 0;
    const srcPresent = fs.existsSync(path.join(C.SRC, '.git'));
    let count = 0;
    if (tmuxOk) { try { count = (await sessions()).length; } catch {} }
    return { tmuxOk, installed: srcPresent, sessions: count, version: tmuxOk ? v.out.trim() : null };
  } catch (e) { return { ok: false, error: e.message }; }
}
function install() {
  try { return _runJob('install', async (logStream) => { await _step(logStream, 'zsh', [_config().INSTALL_SH]); }); }
  catch (e) { return { ok: false, error: e.message }; }
}
// list ONLY cf-* crew sessions (never the user's own). "no server" ⇒ empty, not error.
async function sessions() {
  const r = await _tmux(['list-sessions', '-F', '#{session_name}|#{session_windows}|#{session_attached}|#{session_created}']);
  if (r.code !== 0) return [];
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, windows, attached, created] = l.split('|');
    return { name, windows: +windows || 0, attached: attached === '1', created: +created || 0 };
  }).filter((s) => _okSession(s.name));
}
async function windows(session) {
  if (!_okSession(session)) return { ok: false, error: 'invalid session' };
  const r = await _tmux(['list-windows', '-t', session, '-F', '#{window_index}|#{window_name}|#{window_active}|#{pane_current_command}|#{window_panes}']);
  if (r.code !== 0) return [];
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [index, name, active, cmd, panes] = l.split('|');
    return { index: +index || 0, name, active: active === '1', cmd: cmd || '', panes: +panes || 1 };
  });
}
async function newCrew(name, cwd, opts = {}) {
  try {
    const slug = _slug(name);
    if (!slug || !_okSession(slug)) return { ok: false, error: 'invalid crew name' };
    const dir = _okCwd(cwd);
    const engineers = Math.max(1, Math.min(6, Number(opts.engineers) || 2));
    // exists already?
    if ((await sessions()).some((s) => s.name === slug)) return { ok: false, error: 'crew ' + slug + ' already exists' };
    const c0 = await _tmux(['new-session', '-d', '-s', slug, '-n', 'Orchestrator', '-c', dir]);
    if (c0.code !== 0) return { ok: false, error: 'could not create session: ' + c0.out.trim() };
    await _tmux(['new-window', '-t', slug + ':', '-n', 'PM', '-c', dir]);
    for (let i = 1; i <= engineers; i++) await _tmux(['new-window', '-t', slug + ':', '-n', 'Eng' + i, '-c', dir]);
    return { ok: true, session: slug };
  } catch (e) { return { ok: false, error: e.message }; }
}
// two-step: literal text, pause, then a separate Enter (single call silently fails in TUIs).
async function send(target, text) {
  try {
    if (!_okTarget(target)) return { ok: false, error: 'invalid target' };
    if (typeof text !== 'string' || text.length > 8000) return { ok: false, error: 'bad text' };
    const a = await _tmux(['send-keys', '-l', '-t', target, '--', text]);
    if (a.code !== 0) return { ok: false, error: a.out.trim() || 'send failed' };
    await _sleep(600);
    const b = await _tmux(['send-keys', '-t', target, 'Enter']);
    return { ok: b.code === 0, target };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function capture(target, { lines = 200 } = {}) {
  try {
    if (!_okTarget(target)) return { ok: false, error: 'invalid target' };
    const n = Math.max(1, Math.min(2000, Number(lines) || 200));
    const r = await _tmux(['capture-pane', '-p', '-e', '-t', target, '-S', '-' + n]);
    return { ok: r.code === 0, text: r.out };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function kill(session) {
  try {
    if (!_okSession(session)) return { ok: false, error: 'refused — crews are cf-* only' };
    const r = await _tmux(['kill-session', '-t', session]);
    return { ok: r.code === 0, killed: session, error: r.code === 0 ? undefined : r.out.trim() };
  } catch (e) { return { ok: false, error: e.message }; }
}
function schedule(target, minutes, note) {
  try {
    if (!_okTarget(target)) return { ok: false, error: 'invalid target' };
    const min = Math.max(1, Math.min(1440, Number(minutes) || 0));
    if (!min) return { ok: false, error: 'bad minutes' };
    const id = randomBytes(5).toString('hex');
    const c = { id, target, fireAt: Date.now() + min * 60000, note: String(note || '').slice(0, 300) };
    const list = _readCheckins(); list.push(c); _writeCheckins(list); _arm(c);
    return { ok: true, id, fireAt: c.fireAt };
  } catch (e) { return { ok: false, error: e.message }; }
}
function listCheckins() { return _readCheckins().filter((c) => c.fireAt > Date.now()); }
function cancelCheckin(id) {
  try { const t = _timers.get(id); if (t) { clearTimeout(t); _timers.delete(id); } _writeCheckins(_readCheckins().filter((c) => c.id !== id)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}
function startScheduler() {
  try { const now = Date.now(); const list = _readCheckins().filter((c) => c.fireAt > now); _writeCheckins(list); list.forEach(_arm); return { ok: true, armed: list.length }; }
  catch (e) { return { ok: false, error: e.message }; }
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

export const TmuxOrch = { detect, status, install, sessions, windows, newCrew, send, capture, kill, schedule, listCheckins, cancelCheckin, startScheduler, logs };
export default TmuxOrch;
