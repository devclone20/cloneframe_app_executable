// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — electron/url-guard
//
// One place that decides whether a URL may be LOADED by the native shell.
//
// Why it exists: `cfhub:web:navigate` handed whatever string the renderer sent
// straight to `webContents.loadURL()` with no check at all, while every other
// URL path in main.js already gated on a scheme (`/^https?:\/\//` before
// forwarding a window.open, `/^https:\/\//` before openExternal). So the one
// entry point a compromised or injected renderer would actually reach was the
// one with no guard: `file:///Users/<you>/.ssh/id_ed25519` renders the file,
// `javascript:` runs in the view's context, `data:` fabricates a page that can
// pretend to be any site in the address bar.
//
// The rule is a positive list, not a blocklist: http and https load, plus
// about:blank (Electron's own empty page, which the shell uses to park a view).
// Everything else — file, javascript, data, blob, chrome, devtools, ftp, custom
// app schemes — is refused. A blocklist would have to keep pace with every
// scheme Chromium adds; a positive list does not.
//
// SCOPE, honestly: this constrains what the SHELL will load on command. It is
// not a content sandbox — an https page is still an https page, and the view's
// own webPreferences (contextIsolation + sandbox, no preload) are what contain
// it. What this removes is a renderer's ability to point the native shell at
// the local filesystem or at script-bearing pseudo-schemes.
//
// CommonJS on purpose: electron/ is a CJS package (main.js, preload.js), and
// tests require() this file directly.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

// The only schemes the shell will navigate a view to.
const LOADABLE = new Set(['http:', 'https:']);
// Parked/blank views. Exact matches only — `about:` in general is not loadable
// (about:cache, about:gpu … are Chromium internals with no business here).
const BLANK = new Set(['about:blank', 'about:blank#blocked']);

// isLoadableUrl(u) -> boolean. Never throws; a malformed URL is simply not loadable.
function isLoadableUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  const s = u.trim();
  if (BLANK.has(s.toLowerCase())) return true;
  let parsed;
  try { parsed = new URL(s); } catch { return false; }
  return LOADABLE.has(parsed.protocol);
}

// A window.open target may be opened as a REAL child window (opener intact) only
// when it is an https page on a provider's own host, OR an https URL whose path
// looks like an OAuth endpoint. The path test used to run on the raw string with
// no scheme check, so `javascript:...//sso/...` satisfied it — a string containing
// "/sso/" was enough to be granted a child window. Parse first, then judge.
function isOAuthPopupUrl(u, authHostRe, pathRe) {
  let parsed;
  try { parsed = new URL(String(u)); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;      // OAuth over anything else is not OAuth
  if (authHostRe && authHostRe.test(parsed.hostname)) return true;
  return !!(pathRe && pathRe.test(parsed.pathname));   // PATH only — never the query or hash
}

module.exports = { isLoadableUrl, isOAuthPopupUrl, LOADABLE, BLANK };
