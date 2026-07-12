// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Calendar Engine (CalDAV)
//
// A real CalDAV client for the HUB's Settings → Calendar. Connects to a single
// calendar collection (url, user, pass), lists VEVENTs in a date range via a
// REPORT calendar-query, creates events with a hand-built minimal iCalendar
// PUT, and deletes them by href. Zero npm dependencies — uses the global
// `fetch` (undici, built into Node) for HTTP and hand-rolled scanners for the
// multistatus XML and the iCalendar VEVENT bodies (no `ical`/`xml2js`).
//
// Security: the connection credentials (url + user + pass) live ONLY in a
// separate 0600 file (calendar.secret.json) and are NEVER returned from any
// method — status() exposes the url and nothing else. The main store
// (calendar.json, 0600, in a 0700 dir) holds only the non-secret connection
// url and a local event cache. Nothing is ever logged.
//
// Every write-path method returns {ok, ...} and never throws for expected
// failures. Read-path methods (status/events/upcoming) degrade to an empty /
// disconnected result on any store, network, or parse failure — never throw.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

// ── persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const STORE_FILE = path.join(CONFIG_DIR, 'calendar.json');       // non-secret: connection url + event cache
const SECRET_FILE = path.join(CONFIG_DIR, 'calendar.secret.json'); // creds only, never returned

const HTTP_TIMEOUT_MS = 15_000;
const MAX_CACHE = 2_000;                 // cap the local event cache (keep most-recently-seen)
const DEFAULT_PAST_MS = 7 * 24 * 3_600_000;
const DEFAULT_FUTURE_MS = 60 * 24 * 3_600_000;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on shared/odd filesystems */ }
}

function loadStore() {
  ensureConfigDir();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      connection: data.connection && typeof data.connection === 'object' ? data.connection : null,
      events: Array.isArray(data.events) ? data.events : [],
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { connection: null, events: [] };
    // A corrupt store must never crash the app — start from an empty state.
    return { connection: null, events: [] };
  }
}

function saveStore(store) {
  ensureConfigDir();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ connection: store.connection, events: store.events }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* best effort */ }
}

// Read-path helper: persisting the refreshed cache must never make a read throw.
function saveStoreSafe(store) {
  try { saveStore(store); } catch { /* the returned value is still correct even if the cache write fails */ }
}

// The credentials live in their own file so they can never ride along in the
// main store (which is read back and reshaped into public event objects).
function loadSecret() {
  ensureConfigDir();
  try {
    const data = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
    if (data && typeof data.url === 'string') {
      return { url: data.url, user: typeof data.user === 'string' ? data.user : '', pass: typeof data.pass === 'string' ? data.pass : '' };
    }
    return null;
  } catch {
    return null;
  }
}

function saveSecret(creds) {
  ensureConfigDir();
  const tmp = `${SECRET_FILE}.${process.pid}.tmp`;
  const payload = JSON.stringify({ url: creds.url, user: creds.user || '', pass: creds.pass || '' });
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, SECRET_FILE);
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch { /* best effort */ }
}

function clearSecret() {
  try { fs.rmSync(SECRET_FILE, { force: true }); } catch { /* already gone */ }
}

// ── date / iCalendar conversion ──────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');

function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t); }
  return null;
}

// Compact UTC form required by RFC 5545 for the wire: YYYYMMDDTHHMMSSZ.
function toICalUTC(d) {
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T`
    + `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

// Turns a user-supplied start/end into an iCalendar value. A bare YYYY-MM-DD
// becomes an all-day DATE value; anything else is normalized to a UTC instant.
function toICalValue(input) {
  if (input == null || input === '') return { ok: false, error: 'required' };
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return { ok: true, isDate: true, value: input.replace(/-/g, ''), iso: input };
  }
  const d = toDate(input);
  if (!d) return { ok: false, error: 'unparseable date/time' };
  return { ok: true, isDate: false, value: toICalUTC(d), iso: d.toISOString() };
}

// Parses an iCalendar DTSTART/DTEND property value into an ISO-ish string:
//   • VALUE=DATE / bare YYYYMMDD  → "YYYY-MM-DD"          (all-day)
//   • ...THHMMSSZ                 → "YYYY-MM-DDTHH:MM:SSZ"(UTC instant)
//   • ...THHMMSS (floating/TZID)  → "YYYY-MM-DDTHH:MM:SS" (naive wall time)
// A full IANA tz-database resolution is out of scope with zero deps, so a
// TZID-qualified local time is preserved as naive wall-clock rather than guessed.
function icalValueToIso(prop) {
  const v = (prop.value || '').trim();
  const isDate = prop.params.some((p) => /^VALUE=DATE$/i.test(p)) || /^\d{8}$/.test(v);
  if (isDate) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return v;
  const [, Y, Mo, D, H, Mi, S, z] = m;
  return `${Y}-${Mo}-${D}T${H}:${Mi}:${S}${z ? 'Z' : ''}`;
}

