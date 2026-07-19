#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB BRIDGE
// A local daemon that gives the HUB terminal a REAL body on your machine:
//   • runs real shell commands (zsh) and streams their output
//   • relays natural-language prompts to Claude (Anthropic) — BYOK, on your disk
//
// Zero dependencies. Node 18+ built-ins only (global fetch, ReadableStream,
// crypto, child_process, http). Binds 127.0.0.1 ONLY. Never logs your key.
// Your ANTHROPIC_API_KEY never leaves this machine and is NEVER in the website.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
// guarded (never crash the daemon if 'ws' is absent — /stream just becomes unavailable).
// ws is CommonJS: the WebSocketServer lives on the default export, not as a named ESM export.
let WebSocketServer = null;
try { const _ws = await import('ws'); WebSocketServer = _ws.WebSocketServer || (_ws.default && (_ws.default.WebSocketServer || _ws.default.Server)) || null; } catch { WebSocketServer = null; }

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.dirname(BRIDGE_DIR); // the clone-frame-hub dir (serves the app)
const VERSION = '0.2.0';
const HOST = '127.0.0.1';                       // localhost only — refuse anything else
const PORT = Number(process.env.HUB_BRIDGE_PORT || 8765);
const OUT_CAP = 512 * 1024;                      // 512 KiB max output per command
const CMD_TIMEOUT = 120_000;                     // 2 min hard cap per command
const CHAT_TIMEOUT = 120_000;
const DEFAULT_MODEL = process.env.HUB_BRIDGE_MODEL || 'claude-opus-4-8';
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

// ── agent field guide → the root of iT (~/.clone-frame-hub/AGENTS.md) ─────────
// The bundle ships context/AGENTS.md; mirror it into the iT runtime root so any
// iT shell (and `it context`) finds it, and so it travels with a downloaded app.
function ensureContext() {
  try {
    const src = path.join(HUB_ROOT, 'context', 'AGENTS.md');
    if (!fs.existsSync(src)) return;
    const dst = path.join(CONFIG_DIR, 'AGENTS.md');
    const s = fs.statSync(src);
    let stale = true;
    try { stale = fs.statSync(dst).mtimeMs < s.mtimeMs; } catch {}
    if (stale) fs.copyFileSync(src, dst);
  } catch {}
}
ensureContext();

// ── Anthropic key: env first, then ~/.env.local (never printed, never logged) ─
function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  for (const f of [path.join(homedir(), '.env.local'), path.join(homedir(), '.env')]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {}
  }
  return null;
}
const KEY = loadKey();

// ── shell state: a single tracked working directory ─────────────────────────
const state = { cwd: process.env.HOME || homedir(), prev: null };
const running = new Map(); // id -> child process (for interrupt)

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

// ── static app serving (this makes the HUB a real local app on this origin) ──
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.includes('..')) return false;
  const file = path.join(HUB_ROOT, rel);
  if (file !== HUB_ROOT && !file.startsWith(HUB_ROOT + path.sep)) return false;
  // never expose dotfiles or the bridge source dir
  if (/(^|\/)\.[^/]/.test(rel) || rel === '/bridge' || rel.startsWith('/bridge/')) { res.writeHead(404); res.end('not found'); return true; }
  let data;
  try { if (fs.statSync(file).isDirectory()) return false; data = fs.readFileSync(file); }
  catch { return false; }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') {
    // auto-pair ONLY on a real top-level navigation — a malicious page's fetch()
    // has sec-fetch-dest:empty and cannot forge 'document', so it can't scrape the token.
    const dest = req.headers['sec-fetch-dest'];
    // Only inject the token on a REAL top-level browser navigation. The Chrome --app
    // window always sends dest:'document'; a non-browser client (curl run by ANOTHER
    // local user) sends undefined — denying it there stops cross-user token theft.
    const isNav = dest === 'document';
    let html = data.toString('utf8');
    if (isNav) {
      const inject = `<script>window.__CFHUB_BRIDGE__=${JSON.stringify({ endpoint: `http://${HOST}:${PORT}`, token: TOKEN })};</script>`;
      html = html.includes('<head>') ? html.replace('<head>', '<head>' + inject) : inject + html;
    }
    data = Buffer.from(html, 'utf8');
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
  return true;
}

