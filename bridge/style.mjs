// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Signatures & Writing Style
//
// Local-only module: signatures, tone rules, and "Extract from Sent" (learns
// the user's writing voice from their own Sent folder so the AI can draft in
// character). Everything persists to ~/.clone-frame-hub/style.json.
//
// Zero npm deps. Node built-ins only. `ask()` from ./llm.mjs is imported
// eagerly (same tier as this module); `./email.mjs` is imported lazily, only
// inside extractFromSent(), so this module carries no IMAP/SMTP dependency
// weight for callers who never learn a style.
//
// Privacy: extractFromSent() reads the last N Sent messages to derive a style
// *summary* (greeting, tone, sentence length, etc.) via one LLM call, then
// discards the raw bodies. Only the derived summary is ever persisted — never
// email content, never secrets. Nothing here is logged.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';
import { ask } from './llm.mjs';

// ── persistence ──────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/style.json, dir
// 0700 / file 0600, tmp-write-then-rename, read-per-call, never logs. The store
// guarantees only the top-level container; the per-field coercion in loadStore
// below (and coerceProfileFields at the extract call site) stays this module's
// job, exactly as before.
function emptyStore() {
  return { signatures: [], toneRules: [], profiles: {} };
}

const store = openStore({ name: 'style', version: 1, shape: emptyStore(), root: hubRoot() });

function loadStore() {
  const data = store.read();
  return {
    signatures: Array.isArray(data.signatures) ? data.signatures : [],
    toneRules: Array.isArray(data.toneRules) ? data.toneRules.filter((r) => typeof r === 'string') : [],
    profiles: data.profiles && typeof data.profiles === 'object' ? data.profiles : {},
  };
}

function saveStore(s) {
  store.write(s);
}

// ── signatures ───────────────────────────────────────────────────────────────

/** @returns {{id,accountId,name,text,html,isDefault,createdAt}[]} */
export function signatures(accountId) {
  const all = loadStore().signatures;
  if (accountId === undefined || accountId === null) return all.slice();
  return all.filter((s) => s.accountId === accountId || s.accountId == null);
}

/**
 * @param {{id?:string, accountId?:string|null, name:string, text:string, html?:string, isDefault?:boolean}} input
 * @returns {{ok:boolean, id?:string, error?:string}}
 */
export function saveSignature(input = {}) {
  const { id, accountId = null, name, text, html = null, isDefault = false } = input;
  if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name is required' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'text is required' };

  const store = loadStore();
  const now = new Date().toISOString();
  let sig;

  if (id) {
    const idx = store.signatures.findIndex((s) => s.id === id);
    if (idx === -1) return { ok: false, error: `unknown signature: ${id}` };
    sig = { ...store.signatures[idx], accountId, name: name.trim(), text, html, isDefault: !!isDefault };
    store.signatures[idx] = sig;
  } else {
    sig = { id: randomUUID(), accountId, name: name.trim(), text, html, isDefault: !!isDefault, createdAt: now };
    store.signatures.push(sig);
  }

  if (sig.isDefault) {
    for (const s of store.signatures) {
      if (s.id !== sig.id && s.accountId === sig.accountId) s.isDefault = false;
    }
  }

  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true, id: sig.id };
}

/** @returns {{ok:boolean, error?:string}} */
export function removeSignature(id) {
  const store = loadStore();
  const idx = store.signatures.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: `unknown signature: ${id}` };
  store.signatures.splice(idx, 1);
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

/** @returns {object|null} account-specific default, else global default, else null */
export function defaultSignature(accountId) {
  const all = loadStore().signatures;
  const own = all.find((s) => s.accountId === accountId && s.isDefault);
  if (own) return own;
  const global = all.find((s) => s.accountId == null && s.isDefault);
  return global || null;
}

// ── tone rules ───────────────────────────────────────────────────────────────

/** @returns {string[]} */
export function getToneRules() {
  return loadStore().toneRules.slice();
}

