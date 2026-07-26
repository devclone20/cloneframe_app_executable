// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — web fetch + lightweight search (zero deps)
// Powers Deep Research (real sources) and the agent's "web.fetch" tool.
// Stateless, read-only, no persistence. Node built-ins only (global fetch).
// ─────────────────────────────────────────────────────────────────────────────
import dns from 'node:dns/promises';

// Short-TTL positive DNS cache shared by the SSRF pre-check — avoids the double-DNS
// per hop (the guard looked up the host, then fetch() looked it up again).
// (undici keep-alive is on by default in Node ≥18, so no explicit Agent needed.)
const DNS_TTL_MS = 60_000;
const dnsCache = new Map(); // host -> { addrs, exp }
async function cachedLookup(host) {
  const hit = dnsCache.get(host);
  if (hit && hit.exp > Date.now()) return hit.addrs;
  const addrs = await dns.lookup(host, { all: true });
  dnsCache.set(host, { addrs, exp: Date.now() + DNS_TTL_MS });
  if (dnsCache.size > 512) dnsCache.delete(dnsCache.keys().next().value);
  return addrs;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // cap raw body read
const MAX_TEXT_CHARS = 20 * 1024; // cap extracted text returned to callers
const MAX_REDIRECTS = 20; // browser parity (Chrome: 20) — login flows chain many hops; SSRF guard re-checks EVERY hop
const BLOCKED_CONTENT_TYPE = /^(image|audio|video)\/|application\/(octet-stream|pdf|zip|x-)/i;

// ── SSRF guard ──────────────────────────────────────────────────────────────

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 127 || a === 10 || a === 0) return true; // loopback / private / "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10 (Alibaba metadata lives here)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + 255.255.255.255
  return false;
}

// Expand any IPv6 literal (compressed, or with a trailing embedded IPv4) to 8 hextets.
function expandIPv6(ip) {
  let s = String(ip || '').toLowerCase();
  const m = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/); // trailing dotted IPv4 → two hextets
  if (m) {
    const v4 = m[2].split('.').map(Number);
    if (v4.some((n) => n > 255)) return null;
    s = m[1] + (((v4[0] << 8) | v4[1]).toString(16)) + ':' + (((v4[2] << 8) | v4[3]).toString(16));
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 ? (dbl[1] ? dbl[1].split(':') : []) : null;
  let groups;
  if (tail === null) groups = head;
  else { const fill = 8 - head.length - tail.length; if (fill < 0) return null; groups = [...head, ...Array(fill).fill('0'), ...tail]; }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  if (out.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return out;
}

function isPrivateIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) { // parsing failed → conservative prefix fallback
    const low = String(ip || '').toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd');
  }
  const [a, , , , e, f, gg, h] = g;
  if (g.every((x, i) => x === 0 || (i === 7 && x === 1))) return true; // :: (unspecified) and ::1 (loopback)
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((a & 0xff00) === 0xff00) return true; // multicast ff00::/8
  const embeddedV4 = [(gg >> 8) & 0xff, gg & 0xff, (h >> 8) & 0xff, h & 0xff].join('.');
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && e === 0 && f === 0xffff) return isPrivateIPv4(embeddedV4); // ::ffff:x.x.x.x (v4-mapped)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && e === 0 && f === 0 && (gg || h)) return isPrivateIPv4(embeddedV4); // ::x.x.x.x (v4-compatible)
  if (a === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && e === 0 && f === 0) return isPrivateIPv4(embeddedV4); // NAT64 64:ff9b::/96
  return false;
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);
  if (host.includes(':')) return isPrivateIPv6(host);
  return false;
}

async function resolvesToPrivate(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false; // literal, already checked
  try {
    const addrs = await cachedLookup(host);
    return addrs.some((a) => (a.family === 6 ? isPrivateIPv6(a.address) : isPrivateIPv4(a.address)));
  } catch {
    return false; // let the fetch itself fail naturally
  }
}

async function assertSafeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('blocked');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('blocked');
  if (isBlockedHost(u.hostname)) throw new Error('blocked');
  if (await resolvesToPrivate(u.hostname)) throw new Error('blocked');
  return u;
}

// ── low-level fetch helpers ─────────────────────────────────────────────────

async function readCapped(stream, capBytes) {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > capBytes) {
        const keep = capBytes - (total - value.length);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function readCappedBytes(stream, capBytes) {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > capBytes) {
        const keep = capBytes - (total - value.length);
        if (keep > 0) chunks.push(Buffer.from(value.subarray(0, keep)));
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks);
}

