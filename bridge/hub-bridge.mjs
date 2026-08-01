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
import { serveStatic, armPairing, SECURITY_HEADERS } from './transport/static.mjs';
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
// CACHED, and it does not descend into node_modules.
//
// This ran on EVERY /health call — the one route with no token — and measured 1 872
// directory entries plus 61 statSync calls, ~15 ms, all of it SYNCHRONOUS on the event
// loop that also carries the live terminal, the browser screencast and every chat
// stream. The `node_modules` filter ran AFTER readdirSync had already walked it.
// launch.sh polls this up to 60 times at startup, and any local process could hold the
// daemon at 100% with an unauthenticated loop (DEBUG4 · CF4-B-001).
//
// The answer changes only when a file on disk changes, so a few seconds of cache costs
// nothing real: the whole point of `stale` is to notice an update between launches, not
// within one second of one. Same reasoning as session.mjs's 1s policy TTL, which says so
// in its own comment — this probe is orders of magnitude more expensive and had none.
const STALE_TTL_MS = 5000;
let _staleAt = 0, _staleVal = false;
function walkMjs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;   // never descend
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMjs(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}
function bridgeStale() {
  const age = Date.now() - _staleAt;
  if (age >= 0 && age < STALE_TTL_MS) return _staleVal;
  let v = false;
  try {
    for (const p of walkMjs(BRIDGE_DIR, [])) {
      if (fs.statSync(p).mtimeMs > STARTED_AT) { v = true; break; }
    }
  } catch { /* best effort — never break health */ }
  _staleAt = Date.now(); _staleVal = v;
  return v;
}
// The DOCUMENT can be stale too, and in a way a reload does not fix: web/ is the source and
// dist/index.html is what is served, so editing a panel without `npm run build` leaves the
// owner running old code with nothing on screen to say so. This only compares the two files
// the build turns into each other — no walk, no cost.
// Cached on the same clock as bridgeStale, and for the same reason: both are answered
// only by /health, which is unauthenticated and polled.
let _appAt = 0, _appVal = false;
function appStale() {
  const age = Date.now() - _appAt;
  if (age >= 0 && age < STALE_TTL_MS) return _appVal;
  let v = false;
  try {
    const src = path.join(HUB_ROOT, 'web', 'index.html');
    const out = path.join(HUB_ROOT, 'dist', 'index.html');
    if (fs.existsSync(src) && fs.existsSync(out)) {
      const built = fs.statSync(out).mtimeMs;
      if (fs.statSync(src).mtimeMs > built) v = true;
      if (!v) for (const f of fs.readdirSync(path.join(HUB_ROOT, 'web', 'panels'))) {
        if (f.endsWith('.js') && fs.statSync(path.join(HUB_ROOT, 'web', 'panels', f)).mtimeMs > built) { v = true; break; }
      }
    }
  } catch { /* not a source checkout — nothing to compare */ }
  _appAt = Date.now(); _appVal = v;
  return v;
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
// EVERY response in this daemon goes out through one of these two, so the security
// header set cannot be forgotten by a route added next month. Previously the headers
// lived inside transport/static.mjs and only static files carried them; six other
// writeHead sites in this file had none (DEBUG4 · CF4-B-003).
function head(res, code, extra) {
  res.writeHead(code, { ...SECURITY_HEADERS, ...(extra || {}) });
}
function sendJson(res, code, obj) {
  head(res, code, { 'Content-Type': 'application/json' });
  res.end(j(obj));
}
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
const BODY_MAX = 64e6;   // BYTES — see below
// Chunks are COLLECTED and decoded once, never accumulated into a string.
//
// This used to be `b += c`, which calls toString() on each Buffer independently — so a
// character whose UTF-8 bytes straddle a chunk boundary (Node chunks at ~64 KB) was
// decoded as two invalid fragments. Reproduced exactly:
//
//   original    : Olá — ação, coração, não. 😀 iNFT · CLONE FRAME
//   reassembled : Ol�� — ação, coração, não. 😀 iNFT · CLONE FRAME
//
// Silent and unrecoverable: U+FFFD is legal inside a JSON string, so JSON.parse still
// succeeded and the prompt simply arrived with mojibake in it. In an app whose owner
// writes Portuguese and whose body limit is 64 MB precisely because people paste large
// things into it, that is not a rare shape (DEBUG4 · CF4-B-002).
//
// The cap is measured in BYTES now too. `b.length` counted UTF-16 code units, so the
// stated 64 MB admitted up to ~192 MB of UTF-8 — with V8 holding and repeatedly
// reallocating the growing string the whole time (DEBUG4 · CF4-B-006).
function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = []; let bytes = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      bytes += buf.length;
      if (bytes > BODY_MAX) {
        over = true; chunks.length = 0;
        if (res && !res.headersSent) { try { sendJson(res, 413, { ok: false, error: 'that message is too large — attach fewer or smaller images' }); } catch {} }
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    // null means "already answered with 413" — only possible when a res was handed in, so
    // the callers that do not pass one keep their old never-throws contract.
    req.on('end', () => {
      if (over) return resolve(res ? null : {});
      // ONE decode, over the whole body, so no boundary can fall inside a character.
      let text = '';
      try { text = Buffer.concat(chunks).toString('utf8'); } catch { return resolve({}); }
      try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve(over && res ? null : {}));
  });
}
function streamHead(res) {
  head(res, 200, {
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
  const ok = (o) => sendJson(res, 200, o);
  const fail = (code, e) => sendJson(res, code, { ok: false, error: String((e && e.message) || e) });
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
    // FIRST: the control plane. An agent may not edit the rules that constrain it, the tool
    // inventory it runs on, or the pairing identity — no permission unlocks these, because a
    // switch the agent can flip is not a switch. See Permissions.agentForbidden.
    let CP = null;
    try { ({ Permissions: CP } = await import('./permissions.mjs')); }
    catch (e) { return fail(503, 'permission gate unavailable: ' + ((e && e.message) || e)); }
    const forbidden = CP.agentForbidden(name, fn);
    if (forbidden) return fail(403, 'refused: ' + forbidden);
    // …and the anti-wipe, which asks what is IN the call rather than who is making it.
    // pty.open was guarded and pty.write was not, so "open a shell, then write into it"
    // walked around the one limit the product says cannot be turned off. See
    // Permissions.agentContentGuard for why this binds the agent and never the owner.
    const unsafe = CP.agentContentGuard(name, fn, body.args);
    if (unsafe) return fail(403, 'refused: ' + unsafe);
    // THEN the owner's own app_rpc allowlist, for everything else.
    if (name !== 'rpcallow') {
      let RpcAllow = null;
      try { ({ RpcAllow } = await import('./rpcallow.mjs')); }
      catch (e) { return fail(503, 'the agent allowlist could not be loaded: ' + ((e && e.message) || e)); }
      // A read failure is NOT the same event as "no policy configured". The module answers
      // the shipped default (mode:'open') for an absent file all by itself, so reaching this
      // catch means a policy EXISTS and could not be read — a truncated write, a bad hand-edit,
      // a disk error. Failing open there silently discards a restriction the owner chose, which
      // is the one outcome they would never pick. So it fails CLOSED and says why, exactly like
      // the email gate below. (DEBUG4 · CF4-B-004)
      let verdict;
      try { verdict = RpcAllow.check(name, fn); }
      catch (e) { return fail(403, 'refused: your app_rpc policy could not be read, so nothing is '
        + 'allowed until it is fixed (Settings → Agent Tools): ' + ((e && e.message) || e)); }
      if (!verdict.allowed) return fail(403, verdict.reason);
    }
    // …and the few calls that send mail on the owner's behalf need the owner's toggle. See
    // Permissions.agentGateFor for why these three and no others. Unlike the allowlist above
    // this fails CLOSED: it guards an irreversible, outward-facing act, and the app promises
    // in SETTINGS that it cannot happen with the switch off. Note the error names the way out —
    // an agent told "refused" queues to APPROVAL; one told "error" tends to drop the draft.
    const need = CP.agentGateFor(name, fn);
    if (need && !CP.can(need)) {
      return fail(403, 'refused: the "' + need + '" permission is off — ' + CP.agentGateAdvice(need));
    }
  }
  let obj;
  try { obj = await getMod(name); } catch (e) { return fail(503, name + ' unavailable: ' + ((e && e.message) || e)); }
  const f = obj[fn];
  if (typeof f !== 'function') return fail(400, 'no such fn: ' + fn);
  try { return ok(await f.apply(obj, Array.isArray(body.args) ? body.args : [])); }
  catch (e) {
    // A TypeError raised by applying the function is the CALLER's arguments, not a fault in
    // the daemon. Answering 500 told an agent to retry something that will never work, and
    // handed back a fragment of V8's own text ("Cannot destructure property 'status' of…")
    // as if it were an answer. 400 says whose problem it is, and names the call.
    if (e instanceof TypeError) {
      return fail(400, name + '.' + fn + ' — the arguments were not what it accepts: ' + ((e && e.message) || e));
    }
    return fail(500, e);
  }
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
    if (!res.headersSent) { sendJson(res, 500, { ok: false, error: 'request failed' }); }
    else { try { res.end(); } catch {} }
  }
});

