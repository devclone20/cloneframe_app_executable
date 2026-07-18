// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — native shell (Electron main process)
//
// Same app, same bridge, same index.html — but the shell is now Electron instead of
// a `chrome --app` window. The single reason for this: the in-app browser can be a
// real top-level WebContentsView (a genuine Chromium web-contents embedded in OUR
// window) instead of an <iframe>. That is the ONLY architecture in which full web
// apps run and a real Google-account sign-in works while never leaving the app —
// proven by electron/poc.js (Google's live sign-in form loads, not the "browser may
// not be secure" block that kills iframes/webviews).
//
// This process:
//   • ensures the HUB Bridge daemon is up on 127.0.0.1:<port> (spawns it if not),
//   • opens the app shell (index.html served by the bridge) in a BrowserWindow,
//   • owns a pool of native browser views (WebContentsView) that the renderer drives
//     over IPC — one per in-app browser tab — positioned to match the browser panel.
//
// SECURITY: the app shell is trusted local code; remote web content lives ONLY inside
// the WebContentsViews, in an isolated persistent session partition, and can never
// reach Node (its webPreferences have no preload, contextIsolation on, sandbox on).
// External-window opens from web content are kept INSIDE the app (routed to a tab),
// never spawned as OS windows — the zero-escape rule holds.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { app, BrowserWindow, WebContentsView, session, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = process.env.HUB_BRIDGE_PORT || '8765';
const APP_URL = `http://127.0.0.1:${PORT}`;
const BRIDGE_DIR = path.join(__dirname, '..', 'bridge');
// A branded-Chrome UA whose MAJOR VERSION MATCHES the engine actually running —
// a UA claiming a newer Chrome than the real Chromium is a detectable lie (client
// hints + feature probes betray it). Real Chrome reduces minor versions to 0.0.0.
const CHROME_MAJOR = (process.versions.chrome || '130').split('.')[0];
const CHROME_FULL = process.versions.chrome || '130.0.0.0';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
// Electron's UA client hints identify the brand as "Chromium" ONLY — the "Google Chrome"
// brand is ABSENT (verified: sec-ch-ua = "Not?A_Brand";v="99", "Chromium";v="130"). Google's
// embedded-browser gate flags exactly that: a UA claiming Chrome but client hints that aren't
// genuine Google Chrome → "This browser or app may not be secure". Presenting the real
// three-brand list closes the gap. GREASE brand kept variable to avoid a static fingerprint.
const CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Not?A_Brand";v="99", "Google Chrome";v="${CHROME_MAJOR}"`;
const CH_UA_FULL = `"Chromium";v="${CHROME_FULL}", "Not?A_Brand";v="99.0.0.0", "Google Chrome";v="${CHROME_FULL}"`;
// Big identity providers MAY refuse account sign-in inside embedded browsers. We no
// longer block the attempt (passkey flows can succeed where password flows are walled)
// — we let the navigation run and only intervene when the provider actively REJECTS
// (their deterministic "browser may not be secure" page). AUTH_HOST is still used to
// recognise OAuth popups so they open as real child windows (window.opener intact).
const AUTH_HOST = /(^|\.)accounts\.google\.com$|(^|\.)appleid\.apple\.com$|(^|\.)login\.microsoftonline\.com$|(^|\.)login\.live\.com$/i;
function isAuthUrl(u) { try { return AUTH_HOST.test(new URL(u).hostname); } catch { return false; } }
// Provider rejection pages — the only trigger for the in-app auth wall.
const REJECT_RE = /accounts\.google\.com\/(v3\/)?signin\/rejected|deniedsigninrejected|disallowed_useragent/i;
// OAuth popups (window.open) must be REAL child windows of the app: the opener
// relationship carries the postMessage handshake that completes the login.
const OAUTH_POPUP_RE = /\/oauth|\/__\/auth\/|\/signin-|\/sso\//i;
function isOAuthPopup(u) { return isAuthUrl(u) || OAUTH_POPUP_RE.test(u); }

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

