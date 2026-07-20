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

// Drops the oldest non-pending items first so nothing awaiting a human
// decision is ever silently discarded by the cap.
function enforceCap(items) {
  if (items.length <= MAX_ITEMS) return items;
  const pending = items.filter((it) => it.status === 'pending');
  const rest = items.filter((it) => it.status !== 'pending').slice(-(Math.max(MAX_ITEMS - pending.length, 0)));
  const kept = [...rest, ...pending];
  kept.sort((a, b) => a.createdAt - b.createdAt);
  return kept.slice(-MAX_ITEMS);
}

// ── queries ──────────────────────────────────────────────────────────────────

/** @returns {object[]} newest first, optionally filtered by status */
export function list({ status } = {}) {
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

    const result = await Email.send(item.accountId, {
      to: item.to,
      cc: item.cc,
      bcc: item.bcc,
      subject: item.subject,
      text: item.body,
      inReplyTo: item.inReplyTo || undefined,
    });

    if (!result || result.ok !== true) {
      item.error = (result && result.error) || 'send failed';
      saveStore(store);
      return { ok: false, error: item.error };
    }

    item.status = 'sent';
    item.decidedAt = Date.now();
    item.sentMessageId = result.messageId || null;
    item.error = null;
    saveStore(store);
    return { ok: true, messageId: item.sentMessageId };
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
