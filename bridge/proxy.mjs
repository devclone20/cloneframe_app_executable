// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — in-app browser proxy (render, don't redirect)
//
// Fetches a page server-side (SSRF-guarded, via web.mjs.fetchRaw) and rewrites the
// HTML so it can render inside the HUB's sandboxed <iframe> — the way a real browser
// pane would, not a text-only reader. It:
//   • sends NO X-Frame-Options / CSP (the bridge route sets permissive headers),
//   • strips the page's own CSP/refresh <meta> and any <base>,
//   • injects <base href="<final url>"> so the page's relative CSS/img/js load
//     DIRECTLY from the real origin (we proxy only the top-level document),
//   • injects a tiny controller that keeps navigation inside the proxy (link clicks
//     and GET form submits re-route through /proxy) and postMessages the parent so
//     the HUB address bar/title stay in sync.
//
// SECURITY: the caller embeds the result in <iframe sandbox="allow-scripts …"> WITHOUT
// allow-same-origin → opaque origin. The page's JS therefore cannot read the parent
// window, the bridge token, or authenticate to any bridge route. This module never
// reads disk and never sees the token. All fetching goes through web.mjs's SSRF guard.
// ─────────────────────────────────────────────────────────────────────────────
import { Web } from './web.mjs';

const MAX_HTML_BYTES = 4 * 1024 * 1024;

// Browser-engine presets — the standalone Browser panel lets the user pick Safari /
// Chrome / Firefox(Linux); we send that engine's real User-Agent so origins serve the
// matching layout. Firefox on Linux is the open-source/Linux flagship.
const UA_PRESETS = {
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
};