// ── session cookie jar (memory-only) ─────────────────────────────────────────
// Many sites set a cookie then redirect (consent walls, load balancers, region
// pickers); without echoing it back the destination bounces to the start and the
// page "never opens". This jar lives ONLY in bridge memory — never on disk, never
// exposed over RPC, wiped on restart — and is TTL'd + capped. HttpOnly/Secure/Path
// semantics don't apply: the bridge IS the HTTP client and page JS runs in an
// opaque sandbox with no cookie access.
const COOKIE_TTL_MS = 30 * 60_000;
const COOKIE_MAX_DOMAINS = 200;
const COOKIE_MAX_PER_DOMAIN = 30;
const cookieJar = new Map(); // registrable domain -> Map(name -> { value, exp })
function cookieDomain(host, attr) {
  const h = String(host || '').toLowerCase();
  const d = String(attr || '').toLowerCase().replace(/^\./, '');
  return d && (h === d || h.endsWith('.' + d)) ? d : h; // reject foreign Domain= attrs
}
function cookieStore(host, setCookies) {
  for (const line of setCookies || []) {
    const parts = String(line).split(';');
    const eq = parts[0].indexOf('=');
    if (eq <= 0) continue;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    if (!name || name.length + value.length > 4096) continue;
    let domAttr = '', maxAge = null, expires = null;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim(), pl = p.toLowerCase();
      if (pl.startsWith('domain=')) domAttr = p.slice(7).trim();
      else if (pl.startsWith('max-age=')) maxAge = Number(p.slice(8));
      else if (pl.startsWith('expires=')) expires = Date.parse(p.slice(8));
    }
    const dom = cookieDomain(host, domAttr);
    let exp = Date.now() + COOKIE_TTL_MS;
    if (Number.isFinite(maxAge)) exp = Math.min(exp, Date.now() + maxAge * 1000);
    else if (Number.isFinite(expires)) exp = Math.min(exp, expires);
    if (exp <= Date.now()) { const m = cookieJar.get(dom); if (m) m.delete(name); continue; }
    let m = cookieJar.get(dom);
    if (!m) { m = new Map(); cookieJar.set(dom, m); if (cookieJar.size > COOKIE_MAX_DOMAINS) cookieJar.delete(cookieJar.keys().next().value); }
    m.set(name, { value, exp });
    if (m.size > COOKIE_MAX_PER_DOMAIN) m.delete(m.keys().next().value);
  }
}
function cookieHeader(host) {
  const h = String(host || '').toLowerCase(), out = [], now = Date.now();
  for (const [dom, m] of cookieJar) {
    if (h !== dom && !h.endsWith('.' + dom)) continue;
    for (const [name, c] of m) {
      if (c.exp <= now) { m.delete(name); continue; }
      out.push(name + '=' + c.value);
    }
  }
  return out.join('; ');
}

// Fetches a caller-supplied URL, re-validating the SSRF guard on every hop of
// a manual redirect chain (fetch's built-in "follow" cannot be inspected).
async function safeFetchFollow(url, headers) {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const target = await assertSafeUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const h = { ...headers };
    const ck = cookieHeader(target.hostname);
    if (ck) h.cookie = ck;
    let res;
    try {
      res = await fetch(current, { signal: controller.signal, redirect: 'manual', headers: h });
    } finally {
      clearTimeout(timer);
    }
    try {
      const sc = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      cookieStore(target.hostname, sc);
    } catch {}
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('too-many-redirects');
}

// ── HTML → text ──────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', middot: '·',
};

