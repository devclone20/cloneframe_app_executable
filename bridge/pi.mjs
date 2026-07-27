// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — pi
//
// The raw Pi coding agent (@earendil-works/pi-coding-agent) as the app's first-class
// agent. This module: (1) installs & keeps in sync the CLONE FRAME agent WORKSPACE
// (~/.clone-frame-hub/agent — AGENTS.md curriculum + .pi/{settings,extensions,skills})
// mirrored from the bundle; (2) exposes status + a launcher installer; (3) runs a
// long-lived `pi --mode rpc` process per CODE session and streams its answer + tool
// activity back to the chat as NDJSON (handlePiChat, wired at POST /pi-chat).
//
// BYOK is preserved: Pi thinks on the OWNER's own model (its ~/.pi/agent/auth.json, set by
// `pi /login`) — this module never passes or stores a key. The one hard limit (anti-wipe on
// bash) lives in the `clone-frame` extension, not here. Zero npm deps — Node built-ins only.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));            // …/bridge
const BUNDLE = path.resolve(HERE, '..');                             // app bundle root
const WORKSPACE_SRC = path.join(BUNDLE, 'agent');                    // shipped source of truth
const CONFIG_DIR = path.join(os.homedir(), '.clone-frame-hub');
const WORKSPACE = path.join(CONFIG_DIR, 'agent');                    // installed runtime copy (pi's cwd)
const EXT = path.join(WORKSPACE, '.pi', 'extensions', 'clone-frame.ts');
const BIN_DIR = path.join(CONFIG_DIR, 'bin');
const LAUNCHER = path.join(BIN_DIR, 'pi-clone');

// ── locate the pi binary (PATH, then the common Homebrew spots) ───────────────
let _piBin = null;
function piBin() {
  if (_piBin !== null) return _piBin;
  const found = spawnSync('/bin/sh', ['-lc', 'command -v pi || true'], { encoding: 'utf8' });
  let p = (found.stdout || '').trim().split('\n').filter(Boolean)[0] || '';
  if (!p) for (const c of ['/opt/homebrew/bin/pi', '/usr/local/bin/pi']) { try { fs.accessSync(c, fs.constants.X_OK); p = c; break; } catch {} }
  _piBin = p || 'pi';
  return _piBin;
}
function piVersion() {
  try { const r = spawnSync(piBin(), ['--version'], { encoding: 'utf8', timeout: 5000 }); return (r.stdout || '').trim() || null; } catch { return null; }
}