/** @param {string[]} rules @returns {{ok:boolean, error?:string}} */
export function setToneRules(rules) {
  if (!Array.isArray(rules) || !rules.every((r) => typeof r === 'string')) {
    return { ok: false, error: 'rules must be a string[]' };
  }
  const store = loadStore();
  store.toneRules = rules.map((r) => r.trim()).filter(Boolean);
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

// ── style profile ────────────────────────────────────────────────────────────

/** @returns {object|null} */
export function getProfile(accountId) {
  return loadStore().profiles[accountId] || null;
}

function findSentFolder(folderList) {
  const bySpecial = folderList.find((f) => f.specialUse === '\\Sent');
  if (bySpecial) return bySpecial;
  return folderList.find((f) => /sent|enviad/i.test(f.name || '') || /sent|enviad/i.test(f.path || '')) || null;
}

// Strips ``` fences and pulls out the first balanced {...} — LLMs sometimes
// wrap JSON in prose or code fences despite instructions not to.
function extractJson(text) {
  const stripped = String(text || '').replace(/```(?:json)?/gi, '');
  const start = stripped.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in model response');
  let depth = 0;
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced JSON object in model response');
}

const FORMALITY_VALUES = new Set(['casual', 'neutral', 'formal']);
const EMOJI_VALUES = new Set(['none', 'some', 'lots']);

function coerceProfileFields(raw) {
  return {
    greeting: typeof raw.greeting === 'string' ? raw.greeting : '',
    closing: typeof raw.closing === 'string' ? raw.closing : '',
    formality: FORMALITY_VALUES.has(raw.formality) ? raw.formality : 'neutral',
    avgSentenceLen: Number.isFinite(raw.avgSentenceLen) ? raw.avgSentenceLen : 0,
    emojiUse: EMOJI_VALUES.has(raw.emojiUse) ? raw.emojiUse : 'none',
    punctuation: typeof raw.punctuation === 'string' ? raw.punctuation : '',
    commonPhrases: Array.isArray(raw.commonPhrases) ? raw.commonPhrases.filter((p) => typeof p === 'string').slice(0, 20) : [],
    sampleTone: typeof raw.sampleTone === 'string' ? raw.sampleTone : '',
  };
}

const EXTRACT_SYSTEM_PROMPT = `You analyse a person's sent emails and describe their writing style as STRICT JSON only — no prose, no markdown fences, no explanation. Output exactly one JSON object with this shape:
{"greeting":string,"closing":string,"formality":"casual"|"neutral"|"formal","avgSentenceLen":number,"emojiUse":"none"|"some"|"lots","punctuation":string,"commonPhrases":string[],"sampleTone":string}`;

/**
 * @param {string} accountId
 * @param {{n?:number}} opts
 * @returns {Promise<{ok:boolean, profile?:object, error?:string}>}
 */
export async function extractFromSent(accountId, opts = {}) {
  if (typeof accountId !== 'string' || !accountId) return { ok: false, error: 'accountId is required' };
  const n = Number.isFinite(opts.n) && opts.n > 0 ? Math.floor(opts.n) : 15;

  try {
    const { Email } = await import('./email.mjs');

    const folderList = await Email.folders(accountId);
    const sentFolder = findSentFolder(folderList);
    if (!sentFolder) return { ok: false, error: 'no Sent folder found for this account' };

    const summaries = await Email.list(accountId, sentFolder.path, { limit: n });
    if (!summaries.length) return { ok: false, error: 'no sent messages found' };

    const bodies = [];
    for (const s of summaries) {
      try {
        const full = await Email.message(accountId, sentFolder.path, s.uid);
        const text = (full.text || '').trim();
        if (text) bodies.push(text.slice(0, 2000));
      } catch { /* skip unreadable messages, keep going */ }
    }
    if (!bodies.length) return { ok: false, error: 'no readable sent message bodies found' };

    const userContent = `Here are ${bodies.length} sent emails, separated by "---". Describe the writer's style as the JSON object specified.\n\n${bodies.join('\n---\n')}`;
    const reply = await ask([{ role: 'user', content: userContent }], { system: EXTRACT_SYSTEM_PROMPT, maxTokens: 512 });

    let parsed;
    try {
      parsed = extractJson(reply);
    } catch (e) {
      return { ok: false, error: `could not parse style profile: ${e.message}` };
    }

    const profile = {
      accountId,
      ...coerceProfileFields(parsed),
      extractedFromSent: bodies.length,
      learnedAt: new Date().toISOString(),
    };

    const store = loadStore();
    store.profiles[accountId] = profile;
    saveStore(store);

    return { ok: true, profile };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ── draft prompt helper ──────────────────────────────────────────────────────

/** @returns {string} system-prompt fragment for other modules to prepend when drafting; '' if nothing learned */
export function draftPrompt(accountId) {
  const parts = [];

  const sig = defaultSignature(accountId);
  if (sig) parts.push(`Sign the email with this signature verbatim at the end:\n${sig.text}`);

  const rules = getToneRules();
  if (rules.length) parts.push(`Tone rules to follow:\n- ${rules.join('\n- ')}`);

  const profile = accountId ? getProfile(accountId) : null;
  if (profile) {
    const bits = [];
    if (profile.greeting) bits.push(`typical greeting: "${profile.greeting}"`);
    if (profile.closing) bits.push(`typical closing: "${profile.closing}"`);
    bits.push(`formality: ${profile.formality}`);
    if (profile.avgSentenceLen) bits.push(`avg sentence length: ~${profile.avgSentenceLen} words`);
    bits.push(`emoji use: ${profile.emojiUse}`);
    if (profile.punctuation) bits.push(`punctuation habits: ${profile.punctuation}`);
    if (profile.commonPhrases.length) bits.push(`phrases they use often: ${profile.commonPhrases.join(', ')}`);
    if (profile.sampleTone) bits.push(`overall tone: ${profile.sampleTone}`);
    parts.push(`Write in this person's own voice, learned from their sent emails (${bits.join('; ')}).`);
  }

  if (!parts.length) return '';
  return parts.join('\n\n');
}

export const Style = {
  signatures,
  saveSignature,
  removeSignature,
  defaultSignature,
  getToneRules,
  setToneRules,
  getProfile,
  extractFromSent,
  draftPrompt,
};

export default Style;
