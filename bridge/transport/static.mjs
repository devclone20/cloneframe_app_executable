// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — transport/static  (L3 router-tail)
//
// Static app serving, extracted from hub-bridge.mjs so the router keeps only
// transport wiring + security + dispatch. Serves the built single-file document
// (dist/index.html) when it exists, else the hand-authored monolith, so the app
// is always launchable even with no build tools (T-005).
//
// SECURITY (unchanged, moved verbatim): path-traversal (\0, ..), dotfiles, and the
// /bridge source dir are refused. The pairing token is injected ONLY on a REAL
// top-level navigation (sec-fetch-dest:'document') — a malicious page's fetch()
// sends dest:'empty' and cannot forge 'document', so it can never scrape the token,
// and a non-browser client (curl by another local user) is denied the inject too.
//
// Pure: deps (root/host/port/token) are injected; no module state. Node built-ins only.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

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
    // auto-pair ONLY on a real top-level navigation — a malicious page's fetch()
    // has sec-fetch-dest:empty and cannot forge 'document', so it can't scrape the token.
    const dest = req.headers['sec-fetch-dest'];
    // Only inject the token on a REAL top-level browser navigation. The Chrome --app
    // window always sends dest:'document'; a non-browser client (curl run by ANOTHER
    // local user) sends undefined — denying it there stops cross-user token theft.
    const isNav = dest === 'document';
    let html = data.toString('utf8');
    if (isNav) {
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
