#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB BRIDGE
// A local daemon that gives the HUB terminal a REAL body on your machine:
//   • runs real shell commands (zsh) and streams their output
//   • relays natural-language prompts to the user's OWN model — BYOK, ANY provider
//     (Anthropic, OpenAI-compatible, local MATRIX cluster) — chosen in Settings
//
// The core HTTP/shell/chat daemon uses Node 18+ built-ins (global fetch,
// ReadableStream, crypto, child_process, http); `ws` (live terminal WS), `node-pty`,
// and `imapflow`/`nodemailer`/`mailparser` (email) are its only npm dependencies.
// Binds 127.0.0.1 ONLY. Never logs keys; model API keys never leave this machine
// and are NEVER in the website.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import Shell from './domains/chat/shell.mjs';
import Chat from './domains/chat/chat.mjs';
import { serveStatic } from './transport/static.mjs';
// guarded (never crash the daemon if 'ws' is absent — /stream just becomes unavailable).
// ws is CommonJS: the WebSocketServer lives on the default export, not as a named ESM export.
let WebSocketServer = null;
try { const _ws = await import('ws'); WebSocketServer = _ws.WebSocketServer || (_ws.default && (_ws.default.WebSocketServer || _ws.default.Server)) || null; } catch { WebSocketServer = null; }

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.dirname(BRIDGE_DIR); // the clone-frame-hub dir (serves the app)
const VERSION = '0.2.0';
const HOST = process.env.HUB_BRIDGE_HOST || '127.0.0.1'; // bind addr; loopback only by default
const PORT = Number(process.env.HUB_BRIDGE_PORT || 8765);
// Container mode (opt-in, OFF by default). When the bridge runs inside a container whose port is
// published ONLY to the host's loopback (compose: "127.0.0.1:8765:8765"), a client's packets reach
// the bridge from the container gateway, NOT 127.0.0.1 — so the socket-loopback check cannot apply.
// The isolation boundary then IS the container network namespace + that loopback-only publish; we
// still enforce the anti-rebind Host check and the pairing-token gate. Unset → nothing changes on a
// normal host install. Never publish the container port to 0.0.0.0 when this is on.
const CONTAINER = process.env.HUB_BRIDGE_CONTAINER === '1';
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');

// ── pairing token (persistent, chmod 600) ───────────────────────────────────
function loadToken() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); } catch {}
  const f = path.join(CONFIG_DIR, 'bridge.token');
  try {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = randomBytes(24).toString('base64url');
  try { fs.writeFileSync(f, t, { mode: 0o600 }); } catch {}
  return t;
}
const TOKEN = loadToken();

// ── log hygiene ──────────────────────────────────────────────────────────────
// Local logs may contain hostnames/IPs (esp. once SSH lands). Keep them owner-only
// (0600) — launch.sh creates them via shell redirects that default to 0644.
function hardenLogs() {
  for (const f of ['server.log', 'bridge.log', 'launch.log', 'electron.log']) {
    try { fs.chmodSync(path.join(CONFIG_DIR, f), 0o600); } catch {}
  }
}
hardenLogs();

// ── agent context files → the root of iT (~/.clone-frame-hub/*.md) ────────────
// The bundle ships context/*.md (AGENTS.md field guide, APP-MAP.md screen map, …);
// mirror them into the iT runtime root so any iT shell (and `it context`) finds
// them, and so they travel with a downloaded app.
function ensureContext() {
  try {
    const dir = path.join(HUB_ROOT, 'context');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const src = path.join(dir, name);
      const dst = path.join(CONFIG_DIR, name);
      const s = fs.statSync(src);
      let stale = true;
      try { stale = fs.statSync(dst).mtimeMs < s.mtimeMs; } catch {}
      if (stale) fs.copyFileSync(src, dst);
    }
  } catch {}
}
ensureContext();

