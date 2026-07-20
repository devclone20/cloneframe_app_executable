// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Contacts Engine
//
// Local address book: manual contacts, vCard/CSV import, and real CardDAV
// sync (Basic auth REPORT against an addressbook collection). Zero deps. DAV
// transport (timed fetch, Basic auth, multistatus parse) and the shared
// iCalendar/vCard line primitives come from platform/dav.mjs; only the vCard/
// CSV domain shaping is hand-rolled here. Contacts persist to
// ~/.clone-frame-hub/contacts.json (0600). CardDAV credentials are never
// persisted by this module — callers pass {url, user, pass} per call and only
// the resulting contacts are stored.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';
import { davFetch, parseMultistatus, unfoldLines, splitPropertyLine } from './platform/dav.mjs';

// ── persistence ──────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/contacts.json,
// dir 0700 / file 0600, tmp-write-then-rename, read-per-call, never logs. The
// store guarantees only the top-level container; the per-contact shaping
// (makeContact / mergeContacts / update coercion) stays this module's job,
// exactly as before.
const STORE_VERSION = 1;
const store = openStore({ name: 'contacts', version: STORE_VERSION, shape: { contacts: [] }, root: hubRoot() });

function loadStore() {
  const data = store.read();
  return { contacts: Array.isArray(data.contacts) ? data.contacts : [] };
}

function saveStore(s) {
  store.write(s);
}

// ── contact shape ────────────────────────────────────────────────────────────
function normEmail(e) {
  return typeof e === 'string' ? e.trim().toLowerCase() : '';
}

function makeContact({ displayName, emails = [], phones = [], org = '', source = 'manual' }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    displayName: (displayName || '').trim() || (emails[0] || phones[0] || 'Unnamed'),
    emails: [...new Set(emails.map((e) => (e || '').trim()).filter(Boolean))],
    phones: [...new Set(phones.map((p) => (p || '').trim()).filter(Boolean))],
    org: (org || '').trim(),
    source,
    updatedAt: now,
  };
}

function primaryEmailKey(contact) {
  return contact.emails.length ? normEmail(contact.emails[0]) : '';
}

// Merge a batch of freshly-parsed contacts (no id yet) into the persisted
// store, deduping by lowercased primary email. Contacts without any email
// are always inserted as new (nothing to dedupe against).
function mergeContacts(store, incoming) {
  let imported = 0;
  let skipped = 0;
  for (const draft of incoming) {
    if (!draft.displayName && draft.emails.length === 0 && draft.phones.length === 0) {
      skipped += 1;
      continue;
    }
    const key = primaryEmailKey(draft);
    const existing = key ? store.contacts.find((c) => primaryEmailKey(c) === key) : null;
    if (existing) {
      existing.displayName = draft.displayName || existing.displayName;
      existing.emails = [...new Set([...existing.emails, ...draft.emails])];
      existing.phones = [...new Set([...existing.phones, ...draft.phones])];
      existing.org = draft.org || existing.org;
      existing.source = draft.source;
      existing.updatedAt = new Date().toISOString();
      imported += 1;
    } else {
      store.contacts.push(makeContact(draft));
      imported += 1;
    }
  }
  return { imported, skipped };
}

