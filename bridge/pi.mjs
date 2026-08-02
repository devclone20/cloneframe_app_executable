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
import crypto from 'node:crypto';
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

// ── the PATH every pi child needs ────────────────────────────────────────────
// pi is a Node CLI whose launcher opens with `#!/usr/bin/env node`. Finding the pi binary
// is therefore only half the job: the shebang has to find NODE, and a daemon launched from
// Finder inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) with no Homebrew in it.
// The result was silent and total — `pi --version` exited 127 with empty stdout, piVersion()
// read that as null, and the whole app concluded pi was NOT INSTALLED on a machine where it
// was installed and working. BRAIN told the owner to download it, the skills list took the
// not-installed early return and rendered nothing, and CODE fell back to the raw provider,
// so a model asked for its name answered with its OWN ("DeepSeek") instead of pi's.
//
// The node that must be found is not a guess: it is the one running this daemon.
function childPath() {
  const own = path.dirname(process.execPath);      // the node pi's shebang needs, by definition
  const seen = new Set(), out = [];
  for (const d of [BIN_DIR, own, '/opt/homebrew/bin', '/usr/local/bin',
                   ...String(process.env.PATH || '').split(':')]) {
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out.join(':');
}
const childEnv = (extra) => ({ ...process.env, PATH: childPath(), PI_SKIP_VERSION_CHECK: '1', ...(extra || {}) });

// ── locate the pi binary ─────────────────────────────────────────────────────
// The BUNDLED copy wins. pi is a dependency of bridge/package.json, so install.command's
// npm install puts it inside the .app next to ws and node-pty — which is what makes the
// agent arrive WITH the app instead of being a thing the owner must go and install first.
// A global pi stays a valid fallback for anyone who already had one.
const BUNDLED_PI = path.join(BUNDLE, 'bridge', 'node_modules', '.bin', 'pi');
let _piBin = null;
function piBin() {
  if (_piBin !== null) return _piBin;
  try { fs.accessSync(BUNDLED_PI, fs.constants.X_OK); _piBin = BUNDLED_PI; return _piBin; } catch {}
  // Ask a shell that can actually see the same PATH the children will get, or the lookup
  // disagrees with the launch and we resolve a binary we then fail to run.
  const found = spawnSync('/bin/sh', ['-lc', 'command -v pi || true'],
    { encoding: 'utf8', env: childEnv() });
  let p = (found.stdout || '').trim().split('\n').filter(Boolean)[0] || '';
  if (!p) for (const c of ['/opt/homebrew/bin/pi', '/usr/local/bin/pi']) { try { fs.accessSync(c, fs.constants.X_OK); p = c; break; } catch {} }
  _piBin = p || 'pi';
  return _piBin;
}
// Which pi answered, and whether it is ours — the Update button must never offer to upgrade
// a Homebrew install this app does not own.
const piBinInfo = () => ({ bin: piBin(), bundled: piBin() === BUNDLED_PI });
// `pi --version` is a process spawn (~350ms) that blocks the WHOLE daemon — every panel,
// every stream, every other session. handlePiChat called it twice per message. It answers the
// same thing until pi is upgraded, so cache it; a short TTL still notices an upgrade.
let _ver = { at: 0, v: null };
const VER_TTL = 60_000;
function piVersion() {
  if (_ver.at && Date.now() - _ver.at < VER_TTL) return _ver.v;
  let v = null;
  // A failure here is reported as "pi is not installed" across the whole app, so keep WHY.
  let why = null;
  try {
    const r = spawnSync(piBin(), ['--version'], { encoding: 'utf8', timeout: 5000, env: childEnv() });
    v = (r.stdout || '').trim() || null;
    if (!v) why = (r.stderr || '').trim() || (r.error && r.error.code) || ('exit ' + r.status);
  } catch (e) { v = null; why = e && e.message; }
  _ver = { at: Date.now(), v };
  _verWhy = v ? null : why;
  return v;
}
let _verWhy = null;
const piVersionError = () => _verWhy;

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
// Documents the OWNER may edit through the app (Pi.saveDoc) — an app update must never
// silently overwrite their words. We remember the hash of what WE last wrote; if the file on
// disk no longer matches it, the owner (or pi) changed it and it is theirs. `force:true`
// cpSync had no such notion: refreshTree() writes STRUCTURE.md into the bundle, which makes
// the whole tree "newer", which overwrote an edited AGENTS.md on the very next chat message.
const OWNED = ['AGENTS.md', path.join('.pi', 'APPEND_SYSTEM.md')];
const SYNC_STATE = path.join(CONFIG_DIR, 'agent-sync.json');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function readSyncState() { try { return JSON.parse(fs.readFileSync(SYNC_STATE, 'utf8')) || {}; } catch { return {}; } }
function writeSyncState(s) { try { fs.writeFileSync(SYNC_STATE, JSON.stringify(s, null, 2), { mode: 0o600 }); } catch { /* best effort */ } }
function ownerEdited(rel, state) {
  const dest = path.join(WORKSPACE, rel);
  let cur; try { cur = fs.readFileSync(dest); } catch { return false; }   // absent → nothing to protect
  const last = state[rel];
  return !last || sha(cur) !== last;                                      // no record OR diverged → theirs
}

// The mtime walk is ~2200 statSync calls. It ran on EVERY chat message (install() →
// ensureWorkspace) and blocked the daemon's single thread each time. The bundle only changes
// when the app is rebuilt, so a short TTL is honest; refreshTree() passes force.
let _wsCheck = 0;
const WS_TTL = 30_000;
function ensureWorkspace({ force = false } = {}) {
  try {
    if (!fs.existsSync(WORKSPACE_SRC)) return { ok: false, error: 'bundle agent/ missing' };
    if (!force && _wsCheck && Date.now() - _wsCheck < WS_TTL) return { ok: true, workspace: WORKSPACE, extension: EXT, cached: true };
    _wsCheck = Date.now();
    let stale = true;
    try { stale = newestMtime(WORKSPACE_SRC) > fs.statSync(path.join(WORKSPACE, 'AGENTS.md')).mtimeMs; } catch { stale = true; }
    if (!stale) return { ok: true, workspace: WORKSPACE, extension: EXT };
    const state = readSyncState();
    const kept = OWNED.filter((rel) => ownerEdited(rel, state));
    const skip = new Set(kept.map((rel) => path.join(WORKSPACE, rel)));
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    // cpSync overwrites matching files but never deletes dest-only files, so anything pi wrote
    // into the workspace survives; the filter additionally spares the owner's own documents.
    fs.cpSync(WORKSPACE_SRC, WORKSPACE, { recursive: true, force: true, filter: (_src, dest) => !skip.has(dest) });
    for (const rel of OWNED) {
      if (skip.has(path.join(WORKSPACE, rel))) continue;
      try { state[rel] = sha(fs.readFileSync(path.join(WORKSPACE, rel))); } catch { delete state[rel]; }
    }
    writeSyncState(state);
    ensureIdentity();   // a workspace without a name lets the model answer with the vendor's
    return { ok: true, workspace: WORKSPACE, extension: EXT, kept };
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
    // Only write when the content actually changes — this ran on every chat message.
    let cur = ''; try { cur = fs.readFileSync(LAUNCHER, 'utf8'); } catch {}
    if (cur !== sh) fs.writeFileSync(LAUNCHER, sh, { mode: 0o755 });
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
  let cfg = null, why = '';
  try { const M = await import('./models.mjs'); const Models = M.Models || M.default || M; cfg = Models._streamConfig && Models._streamConfig(providerId); }
  catch (e) { why = 'the model registry could not be read (' + ((e && e.message) || e) + ')'; }
  // An unresolvable pick used to fall through to pi's OWN default model: the picker said one
  // engine and a different one answered, with nothing anywhere to notice it. A model the owner
  // chose either runs or says why — it never gets silently swapped.
  if (!cfg) return { error: why || 'the provider "' + providerId + '" is no longer connected — pick a model again in the CODE picker' };
  if (!modelId) return { error: 'no model id in "' + p + '" — pick a model again in the CODE picker' };
  const anthropic = !!cfg.anthropic;
  let base = String(cfg.baseUrl || (anthropic ? 'https://api.anthropic.com' : '')).replace(/\/+$/, '');
  if (anthropic) base = base.replace(/\/v\d+$/, '');                 // pi's anthropic-messages appends /v1/messages
  // openai-completions wants the /vN base. Match a version segment ANYWHERE at the tail, not
  // only a bare trailing /vN: Google's base is `…/v1beta/openai`, and blindly appending made
  // every Gemini request 404 on `…/v1beta/openai/v1`.
  else if (base && !/\/v\d+[a-z]*(\/[^/]*)?$/i.test(base)) base += '/v1';
  return {
    key: p, model: modelId, provider: cfg.provider || providerId,
    spec: { baseUrl: base || (anthropic ? 'https://api.anthropic.com' : ''), api: anthropic ? 'anthropic-messages' : 'openai-completions', model: modelId, apiKey: cfg.apiKey || 'none', providerId },
  };
}

// A per-model ISOLATED agent dir. Pi persists the resolved model to its config on every run —
// so a provider session runs in this throwaway dir, and the owner's global ~/.pi config is
// NEVER mutated. models.json defines the picked provider (key resolved from $CFHUB_PI_APIKEY at
// request time — never on disk); shared resources (pi-web-access packages, logins, model cache)
// are symlinked in from the real dir so they still work.
// ── the LLM relay: pi never holds the owner's provider key ────────────────────
// pi runs bash with no sandbox (the owner's YOLO choice), and every child it spawns inherits
// its environment — so putting the real provider key in CFHUB_PI_APIKEY meant one injected
// `echo $CFHUB_PI_APIKEY` in any page pi reads could walk off with it. Instead pi gets a
// random LOOPBACK-ONLY capability: it talks to this bridge, and the bridge — which already
// holds the key — attaches it on the way out. Leaking the capability costs the owner nothing
// beyond this machine, and it dies with the session.
const RELAY = new Map();   // token → { baseUrl, apiKey, anthropic, providerId, sessionId }
const BRIDGE_ORIGIN = () => process.env.CFHUB_BRIDGE || ('http://127.0.0.1:' + (process.env.HUB_BRIDGE_PORT || 8765));
function mintRelay(sessionId, spec) {
  for (const [t, v] of RELAY) if (v.sessionId === sessionId) RELAY.delete(t);   // one live token per session
  const token = crypto.randomBytes(32).toString('hex');
  RELAY.set(token, { baseUrl: spec.baseUrl, apiKey: spec.apiKey, anthropic: spec.api === 'anthropic-messages', providerId: spec.providerId || '', sessionId });
  return token;
}
function dropRelay(sessionId) { for (const [t, v] of RELAY) if (v.sessionId === sessionId) RELAY.delete(t); }
// Forward one upstream call, swapping the capability for the real credential. Streams the
// response body straight through so token-by-token output keeps flowing.
async function handleRelay(req, res, rest) {
  const slash = rest.indexOf('/');
  const token = slash < 0 ? rest : rest.slice(0, slash);
  const tail = slash < 0 ? '' : rest.slice(slash);
  const cfg = RELAY.get(token);
  // Also accept the capability in the Authorization header (pi sends it there too) — but the
  // path token is what is matched, so an unknown token never reaches a provider.
  if (!cfg) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"unknown relay token"}'); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = { 'Content-Type': req.headers['content-type'] || 'application/json' };
  if (cfg.anthropic) { headers['x-api-key'] = cfg.apiKey; headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01'; }
  else headers.Authorization = 'Bearer ' + cfg.apiKey;
  if (req.headers.accept) headers.Accept = req.headers.accept;
  let up;
  try { up = await fetch(cfg.baseUrl + tail, { method: req.method, headers, body, duplex: 'half' }); }
  catch (e) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'the model provider could not be reached: ' + ((e && e.message) || e) })); return; }
  const out = { 'Content-Type': up.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-cache, no-transform' };
  res.writeHead(up.status, out);
  if (!up.body) { res.end(); return; }
  try { for await (const c of up.body) res.write(Buffer.from(c)); } catch { /* client left */ }
  res.end();
}

