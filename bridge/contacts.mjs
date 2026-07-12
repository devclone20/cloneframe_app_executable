// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Contacts Engine
//
// Local address book: manual contacts, vCard/CSV import, and real CardDAV
// sync (Basic auth REPORT against an addressbook collection). Zero deps —
// uses global fetch for HTTP and a hand-rolled vCard/CSV/multistatus-XML
// scanner. Contacts persist to ~/.clone-frame-hub/contacts.json (0600).
// CardDAV credentials are never persisted by this module — callers pass
// {url, user, pass} per call and only the resulting contacts are stored.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const CONTACTS_FILE = path.join(CONFIG_DIR, 'contacts.json');

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on shared/odd filesystems */ }
}

function loadStore() {
  ensureConfigDir();
  try {
    const raw = fs.readFileSync(CONTACTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { contacts: Array.isArray(data.contacts) ? data.contacts : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { contacts: [] };
    // Corrupt store must never crash the app — start fresh rather than throw.
    return { contacts: [] };
  }
}

function saveStore(store) {
  ensureConfigDir();
  const tmp = `${CONTACTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, CONTACTS_FILE);
  try { fs.chmodSync(CONTACTS_FILE, 0o600); } catch { /* best effort */ }
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
// Handles line unfolding (CRLF/LF + leading space/tab continuation) and
// simple `;PARAM=x:` prefixed property lines. Does not support base64 PHOTO
// or nested groups — out of scope for an address-book import.
function unfoldLines(text) {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines = [];
  for (const line of rawLines) {
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
// Regex-based multistatus scanner: no XML dependency. Pulls each
// <address-data>…</address-data> (namespace-prefixed or not) payload out of
// the REPORT response body and decodes basic XML entities before handing the
// raw vCard text to parseVCardBlock via extractVCardBlocks.
function extractAddressDataBlocks(xml) {
  const blocks = [];
  const re = /<(?:[\w-]+:)?address-data[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?address-data>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(decodeXMLEntities(m[1]));
  }
  return blocks;
}

function decodeXMLEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

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
    const headers = {
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: '1',
    };
    if (user) {
      const token = Buffer.from(`${user}:${pass || ''}`, 'utf8').toString('base64');
      headers.Authorization = `Basic ${token}`;
    }

    const res = await fetch(url, {
      method: 'REPORT',
      headers,
      body: CARDDAV_REPORT_BODY,
    });

    if (!res.ok && res.status !== 207) {
      return { ok: false, error: `carddavSync: HTTP ${res.status} ${res.statusText}` };
    }

    const xml = await res.text();
    const vcardBlocks = extractAddressDataBlocks(xml);
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
