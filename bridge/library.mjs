// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Document Library / Knowledge Base
//
// The sidebar "Library": a local store for text documents the user pastes or
// imports (name, mimeType, text content, byte size, tags) plus a zero-dep
// full-text search over their content. Binary payloads may be handed in as
// base64, but only text/* (and a small allowlist of textual application/*
// types) are decoded into searchable text — everything else is kept as
// metadata only, so the JSON store never balloons with opaque blobs.
//
// Dependencies: Node built-ins only. Persists to ~/.clone-frame-hub/library.json
// (file 0600, dir 0700, atomic tmp-write-then-rename). A corrupt or missing
// store degrades to empty and never throws; write-path methods return
// {ok, ...} and never throw for expected failures.
//
// Public surface: `Library` object + named exports. See LIBRARY.md.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const STORE_FILE = path.join(CONFIG_DIR, 'library.json');
const STORE_VERSION = 1;

// ── limits (guard the JSON store + memory against pathological inputs) ────────
const MAX_CONTENT_BYTES = 8 * 1024 * 1024; // 8 MiB of extracted/stored text per doc
const MAX_INPUT_CHARS = 12 * 1024 * 1024;  // reject before decoding a huge base64 string
const MAX_NAME_LEN = 512;
const MAX_TAGS = 50;
const MAX_TAG_LEN = 64;
const SNIPPET_LEN = 200;
const EXCERPT_WINDOW = 60;   // chars of context on each side of a match
const MAX_EXCERPTS = 3;
const MAX_HITS_PER_TERM = 2;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_LIST_LIMIT = 500;

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on shared/odd filesystems */ }
}

function loadStore() {
  ensureConfigDir();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { version: STORE_VERSION, docs: Array.isArray(data.docs) ? data.docs : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { version: STORE_VERSION, docs: [] };
    // A corrupt store must never crash the Library — start fresh rather than throw.
    return { version: STORE_VERSION, docs: [] };
  }
}

function saveStore(store) {
  ensureConfigDir();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* best effort */ }
}

// ── MIME handling ─────────────────────────────────────────────────────────────
// A small allowlist of textual application/* types on top of every text/*.
// These are the only content types whose bytes we decode into searchable text.
const TEXTUAL_APPLICATION_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/xhtml+xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/ecmascript',
  'application/markdown',
  'application/x-markdown',
  'application/x-sh',
  'application/x-httpd-php',
  'application/sql',
  'application/toml',
  'application/csv',
]);