async function route(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { head(res, 204); res.end(); return; }
  try { req.socket.setNoDelay(true); } catch {}
  if (!localOnly(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return; }
  const url = new URL(req.url, 'http://x');

  // /health is open (needed for probing) — deliberately minimal: no cwd (leaks the
  // macOS username), no brain/model. Those come from POST /pair, behind the token.
  // `stale` says the bridge/*.mjs on disk is NEWER than this running process — a
  // long-lived daemon serving old code was the real cause of "email → 404" (the UI
  // reloads with ⌘R but the daemon only reloads on relaunch).
  if (url.pathname === '/health') {
    // one writer, one header set — see head()/sendJson()
    // `root: HUB_ROOT` was here and it contradicted the comment two lines up: HUB_ROOT is
    // /Users/<name>/… , so an UNAUTHENTICATED probe learned the macOS username, the desktop
    // layout and where the repo lives. It was added in 3d18a2d of this session's own work,
    // for diagnostics that appStale already answers as a boolean, and nothing ever read it —
    // every `.root` in the client comes from RPC('folders','root'), which is behind the token.
    // `sockets` is the honest half of the answer. Without the `ws` dependency the upgrade
    // handler refuses EVERY WebSocket, and the three biggest surfaces — the iT terminal, the
    // browser's frame push and the agent control plane — go dark with nothing on screen to
    // say why. The app reads this and tells the owner instead of looking broken.
    sendJson(res, 200, { ok: true, name: 'HUB Bridge', version: VERSION, host: HOST, sockets: !!WebSocketServer, stale: bridgeStale(), appStale: appStale() });
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
    let P; try { P = await getMod('pi'); } catch (e) { head(res, 503, { 'Content-Type': 'text/plain' }); res.end('pi unavailable: ' + ((e && e.message) || e)); return; }
    await P.handleRelay(req, res, url.pathname.slice(5) + (url.search || ''));
    return;
  }
  // everything else requires the pairing token
  if (!authed(req)) { sendJson(res, 401, { ok: false, error: 'unpaired' }); return; }

  if (req.method === 'POST' && url.pathname === '/pair') {
    // Reaching here means this client already holds the token (the authed() gate is above),
    // so it may arm ONE more auto-pair — that is how a second app window still pairs after
    // the launcher's first one spent the latch. An unauthenticated attacker cannot re-arm,
    // which is the entire point: the thing they lack is exactly the thing this requires.
    armPairing();
    const b = await Chat.brain();
    sendJson(res, 200, { ok: true, cwd: Shell.cwd(), brain: b.ready ? (b.provider || 'ready') : 'none', model: b.model, provider: b.provider || null }); return;
  }
  // AWAITED, like its four siblings. The router wrapper added two commits ago catches what
  // `route()` throws — and an un-awaited async call throws into NOBODY. `POST /shell` with a
  // body of literal `null` (readBody JSON.parses it) reaches shell.mjs and rejects, which is
  // an unhandled rejection, which ends the process. The one route left un-awaited was the one
  // route that could still kill the daemon.
  if (req.method === 'POST' && url.pathname === '/shell') { await Shell.handleShell(req, res, await readBody(req), { streamHead }); return; }
  if (req.method === 'POST' && url.pathname === '/interrupt') {
    const { id } = await readBody(req);
    sendJson(res, 200, { ok: Shell.interrupt(id) }); return;
  }
  if (req.method === 'POST' && url.pathname === '/chat') { await Chat.handleChat(req, res, await readBody(req), { streamHead }); return; }
  if (req.method === 'POST' && url.pathname === '/provider-chat') { await Chat.handleProviderChat(req, res, await readBody(req), { streamHead }); return; }
  // CODE chat → the raw Pi agent: streams Pi's answer + tool activity as NDJSON. Pi drives the
  // app through the clone-frame extension (op=app + /mod/*); BYOK, one hard limit (anti-wipe).
  if (req.method === 'POST' && url.pathname === '/pi-chat') {
    let P; try { P = await getMod('pi'); } catch (e) { head(res, 503, { 'Content-Type': 'text/plain' }); res.end('pi unavailable: ' + ((e && e.message) || e)); return; }
    const b = await readBody(req, res); if (b === null) return;   // 413 already answered
    await P.handlePiChat(req, res, b, { streamHead }); return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/mod/')) { await handleMod(req, res, url.pathname.slice(5), await readBody(req)); return; }
  sendJson(res, 404, { ok: false, error: 'not found' });
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
    // fileURLToPath, not .pathname. A file: URL percent-encodes, so `.pathname` hands back
    // "…/CLONE%20FRAME%20HUB.app/…" — a path that does not exist. Harmless while the daemon
    // only ever ran from a developer's space-free checkout; guaranteed broken the moment the
    // installer started putting it inside "CLONE FRAME HUB.app", which has two spaces in its
    // name. Every `it` command in every installed release would have failed to find its script.
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'it-cli.mjs');
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
  if (op === 'it') { try { (await getMod('it'))._attachCtl(ws); } catch { try { ws.close(1011, 'it unavailable'); } catch {} } return; }
  // main-app control plane — the running window parks one socket here so the Pi agent (via
  // /mod/app) can open panels + read the live screen. Sibling of op=it; same host/token gates.
  if (op === 'app') { try { (await getMod('app'))._attachCtl(ws); } catch { try { ws.close(1011, 'app unavailable'); } catch {} } return; }
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
  // Say it out loud. `ws` is the daemon's one hard dependency, and install.command is what
  // puts it there — but a half-finished install, or running this file straight out of the
  // download, leaves it absent. The upgrade handler then refuses every socket and the iT
  // terminal, the browser and the agent control plane are all simply dead, with the rest of
  // the app looking perfectly fine. Nothing said so; a whole class of "it's broken" reports
  // was one missing folder.
  if (!WebSocketServer) {
    console.log('  \x1b[33msockets    OFF — the `ws` package is missing, so the iT terminal, the BROWSER and');
    console.log('             the agent control plane cannot connect. Run install.command (or, in this');
    console.log('             folder: npm install --omit=dev) and start the app again.\x1b[0m');
  }
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
// …and the terminals. iT Keeper sessions live in DETACHED daemons on purpose — a shell
// that survives a reload is the feature — but nothing ever took them down again. Not
// quitting, not stopping the bridge, and not the uninstaller, whose guard matches
// `hub-bridge.mjs` and therefore cannot see a process running `keeper.mjs`. Each one
// holds a live shell, and one that is producing output never reaches the 12-hour idle
// cap, so "uninstall CLONE FRAME" could leave shells running your code indefinitely with
// the program that started them deleted (DEBUG4 · CF4-B-005).
//
// PERSISTENCE IS STILL THE POINT, so this is deliberately narrow: a keeper session the
// owner explicitly asked to persist survives a bridge RESTART, which is the case the
// feature exists for. What must not survive is the bridge going away for good, and the
// uninstaller now reaps them unconditionally (uninstall.command step 2). Here we take
// down only the ones this process spawned and that nobody asked to keep.
{
  let leaving = false;
  const bye = (sig) => {
    if (leaving) return; leaving = true;
    const done = () => process.exit(sig === 'SIGINT' ? 130 : 143);
    const timer = setTimeout(done, 3000);          // never hang the quit
    (async () => {
      try { const m = await import('./webengine.mjs'); await m.Webengine.stop(); } catch { /* not running */ }
      try { const k = await import('./keeper.mjs'); if (k.Keeper && k.Keeper.stopEphemeral) await k.Keeper.stopEphemeral(); } catch { /* keeper absent */ }
      clearTimeout(timer); done();
    })();
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
}
