// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Image Gallery
//
// Sidebar "Gallery": stores generated / imported images as lightweight metadata
// in a JSON index, with the raw bytes kept as separate blob files so the index
// stays small and fast to read. list() returns metadata only (never bytes);
// get() reads a single blob back and hands it out as a data URI.
//
// Import is fully supported (base64, with or without a data: prefix). Generation
// has no external image provider wired in, so generate() degrades gracefully to
// {ok:false, error:'no image provider configured'} rather than pretending.
//
// Dependencies: Node built-ins only (fs, path, os, crypto). No image is ever
// rendered here — bytes are written to disk and returned as data URIs, so the
// UI's <img> tag is the only consumer. Blobs live under
// ~/.clone-frame-hub/gallery/ (dir 0700, files 0600); the index is
// ~/.clone-frame-hub/gallery.json (0600). A corrupt/missing index degrades to
// an empty gallery, never throws.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const STORE_FILE = path.join(CONFIG_DIR, 'gallery.json');
const BLOB_DIR = path.join(CONFIG_DIR, 'gallery');

// Per-image byte cap. Generous for photos/screenshots, bounded so a single
// import can never exhaust the disk. Applies to the decoded bytes, not base64.
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_LEN = 2000;
const MAX_TAGS = 32;
const MAX_TAG_LEN = 64;

// Allowed image types → canonical file extension. Anything not in this map is
// rejected: the gallery only accepts images, and pinning the extension to a
// whitelist keeps blob filenames safe and predictable.
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

// Blob filenames are always `${uuid}.${ext}` generated here — never derived from
// caller input. This guard defends against a hand-tampered index.json trying to
// smuggle a traversal path back through get()/remove().
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function ensureDirs() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on shared/odd filesystems */ }
  fs.mkdirSync(BLOB_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(BLOB_DIR, 0o700); } catch { /* best effort */ }
}

function loadStore() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { items: Array.isArray(data.items) ? data.items : [] };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { items: [] };
    // Corrupt index must never crash the gallery — start clean rather than throw.
    return { items: [] };
  }
}