// ── shell exec ───────────────────────────────────────────────────────────────
function resolveCd(arg) {
  const home = process.env.HOME || homedir();
  if (!arg || arg === '~') return home;
  if (arg === '-') return state.prev || state.cwd;
  let p = arg.startsWith('~') ? path.join(home, arg.slice(1)) : arg;
  if (!path.isAbsolute(p)) p = path.resolve(state.cwd, p);
  return p;
}
async function handleShell(req, res, body) {
  const cmd = String(body.cmd || '').trim();
  const id = String(body.id || randomBytes(4).toString('hex'));
  streamHead(res);
  if (!cmd) { res.end(); return; }

  // built-in cd (persists the tracked cwd; real terminals need this)
  const cdMatch = cmd.match(/^cd(?:\s+(.+))?$/);
  if (cdMatch) {
    const target = resolveCd((cdMatch[1] || '').trim().replace(/^["']|["']$/g, ''));
    try {
      if (fs.statSync(target).isDirectory()) { state.prev = state.cwd; state.cwd = target; res.end('\x00CWD\x00' + state.cwd); }
      else res.end('cd: not a directory: ' + target + '\n');
    } catch { res.end('cd: no such file or directory: ' + target + '\n'); }
    return;
  }
  if (cmd === 'pwd') { res.end(state.cwd + '\n\x00CWD\x00' + state.cwd); return; }
  if (cmd === 'clear') { res.end('\x00CLEAR\x00'); return; }

  // destructive-pattern guard — blocked even with root, always
  if (/\brm\s+-[a-z]*[rf][a-z]*\s+(\/\*{0,2}(\s|$)|~(\/|\s|$)|\$HOME)/.test(cmd) || /\bmkfs\b/.test(cmd) || /\bdd\b[^\n]*of=\/dev\//.test(cmd) || /:\(\)\s*\{\s*:\|:/.test(cmd)) {
    res.end('\x00ERR\x00refused: catastrophic pattern blocked for safety\n'); return;
  }
  // sudo / root — only when Root mode is ON; password is per-request, never stored/logged
  let spawnCmd = cmd, sudoPass = null;
  if (/^\s*sudo\b/.test(cmd)) {
    let allowed = false;
    try { const P = await getMod('permissions'); allowed = P.can && P.can('root'); } catch {}
    if (!allowed) { res.end('\x00ERR\x00root/sudo is OFF. Enable "Root mode" in Settings → Agent and try again.\n'); return; }
    sudoPass = body.sudoPass || '';
    if (!sudoPass) { res.end('\x00NEEDSUDO\x00'); return; }
    spawnCmd = cmd.replace(/^\s*sudo\b/, 'sudo -S -p ""');
  }

  let sent = 0, killedForCap = false;
  const child = spawn('zsh', ['-lc', spawnCmd], {
    cwd: fs.existsSync(state.cwd) ? state.cwd : (process.env.HOME || homedir()),
    env: process.env,
    detached: true, // own process group → SIGINT/SIGKILL the whole tree (npm run dev, sleep, …)
  });
  if (sudoPass) { try { child.stdin.write(sudoPass + '\n'); child.stdin.end(); } catch {} }
  const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
  running.set(id, killGroup);
  const to = setTimeout(() => { killGroup('SIGKILL'); res.write('\n\x00ERR\x00command timed out (2m)\n'); }, CMD_TIMEOUT);
  const push = (buf) => {
    if (killedForCap) return;
    sent += buf.length;
    if (sent > OUT_CAP) { killedForCap = true; killGroup('SIGKILL'); res.write('\n\x00ERR\x00output capped (512 KiB)\n'); return; }
    res.write(buf);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { res.write('\x00ERR\x00' + e.message + '\n'); });
  child.on('close', (code) => {
    clearTimeout(to); running.delete(id);
    res.end('\x00EXIT\x00' + (code ?? 0) + '\x00CWD\x00' + state.cwd);
  });
  req.on('close', () => killGroup('SIGKILL'));
}

// ── Claude relay (streaming SSE → plain text chunks) ─────────────────────────
async function handleChat(req, res, body) {
  if (!KEY) { res.writeHead(501, { 'Content-Type': 'text/plain' }); res.end('no ANTHROPIC_API_KEY on this machine'); return; }
  streamHead(res);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = body.model || DEFAULT_MODEL;
  const system = body.system || 'You are the model the owner connected to CLONE FRAME. Answer helpfully, directly and honestly. You have real access to this machine\'s terminal through the HUB Bridge.';
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), CHAT_TIMEOUT);
  req.on('close', () => ctl.abort());
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: j({ model, max_tokens: Number(body.max_tokens) || 2048, system, messages, stream: true }),
    });
    if (!r.ok || !r.body) { const t = await r.text().catch(() => ''); res.end('\x00ERR\x00anthropic ' + r.status + ' ' + t.slice(0, 300)); clearTimeout(to); return; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim(); if (payload === '[DONE]') continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') res.write(ev.delta.text);
          else if (ev.type === 'error') res.write('\x00ERR\x00' + (ev.error?.message || 'stream error'));
        } catch {}
      }
    }
    res.end();
  } catch (e) {
    res.end('\x00ERR\x00' + (e.name === 'AbortError' ? 'timeout' : e.message));
  } finally { clearTimeout(to); }
}

