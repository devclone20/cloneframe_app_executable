// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — transport/static  (L3 router-tail)
//
// Static app serving, extracted from hub-bridge.mjs so the router keeps only
// transport wiring + security + dispatch. Serves the built single-file document
// (dist/index.html) when it exists, else the hand-authored monolith, so the app
// is always launchable even with no build tools (T-005).
//
// SECURITY: path-traversal (\0, ..), dotfiles, and the /bridge source dir are refused.
//
// AUTO-PAIR — read this before touching it. This route is deliberately token-less, so
// whatever decides to embed the pairing token in the HTML is the ONLY thing standing
// between an unauthenticated local socket and POST /shell. It used to be a single header:
//
//     const isNav = req.headers['sec-fetch-dest'] === 'document';
//
// Sec-Fetch-* is a forbidden header name FOR BROWSERS — page JavaScript cannot set it, so
// the guard holds against a malicious web page. It does nothing against a program:
//
//     curl -H 'Sec-Fetch-Dest: document' http://127.0.0.1:8765/     → token in the body
//     curl -X POST /shell -H "authorization: Bearer <token>" -d …   → arbitrary code
//
// Measured, end to end, on 2026-07-26. Anyone able to open a loopback socket — another
// local user who cannot read the 0600 token file, a sandboxed process, an npm
// postinstall — got the owner's machine. Note the boundary this protects: a process
// running AS the owner can read ~/.clone-frame-hub/bridge.token directly and never needed
// this route. The one it defends is the CROSS-USER case, and that is the one it lost.
//
// Now it takes the whole fingerprint of a real top-level, user-initiated navigation, and
// it fires ONCE per bridge start inside a short window after launch — the launcher opens
// the window immediately, so a legitimate pair always lands in it. An attacker must now
// forge four headers AND win a race against the owner's own browser, once, in that window;
// if they win, the owner's window visibly fails to pair instead of silently sharing.
// That is a much smaller hole, not a closed one: the honest fix is to stop putting the
// token in the page at all, which needs the launcher to change too. Documented, not hidden.
//
// Pure apart from the one-shot latch: deps (root/host/port/token) are injected.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

// One-shot auto-pair latch. Armed at start for the launcher's window, and re-armed by
// armPairing() — which hub-bridge calls from the TOKEN-GATED /pair route, so a client that
// already holds the token can open another window and have it pair. A cold attacker cannot
// re-arm: authenticating is the whole thing they do not have.
const PAIR_WINDOW_MS = Number(process.env.CFHUB_PAIR_WINDOW_MS || 120000);
let armedAt = Date.now();
let pairSpent = false;
export function armPairing() { armedAt = Date.now(); pairSpent = false; }
// A real top-level navigation the user initiated: Chrome/Safari/Firefox all send this
// exact combination. fetch() sends dest:'empty', an <iframe> sends dest:'iframe', and a
// programmatic window.open sends site:'cross-site' without user:'?1'.
function isUserNavigation(req) {
  const h = req.headers;
  return h['sec-fetch-dest'] === 'document'
      && h['sec-fetch-mode'] === 'navigate'
      && h['sec-fetch-site'] === 'none'
      && h['sec-fetch-user'] === '?1'
      && String(h.accept || '').includes('text/html');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8' };

// serveStatic(req, res, pathname, {root, host, port, token}) -> boolean
// Returns true if it handled the request (served bytes or a 404); false if the
// caller should fall through to other routes.
export function serveStatic(req, res, pathname, { root, host, port, token }) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.includes('..')) return false;
  // Serve the built single-file document (dist/index.html) when it exists; fall back to the
  // hand-authored monolith so the app is always launchable, even with no build tools (T-005).
  let file;
  if (rel === '/index.html') {
    const dist = path.join(root, 'dist', 'index.html');
    file = fs.existsSync(dist) ? dist : path.join(root, 'index.html');
  } else {
    file = path.join(root, rel);
  }
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  // never expose dotfiles or the bridge source dir
  const isHead = req.method === 'HEAD';
  if (/(^|\/)\.[^/]/.test(rel) || rel === '/bridge' || rel.startsWith('/bridge/')) { res.writeHead(404); res.end(isHead ? undefined : 'not found'); return true; }
  let data;
  try { if (fs.statSync(file).isDirectory()) return false; data = fs.readFileSync(file); }
  catch { return false; }
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') {
    // Auto-pair: full navigation fingerprint, once per bridge start, inside the launch
    // window. See the header comment for what this replaced and why.
    const isNav = !pairSpent
      && (Date.now() - armedAt) < PAIR_WINDOW_MS
      && isUserNavigation(req);
    let html = data.toString('utf8');
    if (isNav) {
      pairSpent = true;
      // Call-back origin = the address the browser actually opened (its Host header, already
      // validated as loopback:port by localOnly upstream) — NOT the bind address, which is
      // 0.0.0.0 in container mode and uncontactable from a browser. Fall back to a loopback.
      const back = /:\d+$/.test(req.headers.host || '') ? req.headers.host
                 : `${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`;
      const inject = `<script>window.__CFHUB_BRIDGE__=${JSON.stringify({ endpoint: `http://${back}`, token })};</script>`;
      html = html.includes('<head>') ? html.replace('<head>', '<head>' + inject) : inject + html;
    }
    data = Buffer.from(html, 'utf8');
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': data.length });
  res.end(isHead ? undefined : data); // HEAD: headers only, no body
  return true;
}

export default { serveStatic };