// ── install / keep the agent workspace in step with the bundle ────────────────
// The bundle's agent/ is the source of truth; the runtime copy is what pi actually runs in.
// Copy when missing or when the bundle's AGENTS.md is newer (an app update ships a new
// curriculum / extension). Cheap — a handful of small files.
// Newest mtime anywhere under a dir — so a change to ANY bundle file (extension, settings,
// skills, curriculum) is detected, not just AGENTS.md (that earlier bug shipped a stale extension).
function newestMtime(dir) {
  let max = 0; const stack = [dir];
  while (stack.length) {
    const c = stack.pop(); let st; try { st = fs.statSync(c); } catch { continue; }
    if (st.isDirectory()) { let names; try { names = fs.readdirSync(c); } catch { continue; } for (const n of names) stack.push(path.join(c, n)); }
    else if (st.mtimeMs > max) max = st.mtimeMs;
  }
  return max;
}
function ensureWorkspace() {
  try {
    if (!fs.existsSync(WORKSPACE_SRC)) return { ok: false, error: 'bundle agent/ missing' };
    // cpSync stamps dest files with the copy time, so the workspace AGENTS.md mtime is a
    // reliable "last sync" marker; if any bundle file is newer, re-sync the whole tree. cpSync
    // overwrites matching files but never deletes dest-only files, so a user's pi-written
    // .pi/APPEND_SYSTEM.md (their soul) survives.
    let stale = true;
    try { stale = newestMtime(WORKSPACE_SRC) > fs.statSync(path.join(WORKSPACE, 'AGENTS.md')).mtimeMs; } catch { stale = true; }
    if (stale) { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); fs.cpSync(WORKSPACE_SRC, WORKSPACE, { recursive: true, force: true }); }
    return { ok: true, workspace: WORKSPACE, extension: EXT };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// ── the iT launcher: type `pi-clone` in an iT shell to open the raw pi agent in the
// CLONE FRAME workspace (trusted, with the clone-frame extension + AGENTS.md). ~/.clone-frame-hub/bin
// is already on the iT PATH, so `it` (and this) are reachable from inside pi's bash too.
function installLauncher() {
  try {
    ensureWorkspace();
    fs.mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
    const sh = `#!/bin/sh\n`
      + `# CLONE FRAME — launch the raw Pi agent in the app workspace (name·iNFT·Pi, YOLO w/ anti-wipe).\n`
      + `export PATH="${BIN_DIR}:$PATH"\n`
      + `cd "${WORKSPACE}" || exit 1\n`
      + `exec "${piBin()}" -a -e "${EXT}" "$@"\n`;
    fs.writeFileSync(LAUNCHER, sh, { mode: 0o755 });
    return { ok: true, path: LAUNCHER };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// ── status for Settings ───────────────────────────────────────────────────────
function webAccessInstalled() {
  try { return fs.existsSync(path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', 'pi-web-access')); } catch { return false; }
}
// Pi's OWN default LLM (BYOK) — read cheaply from pi's settings. This is what the "pi" picker
// entry shows; a CODE session running an owner-picked provider model shows that model's own
// label instead (routed via CFHUB_PI_* — see resolveModel). Never touches the key.
function piModel() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8'));
    return { model: s.defaultModel || null, provider: s.defaultProvider || null };
  } catch { return { model: null, provider: null }; }
}

// Resolve the CODE picker value → pi model config. 'pi'/'' → pi's own default (no provider
// env). 'providerId::modelId' → the app provider's endpoint/key (via Models._streamConfig),
// passed to pi as an ephemeral registered provider (the clone-frame extension wires it).
async function resolveModel(picked) {
  const p = String(picked || '');
  const i = p.indexOf('::');
  if (!p || p === 'pi' || i < 0) return { key: '__pi__', spec: null, model: null, provider: null };
  const providerId = p.slice(0, i), modelId = p.slice(i + 2);
  let cfg = null;
  try { const M = await import('./models.mjs'); const Models = M.Models || M.default || M; cfg = Models._streamConfig && Models._streamConfig(providerId); } catch {}
  if (!cfg || !modelId) return { key: '__pi__', spec: null, model: null, provider: null };
  const anthropic = !!cfg.anthropic;
  let base = String(cfg.baseUrl || (anthropic ? 'https://api.anthropic.com' : '')).replace(/\/+$/, '');
  if (anthropic) base = base.replace(/\/v\d+$/, '');                 // pi's anthropic-messages appends /v1/messages
  else if (base && !/\/v\d+$/.test(base)) base += '/v1';            // openai-completions wants the /vN base
  return {
    key: p, model: modelId, provider: cfg.provider || providerId,
    spec: { baseUrl: base || (anthropic ? 'https://api.anthropic.com' : ''), api: anthropic ? 'anthropic-messages' : 'openai-completions', model: modelId, apiKey: cfg.apiKey || 'none' },
  };
}

// A per-model ISOLATED agent dir. Pi persists the resolved model to its config on every run —
// so a provider session runs in this throwaway dir, and the owner's global ~/.pi config is
// NEVER mutated. models.json defines the picked provider (key resolved from $CFHUB_PI_APIKEY at
// request time — never on disk); shared resources (pi-web-access packages, logins, model cache)
// are symlinked in from the real dir so they still work.
function buildRuntimeDir(modelKey, spec) {
  const safe = String(modelKey).replace(/[^\w.-]/g, '_').slice(0, 80) || 'model';
  const rt = path.join(CONFIG_DIR, 'pi-runtime', safe);
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(rt, 'models.json'), JSON.stringify({ providers: { cfhub: {
    baseUrl: spec.baseUrl, api: spec.api, apiKey: '$CFHUB_PI_APIKEY', authHeader: true,
    models: [{ id: spec.model, name: spec.model, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
  } } }, null, 2));
  let ubase = {};
  try { ubase = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8')); } catch {}
  fs.writeFileSync(path.join(rt, 'settings.json'), JSON.stringify({ theme: ubase.theme, enableSkillCommands: ubase.enableSkillCommands !== false, packages: ubase.packages || ['npm:pi-web-access'], defaultProvider: 'cfhub', defaultModel: spec.model, defaultThinkingLevel: 'off' }, null, 2));
  for (const l of ['npm', 'auth.json', 'models-store.json']) {
    const s = path.join(os.homedir(), '.pi', 'agent', l), d = path.join(rt, l);
    try { if (fs.existsSync(s) && !fs.existsSync(d)) fs.symlinkSync(s, d); } catch {}
  }
  return rt;
}
function status() {
  const version = piVersion();
  const m = piModel();
  return {
    ok: true,
    installed: !!version, version,
    bin: piBin(),
    workspace: fs.existsSync(path.join(WORKSPACE, 'AGENTS.md')),
    workspacePath: WORKSPACE,
    extension: fs.existsSync(EXT),
    launcher: fs.existsSync(LAUNCHER),
    webAccess: webAccessInstalled(),
    model: m.model, provider: m.provider,
    sessions: SESSIONS.size,
  };
}

// Install everything the app needs for pi (idempotent) — called from Settings and at boot.
function install() {
  const w = ensureWorkspace();
  const l = installLauncher();
  purgeOrphanScratch();
  return { ok: w.ok && l.ok, workspace: w, launcher: l, status: status() };
}

// ═════════════════════════════════════════════════════════════════════════════
// Long-lived `pi --mode rpc` sessions — one per CODE session id.
// ═════════════════════════════════════════════════════════════════════════════
const SESSIONS = new Map();       // sessionId → PiSession
const IDLE_MS = 30 * 60 * 1000;   // reap a session process after 30 min idle
const MAX_SESSIONS = 8;

function jsonl(obj) { return JSON.stringify(obj) + '\n'; }

class PiSession {
  constructor(id) {
    this.id = id;
    this.proc = null;
    this.buf = '';
    this.res = null;        // the streaming HTTP response of the in-flight turn
    this.seq = 0;
    this.lastUsed = Date.now();
    this.modelKey = '__pi__'; // which LLM this process is bound to ('__pi__' = pi's own default)
    this.piSid = null;        // pi's own session id (from the get_state handshake) — names its on-disk residue
    this.model = null; this.provider = null; this.spec = null;
    this.waiting = new Map(); // id → pending request() round-trip
    this.quietT = null;       // extension-command completion timer (see _armQuietEnd)
  }
  spawn() {
    // BYOK. Default: pi runs on the owner's own model in their real ~/.pi. When the owner picked
    // a model in CODE (spec set), run in an ISOLATED agent dir (models.json defines it) so pi's
    // model persistence never touches their global config; the key goes via env, resolved on use.
    let extraArgs = [], relEnv = {};
    if (this.spec) {
      relEnv = { PI_CODING_AGENT_DIR: buildRuntimeDir(this.modelKey, this.spec), CFHUB_PI_APIKEY: this.spec.apiKey };
      extraArgs = ['--provider', 'cfhub', '--model', this.spec.model];
    }
    const env = { ...process.env, PATH: BIN_DIR + ':' + (process.env.PATH || ''), PI_SKIP_VERSION_CHECK: '1', ...relEnv };
    const p = spawn(piBin(), ['--mode', 'rpc', '--no-session', '-a', ...extraArgs, '-e', EXT], { cwd: WORKSPACE, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => this._onStdout(d));
    p.stderr.on('data', () => {}); // pi diagnostics; ignore (never surfaces keys)
    // Guard on `this.proc === p`: a deliberate respawn (model change) nulls this.proc first, so the
    // old process's exit must NOT tear down the (new) session.
    p.on('exit', () => { if (this.proc === p) { this._fail('the pi agent exited'); this.proc = null; SESSIONS.delete(this.id); } });
    p.on('error', (e) => { if (this.proc === p) { this._fail('could not start pi: ' + (e && e.message)); this.proc = null; SESSIONS.delete(this.id); } });
  }
  _onStdout(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      this._onEvent(ev);
    }
  }
  _write(frame) { if (this.res && !this.res.writableEnded) { try { this.res.write(jsonl(frame)); } catch {} } }
  _endTurn() { if (this.res && !this.res.writableEnded) { try { this.res.end(); } catch {} } this.res = null; }
  _fail(msg) { if (this.res) { this._write({ t: 'error', d: msg }); this._endTurn(); } }
  _onEvent(ev) {
    const type = ev && ev.type;
    if (type === 'message_update') {
      const a = ev.assistantMessageEvent;
      if (a && a.type === 'text_delta' && a.delta) this._write({ t: 'text', d: a.delta });
      return;
    }
    if (type === 'tool_execution_start') { this._write({ t: 'tool', phase: 'start', name: ev.toolName || 'tool', args: ev.args || {} }); return; }
    if (type === 'tool_execution_end') {
      let out = '';
      const c = ev.result && ev.result.content;
      if (Array.isArray(c)) out = c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
      this._write({ t: 'tool', phase: 'end', name: ev.toolName || 'tool', ok: !ev.isError, result: String(out).slice(0, 600) });
      return;
    }
    if (type === 'extension_ui_request') {
      // notify() is fire-and-forget and carries the ONLY output a slash command like
      // /goal or /subgoal ever produces — dropping it is what made those commands look
      // dead in CODE. Show it; answer nothing (pi expects no response for notify).
      if (ev.method === 'notify') {
        if (this.booting) return; // extensions announce themselves as they load — not the owner's answer
        this._live(); this._write({ t: 'text', d: String(ev.message || '') + '\n' }); return;
      }
      // The others block pi until answered in RPC mode. The bridge relay has no human at
      // the keyboard, so auto-cancel/deny — never leave the agent hanging.
      const method = ev.method;
      const value = method === 'confirm' ? false : (method === 'input' ? '' : null);
      if (this.proc && this.proc.stdin.writable) { try { this.proc.stdin.write(jsonl({ type: 'extension_ui_response', id: ev.id, value })); } catch {} }
      return;
    }
    if (type === 'response') {
      const p = this.waiting.get(ev.id);
      if (p) { this.waiting.delete(ev.id); clearTimeout(p.timer); p.resolve(ev); return; }
      // A prompt that pi handled as an EXTENSION COMMAND runs no agent turn at all, so
      // agent_settled never comes. Without this the stream hung forever (/subgoal: 34s of
      // silence). Arm a short quiet-timer here; any agent activity cancels it.
      if (ev.command === 'prompt') {
        if (ev.success === false) { this._write({ t: 'error', d: String(ev.error || 'pi refused the prompt') }); this._endTurn(); return; }
        this._armQuietEnd();
      }
      return;
    }
    if (type === 'error') { this._write({ t: 'error', d: String((ev.error && ev.error.message) || ev.message || 'error') }); return; }
    if (type === 'agent_settled') { this._live(); this._write({ t: 'done' }); this._endTurn(); return; }
    if (type === 'agent_start' || type === 'agent_end' || type === 'message_update') this._live();
  }

  // ── turn-completion safety net ───────────────────────────────────────────────
  // A turn ends on agent_settled. Extension commands never emit it, so we close the
  // stream once the command has had time to speak (its notify text is already through).
  _armQuietEnd(ms = 2500) {
    this._clearQuiet();
    this.quietT = setTimeout(() => { this.quietT = null; if (this.res) { this._write({ t: 'done' }); this._endTurn(); } }, ms);
  }
  _clearQuiet() { if (this.quietT) { clearTimeout(this.quietT); this.quietT = null; } }
  _live() { this._clearQuiet(); } // real agent activity → this is a normal turn after all

  // One request/response round-trip on the same RPC channel (get_commands, get_state…).
  async request(type, extra = {}, timeoutMs = 4000) {
    await this.ensureUp();
    return this._req(type, extra, timeoutMs);
  }
  async _req(type, extra = {}, timeoutMs = 4000) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('pi is not running');
    const id = 'r' + (++this.seq);
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(type + ' timed out')); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
    });
    try { this.proc.stdin.write(jsonl({ id, type, ...extra })); } catch (e) { this.waiting.delete(id); throw e; }
    return p;
  }
  async ensureUp() {
    if (this.proc) return;
    this.spawn();
    // Handshake instead of a hopeful sleep: pi answers get_state only once it is actually
    // reading stdin, and the extensions announce themselves (notify) during this window —
    // which is exactly the noise the owner must never see in their first reply.
    this.booting = true;
    // The handshake also hands back pi's OWN session id — the key every on-disk
    // artifact this run writes is named after (goal.<sid>.json). Remember it so
    // end() can erase exactly this conversation's residue and nothing else.
    try { const r = await this._req('get_state', {}, 8000); const sid = r && r.data && r.data.sessionId; if (sid) this.piSid = String(sid); }
    catch { /* old pi / slow boot: continue anyway */ }
    this.booting = false;
  }
  async prompt(res, message, resolved, images) {
    this.lastUsed = Date.now();
    if (this.res) { try { res.write(jsonl({ t: 'error', d: 'the agent is still finishing the previous turn' })); res.end(); } catch {} return; }
    resolved = resolved || { key: '__pi__', env: {}, model: null, provider: null };
    // Model switch → respawn this session's pi on the new engine. Fresh context (the browser
    // keeps the visible history). Null this.proc BEFORE killing so the exit guard skips it.
    if (this.proc && this.modelKey !== resolved.key) { const old = this.proc; this.proc = null; try { old.kill('SIGTERM'); } catch {} this.buf = ''; purgeSid(this.piSid); this.piSid = null; }
    this.modelKey = resolved.key; this.model = resolved.model; this.provider = resolved.provider; this.spec = resolved.spec || null;
    this.res = res;
    res.on('close', () => { if (this.res === res) { this.res = null; if (this.proc && this.proc.stdin.writable) { try { this.proc.stdin.write(jsonl({ type: 'abort' })); } catch {} } } });
    try { await this.ensureUp(); } catch (e) { this._fail('could not start pi: ' + ((e && e.message) || e)); return; }
    if (!this.proc || !this.proc.stdin.writable) { this._fail('pi is not running'); return; }
    const cmd = { id: 'p' + (++this.seq), type: 'prompt', message: String(message || '') };
    if (Array.isArray(images) && images.length) cmd.images = images; // pi RPC: prompt.images?: ImageContent[]
    try { this.proc.stdin.write(jsonl(cmd)); } catch (e) { this._fail('write failed: ' + ((e && e.message) || e)); }
  }
  stop() { this._clearQuiet(); try { if (this.proc) this.proc.kill('SIGTERM'); } catch {} this.proc = null; this._endTurn(); }
}

// ── conversation residue ─────────────────────────────────────────────────────
// A CODE conversation's agent is a PROCESS: its whole context (transcript, tool
// state, compaction buffers) lives in that process's memory and dies with it —
// pi runs with --no-session, so nothing of it is ever written to disk. What DOES
// survive a run are the per-session scratch files extensions write into the
// workspace, all named after pi's session id (goal.<sid>.json). Closing the
// conversation erases them; a conversation never leaves a trace behind it.
function purgeSid(sid) {
  const s = String(sid || '');
  if (!/^[\w-]{8,80}$/.test(s)) return 0;      // never let a caller-shaped string reach unlink
  let n = 0;
  for (const f of [`goal.${s}.json`]) {
    const p = path.join(WORKSPACE, '.pi', f);
    try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); n++; } } catch { /* already gone */ }
  }
  return n;
}
// Sweep scratch files no live conversation claims — residue of runs the app never
// got to close (crash, kill -9, a bridge restart mid-turn). Called on install().
function purgeOrphanScratch() {
  const live = new Set([...SESSIONS.values()].map((s) => s.piSid).filter(Boolean));
  let n = 0;
  try {
    for (const f of fs.readdirSync(path.join(WORKSPACE, '.pi'))) {
      const m = /^goal\.([\w-]+)\.json$/.exec(f);
      if (!m || live.has(m[1])) continue;
      try { fs.rmSync(path.join(WORKSPACE, '.pi', f), { force: true }); n++; } catch { /* raced */ }
    }
  } catch { /* no workspace yet */ }
  return n;
}

