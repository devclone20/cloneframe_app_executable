// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Scheduled Send Engine
//
// Backs the Mail app's "Scheduled" folder: emails a user composes now but wants
// delivered at a future instant. `schedule()` records the intent; the host
// server calls `tick()` on an interval (it does not run its own timers) — any
// pending item whose `sendAt` has passed is handed to `./email.mjs`'s
// `Email.send()`. Zero npm dependencies — Node built-ins only (`fs`, `path`,
// `os`, `crypto`). `./email.mjs` is imported lazily, only inside `tick()`, so
// loading this module never pulls in the IMAP/SMTP stack.
//
// Scheduled emails persist to ~/.clone-frame-hub/scheduled.json (file 0600,
// directory 0700) via an atomic tmp-write-then-rename. A missing or corrupt
// store degrades to empty; it never throws. Bodies and addresses are never
// logged — failures are recorded on the record itself (`error`), never printed.
//
// Routed through hub-bridge's generic module RPC (POST /mod/scheduled
// {fn,args}); the server invokes each exported method as obj.fn(...args), so
// every method is directly callable with plain JSON arguments and returns
// JSON-serializable values. Write-path methods return {ok, ...} and never
// throw for an expected failure (they return {ok:false, error} instead).
// Read-path methods return values directly. Public surface: `Scheduled` object
// + named exports. See SCHEDULED.md.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// ── limits ────────────────────────────────────────────────────────────────────
const STORE_VERSION = 1;
const MAX_SUBJECT_LEN = 998; // RFC 5322 header line length ceiling
const MAX_BODY_LEN = 500_000; // 500KB — generous ceiling for a composed message body
const MAX_ADDR_FIELD_LEN = 4_000; // to/cc/bcc, comma-joined
const MAX_ATTEMPTS = 3;

const VALID_STATUS = new Set(['pending', 'sent', 'failed', 'canceled']);

// ── persistence ───────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/scheduled.json,
// dir 0700 / file 0600, tmp-write-then-rename, read-per-call, never logs. The
// per-record coercion (isValidRecord + sanitizeRecord) stays this module's job.
//
// Every WRITE-path method (schedule/cancel/reschedule/tick) goes through
// store.mutate(), whose per-handle in-process queue serializes read-modify-write
// sections — even when the section awaits I/O. This closes the tick() lost-update
// window: tick() holds a snapshot across an `await Email.send()` per due item
// before its single trailing save, so a concurrent cancel()/schedule()/
// reschedule() that loaded-and-saved independently used to be silently clobbered
// by tick()'s stale-snapshot save (last-write-wins). Under mutate() those callers
// queue behind tick() instead. As a consequence the write-path methods are now
// async (Promise-returning); the RPC dispatcher already awaits every method, and
// the only in-process caller (hub-bridge's interval) already `await S.tick()`s.
const store = openStore({ name: 'scheduled', version: STORE_VERSION, shape: { items: [] }, root: hubRoot() });

// Coerce a raw store object's items to the canonical shape (the file may be
// hand-edited). Shared by the read wrapper and every mutate() section.
function coerceItems(data) {
  return Array.isArray(data?.items) ? data.items.filter(isValidRecord).map(sanitizeRecord) : [];
}

// Read-path (sync): the coerced store, exactly as the old loadStore() returned.
function loadStore() {
  return { version: STORE_VERSION, items: coerceItems(store.read()) };
}

// Inside a mutate(fn): normalize the raw `data` in place to the canonical
// {version, items} shape — coerce items, drop any stray hand-edited top-level
// keys — so the trailing write persists exactly what loadStore()→saveStore()
// would have. Returns the coerced items array for the caller to operate on.
function normalizeInPlace(data) {
  const items = coerceItems(data);
  for (const k of Object.keys(data)) if (k !== 'version' && k !== 'items') delete data[k];
  data.version = STORE_VERSION;
  data.items = items;
  return items;
}