function isoMillis(iso) {
  if (!iso) return NaN;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : t;
}

// RFC 5545 DURATION (e.g. "PT1H30M", "P1D", "-PT15M") → end ISO, preserving the
// value-type (date-only / UTC / naive) of the start it is applied to.
function addDurationIso(startIso, dur) {
  const base = Date.parse(startIso);
  if (Number.isNaN(base)) return startIso;
  const m = String(dur).match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return startIso;
  const sign = m[1] === '-' ? -1 : 1;
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x) || 0);
  const ms = (((w * 7 + d) * 24 + h) * 60 + mi) * 60_000 + s * 1_000;
  const end = new Date(base + sign * ms);
  if (/^\d{4}-\d{2}-\d{2}$/.test(startIso)) return end.toISOString().slice(0, 10);
  if (/Z$/.test(startIso)) return end.toISOString();
  return end.toISOString().slice(0, 19);
}

// ── iCalendar text escaping / folding (RFC 5545 §3.1, §3.3.11) ───────────────
function icalEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function unescapeText(v) {
  return String(v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Content lines longer than 75 octets are folded with CRLF + a leading space.
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) { parts.push(rest.slice(0, 74)); rest = rest.slice(74); }
  if (rest) parts.push(rest);
  return parts.join('\r\n ');
}