const EXT_MIME = {
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/plain',
  '.css': 'text/css',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.toml': 'application/toml',
  '.log': 'text/plain',
  '.rtf': 'application/rtf',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function bareMime(mimeType) {
  return String(mimeType || '').toLowerCase().split(';')[0].trim();
}

function isTextMime(mimeType) {
  const mt = bareMime(mimeType);
  if (!mt) return false;
  if (mt.startsWith('text/')) return true;
  if (mt.endsWith('+json') || mt.endsWith('+xml')) return true;
  return TEXTUAL_APPLICATION_MIMES.has(mt);
}

function resolveMime(provided, name, defaultsToText) {
  const bare = bareMime(provided);
  if (bare) return bare;
  const byExt = EXT_MIME[path.extname(name || '').toLowerCase()];
  if (byExt) return byExt;
  return defaultsToText ? 'text/plain' : 'application/octet-stream';
}

// ── input normalization ────────────────────────────────────────────────────
function normalizeTags(tags) {
  let arr;
  if (Array.isArray(tags)) arr = tags;
  else if (typeof tags === 'string') arr = tags.split(',');
  else return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const tag = String(raw ?? '').trim().slice(0, MAX_TAG_LEN);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Decode a base64 payload, transparently accepting a `data:<mime>;base64,…`
// URI prefix and any embedded whitespace/newlines. Returns the decoded Buffer
// plus any mimeType discovered in the data URI (used only when the caller
// didn't pass one explicitly). Never throws — Buffer.from is lenient.
function decodeBase64(input) {
  let payload = String(input);
  let mimeFromUri = '';
  const dataUri = payload.match(/^data:([^;,]*)(;base64)?,/i);
  if (dataUri) {
    mimeFromUri = (dataUri[1] || '').trim().toLowerCase();
    payload = payload.slice(dataUri[0].length);
  }
  payload = payload.replace(/\s+/g, '');
  return { buffer: Buffer.from(payload, 'base64'), mimeFromUri };
}

function makeSnippet(text) {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LEN ? `${flat.slice(0, SNIPPET_LEN).trimEnd()}…` : flat;
}

// ── projections (what leaves the module) ─────────────────────────────────────
// Documents carry no credential fields, but we project explicitly (never spread
// the raw record) so nothing unexpected can ever leak from list()/get().
function listView(doc) {
  return {
    id: doc.id,
    name: doc.name,
    mimeType: doc.mimeType,
    size: doc.size,
    tags: doc.tags,
    hasText: doc.text !== null,
    textLength: doc.text ? doc.text.length : 0,
    snippet: makeSnippet(doc.text),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function getView(doc) {
  return {
    id: doc.id,
    name: doc.name,
    mimeType: doc.mimeType,
    size: doc.size,
    tags: doc.tags,
    hasText: doc.text !== null,
    textLength: doc.text ? doc.text.length : 0,
    text: doc.text ?? '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ── search core ──────────────────────────────────────────────────────────────
function haystack(doc) {
  return `${doc.name}\n${doc.tags.join(' ')}\n${doc.text || ''}`.toLowerCase();
}

function countOccurrences(hay, term) {
  if (!term) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(term, from);
    if (idx === -1) break;
    n += 1;
    from = idx + term.length;
  }
  return n;
}

function docMatches(doc, terms) {
  if (terms.length === 0) return true;
  const hay = haystack(doc);
  return terms.every((t) => hay.includes(t));
}

function scoreDoc(doc, terms) {
  const hay = haystack(doc);
  let score = 0;
  for (const t of terms) score += countOccurrences(hay, t);
  return score;
}

// Build up to MAX_EXCERPTS context windows around term matches in the document
// text. Whitespace is collapsed and truncated sides are marked with an ellipsis.
function buildExcerpts(text, terms) {
  const excerpts = [];
  if (!text) return excerpts;
  const lower = text.toLowerCase();
  const seen = new Set();
  for (const term of terms) {
    if (!term || excerpts.length >= MAX_EXCERPTS) continue;
    let from = 0;
    let hits = 0;
    while (excerpts.length < MAX_EXCERPTS && hits < MAX_HITS_PER_TERM) {
      const idx = lower.indexOf(term, from);
      if (idx === -1) break;
      const start = Math.max(0, idx - EXCERPT_WINDOW);
      const end = Math.min(text.length, idx + term.length + EXCERPT_WINDOW);
      let slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
      if (start > 0) slice = `…${slice}`;
      if (end < text.length) slice = `${slice}…`;
      const key = slice.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        excerpts.push(slice);
      }
      from = idx + term.length;
      hits += 1;
    }
  }
  return excerpts;
}

function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

// list({search='', tag='', limit=500}) -> Doc[] (metadata + snippet, no full text)
// Newest first. `search` is a case-insensitive full-text filter (name + tags +
// content, all terms must match); `tag` narrows to docs carrying that tag.
export function list({ search = '', tag = '', limit = DEFAULT_LIST_LIMIT } = {}) {
  const store = loadStore();
  const terms = tokenize(search);
  const wantTag = String(tag || '').trim().toLowerCase();
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIST_LIMIT;
  return store.docs
    .filter((d) => (wantTag ? d.tags.some((t) => t.toLowerCase() === wantTag) : true))
    .filter((d) => docMatches(d, terms))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, cap)
    .map(listView);
}

// get(id) -> Doc (with full text) | null
export function get(id) {
  if (!id) return null;
  const store = loadStore();
  const doc = store.docs.find((d) => d.id === id);
  return doc ? getView(doc) : null;
}

// add({name, mimeType?, text?, contentBase64?, tags?}) -> {ok, id?, error?}
// Text is taken from `text` when present; otherwise `contentBase64` is decoded
// and, only for textual MIME types, extracted into searchable text. Binary
// content is stored as metadata only (size + mimeType + tags), never as a blob.
export function add({ name, mimeType, text, contentBase64, tags } = {}) {
  try {
    const cleanName = String(name ?? '').trim().slice(0, MAX_NAME_LEN);
    if (!cleanName) return { ok: false, error: 'name is required' };

    let storedText = null; // null => metadata-only (non-textual binary)
    let size = 0;
    let resolvedMime = resolveMime(mimeType, cleanName, true);

    if (typeof text === 'string') {
      size = Buffer.byteLength(text, 'utf8');
      if (size > MAX_CONTENT_BYTES) return { ok: false, error: 'document too large' };
      storedText = text;
      resolvedMime = resolveMime(mimeType, cleanName, true);
    } else if (typeof contentBase64 === 'string' && contentBase64.length > 0) {
      if (contentBase64.length > MAX_INPUT_CHARS) return { ok: false, error: 'document too large' };
      const { buffer, mimeFromUri } = decodeBase64(contentBase64);
      size = buffer.length;
      if (size > MAX_CONTENT_BYTES) return { ok: false, error: 'document too large' };
      resolvedMime = resolveMime(mimeType || mimeFromUri, cleanName, false);
      if (isTextMime(resolvedMime)) storedText = buffer.toString('utf8');
    } else {
      // No content supplied — an empty text note is valid and searchable by name/tags.
      storedText = '';
      size = 0;
    }

    const now = new Date().toISOString();
    const doc = {
      id: randomUUID(),
      name: cleanName,
      mimeType: resolvedMime,
      size,
      tags: normalizeTags(tags),
      text: storedText,
      createdAt: now,
      updatedAt: now,
    };

    const store = loadStore();
    store.docs.push(doc);
    saveStore(store);
    return { ok: true, id: doc.id };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// update(id, patch) -> {ok, error?}
// patch: any subset of {name, mimeType, text, tags}. Providing `text`
// recomputes size and re-enables text extraction for the document.
export function update(id, patch = {}) {
  try {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch is required' };
    const store = loadStore();
    const doc = store.docs.find((d) => d.id === id);
    if (!doc) return { ok: false, error: 'not found' };

    if (patch.name !== undefined) {
      const cleanName = String(patch.name).trim().slice(0, MAX_NAME_LEN);
      if (!cleanName) return { ok: false, error: 'name cannot be empty' };
      doc.name = cleanName;
    }
    if (patch.mimeType !== undefined) doc.mimeType = resolveMime(patch.mimeType, doc.name, doc.text !== null);
    if (patch.tags !== undefined) doc.tags = normalizeTags(patch.tags);
    if (patch.text !== undefined) {
      const t = String(patch.text);
      const size = Buffer.byteLength(t, 'utf8');
      if (size > MAX_CONTENT_BYTES) return { ok: false, error: 'document too large' };
      doc.text = t;
      doc.size = size;
    }
    doc.updatedAt = new Date().toISOString();

    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// remove(id) -> {ok, error?}
export function remove(id) {
  try {
    const store = loadStore();
    const before = store.docs.length;
    store.docs = store.docs.filter((d) => d.id !== id);
    if (store.docs.length === before) return { ok: false, error: 'not found' };
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// search(query) -> {docId, name, excerpts:string[]}[]
// Full-text search over name + tags + content. All query terms must appear in a
// document (AND). Results are ranked by total term frequency, newest first as a
// tiebreak, and capped. `excerpts` are context windows around the matches.
export function search(query) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const store = loadStore();
  const hits = [];
  for (const doc of store.docs) {
    if (!docMatches(doc, terms)) continue;
    hits.push({ doc, score: scoreDoc(doc, terms) });
  }
  hits.sort((a, b) => (b.score - a.score) || String(b.doc.updatedAt).localeCompare(String(a.doc.updatedAt)));
  return hits.slice(0, MAX_SEARCH_RESULTS).map(({ doc }) => {
    let excerpts = buildExcerpts(doc.text, terms);
    if (excerpts.length === 0) {
      // Match came from name/tags (or a metadata-only doc): fall back to a preview.
      const preview = doc.text ? makeSnippet(doc.text) : `${doc.name} · ${doc.mimeType}`;
      excerpts = preview ? [preview] : [];
    }
    return { docId: doc.id, name: doc.name, excerpts };
  });
}

// count() -> number
export function count() {
  return loadStore().docs.length;
}

export const Library = {
  list,
  get,
  add,
  update,
  remove,
  search,
  count,
};

export default Library;