// What pi is told about the model. contextWindow/maxTokens used to be hardcoded 200k/8192 for
// EVERY provider model — long answers were cut at 8k output tokens and small-context models
// silently overran their real window. The registry knows better when it knows anything.
function modelLimits(spec) {
  const id = String(spec.model || '').toLowerCase();
  const ctx = /gpt-4o|o[1-4]|claude|gemini|llama-?3\.[123]|qwen|deepseek/.test(id) ? 200000 : 128000;
  const max = /claude|gpt-4o|gemini|o[1-4]/.test(id) ? 32000 : 8192;
  return { contextWindow: ctx, maxTokens: max };
}
// Sweep runtime directories nothing is using any more.
//
// `pi-runtime` appeared EXACTLY ONCE in the whole codebase — on the line that creates it.
// No cleanup on session end, none on daemon shutdown, none in the uninstaller unless the
// owner typed DELETE. A two-day-old models.json was still sitting there naming a relay
// token, in a design whose own words are "minted per session … dead when the session ends"
// (DEBUG4 · CF4-C-004). The token is dead after a restart, so this is residue rather than a
// live credential — but the owner's standard for this app is that closing something leaves
// nothing behind, and a stale file naming a capability is something.
//
// Conservative on purpose: only directories older than the cutoff, only ones not currently
// registered to a live session, and never the tree itself. Best-effort throughout.
const RUNTIME_TTL_MS = 24 * 60 * 60 * 1000;
function sweepRuntimeDirs(keep = new Set()) {
  const root = path.join(CONFIG_DIR, 'pi-runtime');
  let swept = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      if (keep.has(name)) continue;
      const dir = path.join(root, name);
      try {
        const st = fs.statSync(dir);
        if (!st.isDirectory()) continue;
        if (Date.now() - st.mtimeMs < RUNTIME_TTL_MS) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        swept++;
      } catch { /* in use, or gone already */ }
    }
  } catch { /* no runtime tree yet */ }
  return swept;
}