// ── value coercion ────────────────────────────────────────────────────────────
function asString(v) {
  return typeof v === 'string' ? v : String(v ?? '');
}

// Normalize a user-supplied instant into a canonical UTC ISO string. Accepts an
// ISO/RFC-2822 string or an epoch-ms number. Returns {ok, iso} or {ok:false,
// error}. Never throws.
function parseInstant(v) {
  if (v == null || v === '') return { ok: false, error: 'sendAt is required' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, error: 'sendAt is not a finite timestamp' };
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? { ok: false, error: 'sendAt is not a valid timestamp' } : { ok: true, iso: d.toISOString() };
  }
  if (typeof v === 'string') {
    const t = Date.parse(v.trim());
    return Number.isNaN(t) ? { ok: false, error: 'sendAt is not a parseable date/time' } : { ok: true, iso: new Date(t).toISOString() };
  }
  return { ok: false, error: 'sendAt must be an ISO string or epoch-ms number' };
}

// A tolerant instant → epoch-ms for reads (`now`, comparisons). Bad input
// yields NaN so callers can decide the fallback; this never throws.
function toMillis(v, fallback = NaN) {
  if (v == null || v === '') return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  const t = Date.parse(asString(v).trim());
  return Number.isNaN(t) ? fallback : t;
}

// to/cc/bcc are stored as-authored (string or comma-joined array) and only
// split into individual addresses at send time by email.mjs itself.
function normAddrField(v) {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.map(asString).join(', ') : asString(v);
  return s.trim().slice(0, MAX_ADDR_FIELD_LEN);
}

// ── record shape ──────────────────────────────────────────────────────────────
function isValidRecord(r) {
  return !!r && typeof r === 'object' && r.id != null && String(r.id).length > 0;
}

// Defensive coercion for entries read back from disk (may be hand-edited): every
// field is re-typed to the canonical shape so a partial/garbled record still
// loads cleanly instead of poisoning a read.
function sanitizeRecord(r) {
  const created = typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString();
  const status = VALID_STATUS.has(r.status) ? r.status : 'pending';
  const sendAt = parseInstant(r.sendAt);
  return {
    id: String(r.id),
    accountId: asString(r.accountId),
    to: normAddrField(r.to),
    cc: normAddrField(r.cc),
    bcc: normAddrField(r.bcc),
    subject: asString(r.subject).slice(0, MAX_SUBJECT_LEN),
    body: asString(r.body).slice(0, MAX_BODY_LEN),
    sendAt: sendAt.ok ? sendAt.iso : asString(r.sendAt),
    status,
    attempts: Number.isInteger(r.attempts) && r.attempts >= 0 ? r.attempts : 0,
    createdAt: created,
    sentAt: typeof r.sentAt === 'string' ? r.sentAt : null,
    sentMessageId: typeof r.sentMessageId === 'string' ? r.sentMessageId : null,
    error: typeof r.error === 'string' ? r.error : null,
  };
}

// Strict whitelist — the only shape that ever leaves the module. Guarantees no
// stray key from a hand-edited store is ever returned. There are no secret
// fields on a scheduled email, but the whitelist is kept anyway for the same
// hygiene reason reminders.mjs keeps one.
function publicView(r) {
  return {
    id: r.id,
    accountId: r.accountId,
    to: r.to,
    cc: r.cc,
    bcc: r.bcc,
    subject: r.subject,
    body: r.body,
    sendAt: r.sendAt,
    status: r.status,
    attempts: r.attempts,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    sentMessageId: r.sentMessageId,
    error: r.error,
  };
}

// ── ordering ──────────────────────────────────────────────────────────────────
// Newest sendAt first; records with an unparseable sendAt sort last, with a
// stable createdAt tiebreak so equal instants keep a deterministic order.
function byNewestSendAt(a, b) {
  const ta = toMillis(a.sendAt, -Infinity);
  const tb = toMillis(b.sendAt, -Infinity);
  if (ta !== tb) return tb - ta;
  return toMillis(b.createdAt, 0) - toMillis(a.createdAt, 0);
}