// ── vCard parsing (RFC 6350, minimal subset: FN, N, EMAIL, TEL, ORG) ────────
// Line unfolding (CRLF/LF + leading space/tab continuation) and `;PARAM=x:`
// property-line splitting are the shared iCalendar/vCard primitives, taken
// from platform/dav.mjs. Value unescaping is vCard-specific and stays here.
// Does not support base64 PHOTO or nested groups — out of scope for an
// address-book import.
function unescapeVCardValue(v) {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseVCardBlock(block) {
  const lines = unfoldLines(block);
  let fn = '';
  let nParts = null;
  const emails = [];
  const phones = [];
  let org = '';

  for (const line of lines) {
    const prop = splitPropertyLine(line);
    if (!prop) continue;
    const value = unescapeVCardValue(prop.value);
    switch (prop.name) {
      case 'FN':
        fn = value;
        break;
      case 'N': {
        const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
        nParts = parts;
        break;
      }
      case 'EMAIL':
        if (value.trim()) emails.push(value.trim());
        break;
      case 'TEL':
        if (value.trim()) phones.push(value.trim());
        break;
      case 'ORG':
        org = value.split(';').filter(Boolean).join(' ').trim();
        break;
      default:
        break;
    }
  }

  const displayName = fn || (nParts ? nParts.slice().reverse().join(' ').trim() : '') || '';
  return { displayName, emails, phones, org, source: 'vcard' };
}

function extractVCardBlocks(text) {
  const blocks = [];
  const re = /BEGIN:VCARD([\s\S]*?)END:VCARD/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

export function parseVCards(text) {
  return extractVCardBlocks(text).map(parseVCardBlock);
}

// ── CSV parsing (RFC 4180-ish: quoted fields, escaped "") ───────────────────
function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

// Splits raw CSV text into logical rows, respecting quoted newlines.
function splitCSVRows(text) {
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    if ((ch === '\n') && !inQuotes) {
      rows.push(cur);
      cur = '';
    } else if (ch !== '\r') {
      cur += ch;
    }
  }
  if (cur.trim() !== '') rows.push(cur);
  return rows;
}

const CSV_COLUMN_ALIASES = {
  displayName: ['name', 'full name', 'display name', 'fullname', 'displayname'],
  email: ['email', 'email address', 'e-mail'],
  phone: ['phone', 'phone number', 'telephone', 'tel', 'mobile'],
  org: ['org', 'company', 'organization', 'organisation'],
};

function detectHeader(fields) {
  const lower = fields.map((f) => f.toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(CSV_COLUMN_ALIASES)) {
    const idx = lower.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[key] = idx;
  }
  return map;
}

export function parseCSVContacts(text) {
  const rows = splitCSVRows(text).map(parseCSVLine).filter((r) => r.length > 1 || r[0] !== '');
  if (rows.length === 0) return [];

  const headerMap = detectHeader(rows[0]);
  const hasHeader = Object.keys(headerMap).length > 0;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  // No recognizable header: assume name,email,phone,org column order.
  const map = hasHeader ? headerMap : { displayName: 0, email: 1, phone: 2, org: 3 };

  return dataRows
    .filter((r) => r.some((f) => f !== ''))
    .map((r) => ({
      displayName: map.displayName !== undefined ? (r[map.displayName] || '') : '',
      emails: map.email !== undefined && r[map.email] ? [r[map.email]] : [],
      phones: map.phone !== undefined && r[map.phone] ? [r[map.phone]] : [],
      org: map.org !== undefined ? (r[map.org] || '') : '',
      source: 'csv',
    }));
}

// ── CardDAV sync ─────────────────────────────────────────────────────────────
// Transport + multistatus parsing come from platform/dav.mjs: davFetch runs
// the REPORT with a Basic-auth header and — unlike this module's former inline
// fetch, which had NO timeout and could hang the caller against a dead host —
// always applies a timeout. parseMultistatus pulls the <address-data> payload
// (namespace-prefixed or not) out of each <response>, XML-entity-decoding it
// before we hand the raw vCard text to parseVCardBlock via extractVCardBlocks.
const CARDDAV_REPORT_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
  <C:filter/>
</C:addressbook-query>`;

export async function carddavSync({ url, user, pass } = {}) {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'carddavSync: url is required' };
  }
  try {
    const res = await davFetch({
      url,
      method: 'REPORT',
      creds: { user, pass },
      depth: 1,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: CARDDAV_REPORT_BODY,
    });

    if (!res.ok && res.status !== 207) {
      return { ok: false, error: `carddavSync: HTTP ${res.status} ${res.statusText}` };
    }

    const xml = await res.text();
    const vcardBlocks = parseMultistatus(xml, { dataTag: 'address-data' }).map((r) => r.data);
    if (vcardBlocks.length === 0) {
      return { ok: true, imported: 0 };
    }

    const parsed = vcardBlocks
      .flatMap((block) => extractVCardBlocks(block).map(parseVCardBlock))
      .map((c) => ({ ...c, source: 'carddav' }));

    const store = loadStore();
    const { imported } = mergeContacts(store, parsed);
    saveStore(store);
    return { ok: true, imported };
  } catch (e) {
    return { ok: false, error: `carddavSync: ${e.message}` };
  }
}

// ── public API ───────────────────────────────────────────────────────────────
function matchesSearch(contact, needle) {
  if (!needle) return true;
  const n = needle.toLowerCase();
  if (contact.displayName.toLowerCase().includes(n)) return true;
  if (contact.org.toLowerCase().includes(n)) return true;
  return contact.emails.some((e) => e.toLowerCase().includes(n));
}

export function list({ search = '', limit = 500 } = {}) {
  const store = loadStore();
  return store.contacts
    .filter((c) => matchesSearch(c, search))
    .slice(0, Math.max(0, limit));
}

export function get(id) {
  const store = loadStore();
  return store.contacts.find((c) => c.id === id) || null;
}

export function add({ displayName, emails = [], phones = [], org = '' } = {}) {
  if (!displayName && emails.length === 0 && phones.length === 0) {
    return { ok: false, error: 'add: displayName, emails, or phones required' };
  }
  const store = loadStore();
  const contact = makeContact({ displayName, emails, phones, org, source: 'manual' });
  store.contacts.push(contact);
  saveStore(store);
  return { ok: true, id: contact.id };
}

export function update(id, patch = {}) {
  const store = loadStore();
  const contact = store.contacts.find((c) => c.id === id);
  if (!contact) return { ok: false, error: 'update: contact not found' };

  if (patch.displayName !== undefined) contact.displayName = String(patch.displayName).trim();
  if (patch.emails !== undefined) {
    contact.emails = [...new Set((patch.emails || []).map((e) => String(e).trim()).filter(Boolean))];
  }
  if (patch.phones !== undefined) {
    contact.phones = [...new Set((patch.phones || []).map((p) => String(p).trim()).filter(Boolean))];
  }
  if (patch.org !== undefined) contact.org = String(patch.org).trim();
  contact.updatedAt = new Date().toISOString();

  saveStore(store);
  return { ok: true };
}

export function remove(id) {
  const store = loadStore();
  const before = store.contacts.length;
  store.contacts = store.contacts.filter((c) => c.id !== id);
  if (store.contacts.length === before) return { ok: false, error: 'remove: contact not found' };
  saveStore(store);
  return { ok: true };
}

export function importVCard(text) {
  const parsed = parseVCards(text);
  const store = loadStore();
  const { imported, skipped } = mergeContacts(store, parsed);
  saveStore(store);
  return { ok: true, imported, skipped };
}

export function importCSV(text) {
  const parsed = parseCSVContacts(text);
  const store = loadStore();
  const { imported, skipped } = mergeContacts(store, parsed);
  saveStore(store);
  return { ok: true, imported, skipped };
}

export function count() {
  return loadStore().contacts.length;
}

export const Contacts = {
  list,
  get,
  add,
  update,
  remove,
  importVCard,
  importCSV,
  carddavSync,
  count,
};

export default Contacts;
