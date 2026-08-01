// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Email Approval Queue
//
// Human-in-the-loop gate: AI-drafted emails (replies or new mail) sit here as
// 'pending' until the user approves (→ sent via email.mjs) or rejects them.
// Nothing is ever sent without an explicit approve() call from the UI.
//
// Dependencies: Node built-ins only. email.mjs is lazy dynamic-imported inside
// approve() so a load-order issue in that module never breaks importing this one.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// ── persistence ──────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/approvals.json,
// dir 0700 / file 0600, tmp-write-then-rename, read-per-call, never logs. The
// store guarantees only the top-level container; the per-item status/type
// coercion below stays this module's job, exactly as before.
const store = openStore({ name: 'approvals', version: 1, shape: { items: [] }, root: hubRoot() });
const MAX_ITEMS = 200;

const STATUSES = new Set(['pending', 'approved', 'rejected', 'sent']);
const TYPES = new Set(['ai_reply', 'ai_email']);
const EDITABLE_FIELDS = ['to', 'cc', 'bcc', 'subject', 'body'];

function loadStore() {
  const data = store.read();
  return { items: Array.isArray(data.items) ? data.items : [] };
}

function saveStore(s) {
  store.write(s);
}

// Drops the oldest DECIDED items first so nothing awaiting a human decision is ever silently
// discarded by the cap.
//
// The old version ended with `kept.slice(-MAX_ITEMS)`, applied to pending and decided alike —
// so once pending alone reached the cap it deleted the OLDEST PENDING items, which is exactly
// the promise above, inverted. (`slice(-(Math.max(MAX_ITEMS - pending.length, 0)))` was its
// own trap: at 200 pending that is `slice(-0)`, and `slice(-0)` is `slice(0)` — the whole
// decided list, kept.)
//
// Pending is never truncated. If a human has 200 unanswered approvals the answer is not to
// throw the oldest away behind their back.
function enforceCap(items) {
  if (items.length <= MAX_ITEMS) return items;
  const pending = items.filter((it) => it.status === 'pending');
  const decided = items.filter((it) => it.status !== 'pending').sort((a, b) => a.createdAt - b.createdAt);
  const room = Math.max(MAX_ITEMS - pending.length, 0);
  const kept = [...decided.slice(decided.length - room), ...pending];
  kept.sort((a, b) => a.createdAt - b.createdAt);
  return kept;
}

// ── queries ──────────────────────────────────────────────────────────────────

/** @returns {object[]} newest first, optionally filtered by status */
export function list(opts = {}) {
  // `opts || {}`: JSON has no `undefined`, so an omitted options bag arrives over RPC as
  // null — and a `= {}` default only ever fires for undefined. Without this the destructure
  // throws a V8 internal ("Cannot destructure property …") instead of answering the call.
  const { status } = opts || {};
  const { items } = loadStore();
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  if (status === undefined) return sorted;
  if (!STATUSES.has(status)) return [];
  return sorted.filter((it) => it.status === status);
}

/** @returns {object|null} */
export function get(id) {
  if (!id) return null;
  const { items } = loadStore();
  return items.find((it) => it.id === id) || null;
}

/** @returns {{pending:number, total:number}} */
export function count() {
  const { items } = loadStore();
  return { pending: items.filter((it) => it.status === 'pending').length, total: items.length };
}

// ── mutations ────────────────────────────────────────────────────────────────