// idle sweeper
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of SESSIONS) if (!s.res && now - s.lastUsed > IDLE_MS) { s.stop(); SESSIONS.delete(id); }
}, 5 * 60 * 1000).unref();

function sessionFor(id) {
  let s = SESSIONS.get(id);
  if (!s) {
    if (SESSIONS.size >= MAX_SESSIONS) { // evict the oldest idle one
      let oldest = null; for (const [, v] of SESSIONS) if (!v.res && (!oldest || v.lastUsed < oldest.lastUsed)) oldest = v;
      if (oldest) { oldest.stop(); SESSIONS.delete(oldest.id); }
    }
    s = new PiSession(id); SESSIONS.set(id, s);
  }
  return s;
}

// POST /pi-chat  { session, message }  → NDJSON stream of {t:'text'|'tool'|'error'|'done', …}
async function handlePiChat(req, res, body, { streamHead }) {
  const st = install(); // idempotent: workspace + launcher present before we spawn
  if (!piVersion()) { res.writeHead(501, { 'Content-Type': 'text/plain' }); res.end('pi is not installed — `npm i -g @earendil-works/pi-coding-agent`'); return; }
  if (!st.workspace || !st.workspace.ok) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('could not install the CLONE FRAME agent workspace'); return; }
  const id = String((body && body.session) || 'default').slice(0, 64);
  const message = (body && body.message) || '';
  if (!String(message).trim()) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty message'); return; }
  streamHead(res);
  const resolved = await resolveModel(body && body.model);
  sessionFor(id).prompt(res, message, resolved, _cleanImages(body && body.images));
}

