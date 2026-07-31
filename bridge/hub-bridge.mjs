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
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import Shell from './domains/chat/shell.mjs';
import Chat from './domains/chat/chat.mjs';
import Session from './session.mjs';
import { serveStatic, armPairing } from './transport/static.mjs';
// guarded (never crash the daemon if 'ws' is absent — /stream just becomes unavailable).
// ws is CommonJS: the WebSocketServer lives on the default export, not as a named ESM export.
let WebSocketServer = null;
try { const _ws = await import('ws'); WebSocketServer = _ws.WebSocketServer || (_ws.default && (_ws.default.WebSocketServer || _ws.default.Server)) || null; } catch { WebSocketServer = null; }

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.dirname(BRIDGE_DIR); // the clone-frame-hub dir (serves the app)
// Read, not repeated. This was a hard-coded '0.2.0' that had to be remembered on every release
// and was one of six disagreeing version strings. package.json is the single origin; the built
// document gets the same value through the @@CF_VERSION@@ token in tools/build.mjs.
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HUB_ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
// Any bridge/*.mjs newer on disk than this process = the daemon is serving old code
// (it only reloads on relaunch, unlike the HTML's ⌘R). Reported by /health as `stale`.
const STARTED_AT = Date.now();
function bridgeStale() {
  try {
    for (const f of fs.readdirSync(BRIDGE_DIR, { recursive: true })) {
      const name = String(f);
      if (!name.endsWith('.mjs') || name.includes('node_modules')) continue;
      if (fs.statSync(path.join(BRIDGE_DIR, name)).mtimeMs > STARTED_AT) return true;
    }
  } catch { /* best effort — never break health */ }
  return false;
}
// The DOCUMENT can be stale too, and in a way a reload does not fix: web/ is the source and
// dist/index.html is what is served, so editing a panel without `npm run build` leaves the
// owner running old code with nothing on screen to say so. This only compares the two files
// the build turns into each other — no walk, no cost.
function appStale() {
  try {
    const src = path.join(HUB_ROOT, 'web', 'index.html');
    const out = path.join(HUB_ROOT, 'dist', 'index.html');
    if (!fs.existsSync(src) || !fs.existsSync(out)) return false;
    const built = fs.statSync(out).mtimeMs;
    if (fs.statSync(src).mtimeMs > built) return true;
    for (const f of fs.readdirSync(path.join(HUB_ROOT, 'web', 'panels'))) {
      if (f.endsWith('.js') && fs.statSync(path.join(HUB_ROOT, 'web', 'panels', f)).mtimeMs > built) return true;
    }
  } catch { /* not a source checkout — nothing to compare */ }
  return false;
}
const HOST = process.env.HUB_BRIDGE_HOST || '127.0.0.1'; // bind addr; loopback only by default
const PORT = Number(process.env.HUB_BRIDGE_PORT || 8765);
// Container mode (opt-in, OFF by default). When the bridge runs inside a container whose port is
// published ONLY to the host's loopback (compose: "127.0.0.1:8765:8765"), a client's packets reach
// the bridge from the container gateway, NOT 127.0.0.1 — so the socket-loopback check cannot apply.
// The isolation boundary then IS the container network namespace + that loopback-only publish; we
// still enforce the anti-rebind Host check and the pairing-token gate. Unset → nothing changes on a
// normal host install. Never publish the container port to 0.0.0.0 when this is on.
const CONTAINER = process.env.HUB_BRIDGE_CONTAINER === '1';
// A non-loopback bind is a decision, never a side effect of one env var. In container mode
// the socket-loopback check cannot apply, so the boundary degrades to the Host header — a
// string the client controls. That is fine behind a loopback-only publish
// ("127.0.0.1:8765:8765") and catastrophic without one: the most natural command a user
// types, `docker run -p 8765:8765`, would otherwise hand the LAN an unauthenticated bridge.
// So binding wide requires saying so out loud, and the process refuses rather than assumes.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '']);
if (!LOOPBACK_HOSTS.has(HOST) && process.env.HUB_BRIDGE_ALLOW_PUBLIC !== '1') {
  console.error(`\n  CLONE FRAME · HUB — refusing to start.\n`
    + `  HUB_BRIDGE_HOST is "${HOST}", which is not loopback. This bridge runs a real shell,\n`
    + `  your files and your wallets; exposing it beyond this machine is never a default.\n\n`
    + `  If the port is published to the host loopback only (compose does this), that is the\n`
    + `  supported setup and the bind is safe — confirm it with HUB_BRIDGE_ALLOW_PUBLIC=1.\n`
    + `  If you are about to publish it to a LAN or the internet: don't.\n`);
  process.exit(1);
}
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
try { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); } catch {}