function buildRuntimeDir(modelKey, spec, relayToken) {
  const safe = String(modelKey).replace(/[^\w.-]/g, '_').slice(0, 80) || 'model';
  const rt = path.join(CONFIG_DIR, 'pi-runtime', safe);
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
  // Building one is the natural moment to retire the ones nobody came back for.
  try { sweepRuntimeDirs(new Set([safe])); } catch {}
  const lim = modelLimits(spec);
  // baseUrl points at THIS bridge; the real provider URL and key stay in the daemon.
  const base = relayToken ? (BRIDGE_ORIGIN() + '/llm/' + relayToken) : spec.baseUrl;
  // mode 0600. This file's baseUrl IS the session's relay capability, and it was written
  // with the process umask default — `-rw-r--r--`, world-readable — protected only by the
  // 0700 directory two levels above it. Every other secret-bearing file in this tree is
  // 0600; this one's safety was an accident of its parent (DEBUG4 · CF4-C-004).
  fs.writeFileSync(path.join(rt, 'models.json'), JSON.stringify({ providers: { cfhub: {
    baseUrl: base, api: spec.api, apiKey: '$CFHUB_PI_APIKEY', authHeader: true,
    models: [{ id: spec.model, name: spec.model, reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: lim.contextWindow, maxTokens: lim.maxTokens }],
  } } }, null, 2), { mode: 0o600 });
  let ubase = {};
  try { ubase = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8')); } catch {}
  fs.writeFileSync(path.join(rt, 'settings.json'), JSON.stringify({ theme: ubase.theme, enableSkillCommands: ubase.enableSkillCommands !== false, packages: ubase.packages || ['npm:pi-web-access'], defaultProvider: 'cfhub', defaultModel: spec.model, defaultThinkingLevel: 'off' }, null, 2), { mode: 0o600 });
  // Shared resources only. auth.json is deliberately NOT linked: it used to be symlinked
  // read-write, so pi persisting a model wrote THROUGH the link into the owner's global
  // credentials, and a provider-picked session could authenticate as any other login it found
  // there. This session's only credential is the relay token — it needs nothing from that file.
  for (const l of ['npm', 'models-store.json']) {
    const s = path.join(os.homedir(), '.pi', 'agent', l), d = path.join(rt, l);
    try { if (fs.existsSync(s) && !fs.existsSync(d)) fs.symlinkSync(s, d); } catch {}
  }
  try { fs.rmSync(path.join(rt, 'auth.json'), { force: true }); } catch {}   // retire the old link
  return rt;
}
function status() {
  const version = piVersion();
  const m = piModel();
  const state = readSyncState();
  return {
    ok: true,
    installed: !!version, version,
    bin: piBin(),
    // Ours (inside the .app) or the machine's own? The panel offers UPDATE only for ours, and
    // when pi will not run it needs the REASON, not another "not installed" (see childPath).
    bundled: piBinInfo().bundled,
    versionError: version ? null : piVersionError(),
    workspace: fs.existsSync(path.join(WORKSPACE, 'AGENTS.md')),
    workspacePath: WORKSPACE,
    extension: fs.existsSync(EXT),
    launcher: fs.existsSync(LAUNCHER),
    webAccess: webAccessInstalled(),
    model: m.model, provider: m.provider,
    sessions: SESSIONS.size,
    // Which shipped documents the owner has taken over — an app update leaves these alone,
    // so the panel can say "yours is kept" instead of the update silently losing or winning.
    ownEdited: OWNED.filter((rel) => ownerEdited(rel, state)),
  };
}

// Install everything the app needs for pi (idempotent) — called from Settings and at boot.
// `light` is the per-message path: it must not walk 2000 files, rewrite the launcher or sweep
// scratch on every single thing the owner types (that cost the whole daemon ~0.7s a message).
function install({ light = false } = {}) {
  const w = ensureWorkspace();
  const l = installLauncher();
  if (!light) purgeOrphanScratch();
  return { ok: w.ok && l.ok, workspace: w, launcher: l, status: light ? null : status() };
}

// ═════════════════════════════════════════════════════════════════════════════
// Long-lived `pi --mode rpc` sessions — one per CODE session id.
// ═════════════════════════════════════════════════════════════════════════════
const SESSIONS = new Map();       // sessionId → PiSession
const IDLE_MS = 30 * 60 * 1000;   // reap a session process after 30 min idle
const MAX_SESSIONS = 8;

function jsonl(obj) { return JSON.stringify(obj) + '\n'; }

// ── handing a fresh process the conversation it is joining ────────────────────
// A pi process holds a CODE conversation entirely in memory (--no-session, nothing on disk).
// Any of: first message, model switch, the 30-minute idle reaper, an LRU eviction, a bridge
// restart, or reopening a closed CODE window — starts a NEW process with no memory, while the
// panel keeps showing every turn. The agent then answered as if the conversation had never
// happened. The client sends the transcript; this frames it so pi treats it as its own past
// without re-running tools it already ran.
const HIST_CHARS = 24_000;      // newest-first budget; a long conversation keeps its tail
function historyPreamble(history) {
  if (!Array.isArray(history) || !history.length) return '';
  const rows = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || typeof m !== 'object') continue;
    const who = m.role === 'assistant' || m.role === 'ai' ? 'YOU' : m.role === 'user' ? 'OWNER' : '';
    if (!who) continue;
    let body = String(m.content == null ? '' : m.content).trim();
    if (!body) continue;
    if (body.length > 4000) body = body.slice(0, 4000) + '\n…[truncated]';
    const row = who + ': ' + body;
    if (used + row.length > HIST_CHARS) break;
    used += row.length;
    rows.unshift(row);
  }
  if (!rows.length) return '';
  const dropped = history.length - rows.length;
  return '<conversation_so_far>\n'
    + 'You are continuing an existing conversation with the owner. The exchange below is YOUR OWN'
    + ' memory of it — a previous process of yours held it and that process is gone, so it is'
    + ' replayed here. Treat it as what you already know and already did: do NOT redo tool calls'
    + ' whose results appear below, and do not greet the owner as if this were the first message.\n'
    + (dropped > 0 ? '(' + dropped + ' earlier turn' + (dropped === 1 ? '' : 's') + ' omitted for length.)\n' : '')
    + '\n' + rows.join('\n\n') + '\n</conversation_so_far>\n\nThe owner now says:\n\n';
}

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
    // A turn is a numbered thing. Without this, the late `agent_settled` of an ABORTED turn
    // closed the NEXT turn's stream: the button flipped back to ↑ and the bubble ended
    // "(no reply)" while pi went on working, invisibly, on the message the owner had just sent.
    this.turn = 0;
    this.resTurn = 0;
    this.busy = false;      // pi's agent loop is running (its own view, not the HTTP stream's)
    this.primed = false;    // has THIS process been given the conversation so far?
    this.stderr = '';       // last diagnostics, for when pi dies at spawn
  }
  spawn() {
    // BYOK. Default: pi runs on the owner's own model in their real ~/.pi. When the owner picked
    // a model in CODE (spec set), run in an ISOLATED agent dir (models.json defines it) so pi's
    // model persistence never touches their global config. The credential pi gets is a
    // loopback relay token, never the owner's provider key — see mintRelay/handleRelay.
    let extraArgs = [], relEnv = {};
    if (this.spec) {
      const token = mintRelay(this.id, this.spec);
      relEnv = { PI_CODING_AGENT_DIR: buildRuntimeDir(this.modelKey, this.spec, token), CFHUB_PI_APIKEY: token };
      extraArgs = ['--provider', 'cfhub', '--model', this.spec.model];
    } else dropRelay(this.id);
    // Same PATH the version probe used — see childPath(). Resolving pi with one environment
    // and running it with another is how a binary that answers `--version` still dies at 127.
    const env = childEnv(relEnv);
    const p = spawn(piBin(), ['--mode', 'rpc', '--no-session', '-a', ...extraArgs, '-e', EXT], { cwd: WORKSPACE, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.primed = false;   // a NEW process remembers nothing — it must be told the conversation
    this.busy = false;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => this._onStdout(d));
    // pi's stderr was discarded, so a death at spawn (bad auth, an extension that will not
    // compile, a model that does not exist) reached the owner as a bare "the pi agent exited".
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    // Guard on `this.proc === p`: a deliberate respawn (model change) nulls this.proc first, so the
    // old process's exit must NOT tear down the (new) session.
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      const why = (this.stderr || '').trim().split('\n').filter(Boolean).pop() || '';
      this._fail('the pi agent exited' + (code ? ' (code ' + code + ')' : '') + (why ? ' — ' + why.slice(0, 300) : ''));
      this.proc = null; this.busy = false; dropRelay(this.id); SESSIONS.delete(this.id);
    });
    p.on('error', (e) => { if (this.proc === p) { this._fail('could not start pi: ' + (e && e.message)); this.proc = null; dropRelay(this.id); SESSIONS.delete(this.id); } });
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
  // Close the stream ONLY if it still belongs to the turn that is finishing. A settle that
  // arrives for turn N must never end the stream of turn N+1.
  _endIfOwned(turn) { if (this.res && turn === this.resTurn) { this._write({ t: 'done' }); this._endTurn(); } }
  _onEvent(ev) {
    const type = ev && ev.type;
    if (type === 'message_update') {
      const a = ev.assistantMessageEvent;
      this._live();   // text flowing IS agent activity — this could never be reached before
      if (a && a.type === 'text_delta' && a.delta) this._write({ t: 'text', d: a.delta });
      return;
    }
    // A failed LLM call is reported as an assistant message that STOPPED with an error, not as
    // an `error` event — so a bad key, a 401/429/5xx or a dead network produced a silent empty
    // reply. Say it out loud.
    if (type === 'message_end') {
      this._live();
      const m = ev.message || ev.assistantMessage || {};
      const stop = String(m.stopReason || ev.stopReason || '');
      if (stop === 'error') this._write({ t: 'error', d: String(m.errorMessage || ev.error || 'the model provider refused the request — check the model and its API key') });
      else if (stop === 'max_tokens') this._write({ t: 'error', d: 'the reply hit the model’s output limit and was cut short' });
      return;
    }
    if (type === 'tool_execution_start') { this._live(); this._write({ t: 'tool', phase: 'start', id: ev.toolCallId || ev.id || '', name: ev.toolName || 'tool', args: ev.args || {} }); return; }
    if (type === 'tool_execution_end') {
      this._live();
      let out = '';
      const c = ev.result && ev.result.content;
      if (Array.isArray(c)) out = c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n');
      // Carry pi's own call id: the panel used to pair start/end by NAME, so two concurrent
      // tools with the same name swapped results and a stray end corrupted an unrelated line.
      this._write({ t: 'tool', phase: 'end', id: ev.toolCallId || ev.id || '', name: ev.toolName || 'tool', ok: !ev.isError, result: String(out).slice(0, 600) });
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
      if (ev.command === 'abort') { this.busy = false; return; }
      // A prompt that pi handled as an EXTENSION COMMAND runs no agent turn at all, so
      // agent_settled never comes. Without this the stream hung forever (/subgoal: 34s of
      // silence). Arm a short quiet-timer here; any agent activity cancels it.
      if (ev.command === 'prompt') {
        if (ev.success === false) {
          this.busy = false;
          this._write({ t: 'error', d: String(ev.error || 'pi refused the prompt') }); this._endTurn(); return;
        }
        this._armQuietEnd();
      }
      return;
    }
    // An error event wrote its frame and then left the stream (and the panel's ■ button) open
    // forever when no settle followed. An error that is not followed by activity ends the turn.
    if (type === 'error') {
      this._write({ t: 'error', d: String((ev.error && ev.error.message) || ev.message || 'error') });
      this._armQuietEnd(1500);
      return;
    }
    if (type === 'extension_error') { this._write({ t: 'error', d: 'an agent extension failed: ' + String(ev.error || '').slice(0, 300) }); return; }
    if (type === 'agent_settled') { this._clearQuiet(); this.busy = false; this._endIfOwned(this.turn); return; }
    if (type === 'agent_start') { this.busy = true; this._live(); return; }
    if (type === 'agent_end' || type === 'turn_start' || type === 'turn_end' || type === 'message_start') this._live();
  }

  // ── turn-completion safety net ───────────────────────────────────────────────
  // A turn ends on agent_settled. Extension commands never emit it, so we close the
  // stream once the command has had time to speak (its notify text is already through).
  // Bound to the turn that armed it: a stale timer must not close a newer stream.
  _armQuietEnd(ms = 2500) {
    this._clearQuiet();
    const mine = this.turn;
    this.quietT = setTimeout(() => { this.quietT = null; this._endIfOwned(mine); }, ms);
  }
  _clearQuiet() { if (this.quietT) { clearTimeout(this.quietT); this.quietT = null; } }
  _live() { this._clearQuiet(); } // real agent activity → this is a normal turn after all
  // Nothing may outlive the process that owned it: a dead pi left get_state/get_commands
  // round-trips hanging until each individual timeout fired.
  _rejectWaiting(why) {
    for (const [, p] of this.waiting) { clearTimeout(p.timer); try { p.reject(new Error(why)); } catch {} }
    this.waiting.clear();
  }

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
  // After ■ we tell pi to abort, but pi needs a moment to unwind its own turn. The next
  // message used to be fired straight at it and REFUSED ("Agent is already processing"),
  // so the owner's message vanished. Wait for the settle instead — briefly, then force it.
  async _settle(ms = 4000) {
    if (!this.busy) return true;
    const t0 = Date.now();
    while (this.busy && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 40));
    return !this.busy;
  }
  async prompt(res, message, resolved, images, history) {
    this.lastUsed = Date.now();
    if (this.res) { try { res.write(jsonl({ t: 'error', d: 'the agent is still finishing the previous turn' })); res.end(); } catch {} return; }
    resolved = resolved || { key: '__pi__', env: {}, model: null, provider: null };
    const turn = ++this.turn;
    // Model switch → respawn this session's pi on the new engine. Null this.proc BEFORE
    // killing so the exit guard skips it; the new process is un-primed, so the conversation
    // below is replayed into it and the owner keeps their context across the switch.
    if (this.proc && this.modelKey !== resolved.key) {
      const old = this.proc; this.proc = null; this._rejectWaiting('the agent restarted on a new model');
      try { old.kill('SIGTERM'); } catch {} this.buf = ''; this.busy = false;
      purgeSid(this.piSid); this.piSid = null;
    }
    this.modelKey = resolved.key; this.model = resolved.model; this.provider = resolved.provider; this.spec = resolved.spec || null;
    this.res = res; this.resTurn = turn;
    let gone = false;
    res.on('close', () => {
      gone = true;
      if (this.res === res) { this.res = null; this._clearQuiet(); }
      // Tell pi to stop even if the stream it was writing to is already gone.
      if (this.proc && this.proc.stdin.writable) { try { this.proc.stdin.write(jsonl({ type: 'abort' })); } catch {} }
    });
    try { await this.ensureUp(); } catch (e) { this._fail('could not start pi: ' + ((e && e.message) || e)); return; }
    // The handshake can take seconds. If the owner left in that window, do NOT submit the
    // prompt: it used to run a whole invisible turn that nobody could see or stop.
    if (gone || this.res !== res) { this.res = null; return; }
    if (!this.proc || !this.proc.stdin.writable) { this._fail('pi is not running'); return; }
    if (this.busy) {
      await this._settle();
      if (gone || this.res !== res) { this.res = null; return; }
      if (this.busy) { this._fail('the agent is still stopping the previous turn — send again in a moment'); return; }
    }
    // Say which engine actually answers. The picker used to be the only claim about the
    // model, and nothing in the stream could contradict it.
    this._write({ t: 'meta', model: this.model || null, provider: this.provider || null, own: !this.spec, fresh: !this.primed });
    // ── the conversation. pi runs with --no-session: everything it knows lives in THIS
    // process's memory. When the process is new — first message, a model switch, the idle
    // reaper, an eviction, a bridge restart — it knows nothing, while the panel still shows
    // the whole transcript. That gap IS the "the agent has no context" complaint. Replay it.
    let text = String(message || '');
    if (!this.primed) {
      const pre = historyPreamble(history);
      if (pre) text = pre + text;
    }
    this.primed = true;
    this.busy = true;
    const cmd = { id: 'p' + (++this.seq), type: 'prompt', message: text };
    if (Array.isArray(images) && images.length) cmd.images = images; // pi RPC: prompt.images?: ImageContent[]
    try { this.proc.stdin.write(jsonl(cmd)); } catch (e) { this.busy = false; this._fail('write failed: ' + ((e && e.message) || e)); }
  }
  stop() {
    this._clearQuiet(); this._rejectWaiting('the agent was stopped');
    try { if (this.proc) this.proc.kill('SIGTERM'); } catch {}
    this.proc = null; this.busy = false; dropRelay(this.id); this._endTurn();
  }
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
  // A live session whose get_state handshake timed out has piSid === null, so it could not
  // claim its own file and the sweep deleted it mid-goal. If ANY live session is unidentified,
  // the sweep cannot prove a file is an orphan — so it sweeps nothing.
  const unknown = [...SESSIONS.values()].some((s) => s.proc && !s.piSid);
  if (unknown) return 0;
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