// ── tiny helpers ─────────────────────────────────────────────────────────────
const j = (o) => JSON.stringify(o);
function cors(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Max-Age', '600');
}
function localOnly(req) {
  // anti DNS-rebinding: the Host header must be our loopback:port, and the
  // socket must actually be loopback. A rebound attacker domain fails the Host check.
  const host = (req.headers.host || '').toLowerCase();
  const okHost = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}` || host === `[::1]:${PORT}`;
  if (CONTAINER) return okHost;                 // container netns + loopback-only publish is the boundary
  const ra = req.socket.remoteAddress || '';
  const okAddr = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  return okHost && okAddr;
}
function authed(req) {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('token') || '';
  const tok = bearer || q;
  // constant-time-ish compare
  if (tok.length !== TOKEN.length) return false;
  let d = 0; for (let i = 0; i < tok.length; i++) d |= tok.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return d === 0;
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function streamHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  });
}

// Email (real IMAP/SMTP) now flows through the generic /mod router as `email`
// (adapter: domains/mail/mail.mjs). The bespoke /email/* switch was retired in
// T-033 — email.mjs itself is unchanged and still lazily loaded, so a mail-deps
// issue never takes down shell/chat (getMod degrades it to a 503).

// ── generic module RPC (tasks/approvals/style/contacts/integrations) ─────────
// One token-gated route serves every backend module: POST /mod/<name> {fn, args}.
// Modules are lazily imported so one broken module never affects the others.
const MODULES = { tasks: './tasks.mjs', approvals: './approvals.mjs', style: './style.mjs', contacts: './contacts.mjs', integrations: './integrations.mjs',
  models: './models.mjs', calendar: './calendar.mjs', notes: './notes.mjs', library: './library.mjs', research: './research.mjs',
  cookbook: './cookbook.mjs', gallery: './gallery.mjs', compare: './compare.mjs', reminders: './reminders.mjs', admin: './admin.mjs',
  scheduled: './scheduled.mjs', oauth: './oauth.mjs', images: './images.mjs', search: './search.mjs', web: './web.mjs',
  browser: './browser.mjs', harness: './harness.mjs', nft: './nft.mjs', files: './files.mjs', permissions: './permissions.mjs',
  proxy: './proxy.mjs', folders: './folders.mjs', servers: './servers.mjs', acp: './acp.mjs',
  robinhood: './robinhood.mjs', okxai: './okxai.mjs', virtuals: './virtuals.mjs',
  pty: './pty.mjs', it: './it.mjs', ssh: './ssh.mjs', keeper: './keeper.mjs', matrix: './matrix.mjs', assistant: './assistant.mjs',
  email: './domains/mail/mail.mjs' };
const MODEXPORT = { tasks: 'Tasks', approvals: 'Approvals', style: 'Style', contacts: 'Contacts', integrations: 'Integrations',
  models: 'Models', calendar: 'Calendar', notes: 'Notes', library: 'Library', research: 'Research',
  cookbook: 'Cookbook', gallery: 'Gallery', compare: 'Compare', reminders: 'Reminders', admin: 'Admin',
  scheduled: 'Scheduled', oauth: 'OAuth', images: 'Images', search: 'Search', web: 'Web',
  browser: 'Browser', harness: 'Harness', nft: 'NFT', files: 'Files', permissions: 'Permissions', acp: 'Acp',
  robinhood: 'Robinhood', okxai: 'OkxAi', virtuals: 'Virtuals',
  pty: 'Pty', it: 'It', ssh: 'Ssh', keeper: 'Keeper', matrix: 'Matrix', assistant: 'Assistant',
  email: 'Email' };
const _modCache = {};
async function getMod(name) {
  if (_modCache[name]) return _modCache[name];
  const m = await import(MODULES[name]);
  const obj = m[MODEXPORT[name]] || m.default || m;
  _modCache[name] = obj; return obj;
}
async function handleMod(req, res, name, body) {
  const ok = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(j(o)); };
  const fail = (code, e) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: String((e && e.message) || e) })); };
  if (!MODULES[name]) return fail(404, 'unknown module');
  const fn = String(body.fn || '');
  if (!fn || fn[0] === '_' || fn === 'constructor') return fail(400, 'bad fn');
  let obj;
  try { obj = await getMod(name); } catch (e) { return fail(503, name + ' unavailable: ' + ((e && e.message) || e)); }
  const f = obj[fn];
  if (typeof f !== 'function') return fail(400, 'no such fn: ' + fn);
  try { return ok(await f.apply(obj, Array.isArray(body.args) ? body.args : [])); }
  catch (e) { return fail(500, e); }
}
// ── in-app browser proxy ─────────────────────────────────────────────────────
// GET /proxy?url=<http(s)> — renders a page for the HUB's sandboxed <iframe>.
// TOKEN-LESS on purpose: the token must never appear in an iframe URL (the proxied
// page's own JS can read location.search). Safe because: localOnly() still gates it,
// web.mjs's SSRF guard blocks private/internal hosts (re-checked every redirect hop),
// GET + http(s) only, size/time-capped, and it returns ONLY fetched public web content
// (no token, no files, no secrets). The renderer is embedded sandboxed WITHOUT
// allow-same-origin (opaque origin) so proxied JS can never reach the token or RPC.
let proxyInFlight = 0;
const PROXY_MAX_INFLIGHT = 8; // cap concurrent outbound fetches (anti-DoS / amplification)
async function handleProxy(req, res, url) {
  // GATE: only our own sandboxed <iframe> may drive this. A real Chromium iframe
  // navigation always sends `Sec-Fetch-Dest: iframe`; a cross-origin fetch() from
  // another browser tab sends `empty` (and can't forge Sec-Fetch-* — forbidden headers).
  // This is what stops the token-less proxy from being a readable open proxy for any
  // site the user visits, and stops it from being an SSRF pivot driven from the web.
  const dest = req.headers['sec-fetch-dest'];
  if (dest !== 'iframe') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden — proxy is only for the in-app browser'); return; }
  // Never expose proxied bytes cross-origin: strip the reflected CORS this handler
  // inherited from cors(). The legitimate iframe loads /proxy as a navigation (no CORS
  // needed); anything relying on ACAO to READ the body is an attacker, so deny it.
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Methods');
  res.removeHeader('Access-Control-Allow-Headers');
  const target = url.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad url'); return; }
  if (proxyInFlight >= PROXY_MAX_INFLIGHT) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('proxy busy'); return; }
  let Proxy;
  try { Proxy = await getMod('proxy'); } catch (e) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('proxy unavailable'); return; }
  proxyInFlight++;
  try {
    const fresh = url.searchParams.get('fresh') === '1';
    const ua = url.searchParams.get('ua') || '';
    const out = await Proxy.render(target, { fresh, ua });
    // Deliberately NO X-Frame-Options and NO Content-Security-Policy → embeddable in
    // our sandboxed iframe. Cross-origin isolation is provided by the iframe sandbox
    // on the client (no allow-same-origin → opaque origin), not by headers here.
    res.writeHead(out.status || 200, {
      'Content-Type': out.contentType || 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(out.binary ? out.body : Buffer.from(String(out.body || '')));
  } catch (e) { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('proxy error'); }
  finally { proxyInFlight--; }
}

// boot the task scheduler once (best-effort; never blocks server start)
async function bootTasks() {
  // materialize the CloneFrame folder skeleton on the user's machine (idempotent) so it
  // exists in Finder from first launch — editable both inside the app and directly on disk.
  try { const F = await getMod('folders'); if (F.ensure) { const r = await F.ensure(); console.log('  folders    ' + ((r && r.root) || 'ready')); } }
  catch (e) { console.log('  folders    off (' + ((e && e.message) || e) + ')'); }
  try { const T = await getMod('tasks'); if (T.init) await T.init(); if (T.startScheduler) T.startScheduler(); console.log('  tasks      scheduler on'); }
  catch (e) { console.log('  tasks      off (' + ((e && e.message) || e) + ')'); }
  // scheduled-email poller: send due emails every 60s (best-effort, never crashes)
  const sched = setInterval(async () => {
    try { const S = await getMod('scheduled'); if (S.tick) await S.tick(); } catch {}
  }, 60_000);
  sched.unref?.();
}

// ── router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  try { req.socket.setNoDelay(true); } catch {}
  if (!localOnly(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'forbidden' })); return; }
  const url = new URL(req.url, 'http://x');

  // /health is open (needed for probing) — deliberately minimal: no cwd (leaks the
  // macOS username), no brain/model. Those come from POST /pair, behind the token.
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(j({ ok: true, name: 'HUB Bridge', version: VERSION, host: HOST }));
    return;
  }
  // static app files (GET only; no token — the HTML is not secret and carries the injected token)
  if (req.method === 'GET' && serveStatic(req, res, url.pathname, { root: HUB_ROOT, host: HOST, port: PORT, token: TOKEN })) return;
  // in-app browser proxy — token-LESS by design (see handleProxy). localOnly() already passed.
  if (req.method === 'GET' && url.pathname === '/proxy') { await handleProxy(req, res, url); return; }
  // everything else requires the pairing token
  if (!authed(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'unpaired' })); return; }

  if (req.method === 'POST' && url.pathname === '/pair') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const b = await Chat.brain();
    res.end(j({ ok: true, cwd: Shell.cwd(), brain: b.ready ? (b.provider || 'ready') : 'none', model: b.model, provider: b.provider || null })); return;
  }
  if (req.method === 'POST' && url.pathname === '/shell') { Shell.handleShell(req, res, await readBody(req), { streamHead }); return; }
  if (req.method === 'POST' && url.pathname === '/interrupt') {
    const { id } = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(j({ ok: Shell.interrupt(id) })); return;
  }
  if (req.method === 'POST' && url.pathname === '/chat') { await Chat.handleChat(req, res, await readBody(req), { streamHead }); return; }
  if (req.method === 'POST' && url.pathname === '/provider-chat') { await Chat.handleProviderChat(req, res, await readBody(req), { streamHead }); return; }
  if (req.method === 'POST' && url.pathname.startsWith('/mod/')) { await handleMod(req, res, url.pathname.slice(5), await readBody(req)); return; }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'not found' }));
});

// ── live PTY terminal — ONE token-gated WS at GET /stream (boundary DATA plane) ───
// wsGuard repeats EVERY http guard: correct path + localOnly (loopback socket + our
// Host header, anti DNS-rebinding) + the pairing token carried in the Sec-WebSocket-
// Protocol subprotocol 'cfhub.bearer.<token>' (NEVER the URL, so proxied/logged URLs
// can't leak it). Only the non-secret 'cfhub' subprotocol is echoed back. On success
// the raw socket is handed to Pty.attach, which owns all I/O, resize, and idle/lifetime caps.
const wss = WebSocketServer ? new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024,
  handleProtocols: (protos) => (protos && protos.has && protos.has('cfhub')) ? 'cfhub' : false }) : null;
function tokenEq(tok) {
  if (typeof tok !== 'string' || tok.length !== TOKEN.length) return false;
  let d = 0; for (let i = 0; i < tok.length; i++) d |= tok.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return d === 0;
}
server.on('upgrade', (req, socket, head) => {
  try {
    if (!wss) { socket.destroy(); return; }
    let url; try { url = new URL(req.url, `http://${req.headers.host}`); } catch { socket.destroy(); return; }
    if (url.pathname !== '/stream') { socket.destroy(); return; }
    if (!localOnly(req)) { socket.destroy(); return; }               // loopback socket + our Host header
    const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    const bearer = offered.find((p) => p.startsWith('cfhub.bearer.'));
    if (!bearer || !tokenEq(bearer.slice('cfhub.bearer.'.length))) { socket.destroy(); return; } // token in subprotocol only
    wss.handleUpgrade(req, socket, head, (ws) => dispatchStream(ws, url));
  } catch { try { socket.destroy(); } catch {} }
});
// zsh shell integration (generated once): a ZDOTDIR whose startup files source the
// user's own dotfiles untouched, then add a chpwd/precmd hook that emits OSC 7 —
// so the app's file tree can follow the live terminal's cwd. Fail-soft: if anything
// here can't be written, the terminal still opens as a plain login shell.
let _zdotDir = null;
function ensureZdot() {
  if (_zdotDir !== null) return _zdotDir;
  if (process.env.ZDOTDIR) { _zdotDir = ''; return ''; }     // user runs a custom ZDOTDIR setup — leave it alone
  try {
    const dir = path.join(CONFIG_DIR, 'zdot');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // the `it` CLI, on PATH only inside iT shells (like cmux's in-terminal-only CLI)
    const bin = path.join(CONFIG_DIR, 'bin');
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), 'it-cli.mjs');
    fs.writeFileSync(path.join(bin, 'it'), `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`, { mode: 0o755 });
    const hook = [
      '# CLONE FRAME HUB shell integration (generated — safe to delete; recreated on demand).',
      '# Emits OSC 7 on every prompt/cd so the in-app file tree follows this shell.',
      '__cfhub_osc7(){ printf \'\\e]7;file://%s%s\\e\\\\\' "$HOST" "$PWD" }',
      'typeset -ag precmd_functions chpwd_functions preexec_functions',
      'precmd_functions+=(__cfhub_osc7)',
      'chpwd_functions+=(__cfhub_osc7)',
      '# Long-command notifier: any command taking 15s+ raises an OSC 777 notification',
      '# when it finishes — iT surfaces it (dot + toast + the ⌘I panel) even when you',
      '# are on another workspace. Works for every agent/build/deploy, no wrappers.',
      'zmodload zsh/datetime 2>/dev/null',
      '__cfhub_preexec(){ __cfhub_t0=${EPOCHREALTIME%.*}; __cfhub_cmd="$1" }',
      '__cfhub_done(){ local rc=$?; [ -n "$__cfhub_t0" ] || return 0; local dt=$(( ${EPOCHREALTIME%.*} - __cfhub_t0 )); __cfhub_t0=""; if [ "$dt" -ge 15 ]; then printf \'\\e]777;notify;%s;%s\\e\\\\\' "finished in ${dt}s · exit ${rc}" "${__cfhub_cmd[1,80]}"; fi }',
      'preexec_functions+=(__cfhub_preexec)',
      'precmd_functions+=(__cfhub_done)',
      '# the iT command line (`it` — cmux-compatible commands)',
      'export PATH="' + bin + ':$PATH"',
    ].join('\n');
    const src = (f) => `[ -f "$HOME/${f}" ] && . "$HOME/${f}"`;
    fs.writeFileSync(path.join(dir, '.zshenv'),   `export ZDOTDIR="$HOME"\n${src('.zshenv')}\nexport ZDOTDIR=${JSON.stringify(dir)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, '.zprofile'), `${src('.zprofile')}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, '.zshrc'),    `${src('.zshrc')}\n${hook}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, '.zlogin'),   `${src('.zlogin')}\n`, { mode: 0o600 });
    _zdotDir = dir;
  } catch { _zdotDir = ''; }
  return _zdotDir;
}
async function dispatchStream(ws, url) {
  const op = url.searchParams.get('op') || 'shell';
  // iT control plane — no PTY: the iT window parks one socket here and the `it` CLI's
  // commands are ferried over it. Same host/token gates as every stream (upgrade handler).
  if (op === 'it') { try { (await getMod('it')).attachCtl(ws); } catch { try { ws.close(1011, 'it unavailable'); } catch {} } return; }
  let Pty; try { Pty = await getMod('pty'); } catch { try { ws.close(1011, 'pty unavailable'); } catch {} return; }
  const cols = Math.max(1, Math.min(1000, Number(url.searchParams.get('cols')) || 80));
  const rows = Math.max(1, Math.min(1000, Number(url.searchParams.get('rows')) || 24));
  const cwd = url.searchParams.get('cwd') || undefined;
  let hello;
  if (op === 'attach') {
    // attach to a tmux session — the substrate for agent crews running side-by-side
    const session = String(url.searchParams.get('session') || '');
    if (!/^[\w.-]{1,64}$/.test(session)) { try { ws.close(1008, 'bad session name'); } catch {} return; }
    hello = { cmd: 'tmux', args: ['attach-session', '-t', session], cwd, cols, rows };
  } else if (op === 'ssh') {
    // iT remote — a (persistence-capable) PTY running `ssh <alias>`. This is OUR own remote
    // engine, not tmux; ssh is only the transport. Gated by the default-OFF `ssh` permission.
    // The hostname is resolved server-side from a SAVED alias, so it never crosses to the client,
    // and the argv is built by ssh.mjs (allowlisted -o, `--` before the host, no user@host).
    let Perms; try { Perms = await getMod('permissions'); } catch {}
    if (!Perms || !Perms.can('ssh')) { try { ws.close(1008, 'ssh permission is off'); } catch {} return; }
    let Ssh; try { Ssh = await getMod('ssh'); } catch {}
    const spec = Ssh && Ssh._connectArgs(String(url.searchParams.get('host') || ''), { interactive: true });
    if (!spec) { try { ws.close(1008, 'unknown host'); } catch {} return; }
    hello = { cmd: spec.cmd, args: spec.args, cwd, cols, rows };
    // reuse Phase-4 persistence: reattach to the live ssh pty after a reload (remote stays up).
    const sid = String(url.searchParams.get('sid') || '');
    if (/^[A-Za-z0-9_-]{8,64}$/.test(sid)) { hello.id = sid; hello.persist = url.searchParams.get('persist') === '1'; }
  } else if (op === 'keeper') {
    // iT Keeper — OUR own tmux-less persistence. The session lives in a DETACHED daemon that
    // outlives this attach AND a bridge restart; here we only bridge the WS to a `keeper attach`
    // child (ephemeral — reaped on ws close; the daemon keeps the shell alive and replays on reattach).
    const sess = String(url.searchParams.get('sess') || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sess)) { try { ws.close(1008, 'bad session id'); } catch {} return; }
    let Keeper; try { Keeper = await getMod('keeper'); } catch {}
    if (!Keeper) { try { ws.close(1011, 'keeper unavailable'); } catch {} return; }
    const ens = await Keeper.ensure(sess, { cwd, cols, rows });
    if (!ens || !ens.ok) { try { ws.close(1011, (ens && ens.error) || 'keeper failed'); } catch {} return; }
    hello = { cmd: process.execPath, args: [Keeper._keeperPath(), 'attach', sess], cwd, cols, rows };
  } else {
    const shell = process.env.SHELL || 'zsh';
    hello = { cmd: shell, args: ['-l'], cwd, cols, rows };
    if (/\bzsh$/.test(shell)) { const zd = ensureZdot(); if (zd) hello.env = { ZDOTDIR: zd }; }
    // iT identity for the `it` CLI (like cmux's CMUX_WORKSPACE_ID/CMUX_SURFACE_ID):
    // plain ids, no secrets — the CLI reads the token from disk, never from env.
    const wsId = String(url.searchParams.get('ws') || ''), surfId = String(url.searchParams.get('surf') || '');
    hello.env = hello.env || {};
    if (/^[\w-]{1,64}$/.test(wsId)) hello.env.CFHUB_IT_WORKSPACE = wsId;
    if (/^[\w-]{1,64}$/.test(surfId)) hello.env.CFHUB_IT_SURFACE = surfId;
    hello.env.CFHUB_BRIDGE = `http://${HOST}:${PORT}`;
    // Phase 4 — persistent sessions: a client-supplied stable id + persist flag let the
    // pty survive a reload (reattach + scrollback replay) instead of being reaped.
    const sid = String(url.searchParams.get('sid') || '');
    if (/^[A-Za-z0-9_-]{8,64}$/.test(sid)) { hello.id = sid; hello.persist = url.searchParams.get('persist') === '1'; }
  }
  Pty.attach(ws, hello);
}