// ── pairing token ────────────────────────────────────────────────────────────
// Minted and owned by bridge/session.mjs, which also holds the owner's lifetime policy
// (permanent by default — see that file). Read it through Session._token() at USE time,
// never into a const: a rotation must take effect on the next request, not the next boot.

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
// Same-machine app only: reflecting an arbitrary Origin would let any page the owner
// visits read our responses the day a token leaks. No legitimate internet origin needs
// to read 127.0.0.1:PORT — so allowlist ours and stay silent for everyone else.
// CFHUB_EXTRA_ORIGIN opts a dev preview (other origin) in explicitly.
const CORS_ALLOWED = new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
  ...(process.env.CFHUB_EXTRA_ORIGIN ? [process.env.CFHUB_EXTRA_ORIGIN] : []),
]);
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  // No Origin header = not a browser CORS request (curl, the `it` CLI, the pi extension).
  // We used to answer those with `*`, reasoning that there were no credentials to protect.
  // The header did nothing for them — non-browser clients never read it — while sitting
  // there as a wildcard for any future code path that DOES arrive origin-less. Removed
  // 2026-07-26: say nothing, and only ever name our own origin.
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
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
// The Authorization header is the ONLY carrier. A `?token=` query param used to be
// accepted as an alternate, and nothing in this app ever sent one — the client has always
// been Bearer-only (BridgeClient.headers()). What it did do is put the secret somewhere
// URLs go: shell history, access logs, the Referer of anything the page loads, a
// screen-share of the address bar. Removed 2026-07-26; the WS carries it in the
// subprotocol for the same reason.
function authed(req) {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return Session._verify(bearer);   // constant-time compare + the owner's lifetime policy
}
// 4MB used to be the hard cap AND the failure mode was req.destroy() with no response — so a
// pasted screenshot over ~3MB killed the request silently and CODE waited forever for a stream
// that would never start. The chat routes carry base64 images (5 × ~8MB is allowed upstream),
// so they get room; anything over the limit is answered with a 413 the client can render.
const BODY_MAX = 64e6;
function readBody(req, res) {
  return new Promise((resolve) => {
    let b = '', over = false;
    req.on('data', (c) => {
      if (over) return;
      b += c;
      if (b.length > BODY_MAX) {
        over = true; b = '';
        if (res && !res.headersSent) { try { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'that message is too large — attach fewer or smaller images' })); } catch {} }
        req.destroy();
      }
    });
    // null means "already answered with 413" — only possible when a res was handed in, so
    // the callers that do not pass one keep their old never-throws contract.
    req.on('end', () => { if (over) return resolve(res ? null : {}); try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve(over && res ? null : {}));
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
const MODULES = { brain: './brain.mjs', tasks: './tasks.mjs', approvals: './approvals.mjs', style: './style.mjs',
  models: './models.mjs', notes: './notes.mjs', research: './research.mjs', reminders: './reminders.mjs', admin: './admin.mjs',
  scheduled: './scheduled.mjs', oauth: './oauth.mjs', search: './search.mjs', web: './web.mjs',
  browser: './browser.mjs', harness: './harness.mjs', nft: './nft.mjs', files: './files.mjs', permissions: './permissions.mjs',
  webengine: './webengine.mjs', folders: './folders.mjs', servers: './servers.mjs', acp: './acp.mjs',
  robinhood: './robinhood.mjs', okxai: './okxai.mjs', virtuals: './virtuals.mjs',
  pty: './pty.mjs', it: './it.mjs', ssh: './ssh.mjs', keeper: './keeper.mjs', matrix: './matrix.mjs',
  app: './app.mjs', pi: './pi.mjs', rpcallow: './rpcallow.mjs', session: './session.mjs',
  email: './domains/mail/mail.mjs' };
const MODEXPORT = { brain: 'Brain', tasks: 'Tasks', approvals: 'Approvals', style: 'Style',
  models: 'Models', notes: 'Notes', research: 'Research', reminders: 'Reminders', admin: 'Admin',
  scheduled: 'Scheduled', oauth: 'OAuth', search: 'Search', web: 'Web',
  browser: 'Browser', harness: 'Harness', nft: 'NFT', files: 'Files', permissions: 'Permissions', acp: 'Acp',
  webengine: 'Webengine',
  robinhood: 'Robinhood', okxai: 'OkxAi', virtuals: 'Virtuals',
  pty: 'Pty', it: 'It', ssh: 'Ssh', keeper: 'Keeper', matrix: 'Matrix',
  app: 'App', pi: 'Pi', rpcallow: 'RpcAllow', session: 'Session',
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
  // The owner's own app_rpc allowlist. Applies ONLY to calls the agent marks as its own
  // (the pi extension sets x-cfhub-caller: agent) — the app's UI drives the same route and
  // is never constrained by it, so a narrow list can never brick the interface. Ships
  // wide open; see bridge/rpcallow.mjs for exactly what this is and is not.
  if (String(req.headers['x-cfhub-caller'] || '').toLowerCase() === 'agent') {
    // The whole `rpcallow` module used to be exempt, so an agent the list constrained could
    // call rpcallow.set and widen it. Nothing was GAINED — the module's header already notes
    // that a token-holder can bypass the list by omitting this header — but a policy its own
    // subject can edit is not a policy. The exemption existed so the agent could READ what it
    // is allowed to do; that is all it keeps. Reads pass, writes do not.
    if (name === 'rpcallow') {
      if (fn === 'set' || fn === 'reset') return fail(403, "refused: the app_rpc policy is the owner's — it is changed in SETTINGS, not by the agent it constrains");
    } else try {
      const { RpcAllow } = await import('./rpcallow.mjs');
      const verdict = RpcAllow.check(name, fn);
      if (!verdict.allowed) return fail(403, verdict.reason);
    } catch { /* policy unreadable → fail OPEN, matching the shipped default */ }
    // …and the few calls that send mail on the owner's behalf need the owner's toggle. See
    // Permissions.agentGateFor for why these three and no others. Unlike the allowlist above
    // this fails CLOSED: it guards an irreversible, outward-facing act, and the app promises
    // in SETTINGS that it cannot happen with the switch off. Note the error names the way out —
    // an agent told "refused" queues to APPROVAL; one told "error" tends to drop the draft.
    try {
      const { Permissions } = await import('./permissions.mjs');
      const need = Permissions.agentGateFor(name, fn);
      if (need && !Permissions.can(need)) {
        return fail(403, 'refused: the "' + need + '" permission is off — queue it with approvals.add and the owner will send it');
      }
    } catch (e) { return fail(503, 'permission gate unavailable: ' + ((e && e.message) || e)); }
  }
  let obj;
  try { obj = await getMod(name); } catch (e) { return fail(503, name + ' unavailable: ' + ((e && e.message) || e)); }
  const f = obj[fn];
  if (typeof f !== 'function') return fail(400, 'no such fn: ' + fn);
  try { return ok(await f.apply(obj, Array.isArray(body.args) ? body.args : [])); }
  catch (e) { return fail(500, e); }
}
// The in-app browser is now a real Chromium engine driven over CDP (bridge/webengine.mjs)
// through the token-gated POST /mod/webengine router — the old token-less GET /proxy
// reader was removed with the panel rewrite (L1). No HTML-rewriting proxy remains.

// boot the task scheduler once (best-effort; never blocks server start)
async function bootTasks() {
  // materialize the CloneFrame folder skeleton on the user's machine (idempotent) so it
  // exists in Finder from first launch — editable both inside the app and directly on disk.
  try { const F = await getMod('folders'); if (F.ensure) { const r = await F.ensure(); console.log('  folders    ' + ((r && r.root) || 'ready')); } }
  catch (e) { console.log('  folders    off (' + ((e && e.message) || e) + ')'); }
  try { const T = await getMod('tasks'); if (T.init) await T.init(); if (T.startScheduler) T.startScheduler(); console.log('  tasks      scheduler on'); }
  catch (e) { console.log('  tasks      off (' + ((e && e.message) || e) + ')'); }
  // Pi agent: install/sync the workspace (AGENTS.md + extension + skills) and the `pi-clone`
  // iT launcher, idempotently, so both are ready the moment the app opens. Best-effort.
  try { const P = await getMod('pi'); const r = P.install(); const s = P.status(); console.log('  pi         ' + (r && r.ok ? ('ready · ' + (s.version || '?') + (s.webAccess ? ' · web' : '') + ' · pi-clone') : 'partial')); }
  catch (e) { console.log('  pi         off (' + ((e && e.message) || e) + ')'); }
  // The browser keeps no history (owner's order, 2026-07-25). Loading the module at boot
  // is what erases a `history` array an older install left in browser.json — otherwise it
  // would sit on disk until something happened to touch the module.
  try { await getMod('browser'); } catch { /* the domain is optional at boot */ }
  // scheduled-email poller: send due emails every 60s (best-effort, never crashes)
  const sched = setInterval(async () => {
    try { const S = await getMod('scheduled'); if (S.tick) await S.tick(); } catch {}
  }, 60_000);
  sched.unref?.();
}

// ── router ───────────────────────────────────────────────────────────────────
// The router is one async function, so an unexpected throw anywhere inside it used to become
// an unhandled rejection — and Node ends the process on those. One malformed URL cost the
// owner every live terminal session, the task scheduler and the agent. The lesson is not the
// one decode that did it (fixed at its source in transport/static.mjs): it is that a throw in
// routing must cost ONE REQUEST. Everything below is wrapped, and the wrapper never leaks
// internals — the caller gets the same shape every other failure uses.
const server = http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    console.error('router:', (e && e.stack) || e);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'request failed' })); }
    else { try { res.end(); } catch {} }
  }
});