// idle sweeper. Reaping frees the machine's RAM, and the conversation survives it now: the
// next message replays the transcript into a fresh process (see historyPreamble).
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of SESSIONS) if (!s.res && !s.busy && now - s.lastUsed > IDLE_MS) { s.stop(); SESSIONS.delete(id); }
}, 5 * 60 * 1000).unref();

// The internal session used to LIST slash commands is not a conversation and must never
// compete with one for a slot.
const CMD_SESSION = '__commands__';
function sessionFor(id) {
  let s = SESSIONS.get(id);
  if (!s) {
    if (SESSIONS.size >= MAX_SESSIONS) {
      // Evict the internal command session first, then the oldest idle REAL one. Listing
      // commands used to be able to kill a live conversation's agent to make room for itself.
      let oldest = SESSIONS.get(CMD_SESSION) && !SESSIONS.get(CMD_SESSION).res ? SESSIONS.get(CMD_SESSION) : null;
      if (!oldest) for (const [, v] of SESSIONS) if (!v.res && !v.busy && (!oldest || v.lastUsed < oldest.lastUsed)) oldest = v;
      if (oldest) { oldest.stop(); SESSIONS.delete(oldest.id); }
    }
    s = new PiSession(id); SESSIONS.set(id, s);
  }
  return s;
}

