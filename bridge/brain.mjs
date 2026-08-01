// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — BRAIN: what the owner's agent knows about them
//
// Memories used to live in the browser's localStorage. That made them invisible to
// everything that runs server-side — pi above all — so the agent could be told
// "remember this" and had no place to put it, and the panel was the only reader of
// its own store. Here they are on disk, behind the same RPC surface every other
// module uses, which means three things at once:
//
//   • the BRAIN panel reads and writes them
//   • pi writes them itself, through app_rpc{module:"brain"} — a memory the owner
//     states in a conversation lands in the panel without anyone copying it
//   • the CODE and LAB prompts read the same rows, so what the panel shows IS what
//     the model was told
//
// A memory is a short fact ABOUT the owner, filed under a topic. It is never an
// instruction: the consumer fences it as data (see brainMemoryBlock in the panel).
// Zero npm deps — Node built-ins only.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// The topics a memory can be filed under. Deliberately few and concrete: a taxonomy
// nobody can hold in their head gets used as one bucket. 'contact' was here and left
// with the CONTACTS panel — there is nowhere in the app to hold a person any more.
export const TOPICS = ['identity', 'preference', 'project', 'fact'];
const DEFAULT_TOPIC = 'fact';

const MAX_MEMORIES = 500;      // a store, not a log
const MAX_TEXT = 1000;         // one fact, not a document
const RECALL_LIMIT = 40;       // what actually reaches a prompt

const store = openStore({
  name: 'brain',
  version: 1,
  shape: { memories: [], enabled: true },
  root: hubRoot(),
});

const now = () => Date.now();
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const topicOf = (t) => (TOPICS.includes(String(t)) ? String(t) : DEFAULT_TOPIC);

function load() {
  const s = store.read();
  if (!Array.isArray(s.memories)) s.memories = [];
  if (typeof s.enabled !== 'boolean') s.enabled = true;
  return s;
}

/** @returns {{ok:true, memories:Array, enabled:boolean, topics:string[], counts:Record<string,number>}} */
export function list(opts = {}) {
  // `opts || {}`: JSON has no `undefined`, so an omitted options bag arrives over RPC as
  // null — and a `= {}` default only ever fires for undefined. Without this the destructure
  // throws a V8 internal ("Cannot destructure property …") instead of answering the call.
  const { topic, q } = opts || {};
  const s = load();
  let rows = s.memories.slice();
  if (topic && topic !== 'all') rows = rows.filter((m) => m.topic === topic);
  if (q) { const n = String(q).toLowerCase(); rows = rows.filter((m) => (m.text || '').toLowerCase().includes(n)); }
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const counts = {};
  for (const t of TOPICS) counts[t] = s.memories.filter((m) => m.topic === t).length;
  return { ok: true, memories: rows, enabled: s.enabled, topics: TOPICS, counts, total: s.memories.length };
}

/**
 * Add a memory. Called by the panel AND by pi — so the same guard has to hold for a
 * client the owner is driving and for an agent writing on their behalf.
 * @param {{text:string, topic?:string, source?:string}} input
 */
export function add(input = {}) {
  const text = clean(input.text).slice(0, MAX_TEXT);
  if (!text) return { ok: false, error: 'a memory needs some text' };
  const s = load();
  // Same fact twice is not two memories. Compared on the flattened text, so spacing
  // and case cannot smuggle a duplicate past.
  const key = text.toLowerCase();
  const dup = s.memories.find((m) => (m.text || '').toLowerCase() === key);
  if (dup) return { ok: true, id: dup.id, duplicate: true };
  const row = {
    id: 'm' + randomUUID().slice(0, 8),
    text,
    topic: topicOf(input.topic),
    source: clean(input.source).slice(0, 40) || 'owner',
    ts: now(),
  };
  s.memories.unshift(row);
  if (s.memories.length > MAX_MEMORIES) s.memories.length = MAX_MEMORIES;
  store.write(s);
  return { ok: true, id: row.id, memory: row };
}

/** @param {string} id @param {{text?:string, topic?:string}} patch */
export function update(id, patch = {}) {
  const s = load();
  const m = s.memories.find((x) => x.id === id);
  if (!m) return { ok: false, error: 'no memory with that id' };
  if (patch.text !== undefined) {
    const t = clean(patch.text).slice(0, MAX_TEXT);
    if (!t) return { ok: false, error: 'a memory needs some text' };
    m.text = t;
  }
  if (patch.topic !== undefined) m.topic = topicOf(patch.topic);
  m.editedAt = now();
  store.write(s);
  return { ok: true, memory: m };
}

/** @param {string|string[]} ids */
export function remove(ids) {
  const want = new Set(Array.isArray(ids) ? ids : [ids]);
  const s = load();
  const before = s.memories.length;
  s.memories = s.memories.filter((m) => !want.has(m.id));
  store.write(s);
  return { ok: true, removed: before - s.memories.length };
}

/** Master switch: off means nothing reaches a prompt, and the rows are kept. */
export function setEnabled(on) {
  const s = load();
  s.enabled = !!on;
  store.write(s);
  return { ok: true, enabled: s.enabled };
}

/** Drop exact duplicates left by an older store or a careless import. */
export function tidy() {
  const s = load();
  const seen = new Set();
  const before = s.memories.length;
  s.memories = s.memories.filter((m) => {
    const k = clean(m.text).toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k); m.text = clean(m.text); m.topic = topicOf(m.topic);
    return true;
  });
  store.write(s);
  return { ok: true, removed: before - s.memories.length };
}

/**
 * One-time move of the browser store onto disk. The panel hands over whatever it had
 * in localStorage the first time it finds the bridge store empty; nothing is lost and
 * nothing is duplicated, because add() already refuses a repeat of the same text.
 */
export function importMemories(rows) {
  if (!Array.isArray(rows)) return { ok: false, error: 'rows must be an array' };
  let added = 0;
  for (const r of rows.slice(0, MAX_MEMORIES)) {
    if (!r || typeof r.text !== 'string') continue;
    const res = add({ text: r.text, topic: r.type || r.topic, source: r.source || 'imported' });
    if (res.ok && !res.duplicate) added++;
  }
  return { ok: true, added };
}

/**
 * What a prompt should carry. Newest first, bounded, and flattened — this runs on
 * every agent turn, so it must be cheap and it must never be able to throw.
 */
export function recall(opts = {}) {
  const { limit } = opts || {};
  try {
    const s = load();
    if (!s.enabled) return { ok: true, enabled: false, memories: [] };
    const n = Math.max(1, Math.min(RECALL_LIMIT, Number(limit) || RECALL_LIMIT));
    const rows = s.memories.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, n)
      .map((m) => ({ text: m.text, topic: m.topic }));
    return { ok: true, enabled: true, memories: rows };
  } catch { return { ok: true, enabled: true, memories: [] }; }
}

export const Brain = { list, add, update, remove, setEnabled, tidy, importMemories, recall, TOPICS };
export default Brain;
