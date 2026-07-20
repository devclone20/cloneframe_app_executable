// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — DAV Platform Port (WebDAV/CalDAV/CardDAV primitives)
//
// A deep, zero-dependency module extracted from the two hand-rolled DAV forks
// living in bridge/calendar.mjs (CalDAV) and bridge/contacts.mjs (CardDAV).
// Both forks re-implement the same five primitives — line unfolding, property-
// line splitting, XML entity decoding, Basic auth headers, and a fetch wrapper
// around the global `fetch` — with small, accidental divergences. This module
// is the single, unified superset both callers can adopt without behavior
// change:
//
//   • calendar.mjs's `davFetch` ALWAYS applies a 15s AbortSignal.timeout.
//   • contacts.mjs's inline REPORT fetch (in carddavSync) has NO timeout at
//     all — a dead/unreachable CardDAV host hangs the calling request
//     indefinitely. `davFetch` here always applies a timeout (default 15s,
//     override via `timeout`), closing that gap for every caller.
//   • calendar.mjs's `decodeXMLEntities` decodes numeric character refs
//     (`&#65;`); contacts.mjs's twin does not. This port decodes both decimal
//     and hex numeric refs (`&#65;` and `&#x41;`) plus the five XML named
//     entities — a strict superset of both.
//   • calendar.mjs's multistatus parser only ever looks for `calendar-data`;
//     contacts.mjs's only ever looks for `address-data`. `parseMultistatus`
//     here takes the element name(s) to look for, so it serves both CalDAV
//     and CardDAV (and any future DAV report) without forking the regex.
//
// This module is intentionally *transport-only*: it has no persistence, no
// domain shape (VEVENT/VCARD), and no policy about retries or caching. Those
// stay in calendar.mjs / contacts.mjs. That keeps the interface small:
// davFetch + 4 parsing primitives, each doing exactly one thing.
//
// Zero npm dependencies — Node 18+ built-ins only (global fetch, AbortSignal,
// Buffer). No functions here touch the filesystem, so there is nothing to
// secure with file permissions; credentials passed in `creds` are used only
// to compute a Basic auth header for the single outgoing request and are
// never logged, cached, or written anywhere by this module.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;

// ── line unfolding (RFC 5545 §3.1 / RFC 6350 — shared by iCalendar & vCard) ──
// A line that starts with a single space or tab is a continuation of the
// previous line (the leading whitespace itself is dropped). Identical in both
// forks; lifted verbatim.
export function unfoldLines(text) {
  const raw = String(text).split(/\r\n|\r|\n/);
  const lines = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

// ── property-line splitting (iCalendar / vCard "NAME;PARAM=x:value") ────────
// Returns null for a line with no ':' (blank/garbage lines inside a block).
// `name` is upper-cased for case-insensitive matching by callers.
export function splitPropertyLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const [name, ...params] = head.split(';');
  return { name: name.toUpperCase(), params, value };
}

// ── XML entity decoding (superset of both forks) ────────────────────────────
// Decodes the 5 predefined XML entities plus decimal (&#65;) and hex
// (&#x41;) numeric character references. `&amp;` is decoded LAST so an
// entity that itself decodes to "&lt;" etc. is never double-unescaped.
export function decodeXMLEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