// POST /pi-chat  { session, message, model, images, history }
//   → NDJSON stream of {t:'meta'|'text'|'tool'|'error'|'done', …}
async function handlePiChat(req, res, body, { streamHead }) {
  const st = install({ light: true }); // cheap per-message check: never a 2000-file walk
  if (!piVersion()) { res.writeHead(501, { 'Content-Type': 'text/plain' }); res.end('pi is not installed — `npm i -g @earendil-works/pi-coding-agent`'); return; }
  if (!st.workspace || !st.workspace.ok) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('could not install the CLONE FRAME agent workspace'); return; }
  const id = String((body && body.session) || 'default').slice(0, 64);
  const message = (body && body.message) || '';
  if (!String(message).trim()) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty message'); return; }
  const resolved = await resolveModel(body && body.model);
  // A model the owner picked that cannot be resolved is an ERROR, not an invitation to run
  // something else. The stream says so and stops; nothing is sent to any LLM.
  if (resolved.error) {
    streamHead(res);
    try { res.write(jsonl({ t: 'error', d: resolved.error })); res.end(); } catch {}
    return;
  }
  streamHead(res);
  sessionFor(id).prompt(res, message, resolved, _cleanImages(body && body.images), body && body.history);
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
  dropRelay(key);
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
    // An unresolvable class falls back to the owner's own pi login (BYOK) rather than to a
    // wrong model — same rule as a CODE session, reported so the caller can say why.
    if (resolved.error) return { ok: true, dir: null, env: {}, provider: null, model: null, class: cls, note: resolved.error };
    if (!resolved.spec) return { ok: true, dir: null, env: {}, provider: null, model: null, class: cls };
    // A child agent gets the same loopback capability, never the owner's provider key: the
    // fleet runs bash too, and its environment is inherited by everything it spawns.
    const token = mintRelay('fleet:' + resolved.key + ':' + crypto.randomBytes(6).toString('hex'), resolved.spec);
    const rt = buildRuntimeDir('fleet-' + resolved.key, resolved.spec, token);
    return { ok: true, dir: rt, env: { CFHUB_PI_APIKEY: token }, provider: 'cfhub', model: resolved.spec.model, class: cls };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

