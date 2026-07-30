// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — webengine
//
// The CDP web engine behind the rebuilt in-app browser. Owns ONE dedicated
// Chrome instance (own profile: ~/.clone-frame-hub/web-engine) spawned with
// --remote-debugging-pipe: CDP rides fds 3/4 as NUL-delimited JSON — no TCP
// port, no WebSocket, no npm deps. The panel paints Page.startScreencast JPEG
// frames onto a canvas (castStart → poll frame()) and forwards input events
// (input/click/type); the pi agent drives the same engine through the same RPC
// surface (open/navigate/read/screenshot).
//
// Security: reached only through the token-gated POST /mod/webengine router,
// which blocks `_`-prefixed fns — every internal here is `_`-prefixed. RPC can
// navigate to http(s)/about:blank ONLY (the engine runs with the user's fs;
// file:// or chrome:// driven over RPC would be an exfiltration path). No raw
// CDP method name and no caller-supplied JS ever crosses the boundary: input
// maps through a fixed whitelist, read() evaluates one fixed expression.
// Because CDP rides the pipe, Chrome exits when the bridge dies (its end of
// the pipe closes) — no orphaned engines, no pidfile needed.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hubRoot } from './platform/hub-root.mjs';

// Downloads land where every browser puts them. They are the one thing the owner asks
// for BY NAME, so they outlive the ephemeral session on purpose — clearing history has
// never deleted your downloads. Nothing is opened or executed here; the file is written
// and named, and that is all.
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads');
// Where a file the owner picks for an upload is staged. The app's own file picker hands
// back BYTES, never a path (that is the web's rule), while the page needs a real file on
// disk — so the bytes are written here and handed over. Emptied at every engine start:
// nothing the owner uploaded lingers past the session that uploaded it.
const uploadDir = () => path.join(hubRoot(), 'uploads');
const MAX_UPLOAD = 32 * 1024 * 1024;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const EMPTY = Buffer.alloc(0);

// All engine state lives here; wiped as a unit on engine exit so a dead engine
// can never leave a half-alive tab table behind.
const S = {
  proc: null,       // ChildProcess of the engine (null when down)
  ready: false,     // handshake (Browser.getVersion) completed
  starting: null,   // in-flight _ensureEngine promise (single-flight)
  lastExit: null,   // { code, signal, at } of the last engine death
  nextId: 0,        // CDP command id counter
  pending: new Map(),   // id -> { resolve, reject, timer }
  buf: EMPTY,           // fd-4 read buffer, split on NUL
  tabs: new Map(),      // targetId -> { id, sessionId, url, title, casting, seq, frame }
  bySession: new Map(), // CDP sessionId -> tab
  attaching: new Map(), // targetId -> in-flight attach promise (single-flight)
  wsClients: new Set(), // live op=web sockets (attachWs) — frames are PUSHED to watchers
  ctx: null,            // the private (off-the-record) context every owner tab lives in
  inputWs: null,        // socket that last carried input — a popup's causal owner
  inputAt: 0,
  dls: new Map(),       // guid -> { guid, name, url, total, got, state, ts }
  cover: null,          // { left, top, width, height } of the app's own window (see _parkBounds)
  pk: new Map(),        // passkey ceremony tag -> { tabId, at } (see _onPasskey)
  signin: null,         // live sign-in window: { tabId, origin, at, settle }
};

// ── the private session ──────────────────────────────────────────────────────
// Nothing the owner browses is ever written down. Their tabs live in an
// off-the-record browser context: cookies, storage and cache exist in this
// process's memory only, Chrome keeps no history for it, and disposing it
// destroys every trace at once. wipe() disposes it — the panel calls that when
// its last window closes AND before its first window opens, so the browser is
// blank on arrival no matter how the previous run ended (even a kill -9).
// The Google-search worker shares this context (see search()); the on-disk
// default profile is wiped at every engine start and holds nothing of anyone.
async function _ensureCtx() {
  if (S.ctx) return S.ctx;
  const r = await _send('Target.createBrowserContext', { disposeOnDetach: false });
  S.ctx = r.browserContextId;
  // Without this, headless Chrome silently DENIES every download: the owner clicked a
  // download link and nothing happened at all — no file, no navigation, no message
  // (measured 2026-07-25 with a Content-Disposition: attachment link). Allow them, name
  // them, and report their progress so the panel can say what is happening.
  try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch { /* already there */ }
  await _send('Browser.setDownloadBehavior', {
    behavior: 'allow', browserContextId: S.ctx, downloadPath: DOWNLOAD_DIR, eventsEnabled: true,
  }).catch(() => { /* older Chrome: downloads stay denied, and say so honestly */ });
  return S.ctx;
}

// Download events are BROWSER-level: they carry no sessionId, so they are routed the same
// way a popup is — to the window whose click caused them, falling back to every browser
// window (a download nobody is told about is the bug this whole path exists to kill).
function _pushDownload(d) {
  const msg = { t: 'dl', id: d.guid, name: d.name, url: d.url, state: d.state, got: d.got, total: d.total, path: d.path || null };
  if (S.inputWs && S.wsClients.has(S.inputWs) && Date.now() - S.inputAt < 60000) { _wsSend(S.inputWs, msg); return; }
  for (const ws of S.wsClients) _wsSend(ws, msg);
}

// ── WS push plane (op=web) — frames/meta pushed instead of 30Hz HTTP polling ─
function _wsSend(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch { /* client going away */ } }
function _pushWatchers(tabId, obj) {
  for (const ws of S.wsClients) {
    if (!ws._watch || !ws._watch.has(tabId)) continue;
    _wsSend(ws, obj);
  }
}

// Frames ride a dedicated path with LATEST-ONLY backpressure: at most one frame
// sits in a socket's kernel buffer; while it drains, newer frames REPLACE the
// pending one (never queue), and a short timer flushes the tail frame after a
// burst — the old 6MB skip-threshold let ~20 retina frames pile up, so the
// picture the owner saw ran seconds behind the page ("slow, won't run").
// Clients that announce `bin` on watch get [u32 header-len][JSON header][JPEG]
// binary frames — no base64 inflation, no multi-MB JSON.parse on the client.
function _frameBinary(tab, params) {
  const head = Buffer.from(JSON.stringify({ t: 'frame', id: tab.id, seq: tab.seq, metadata: params.metadata }), 'utf8');
  const jpeg = Buffer.from(String(params.data || ''), 'base64');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(head.length, 0);
  return Buffer.concat([len, head, jpeg]);
}
function _wsFrameTo(ws, payload) {
  if (ws.readyState !== 1) return;
  // 512KB ≈ two retina frames in flight. At the old 320KB a single 2400×1400 frame
  // already counted as congestion, so every frame took the timer path.
  if (ws.bufferedAmount > 512 * 1024) {
    ws._lagFrame = payload;
    if (!ws._lagT) {
      // 40ms tail (was 80): after a burst the LAST frame lands within half a frame-tick,
      // so a click's visual answer never waits behind the flush timer.
      ws._lagT = setTimeout(() => { ws._lagT = null; const p = ws._lagFrame; ws._lagFrame = null; if (p) _wsFrameTo(ws, p); }, 40);
      if (ws._lagT.unref) ws._lagT.unref();
    }
    return;
  }
  ws._lagFrame = null;
  try { ws.send(payload); } catch { /* client going away */ }
}
function _pushFrame(tab, params) {
  let bin = null, json = null;
  for (const ws of S.wsClients) {
    if (!ws._watch || !ws._watch.has(tab.id)) continue;
    if (ws._bin) { if (!bin) bin = _frameBinary(tab, params); _wsFrameTo(ws, bin); }
    else { if (!json) json = JSON.stringify({ t: 'frame', id: tab.id, seq: tab.seq, data: params.data, metadata: params.metadata }); _wsFrameTo(ws, json); }
  }
}

function _findChrome() {
  const env = process.env.CFHUB_CHROME;
  // The owner's explicit override wins even unverified — a bad path surfaces
  // honestly as a spawn error instead of silently falling back to another binary.
  if (env && env.trim()) return env.trim();
  for (const p of CHROME_CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ } }
  return null;
}

// http(s) + about:blank only. Everything else (file://, chrome://, javascript:,
// devtools://) is a privilege boundary, not a preference.
function _safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s || s === 'about:blank') return 'about:blank';
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function _clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function _tab(id) { return S.tabs.get(String(id == null ? '' : id)) || null; }
// Agent tools with no id drive the tab the user is looking at — "pi drives the
// browser on screen". Falls back to any live tab.
function _primaryTab() { const arr = [...S.tabs.values()]; return arr[arr.length - 1] || null; }

// ── CDP transport (write fd 3, read fd 4, NUL-delimited JSON) ────────────────
function _send(method, params = {}, sessionId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const pipe = S.proc && S.proc.stdio[3];
    if (!pipe || !pipe.writable) return reject(new Error('engine not running'));
    const id = ++S.nextId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => { S.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeoutMs);
    S.pending.set(id, { resolve, reject, timer });
    try { pipe.write(JSON.stringify(msg) + '\0'); }
    catch (e) { clearTimeout(timer); S.pending.delete(id); reject(e); }
  });
}

function _onData(chunk) {
  S.buf = S.buf.length ? Buffer.concat([S.buf, chunk]) : chunk;
  let i;
  while ((i = S.buf.indexOf(0)) >= 0) {
    const raw = S.buf.subarray(0, i);
    S.buf = i + 1 < S.buf.length ? S.buf.subarray(i + 1) : EMPTY;
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { continue; }
    _onMessage(msg);
  }
}

// ── the passkey moment ───────────────────────────────────────────────────────
// A security key or a platform passkey is the one thing a painted browser cannot do
// alone: the ceremony is a NATIVE dialog drawn by Chrome, and a headless engine has no
// window to draw it on. Measured on this machine, 2026-07-27, on a real
// navigator.credentials.get():
//   --headless=new      → no dialog, the promise never settles (still pending at 6s,
//                         22s, 60s). That is exactly the "it just sits there" the owner
//                         reported at Google's "confirm with your security key" step.
//   headful, on screen  → Chrome shows "Insert your security key and tap it" and the
//                         ceremony completes.
// So a sign-in needs a real window. Two more measurements decide WHERE that window lives:
//   off-screen  → macOS clamps it back: --window-position=-4000 lands at left:-1240,
//                 leaving a 40px sliver of Chrome on the desktop forever.
//   minimized   → the compositor starves: 3 screencast frames in 3s (vs 30 visible).
//   fully covered by another window → 30 frames in 3s, identical to exposed.
// Hence: in sign-in mode the engine runs headful with every window parked exactly under
// the app's own window, which hides it completely at full frame rate, and a ceremony
// raises that window for the seconds it takes.
const PK_BINDING = '__cfPasskey';
const PK_TAG_RE = /^[A-Za-z0-9_]{1,64}$/;
// Runs in the page's own world. It does not decide anything: it announces the ceremony
// and WAITS, so the window is already up before Chrome is asked to draw the dialog —
// no race between raising a window and the native prompt appearing. Every failure path
// falls through to the untouched original: a broken shim must never break a login.
const PASSKEY_SHIM = `(() => {
  if (window.__cfPkShim) return; window.__cfPkShim = 1;
  const creds = navigator.credentials; if (!creds) return;
  const gates = (window.__cfPkGates = window.__cfPkGates || {});
  let n = 0;
  const wrap = (name) => {
    const orig = creds[name];
    if (typeof orig !== 'function') return;
    creds[name] = function (opts) {
      // Only a WebAuthn ceremony needs a window. Password/federated credentials draw
      // nothing, and conditional mediation is the silent autofill hint every passkey
      // site fires on load — raising a window for that would be a jump-scare.
      if (!opts || !opts.publicKey || opts.mediation === 'conditional'
          || typeof window.${PK_BINDING} !== 'function') return orig.call(creds, opts);
      const tag = 't' + (++n) + '_' + Date.now().toString(36);
      let origin = ''; try { origin = location.origin; } catch (e) {}
      const gate = new Promise((res) => { gates[tag] = res; });
      try { window.${PK_BINDING}(JSON.stringify({ phase: 'ask', tag: tag, kind: name, origin: origin })); }
      catch (e) { delete gates[tag]; return orig.call(creds, opts); }
      return gate.then((verdict) => {
        delete gates[tag];
        if (verdict === 'refuse') throw new DOMException('Passkey sign-in was cancelled in CLONE FRAME.', 'NotAllowedError');
        const end = () => { try { window.${PK_BINDING}(JSON.stringify({ phase: 'end', tag: tag })); } catch (e) {} };
        return orig.call(creds, opts).then((r) => { end(); return r; }, (e) => { end(); throw e; });
      });
    };
  };
  wrap('get'); wrap('create');
})();`;