// ── Email (real IMAP/SMTP via email.mjs — lazily loaded so a mail issue never
//    takes down shell/chat; deps: imapflow + nodemailer + mailparser) ─────────
let _emailMod = null, _emailErr = null;
async function getEmail() {
  if (_emailMod) return _emailMod;
  if (_emailErr) throw _emailErr;
  try { const m = await import('./email.mjs'); _emailMod = m.Email || m.default || m; return _emailMod; }
  catch (e) { _emailErr = e; throw e; }
}
async function handleEmail(req, res, pathname, body) {
  const ok = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(j(o)); };
  const fail = (code, e) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: String((e && e.message) || e) })); };
  let Email;
  try { Email = await getEmail(); } catch (e) { return fail(503, 'email engine unavailable: ' + ((e && e.message) || e)); }
  try {
    switch (pathname) {
      case '/email/accounts':        return ok(await Email.listAccounts());
      case '/email/account/get':     return ok(await Email.getAccount(body.id));
      case '/email/account/add':     return ok(await Email.addAccount(body));
      case '/email/account/test':    return ok(await Email.testAccount(body));
      case '/email/account/remove':  return ok(await Email.removeAccount(body.id));
      case '/email/account/default': return ok(await Email.setDefault(body.id));
      case '/email/folders':         return ok(await Email.folders(body.accountId));
      case '/email/list':            return ok(await Email.list(body.accountId, body.folder, body.opts || {}));
      case '/email/message':         return ok(await Email.message(body.accountId, body.folder, body.uid));
      case '/email/attachment':      return ok(await Email.attachment(body.accountId, body.folder, body.uid, body.partId));
      case '/email/send':            return ok(await Email.send(body.accountId, body.msg || {}));
      case '/email/flag':            return ok(await Email.flag(body.accountId, body.folder, body.uid, body.flags || {}));
      case '/email/move':            return ok(await Email.move(body.accountId, body.folder, body.uid, body.target));
      case '/email/drafts':          return ok(await Email.listDrafts(body.accountId, body.opts || {}));
      case '/email/draft/save':      return ok(await Email.saveDraft(body.accountId, body.draft));
      case '/email/draft/delete':    return ok(await Email.deleteDraft(body.accountId, body.uid));
      case '/email/refresh':         return ok(await Email.idleSince(body.accountId, body.folder, body.sinceUid || 0));
      default: return fail(404, 'unknown email route');
    }
  } catch (e) { return fail(500, e); }
}

// ── provider chat: stream from the user's OWN model (API or local), any provider
//    Anthropic → /v1/messages ; everyone else (OpenAI/DeepSeek/Groq/Ollama/…) → /chat/completions
async function handleProviderChat(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system || '';
  const maxTok = Number(body.max_tokens) || 2048;
  let Models; try { Models = await getMod('models'); } catch (e) { res.writeHead(503); res.end('models module off'); return; }
  const raw = Models._raw && Models._raw(String(body.providerId || ''));
  if (!raw) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('provider not found'); return; }
  const model = body.model || (raw.models && raw.models[0]) || 'auto';
  const key = raw.apiKey || '';
  const anthropic = Models._isAnthropic ? Models._isAnthropic(raw.provider, raw.baseUrl) : false;
  streamHead(res);
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), CHAT_TIMEOUT); req.on('close', () => ctl.abort());
  try {
    if (anthropic) {
      // tolerate a stored base that already ends in /v1 (e.g. https://api.anthropic.com/v1)
      let base = (raw.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v\d+$/, '');
      const r = await fetch(base + '/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: j({ model, max_tokens: maxTok, system, messages, stream: true }),
      });
      if (!r.ok || !r.body) { const t = await r.text().catch(() => ''); res.end('\x00ERR\x00' + r.status + ' ' + t.slice(0, 300)); clearTimeout(to); return; }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; const p = line.slice(5).trim(); if (p === '[DONE]') continue;
          try { const ev = JSON.parse(p); if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') res.write(ev.delta.text); else if (ev.type === 'error') res.write('\x00ERR\x00' + (ev.error?.message || 'stream error')); } catch {} } }
      res.end();
    } else {
      // OpenAI-compatible (also Ollama/llama.cpp/vLLM local)
      let base = (raw.baseUrl || '').replace(/\/+$/, '');
      const url = /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
      const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const headers = { 'content-type': 'application/json' };
      if (raw.kind === 'api' && key) headers.Authorization = 'Bearer ' + key;
      const r = await fetch(url, { method: 'POST', signal: ctl.signal, headers, body: j({ model, messages: msgs, stream: true, max_tokens: maxTok }) });
      if (!r.ok || !r.body) { const t = await r.text().catch(() => ''); res.end('\x00ERR\x00' + r.status + ' ' + t.slice(0, 300)); clearTimeout(to); return; }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; const p = line.slice(5).trim(); if (p === '[DONE]') continue;
          try { const ev = JSON.parse(p); const d = ev.choices?.[0]?.delta?.content; if (d) res.write(d); } catch {} } }
      res.end();
    }
  } catch (e) { res.end('\x00ERR\x00' + (e.name === 'AbortError' ? 'timeout' : e.message)); }
  finally { clearTimeout(to); }
}

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
  pty: './pty.mjs', it: './it.mjs', ssh: './ssh.mjs', keeper: './keeper.mjs' };