function buildVEvent({ uid, summary, start, end, location }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CLONE FRAME//HUB Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICalUTC(new Date())}`,
    start.isDate ? `DTSTART;VALUE=DATE:${start.value}` : `DTSTART:${start.value}`,
    end.isDate ? `DTEND;VALUE=DATE:${end.value}` : `DTEND:${end.value}`,
    `SUMMARY:${icalEscape(summary)}`,
    ...(location ? [`LOCATION:${icalEscape(location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ── iCalendar / multistatus parsing (hand-rolled, no XML/ical deps) ──────────
function unfoldLines(text) {
  const raw = text.split(/\r\n|\r|\n/);
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

function splitPropertyLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const [name, ...params] = head.split(';');
  return { name: name.toUpperCase(), params, value };
}

function extractVEventBlocks(ical) {
  const blocks = [];
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let m;
  while ((m = re.exec(ical)) !== null) blocks.push(m[1]);
  return blocks;
}

function parseVEventBlock(block) {
  const lines = unfoldLines(block);
  let uid = '';
  let summary = '';
  let location = '';
  let start = null;
  let end = null;
  let duration = null;

  for (const line of lines) {
    const prop = splitPropertyLine(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': uid = prop.value.trim(); break;
      case 'SUMMARY': summary = unescapeText(prop.value); break;
      case 'LOCATION': location = unescapeText(prop.value); break;
      case 'DTSTART': start = icalValueToIso(prop); break;
      case 'DTEND': end = icalValueToIso(prop); break;
      case 'DURATION': duration = prop.value.trim(); break;
      default: break;
    }
  }

  if (!uid && !summary && !start) return null;
  if (!end) end = start && duration ? addDurationIso(start, duration) : start;
  return {
    uid: uid || `no-uid-${createHash('sha1').update(block).digest('hex').slice(0, 16)}`,
    summary,
    location,
    start,
    end,
  };
}

function decodeXMLEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

const HREF_RE = /<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i;
const CALDATA_RE = /<(?:[\w-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/i;

function absolutize(href, base) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

function childHref(collectionUrl, name) {
  const b = collectionUrl.endsWith('/') ? collectionUrl : `${collectionUrl}/`;
  try { return new URL(name, b).toString(); } catch { return b + name; }
}

// Splits a DAV multistatus body into <response> chunks and pulls the <href> +
// <calendar-data> out of each, tolerating any namespace prefix (D:/d:/none).
function parseMultistatus(xml, baseUrl) {
  const out = [];
  const chunks = xml.split(/<\/(?:[\w-]+:)?response>/i);
  for (const chunk of chunks) {
    const dataM = chunk.match(CALDATA_RE);
    if (!dataM) continue;
    const hrefM = chunk.match(HREF_RE);
    const href = hrefM ? decodeXMLEntities(hrefM[1].trim()) : '';
    const ical = decodeXMLEntities(dataM[1]);
    for (const veBlock of extractVEventBlocks(ical)) {
      const ev = parseVEventBlock(veBlock);
      if (!ev) continue;
      ev.href = href ? absolutize(href, baseUrl) : childHref(baseUrl, `${ev.uid}.ics`);
      out.push(ev);
    }
  }
  return out;
}

// ── public event shape / range helpers ───────────────────────────────────────
function toEvent(ev) {
  return {
    uid: ev.uid,
    summary: ev.summary || '',
    start: ev.start || null,
    end: ev.end || ev.start || null,
    location: ev.location || '',
    href: ev.href || '',
  };
}

function byStart(a, b) {
  const sa = isoMillis(a.start);
  const sb = isoMillis(b.start);
  if (Number.isNaN(sa) && Number.isNaN(sb)) return 0;
  if (Number.isNaN(sa)) return 1;
  if (Number.isNaN(sb)) return -1;
  return sa - sb;
}

function resolveRange(from, to) {
  const now = Date.now();
  const start = toDate(from) || new Date(now - DEFAULT_PAST_MS);
  const end = toDate(to) || new Date(now + DEFAULT_FUTURE_MS);
  return { start, end };
}

// An event is in range if [start,end) intersects the window. Events whose start
// is unparseable are kept (better to surface than to silently drop).
function overlaps(ev, range) {
  const s = isoMillis(ev.start);
  if (Number.isNaN(s)) return true;
  const e = isoMillis(ev.end);
  const endMs = Number.isNaN(e) ? s : e;
  return s < range.end.getTime() && endMs >= range.start.getTime();
}

function filterCache(events, range) {
  return events.map(toEvent).filter((ev) => overlaps(ev, range)).sort(byStart);
}

function cacheUpsert(store, events) {
  const byUid = new Map(store.events.map((e) => [e.uid, e]));
  for (const ev of events) byUid.set(ev.uid, toEvent(ev));
  let arr = [...byUid.values()];
  if (arr.length > MAX_CACHE) arr = arr.slice(arr.length - MAX_CACHE);
  store.events = arr;
}

// ── HTTP (CalDAV over global fetch) ──────────────────────────────────────────
function authHeader(creds) {
  return `Basic ${Buffer.from(`${creds.user || ''}:${creds.pass || ''}`, 'utf8').toString('base64')}`;
}

function describeFetchError(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'request timed out';
  const cause = e && e.cause;
  if (cause && cause.code) return `${cause.code}: ${cause.message || e.message}`;
  return (e && e.message) || String(e);
}

async function davFetch(url, { method, headers = {}, body, creds } = {}) {
  const h = { ...headers };
  if (creds && (creds.user || creds.pass)) h.Authorization = authHeader(creds);
  return fetch(url, { method, headers: h, body, redirect: 'follow', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>`;

function calendarQueryBody(range) {
  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${toICalUTC(range.start)}" end="${toICalUTC(range.end)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Connect a CalDAV calendar collection. Validates reachability + auth with a
 * Depth:0 PROPFIND, then persists the credentials (0600, separate file) and the
 * non-secret url. Never throws.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function connect({ url, user, pass } = {}) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'url is required' };
  const trimmed = url.trim();
  let parsed;
  try { parsed = new URL(trimmed); } catch { return { ok: false, error: 'url must be a valid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'url must be http(s)' };
  }

  const creds = { url: trimmed, user: user || '', pass: pass || '' };
  try {
    const res = await davFetch(trimmed, {
      method: 'PROPFIND',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      creds,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `authentication failed (HTTP ${res.status})` };
    }
    if (!res.ok && res.status !== 207) {
      return { ok: false, error: `unexpected response (HTTP ${res.status} ${res.statusText})` };
    }

    const store = loadStore();
    store.connection = { url: trimmed, connectedAt: Date.now() };
    saveSecret(creds);
    try {
      saveStore(store);
    } catch (e) {
      clearSecret(); // keep the two files consistent — don't leave orphaned creds
      return { ok: false, error: `failed to persist connection: ${e.message || e}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
}

/**
 * @returns {{connected:boolean, url?:string}} never exposes user/pass
 */
function status() {
  const store = loadStore();
  const creds = loadSecret();
  if (store.connection && store.connection.url && creds) {
    return { connected: true, url: store.connection.url };
  }
  return { connected: false };
}

/**
 * Forget the connection: remove the credential file and clear the cached
 * connection + events. Always resolves ok — disconnecting is a local operation.
 * @returns {{ok:boolean}}
 */
function disconnect() {
  clearSecret();
  try {
    const store = loadStore();
    store.connection = null;
    store.events = [];
    saveStore(store);
  } catch { /* the creds are already gone — that is what "disconnected" means */ }
  return { ok: true };
}

/**
 * List events overlapping [from, to]. Runs a live CalDAV REPORT, refreshes the
 * local cache, and returns the parsed events. On any network/parse failure it
 * degrades to the cached events in range. Not connected → []. Never throws.
 * @param {{from?:string|number, to?:string|number}} [args]
 * @returns {Promise<Array<{uid:string,summary:string,start:string|null,end:string|null,location:string,href:string}>>}
 */
async function events({ from, to } = {}) {
  const creds = loadSecret();
  const store = loadStore();
  if (!creds || !store.connection) return [];
  const range = resolveRange(from, to);

  try {
    const res = await davFetch(creds.url, {
      method: 'REPORT',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: calendarQueryBody(range),
      creds,
    });
    if (!res.ok && res.status !== 207) return filterCache(store.events, range);
    const xml = await res.text();
    const parsed = parseMultistatus(xml, creds.url);
    if (parsed.length > 0) {
      cacheUpsert(store, parsed);
      saveStoreSafe(store);
    }
    return parsed.map(toEvent).filter((ev) => overlaps(ev, range)).sort(byStart);
  } catch {
    return filterCache(store.events, range);
  }
}

/**
 * The next `limit` events from now (includes events currently in progress),
 * soonest first. Built on events(); falls back to cache when offline.
 * @param {{limit?:number}} [args]
 * @returns {Promise<Array<object>>}
 */
async function upcoming({ limit = 10 } = {}) {
  const n = Math.max(0, Math.min(Number(limit) || 10, 500));
  const now = Date.now();
  const evs = await events({ from: new Date(now).toISOString(), to: new Date(now + 365 * 24 * 3_600_000).toISOString() });
  return evs
    .filter((ev) => {
      const e = isoMillis(ev.end);
      const s = isoMillis(ev.start);
      const endMs = Number.isNaN(e) ? s : e;
      return Number.isNaN(endMs) || endMs >= now;
    })
    .sort(byStart)
    .slice(0, n);
}

/**
 * Create a VEVENT and PUT it to <collection>/<uid>.ics (If-None-Match: * so a
 * uuid collision can't overwrite). Not connected → {ok:false}. Never throws.
 * @param {{summary:string, start:string|number, end:string|number, location?:string}} args
 * @returns {Promise<{ok:boolean, uid?:string, error?:string}>}
 */
async function createEvent({ summary, start, end, location } = {}) {
  const creds = loadSecret();
  const store = loadStore();
  if (!creds || !store.connection) return { ok: false, error: 'not connected' };
  if (!summary || typeof summary !== 'string' || !summary.trim()) return { ok: false, error: 'summary is required' };

  const s = toICalValue(start);
  if (!s.ok) return { ok: false, error: `invalid start: ${s.error}` };
  const e = toICalValue(end);
  if (!e.ok) return { ok: false, error: `invalid end: ${e.error}` };
  const sMs = isoMillis(s.iso);
  const eMs = isoMillis(e.iso);
  if (!Number.isNaN(sMs) && !Number.isNaN(eMs) && eMs < sMs) {
    return { ok: false, error: 'end must not be before start' };
  }

  const uid = randomUUID();
  const href = childHref(creds.url, `${uid}.ics`);
  const ics = buildVEvent({ uid, summary: summary.trim(), start: s, end: e, location: location ? String(location) : '' });

  try {
    const res = await davFetch(href, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'If-None-Match': '*' },
      body: ics,
      creds,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `create failed (HTTP ${res.status} ${res.statusText})` };
    }
    cacheUpsert(store, [{
      uid,
      summary: summary.trim(),
      start: s.iso,
      end: e.iso,
      location: location ? String(location) : '',
      href,
    }]);
    saveStoreSafe(store);
    return { ok: true, uid };
  } catch (err) {
    return { ok: false, error: describeFetchError(err) };
  }
}

/**
 * Delete an event by uid. Uses the cached href when known, else derives
 * <collection>/<uid>.ics. A 404 is treated as success (idempotent). Never throws.
 * @param {string} uid
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function deleteEvent(uid) {
  const creds = loadSecret();
  const store = loadStore();
  if (!creds || !store.connection) return { ok: false, error: 'not connected' };
  if (!uid || typeof uid !== 'string') return { ok: false, error: 'uid is required' };

  const cached = store.events.find((ev) => ev.uid === uid);
  const href = cached && cached.href ? absolutize(cached.href, creds.url) : childHref(creds.url, `${uid}.ics`);

  try {
    const res = await davFetch(href, { method: 'DELETE', creds });
    if ((res.status >= 200 && res.status < 300) || res.status === 404) {
      store.events = store.events.filter((ev) => ev.uid !== uid);
      saveStoreSafe(store);
      return { ok: true };
    }
    return { ok: false, error: `delete failed (HTTP ${res.status} ${res.statusText})` };
  } catch (err) {
    return { ok: false, error: describeFetchError(err) };
  }
}

export const Calendar = {
  connect,
  status,
  disconnect,
  events,
  createEvent,
  deleteEvent,
  upcoming,
};

export default Calendar;