// refuse to run wide-open
server.listen(PORT, HOST, async () => {
  const endpoint = `http://${HOST}:${PORT}`;
  const pair = `${endpoint}#token=${TOKEN}`;
  const line = '─'.repeat(64);
  console.log(`\n\x1b[38;5;176m▓▒ CLONE FRAME · HUB — local app v${VERSION}\x1b[0m`);
  console.log(line);
  console.log(`  app        \x1b[1m${endpoint}\x1b[0m  ← open this (auto-pairs)`);
  const brain = await Chat.brain();
  console.log(`  brain      ${brain.ready ? '\x1b[32m' + (brain.provider || 'model') + ' (' + brain.model + ') — from Settings/env, any provider\x1b[0m' : '\x1b[33mnone — add a provider, or set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY in ~/.env.local\x1b[0m'}`);
  console.log(`  shell      zsh · cwd ${Shell.cwd()}`);
  console.log(`  bind       ${HOST} only  ·  token gate ON  ·  serving ${path.basename(HUB_ROOT)}/`);
  console.log(line);
  console.log(`  Opened via the launcher, the Chrome app window auto-connects.`);
  console.log(`  For the dev preview (other origin), paste into MY MACHINE → HUB BRIDGE:`);
  console.log(`  \x1b[38;5;176m${pair}\x1b[0m`);
  console.log(`  (token at ~/.clone-frame-hub/bridge.token · chmod 600)`);
  console.log(line + '\n');
  bootTasks();
});
server.on('error', (e) => { console.error('bridge error:', e.message); process.exit(1); });