const MODEXPORT = { tasks: 'Tasks', approvals: 'Approvals', style: 'Style', contacts: 'Contacts', integrations: 'Integrations',
  models: 'Models', calendar: 'Calendar', notes: 'Notes', library: 'Library', research: 'Research',
  cookbook: 'Cookbook', gallery: 'Gallery', compare: 'Compare', reminders: 'Reminders', admin: 'Admin',
  scheduled: 'Scheduled', oauth: 'OAuth', images: 'Images', search: 'Search', web: 'Web',
  browser: 'Browser', harness: 'Harness', nft: 'NFT', files: 'Files', permissions: 'Permissions', acp: 'Acp',
  robinhood: 'Robinhood', okxai: 'OkxAi', virtuals: 'Virtuals',
  pty: 'Pty', it: 'It', ssh: 'Ssh', keeper: 'Keeper' };
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
  if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
  // in-app browser proxy — token-LESS by design (see handleProxy). localOnly() already passed.
  if (req.method === 'GET' && url.pathname === '/proxy') { await handleProxy(req, res, url); return; }
  // everything else requires the pairing token
  if (!authed(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(j({ ok: false, error: 'unpaired' })); return; }

  if (req.method === 'POST' && url.pathname === '/pair') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(j({ ok: true, cwd: state.cwd, brain: KEY ? 'anthropic' : 'none', model: KEY ? DEFAULT_MODEL : null })); return;
  }
  if (req.method === 'POST' && url.pathname === '/shell') { handleShell(req, res, await readBody(req)); return; }
  if (req.method === 'POST' && url.pathname === '/interrupt') {
    const { id } = await readBody(req); const c = running.get(String(id));
    if (c) c('SIGINT');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(j({ ok: !!c })); return;
  }
  if (req.method === 'POST' && url.pathname === '/chat') { await handleChat(req, res, await readBody(req)); return; }
  if (req.method === 'POST' && url.pathname === '/provider-chat') { await handleProviderChat(req, res, await readBody(req)); return; }
  if (req.method === 'POST' && url.pathname.startsWith('/email/')) { await handleEmail(req, res, url.pathname, await readBody(req)); return; }
  if (req.method === 'GET' && url.pathname === '/email/accounts') { await handleEmail(req, res, '/email/accounts', {}); return; }
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
server.listen(PORT, HOST, () => {
  const endpoint = `http://${HOST}:${PORT}`;
  const pair = `${endpoint}#token=${TOKEN}`;
  const line = '─'.repeat(64);
  console.log(`\n\x1b[38;5;176m▓▒ CLONE FRAME · HUB — local app v${VERSION}\x1b[0m`);
  console.log(line);
  console.log(`  app        \x1b[1m${endpoint}\x1b[0m  ← open this (auto-pairs)`);
  console.log(`  brain      ${KEY ? '\x1b[32manthropic (' + DEFAULT_MODEL + ') — key loaded from disk\x1b[0m' : '\x1b[33mnone — set ANTHROPIC_API_KEY or ~/.env.local\x1b[0m'}`);
  console.log(`  shell      zsh · cwd ${state.cwd}`);
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