async function route(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  try { req.socket.setNoDelay(true); } catch {}
  if (!localOnly(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'forbidden' })); return; }
  const url = new URL(req.url, 'http://x');

  // /health is open (needed for probing) — deliberately minimal: no cwd (leaks the
  // macOS username), no brain/model. Those come from POST /pair, behind the token.
  // `stale` says the bridge/*.mjs on disk is NEWER than this running process — a
  // long-lived daemon serving old code was the real cause of "email → 404" (the UI
  // reloads with ⌘R but the daemon only reloads on relaunch).
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // `root: HUB_ROOT` was here and it contradicted the comment two lines up: HUB_ROOT is
    // /Users/<name>/… , so an UNAUTHENTICATED probe learned the macOS username, the desktop
    // layout and where the repo lives. It was added in 3d18a2d of this session's own work,
    // for diagnostics that appStale already answers as a boolean, and nothing ever read it —
    // every `.root` in the client comes from RPC('folders','root'), which is behind the token.
    res.end(j({ ok: true, name: 'HUB Bridge', version: VERSION, host: HOST, stale: bridgeStale(), appStale: appStale() }));
    return;
  }
  // static app files (GET only; no token — the HTML is not secret and carries the injected token)
  // HEAD is served like GET (headers only) so probes never fall through to the 401/404
  // gate and log a console error (audit BUG-L0-001: HEAD not served → COOP/401 on boot).
  if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname, { root: HUB_ROOT, host: HOST, port: PORT, token: Session._token() })) return;
  // The LLM relay: pi's model calls come back here so the owner's provider key never enters
  // pi's environment (where every bash command it runs would inherit it). The capability IS
  // the random token in the path — minted per session, held only by that pi process, dead when
  // the session ends. It is deliberately ahead of the pairing gate because pi authenticates
  // with the relay token, not with the app's pairing token; an unknown token gets a 401 and
  // never reaches a provider. See bridge/pi.mjs → mintRelay / handleRelay.
  if (url.pathname.startsWith('/llm/')) {
    let P; try { P = await getMod('pi'); } catch (e) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('pi unavailable: ' + ((e && e.message) || e)); return; }
    await P.handleRelay(req, res, url.pathname.slice(5) + (url.search || ''));
    return;
  }
  // everything else requires the pairing token
  if (!authed(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'unpaired' })); return; }

  if (req.method === 'POST' && url.pathname === '/pair') {
    // Reaching here means this client already holds the token (the authed() gate is above),
    // so it may arm ONE more auto-pair — that is how a second app window still pairs after
    // the launcher's first one spent the latch. An unauthenticated attacker cannot re-arm,
    // which is the entire point: the thing they lack is exactly the thing this requires.
    armPairing();
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
  // CODE chat → the raw Pi agent: streams Pi's answer + tool activity as NDJSON. Pi drives the
  // app through the clone-frame extension (op=app + /mod/*); BYOK, one hard limit (anti-wipe).
  if (req.method === 'POST' && url.pathname === '/pi-chat') {
    let P; try { P = await getMod('pi'); } catch (e) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('pi unavailable: ' + ((e && e.message) || e)); return; }
    const b = await readBody(req, res); if (b === null) return;   // 413 already answered
    await P.handlePiChat(req, res, b, { streamHead }); return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/mod/')) { await handleMod(req, res, url.pathname.slice(5), await readBody(req)); return; }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'not found' }));
}