// The slash commands pi ACTUALLY has right now — extension commands (/goal, /subgoal),
// prompt templates and skills. CODE used to carry a hand-written list that drifted from
// reality: goal.ts was built, registered and invisible. Asking the agent is the only
// listing that cannot go stale. Cached briefly; a cold call spawns pi once.
let CMD_CACHE = { at: 0, list: [] };
async function commands({ fresh = false } = {}) {
  if (!fresh && CMD_CACHE.list.length && Date.now() - CMD_CACHE.at < 60_000) return { ok: true, commands: CMD_CACHE.list, cached: true };
  // Borrow a live conversation's process when one is idle; only cold-spawn the internal
  // session as a last resort (and it is the first thing evicted — see sessionFor).
  const live = [...SESSIONS.values()].find((x) => x.proc && !x.res && !x.busy);
  const s = live || sessionFor(CMD_SESSION);
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

// The agent's own documents, by name. CLONE FRAME is pi's body, so the owner is entitled
// to read — and edit — the two texts that shape it: the curriculum it studies, and the map
// of the body it lives in. Named, never path-addressed: a client cannot ask for a file.
const DOCS = {
  curriculum: { file: () => path.join(WORKSPACE, 'AGENTS.md'), title: 'AGENTS.md — the curriculum', editable: true },
  tree:       { file: () => path.join(WORKSPACE, 'STRUCTURE.md'), title: 'STRUCTURE.md — the body tree', editable: false },
  soul:       { file: () => path.join(WORKSPACE, '.pi', 'APPEND_SYSTEM.md'), title: 'APPEND_SYSTEM.md — what you appended to its mind', editable: true },
};
const MAX_DOC = 512 * 1024;

/** @param {string} name one of DOCS */
function doc(name) {
  const d = DOCS[String(name || '')];
  if (!d) return { ok: false, error: 'unknown document' };
  const file = d.file();
  let text = '', bytes = 0, present = false;
  try { const st = fs.statSync(file); bytes = st.size; present = true; } catch {}
  if (present && bytes > MAX_DOC) return { ok: true, name, title: d.title, editable: d.editable, present, bytes, text: '', tooBig: true };
  if (present) { try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; } }
  return { ok: true, name, title: d.title, editable: d.editable, present, bytes, text };
}

