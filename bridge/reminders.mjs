// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Reminders Engine
//
// Backs the HUB's Settings → "Reminders" panel and the sidebar bell: simple
// time-based reminders with a note, a `remindAt` instant and a lifecycle status
// (pending → done, or dismissed). Full CRUD plus snooze, a `due()` the server
// polls, and a `counts()` for the bell badge. Zero npm dependencies — Node
// built-ins only (`fs`, `path`, `os`, `crypto`).
//
// Reminders persist to ~/.clone-frame-hub/reminders.json (file 0600, directory
// 0700) via an atomic tmp-write-then-rename. A missing or corrupt store degrades
// to empty; it never throws. A reminder has no secret fields, so nothing is
// redacted — but the public view is a strict whitelist, so any stray key from a
// hand-edited store (including anything that looked like a credential) never
// leaves the module. Nothing is ever logged.
//
// Routed through hub-bridge's generic module RPC (POST /mod/reminders {fn,args});
// the server invokes each exported method as obj.fn(...args), so every method is
// directly callable with plain JSON arguments and returns JSON-serializable
// values. Write-path methods return {ok, ...} and never throw for an expected
// failure (they return {ok:false, error} instead). Read-path methods return
// values directly. Public surface: `Reminders` object + named exports.
// See REMINDERS.md.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── paths / limits ────────────────────────────────────────────────────────────
const ROOT = path.join(homedir(), '.clone-frame-hub');
const REMINDERS_FILE = path.join(ROOT, 'reminders.json');

const STORE_VERSION = 1;
const MAX_NOTE_LEN = 4_000; // per-reminder note character cap
const MAX_REF_LEN = 200;    // refType / refId character cap
const MAX_SNOOZE_MIN = 525_600; // one year, in minutes — an upper bound for snooze

const VALID_STATUS = new Set(['pending', 'done', 'dismissed']);

// ── persistence — atomic writes, dir 0700 / file 0600, never logs anything ────
function ensureDir() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ROOT, 0o700); } catch { /* best effort on odd/shared filesystems */ }
}

function loadStore() {
  ensureDir();
  try {
    const data = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
    const reminders = Array.isArray(data?.reminders)
      ? data.reminders.filter(isValidReminder).map(sanitizeReminder)
      : [];
    return { version: STORE_VERSION, reminders };
  } catch {
    // Missing (ENOENT) or corrupt/hand-edited JSON must never crash the app —
    // start from an empty store rather than throw.
    return { version: STORE_VERSION, reminders: [] };
  }
}