// Owner-pasted images ride the prompt as pi RPC ImageContent[] — max 5, image/* only,
// ~8MB decoded each (12M base64 chars). Anything else is dropped, never trusted.
function _cleanImages(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list.slice(0, 5)) {
    if (!x || typeof x !== 'object') continue;
    const data = String(x.data || '');
    const mime = String(x.mimeType || '');
    if (!data || data.length > 12_000_000) continue;
    if (!/^image\/[\w.+-]+$/.test(mime)) continue;
    out.push({ type: 'image', data, mimeType: mime });
  }
  return out;
}

function stop(id) { const s = SESSIONS.get(String(id || '')); if (s) { s.stop(); SESSIONS.delete(s.id); } return { ok: true }; }

// The conversation was closed in CODE: end its agent for good. The process dies
// (with it every byte of context it held), its scratch is erased, and the id is
// released — so re-opening or starting a conversation always boots a NEW agent
// rather than resuming a half-remembered one. Idempotent: closing a conversation
// that never spoke is a no-op that still answers ok.
function end({ id } = {}) {
  const key = String(id || '');
  const s = SESSIONS.get(key);
  const sid = s && s.piSid;
  if (s) { s.stop(); SESSIONS.delete(key); }
  return { ok: true, ended: !!s, purged: purgeSid(sid) };
}