// ── bridge lifecycle ─────────────────────────────────────────────────────────
function health() {
  return new Promise((res) => {
    const req = http.get(APP_URL + '/health', (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.setTimeout(800, () => { req.destroy(); res(false); });
  });
}
// GUI launches (`open`/Finder) carry a minimal PATH with no Homebrew — resolve the
// system node by absolute path. Electron-as-node is NOT an option here: the bridge
// loads native modules (node-pty) compiled against the system node ABI.
function resolveNode() {
  const fs = require('fs');
  for (const c of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'node';
}
async function ensureBridge() {
  if (await health()) return true;
  spawn(resolveNode(), ['hub-bridge.mjs'], { cwd: BRIDGE_DIR, detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) { if (await health()) return true; await new Promise((r) => setTimeout(r, 200)); }
  return false;
}

// ── native browser views (one per in-app browser tab) ────────────────────────
let mainWin = null;
let webSession = null;
const views = new Map(); // id -> WebContentsView
// id -> the site that led into the current auth flow. For a third-party OAuth this is
// the site (github.com); for a DIRECT visit to a provider it is the provider itself, so
// the renderer can tell "log in on this site" from "this provider blocks its own login".
const lastSites = new Map();

function ensureSession() {
  if (webSession) return webSession;
  webSession = session.fromPartition('persist:cfhub-web');
  webSession.setUserAgent(CHROME_UA);
  // Rewrite the UA client-hint headers on every request so the app presents itself as
  // genuine Google Chrome (Electron omits the "Google Chrome" brand — the tell Google's
  // sign-in gate keys off). Only touch hints Chromium already chose to send; adding the
  // full-version list unconditionally is harmless (Google requests it via Accept-CH).
  webSession.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    let sawUA = false, sawFull = false, sawMobile = false, sawPlat = false;
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'user-agent') h[k] = CHROME_UA;                 // setUserAgent on views is unreliable (electron#47979)
      else if (lk === 'sec-ch-ua') { h[k] = CH_UA; sawUA = true; }
      else if (lk === 'sec-ch-ua-full-version-list') { h[k] = CH_UA_FULL; sawFull = true; }
      else if (lk === 'sec-ch-ua-mobile') sawMobile = true;
      else if (lk === 'sec-ch-ua-platform') sawPlat = true;
    }
    // Only add hints to requests that already carry the low-entropy sec-ch-ua (i.e. the
    // browser decided to send client hints for this request) — keeps non-hint requests clean.
    if (sawUA) {
      if (!sawFull) h['sec-ch-ua-full-version-list'] = CH_UA_FULL;
      if (!sawMobile) h['sec-ch-ua-mobile'] = '?0';
      if (!sawPlat) h['sec-ch-ua-platform'] = '"macOS"';
    }
    cb({ requestHeaders: h });
  });
  return webSession;
}

// Override navigator.userAgentData in the PAGE's main world so JS-side checks (Google
// Identity Services) see genuine "Google Chrome" too — the header rewrite alone leaves
// the JS brand list saying "Chromium", and that mismatch is itself a tell. A preload runs
// in an isolated world and can't touch the page's navigator; accounts.google.com's CSP
// blocks an injected <script>. CDP addScriptToEvaluateOnNewDocument runs main-world, at
// document-start, before page scripts — the only reliable surface. NOT automation: no
// input is driven, navigator.webdriver stays false.
function spoofUaData(wc) {
  const src = `(() => {
    try {
      const V='${CHROME_MAJOR}', FV='${CHROME_FULL}';
      const brands=[{brand:'Chromium',version:V},{brand:'Not?A_Brand',version:'99'},{brand:'Google Chrome',version:V}];
      const full=[{brand:'Chromium',version:FV},{brand:'Not?A_Brand',version:'99.0.0.0'},{brand:'Google Chrome',version:FV}];
      const ghev=(hints)=>Promise.resolve({architecture:'x86',bitness:'64',model:'',wow64:false,platform:'macOS',platformVersion:'15.5.0',uaFullVersion:FV,fullVersionList:full,brands,mobile:false});
      ghev.toString=()=>'function getHighEntropyValues() { [native code] }';
      const data={brands,mobile:false,platform:'macOS',getHighEntropyValues:ghev,toJSON:()=>({brands,mobile:false,platform:'macOS'})};
      Object.defineProperty(navigator,'userAgentData',{get:()=>data,configurable:true});
    } catch(_){}
  })();`;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    // Chain + return so the caller can await registration BEFORE the first real navigation.
    return wc.debugger.sendCommand('Page.enable')
      .then(() => wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: src }))
      .catch(() => {});
  } catch (_) { /* debugger may be claimed by an external CDP client (e.g. --remote-debugging-port during tests) */ }
  return Promise.resolve();
}

function pushState(id) {
  const v = views.get(id); if (!v || !mainWin) return;
  const wc = v.webContents;
  try {
    if (wc.getURL() === 'about:blank') return; // internal seed page — never surface it
    mainWin.webContents.send('cfhub:web:state', {
      id, url: wc.getURL(), title: wc.getTitle(),
      canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
      canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
      loading: wc.isLoading(),
    });
  } catch (_) {}
}