// Chrome hands out one window id per engine window (one window per tab, see open()).
async function _windowId(tab) {
  if (tab.windowId) return tab.windowId;
  const r = await _send('Browser.getWindowForTarget', { targetId: tab.id }, undefined, 5000);
  tab.windowId = r.windowId;
  return tab.windowId;
}
// Where a hidden engine window sits: exactly on the app's own viewport, so the app covers
// it completely. Without a reported cover rect there is nowhere safe to hide, so it goes to
// the top-left at a default size and the panel says so.
//
// The window must ALSO be at least as large as the viewport the panel asked for. Headless
// renders any emulated size regardless of window geometry; HEADFUL does not — an emulated
// viewport larger than the window's page area is scaled to fit and letterboxed, and the
// panel then stretches that frame across its canvas. That is the "ficou destorcido" the
// owner saw the first time sign-in mode ran. CHROME_UI is everything setWindowBounds counts
// inside the window that the page never gets: tab strip, address bar, and Chrome's
// "unsupported command-line flag" infobar (--disable-blink-features=AutomationControlled
// earns it, and that flag stays — it is what keeps the owner's browsing from being read as
// a bot). Measured too tight at 92: a 900px viewport came back 869px tall, an aspect error
// of 3.4% that the panel stretched across the canvas. Generous on purpose — the excess only
// ever applies when the app window is smaller than the page it is showing.
const CHROME_UI = 170;
const WIN_FRAME = 16;
function _parkBounds() {
  const c = S.cover;
  if (!c) return { left: 0, top: 30, width: 1280, height: 800 };
  return {
    left: Math.round(_num(c.left)), top: Math.max(0, Math.round(_num(c.top))),
    width: Math.max(520, Math.round(_num(c.width) || 1280)),
    height: Math.max(420, Math.round(_num(c.height) || 800)),
  };
}
// The page area a parked window can actually show. Growing the window instead was the
// obvious move and it does not work: macOS refuses to make a window taller than the screen,
// so the request was silently clamped and the frame came back short anyway (measured —
// asking for 900px of page height returned 869 whether the window was 992 or 1070 tall).
function _pageBox() {
  const b = _parkBounds();
  return { w: Math.max(200, b.width - WIN_FRAME), h: Math.max(200, b.height - CHROME_UI) };
}
async function _placeWindow(tab, raise) {
  if (!S.headful || !tab) return;
  try {
    const windowId = await _windowId(tab);
    await _send('Browser.setWindowBounds', { windowId, bounds: { ..._parkBounds(tab), windowState: 'normal' } }, undefined, 5000);
    // A live sign-in window is the one window meant to be looked at: it stays in front
    // for as long as the sign-in lasts, and then it stops existing.
    if (raise || (S.signin && S.signin.tabId === tab.id)) await _send('Target.activateTarget', { targetId: tab.id }, undefined, 5000);
  } catch { /* the window may be closing; the ceremony still gets its answer */ }
}
// Every window follows the app when it moves, resizes, or when a viewport grows.
async function _placeAll() {
  if (!S.headful) return;
  for (const tab of S.tabs.values()) await _placeWindow(tab, false);
}

// Release a waiting shim. The tag is one this engine minted, but it arrives from the
// page, so it is matched against a fixed shape before it is ever named in an expression
// — no page-supplied text reaches the JS this module evaluates (module invariant, :12-19).
function _releasePasskey(tab, tag, verdict) {
  if (!PK_TAG_RE.test(String(tag || ''))) return Promise.resolve();
  return _send('Runtime.evaluate', {
    expression: `(()=>{const g=window.__cfPkGates&&window.__cfPkGates[${JSON.stringify(String(tag))}];if(g)g(${JSON.stringify(verdict === 'refuse' ? 'refuse' : 'go')});})()`,
  }, tab.sessionId, 5000).catch(() => { /* page navigated away mid-ceremony */ });
}

async function _onPasskey(tab, payload) {
  let m; try { m = JSON.parse(String(payload || '')); } catch { return; }
  const tag = String(m.tag || '');
  if (!PK_TAG_RE.test(tag)) return;
  if (m.phase === 'end') {
    S.pk.delete(tag);
    // The credential prompt closed. Whatever the page does next is the real outcome, so
    // the "has it finished" clock starts again from here.
    if (S.signin && S.signin.tabId === tab.id) { S.signin.busy = false; S.signin.at = Date.now(); }
    await _placeWindow(tab, false);
    _pushWatchers(tab.id, { t: 'passkey', id: tab.id, phase: 'done', tag });
    return;
  }
  if (m.phase !== 'ask') return;
  S.pk.set(tag, { tabId: tab.id, at: Date.now() });
  // A page that is asking for a key is a page mid-sign-in, however still it looks. This is
  // the flag that stops the sign-in being declared finished while the owner is typing the
  // password into the system prompt — the engine used to carry the session across before
  // the login had happened, so nothing was signed in.
  if (S.signin && S.signin.tabId === tab.id) {
    S.signin.busy = true;
    if (S.signin.settle) { clearTimeout(S.signin.settle); S.signin.settle = null; }
  }
  const origin = String(m.origin || '').slice(0, 200);
  if (!S.headful) {
    // Headless has no dialog to show. Say so and hold the call: the panel offers sign-in
    // mode, or cancels — either answer is better than the silent forever-wait.
    _pushWatchers(tab.id, { t: 'passkey', id: tab.id, phase: 'blocked', tag, origin });
    return;
  }
  await _placeWindow(tab, true);
  _pushWatchers(tab.id, { t: 'passkey', id: tab.id, phase: 'open', tag, origin });
  await _releasePasskey(tab, tag, 'go');
}

function _onMessage(msg) {
  if (msg.id !== undefined) {
    const p = S.pending.get(msg.id);
    if (!p) return;
    S.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
    else p.resolve(msg.result || {});
    return;
  }
  const ev = msg.method;
  const params = msg.params || {};
  if (ev === 'Page.screencastFrame') {
    const tab = S.bySession.get(msg.sessionId);
    if (tab) {
      tab.seq++; tab.frame = { seq: tab.seq, data: params.data, metadata: params.metadata, ts: Date.now() };
      tab.lastSeen = Date.now();
      _pushFrame(tab, params);
    }
    // Ack immediately even for untracked sessions — an unacked frame stalls the cast.
    _send('Page.screencastFrameAck', { sessionId: params.sessionId }, msg.sessionId).catch(() => { /* engine may be closing */ });
  } else if (ev === 'Page.frameStartedLoading' || ev === 'Page.frameStoppedLoading' || ev === 'Page.loadEventFired') {
    const tab = S.bySession.get(msg.sessionId);
    if (tab) {
      _pushWatchers(tab.id, { t: 'loading', id: tab.id, on: ev === 'Page.frameStartedLoading' });
      // targetInfoChanged fires at COMMIT, when title is still the url (or the previous
      // page's) — which is why every tab label was one navigation behind. Read the real
      // <title> once the document is up, and once more for late/SPA titles.
      if (ev !== 'Page.frameStartedLoading') { _refreshTitle(tab); _refreshTitle(tab, 1200); }
    }
  } else if (ev === 'Target.targetInfoChanged') {
    const info = params.targetInfo;
    if (!info || info.type !== 'page') return;
    const tab = S.tabs.get(info.targetId);
    if (!tab) return;
    const changed = info.url !== tab.url || info.title !== tab.title;
    tab.url = info.url; tab.title = info.title;
    // No visit is recorded anywhere: the browser keeps no history by design (owner's
    // order, 2026-07-25). The url/title push below only feeds the live tab strip.
    if (changed) _pushWatchers(tab.id, { t: 'tab', id: tab.id, url: tab.url, title: tab.title });
    if (S.signin) _signinWatch(tab);
  } else if (ev === 'Target.targetCreated') {
    const info = params.targetInfo;
    if (!info || info.type !== 'page' || S.tabs.has(info.targetId)) return;
    // A page target the engine did not create is a POPUP: a target="_blank" link,
    // window.open, an OAuth window. Adoption used to be gated on `info.url` — but a
    // popup is born with an EMPTY url and only learns it a tick later (measured on
    // cloneframe.io and virtuals.io, 2026-07-25):
    //     Target.targetCreated   url=""                     openerId=<opener>
    //     Target.targetInfoChanged url="https://github.com/…"
    // so the gate never opened and every popup became a page NOBODY COULD SEE. The
    // owner clicked "GitHub" and "Open App" and nothing happened — while 13 invisible
    // github.com pages rendered at full speed until the engine wedged (Target.createTarget
    // went from 64ms to a 15s timeout: that was the "congelamentos"). Adopt first,
    // decide once the identity settles (_announceSpawn).
    _adoptSpawned(info).catch(() => { /* raced destruction */ });
  } else if (ev === 'Page.fileChooserOpened') {
    // The page asked for a file. Headless Chrome has no dialog to show, so the click on
    // "Choose file" did nothing whatsoever — measured. Interception makes the page WAIT
    // while the panel puts the owner's real macOS picker up and answers with setFiles().
    const tab = S.bySession.get(msg.sessionId);
    if (tab) {
      const m = { t: 'file', id: tab.id, mode: String(params.mode || 'selectSingle'), node: params.backendNodeId };
      const watched = [...S.wsClients].filter((ws) => ws._watch && ws._watch.has(tab.id));
      if (watched.length) watched.forEach((ws) => _wsSend(ws, m));
      else if (S.inputWs && S.wsClients.has(S.inputWs)) _wsSend(S.inputWs, m);
    }
  } else if (ev === 'Browser.downloadWillBegin') {
    const name = String(params.suggestedFilename || 'download').slice(0, 160);
    const d = { guid: params.guid, name, url: String(params.url || '').slice(0, 400), total: 0, got: 0, state: 'inProgress', ts: Date.now() };
    S.dls.set(d.guid, d);
    if (S.dls.size > 40) S.dls.delete(S.dls.keys().next().value);
    _pushDownload(d);
  } else if (ev === 'Browser.downloadProgress') {
    const d = S.dls.get(params.guid);
    if (!d) return;
    d.got = _num(params.receivedBytes); d.total = _num(params.totalBytes);
    d.state = String(params.state || d.state);
    if (d.state === 'completed') d.path = path.join(DOWNLOAD_DIR, d.name);
    _pushDownload(d);
  } else if (ev === 'Runtime.bindingCalled' && params.name === PK_BINDING) {
    const tab = S.bySession.get(msg.sessionId);
    if (tab) _onPasskey(tab, params.payload).catch(() => { /* tab died mid-ceremony */ });
  } else if (ev === 'Log.entryAdded') {
    const tab = S.bySession.get(msg.sessionId);
    if (tab && params.entry) { tab.console.push({ level: params.entry.level, text: String(params.entry.text || '').slice(0, 600), ts: Date.now() }); if (tab.console.length > 200) tab.console.shift(); }
  } else if (ev === 'Runtime.consoleAPICalled') {
    const tab = S.bySession.get(msg.sessionId);
    if (tab) { const text = (params.args || []).map((a) => (a.value !== undefined ? a.value : a.description) ?? '').join(' ').slice(0, 600); tab.console.push({ level: params.type || 'log', text, ts: Date.now() }); if (tab.console.length > 200) tab.console.shift(); }
  } else if (ev === 'Network.responseReceived') {
    const tab = S.bySession.get(msg.sessionId);
    if (tab && params.response) { tab.net.push({ url: String(params.response.url || '').slice(0, 300), status: params.response.status, type: params.type, ts: Date.now() }); if (tab.net.length > 300) tab.net.shift(); }
  } else if (ev === 'Target.targetDestroyed') {
    const tab = S.tabs.get(params.targetId);
    // The sign-in announcement goes FIRST: 'gone' makes a panel with no tabs left open a
    // fresh one, and while sign-in mode is on a fresh tab is a fresh window — the owner
    // closed the window and watched another appear.
    if (tab) { S.tabs.delete(tab.id); S.bySession.delete(tab.sessionId); _signinClosed(tab.id); _pushWatchers(tab.id, { t: 'gone', id: tab.id }); }
  } else if (ev === 'Target.detachedFromTarget') {
    const tab = S.bySession.get(params.sessionId);
    if (tab) { S.tabs.delete(tab.id); S.bySession.delete(tab.sessionId); _signinClosed(tab.id); _pushWatchers(tab.id, { t: 'gone', id: tab.id }); }
  }
}