/**
 * Regenerate the body tree from the real sources, right now.
 *
 * STRUCTURE.md used to refresh only on `npm run build`. Between builds it described a
 * body that had already changed — a new skill, a new module, a file moved — and the map
 * the agent navigates by was quietly out of date. The generator reads the sources, so
 * running it is the whole update: this puts it one button (and one app_rpc call) away,
 * for the owner AND for pi itself after it changes the body.
 *
 * The generator writes into the BUNDLE; ensureWorkspace() then carries it into the live
 * workspace, so both copies move together and pi never reads a map the panel is not
 * showing. Returns the stamp line so the caller can prove it moved.
 */
function refreshTree() {
  const script = path.join(BUNDLE, 'tools', 'gen-structure-tree.mjs');
  if (!fs.existsSync(script)) return { ok: false, error: 'the generator is not in this install' };
  const file = path.join(WORKSPACE, 'STRUCTURE.md');
  const stampOf = (p) => {
    try { return (fs.readFileSync(p, 'utf8').slice(0, 600).match(/^Generated by .*$/m) || [''])[0]; } catch { return ''; }
  };
  // The generator only rewrites when the body actually differs, so the stamp is a real
  // before/after signal now — worth capturing, because "regenerated" and "changed" are
  // different facts and the owner is owed the second one, not the first.
  const before = stampOf(file);
  const r = spawnSync(process.execPath, [script], { cwd: BUNDLE, encoding: 'utf8', timeout: 60_000 });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim().slice(0, 400) || 'the generator failed' };
  try { ensureWorkspace(); } catch (e) { return { ok: false, error: 'generated, but the workspace copy failed: ' + ((e && e.message) || e) }; }
  let bytes = 0;
  try { bytes = fs.statSync(file).size; } catch {}
  const stamp = stampOf(file);
  return { ok: true, bytes, stamp, changed: !!stamp && stamp !== before, file: file.replace(os.homedir(), '~') };
}

/** Where each of these documents actually lives, so the owner can go and open it. */
function docPaths() {
  const out = {};
  for (const [k, d] of Object.entries(DOCS)) out[k] = d.file().replace(os.homedir(), '~');
  return { ok: true, paths: out, workspace: WORKSPACE.replace(os.homedir(), '~'), source: path.join(BUNDLE, 'agent') };
}