function saveStore(store) {
  ensureDir();
  const tmp = `${REMINDERS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, REMINDERS_FILE);
  try { fs.chmodSync(REMINDERS_FILE, 0o600); } catch { /* best effort */ }
}

// ── value coercion ────────────────────────────────────────────────────────────
function asString(v) {
  return typeof v === 'string' ? v : String(v ?? '');
}

// Normalize a user-supplied instant into a canonical UTC ISO string. Accepts an
// ISO/RFC-2822 string, a bare `YYYY-MM-DD` (→ UTC midnight), or an epoch-ms
// number. Returns {ok, iso} or {ok:false, error}. Never throws.
function parseInstant(v) {
  if (v == null || v === '') return { ok: false, error: 'remindAt is required' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, error: 'remindAt is not a finite timestamp' };
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? { ok: false, error: 'remindAt is not a valid timestamp' } : { ok: true, iso: d.toISOString() };
  }
  if (typeof v === 'string') {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? { ok: false, error: 'remindAt is not a parseable date/time' } : { ok: true, iso: new Date(t).toISOString() };
  }
  return { ok: false, error: 'remindAt must be an ISO string or epoch-ms number' };
}

// A tolerant instant → epoch-ms for reads (`now`, comparisons). Bad input yields
// NaN so callers can decide the fallback; this never throws.
function toMillis(v, fallback = NaN) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const t = Date.parse(asString(v).trim());
  return Number.isNaN(t) ? fallback : t;
}

function normRef(v) {
  if (v == null) return null;
  const s = asString(v).trim().slice(0, MAX_REF_LEN);
  return s || null;
}

// ── reminder shape ────────────────────────────────────────────────────────────
function isValidReminder(r) {
  return !!r && typeof r === 'object' && r.id != null && String(r.id).length > 0;
}

// Defensive coercion for entries read back from disk (may be hand-edited): every
// field is re-typed to the canonical shape so a partial/garbled record still
// loads cleanly instead of poisoning a read.
function sanitizeReminder(r) {
  const created = typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString();
  const status = VALID_STATUS.has(r.status) ? r.status : 'pending';
  const remindAt = parseInstant(r.remindAt);
  return {
    id: String(r.id),
    note: asString(r.note).slice(0, MAX_NOTE_LEN),
    remindAt: remindAt.ok ? remindAt.iso : asString(r.remindAt),
    status,
    refType: normRef(r.refType),
    refId: normRef(r.refId),
    snoozedCount: Number.isInteger(r.snoozedCount) && r.snoozedCount >= 0 ? r.snoozedCount : 0,
    createdAt: created,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : created,
    doneAt: typeof r.doneAt === 'string' ? r.doneAt : null,
  };
}

// Strict whitelist — the only shape that ever leaves the module. Guarantees no
// stray key from a hand-edited store is ever returned.
function publicView(r) {
  return {
    id: r.id,
    note: r.note,
    remindAt: r.remindAt,
    status: r.status,
    refType: r.refType,
    refId: r.refId,
    snoozedCount: r.snoozedCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    doneAt: r.doneAt,
  };
}

// ── ordering ──────────────────────────────────────────────────────────────────
// Soonest remindAt first; records with an unparseable remindAt sort last, with a
// stable createdAt tiebreak so equal instants keep a deterministic order.
function bySoonest(a, b) {
  const ta = toMillis(a.remindAt, Infinity);
  const tb = toMillis(b.remindAt, Infinity);
  if (ta !== tb) return ta - tb;
  return (toMillis(a.createdAt, 0)) - (toMillis(b.createdAt, 0));
}

// ── public API ────────────────────────────────────────────────────────────────

// Read-path: reminders soonest-first. `status` is one of
// 'all' | 'pending' | 'done' | 'dismissed'; an unknown value is treated as 'all'.
export function list({ status = 'all' } = {}) {
  const store = loadStore();
  const want = asString(status).trim().toLowerCase() || 'all';
  const filtered = want === 'all' || !VALID_STATUS.has(want)
    ? store.reminders
    : store.reminders.filter((r) => r.status === want);
  return filtered.slice().sort(bySoonest).map(publicView);
}

// Read-path: the full reminder, or null when the id is unknown.
export function get(id) {
  const store = loadStore();
  const r = store.reminders.find((x) => x.id === id);
  return r ? publicView(r) : null;
}

// Write-path: {ok, id} on success, {ok:false, error} otherwise. Never throws.
// Requires a non-empty `note` and a parseable `remindAt`. `refType`/`refId` are
// optional free-form links back to the source object (e.g. an email or task).
export function create(input = {}) {
  try {
    const src = input && typeof input === 'object' ? input : {};
    const note = asString(src.note).trim();
    if (!note) return { ok: false, error: 'create: note is required' };
    const when = parseInstant(src.remindAt);
    if (!when.ok) return { ok: false, error: `create: ${when.error}` };

    const now = new Date().toISOString();
    const reminder = {
      id: randomUUID(),
      note: note.slice(0, MAX_NOTE_LEN),
      remindAt: when.iso,
      status: 'pending',
      refType: normRef(src.refType),
      refId: normRef(src.refId),
      snoozedCount: 0,
      createdAt: now,
      updatedAt: now,
      doneAt: null,
    };
    const store = loadStore();
    store.reminders.push(reminder);
    saveStore(store);
    return { ok: true, id: reminder.id };
  } catch (e) {
    return { ok: false, error: `create: ${e?.message || e}` };
  }
}

// Write-path: patch is any subset of {note, remindAt, status, refType, refId}.
// Provided fields replace the old value; `updatedAt` is bumped. Setting status
// to 'done' stamps `doneAt`; any other status clears it. {ok} on success,
// {ok:false, error} otherwise. Never throws.
export function update(id, patch = {}) {
  try {
    const store = loadStore();
    const r = store.reminders.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'update: reminder not found' };
    const p = patch && typeof patch === 'object' ? patch : {};

    if (p.remindAt !== undefined) {
      const when = parseInstant(p.remindAt);
      if (!when.ok) return { ok: false, error: `update: ${when.error}` };
      r.remindAt = when.iso;
    }
    if (p.status !== undefined) {
      const status = asString(p.status).trim().toLowerCase();
      if (!VALID_STATUS.has(status)) return { ok: false, error: 'update: status must be pending|done|dismissed' };
      r.status = status;
      r.doneAt = status === 'done' ? (r.doneAt || new Date().toISOString()) : null;
    }
    if (p.note !== undefined) {
      const note = asString(p.note).trim();
      if (!note) return { ok: false, error: 'update: note cannot be emptied' };
      r.note = note.slice(0, MAX_NOTE_LEN);
    }
    if (p.refType !== undefined) r.refType = normRef(p.refType);
    if (p.refId !== undefined) r.refId = normRef(p.refId);

    r.updatedAt = new Date().toISOString();
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
    const before = store.reminders.length;
    store.reminders = store.reminders.filter((r) => r.id !== id);
    if (store.reminders.length === before) return { ok: false, error: 'remove: reminder not found' };
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `remove: ${e?.message || e}` };
  }
}

// Write-path: push `remindAt` to now + `minutes` and re-arm the reminder
// (status → 'pending', `doneAt` cleared, `snoozedCount` incremented). `minutes`
// must be a positive finite number (≤ one year). {ok, remindAt} on success,
// {ok:false, error} otherwise. Never throws.
export function snooze(id, minutes) {
  try {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: 'snooze: minutes must be a positive number' };
    if (mins > MAX_SNOOZE_MIN) return { ok: false, error: `snooze: minutes must be ≤ ${MAX_SNOOZE_MIN}` };

    const store = loadStore();
    const r = store.reminders.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'snooze: reminder not found' };

    const next = new Date(Date.now() + Math.round(mins * 60_000)).toISOString();
    r.remindAt = next;
    r.status = 'pending';
    r.doneAt = null;
    r.snoozedCount += 1;
    r.updatedAt = new Date().toISOString();
    saveStore(store);
    return { ok: true, remindAt: next };
  } catch (e) {
    return { ok: false, error: `snooze: ${e?.message || e}` };
  }
}

// Write-path: mark a reminder done (idempotent) and stamp `doneAt`. {ok} on
// success, {ok:false, error} otherwise. Never throws.
export function markDone(id) {
  try {
    const store = loadStore();
    const r = store.reminders.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'markDone: reminder not found' };
    r.status = 'done';
    r.doneAt = r.doneAt || new Date().toISOString();
    r.updatedAt = new Date().toISOString();
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `markDone: ${e?.message || e}` };
  }
}

// Read-path (polled by the server): pending reminders whose remindAt has arrived
// (remindAt <= now), soonest-first. `now` is optional — an ISO string or epoch-ms
// number; anything missing/unparseable falls back to the current time. Reminders
// with an unparseable remindAt are never considered due. Never throws.
export function due(now) {
  const store = loadStore();
  const cutoff = toMillis(now, Date.now());
  return store.reminders
    .filter((r) => {
      if (r.status !== 'pending') return false;
      const t = toMillis(r.remindAt, NaN);
      return !Number.isNaN(t) && t <= cutoff;
    })
    .sort(bySoonest)
    .map(publicView);
}

// Read-path: badge counts for the sidebar bell. `due` counts pending reminders
// already at or past `now` (same rule as due()). Never throws.
export function counts(now) {
  const store = loadStore();
  const cutoff = toMillis(now, Date.now());
  const out = { total: store.reminders.length, pending: 0, due: 0, done: 0, dismissed: 0 };
  for (const r of store.reminders) {
    if (r.status === 'done') out.done++;
    else if (r.status === 'dismissed') out.dismissed++;
    else {
      out.pending++;
      const t = toMillis(r.remindAt, NaN);
      if (!Number.isNaN(t) && t <= cutoff) out.due++;
    }
  }
  return out;
}

export const Reminders = { list, get, create, update, remove, snooze, markDone, due, counts };

export default Reminders;
