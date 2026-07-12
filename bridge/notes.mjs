// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Notes Engine
//
// The HUB's "Notes" sidebar: Markdown notes with title, body, tags and
// timestamps. Full CRUD plus case-insensitive text search and a tag index.
// Zero npm dependencies — Node built-ins only. Notes persist to
// ~/.clone-frame-hub/notes.json (file 0600, directory 0700) via an atomic
// tmp-write-then-rename. A corrupt or missing store degrades to empty; it
// never throws. Every write-path method returns {ok, ...} and never throws
// for an expected failure (returns {ok:false, error} instead).
//
// Routed through hub-bridge's generic module RPC (POST /mod/notes {fn,args});
// the server invokes each exported method as obj.fn(...args), so every method
// is directly callable with plain JSON arguments and returns JSON-serializable
// values. Public surface: `Notes` object + named exports. See NOTES.md.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── paths / limits ────────────────────────────────────────────────────────────
const ROOT = path.join(homedir(), '.clone-frame-hub');
const NOTES_FILE = path.join(ROOT, 'notes.json');

const STORE_VERSION = 1;
const SNIPPET_LEN = 220; // list body preview length, in characters
const MAX_TAG_LEN = 64;  // per-tag character cap
const MAX_TAGS = 50;     // per-note tag count cap

// ── persistence — atomic writes, dir 0700 / file 0600, never logs anything ───
function ensureDir() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ROOT, 0o700); } catch { /* best effort on odd/shared filesystems */ }
}

function loadStore() {
  ensureDir();
  try {
    const data = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    const notes = Array.isArray(data?.notes)
      ? data.notes.filter(isValidNote).map(sanitizeNote)
      : [];
    return { version: STORE_VERSION, notes };
  } catch {
    // Missing (ENOENT) or corrupt/hand-edited JSON must never crash the app —
    // start from an empty store rather than throw.
    return { version: STORE_VERSION, notes: [] };
  }
}

function saveStore(store) {
  ensureDir();
  const tmp = `${NOTES_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, NOTES_FILE);
  try { fs.chmodSync(NOTES_FILE, 0o600); } catch { /* best effort */ }
}

// ── note shape ────────────────────────────────────────────────────────────────
function isValidNote(n) {
  return !!n && typeof n === 'object' && n.id != null && String(n.id).length > 0;
}

function asString(v) {
  return typeof v === 'string' ? v : String(v ?? '');
}

// Normalize a tag list: accepts an array or a comma-separated string, trims,
// caps length, drops empties, and dedupes case-insensitively while preserving
// the first-seen original casing (tags are display strings).
function normTags(input) {
  let raw;
  if (Array.isArray(input)) raw = input;
  else if (typeof input === 'string') raw = input.split(',');
  else raw = [];
  const seen = new Map(); // lowercased key -> original-cased tag
  for (const item of raw) {
    const tag = asString(item).trim().slice(0, MAX_TAG_LEN);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen.values()];
}

// Defensive coercion for entries read back from disk (may be hand-edited).
function sanitizeNote(n) {
  const created = typeof n.createdAt === 'string' ? n.createdAt : new Date().toISOString();
  return {
    id: String(n.id),
    title: asString(n.title),
    body: asString(n.body),
    tags: normTags(n.tags),
    createdAt: created,
    updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : created,
  };
}

function makeNote({ title, body, tags }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: asString(title).trim(),
    body: asString(body),
    tags: normTags(tags),
    createdAt: now,
    updatedAt: now,
  };
}

// ── snippet — light Markdown → plain-text preview for the list view ──────────
function toSnippet(body) {
  const text = asString(body)
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`([^`]*)`/g, '$1')              // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links → link text
    .replace(/^[ \t]*[>#]+[ \t]*/gm, '')      // heading / blockquote markers
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, '') // list markers
    .replace(/[*_~]+/g, '')                   // emphasis marks
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= SNIPPET_LEN) return text;
  return `${text.slice(0, SNIPPET_LEN).replace(/\s+\S*$/, '')}…`;
}

function publicListView(n) {
  return {
    id: n.id,
    title: n.title,
    snippet: toSnippet(n.body),
    tags: n.tags,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

// ── query helpers ─────────────────────────────────────────────────────────────
function byNewest(a, b) {
  const bu = Date.parse(b.updatedAt) || 0;
  const au = Date.parse(a.updatedAt) || 0;
  if (bu !== au) return bu - au;
  return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
}

function matchesSearch(n, needle) {
  if (n.title.toLowerCase().includes(needle)) return true;
  if (n.body.toLowerCase().includes(needle)) return true;
  return n.tags.some((t) => t.toLowerCase().includes(needle));
}

function hasTag(n, tagLower) {
  return n.tags.some((t) => t.toLowerCase() === tagLower);
}

// ── public API ────────────────────────────────────────────────────────────────
// Read-path: returns values directly. `list` newest-first, body → snippet.
export function list({ search = '', tag = '' } = {}) {
  const store = loadStore();
  const needle = asString(search).trim().toLowerCase();
  const wantTag = asString(tag).trim().toLowerCase();
  return store.notes
    .filter((n) => (!needle || matchesSearch(n, needle)) && (!wantTag || hasTag(n, wantTag)))
    .sort(byNewest)
    .map(publicListView);
}

// Read-path: full note (including full body) or null when not found.
export function get(id) {
  const store = loadStore();
  return store.notes.find((n) => n.id === id) || null;
}

// Write-path: {ok, id} on success, {ok:false, error} otherwise. Never throws.
export function create(input = {}) {
  try {
    const src = input && typeof input === 'object' ? input : {};
    const title = asString(src.title).trim();
    const body = asString(src.body);
    if (!title && !body.trim()) {
      return { ok: false, error: 'create: title or body is required' };
    }
    const store = loadStore();
    const note = makeNote({ title, body, tags: src.tags });
    store.notes.push(note);
    saveStore(store);
    return { ok: true, id: note.id };
  } catch (e) {
    return { ok: false, error: `create: ${e?.message || e}` };
  }
}

// Write-path: patch is any subset of {title, body, tags}. Arrays replace (then
// dedupe). {ok} on success, {ok:false, error} otherwise. Never throws.
export function update(id, patch = {}) {
  try {
    const store = loadStore();
    const note = store.notes.find((n) => n.id === id);
    if (!note) return { ok: false, error: 'update: note not found' };
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.title !== undefined) note.title = asString(p.title).trim();
    if (p.body !== undefined) note.body = asString(p.body);
    if (p.tags !== undefined) note.tags = normTags(p.tags);
    note.updatedAt = new Date().toISOString();
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `update: ${e?.message || e}` };
  }
}

// Write-path: {ok} on success, {ok:false, error} otherwise. Never throws.
export function remove(id) {
  try {
    const store = loadStore();
    const before = store.notes.length;
    store.notes = store.notes.filter((n) => n.id !== id);
    if (store.notes.length === before) return { ok: false, error: 'remove: note not found' };
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `remove: ${e?.message || e}` };
  }
}

// Read-path: sorted, de-duplicated union of every tag across all notes.
export function tags() {
  const store = loadStore();
  const seen = new Map(); // lowercased key -> original-cased tag
  for (const n of store.notes) {
    for (const t of n.tags) {
      const key = t.toLowerCase();
      if (!seen.has(key)) seen.set(key, t);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export const Notes = { list, get, create, update, remove, tags };

export default Notes;