/** Write one of the EDITABLE documents back. The tree is generated — it is never writable. */
function saveDoc(name, text) {
  const d = DOCS[String(name || '')];
  if (!d) return { ok: false, error: 'unknown document' };
  if (!d.editable) return { ok: false, error: 'this one is generated from the real sources on every build — edit the sources, not the map' };
  if (typeof text !== 'string') return { ok: false, error: 'text is required' };
  // BYTES, like doc() — not text.length. doc() measures st.size while this measured UTF-16
  // units, so multi-byte text could pass here and land on disk ABOVE the limit, after which
  // doc() would no longer hand it out and the document became uneditable by the very panel
  // that had just written it.
  if (Buffer.byteLength(text) > MAX_DOC) return { ok: false, error: 'too large' };
  const file = d.file();
  // NEVER write back a document we did not hand out. Past MAX_DOC, doc() returns text:'' with
  // editable:true, so the Body tab opened an EMPTY textarea over a real 600 KB curriculum and
  // one click on Save replaced it with zero bytes. Worse, saveDoc does not re-record the sha,
  // so ownerEdited() then treated the empty file as the owner's own work and ensureWorkspace()
  // protected it from being restored from the bundle. The fleet ran that end to end under an
  // isolated HOME: 614417 bytes → 0. Keying on the file's size on disk (not on the text being
  // empty) is what makes this safe: a deliberate clear of a SMALL document still works.
  try {
    if (fs.statSync(file).size > MAX_DOC) {
      return { ok: false, error: 'this document is too large to edit here — open it in FOLDERS' };
    }
  } catch { /* not there yet: a first write is fine */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  return { ok: true, bytes: Buffer.byteLength(text) };
}

// ── who the agent is ─────────────────────────────────────────────────────────
// The owner asked its name and it answered "DeepSeek". The immediate cause was elsewhere
// (pi could not run, so the raw provider answered — see childPath), but the deeper one is
// real and would have surfaced the moment pi did run: NOTHING told the agent who it was.
// A language model with no identity in its system prompt answers with its vendor's name,
// because that is the only name it has.
//
// One file holds it: .pi/APPEND_SYSTEM.md, which pi appends to its own system prompt. That
// is already the file pi writes when the owner says "call yourself NAME" in chat, and it is
// in OWNED, so app updates never touch it. BRAIN writes the SAME file — two doors, one
// truth, instead of a settings field and a chat command disagreeing about the agent's name.
//
// The app owns only the block between these markers. Whatever the owner or pi wrote outside
// it is theirs and is carried across every write.
const ID_START = '<!-- CLONE FRAME · IDENTITY — managed by BRAIN. Edit it there, or just tell the agent in chat. -->';
const ID_END = '<!-- /CLONE FRAME · IDENTITY -->';
const SOUL_FILE = () => path.join(WORKSPACE, '.pi', 'APPEND_SYSTEM.md');
const DEFAULT_NAME = 'pi';

function identityBlock(name) {
  const n = String(name || DEFAULT_NAME).trim() || DEFAULT_NAME;
  return ID_START + '\n'
    + 'Your name is **' + n + '**. That is the name you answer with, always.\n\n'
    + 'The language model underneath you — whichever one the owner picked in CODE, from any\n'
    + 'vendor — is an ENGINE you are running on. It is not your identity. When you are asked\n'
    + 'who or what you are, answer ' + n + '. Never answer with the model\'s name or its\n'
    + 'vendor\'s, and never say you are that company\'s assistant. Swapping the model changes\n'
    + 'what you think with, not who you are.\n\n'
    // House style. The owner reads what this agent writes inside BRAIN, where it is rendered
    // as markdown — so anything it writes has to be SHAPED, not poured. Without this the
    // agent appends prose in whatever form the underlying model favours that day, and a
    // document that was structured on Monday is a wall of text by Friday.
    + 'HOW YOU WRITE. Anything you write into this app is read as markdown, so give it shape:\n'
    + '- `##` for each topic, `###` for a sub-topic. Never a wall of text.\n'
    + '- Short paragraphs. One idea each. Blank line between them.\n'
    + '- Lists for steps and options; a table when you are comparing things side by side.\n'
    + '- Fenced code blocks with a language for commands, paths and code — never loose text.\n'
    + '- **Bold** only the one thing that matters in a section. Bold everywhere is bold nowhere.\n'
    + '- A `>` quote for a rule or a warning that must not be missed.\n'
    + '- Keep the shape you find. When you add to a document, match the headings already in it.\n'
    + ID_END;
}
const readSoulFile = () => { try { return fs.readFileSync(SOUL_FILE(), 'utf8'); } catch { return ''; } };

/** Split the file into the app-managed identity block and everything else. */
function splitSoul(text) {
  const i = text.indexOf(ID_START), j = text.indexOf(ID_END);
  if (i < 0 || j < i) return { block: '', rest: text };
  return { block: text.slice(i, j + ID_END.length), rest: (text.slice(0, i) + text.slice(j + ID_END.length)).trim() };
}
const nameFromBlock = (block) => { const m = block.match(/Your name is \*\*(.+?)\*\*/); return m ? m[1] : null; };

/** Read the agent's identity: the name it answers with, plus the owner's own soul text. */
function identity() {
  const raw = readSoulFile();
  const { block, rest } = splitSoul(raw);
  return {
    ok: true,
    name: (block && nameFromBlock(block)) || DEFAULT_NAME,
    soul: rest,
    managed: !!block,
    path: SOUL_FILE().replace(os.homedir(), '~'),
  };
}

/** Name the agent (and optionally give it a soul). Writes the file pi itself reads. */
function setIdentity({ name, soul } = {}) {
  // A name lands inside the system prompt, so it may not carry markup or line breaks that
  // could restructure it. Trim hard rather than reject — the owner is naming a thing, not
  // filling in a form.
  const clean = String(name == null ? DEFAULT_NAME : name).replace(/[\r\n*_`#<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || DEFAULT_NAME;
  const rest = soul == null ? splitSoul(readSoulFile()).rest : String(soul);
  if (Buffer.byteLength(rest) > MAX_DOC) return { ok: false, error: 'the soul text is too large' };
  const text = identityBlock(clean) + (rest.trim() ? '\n\n' + rest.trim() + '\n' : '\n');
  try {
    fs.mkdirSync(path.dirname(SOUL_FILE()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(SOUL_FILE(), text, { mode: 0o600 });
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  // Every live session holds the old prompt: pi reads this file when it starts. Retire them
  // so the next message comes from an agent that knows its new name, instead of the rename
  // appearing to do nothing until something else happens to restart the process.
  for (const id of [...SESSIONS.keys()]) { try { end({ id }); } catch {} }
  return { ok: true, name: clean, restarted: true };
}

/** A fresh install ships as "pi" — never nameless, or the model answers with its own name. */
function ensureIdentity() {
  try { if (!splitSoul(readSoulFile()).block) setIdentity({ name: DEFAULT_NAME }); } catch {}
}

// ── update the bundled agent ─────────────────────────────────────────────────
// pi ships INSIDE the app, so keeping it current is the app's job, not the owner's — but
// only when the pi answering is ours. A global pi belongs to whoever installed it (Homebrew,
// npm -g); upgrading that from in here would reach outside the bundle and change a tool the
// owner uses in their own terminals. Refuse, and say which one is in charge.
const PI_PKG = '@earendil-works/pi-coding-agent';
async function update() {
  const { bundled, bin } = piBinInfo();
  if (!bundled) {
    return { ok: false, external: true, bin,
      error: 'The pi in use was installed outside this app (' + bin + '). Update it where it '
           + 'came from — `npm i -g ' + PI_PKG + '` or your package manager — so the app never '
           + 'changes a tool it does not own.' };
  }
  const before = piVersion();
  const r = spawnSync('npm', ['install', PI_PKG + '@latest', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: path.join(BUNDLE, 'bridge'), encoding: 'utf8', timeout: 600_000, env: childEnv() });
  if (r.status !== 0) {
    return { ok: false, error: ((r.stderr || '').trim() || (r.error && r.error.message) || 'npm exited ' + r.status).slice(0, 400) };
  }
  _ver = { at: 0, v: null };   // the cache would otherwise report the old build for a minute
  _piBin = null;
  const after = piVersion();
  return { ok: true, from: before, to: after, changed: before !== after };
}

export const Pi = { status, install, update, installLauncher, ensureWorkspace, stop, end, commands, brain, repairSkill, doc, docPaths, refreshTree, saveDoc, identity, setIdentity, handlePiChat, handleRelay, buildFleetRuntime, _paths: { WORKSPACE, EXT, LAUNCHER } };
export default Pi;