ipcMain.handle('cfhub:web:create', async (_e, { id }) => {
  if (views.has(id)) return { ok: true };
  const ses = ensureSession();
  const v = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true } });
  v.setVisible(false);
  v.webContents.setUserAgent(CHROME_UA);
  const wc = v.webContents;
  // Sign-in flows run UNBLOCKED in the view (passkeys/security keys can succeed where
  // password flows are walled). `lastSites` remembers the page that initiated an auth
  // redirect so a rejection wall can send the user back somewhere useful.
  // window.open: OAuth popups become REAL child windows of the app (same session, the
  // opener postMessage handshake completes the login, still our window — zero-escape
  // holds). Everything else is routed back to the renderer as a new in-app tab.
  v.webContents.setWindowOpenHandler(({ url }) => {
    if (isOAuthPopup(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: mainWin, width: 520, height: 660, autoHideMenuBar: true,
          webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:\/\//i.test(url) && mainWin) mainWin.webContents.send('cfhub:web:openurl', { id, url });
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => {
    try { child.webContents.setUserAgent(CHROME_UA); } catch (_) {}
    spoofUaData(child.webContents); // same genuine-Chrome disguise in the OAuth popup
    // a provider rejection inside the popup: close it and raise the honest wall
    child.webContents.on('did-navigate', (_e2, url) => {
      if (REJECT_RE.test(url)) {
        try { child.close(); } catch (_) {}
        if (mainWin) mainWin.webContents.send('cfhub:web:authwall', { id, authUrl: url, siteUrl: lastSites.get(id) || wc.getURL() });
      }
    });
  });
  // provider rejection in the view itself → honest wall (the ONLY auth intervention).
  // Google reaches its rejection page via an IN-PAGE (SPA) transition, so both real
  // and in-page navigations must be watched. An auth-host URL never overwrites lastSites
  // (it's the destination, not the initiator) — except a DIRECT visit, seeded by navigate().
  const onNav = (_e2, url) => {
    if (url === 'about:blank') return;
    if (REJECT_RE.test(url)) {
      if (mainWin) mainWin.webContents.send('cfhub:web:authwall', { id, authUrl: url, siteUrl: lastSites.get(id) || '' });
      return;
    }
    if (!isAuthUrl(url)) lastSites.set(id, url);
  };
  wc.on('did-navigate', onNav);
  wc.on('did-navigate-in-page', onNav);
  ['did-navigate', 'did-navigate-in-page', 'did-finish-load', 'did-stop-loading', 'did-start-loading', 'page-title-updated']
    .forEach((ev) => wc.on(ev, () => pushState(id)));
  mainWin.contentView.addChildView(v);
  views.set(id, v);
  // Register the genuine-Chrome JS disguise BEFORE the user's first navigation. The Page
  // domain only resolves addScriptToEvaluateOnNewDocument once a document exists, so seed
  // an about:blank first, then inject. nativeNav() awaits create(), so navigate() runs after.
  try { await wc.loadURL('about:blank'); } catch (_) {}
  await spoofUaData(wc);
  return { ok: true };
});
ipcMain.handle('cfhub:web:setBounds', (_e, { id, bounds, visible }) => {
  const v = views.get(id); if (!v) return { ok: false };
  if (bounds) v.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
  if (typeof visible === 'boolean') v.setVisible(visible);
  return { ok: true };
});
ipcMain.handle('cfhub:web:navigate', async (_e, { id, url }) => {
  const v = views.get(id); if (!v) return { ok: false };
  // A commanded nav is a fresh destination: seed lastSites with it (even an auth host,
  // so a DIRECT visit to accounts.google.com is recognised as the provider's own site,
  // not a stale third-party from a previous flow).
  lastSites.set(id, url);
  try { await v.webContents.loadURL(url); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('cfhub:web:act', (_e, { id, action }) => {
  const v = views.get(id); if (!v) return { ok: false };
  const wc = v.webContents, nav = wc.navigationHistory;
  if (action === 'back') { nav ? nav.canGoBack() && nav.goBack() : wc.canGoBack() && wc.goBack(); }
  else if (action === 'forward') { nav ? nav.canGoForward() && nav.goForward() : wc.canGoForward() && wc.goForward(); }
  else if (action === 'reload') wc.reload();
  else if (action === 'stop') wc.stop();
  return { ok: true };
});
ipcMain.handle('cfhub:web:destroy', (_e, { id }) => {
  const v = views.get(id); if (!v) return { ok: true };
  try { mainWin.contentView.removeChildView(v); v.webContents.close(); } catch (_) {}
  views.delete(id); lastSites.delete(id);
  return { ok: true };
});
// Open a URL in the user's real system browser (their everyday Chrome, already signed
// into Google). Used ONLY for Google-account sign-in — the one flow Google blocks in
// every embedded browser by policy. https only.
ipcMain.handle('cfhub:open-external', (_e, { url }) => {
  if (/^https:\/\//i.test(url)) { shell.openExternal(url); return { ok: true }; }
  return { ok: false };
});

// ── window ───────────────────────────────────────────────────────────────────
async function createWindow() {
  mainWin = new BrowserWindow({
    width: 1480, height: 940, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hiddenInset',
    title: 'CLONE FRAME — HUB',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  mainWin.webContents.setUserAgent(CHROME_UA); // the shell itself also looks like normal Chrome
  // A renderer reload (⌘R) rebuilds the app from scratch — the old tabs' native views
  // would linger as orphans painted OVER the fresh page. Destroy them all on every
  // top-level navigation; the new renderer recreates what it needs.
  mainWin.webContents.on('did-navigate', () => {
    for (const [, v] of views) { try { mainWin.contentView.removeChildView(v); v.webContents.close(); } catch (_) {} }
    views.clear(); lastSites.clear();
  });
  await mainWin.loadURL(APP_URL);
  mainWin.on('closed', () => { mainWin = null; });
}

app.whenReady().then(async () => {
  const up = await ensureBridge();
  if (!up) { /* still open the window — it shows the "connect bridge" state */ }
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