// ── live PTY terminal — ONE token-gated WS at GET /stream (boundary DATA plane) ───
// wsGuard repeats EVERY http guard: correct path + localOnly (loopback socket + our
// Host header, anti DNS-rebinding) + the pairing token carried in the Sec-WebSocket-
// Protocol subprotocol 'cfhub.bearer.<token>' (NEVER the URL, so proxied/logged URLs
// can't leak it). Only the non-secret 'cfhub' subprotocol is echoed back. On success
// the raw socket is handed to Pty.attach, which owns all I/O, resize, and idle/lifetime caps.
const wss = WebSocketServer ? new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024,
  handleProtocols: (protos) => (protos && protos.has && protos.has('cfhub')) ? 'cfhub' : false }) : null;
const tokenEq = (tok) => Session._verify(tok);   // same gate as HTTP: compare + lifetime
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
    // the `it` CLI, on PATH only inside iT shells
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
      '# the iT command line (`it`)',
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
  // main-app control plane — the running window parks one socket here so the Pi agent (via
  // /mod/app) can open panels + read the live screen. Sibling of op=it; same host/token gates.
  if (op === 'app') { try { (await getMod('app')).attachCtl(ws); } catch { try { ws.close(1011, 'app unavailable'); } catch {} } return; }
  // BROWSER data plane — the panel parks one socket here: screencast frames are PUSHED
  // (no 30Hz HTTP polling) and pointer/keyboard input rides the same socket. Sibling of
  // op=it/app; same host/token gates as every stream.
  if (op === 'web') { try { (await getMod('webengine')).attachWs(ws); } catch { try { ws.close(1011, 'webengine unavailable'); } catch {} } return; }
  let Pty; try { Pty = await getMod('pty'); } catch { try { ws.close(1011, 'pty unavailable'); } catch {} return; }
  const cols = Math.max(1, Math.min(1000, Number(url.searchParams.get('cols')) || 80));
  const rows = Math.max(1, Math.min(1000, Number(url.searchParams.get('rows')) || 24));
  const cwd = url.searchParams.get('cwd') || undefined;
  let hello;
  // op='attach' (spawning an external multiplexer to ride on its sessions) was removed on
  // 2026-07-26. It was a second, redundant way to do what op='keeper' does with our OWN
  // engine — persistent shells that survive a disconnect AND a bridge restart, with
  // scrollback replay — and it made the app depend on a program we neither ship nor control.
  // Nothing is lost: every iT tab is a real TTY, so anyone who wants another multiplexer can
  // still run it inside one, like any other command.
  if (op === 'ssh') {
    // iT remote — a (persistence-capable) PTY running `ssh <alias>`. This is OUR own remote
    // engine; ssh is only the transport. Gated by the default-OFF `ssh` permission.
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
    // iT Keeper — OUR own session persistence. The session lives in a DETACHED daemon that
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
    // iT identity for the `it` CLI:
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
  // one-time: move any plaintext provider keys into the macOS Keychain (BUG-L7-001);
  // deliberately here — importing models.mjs must never exec `security` as a side effect
  getMod('models').then((m) => { try { m._migrateKeys && m._migrateKeys(); } catch { /* best effort */ } }).catch(() => {});
  const endpoint = `http://${HOST}:${PORT}`;
  const pair = `${endpoint}#token=${Session._token()}`;
  const line = '─'.repeat(64);
  console.log(`\n\x1b[38;5;176m▓▒ CLONE FRAME · HUB — local app v${VERSION}\x1b[0m`);
  console.log(line);
  console.log(`  app        \x1b[1m${endpoint}\x1b[0m  ← open this (auto-pairs)`);
  const brain = await Chat.brain();
  console.log(`  brain      ${brain.ready ? '\x1b[32m' + (brain.provider || 'model') + ' (' + brain.model + ') — from Settings/env, any provider\x1b[0m' : '\x1b[33mnone — add a provider, or set DEEPSEEK_API_KEY / ANTHROPIC_API_KEY in ~/.env.local\x1b[0m'}`);
  console.log(`  shell      zsh · cwd ${Shell.cwd()}`);
  console.log(`  bind       ${HOST} only  ·  token gate ON  ·  serving ${path.basename(HUB_ROOT)}/`);
  const sp = Session.get();
  console.log(`  session    ${sp.mode === 'expiring'
    ? `expires in ${Math.max(0, Math.round(sp.remainingMs / 60000))} min (${sp.hours}h token · Settings → Session)`
    : 'permanent token — change it in Settings → Session'}`);
  console.log(line);
  console.log(`  Opened via the launcher, the Chrome app window auto-connects.`);
  console.log(`  For the dev preview (other origin), paste into MY MACHINE → HUB BRIDGE:`);
  // The pairing token is the WHOLE authentication for this daemon, and this banner is
  // the first thing anyone copies into a bug report or a screen recording. Printing it
  // by default put it in every launch.log, every scrollback and every "here is my
  // terminal output" — the one place a local-only secret must never end up. The dev
  // path still exists, on purpose, but you now have to ask for it.
  if (process.env.HUB_BRIDGE_SHOW_TOKEN === '1') {
    console.log(`  \x1b[38;5;176m${pair}\x1b[0m`);
  } else {
    console.log(`  \x1b[38;5;176m${endpoint}#token=\x1b[2m…\x1b[0m\x1b[38;5;176m\x1b[0m   \x1b[2m(hidden — HUB_BRIDGE_SHOW_TOKEN=1 to print it)\x1b[0m`);
  }
  console.log(`  (token at ~/.clone-frame-hub/bridge.token · chmod 600)`);
  console.log(line + '\n');
  bootTasks();
});
server.on('error', (e) => { console.error('bridge error:', e.message); process.exit(1); });

// Take the browser engine down with us, so its disposable profile is erased rather than left
// on disk until some future launch. webengine.stop() wipes it; nothing was calling stop() when
// the daemon exited, so a Ctrl-C left the engine's cookies and cache sitting there — measured:
// 7 cookies for a link-redirect domain, still on disk with no engine running.
// Best-effort and time-boxed: quitting must never hang on cleanup.
{
  let leaving = false;
  const bye = (sig) => {
    if (leaving) return; leaving = true;
    const done = () => process.exit(sig === 'SIGINT' ? 130 : 143);
    const timer = setTimeout(done, 3000);          // never hang the quit
    (async () => {
      try { const m = await import('./webengine.mjs'); await m.Webengine.stop(); } catch { /* not running */ }
      clearTimeout(timer); done();
    })();
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
}