// ── Fleet: an ISOLATED throwaway runtime for a spawned sub-agent (fleet.ts). ────────────────
// Resolve the agent's model CLASS → the owner's BYOK provider, build a throwaway
// PI_CODING_AGENT_DIR (so a child's --model never mutates the owner's global ~/.pi), and hand
// back the provider/model flags + the key BY ENV ONLY. Never returns the real ~/.pi.
function readAgentClass(agentName) {
  try {
    const safe = String(agentName || '').replace(/[^\w.-]/g, '');
    const raw = fs.readFileSync(path.join(WORKSPACE, '.pi', 'agents', safe + '.md'), 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const mm = fm && fm[1].match(/^\s*model\s*:\s*(.+)$/m);
    if (mm) return mm[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* default below */ }
  return 'free';
}
// The ONE place fleet classes bind to the owner's models. Wire to the app registry / MATRIX-EXO
// cluster via an optional Models.resolveFleetClass hook; until it exists, every class falls back
// to the owner's own pi login (BYOK) — the fleet works immediately, just without tier splitting.
async function resolveFleetClass(cls) {
  try { const M = await import('./models.mjs'); const Models = M.Models || M.default || M; if (Models.resolveFleetClass) return await Models.resolveFleetClass(cls); } catch { /* fall through */ }
  return 'pi';
}
async function buildFleetRuntime(opts) {
  try {
    const cls = (opts && opts.class) || readAgentClass(opts && opts.agent);
    const picked = (opts && opts.model) || await resolveFleetClass(cls);
    const resolved = await resolveModel(picked);
    if (!resolved.spec) return { ok: true, dir: null, env: {}, provider: null, model: null, class: cls };
    const rt = buildRuntimeDir('fleet-' + resolved.key, resolved.spec);
    return { ok: true, dir: rt, env: { CFHUB_PI_APIKEY: resolved.spec.apiKey }, provider: 'cfhub', model: resolved.spec.model, class: cls };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// The slash commands pi ACTUALLY has right now — extension commands (/goal, /subgoal),
// prompt templates and skills. CODE used to carry a hand-written list that drifted from
// reality: goal.ts was built, registered and invisible. Asking the agent is the only
// listing that cannot go stale. Cached briefly; a cold call spawns pi once.
let CMD_CACHE = { at: 0, list: [] };
async function commands({ fresh = false } = {}) {
  if (!fresh && CMD_CACHE.list.length && Date.now() - CMD_CACHE.at < 60_000) return { ok: true, commands: CMD_CACHE.list, cached: true };
  const live = [...SESSIONS.values()].find((x) => x.proc && !x.res);
  const s = live || sessionFor('__commands__');
  try {
    const r = await s.request('get_commands');
    const list = ((r && r.data && r.data.commands) || []).filter((c) => c && c.name);
    if (list.length) CMD_CACHE = { at: Date.now(), list };
    return { ok: true, commands: list };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), commands: CMD_CACHE.list };
  }
}

// ── the agent's real brain, READ OFF DISK ────────────────────────────────────
// The BRAIN panel used to show four hand-written "fabric patterns" that existed
// nowhere but in that array, and a store nothing ever read. The only listing that
// cannot go stale is the one taken from the files the agent actually loads.
//
// Two skill roots, and the difference matters to the owner:
//   HUB    ~/.clone-frame-hub/agent/.pi/skills   — installed with CLONE FRAME, the
//          crafts this app taught its agent. Refreshed from the bundle on install.
//   GLOBAL ~/.pi/agent/skills                    — the owner's own, or another
//          project's; pi loads them everywhere, not just here.
const SKILL_ROOTS = [
  { source: 'hub', dir: path.join(WORKSPACE, '.pi', 'skills') },
  { source: 'global', dir: path.join(os.homedir(), '.pi', 'agent', 'skills') },
];
const EXT_DIR = path.join(WORKSPACE, '.pi', 'extensions');

// SKILL.md frontmatter: a leading --- block with `name:` and `description:`.
// Deliberately not a YAML parser — the contract is two scalar fields, and a skill
// with a malformed header should degrade to its folder name, never throw.
function readSkill(dir, name, source) {
  const file = path.join(dir, name, 'SKILL.md');
  let head = '';
  try { head = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return null; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  const field = (k) => {
    const m = fm && new RegExp('^' + k + ':\\s*(.+)$', 'm').exec(fm[1]);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  let bytes = 0; try { bytes = fs.statSync(file).size; } catch {}
  return {
    id: source + ':' + name,
    name: field('name') || name,
    folder: name,
    description: field('description'),
    tools: field('allowed-tools'),
    source,
    bytes,
  };
}

/**
 * Everything the owner's agent actually carries, detected from disk.
 * No stored state, no seeds — call it and it reflects the machine right now.
 * @returns {Promise<{ok:true, installed:boolean, version:string|null, skills:Array, extensions:Array, commands:Array, curriculum:{present:boolean,bytes:number}, roots:Array}>}
 */
async function brain() {
  const skills = [];
  const roots = [];
  const issues = [];
  for (const { source, dir } of SKILL_ROOTS) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
    roots.push({ source, dir, count: 0, present: names.length > 0 });
    for (const n of names.sort()) {
      const s = readSkill(dir, n, source);
      if (s) { skills.push(s); roots[roots.length - 1].count++; continue; }
      // A folder with no SKILL.md is not a skill pi can load. Silently skipping it hid the
      // problem from the only person who can fix it — so it is REPORTED instead, with the
      // path and what is inside, and the panel offers to write the missing header.
      let has = [];
      try { has = fs.readdirSync(path.join(dir, n)).slice(0, 8); } catch {}
      issues.push({ kind: 'no-skill-md', folder: n, source, dir: path.join(dir, n), contains: has });
    }
  }
  // Everything else pi carries, by topic. Counted, never invented: an empty category is
  // reported as empty rather than dropped, so the panel can show the whole shape.
  const countDir = (d, filter) => {
    try { return fs.readdirSync(d).filter((f) => !f.startsWith('.') && (!filter || filter(f))); } catch { return []; }
  };
  const PI_HOME = path.join(WORKSPACE, '.pi');
  const assets = {
    agents: countDir(path.join(PI_HOME, 'agents'), (f) => f.endsWith('.md')),
    dormant: countDir(path.join(PI_HOME, 'dormant'), (f) => f.endsWith('.ts')),
    guardrails: countDir(path.join(PI_HOME, 'guardrails')),
    themes: countDir(path.join(PI_HOME, 'themes'), (f) => f.endsWith('.json')),
    packages: countDir(path.join(PI_HOME, 'npm', 'node_modules'), (f) => !f.startsWith('.')),
  };
  const extensions = [];
  try {
    for (const f of fs.readdirSync(EXT_DIR).sort()) {
      if (!f.endsWith('.ts')) continue;
      let bytes = 0; try { bytes = fs.statSync(path.join(EXT_DIR, f)).size; } catch {}
      extensions.push({ name: f.replace(/\.ts$/, ''), file: f, bytes });
    }
  } catch {}
  // The slash commands pi reports itself — asking it is the only listing that cannot
  // drift. But commands() COLD-SPAWNS pi when nothing is running, and a panel render
  // must never wait on a process start: the first call hung until it was killed.
  // Use a live session or a warm cache, and otherwise say the list is not loaded.
  let cmds = [];
  let cmdSource = 'none';
  const warm = CMD_CACHE.list.length && Date.now() - CMD_CACHE.at < 60_000;
  const live = [...SESSIONS.values()].some((x) => x.proc && !x.res);
  if (warm || live) {
    try {
      const c = await Promise.race([
        commands({}),
        new Promise((r) => setTimeout(() => r(null), 2500)), // never block the panel
      ]);
      if (c && c.commands) { cmds = c.commands; cmdSource = warm && !live ? 'cache' : 'live'; }
    } catch {}
  }
  if (!cmds.length && CMD_CACHE.list.length) { cmds = CMD_CACHE.list; cmdSource = 'cache'; }
  let curriculum = { present: false, bytes: 0 };
  try { const st = fs.statSync(path.join(WORKSPACE, 'AGENTS.md')); curriculum = { present: true, bytes: st.size }; } catch {}
  const s = status();
  return { ok: true, installed: !!s.installed, version: s.version || null, skills, extensions, commands: cmds, commandSource: cmdSource, curriculum, roots, assets, issues };
}

/**
 * Give a skill folder the SKILL.md it is missing, so pi will actually load it.
 * A folder without one is invisible to the agent no matter what is inside it; this writes
 * the two-field header pi needs and leaves the body pointing at whatever was already there.
 * Refuses anything that is not a direct child of a known skills root, and never overwrites.
 * @param {{folder:string, source:'hub'|'global'}} sel
 */
function repairSkill({ folder, source } = {}) {
  const root = SKILL_ROOTS.find((r) => r.source === source);
  if (!root) return { ok: false, error: 'unknown skills root' };
  const name = String(folder || '');
  // Path containment, not string trust: the folder name comes from the client.
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return { ok: false, error: 'invalid skill folder name' };
  const dir = path.join(root.dir, name);
  if (path.dirname(dir) !== root.dir) return { ok: false, error: 'refused — outside the skills root' };
  let inside = [];
  try { if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'not a folder' }; inside = fs.readdirSync(dir); }
  catch { return { ok: false, error: 'that folder is not there' }; }
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file)) return { ok: false, error: 'it already has a SKILL.md' };
  const title = name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const body = `---\nname: ${name}\ndescription: ${title} — describe here WHEN the agent should reach for this skill. pi reads this line to decide; write it as a trigger, not a title.\n---\n\n# ${title}\n\nThis header was written by CLONE FRAME so pi can load the folder at all — it had files\nbut no SKILL.md, which makes a skill invisible to the agent.\n\nReplace this body with what the skill actually does and how to use it.\n\nFiles already in this folder:\n\n${inside.map((f) => `- \`${f}\``).join('\n') || '- (none)'}\n`;
  try { fs.writeFileSync(file, body, { mode: 0o644 }); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  return { ok: true, path: file, name };
}

export const Pi = { status, install, installLauncher, ensureWorkspace, stop, end, commands, brain, repairSkill, handlePiChat, buildFleetRuntime, _paths: { WORKSPACE, EXT, LAUNCHER } };
export default Pi;