function safeCodePoint(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

function decodeEntities(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function cleanInline(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = cleanInline(m[1]);
  return t || undefined;
}

function htmlToText(html) {
  if (!html) return '';
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<(br|p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n *(\n *)*/g, '\n\n');
  return s.trim();
}

// ── public: fetchUrl ─────────────────────────────────────────────────────

export async function fetchUrl(url) {
  try {
    if (typeof url !== 'string' || !url.trim()) return { ok: false, url, error: 'invalid-url' };

    let res;
    try {
      res = await safeFetchFollow(url, { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' });
    } catch (err) {
      if (err?.message === 'blocked') return { ok: false, url, error: 'blocked' };
      throw err;
    }

    if (!res.ok) return { ok: false, url: res.url || url, error: `http-${res.status}` };

    const ct = res.headers.get('content-type') || '';
    if (BLOCKED_CONTENT_TYPE.test(ct)) return { ok: false, url: res.url || url, error: 'unsupported-content-type' };

    const html = await readCapped(res.body, MAX_BODY_BYTES);
    const title = extractTitle(html);
    const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);
    return { ok: true, url: res.url || url, title, text };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { ok: false, url, error: timedOut ? 'timeout' : String(err?.message || err) };
  }
}

// ── public: search ───────────────────────────────────────────────────────
// Delegates to the web ENGINE (bridge/webengine.mjs): the owner's real Chrome
// asks Google and reads the results off the DOM. The DuckDuckGo HTML scrape
// that used to live here is gone — it rotted with DDG's markup, and the owner
// asked for it to be removed. Same public contract: {ok, results:[{title,url,snippet}]}.

export async function search(query, { limit = 6 } = {}) {
  try {
    if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [], error: 'invalid-query' };
    const { Webengine } = await import('./webengine.mjs');
    return await Webengine.search({ q: query, limit });
  } catch (err) {
    return { ok: false, results: [], error: String(err?.message || err) };
  }
}

// ── public: research ─────────────────────────────────────────────────────

export async function research(question, { maxSources = 4 } = {}) {
  try {
    if (typeof question !== 'string' || !question.trim()) return { ok: false, sources: [], error: 'invalid-question' };
    const n = Math.max(1, Math.min(10, Number(maxSources) || 4));

    const found = await search(question, { limit: n * 2 });
    if (!found.ok || !found.results.length) return { ok: false, sources: [], error: found.error || 'no-results' };

    const sources = [];
    for (const r of found.results) {
      if (sources.length >= n) break;
      const page = await fetchUrl(r.url);
      if (page.ok && page.text) sources.push({ title: page.title || r.title, url: page.url, text: page.text });
    }

    if (!sources.length) return { ok: false, sources: [], error: 'no-fetchable-sources' };
    return { ok: true, sources };
  } catch (err) {
    return { ok: false, sources: [], error: String(err?.message || err) };
  }
}

// ── public: fetchRaw ───────────────────────────────────────────────────────
// SSRF-guarded raw fetch (bytes + headers) for the in-app browser proxy. Re-checks
// the guard on every redirect hop; returns the final URL and content-type so the
// proxy can rewrite HTML and pass other content types through. Never touches disk.
export async function fetchRaw(url, { maxBytes = 4 * 1024 * 1024, ua } = {}) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u) return { ok: false, error: 'invalid-url' };
  let res;
  try {
    res = await safeFetchFollow(u, {
      'user-agent': ua || UA,   // browser-engine picker (Safari/Chrome/Firefox) sends its own UA
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/*;q=0.8,*/*;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      // real top-level navigations carry these; their absence is a common bot signal
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
    });
  } catch (err) {
    if (err?.message === 'blocked') return { ok: false, error: 'blocked' };
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  }
  const contentType = res.headers.get('content-type') || '';
  let body;
  try { body = await readCappedBytes(res.body, maxBytes); }
  catch (err) { return { ok: false, error: String(err?.message || err) }; }
  return { ok: res.ok, status: res.status, finalUrl: res.url || u, contentType, body };
}

// ── public: frameable ────────────────────────────────────────────────────────
// Lightweight header probe for the in-app browser's hybrid loader: may this REMOTE
// url be embedded directly in our <iframe>? Inspects X-Frame-Options and CSP
// frame-ancestors on the FINAL (post-redirect) response; never reads the body.
// SSRF-guarded per hop (reuses safeFetchFollow). Result is short-cached.
const FRAME_TTL_OK = 10 * 60_000;  // frameable: stable, cache longer
const FRAME_TTL_NO = 5 * 60_000;   // not-frameable / error: shorter
const FRAME_MAX = 256;
const frameCache = new Map();      // key -> { exp, val }
function frameKey(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u || ''); } }
function frameGet(k) { const h = frameCache.get(k); if (!h) return null; if (h.exp <= Date.now()) { frameCache.delete(k); return null; } return h.val; }
function frameSet(k, val, ttl) { frameCache.set(k, { exp: Date.now() + ttl, val }); while (frameCache.size > FRAME_MAX) frameCache.delete(frameCache.keys().next().value); }
function blocksFraming(headers) {
  const xfo = (headers.get('x-frame-options') || '').toLowerCase();
  if (xfo && (xfo.includes('deny') || xfo.includes('sameorigin') || xfo.includes('allow-from'))) return true;
  const csp = headers.get('content-security-policy') || '';
  if (csp) {
    const m = /frame-ancestors([^;]*)/i.exec(csp);
    if (m) {
      const val = m[1].trim().toLowerCase();
      if (val === '' || val === "'none'") return true;   // frame-ancestors 'none' → nobody may frame
      if (!/\*/.test(val)) return true;                  // a specific allow-list we can't be part of
    }
  }
  return false;
}
export async function frameable(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!/^https?:\/\//i.test(u)) return { ok: false, frameable: false, reason: 'bad-url' };
  const key = frameKey(u);
  const cached = frameGet(key);
  if (cached) return cached;
  let res;
  try {
    res = await safeFetchFollow(u, {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site',
    });
  } catch (err) {
    const reason = err?.message === 'blocked' ? 'blocked' : (err?.name === 'AbortError' ? 'timeout' : String(err?.message || err));
    const val = { ok: false, frameable: false, reason };
    frameSet(key, val, FRAME_TTL_NO);
    return val;
  }
  try { res.body?.cancel?.(); } catch {}   // headers only — never read the body
  const val = { ok: true, frameable: !blocksFraming(res.headers), finalUrl: res.url || u, status: res.status };
  frameSet(key, val, val.frameable ? FRAME_TTL_OK : FRAME_TTL_NO);
  return val;
}

// `frameable` (iframe-embeddability probe) is retired: the in-app browser is now a
// real CDP engine, not an iframe, so nothing probes framing anymore. fetchUrl/search/
// fetchRaw stay — they back the agent's web_search / fetch_content.
export const Web = { fetchUrl, search, research, fetchRaw };
export default Web;