/** @returns {{ok:boolean, id?:string, error?:string}} */
export function add(item = {}) {
  if (!item || typeof item !== 'object') return { ok: false, error: 'item is required' };
  const { type, accountId, to, cc, bcc, subject, body, sourceUid, folder, generatedBy, inReplyTo } = item;

  if (!accountId || typeof accountId !== 'string') return { ok: false, error: 'accountId is required' };
  if (!to || (Array.isArray(to) ? to.length === 0 : typeof to !== 'string')) {
    return { ok: false, error: 'to is required' };
  }
  if (body === undefined || body === null || body === '') return { ok: false, error: 'body is required' };
  const safeType = TYPES.has(type) ? type : 'ai_email';

  const record = {
    id: randomUUID(),
    type: safeType,
    accountId,
    to,
    cc: cc ?? undefined,
    bcc: bcc ?? undefined,
    subject: subject ?? '',
    body,
    sourceUid: sourceUid ?? null,
    folder: folder ?? null,
    generatedBy: generatedBy ?? null,
    inReplyTo: inReplyTo ?? null,
    status: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    sentMessageId: null,
    error: null,
  };

  try {
    const store = loadStore();
    store.items = enforceCap([...store.items, record]);
    saveStore(store);
    return { ok: true, id: record.id };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** @returns {{ok:boolean, messageId?:string, error?:string}} */
export async function approve(id) {
  try {
    const store = loadStore();
    const item = store.items.find((it) => it.id === id);
    if (!item) return { ok: false, error: 'not found' };
    if (item.status !== 'pending') return { ok: false, error: `cannot approve item in status '${item.status}'` };

    let Email;
    try {
      ({ Email } = await import('./email.mjs'));
    } catch (e) {
      return { ok: false, error: `email module unavailable: ${e.message || e}` };
    }

    // CLAIM IT FIRST, and write the claim to disk before the socket opens.
    //
    // This used to be one read-modify-write wrapped around `await Email.send()` — a fresh
    // nodemailer transport, so connect + TLS + AUTH + DATA, routinely 1-3 seconds. Two things
    // went wrong in that window, both silently:
    //   · two approvals of the same item (a second click, a second window, the scheduler)
    //     both read status 'pending' and BOTH SENT. The recipient got it twice.
    //   · every other write to this store — a reject, an agent's approvals.add, a prune —
    //     was overwritten when the stale snapshot was finally saved.
    // 'approved' already existed in STATUSES and was unused. It is the right word: the owner
    // said yes and it is on its way. The panel shows it as a badge with no buttons, and
    // count() ignores it, so the APPROVAL badge clears the moment you click.
    item.status = 'approved';
    item.decidedAt = Date.now();
    saveStore(store);

    // The claim is on disk, so from here EVERY exit must put it back. A throw used to fall
    // through to the outer catch with the item still 'approved' — not pending, so the panel
    // rendered it as a badge with no buttons, and not sent, so it never went. The owner's
    // draft became unreachable from either side. Only the returned-{ok:false} path rolled back.
    let result;
    try {
      result = await Email.send(item.accountId, {
        to: item.to,
        cc: item.cc,
        bcc: item.bcc,
        subject: item.subject,
        text: item.body,
        inReplyTo: item.inReplyTo || undefined,
      });
    } catch (e) {
      const back = loadStore();
      const row0 = back.items.find((it) => it.id === id);
      if (row0) { row0.status = 'pending'; row0.decidedAt = null; row0.error = (e && e.message) || String(e); saveStore(back); }
      return { ok: false, error: (e && e.message) || String(e) };
    }

    // RE-READ. `store` is now seconds stale; anything written during the send would be lost
    // by saving it. Apply the outcome to a fresh snapshot instead.
    const fresh = loadStore();
    const row = fresh.items.find((it) => it.id === id) || item;

    if (!result || result.ok !== true) {
      // Back to pending so the owner can try again — a failed send must not consume the draft.
      row.status = 'pending';
      row.decidedAt = null;
      row.error = (result && result.error) || 'send failed';
      saveStore(fresh);
      return { ok: false, error: row.error };
    }

    row.status = 'sent';
    row.decidedAt = Date.now();
    row.sentMessageId = result.messageId || null;
    row.error = null;
    saveStore(fresh);
    return { ok: true, messageId: row.sentMessageId };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** @returns {{ok:boolean, error?:string}} */
export function reject(id) {
  try {
    const store = loadStore();
    const item = store.items.find((it) => it.id === id);
    if (!item) return { ok: false, error: 'not found' };
    if (item.status !== 'pending') return { ok: false, error: `cannot reject item in status '${item.status}'` };
    item.status = 'rejected';
    item.decidedAt = Date.now();
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** @returns {{ok:boolean, error?:string}} */
export function edit(id, patch = {}) {
  try {
    const store = loadStore();
    const item = store.items.find((it) => it.id === id);
    if (!item) return { ok: false, error: 'not found' };
    if (item.status !== 'pending') return { ok: false, error: `cannot edit item in status '${item.status}'` };
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch is required' };

    for (const key of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) item[key] = patch[key];
    }
    if (!item.to || (Array.isArray(item.to) ? item.to.length === 0 : typeof item.to !== 'string')) {
      return { ok: false, error: 'to cannot be empty' };
    }
    if (item.body === undefined || item.body === null || item.body === '') {
      return { ok: false, error: 'body cannot be empty' };
    }

    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** @returns {{ok:boolean, error?:string}} */
export function remove(id) {
  try {
    const store = loadStore();
    const before = store.items.length;
    store.items = store.items.filter((it) => it.id !== id);
    if (store.items.length === before) return { ok: false, error: 'not found' };
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

export const Approvals = { list, get, add, approve, reject, edit, remove, count };
export default Approvals;