// ── Basic auth (RFC 7617) ────────────────────────────────────────────────────
// Always returns a well-formed header, even for empty/missing creds (mirrors
// calendar.mjs's unconditional builder). Callers decide *whether* to attach
// it — see davFetch below, which is the superset of both forks' conditions.
export function authHeader(creds = {}) {
  const user = (creds && creds.user) || '';
  const pass = (creds && creds.pass) || '';
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

// ── fetch error → human string (used by callers around davFetch's throws) ──
// davFetch never swallows a failure — it throws like `fetch` does. This is a
// convenience the callers can use in their own catch blocks (lifted from
// calendar.mjs, generalized off any DOMException/AbortError name).
export function describeFetchError(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'request timed out';
  const cause = e && e.cause;
  if (cause && cause.code) return `${cause.code}: ${cause.message || e.message}`;
  return (e && e.message) || String(e);
}

// ── the fetch wrapper itself ─────────────────────────────────────────────────
/**
 * A single DAV HTTP request over the global `fetch`. ALWAYS applies a
 * timeout — this is the fix for contacts.carddavSync hanging forever against
 * a dead/unreachable host (its inline fetch had no AbortSignal at all).
 *
 * Attaches `Authorization: Basic ...` whenever `creds.user` or `creds.pass`
 * is truthy (the superset of calendar.mjs's `creds.user || creds.pass` check
 * and contacts.mjs's narrower `user`-only check). Sets the `Depth` header
 * when `depth` is given (0/1/infinity, per RFC 4918). Follows redirects, like
 * both forks.
 *
 * Never swallows failure: network errors, timeouts, and non-2xx/207 statuses
 * are the caller's problem to interpret (non-2xx responses resolve normally —
 * only transport-level failures reject, exactly like `fetch`).
 *
 * @param {object} args
 * @param {string} args.url
 * @param {string} [args.method='GET']
 * @param {{user?:string, pass?:string}} [args.creds]
 * @param {number} [args.timeout=15000] milliseconds; always applied
 * @param {BodyInit} [args.body]
 * @param {0|1|'infinity'|number} [args.depth] sets the Depth header when given
 * @param {Record<string,string>} [args.headers] extra/override headers
 * @returns {Promise<Response>}
 */
export async function davFetch({ url, method = 'GET', creds, timeout, body, depth, headers = {} } = {}) {
  if (!url || typeof url !== 'string') throw new TypeError('davFetch: url is required');

  const h = { ...headers };
  if (depth !== undefined && depth !== null) h.Depth = String(depth);
  if (creds && (creds.user || creds.pass)) h.Authorization = authHeader(creds);

  const ms = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;

  return fetch(url, {
    method,
    headers: h,
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(ms),
  });
}

// ── multistatus (WebDAV RFC 4918 §13) parsing ────────────────────────────────
const HREF_RE = /<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i;

function dataTagRegex(tag) {
  // tag names in DAV multistatus bodies are simple tokens (calendar-data,
  // address-data, ...) — no need for a more permissive/unsafe pattern.
  return new RegExp(`<(?:[\\w-]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i');
}

function absolutize(href, base) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

/**
 * Splits a DAV multistatus (207) XML body into per-<response> entries and
 * pulls the <href> and a named data element out of each, tolerating any XML
 * namespace prefix (D:/d:/C:/c:/none) — exactly as both forks already did,
 * just parameterized on which data element to look for so one parser serves
 * CalDAV (`dataTag: 'calendar-data'`) and CardDAV (`dataTag: 'address-data'`)
 * alike.
 *
 * A <response> chunk with no matching data element is skipped (e.g. a
 * collection's own PROPFIND self-entry, or an addressbook entry with no
 * address-data because of a 404 propstat — same tolerance both forks had).
 *
 * @param {string} xml
 * @param {object} [opts]
 * @param {string} [opts.dataTag='calendar-data'] element name to extract (no namespace prefix)
 * @param {string} [opts.baseUrl] when given, hrefs are resolved against it
 * @returns {Array<{href:string, data:string}>} data is XML-entity-decoded; href is absolutized when baseUrl is given
 */
export function parseMultistatus(xml, { dataTag = 'calendar-data', baseUrl } = {}) {
  const dataRe = dataTagRegex(dataTag);
  const chunks = String(xml).split(/<\/(?:[\w-]+:)?response>/i);
  const out = [];
  for (const chunk of chunks) {
    const dataM = chunk.match(dataRe);
    if (!dataM) continue;
    const hrefM = chunk.match(HREF_RE);
    let href = hrefM ? decodeXMLEntities(hrefM[1].trim()) : '';
    if (href && baseUrl) href = absolutize(href, baseUrl);
    out.push({ href, data: decodeXMLEntities(dataM[1]) });
  }
  return out;
}

export const Dav = {
  davFetch,
  parseMultistatus,
  unfoldLines,
  splitPropertyLine,
  decodeXMLEntities,
  authHeader,
  describeFetchError,
};

export default Dav;