// ── engine lifecycle ─────────────────────────────────────────────────────────
function _ensureEngine() {
  if (S.proc && S.ready) return Promise.resolve();
  if (S.starting) return S.starting;
  S.starting = _spawnEngine().finally(() => { S.starting = null; });
  return S.starting;
}

async function _spawnEngine() {
  const bin = _findChrome();
  if (!bin) throw new Error('Chrome not found — set CFHUB_CHROME to a Chromium binary');
  const profile = path.join(hubRoot(), 'web-engine');
  // The profile is DISPOSABLE: it is erased on every engine start. Everything —
  // owner tabs AND the search worker — lives in an in-memory private context, so
  // the on-disk profile is pure Chrome scaffolding that should hold nothing. The
  // wipe also retro-erases residue engines wrote before the browser went ephemeral
  // (owner's order, 2026-07-25). Best-effort: a file the dying previous engine still
  // holds survives one boot and dies on the next — self-healing, never blocking.
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* see above */ }
  // Staged uploads die with the session that made them — a copy of the owner's file has
  // no business outliving the page it was handed to.
  try { fs.rmSync(uploadDir(), { recursive: true, force: true }); } catch { /* next boot */ }
  try { fs.mkdirSync(profile, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // Pages in non-active engine windows get their timers clamped to 1Hz by
    // default — carousels and infinite feeds stutter even though frames flow.
    '--disable-background-timer-throttling',
    // This is the owner's own interactive browser, not a scraper: don't let the
    // automation pipe brand every page view as a bot (navigator.webdriver=true made
    // Google wall each search). Same disguise the v0.51 Electron shell keeps.
    '--disable-blink-features=AutomationControlled',
    // A fresh engine profile has zero media-engagement history, so Chrome's default
    // policy pauses every video the owner navigates to (proven: YouTube's own clock
    // stayed at 0:02 across 6s while the screencast kept updating — the frames were
    // fine, the video was simply never allowed to start). A browser the owner drives
    // should behave like the browser they know.
    '--autoplay-policy=no-user-gesture-required',
    // RETINA. A screencast frame is emitted at (css viewport × THE BROWSER's device
    // scale factor) — Emulation.setDeviceMetricsOverride's deviceScaleFactor changes only
    // what the PAGE believes (devicePixelRatio, which srcset uses to pick 2× images), never
    // the capture. Measured on a 1200×700 viewport, 2026-07-25:
    //   engine default          → jpeg 1200×700   (the panel then upscaled it 2× on the
    //                                              owner's retina canvas: soft text, soft
    //                                              images — "a resolução ainda está fraca")
    //   --force-device-scale-factor=2 → jpeg 2400×1400 TRUE pixels
    // This raises the CEILING only: the panel picks the real resolution per frame with
    // castStart's maxWidth/maxHeight, so a 1× display still receives 1× frames and pays
    // nothing.
    '--force-device-scale-factor=2',
    // --window-size is in CSS pixels and is NOT affected by the scale factor: doubling it
    // to "compensate" gave every un-sized tab a 2560px-wide layout, so a page drawn into a
    // ~900px canvas came out tiny in the corner (measured deviceWidth 2560, seen on the
    // owner's screen). 1280×800 CSS is the desktop every tab starts as; the surface behind
    // it is 2560×1600 device pixels because of the line above.
    '--window-size=1280,800',
    'about:blank',
  ];
  // Headless by default (renders regardless of visibility); reveal mode relaunches
  // headful so the user can log in (see _relaunch).
  if (!S.headful) args.splice(2, 0, '--headless=new');
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  S.proc = proc; S.ready = false; S.buf = EMPTY;
  const spawnErr = new Promise((_, rej) => proc.once('error', (e) => rej(new Error('spawn failed: ' + e.message))));
  // Silence EPIPE on writes that race the engine's death; death itself is
  // handled by 'exit' below.
  proc.stdio[3].on('error', () => {});
  proc.stdio[4].on('error', () => {});
  proc.stdio[4].on('data', _onData);
  proc.on('exit', (code, signal) => {
    if (S.proc !== proc) return;
    S.lastExit = { code, signal, at: Date.now() };
    for (const p of S.pending.values()) { clearTimeout(p.timer); p.reject(new Error('engine exited')); }
    S.pending.clear(); S.tabs.clear(); S.bySession.clear(); S.attaching.clear(); S.ctx = null;
    if (_reaperTimer) { clearInterval(_reaperTimer); _reaperTimer = null; }
    S.buf = EMPTY; S.proc = null; S.ready = false;
    for (const ws of S.wsClients) { if (ws._watch) ws._watch.clear(); _wsSend(ws, { t: 'down' }); }
  });
  try {
    // 25s, not 10: the FIRST Chrome launch on a busy machine (cold page cache, macOS
    // notarization check, another engine already casting) can take well past ten
    // seconds, and the old budget turned that into a hard "engine failed to start"
    // for a browser that was merely slow to wake (seen 2026-07-25 under load).
    const ver = await Promise.race([_send('Browser.getVersion', {}, undefined, 25000), spawnErr]);
    // Identity normalization: headless "new" appends the HeadlessChrome token to the
    // UA of what IS the user's real Chrome, so Google & co. misclassify every request
    // as a bot (/sorry wall on each search). Report the browser's true identity —
    // same call the v0.51 Electron shell ships; CAPTCHAs still appear and the OWNER
    // solves them on the canvas, nothing is auto-bypassed.
    S.ua = String((ver && ver.userAgent) || '').replace(/HeadlessChrome/g, 'Chrome');
    const mj = /Chrome\/(\d+)\.([\d.]+)/.exec(S.ua);
    S.uaMajor = (mj && mj[1]) || '150';
    S.uaFull = mj ? (mj[1] + '.' + mj[2]) : (S.uaMajor + '.0.0.0');
    // Discovery feeds targetCreated/InfoChanged/Destroyed — the tab table and
    // history recording depend on it.
    await _send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await _send('Target.getTargets');
    for (const t of targetInfos || []) {
      if (t.type === 'page' && !S.tabs.has(t.targetId)) await _attachOnce(t.targetId, t);
    }
    // In sign-in mode this includes the engine's own about:blank startup window, which
    // must never be closed (Chrome exits with it) — so it is hidden with the rest. Seen
    // on screen before this line existed: a stray Chrome window sitting beside the app.
    if (S.headful) for (const tab of S.tabs.values()) await _placeWindow(tab, false);
  } catch (e) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    if (S.proc === proc) { S.proc = null; S.ready = false; }
    throw new Error('engine failed to start: ' + e.message);
  }
  S.ready = true;
  S.lastExit = null;
}

function _attachOnce(targetId, info) {
  const existing = S.tabs.get(targetId);
  if (existing) return Promise.resolve(existing);
  let p = S.attaching.get(targetId);
  if (!p) {
    p = _attach(targetId, info).finally(() => S.attaching.delete(targetId));
    S.attaching.set(targetId, p);
  }
  return p;
}

async function _attach(targetId, info) {
  const { sessionId } = await _send('Target.attachToTarget', { targetId, flatten: true });
  const tab = {
    id: targetId, sessionId,
    url: (info && info.url) || '', title: (info && info.title) || '',
    casting: false, seq: 0, frame: null, lastSeen: Date.now(),
    // Agent-read state: the ref→backendNodeId map from the last readPage() (so
    // click({ref}) survives pixel drift), plus rolling console/network capture.
    refMap: new Map(), console: [], net: [],
  };
  S.tabs.set(targetId, tab);
  S.bySession.set(sessionId, tab);
  await _send('Page.enable', {}, sessionId).catch(() => { /* target may be mid-close */ });
  // Apply the normalized identity per session (see _spawnEngine) — UA string plus
  // client-hint brands, so headless pages present as the real Chrome they are.
  if (S.ua) {
    await _send('Emulation.setUserAgentOverride', {
      userAgent: S.ua,
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: S.uaMajor },
          { brand: 'Google Chrome', version: S.uaMajor },
          { brand: 'Not/A)Brand', version: '24' },
        ],
        fullVersionList: [
          { brand: 'Chromium', version: S.uaFull },
          { brand: 'Google Chrome', version: S.uaFull },
          { brand: 'Not/A)Brand', version: '24.0.0.0' },
        ],
        platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm', model: '', mobile: false,
      },
    }, sessionId).catch(() => { /* older Chrome — plain UA override still applied below is fine */ });
  }
  // Every page believes it is focused: without this, pages in the engine's
  // non-frontmost windows report document.hasFocus()=false — carets don't
  // blink, focus-gated UI dims, some sites pause — while the owner is actively
  // typing into them through the panel.
  await _send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => { /* older Chrome */ });
  // Best-effort observability domains — a page that refuses one must not block attach.
  await _send('Runtime.enable', {}, sessionId).catch(() => {});
  // The passkey channel (see PASSKEY_SHIM), installed in the BACKGROUND and never awaited:
  // opening a tab must not wait on it. Page.addScriptToEvaluateOnNewDocument is known to
  // hang on a target that has no document yet, and three awaited 5s budgets would have put
  // up to 15s in front of every new tab — a browser that "stopped working". Order still
  // matters (addBinding first, or the shim finds no window.__cfPasskey and steps aside),
  // so the calls chain; only the chain is detached. The shim is registered for future
  // documents AND evaluated once for the document already here, since attach can land
  // either side of the first load.
  _send('Runtime.addBinding', { name: PK_BINDING }, sessionId, 5000)
    .then(() => _send('Page.addScriptToEvaluateOnNewDocument', { source: PASSKEY_SHIM }, sessionId, 5000))
    .then(() => _send('Runtime.evaluate', { expression: PASSKEY_SHIM }, sessionId, 5000))
    .catch(() => { /* a page that refuses the channel still browses — it just cannot announce a ceremony */ });
  // DOM.getNodeForLocation — what the page context menu hit-tests with — needs the DOM
  // agent awake. Without it the call crawls and answers nothing, so a right-click sat
  // there for seconds and then offered a menu that knew nothing about the link under it.
  await _send('DOM.enable', {}, sessionId).catch(() => {});
  // Let the page ask for a file and wait for the answer (see Page.fileChooserOpened).
  await _send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId).catch(() => {});
  await _send('Log.enable', {}, sessionId).catch(() => {});
  await _send('Network.enable', {}, sessionId).catch(() => {});
  await _send('Accessibility.enable', {}, sessionId).catch(() => {});
  return tab;
}