// Small LRU response cache so back / reload / re-opened tabs are instant instead of
// re-fetching the origin. Keyed by absolute target URL. HTML + text only, short TTL.
const CACHE_TTL_MS = 45_000;
const CACHE_MAX = 48;
const CACHE_MAX_ENTRY_BYTES = 3 * 1024 * 1024;
const cache = new Map(); // url -> { exp, out }
function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (hit.exp <= Date.now()) { cache.delete(url); return null; }
  cache.delete(url); cache.set(url, hit); // LRU touch
  return hit.out;
}
function cacheSet(url, out) {
  const len = out && out.body ? Buffer.byteLength(out.body) : 0;
  if (!len || len > CACHE_MAX_ENTRY_BYTES) return;
  cache.set(url, { exp: Date.now() + CACHE_TTL_MS, out });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// The controller injected into every proxied HTML document. Runs in the opaque
// sandbox origin. `%REAL%` is replaced with the JSON-encoded final URL.
//
// PARENT-AUTHORITATIVE navigation: the controller never navigates itself and never
// tells the parent "my address is X". It only asks the parent to navigate ("navigate")
// and reports its title. The parent then re-fetches the requested URL through /proxy,
// so the address bar it shows ALWAYS equals the content it loaded — a malicious page
// cannot display attacker content under a spoofed address (no phishing), and the only
// attacker-controlled string that reaches the parent is `title`, which the parent
// renders as escaped text (never innerHTML) — so no path to the token/RPC.
const CONTROLLER = `<script>(function(){
  "use strict";
  var REAL=%REAL%;
  function abs(h){try{return new URL(h,REAL).href}catch(e){return null}}
  function ok(u){return u&&/^https?:/i.test(u)}
  function send(m){try{parent.postMessage(m,"*")}catch(e){}}
  function nav(u,newTab,gesture){if(ok(u))send({__cfhub:1,type:"navigate",url:u,newTab:!!newTab,gesture:!!gesture})}
  function loaded(){send({__cfhub:1,type:"loaded",title:(document.title||"").slice(0,300)})}
  if(document.readyState!=="loading")loaded();else document.addEventListener("DOMContentLoaded",loaded);
  window.addEventListener("load",loaded);

  // L1: JS-driven "open in new tab" — no allow-popups, so route it to the parent.
  try{
    window.open=function(u){nav(abs(u||""),true,false);return {closed:false,focus:function(){},blur:function(){},close:function(){},postMessage:function(){},location:{href:""}}};
  }catch(e){}

  function anchorNav(e,forceNew){
    if(e.defaultPrevented)return false;
    var a=e.target&&e.target.closest?e.target.closest("a[href],area[href]"):null;if(!a)return false;
    var href=a.getAttribute("href")||"";
    if(!href||href.charAt(0)==="#"||/^(javascript|mailto|tel|sms|data|blob):/i.test(href))return false;
    var u=abs(href);if(!ok(u))return false;
    e.preventDefault();
    // Only a REAL user gesture (⌘/Ctrl-click or middle-click) opens a new tab.
    // A bare target="_blank" navigates IN PLACE — this is what stops the tab storm.
    var isGesture=forceNew||e.metaKey||e.ctrlKey;
    nav(u, isGesture || a.target==="_blank", isGesture);
    return true;
  }
  // L2: left-click + middle-click(auxclick) both intercepted.
  document.addEventListener("click",function(e){if(e.button!==0)return;anchorNav(e,false)},true);
  document.addEventListener("auxclick",function(e){if(e.button===1)anchorNav(e,true)},true);

  document.addEventListener("submit",function(e){
    var f=e.target;if(!f||f.tagName!=="FORM")return;
    var method=(f.getAttribute("method")||"get").toLowerCase();
    var action=abs(f.getAttribute("action")||REAL);if(!ok(action))return;
    var newTab=f.target==="_blank";
    if(method==="get"){
      var qs="";try{qs=new URLSearchParams(new FormData(f)).toString()}catch(_){return}
      var base=action.split("#")[0];
      e.preventDefault();nav(base+(base.indexOf("?")>=0?"&":"?")+qs,newTab,newTab);return;
    }
    // L3: POST — we can't proxy a POST body through GET, but we MUST stop the iframe
    // self-navigating to a bare origin (blank pane). Take the user to the action page.
    e.preventDefault();nav(action.split("#")[0],newTab,newTab);
  },true);

  // L4 (partial): SPA client routing via History API — surface the new URL so the
  // address bar stays truthful; the parent re-fetches it as a real document.
  try{
    var _ps=history.pushState;
    history.pushState=function(s,t,u){var r=_ps.apply(this,arguments);if(u)nav(abs(u),false,false);return r};
  }catch(e){}
})();</script>`;

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// A dark, on-brand shell for non-HTML content and errors. The sandbox has no
// allow-popups, so target="_blank" is dead here — action links post to the parent
// instead: data-nav → parent re-fetches through /proxy, data-x → parent opens the
// real URL in the system browser. href stays for copy-link / visual affordance.
const SHELL_CONTROLLER = `<script>(function(){"use strict";
function send(m){try{parent.postMessage(m,"*")}catch(e){}}
document.addEventListener("click",function(e){
  var a=e.target&&e.target.closest?e.target.closest("[data-x],[data-nav]"):null;if(!a)return;
  e.preventDefault();
  if(a.hasAttribute("data-x"))send({__cfhub:1,type:"external",url:a.getAttribute("data-x")});
  else send({__cfhub:1,type:"navigate",url:a.getAttribute("data-nav")});
},true);
})();</script>`;
function shell(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#0a0a0f;color:#c9c9d4;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:48px 28px}h1{font-size:16px;color:#e6e6ef;font-weight:600;margin:0 0 6px}
.u{font-size:11px;color:#c56b7a;word-break:break-all;margin-bottom:20px}a{color:#6fb7d9;text-decoration:none;cursor:pointer}
.acts{display:flex;gap:10px;margin-top:22px}
.acts a{font-size:12px;padding:8px 16px;border:1px solid #2a2a36;border-radius:999px;color:#e6e6ef;background:#14141c}
.acts a:hover{border-color:#3a3a4a}
pre{white-space:pre-wrap;word-break:break-word;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#a7a7b6;background:#111117;border:1px solid #22222c;border-radius:10px;padding:16px}
img{max-width:100%;height:auto;border-radius:10px}</style></head><body><div class="wrap">${inner}</div>${SHELL_CONTROLLER}</body></html>`;
}

function errorPage(url, reason) {
  const nice = reason === 'blocked' ? 'This address is blocked (local or private network).'
    : reason === 'timeout' ? 'The site took too long to respond.'
    : reason === 'too-many-redirects' ? 'The site redirected too many times.'
    : reason && reason.startsWith('http-') ? 'The site returned ' + reason.slice(5) + ' — it may block embedded browsers.'
    : 'The page could not be loaded.';
  return shell('Could not load', `<h1>Couldn't load this page</h1><div class="u">${esc(url)}</div>
    <p>${esc(nice)}</p><div class="acts"><a data-nav="${esc(url)}">Try again</a><a data-x="${esc(url)}">Open in your browser ↗</a></div>`);
}

function binaryPage(url, ct) {
  return shell('File', `<h1>This is a file, not a web page</h1><div class="u">${esc(url)}</div>
    <p>Content type: ${esc(ct || 'unknown')}</p><div class="acts"><a data-x="${esc(url)}">Open / download in your browser ↗</a></div>`);
}

function textPage(url, text, ct) {
  return shell('Text', `<h1>${esc(ct || 'text')}</h1><div class="u">${esc(url)}</div><pre>${esc(text.slice(0, 200 * 1024))}</pre>`);
}

// Rewrite a fetched HTML document so it renders safely inside the sandbox.
function rewriteHtml(html, finalUrl) {
  let s = String(html || '');
  // drop the page's own base + framing/refresh directives; we set our own headers.
  s = s.replace(/<base\b[^>]*>/gi, '');
  s = s.replace(/<meta[^>]+http-equiv\s*=\s*["']?\s*(content-security-policy|refresh|x-frame-options)\s*["']?[^>]*>/gi, '');
  const inject =
    `<base href="${esc(finalUrl)}">` +
    `<meta name="referrer" content="no-referrer">` +
    CONTROLLER.replace('%REAL%', JSON.stringify(finalUrl).replace(/</g, '\\u003c'));
  if (/<head[^>]*>/i.test(s)) s = s.replace(/<head[^>]*>/i, (m) => m + inject);
  else if (/<html[^>]*>/i.test(s)) s = s.replace(/<html[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
  else s = '<head>' + inject + '</head>' + s;
  return s;
}

// render(url, { fresh, ua }) → { status, contentType, body (Buffer|string), binary? }
export async function render(rawUrl, { fresh = false, ua = '' } = {}) {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!/^https?:\/\//i.test(url)) return { status: 400, contentType: 'text/html; charset=utf-8', body: errorPage(url, 'bad') };

  const uaStr = UA_PRESETS[ua] || '';
  const ck = (ua || '') + '\n' + url;          // cache key is engine-scoped (same URL, different UA → different page)
  if (!fresh) { const c = cacheGet(ck); if (c) return c; }

  let r = await Web.fetchRaw(url, { maxBytes: MAX_HTML_BYTES, ua: uaStr });
  // network-level failure (timeout, DNS, SSRF block) → branded error page
  if (!r.ok && r.error) return { status: 200, contentType: 'text/html; charset=utf-8', body: errorPage(url, r.error) };
  // bot walls often gate on the engine — one silent retry as a different browser
  if (!r.ok && [403, 429, 503].includes(r.status)) {
    const alt = await Web.fetchRaw(url, { maxBytes: MAX_HTML_BYTES, ua: UA_PRESETS[ua === 'firefox' ? 'chrome' : 'firefox'] });
    if (alt.ok) r = alt;
  }

  const ct = (r.contentType || '').toLowerCase();
  const finalUrl = r.finalUrl || url;
  const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
  // non-2xx WITHOUT a renderable HTML body → error page. A 404/403 that ships a real
  // HTML page renders like in any browser (falls through).
  if (!r.ok && !(isHtml && r.body && r.body.length)) {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: errorPage(url, r.error || ('http-' + r.status)) };
  }

  let out;
  if (isHtml) {
    out = { status: 200, contentType: 'text/html; charset=utf-8', body: rewriteHtml(r.body.toString('utf8'), finalUrl) };
  } else if (ct.startsWith('image/')) {
    out = { status: 200, contentType: r.contentType, body: r.body, binary: true };
  } else if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct.includes('javascript')) {
    out = { status: 200, contentType: 'text/html; charset=utf-8', body: textPage(finalUrl, r.body.toString('utf8'), r.contentType) };
  } else {
    out = { status: 200, contentType: 'text/html; charset=utf-8', body: binaryPage(finalUrl, r.contentType) };
  }
  // cache clean 2xx documents only — the URL the user asked for AND (cheaply) the
  // final URL after redirects, both engine-scoped
  if (r.ok) {
    cacheSet(ck, out);
    if (finalUrl !== url) cacheSet((ua || '') + '\n' + finalUrl, out);
  }
  return out;
}

export const Proxy = { render };
export default Proxy;