// ── public API ────────────────────────────────────────────────────────────────

// Write-path: {ok, id} on success, {ok:false, error} otherwise. Never throws.
// Requires accountId, to, subject, a body, and a sendAt strictly in the future.
export async function schedule(input = {}) {
  try {
    const src = input && typeof input === 'object' ? input : {};
    const accountId = asString(src.accountId).trim();
    if (!accountId) return { ok: false, error: 'schedule: accountId is required' };
    const to = normAddrField(src.to);
    if (!to) return { ok: false, error: 'schedule: to is required' };
    const subject = asString(src.subject).trim();
    if (!subject) return { ok: false, error: 'schedule: subject is required' };
    const body = asString(src.body);
    if (!body) return { ok: false, error: 'schedule: body is required' };

    const when = parseInstant(src.sendAt);
    if (!when.ok) return { ok: false, error: `schedule: ${when.error}` };
    if (toMillis(when.iso) <= Date.now()) return { ok: false, error: 'schedule: sendAt must be in the future' };

    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      accountId,
      to,
      cc: normAddrField(src.cc),
      bcc: normAddrField(src.bcc),
      subject: subject.slice(0, MAX_SUBJECT_LEN),
      body: body.slice(0, MAX_BODY_LEN),
      sendAt: when.iso,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      sentAt: null,
      sentMessageId: null,
      error: null,
    };

    return await store.mutate((data) => {
      const items = normalizeInPlace(data);
      items.push(record);
      return { ok: true, id: record.id };
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Read-path: scheduled emails, newest sendAt first. `status` is one of
// 'all' | 'pending' | 'sent' | 'failed' | 'canceled'; an unknown value is
// treated as 'all'.
export function list(opts = {}) {
  // `opts || {}`: JSON has no `undefined`, so an omitted options bag arrives over RPC as
  // null — and a `= {}` default only ever fires for undefined. Without this the destructure
  // throws a V8 internal ("Cannot destructure property …") instead of answering the call.
  const { status = 'all' } = opts || {};
  const store = loadStore();
  const want = asString(status).trim().toLowerCase() || 'all';
  const filtered = want === 'all' || !VALID_STATUS.has(want)
    ? store.items
    : store.items.filter((r) => r.status === want);
  return filtered.slice().sort(byNewestSendAt).map(publicView);
}

// Read-path: the full record, or null when the id is unknown.
export function get(id) {
  const store = loadStore();
  const r = store.items.find((x) => x.id === id);
  return r ? publicView(r) : null;
}

// Write-path: {ok} on success, {ok:false, error} otherwise. Only a 'pending'
// item can be canceled. Never throws.
export async function cancel(id) {
  try {
    return await store.mutate((data) => {
      const items = normalizeInPlace(data);
      const r = items.find((x) => x.id === id);
      if (!r) return { ok: false, error: 'cancel: unknown id' };
      if (r.status !== 'pending') return { ok: false, error: `cancel: item is '${r.status}', not 'pending'` };
      r.status = 'canceled';
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Write-path: {ok} on success, {ok:false, error} otherwise. Only a 'pending'
// item can be rescheduled; the new sendAt must be in the future. Never throws.
export async function reschedule(id, sendAt) {
  try {
    return await store.mutate((data) => {
      const items = normalizeInPlace(data);
      const r = items.find((x) => x.id === id);
      if (!r) return { ok: false, error: 'reschedule: unknown id' };
      if (r.status !== 'pending') return { ok: false, error: `reschedule: item is '${r.status}', not 'pending'` };
      const when = parseInstant(sendAt);
      if (!when.ok) return { ok: false, error: `reschedule: ${when.error}` };
      if (toMillis(when.iso) <= Date.now()) return { ok: false, error: 'reschedule: sendAt must be in the future' };
      r.sendAt = when.iso;
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Read-path: pending items whose sendAt has already passed, newest-first (same
// ordering as list()). Does not send anything or mutate the store. `now`
// accepts an ISO string or epoch-ms for testability; defaults to Date.now().
export function due(now) {
  const cutoff = now == null ? Date.now() : toMillis(now, Date.now());
  const store = loadStore();
  return store.items
    .filter((r) => r.status === 'pending' && toMillis(r.sendAt, Infinity) <= cutoff)
    .slice()
    .sort(byNewestSendAt)
    .map(publicView);
}

// Called periodically by the host server (not by a timer owned by this
// module). Finds every pending, due item, lazily imports ./email.mjs, and
// sends each via Email.send(). On success the record is marked 'sent' with
// the returned messageId. On failure `attempts` is incremented and the error
// is stored; the record stays 'pending' for retry until it has failed
// `MAX_ATTEMPTS` times, at which point it is marked 'failed' and no longer
// retried. Never throws — a hard failure (e.g. email.mjs itself fails to
// import) is caught per-item so one bad record can't stall the rest of the
// batch.
export async function tick() {
  const cutoff = Date.now();
  // Fast path: nothing due → no mutation and no write at all (matches the
  // original's early return; avoids rewriting the store on every idle interval
  // and avoids taking the mutate() lock when there is no work to serialize).
  if (!loadStore().items.some((r) => r.status === 'pending' && toMillis(r.sendAt, Infinity) <= cutoff)) {
    return { sent: 0, failed: 0 };
  }

  // Work path: the whole read-modify-write — including the awaited Email.send()
  // per due item — runs under ONE serialized mutate() section, so a concurrent
  // schedule()/cancel()/reschedule() queues behind us instead of being clobbered
  // by our trailing save. The store is RE-READ fresh inside mutate() (the
  // fast-path snapshot above is only a lock-avoidance hint).
  return store.mutate(async (data) => {
    const result = { sent: 0, failed: 0 };
    const items = normalizeInPlace(data);
    const nowCutoff = Date.now();
    const dueItems = items.filter((r) => r.status === 'pending' && toMillis(r.sendAt, Infinity) <= nowCutoff);
    if (!dueItems.length) return result;

    let Email;
    try {
      ({ default: Email } = await import('./email.mjs'));
    } catch (e) {
      // The send stack itself is unavailable — every due item fails this pass
      // and is left pending (unless it has already exhausted its attempts) so
      // the next tick() can retry once the import succeeds.
      for (const r of dueItems) recordFailure(r, `email.mjs import failed: ${e?.message || String(e)}`);
      result.failed = dueItems.length;
      return result;
    }

    for (const r of dueItems) {
      r.attempts += 1;
      try {
        const outcome = await Email.send(r.accountId, {
          to: r.to,
          cc: r.cc || undefined,
          bcc: r.bcc || undefined,
          subject: r.subject,
          text: r.body,
        });
        if (outcome?.ok) {
          r.status = 'sent';
          r.sentAt = new Date().toISOString();
          r.sentMessageId = outcome.messageId || null;
          r.error = null;
          result.sent += 1;
        } else {
          applyFailureOutcome(r, outcome?.error || 'send failed');
          result.failed += 1;
        }
      } catch (e) {
        applyFailureOutcome(r, e?.message || String(e));
        result.failed += 1;
      }
    }

    return result;
  });
}

// attempts is already incremented by the caller before the send attempt; this
// only decides whether the record keeps retrying or gives up.
function applyFailureOutcome(r, message) {
  r.error = message;
  r.status = r.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
}

// Used for the email.mjs-import-unavailable path, where no attempt was made
// against a specific transport but the item still needs an attempt counted so
// it doesn't retry forever if email.mjs never becomes importable.
function recordFailure(r, message) {
  r.attempts += 1;
  applyFailureOutcome(r, message);
}

export const Scheduled = {
  schedule,
  list,
  get,
  cancel,
  reschedule,
  due,
  tick,
};

export default Scheduled;