// ── popups (target="_blank", window.open) ────────────────────────────────────
// A page opened BY A PAGE must land where the owner can see it: as a new tab in the
// panel that caused it — what every real browser does. Pages the engine opens itself
// (open(), search()) mark themselves `claimed` the instant createTarget answers, so
// the settle timer below can tell "the app asked for this" from "the page asked for
// this" without racing the CDP round-trip.
const SPAWN_SETTLE_MS = 400;
// The engine never holds more pages than a person can plausibly be looking at. Beyond
// this a popup is coalesced into its opener instead of adopted — a page that renders
// with nobody watching costs the same CPU as one on screen.
const MAX_PAGES = 24;

async function _adoptSpawned(info) {
  const tab = await _attachOnce(info.targetId, info);
  tab.openerId = info.openerId || null;
  // The test is the CONTEXT, not the opener. Openerless is not the same as not-a-popup:
  // a ⌘-click new tab is born with no openerId at all, and gating on the opener made
  // those invisible exactly like target="_blank" used to be. What every page-spawned tab
  // does share is our private context — while the engine's own startup page (which must
  // never be closed, or Chrome exits with it) lives in the default context and has none.
  if (!S.ctx || info.browserContextId !== S.ctx) return;
  if (tab.claimed || tab.spawnT) return;
  if (!tab.ctx) tab.ctx = S.ctx;                 // popups inherit the private session
  _placeWindow(tab, false).catch(() => { /* headless, or the popup died first */ });
  tab.spawnT = setTimeout(() => { tab.spawnT = null; _announceSpawn(tab); }, SPAWN_SETTLE_MS);
  if (tab.spawnT.unref) tab.spawnT.unref();
}

// Route the new tab to the ONE browser window that caused it, in order of certainty:
//   1. the socket watching its opener — the window holding the page that was clicked;
//   2. the socket whose input we last carried — a popup is always the consequence of a
//      click, and that click crossed exactly one socket;
//   3. nobody can show it → the opener navigates there instead, and the popup closes.
// There is no fourth branch: a popup NEVER survives as a page nobody can see.
function _announceSpawn(tab) {
  if (tab.claimed || !S.tabs.has(tab.id)) return;
  const msg = { t: 'popup', id: tab.id, url: tab.url || '', openerId: tab.openerId };
  let sent = 0;
  if (S.tabs.size <= MAX_PAGES) {
    for (const ws of S.wsClients) { if (ws._watch && tab.openerId && ws._watch.has(tab.openerId)) { _wsSend(ws, msg); sent++; } }
    if (!sent && S.inputWs && S.wsClients.has(S.inputWs) && Date.now() - S.inputAt < 30000) { _wsSend(S.inputWs, msg); sent++; }
  }
  if (sent) { tab.claimed = true; return; }
  const opener = tab.openerId && S.tabs.get(tab.openerId);
  if (opener && _safeUrl(tab.url)) _send('Page.navigate', { url: tab.url }, opener.sessionId).catch(() => { /* opener closing */ });
  _send('Target.closeTarget', { targetId: tab.id }).catch(() => { /* already gone */ });
  S.tabs.delete(tab.id); S.bySession.delete(tab.sessionId);
}

// Everything the engine opens on purpose. Cancels the popup settle timer so a target
// the app requested is never announced as one the page requested.
function _claim(tab) {
  if (!tab) return tab;
  tab.claimed = true;
  if (tab.spawnT) { clearTimeout(tab.spawnT); tab.spawnT = null; }
  return tab;
}

// Reap orphaned tabs: a panel that closed or reloaded stops polling frame(), so its
// engine tab's lastSeen goes stale. Close tabs unpolled for >2min (the newest tab is
// always spared, so a freshly-opened tab that hasn't been polled yet is never reaped).
// This bounds Chrome memory to the tabs actually on screen, regardless of client crashes.
let _reaperTimer = null;
function _startReaper() {
  if (_reaperTimer) return;
  _reaperTimer = setInterval(() => {
    const now = Date.now();
    const arr = [...S.tabs.values()];
    const newest = arr[arr.length - 1];
    // A tab held by a live op=web socket is on screen — never reap it.
    const watched = new Set();
    for (const ws of S.wsClients) { if (ws._watch) for (const id of ws._watch) watched.add(id); }
    // Over the page cap, staleness stops mattering: the oldest tabs nobody is watching
    // go first. This is the backstop that keeps ANY future leak from wedging the engine
    // the way the popup leak did (13 invisible pages → 15s CDP timeouts, 2026-07-25).
    let over = arr.length - MAX_PAGES;
    for (const tab of arr) {
      if (tab === newest || watched.has(tab.id)) continue;
      const stale = now - (tab.lastSeen || 0) > 120000;
      if (!stale && over <= 0) continue;
      if (!stale) over--;
      _send('Target.closeTarget', { targetId: tab.id }).catch(() => {}); S.tabs.delete(tab.id); S.bySession.delete(tab.sessionId);
    }
  }, 30000);
  _reaperTimer.unref && _reaperTimer.unref();
}

function _waitExit(proc, ms) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    proc.once('exit', () => { clearTimeout(t); res(true); });
  });
}

// ── input mapping (fixed whitelist — no raw CDP crosses the RPC boundary) ────
const MOUSE_TYPES = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' };
const BUTTONS = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);

async function _dispatchEvent(sessionId, ev) {
  const kind = ev && ev.kind;
  const mods = _clampInt(ev && ev.modifiers, 0, 15, 0);
  if (kind === 'mouse') {
    const type = MOUSE_TYPES[ev.type];
    if (!type) return;
    await _send('Input.dispatchMouseEvent', {
      type,
      x: _num(ev.x), y: _num(ev.y),
      button: BUTTONS.has(ev.button) ? ev.button : (type === 'mouseMoved' ? 'none' : 'left'),
      clickCount: _clampInt(ev.clickCount, 0, 3, type === 'mouseMoved' ? 0 : 1),
      modifiers: mods,
    }, sessionId);
  } else if (kind === 'wheel') {
    await _send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: _num(ev.x), y: _num(ev.y),
      deltaX: _num(ev.deltaX), deltaY: _num(ev.deltaY),
      modifiers: mods,
    }, sessionId);
  } else if (kind === 'key') {
    const text = ev.text ? String(ev.text).slice(0, 4) : '';
    // keyDown-with-text produces the character; rawKeyDown is for non-printables
    // (arrows, Esc) — the split DevTools' own frontend uses.
    const type = ev.type === 'up' ? 'keyUp' : (text ? 'keyDown' : 'rawKeyDown');
    const vk = _clampInt(ev.keyCode, 0, 255, 0);
    const params = {
      type, modifiers: mods,
      key: String(ev.key || ''), code: String(ev.code || ''),
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    };
    if (text) { params.text = text; params.unmodifiedText = text; }
    await _send('Input.dispatchKeyEvent', params, sessionId);
  } else if (kind === 'text') {
    await _send('Input.insertText', { text: String(ev.text || '') }, sessionId);
  }
}

// Result extraction for search(): anchors wrapping an <h3> are Google's organic
// results; /url? redirects are unwrapped, google-internal links dropped. FIXED
// string — the same no-eval-injection rule as read(), the query never touches it.
const SEARCH_EXTRACT = `(() => {
  const out = []; const seen = new Set();
  for (const h of document.querySelectorAll('a h3')) {
    const a = h.closest('a'); if (!a) continue;
    let url = a.href || '';
    try {
      const u = new URL(url);
      if (u.pathname === '/url') url = u.searchParams.get('q') || url;
      const f = new URL(url);
      if (!/^https?:$/i.test(f.protocol)) continue;
      if (/(^|\\.)google\\.[a-z.]+$/i.test(f.hostname)) continue;
    } catch { continue; }
    if (seen.has(url)) continue; seen.add(url);
    let snippet = '';
    const block = a.closest('[data-hveid],[data-snc],.g,.MjjYud');
    if (block) snippet = (block.innerText || '').replace(h.innerText || '', ' ').replace(/\\s+/g, ' ').trim().slice(0, 240);
    out.push({ title: (h.innerText || '').trim().slice(0, 160), url, snippet });
    if (out.length >= 20) break;
  }
  return { host: location.hostname, done: document.readyState === 'complete', results: out,
    consent: !!document.getElementById('W0wltc'), sorry: location.pathname.indexOf('/sorry') === 0 };
})()`;

// Google's cookie-consent interstitial, answered the privacy-preserving way (reject
// all) so the disposable profile never accrues consented tracking. #W0wltc is the
// stable id of the inline banner's reject button; the text scan covers the
// consent.google.com page in the owner's language. FIXED string — same
// no-eval-injection rule as everything else that crosses Runtime.evaluate.
const CONSENT_REJECT = `(() => {
  const byId = document.getElementById('W0wltc');
  if (byId) { byId.click(); return 'clicked'; }
  const re = /(reject|recusar|refuser|ablehnen|rechazar|rifiuta|weiger|avvisa|afvis)/i;
  for (const b of document.querySelectorAll('button,[role="button"]')) {
    const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim();
    if (re.test(t)) { b.click(); return 'clicked'; }
  }
  return 'none';
})()`;

// ── public RPC surface (POST /mod/webengine {fn,args}) ───────────────────────
// The authoritative title of a loaded page (see the loading branch of _onMessage).
// Fixed expression, no caller text — same no-eval-injection rule as read().
function _refreshTitle(tab, delay = 60) {
  clearTimeout(tab.titleT);
  tab.titleT = setTimeout(async () => {
    try {
      const r = await _send('Runtime.evaluate', { expression: '({u:location.href,t:document.title})', returnByValue: true }, tab.sessionId, 4000);
      const v = r && r.result && r.result.value;
      if (!v || !v.t) return;
      if (v.t === tab.title && (v.u || tab.url) === tab.url) return;
      tab.title = v.t; tab.url = v.u || tab.url;
      _pushWatchers(tab.id, { t: 'tab', id: tab.id, url: tab.url, title: tab.title });
    } catch { /* tab closed or navigating again */ }
  }, delay);
  if (tab.titleT.unref) tab.titleT.unref();
}