function saveStore(store) {
  ensureDirs();
  const tmp = `${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* best effort */ }
}

function blobPathFor(filename) {
  if (typeof filename !== 'string' || !SAFE_FILENAME.test(filename)) return null;
  const p = path.join(BLOB_DIR, filename);
  // Defence in depth: the resolved path must still live inside BLOB_DIR.
  if (p !== BLOB_DIR && !p.startsWith(BLOB_DIR + path.sep)) return null;
  return p;
}

function writeBlob(filename, buffer) {
  ensureDirs();
  const dest = blobPathFor(filename);
  if (!dest) throw new Error('unsafe blob filename');
  const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, dest);
  try { fs.chmodSync(dest, 0o600); } catch { /* best effort */ }
}

// ── input normalisation ──────────────────────────────────────────────────────

// Accepts either a raw base64 string or a full `data:<mime>;base64,<payload>`
// URI. Returns {base64, mimeFromUri} with whitespace stripped and base64url
// normalised to standard base64. Never throws.
function parseContent(contentBase64) {
  if (typeof contentBase64 !== 'string' || contentBase64.trim() === '') {
    return { base64: null, mimeFromUri: null };
  }
  let s = contentBase64.trim();
  let mimeFromUri = null;
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(s);
  if (m) {
    // Only base64 data URIs are supported (images are binary; URL-encoded text
    // payloads are not a real-world image path).
    if (!m[2]) return { base64: null, mimeFromUri: null };
    mimeFromUri = (m[1] || '').trim().toLowerCase() || null;
    s = m[3];
  }
  s = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return { base64: s, mimeFromUri };
}

function isValidBase64(s) {
  return typeof s === 'string' && s.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

// Magic-byte sniffer. Returns a canonical image MIME or null. Used to self-heal
// a mislabeled mimeType so the stored data URI always matches the real bytes.
function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return 'image/tiff';
  if (b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = b.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') return 'image/heic';
    if (brand === 'mif1' || brand === 'msf1' || brand === 'heim' || brand === 'heis') return 'image/heif';
  }
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

function normalizeMime(m) {
  if (typeof m !== 'string') return null;
  const v = m.trim().toLowerCase();
  return MIME_EXT[v] ? v : null;
}

function normalizePrompt(p) {
  if (typeof p !== 'string') return '';
  return p.trim().slice(0, MAX_PROMPT_LEN);
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const v = t.trim().slice(0, MAX_TAG_LEN);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// The list/index projection: metadata only, never bytes.
function toListItem(it) {
  return {
    id: it.id,
    prompt: it.prompt || '',
    filename: it.filename,
    mimeType: it.mimeType,
    byteSize: it.byteSize ?? null,
    tags: Array.isArray(it.tags) ? it.tags : [],
    source: it.source || 'import',
    createdAt: it.createdAt,
  };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * List all images, newest first. Metadata only — never image bytes.
 * @returns {Array<{id,prompt,filename,mimeType,byteSize,tags,source,createdAt}>}
 */
export function list() {
  const { items } = loadStore();
  return [...items]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(toListItem);
}

/**
 * Read one image back as a data URI. Returns null if the id is unknown or the
 * blob is missing (degrades, never throws).
 * @returns {{id,prompt,dataUri,mimeType,filename,byteSize,tags,createdAt}|null}
 */
export function get(id) {
  if (!id || typeof id !== 'string') return null;
  const { items } = loadStore();
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  const p = blobPathFor(it.filename);
  if (!p) return null;
  let buf;
  try { buf = fs.readFileSync(p); } catch { return null; }
  return {
    id: it.id,
    prompt: it.prompt || '',
    dataUri: `data:${it.mimeType};base64,${buf.toString('base64')}`,
    mimeType: it.mimeType,
    filename: it.filename,
    byteSize: it.byteSize ?? buf.length,
    tags: Array.isArray(it.tags) ? it.tags : [],
    createdAt: it.createdAt,
  };
}

/**
 * Import an image. `contentBase64` may be raw base64 or a full
 * `data:<mime>;base64,<payload>` URI. The stored mimeType self-heals from the
 * real bytes when they can be sniffed, so the returned data URI always renders.
 * @param {{prompt?:string, mimeType:string, contentBase64:string, tags?:string[]}} input
 * @returns {{ok:boolean, id?:string, error?:string}}
 */
export function add(input = {}) {
  try {
    if (!input || typeof input !== 'object') return { ok: false, error: 'add: object argument required' };
    const { base64, mimeFromUri } = parseContent(input.contentBase64);
    if (!base64) return { ok: false, error: 'add: contentBase64 is required' };
    if (!isValidBase64(base64)) return { ok: false, error: 'add: contentBase64 is not valid base64' };

    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch { buf = null; }
    if (!buf || buf.length === 0) return { ok: false, error: 'add: decoded image is empty' };
    if (buf.length > MAX_BYTES) {
      return { ok: false, error: `add: image exceeds ${Math.floor(MAX_BYTES / (1024 * 1024))} MiB limit` };
    }

    // Resolve the MIME with the real bytes as the source of truth, then fall
    // back to the caller's declared type, then the data-URI's type.
    const sniffed = sniffMime(buf);
    const declared = normalizeMime(input.mimeType);
    const fromUri = normalizeMime(mimeFromUri);
    const mimeType = sniffed || declared || fromUri;
    if (!mimeType) {
      return { ok: false, error: 'add: unsupported or missing image mimeType' };
    }

    const id = randomUUID();
    const filename = `${id}.${MIME_EXT[mimeType]}`;
    writeBlob(filename, buf);

    const record = {
      id,
      prompt: normalizePrompt(input.prompt),
      filename,
      mimeType,
      byteSize: buf.length,
      tags: normalizeTags(input.tags),
      source: 'import',
      createdAt: new Date().toISOString(),
    };

    try {
      const store = loadStore();
      store.items.push(record);
      saveStore(store);
    } catch (e) {
      // Index write failed — don't leave an orphan blob behind.
      const p = blobPathFor(filename);
      if (p) { try { fs.unlinkSync(p); } catch { /* best effort */ } }
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }

    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Remove an image (index entry + blob file). Idempotent-ish: unknown id →
 * {ok:false, error:'not found'}. A missing blob still clears the index entry.
 * @returns {{ok:boolean, error?:string}}
 */
export function remove(id) {
  try {
    if (!id || typeof id !== 'string') return { ok: false, error: 'remove: id is required' };
    const store = loadStore();
    const it = store.items.find((x) => x.id === id);
    if (!it) return { ok: false, error: 'not found' };
    store.items = store.items.filter((x) => x.id !== id);
    saveStore(store);
    const p = blobPathFor(it.filename);
    if (p) { try { fs.unlinkSync(p); } catch { /* blob already gone — index is what matters */ } }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Text-to-image generation. No external image provider is configured on this
 * machine (the shared BYOK Claude helper produces text, not pixels), so this
 * degrades gracefully instead of failing loudly or faking output.
 * @returns {{ok:false, error:string}}
 */
export function generate(_input = {}) {
  return { ok: false, error: 'no image provider configured' };
}

/**
 * Total number of images in the gallery.
 * @returns {number}
 */
export function count() {
  return loadStore().items.length;
}

export const Gallery = { list, get, add, remove, generate, count };
export default Gallery;