export const Webengine = {
  async start() {
    try { await _ensureEngine(); return { ok: true, pid: S.proc.pid, tabs: Webengine.tabs() }; }
    catch (e) { return { ok: false, error: e.message }; }
  },

  async stop() {
    const proc = S.proc;
    if (!proc) return { ok: true, running: false };
    // Closing our end of the CDP pipe is the clean shutdown signal for
    // --remote-debugging-pipe; SIGKILL is the honest fallback.
    try { proc.stdio[3].end(); } catch { /* pipe already gone */ }
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
    const exited = await _waitExit(proc, 2500);
    if (!exited) { try { proc.kill('SIGKILL'); } catch { /* already gone */ } await _waitExit(proc, 1500); }
    // Wipe on STOP as well as on start. The profile was only erased when the engine LAUNCHED,
    // so everything it had written sat on disk from the moment it exited until the next launch —
    // which can be days. Measured: with no engine running, ~/.clone-frame-hub/web-engine held
    // 7 cookies for a link-redirect domain, written 15 minutes earlier by an engine that had
    // since exited. This module's own header says the on-disk profile "should hold nothing";
    // that was true while it ran and false the rest of the time.
    // Best-effort and non-blocking, exactly like the start-side wipe: a file the dying process
    // still holds survives until the next boot erases it. Never let cleanup fail a stop.
    try { fs.rmSync(path.join(hubRoot(), 'web-engine'), { recursive: true, force: true }); } catch { /* next start */ }
    try { fs.rmSync(uploadDir(), { recursive: true, force: true }); } catch { /* next start */ }
    return { ok: true };
  },

  status() {
    return {
      running: !!(S.proc && S.ready),
      pid: S.proc ? S.proc.pid : null,
      headful: !!S.headful,
      bin: _findChrome(),
      profile: path.join(hubRoot(), 'web-engine'),
      tabs: Webengine.tabs(),
      lastExit: S.lastExit,
      // Where sign-in mode hides its windows, and where it would put them right now.
      // Without this, a misplaced window is a guessing game (it was one, once).
      cover: S.cover,
      coverAt: S.coverAt || null,   // last time the app reported where it is (see setCover)
      signin: S.signin ? { tabId: S.signin.tabId, origin: S.signin.origin, startUrl: S.signin.startUrl, moved: !!S.signin.moved, seen: S.signin.seen || 0, waiting: !!S.signin.settle } : null,
      park: S.headful ? _parkBounds() : null,
      pageBox: S.headful ? _pageBox() : null,
    };
  },

  tabs() {
    return [...S.tabs.values()].map((t) => ({ id: t.id, url: t.url, title: t.title, casting: t.casting, seq: t.seq }));
  },

  async open({ url, background = false } = {}) {
    const u = _safeUrl(url);
    if (!u) return { ok: false, error: 'only http(s) urls' };
    try {
      await _ensureEngine();
      // ONE ENGINE WINDOW PER TAB — the load-bearing line of the whole browser.
      // Headless Chrome only composites the ACTIVE tab of each window, so tabbed
      // targets starve: measured 0 screencast frames in 4s of scrolling for any
      // tab that wasn't the last one opened (the "browser is useless, freezes
      // when I use it" report — the panel's active tab was a background target).
      // In their own windows, every tab casts concurrently (measured 106+106
      // frames/3s on two tabs at once) — pi opening a page never freezes the
      // owner's, and each ⧉ browser window paints independently.
      const ctx = await _ensureCtx();
      const r = await _send('Target.createTarget', { url: u, newWindow: true, background: !!background, browserContextId: ctx });
      const tab = _claim(await _attachOnce(r.targetId));
      tab.ctx = ctx; // marks this tab as the owner's — wipe() only ever destroys these
      // In sign-in mode the engine is headful, so a new tab is a real Chrome window that
      // would otherwise land on top of everything. Park it under the app before it is seen.
      await _placeWindow(tab, false);
      return { ok: true, id: tab.id, url: u };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async close({ id } = {}) {
    const tab = _tab(id);
    if (!tab) return { ok: false, error: 'no such tab' };
    // Closing a tab erases the site it was on: cookies, localStorage, IndexedDB, caches,
    // service workers. The context is memory-only anyway, but a sibling tab must not
    // inherit the session of a page the owner just closed.
    let origin = '';
    try { origin = new URL(tab.url).origin; } catch { /* about:blank / never navigated */ }
    // The sign-in window is the one tab whose closing MEANS "keep this" — closing it is
    // how anyone ends a sign-in, and erasing the site would throw away the very session
    // the window was opened to get.
    const isSignin = !!(S.signin && S.signin.tabId === tab.id);
    if (origin && !isSignin) await _send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }, tab.sessionId).catch(() => { /* page already gone */ });
    try { await _send('Target.closeTarget', { targetId: tab.id }); } catch (e) { return { ok: false, error: e.message }; }
    // targetDestroyed also fires; deleting here just makes close() synchronous-honest —
    // which is also why the sign-in announcement has to be made from here as well.
    S.tabs.delete(tab.id); S.bySession.delete(tab.sessionId);
    if (isSignin) _signinClosed(tab.id);
    return { ok: true };
  },

  // Destroy the private session: every owner tab closes and the off-the-record context
  // goes with them, taking its cookies, storage and cache. Called by the panel when its
  // last window closes and before its first window opens.
  //
  // `ifIdle` asks the ENGINE whether anyone is still browsing, instead of letting a panel
  // window answer for the whole app: the panel's ownership set is per-document, so a
  // SECOND browser window used to arrive believing nothing was open and wipe the first
  // window's tabs out from under it. Idle means no live socket is watching an owner tab.
  async wipe({ ifIdle = false } = {}) {
    if (ifIdle) {
      for (const ws of S.wsClients) {
        if (!ws._watch) continue;
        for (const id of ws._watch) { const t = S.tabs.get(id); if (t && t.ctx) return { ok: true, skipped: true }; }
      }
    }
    if (!(S.proc && S.ready)) { S.ctx = null; return { ok: true, running: false }; }
    // Only the owner's tabs (tab.ctx): the engine's own startup page stays, so the last
    // close doesn't take Chrome down with it, and a search running in the default profile
    // is never killed mid-flight.
    for (const tab of [...S.tabs.values()]) {
      if (!tab.ctx) continue;
      await _send('Target.closeTarget', { targetId: tab.id }).catch(() => { /* raced */ });
      S.tabs.delete(tab.id); S.bySession.delete(tab.sessionId);
      // Tell every watcher the tab is gone. Deleting from S.tabs first means the
      // Target.targetDestroyed handler finds nothing and pushes nothing — so a window
      // that was watching this tab kept a dead handle and a canvas that never painted
      // again. That is what a "frozen browser" looks like from the outside (observed
      // live, 2026-07-25); a wipe must never leave another window holding a corpse.
      _pushWatchers(tab.id, { t: 'gone', id: tab.id });
    }
    if (S.ctx) { await _send('Target.disposeBrowserContext', { browserContextId: S.ctx }).catch(() => { /* already gone */ }); S.ctx = null; }
    return { ok: true };
  },

  async navigate({ id, url } = {}) {
    // id omitted → the on-screen tab (pi drives what the user is looking at).
    let tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) { const o = await Webengine.open({ url }); return o; }
    const u = _safeUrl(url);
    if (!u) return { ok: false, error: 'only http(s) urls' };
    try {
      const r = await _send('Page.navigate', { url: u }, tab.sessionId, 30000);
      if (r.errorText) return { ok: false, error: r.errorText };
      return { ok: true, id: tab.id, url: u };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async back({ id } = {}) { return _historyStep(id, -1); },
  async forward({ id } = {}) { return _historyStep(id, +1); },

  async reload({ id, ignoreCache = false } = {}) {
    // Same resolution as navigate() and _historyStep(): id omitted → the on-screen tab.
    // The agent's web_navigate offers back/forward/reload as one control, and back and
    // forward already defaulted; reload alone demanded an id and answered "no such tab"
    // to a caller that had named none — which reads as "your tab is gone", not "I need
    // an id". The panel always passes {id}, so its behaviour is unchanged.
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: id != null ? 'no such tab' : 'no tab open' };
    try { await _send('Page.reload', { ignoreCache: !!ignoreCache }, tab.sessionId); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },

  async castStart({ id, maxWidth = 1280, maxHeight = 800, quality = 70, everyNthFrame = 1 } = {}) {
    const tab = _tab(id);
    if (!tab) return { ok: false, error: 'no such tab' };
    try {
      // Engine-created targets (window.open, OAuth popups) can land as TABS in an
      // existing window, where only the active tab composites. Casting a tab is
      // the declaration that the owner is looking at it — make it its window's
      // active tab so frames actually flow. No-op for our one-window-per-tab targets.
      // Skipped in sign-in mode: there activateTarget also RAISES a real Chrome window,
      // and casting must never yank a parked window in front of the app. Nothing is lost —
      // a covered headful window composites at full rate without ever being active
      // (measured: 30 frames/3s covered, the same as exposed).
      if (!S.headful) await _send('Target.activateTarget', { targetId: tab.id }).catch(() => { /* best-effort */ });
      // Casting is the moment the panel says "the owner is looking at this" — a good time
      // to make sure the real window behind it is still where the app is.
      else await _placeWindow(tab, false);
      await _send('Page.startScreencast', {
        format: 'jpeg',
        quality: _clampInt(quality, 1, 100, 70),
        maxWidth: _clampInt(maxWidth, 64, 4096, 1280),
        maxHeight: _clampInt(maxHeight, 64, 4096, 800),
        everyNthFrame: _clampInt(everyNthFrame, 1, 30, 1),
      }, tab.sessionId);
      tab.casting = true;
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async castStop({ id } = {}) {
    const tab = _tab(id);
    if (!tab) return { ok: false, error: 'no such tab' };
    try { await _send('Page.stopScreencast', {}, tab.sessionId); } catch { /* already stopped / tab closing */ }
    tab.casting = false;
    return { ok: true };
  },

  // Poll for the latest screencast frame. `since` = last seq the panel painted;
  // data:null means "nothing newer" so idle polling costs no JPEG bytes. Polling also
  // marks the tab alive — a tab nobody polls (panel closed/reloaded) is reaped (below).
  frame({ id, since = 0 } = {}) {
    const tab = _tab(id);
    if (!tab) return { ok: false, error: 'no such tab' };
    tab.lastSeen = Date.now();
    _startReaper();
    const n = _num(since);
    if (tab.frame && tab.frame.seq > n) return { ok: true, seq: tab.frame.seq, data: tab.frame.data, metadata: tab.frame.metadata };
    return { ok: true, seq: tab.seq, data: null };
  },

  async setViewport({ id, width = 1280, height = 800, scale = 1 } = {}) {
    const tab = _tab(id);
    if (!tab) return { ok: false, error: 'no such tab' };
    try {
      let w = _clampInt(width, 64, 4096, 1280), h = _clampInt(height, 64, 4096, 800);
      // Headless renders any emulated viewport whatever the window looks like; HEADFUL
      // caps it at the window's page area and letterboxes the rest — and the panel, which
      // stretches every frame across its canvas, turns that letterbox into the stretched
      // picture the owner reported. So in sign-in mode the request is scaled DOWN to what
      // the window can really show, BOTH axes by the same factor: the frame comes back a
      // little softer, never the wrong shape.
      if (S.headful) {
        // Put the window where it belongs FIRST. The clamp below measures the parked
        // bounds, so measuring before the window has actually got there clamps against a
        // window that no longer exists: a freshly opened tab was still at the spawn size
        // (1280x800) and the very first frame came back 2400x1390 instead of 2400x1440,
        // while every later frame was exact. Order, not arithmetic.
        await _placeWindow(tab, false);
        await new Promise((r) => setTimeout(r, 120)); // let the widget catch up with its window
        const box = _pageBox();
        const k = Math.min(1, box.w / w, box.h / h);
        if (k < 1) { w = Math.max(64, Math.round(w * k)); h = Math.max(64, Math.round(h * k)); }
      }
      await _send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h,
        deviceScaleFactor: Math.min(Math.max(_num(scale) || 1, 0.25), 3),
        mobile: false,
      }, tab.sessionId);
      tab.vw = w; tab.vh = h;
      return { ok: true, width: w, height: h };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async input({ id, events } = {}) {
    const tab = _tab(id);
    if (!tab) return { ok: false, error: 'no such tab' };
    const list = Array.isArray(events) ? events.slice(0, 128) : [];
    for (const ev of list) {
      // Sequential on purpose: input order is semantics (down before up).
      try { await _dispatchEvent(tab.sessionId, ev); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    return { ok: true, count: list.length };
  },

  // modifiers ride along so ⌘-click (open in a new tab) and right-click reach the page as
  // the real gestures they are — a click stripped of its modifier is a different click.
  async click({ id, x, y, button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    return Webengine.input({ id, events: [
      { kind: 'mouse', type: 'move', x, y, modifiers },
      { kind: 'mouse', type: 'down', x, y, button, clickCount, modifiers },
      { kind: 'mouse', type: 'up', x, y, button, clickCount, modifiers },
    ] });
  },

  async type({ id, text } = {}) {
    return Webengine.input({ id, events: [{ kind: 'text', text: String(text == null ? '' : text) }] });
  },

  // Agent-facing page extraction. The expression is FIXED — maxChars is a
  // clamped integer, never caller text, so there is no eval-injection path.
  async read({ id, maxChars = 20000 } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    const cap = _clampInt(maxChars, 1, 200000, 20000);
    const expression = `({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${cap}) })`;
    try {
      const r = await _send('Runtime.evaluate', { expression, returnByValue: true }, tab.sessionId);
      const v = r && r.result && r.result.value;
      if (!v || typeof v !== 'object') return { ok: false, error: 'no result' };
      return { ok: true, url: String(v.url || ''), title: String(v.title || ''), text: String(v.text || '') };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // What the owner has selected on the page. The engine renders in its own process, so a
  // ⌘C inside it reaches nobody's clipboard — the panel reads the selection through here
  // and writes it to the app's clipboard instead (measured 2026-07-25: before this,
  // selecting text and pressing ⌘C produced nothing at all). FIXED expression: no caller
  // text ever crosses Runtime.evaluate, same rule as read().
  async selection({ id } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    try {
      const r = await _send('Runtime.evaluate', { expression: '(window.getSelection?String(getSelection()):"").slice(0,200000)', returnByValue: true }, tab.sessionId, 6000);
      return { ok: true, text: String((r && r.result && r.result.value) || '') };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // Select All is a BROWSER command, not something the page listens for: a synthetic ⌘A
  // key event selects nothing at all (measured — the selection came back empty). Do it to
  // the document, and to the focused field when there is one, which is what ⌘A means in
  // both places. FIXED expression, no caller text.
  async selectAll({ id } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    const expression = `(()=>{const a=document.activeElement;
      if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable)){try{if(a.select)a.select();else document.execCommand('selectAll');return 'field'}catch(e){}}
      const s=getSelection();if(!s||!document.body)return 'none';
      s.removeAllRanges();const r=document.createRange();r.selectNodeContents(document.body);s.addRange(r);return 'page'})()`;
    try {
      const r = await _send('Runtime.evaluate', { expression, returnByValue: true }, tab.sessionId, 6000);
      return { ok: true, scope: String((r && r.result && r.result.value) || 'page') };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async screenshot({ id, quality = 80 } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    try {
      const r = await _send('Page.captureScreenshot', { format: 'jpeg', quality: _clampInt(quality, 1, 100, 80) }, tab.sessionId, 20000);
      return { ok: true, format: 'jpeg', data: r.data };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ── agent-read surface (the pi web_* tools; id omitted → the on-screen tab) ──
  // readPage returns a compact accessibility tree: every interactive node gets a
  // stable ref (r1, r2…) mapped to its backendDOMNodeId, so click({ref}) is robust
  // against pixel drift — the Claude-Code browser-pane pattern.
  async readPage({ id } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    try {
      const ax = await _send('Accessibility.getFullAXTree', {}, tab.sessionId, 20000);
      tab.refMap.clear();
      const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'tab', 'switch', 'slider', 'option']);
      const nodes = []; let n = 0;
      for (const node of ax.nodes || []) {
        const role = node.role && node.role.value;
        if (!role) continue;
        const name = node.name ? String(node.name.value || '').trim() : '';
        if (INTERACTIVE.has(role) && node.backendDOMNodeId) { n++; const ref = 'r' + n; tab.refMap.set(ref, node.backendDOMNodeId); nodes.push({ ref, role, name: name.slice(0, 120) }); }
        else if (name && (role === 'heading' || role === 'StaticText' || role === 'paragraph')) { nodes.push({ role, text: name.slice(0, 160) }); }
        if (nodes.length > 400) break;
      }
      return { ok: true, url: tab.url, title: tab.title, nodes };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async find({ id, query } = {}) {
    const p = await Webengine.readPage({ id });
    if (!p.ok) return p;
    const q = String(query || '').toLowerCase();
    const hits = p.nodes.filter((nd) => ((nd.name || nd.text || '') + ' ' + (nd.role || '')).toLowerCase().includes(q));
    return { ok: true, query, hits: hits.slice(0, 40) };
  },

  // Web search through the ENGINE — the owner's real Chrome asks Google in a
  // background window and reads the result list off the DOM. This replaced the
  // DuckDuckGo HTML scrape (rot-prone, and the owner asked for it gone); a plain
  // fetch of google.com would hit the bot wall the engine's identity avoids.
  async search({ q, limit = 6 } = {}) {
    const query = String(q == null ? '' : q).trim();
    if (!query) return { ok: false, results: [], error: 'empty query' };
    const cap = _clampInt(limit, 1, 20, 6);
    let tab = null;
    try {
      await _ensureEngine();
      // The worker runs in the SAME private context as the owner's tabs — deliberately.
      // Nothing touches disk, and when Google demands a human check (/sorry), the owner
      // solves it once in the BROWSER panel and this worker inherits that trust in the
      // same breath. A separate profile would be unhealable: his solve could never
      // reach it. Consent walls need no human at all — auto-rejected below.
      // ARRIVE THE WAY A PERSON DOES: google.com first, the query second. Jumping
      // straight to /search from a cold private context is itself the bot signal —
      // measured 2026-07-25, three runs each: direct SERP → /sorry every time, 0 results;
      // homepage-then-SERP → 10 results every time. The homepage visit is what mints the
      // cookies the SERP request needs, and it is also where the consent banner lives,
      // answered here once, the privacy-preserving way (reject all).
      const r = await _send('Target.createTarget', {
        url: 'https://www.google.com/',
        newWindow: true, background: true, browserContextId: await _ensureCtx(),
      });
      tab = _claim(await _attachOnce(r.targetId));
      let deadline = Date.now() + 20000; // warm-up budget (homepage + consent)
      let out = null, host = '', consentTried = 0, sorry = false, warmed = false;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 300));
        const ev = await _send('Runtime.evaluate', { expression: SEARCH_EXTRACT, returnByValue: true }, tab.sessionId, 5000).catch(() => null);
        const v = ev && ev.result && ev.result.value;
        if (!v) continue;
        host = v.host || '';
        // Human check (/sorry): only the owner can answer it — stop waiting. Because the
        // worker shares the panel's private context, one solve in the panel heals search.
        if (v.sorry) { sorry = true; break; }
        // consent.google.com is a FULL-PAGE wall: nothing works until it is answered,
        // so keep trying there. The banner on google.com itself is only an overlay —
        // and measured 2026-07-25, clicking "Reject all" reports "clicked" but the
        // overlay STAYS. Waiting for it to vanish is therefore a deadlock, and it was:
        // the poll sat on the homepage until the deadline and reported "no results".
        // Results do not depend on it (proven: homepage → SERP returns 10/10 with the
        // overlay still up), so reject once for privacy and move on.
        if (/(^|\.)consent\./i.test(host)) {
          if (consentTried < 3) {
            consentTried++;
            await _send('Runtime.evaluate', { expression: CONSENT_REJECT, returnByValue: true }, tab.sessionId, 5000).catch(() => null);
          }
          continue;
        }
        if (!warmed) {
          if (!v.done) continue;
          if (v.consent && !consentTried) {
            consentTried++;
            await _send('Runtime.evaluate', { expression: CONSENT_REJECT, returnByValue: true }, tab.sessionId, 5000).catch(() => null);
            continue; // one poll of grace for the click to take effect, then on regardless
          }
          warmed = true;
          // The query gets its own budget: a slow consent dance must never eat the time
          // the answer needs (the very first search after app start used to time out).
          deadline = Date.now() + 15000;
          await _send('Page.navigate', { url: 'https://www.google.com/search?q=' + encodeURIComponent(query) }, tab.sessionId, 15000).catch(() => { /* the poll below is the real answer */ });
          continue;
        }
        if (Array.isArray(v.results) && v.results.length) { out = v.results; break; }
      }
      if (!out || !out.length) {
        const why = sorry
          ? 'Google wants a human check — open the BROWSER panel, search once and solve it, then try again'
          : (/(^|\.)consent\./i.test(host)
            ? 'Google is asking for cookie consent and it could not be dismissed — try again'
            : 'no results');
        return { ok: false, results: [], error: why };
      }
      return { ok: true, results: out.slice(0, cap) };
    } catch (e) {
      return { ok: false, results: [], error: e.message };
    } finally {
      if (tab) { _send('Target.closeTarget', { targetId: tab.id }).catch(() => {}); S.tabs.delete(tab.id); S.bySession.delete(tab.sessionId); }
    }
  },

  // click by ref (from readPage) or raw x,y. Ref resolves through the DOM box model
  // so the click lands on the element wherever it currently is.
  async clickRef({ id, ref, button = 'left', modifiers = 0 } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    const backendNodeId = tab.refMap.get(String(ref || ''));
    if (!backendNodeId) return { ok: false, error: 'unknown ref (call readPage first): ' + ref };
    try {
      await _send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, tab.sessionId).catch(() => {});
      const box = await _send('DOM.getBoxModel', { backendNodeId }, tab.sessionId);
      const q = box.model.content; const x = (q[0] + q[2] + q[4] + q[6]) / 4; const y = (q[1] + q[3] + q[5] + q[7]) / 4;
      return Webengine.click({ id: tab.id, x, y, button, modifiers });
    } catch (e) { return { ok: false, error: 'ref not clickable: ' + e.message }; }
  },

  // What is under the pointer — the page context menu needs to know whether it is over a
  // link, an image or an editable field before it can offer anything honest. The function
  // is FIXED and the coordinates are numbers: nothing caller-shaped is ever compiled.
  // Point OR element: `ref` (from readPage) asks about a node the caller already found,
  // which is how a test — or an agent — inspects a link without having to guess pixels.
  async hitTest({ id, x, y, ref } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    if (ref) {
      const backendNodeId = tab.refMap.get(String(ref));
      if (!backendNodeId) return { ok: false, error: 'unknown ref (call readPage first): ' + ref };
      try {
        await _send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, tab.sessionId).catch(() => {});
        const box = await _send('DOM.getBoxModel', { backendNodeId }, tab.sessionId, 4000);
        const q = box.model.content;
        x = (q[0] + q[2] + q[4] + q[6]) / 4; y = (q[1] + q[3] + q[5] + q[7]) / 4;
      } catch (e) { return { ok: false, error: 'ref not measurable: ' + e.message }; }
    }
    try {
      // Tight budgets on purpose: a menu that arrives late is a menu the owner already
      // gave up on. If the page cannot answer in time, the menu still opens — with the
      // actions that do not depend on what is under the pointer.
      const node = await _send('DOM.getNodeForLocation', { x: Math.round(_num(x)), y: Math.round(_num(y)), includeUserAgentShadowDOM: false }, tab.sessionId, 2500);
      const backendNodeId = node && node.backendNodeId;
      if (!backendNodeId) return { ok: true, link: '', linkText: '', img: '', editable: false, selection: '' };
      const r = await _send('DOM.resolveNode', { backendNodeId }, tab.sessionId, 6000);
      const objectId = r && r.object && r.object.objectId;
      if (!objectId) return { ok: true, link: '', linkText: '', img: '', editable: false, selection: '' };
      const functionDeclaration = `function(){
        const a=this.closest?this.closest('a[href]'):null;
        const im=(this.tagName==='IMG'&&this.currentSrc)?this.currentSrc:(this.closest?((this.closest('img')||{}).currentSrc||''):'');
        const ed=!!(this.closest&&this.closest('input,textarea,[contenteditable=""],[contenteditable="true"]'));
        const sel=(window.getSelection?String(getSelection()):'').slice(0,4000);
        return {link:a?a.href:'',linkText:a?(a.innerText||'').trim().slice(0,80):'',img:String(im||'').slice(0,2000),editable:ed,selection:sel};
      }`;
      const out = await _send('Runtime.callFunctionOn', { objectId, functionDeclaration, returnByValue: true }, tab.sessionId, 6000);
      const v = (out && out.result && out.result.value) || {};
      return { ok: true, link: String(v.link || ''), linkText: String(v.linkText || ''), img: String(v.img || ''), editable: !!v.editable, selection: String(v.selection || '') };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // Find-in-page. window.find() is the only primitive that both scrolls to a match and
  // SELECTS it, which is what a person expects from ⌘F. The needle is passed as an
  // ARGUMENT, never spliced into source — the no-eval-injection rule holds even here.
  async findText({ id, query, backwards = false } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    const q = String(query == null ? '' : query).slice(0, 400);
    if (!q) return { ok: false, error: 'empty query' };
    try {
      const r = await _send('Runtime.evaluate', {
        expression: '(function(q,b){try{const s=getSelection();if(b&&s&&s.rangeCount)s.collapseToStart();return window.find(q,false,!!b,true,false,false,false)}catch(e){return false}})',
        returnByValue: false,
      }, tab.sessionId, 6000);
      const objectId = r && r.result && r.result.objectId;
      if (!objectId) return { ok: false, error: 'find unavailable' };
      const out = await _send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: 'function(q,b){return this(q,b)}',
        arguments: [{ value: q }, { value: !!backwards }], returnByValue: true,
      }, tab.sessionId, 8000);
      return { ok: true, found: !!(out && out.result && out.result.value) };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // Stage the bytes of a file the owner picked, so the page can be given a real path.
  // The name is reduced to a bare filename before it is used — a caller cannot write
  // outside the uploads directory no matter what it sends.
  stageUpload({ name, data } = {}) {
    const safe = String(name || 'file').split(/[/\\]/).pop().replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) return { ok: false, error: 'empty file' };
    if (buf.length > MAX_UPLOAD) return { ok: false, error: `that file is larger than the ${Math.round(MAX_UPLOAD / 1048576)}MB upload limit` };
    try {
      const dir = uploadDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const full = path.join(dir, safe);
      fs.writeFileSync(full, buf, { mode: 0o600 });
      return { ok: true, path: full, bytes: buf.length };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // Answer a waiting file chooser. Paths must be ones we staged: the page chose the
  // moment, the OWNER chose the file, and nothing else on disk is reachable from here.
  async setFiles({ id, node, files } = {}) {
    const tab = (id != null ? _tab(id) : _primaryTab());
    if (!tab) return { ok: false, error: 'no tab open' };
    const dir = uploadDir();
    const list = (Array.isArray(files) ? files : []).map(String)
      .filter((f) => path.resolve(f).startsWith(dir + path.sep))
      .slice(0, 10);
    if (!list.length) return { ok: false, error: 'nothing staged to send' };
    try {
      await _send('DOM.setFileInputFiles', { files: list, backendNodeId: Number(node) || undefined }, tab.sessionId, 8000);
      return { ok: true, count: list.length };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // What the browser has fetched to disk this session — newest first. The agent can act
  // on a file the owner just downloaded without being told where it went.
  downloads() {
    return { ok: true, dir: DOWNLOAD_DIR, items: [...S.dls.values()].slice(-20).reverse().map((d) => ({ name: d.name, url: d.url, state: d.state, bytes: d.got, total: d.total, path: d.path || null })) };
  },

  consoleLog({ id } = {}) { const tab = (id != null ? _tab(id) : _primaryTab()); if (!tab) return { ok: false, error: 'no tab open' }; return { ok: true, entries: tab.console.slice(-60) }; },
  network({ id } = {}) { const tab = (id != null ? _tab(id) : _primaryTab()); if (!tab) return { ok: false, error: 'no tab open' }; return { ok: true, requests: tab.net.slice(-60) }; },

  // Sign-in mode. A passkey or a security key needs a real window to draw its dialog on
  // (see "the passkey moment"), which headless does not have, so signing in means running
  // the engine headful with its windows parked under the app's own window. The profile
  // singleton lock means one instance, so this is a relaunch: every tab's URL is
  // snapshotted and rebuilt afterwards in a NEW private context. That CLEARS the current
  // session — which is why it belongs before a sign-in, never in the middle of one.
  // `cover` is the app window's screen rect; without it there is nowhere to hide.
  // ── the sign-in window: open it, use it, and it disappears ────────────────
  // Open a REAL Chrome window on `url` and leave it in front. Everything a sign-in can
  // ask for works there — password, passkey, security key, an SMS code — because it is a
  // genuine browser window, not a picture of one.
  async signinStart({ url, cover } = {}) {
    const u = _safeUrl(url);
    if (!u || u === 'about:blank') return { ok: false, error: 'a sign-in needs a page to sign in to' };
    if (cover) S.cover = { left: _num(cover.left), top: _num(cover.top), width: _num(cover.width), height: _num(cover.height) };
    S.signin = null;
    const r = await _relaunch(true);
    if (r.ok === false) return r;
    const t = await Webengine.open({ url: u });
    if (!t.ok) return t;
    const tab = _tab(t.id);
    if (tab) { _signinArm(tab, u); await _placeWindow(tab, true); }
    return { ok: true, id: t.id, url: u, origin: _originOf(u) };
  },
  // Done. Take the session out of the window, put the engine back to windowless, and put
  // the session into it — so the owner lands signed in, with nothing left open.
  async signinFinish() {
    if (!S.headful) return { ok: false, error: 'no sign-in window is open' };
    const cookies = await _harvestCookies();
    const tabs = [...S.tabs.values()].map((t) => ({ url: t.url, casting: t.casting }));
    if (S.signin && S.signin.settle) clearTimeout(S.signin.settle);
    S.signin = null;
    const r = await _relaunch(false, { cookies, tabs: tabs.filter((t) => /^https?:\/\//i.test(t.url)) });
    // Which sites actually came across — the one number that says whether a sign-in
    // survived, and the first thing to look at when it did not.
    const domains = [...new Set(cookies.map((c) => String(c.domain || '').replace(/^\./, '')))].sort().slice(0, 25);
    return { ...r, carried: cookies.length, restored: r.restored || 0, rejected: r.rejected || 0, domains };
  },
  // Walked away from it: close the window and keep nothing.
  async signinCancel() {
    if (S.signin && S.signin.settle) clearTimeout(S.signin.settle);
    S.signin = null;
    if (!S.headful) return { ok: true, headful: false };
    return _relaunch(false);
  },

  async signin({ on = true, cover } = {}) {
    if (cover) S.cover = { left: _num(cover.left), top: _num(cover.top), width: _num(cover.width), height: _num(cover.height) };
    const r = await _relaunch(!!on);
    return { ...r, signin: S.headful, cover: S.cover };
  },
  // The app window moved or resized: hidden windows must follow it or they peek out.
  async setCover({ left, top, width, height } = {}) {
    S.cover = { left: _num(left), top: _num(top), width: _num(width), height: _num(height) };
    S.coverAt = Date.now();
    await _placeAll();
    return { ok: true, cover: S.cover };
  },
  // The owner's answer to a ceremony this engine could not serve: 'go' lets the page ask
  // Chrome anyway (it will hang — only useful once sign-in mode is on), 'refuse' rejects
  // it with NotAllowedError so the site offers its other sign-in methods instead of
  // spinning forever.
  async passkey({ tag, verdict = 'refuse' } = {}) {
    const rec = S.pk.get(String(tag || ''));
    if (!rec) return { ok: false, error: 'no such ceremony' };
    const tab = _tab(rec.tabId);
    if (!tab) { S.pk.delete(String(tag)); return { ok: false, error: 'tab is gone' }; }
    S.pk.delete(String(tag));
    await _releasePasskey(tab, tag, verdict === 'go' ? 'go' : 'refuse');
    return { ok: true, verdict: verdict === 'go' ? 'go' : 'refuse' };
  },
  async reveal() { return _relaunch(true); },
  async unreveal() { return _relaunch(false); },

  // op=web data plane (dispatchStream hands the upgraded socket here). Frames and
  // tab meta are PUSHED to watchers the instant Chrome produces them — no polling —
  // and input events ride the same socket. The message surface mirrors the RPC
  // whitelist exactly; nothing new crosses the CDP boundary.
  attachWs(ws) {
    if (!ws || typeof ws.on !== 'function') return { ok: false, error: 'stream-only surface' };
    ws._watch = new Set();
    ws._q = Promise.resolve(); // serialize input batches — input order is semantics
    S.wsClients.add(ws);
    // The reaper used to be armed only by the HTTP frame() poll — under the WS push
    // plane nobody polls, so orphaned tabs (closed panels, dead clients) lived forever.
    _startReaper();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      const t = m && m.t;
      if (t === 'watch') {
        const tab = _tab(m.id);
        if (m.bin) ws._bin = true; // client decodes [len][header][jpeg] binary frames
        if (tab) {
          ws._watch.add(tab.id); tab.lastSeen = Date.now();
          if (tab.frame) {
            if (ws._bin) _wsFrameTo(ws, _frameBinary(tab, tab.frame));
            else _wsSend(ws, { t: 'frame', id: tab.id, seq: tab.frame.seq, data: tab.frame.data, metadata: tab.frame.metadata });
          }
          _wsSend(ws, { t: 'tab', id: tab.id, url: tab.url, title: tab.title });
        } else {
          // Watching something that does not exist is how a window discovers it is
          // holding a corpse. After a bridge restart the panel reconnects and re-watches
          // the tab ids it remembers — the engine is new and knows none of them, and the
          // old code answered with silence, so the canvas kept showing the last frame it
          // ever painted and the strip kept listing dead tabs. That IS the freeze the
          // owner reported (confirmed on his screen, 2026-07-25). Say it plainly instead:
          // the panel drops the tab and opens a fresh one.
          _wsSend(ws, { t: 'gone', id: String(m.id == null ? '' : m.id) });
        }
      } else if (t === 'unwatch') {
        ws._watch.delete(String(m.id == null ? '' : m.id));
      } else if (t === 'input') {
        const id = m.id, events = m.events;
        // Causal attribution for popups: the click that opens a target="_blank" link
        // crosses exactly one socket, and that socket's window is where the new tab belongs.
        S.inputWs = ws; S.inputAt = Date.now();
        ws._q = ws._q.then(() => Webengine.input({ id, events })).catch(() => { /* tab may be closing */ });
        const tab = _tab(id); if (tab) tab.lastSeen = Date.now();
      } else if (t === 'ping') {
        _wsSend(ws, { t: 'pong' });
      }
    });
    const drop = () => { S.wsClients.delete(ws); if (ws._lagT) { clearTimeout(ws._lagT); ws._lagT = null; } ws._lagFrame = null; };
    ws.on('close', drop); ws.on('error', drop);
    _wsSend(ws, { t: 'hello', running: !!(S.proc && S.ready) });
    return { ok: true };
  },
};

async function _historyStep(id, delta) {
  const tab = (id != null ? _tab(id) : _primaryTab());
  if (!tab) return { ok: false, error: 'no tab open' };
  try {
    const h = await _send('Page.getNavigationHistory', {}, tab.sessionId);
    const i = h.currentIndex + delta;
    if (!Array.isArray(h.entries) || i < 0 || i >= h.entries.length) return { ok: false, error: 'no history entry' };
    await _send('Page.navigateToHistoryEntry', { entryId: h.entries[i].id }, tab.sessionId);
    return { ok: true, url: h.entries[i].url };
  } catch (e) { return { ok: false, error: e.message }; }
}

// reveal/unreveal: relaunch the engine headful/headless, preserving tabs. The profile
// singleton lock forces one instance, so we snapshot each tab's url + casting state,
// kill the engine, respawn in the requested mode, and rebuild the tabs pointed back
// at their pages — in a fresh private context, so the relaunch also drops every cookie
// and cache the old one held (the engine restart IS a wipe; this is by design).
S.headful = false;
async function _relaunch(headful, { cookies, tabs } = {}) {
  headful = !!headful;
  if (!cookies && !tabs && S.proc && S.ready && S.headful === headful) return { ok: true, headful, unchanged: true };
  const snap = tabs || [...S.tabs.values()].map((t) => ({ url: t.url, casting: t.casting }));
  const proc = S.proc;
  if (proc) {
    try { proc.stdio[3].end(); } catch { /* pipe gone */ }
    try { proc.kill('SIGTERM'); } catch { /* gone */ }
    await _waitExit(proc, 2000);
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    // WAIT for it to actually be gone. Chrome holds a singleton lock on the profile
    // directory, and _spawnEngine deletes that directory and starts a new Chrome on it:
    // racing a process that is still dying gives a Chrome that exits on arrival, which
    // surfaces to the owner as "Browser engine unavailable" and leaves sign-in mode stuck
    // half-on. This is the wait that was missing.
    await _waitExit(proc, 3000);
  }
  S.proc = null; S.ready = false; S.headful = headful;
  // Every ceremony waiting on the old engine died with it — its page no longer exists.
  S.pk.clear();
  try { await _spawnEngine(); }
  catch (e) {
    // One honest retry: the lock is the usual reason, and it clears in well under a second.
    await new Promise((r) => setTimeout(r, 900));
    try { await _spawnEngine(); } catch { return { ok: false, error: e.message }; }
  }
  // Cookies BEFORE the first page loads, or the rebuilt tab arrives signed out and the
  // whole point of carrying them across is lost.
  let restored = 0, rejected = 0;
  if (cookies && cookies.length) {
    try {
      const ctx = await _ensureCtx();
      const r = await _restoreCookies(cookies, ctx);
      restored = r.restored; rejected = r.rejected;
    } catch { /* a session that refuses to travel is reported, never faked */ }
  }
  const rebuilt = [];
  for (const s of snap) {
    if (!/^https?:\/\//i.test(s.url)) continue;
    try { const r = await Webengine.open({ url: s.url }); if (r.ok) { rebuilt.push({ id: r.id, url: s.url }); if (s.casting) await Webengine.castStart({ id: r.id }); } }
    catch { /* one tab failing must not abort the rest */ }
  }
  // The caller has to be able to re-bind: after a relaunch every tab id the panel held is
  // a corpse, and a panel that guesses opens a tab nobody asked for (which, in sign-in
  // mode, is a second real window on the owner's desktop — exactly what he reported).
  return { ok: true, headful, restored, rejected, tabs: rebuilt };
}

// ── the sign-in window ───────────────────────────────────────────────────────
// What the owner asked for, and it is the right shape: a real window appears ONLY for the
// sign-in, and when it is done it GOES AWAY — no external browser is left sitting around.
// The session survives because a session is cookies: they are read out of the private
// context before the headful engine dies and written into the headless one before its
// first page loads. Everything else about that window (its history, its cache) dies with
// it, exactly like the rest of this browser.
// Limits, stated honestly: sites that keep their session in localStorage rather than
// cookies will not carry across, and a provider that binds its cookies to the device
// profile (Google's own DBSC sessions) can invalidate them on first refresh — which is why
// the target here is the SITE's session (github.com), not the provider's.
// Only the fields a session actually needs. The exotic ones a live Chrome reports back
// (sameParty, sourcePort, partitionKey, priority) are the ones whose shape drifts between
// versions, and Storage.setCookies is ALL-OR-NOTHING: one cookie Chrome dislikes rejects
// the whole call, so a single odd field silently costs the entire sign-in.
const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires'];
function _cookieParams(list) {
  return (list || []).map((c) => {
    const o = {};
    for (const k of COOKIE_FIELDS) if (c[k] !== undefined && c[k] !== null) o[k] = c[k];
    return o;
  }).filter((c) => c.name && c.domain);
}
// Restore them, and know how many really landed. Batch first because it is one round trip;
// if Chrome refuses the batch, go one at a time so the session is not lost to whichever
// single cookie it disliked, and report the truth either way.
async function _restoreCookies(cookies, ctx) {
  if (!cookies || !cookies.length) return { restored: 0, rejected: 0 };
  try {
    await _send('Storage.setCookies', { cookies, browserContextId: ctx }, undefined, 20000);
    return { restored: cookies.length, rejected: 0 };
  } catch { /* fall through to one-by-one */ }
  let restored = 0, rejected = 0;
  for (const c of cookies) {
    try { await _send('Storage.setCookies', { cookies: [c], browserContextId: ctx }, undefined, 8000); restored++; }
    catch { rejected++; }
  }
  return { restored, rejected };
}
async function _harvestCookies() {
  if (!S.ctx) return [];
  try {
    const r = await _send('Storage.getCookies', { browserContextId: S.ctx }, undefined, 20000);
    return _cookieParams(r && r.cookies);
  } catch { return []; }
}
// While a sign-in is live the window is meant to be SEEN: it is the one moment this
// browser asks the owner to look at a real Chrome window.
function _signinArm(tab, url) {
  S.signin = {
    tabId: tab.id, origin: _originOf(url), startUrl: String(url || ''),
    moved: false, at: Date.now(), settle: null, seen: 0,
    busy: false,        // a credential prompt is open — see _onPasskey
    tries: 0,
    before: new Set(),  // the cookies that existed BEFORE the sign-in (filled just below)
  };
  // A sign-in is finished when the SITE HAS GIVEN A SESSION, not when the page stops
  // moving. Remember what was there first so "new" means something.
  _harvestCookies().then((list) => {
    if (S.signin && S.signin.tabId === tab.id) for (const c of list) S.signin.before.add(c.domain + '|' + c.name);
  }).catch(() => {});
}
function _originOf(u) { try { return new URL(String(u)).origin; } catch { return ''; } }
// Hostnames, tested as hostnames. The first cut tested the whole URL against a pattern
// anchored with (^|\.), which can never match "https://accounts.google.com/…" — the
// character before the host is a slash. So nothing was ever recognised as an auth page and
// the finish detector could not work. Measured on the owner's own run.
const AUTH_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|auth0\.com|okta\.com|duosecurity\.com|id\.atlassian\.com)$/i;
function _isAuthUrl(u) {
  try {
    const x = new URL(String(u));
    if (AUTH_HOSTS.test(x.hostname)) return true;
    // A site's own login path counts too, so "finished" never fires on the form itself.
    if (/^\/(login|signin|sign_in|session|sessions|oauth|authorize)/i.test(x.pathname)) return true;
    return false;
  } catch { return false; }
}
// The sign-in is "probably finished" when the window is back on the site it started from
// and has stopped moving. The owner can always say so first with the panel's Done button;
// this only saves them the click.
// Closing the window IS "I'm done" — it is what anyone would do, and it needs no visible
// app behind it. The cookies live in the browser context, not in the window, so they are
// still there to be harvested after the tab is gone.
function _signinClosed(tabId) {
  const s = S.signin;
  if (!s || s.tabId !== tabId) return;
  if (s.settle) { clearTimeout(s.settle); s.settle = null; }
  for (const ws of S.wsClients) _wsSend(ws, { t: 'signin', phase: 'ready', closed: true });
}
function _signinWatch(tab) {
  const s = S.signin;
  if (!s || !tab || tab.id !== s.tabId) return;
  s.seen = (s.seen || 0) + 1;   // how many navigations this watcher actually saw
  if (String(tab.url || '') !== s.startUrl) s.moved = true;   // sticky: it went somewhere
  // Finished = it has been somewhere, it is no longer on any sign-in page, and it stopped.
  // Keying on "back at the origin it started from" was wrong the moment the owner pressed
  // SIGN IN while already inside Google's flow: the origin WAS the provider, so the
  // condition could never come true.
  const back = s.moved && !_isAuthUrl(tab.url) && /^https?:/i.test(String(tab.url || ''));
  if (s.settle) { clearTimeout(s.settle); s.settle = null; }
  if (!back || s.busy) return;   // busy = a credential prompt is open; nothing has finished
  // The minimum age is folded into the WAIT, never used as an early return. Returning
  // early was a trap: the check only runs when a navigation arrives, so a sign-in whose
  // LAST navigation landed a moment before the minimum was never re-examined and the
  // window sat there forever — reproduced 3 times out of 3 at the boundary, and it is
  // what the owner met on his own run.
  const wait = Math.max(2500, 4000 - (Date.now() - s.at));
  s.settle = setTimeout(async () => {
    s.settle = null;
    if (S.signin !== s || s.busy) return;
    // Second signal: the site has actually GIVEN something. A page that merely stopped
    // moving proves nothing — it looks identical while a system password prompt is up.
    // Waiting for a cookie the sign-in did not have before is waiting for the session
    // itself. Soft, not absolute: after ~3 more looks, trust the quiet, because a site
    // that reuses its cookie names would otherwise never be declared done (and closing
    // the window by hand always works regardless).
    let fresh = 0;
    try { fresh = (await _harvestCookies()).filter((c) => !s.before.has(c.domain + '|' + c.name)).length; } catch { fresh = 0; }
    if (!fresh && s.tries < 3) {
      s.tries++;
      s.settle = setTimeout(() => { s.settle = null; _signinWatch(tab); }, 3000);
      if (s.settle.unref) s.settle.unref();
      return;
    }
    _pushWatchers(tab.id, { t: 'signin', phase: 'ready', url: tab.url, fresh });
    for (const ws of S.wsClients) _wsSend(ws, { t: 'signin', phase: 'ready', url: tab.url, fresh });
  }, wait);
  if (s.settle.unref) s.settle.unref();
}

export default Webengine;
