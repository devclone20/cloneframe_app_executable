// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Model-Provider Registry & AI Defaults
//
// BYOK registry of AI model providers, plus the per-capability default map that
// powers Settings ("Add Models", "Added Models", "AI Defaults") and the "Brain".
//
// Two kinds of provider:
//   • local  — an OpenAI-compatible base URL with NO key (Ollama, llama.cpp,
//              vLLM). Prefilled base URLs point at the usual localhost ports.
//   • api    — a hosted provider that needs a base URL + apiKey (OpenAI,
//              Anthropic, DeepSeek, OpenRouter, Groq, Gemini, xAI).
//
// Dependencies: Node built-ins only. Live probes use the global `fetch`
// (undici, built into Node). `./llm.mjs` is lazy dynamic-imported inside
// brainStatus() so a load-order issue there never breaks importing this module.
//
// Security: the apiKey of an `api` provider lives ONLY in the on-disk store
// (file 0600, in a 0700 dir). It is NEVER logged and NEVER returned — every
// value handed to a caller carries `hasApiKey: boolean` in its place. The raw
// key is read back into memory only by the module-private getRecord(), used
// solely by testProvider()/listModels() to perform the live probe.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// ── Keychain-backed API keys (BUG-L7-001: plaintext keys in models.json) ─────
// Keys live in the macOS Keychain (service "CLONE FRAME HUB", account = provider
// id); models.json keeps only the sentinel below. Reads are cached per process.
// Fallback: if `security` is unavailable/fails, the key stays in the 0600 store
// exactly as before — never lose a key to make a point. Keys are never logged.
const KC_SERVICE = 'CLONE FRAME HUB';
const KC_SENTINEL = 'keychain:v1';
const kcCache = new Map();
// The Keychain is ONLY for the real user store. A test pointing the data tree at a
// throwaway root (CLONE_FRAME_HUB_ROOT) must never read or write the user's Keychain.
const kcEnabled = () => !process.env.CLONE_FRAME_HUB_ROOT;
function kcStore(id, key) {
  if (!kcEnabled()) return false;
  try {
    // -U updates in place; argv (not shell) so the key is never shell-parsed.
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-a', id, '-s', KC_SERVICE, '-w', key], { stdio: 'ignore' });
    kcCache.set(id, key);
    return true;
  } catch { return false; }
}
function kcLoad(id) {
  if (!kcEnabled()) return '';
  if (kcCache.has(id)) return kcCache.get(id);
  try {
    const k = execFileSync('/usr/bin/security', ['find-generic-password', '-a', id, '-s', KC_SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/\n$/, '');
    kcCache.set(id, k);
    return k;
  } catch { return ''; }
}
function kcDelete(id) {
  kcCache.delete(id);
  if (!kcEnabled()) return;
  try { execFileSync('/usr/bin/security', ['delete-generic-password', '-a', id, '-s', KC_SERVICE], { stdio: 'ignore' }); } catch { /* absent */ }
}
function resolveKey(r) { return r && r.apiKey === KC_SENTINEL ? kcLoad(r.id) : ((r && r.apiKey) || ''); }

// ── persistence ──────────────────────────────────────────────────────────────
const PROBE_TIMEOUT_MS = 10_000;

// Capabilities the UI always renders in "AI Defaults" (others may be added ad
// hoc via setDefault and will then also appear in getDefaults()).
const CAPABILITIES = ['chat', 'email_summary', 'email_reply', 'email_tags'];

// Prefilled provider catalog. `native:'anthropic'` marks the one provider whose
// wire protocol is NOT OpenAI-compatible (different auth header + models path).
const KNOWN = {
  openai: { label: 'OpenAI', kind: 'api', baseUrl: 'https://api.openai.com/v1', docsUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic', kind: 'api', baseUrl: 'https://api.anthropic.com', docsUrl: 'https://console.anthropic.com/settings/keys', native: 'anthropic' },
  deepseek: { label: 'DeepSeek', kind: 'api', baseUrl: 'https://api.deepseek.com', docsUrl: 'https://platform.deepseek.com/api_keys' },
  openrouter: { label: 'OpenRouter', kind: 'api', baseUrl: 'https://openrouter.ai/api/v1', docsUrl: 'https://openrouter.ai/keys' },
  groq: { label: 'Groq', kind: 'api', baseUrl: 'https://api.groq.com/openai/v1', docsUrl: 'https://console.groq.com/keys' },
  gemini: { label: 'Google Gemini', kind: 'api', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', docsUrl: 'https://aistudio.google.com/apikey' },
  xai: { label: 'xAI (Grok)', kind: 'api', baseUrl: 'https://api.x.ai/v1', docsUrl: 'https://console.x.ai' },
  ollama: { label: 'Ollama', kind: 'local', baseUrl: 'http://localhost:11434/v1', docsUrl: 'https://ollama.com' },
  llamacpp: { label: 'llama.cpp', kind: 'local', baseUrl: 'http://localhost:8080/v1', docsUrl: 'https://github.com/ggml-org/llama.cpp' },
  vllm: { label: 'vLLM', kind: 'local', baseUrl: 'http://localhost:8000/v1', docsUrl: 'https://docs.vllm.ai' },
};

// Backed by the shared atomic JSON store: ~/.clone-frame-hub/models.json, dir
// 0700 / file 0600, tmp-write-then-rename, read-per-call, never logs (the raw
// apiKey lives on disk only and is never surfaced by the store itself). The
// per-record coercion below (providers -> valid objects with a string id;
// defaults -> a plain object) stays this module's job, exactly as before.
const store = openStore({ name: 'models', version: 1, shape: { providers: [], defaults: {} }, root: hubRoot() });

// A missing or corrupt store degrades to empty — it must never throw.
function loadStore() {
  const data = store.read();
  return {
    providers: Array.isArray(data.providers)
      ? data.providers.filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
      : [],
    defaults: data.defaults && typeof data.defaults === 'object' && !Array.isArray(data.defaults) ? data.defaults : {},
  };
}

function saveStore(s) {
  store.write(s);
}

// Internal only — never exported. Returns the raw record (apiKey included),
// used solely by the live-probe paths.
function getRecord(id) {
  if (!id || typeof id !== 'string') return null;
  return loadStore().providers.find((p) => p.id === id) || null;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function isValidUrl(value) {
  try { new URL(value); return true; } catch { return false; }
}

function hostOf(urlStr) {
  if (!urlStr) return null;
  try { return new URL(urlStr).host; } catch { return null; }
}

function normalizeBaseUrl(u) {
  return typeof u === 'string' ? u.trim().replace(/\/+$/, '') : '';
}

function isAnthropic(provider, baseUrl) {
  return provider === 'anthropic' || (KNOWN[provider]?.native === 'anthropic') || hostOf(baseUrl) === 'api.anthropic.com';
}

// Server-only: the exact wire details /provider-chat needs to stream from a
// STORED provider. Returns the apiKey — hence exposed ONLY as `_streamConfig`
// (the RPC dispatcher blocks _-prefixed fns, so a secret can never be returned
// to the client). Consolidates the old two-step `_raw` (whole record) +
// `_isAnthropic` reach into ONE purpose-built accessor for the streaming relay.
// @returns {null | {provider,kind,baseUrl,apiKey,models,anthropic}}
function streamConfig(id) {
  const r = getRecord(id);
  if (!r) return null;
  return {
    provider: r.provider,
    kind: r.kind,
    baseUrl: r.baseUrl || '',
    apiKey: resolveKey(r),
    models: Array.isArray(r.models) ? r.models : [],
    anthropic: isAnthropic(r.provider, r.baseUrl),
  };
}

// Candidate model-list URLs for an OpenAI-compatible base. Handles bases given
// with or without a trailing `/v1`, and bases that already point at `/models`.
function modelsUrls(baseUrl) {
  const b = normalizeBaseUrl(baseUrl);
  if (/\/models$/.test(b)) return [b];
  const urls = [`${b}/models`];
  if (!/\/v\d+(\/|$)/.test(b)) urls.push(`${b}/v1/models`);
  return urls;
}

// Accepts OpenAI (`{data:[{id}]}`), bare arrays, and Ollama-native
// (`{models:[{name}]}`) shapes. Returns a de-duplicated, sorted string[].
function extractModelIds(data) {
  if (!data) return [];
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data.data) ? data.data
    : Array.isArray(data.models) ? data.models
    : [];
  const ids = arr
    .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name || m.model))))
    .filter((x) => typeof x === 'string' && x.trim());
  return [...new Set(ids)].sort();
}

function statusHint(status) {
  if (status === 401 || status === 403) return ' (authentication failed — check the API key)';
  if (status === 404) return ' (no models endpoint at this URL)';
  if (status === 429) return ' (rate limited)';
  if (status >= 500) return ' (provider server error)';
  return '';
}

function describeFetchError(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `timed out after ${PROBE_TIMEOUT_MS / 1000}s`;
  const cause = e?.cause;
  if (cause?.code) return `${cause.code}: ${cause.message || e.message}`;
  return e?.message || String(e);
}

// ── live probes ──────────────────────────────────────────────────────────────
async function probeOpenAICompat({ kind, baseUrl, apiKey }) {
  const headers = {};
  if (kind === 'api' && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let lastErr = 'unreachable';
  for (const url of modelsUrls(baseUrl)) {
    let r;
    try {
      r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (e) {
      return { ok: false, error: describeFetchError(e) }; // network-level failure is authoritative
    }
    if (r.ok) {
      const data = await r.json().catch(() => null);
      return { ok: true, models: extractModelIds(data) };
    }
    lastErr = `HTTP ${r.status}${statusHint(r.status)}`;
    if (r.status !== 404) return { ok: false, error: lastErr }; // only a 404 warrants trying the next path
  }
  return { ok: false, error: lastErr };
}

async function probeAnthropic({ baseUrl, apiKey }) {
  if (!apiKey) return { ok: false, error: 'Anthropic requires an API key' };
  // tolerate a base that already ends in /v1 (e.g. https://api.anthropic.com/v1)
  const base = (normalizeBaseUrl(baseUrl) || 'https://api.anthropic.com').replace(/\/v\d+$/, '');
  const url = `${base}/v1/models`;
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (r.ok) {
      const data = await r.json().catch(() => null);
      const models = extractModelIds(data);
      if (models.length) return { ok: true, models };
      // reachable + authenticated but no list returned — fall through to the ping
    } else if (r.status !== 404) {
      return { ok: false, error: `HTTP ${r.status}${statusHint(r.status)}` };
    }
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
  return probeAnthropicPing(base, apiKey);
}

// Validates the key when /v1/models is unavailable: a tiny messages call. A 401/
// 403 means the key is bad; any other reply means the key authenticated.
async function probeAnthropicPing(base, apiKey) {
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'authentication failed — check the API key' };
    return { ok: true, models: [] };
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
}

async function probeModels(cfg) {
  return isAnthropic(cfg.provider, cfg.baseUrl) ? probeAnthropic(cfg) : probeOpenAICompat(cfg);
}

// ── sanitization ─────────────────────────────────────────────────────────────
function toPublic(r) {
  const models = Array.isArray(r.models) ? r.models.slice() : [];
  return {
    id: r.id,
    kind: r.kind,
    provider: r.provider,
    label: r.label,
    baseUrl: r.baseUrl,
    enabled: r.enabled !== false,
    hasApiKey: !!r.apiKey,
    models,
    disabledModels: Array.isArray(r.disabledModels) ? r.disabledModels.slice() : [],
    modelCount: models.length,
    lastTestedAt: r.lastTestedAt || null,
    lastError: r.lastError || null,
    createdAt: r.createdAt,
  };
}

// Builds the probe config for a stored record or a raw input object, filling a
// missing baseUrl from the known-provider catalog.
function normalizeCfg(input) {
  const kind = input.kind === 'local' ? 'local' : 'api';
  const provider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.toLowerCase().trim() : 'custom';
  const known = KNOWN[provider];
  const baseUrl = normalizeBaseUrl(
    typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl : (known ? known.baseUrl : '')
  );
  const apiKey = kind === 'api' && typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined;
  return { kind, provider, baseUrl, apiKey };
}

// ── public API ───────────────────────────────────────────────────────────────

/** @returns {object[]} sanitized providers, newest first (never includes apiKey) */
export function listProviders() {
  return loadStore().providers
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(toPublic);
}

/** @returns {object[]} the prefill catalog for the "Add Models" picker */
export function knownProviders() {
  return Object.entries(KNOWN).map(([provider, v]) => ({
    provider,
    label: v.label,
    kind: v.kind,
    baseUrl: v.baseUrl,
    keyless: v.kind === 'local',
    docsUrl: v.docsUrl || null,
  }));
}

/** @returns {object|null} sanitized provider by id */
export function getProvider(id) {
  const rec = getRecord(id);
  return rec ? toPublic(rec) : null;
}

/**
 * @param {{kind:'local'|'api', provider?:string, label?:string, baseUrl?:string, apiKey?:string}} input
 * @returns {{ok:boolean, id?:string, error?:string}}
 */
export function addProvider(input = {}) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'input object is required' };
  const kind = input.kind;
  if (kind !== 'local' && kind !== 'api') return { ok: false, error: "kind must be 'local' or 'api'" };

  const provider = typeof input.provider === 'string' && input.provider.trim() ? input.provider.toLowerCase().trim() : 'custom';
  const known = KNOWN[provider];
  const baseUrl = normalizeBaseUrl(
    typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl : (known ? known.baseUrl : '')
  );
  if (!baseUrl) return { ok: false, error: 'baseUrl is required (unknown provider — pass one, or use a known provider)' };
  if (!isValidUrl(baseUrl)) return { ok: false, error: 'baseUrl must be a valid URL' };

  const label = typeof input.label === 'string' && input.label.trim()
    ? input.label.trim()
    : (known ? known.label : (provider !== 'custom' ? provider : hostOf(baseUrl) || 'Provider'));

  let apiKey = null;
  if (kind === 'api') {
    if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) return { ok: false, error: 'apiKey is required for an api provider' };
    apiKey = input.apiKey.trim();
  }

  const store = loadStore();
  const record = {
    id: randomUUID(),
    kind,
    provider,
    label,
    baseUrl,
    apiKey, // null for local; on-disk only, never returned
    enabled: true,
    models: [],
    disabledModels: [],
    lastTestedAt: null,
    lastError: null,
    createdAt: Date.now(),
  };
  if (record.apiKey && kcStore(record.id, record.apiKey)) record.apiKey = KC_SENTINEL;

  // A NEW KEY REPLACES THE OLD ONE. It used to push unconditionally, so pasting a fresh
  // key for a provider you already had left the previous record in place with its previous
  // key — two Anthropic rows, two Keychain entries, and whichever sorted first decided
  // which key the app actually used. The owner saw "connected" on a key they had replaced.
  // Same vendor at the same base URL is the same provider: it is superseded, not stacked.
  const supersedes = store.providers.filter((p) => p.provider === provider && p.baseUrl === baseUrl);
  for (const old of supersedes) {
    kcDelete(old.id);                                   // the old secret dies with the record
    for (const cap of Object.keys(store.defaults)) {    // and every job that pointed at it
      if (store.defaults[cap] && store.defaults[cap].providerId === old.id) {
        store.defaults[cap] = { ...store.defaults[cap], providerId: record.id };
      }
    }
  }
  if (supersedes.length) {
    // Keep what the owner had chosen: the replacement inherits the models and the enabled
    // flags of the record it replaces, so re-pasting a key does not undo their setup.
    const prev = supersedes[supersedes.length - 1];
    record.models = Array.isArray(prev.models) ? prev.models : [];
    record.disabledModels = Array.isArray(prev.disabledModels) ? prev.disabledModels : [];
    record.enabled = prev.enabled !== false;
    store.providers = store.providers.filter((p) => !supersedes.includes(p));
  }
  store.providers.push(record);
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true, id: record.id, replaced: supersedes.length };
}

/**
 * @param {string} id
 * @param {{label?:string, baseUrl?:string, apiKey?:string, enabled?:boolean}} patch
 * @returns {{ok:boolean, error?:string}}
 */
export function updateProvider(id, patch = {}) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch object is required' };

  const store = loadStore();
  const rec = store.providers.find((p) => p.id === id);
  if (!rec) return { ok: false, error: 'not found' };

  if (patch.label !== undefined) {
    if (typeof patch.label !== 'string' || !patch.label.trim()) return { ok: false, error: 'label must be a non-empty string' };
    rec.label = patch.label.trim();
  }
  if (patch.baseUrl !== undefined) {
    const b = normalizeBaseUrl(patch.baseUrl);
    if (!b || !isValidUrl(b)) return { ok: false, error: 'baseUrl must be a valid URL' };
    rec.baseUrl = b;
    rec.models = [];
    rec.lastTestedAt = null;
    rec.lastError = null;
  }
  if (patch.apiKey !== undefined) {
    if (rec.kind !== 'api') return { ok: false, error: 'local providers do not take an apiKey' };
    if (typeof patch.apiKey !== 'string' || !patch.apiKey.trim()) return { ok: false, error: 'apiKey must be a non-empty string' };
    const nk = patch.apiKey.trim();
    rec.apiKey = kcStore(rec.id, nk) ? KC_SENTINEL : nk;
    rec.lastTestedAt = null;
    rec.lastError = null;
  }
  if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;

  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

/** @returns {{ok:boolean, error?:string}} also clears any default that referenced the provider */
export function removeProvider(id) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
  const store = loadStore();
  const idx = store.providers.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, error: 'not found' };
  kcDelete(id); // the Keychain entry must not outlive the provider
  store.providers.splice(idx, 1);
  for (const cap of Object.keys(store.defaults)) {
    if (store.defaults[cap] && store.defaults[cap].providerId === id) store.defaults[cap] = null;
  }
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

/**
 * Probes a provider's model list. Accepts either a stored provider `id` (uses
 * its saved key; persists the result) or a raw config object (tests before it
 * is added). Never throws.
 * @param {string | {kind:'local'|'api', provider?:string, baseUrl?:string, apiKey?:string}} cfgOrId
 * @returns {Promise<{ok:boolean, models?:string[], error?:string}>}
 */
export async function testProvider(cfgOrId) {
  let cfg;
  const byId = typeof cfgOrId === 'string';
  if (byId) {
    const rec = getRecord(cfgOrId);
    if (!rec) return { ok: false, error: 'not found' };
    cfg = { kind: rec.kind, provider: rec.provider, baseUrl: rec.baseUrl, apiKey: resolveKey(rec) };
  } else if (cfgOrId && typeof cfgOrId === 'object') {
    cfg = normalizeCfg(cfgOrId);
  } else {
    return { ok: false, error: 'provide a provider id or a config object' };
  }

  if (!cfg.baseUrl) return { ok: false, error: 'baseUrl is required (unknown provider)' };
  if (!isValidUrl(cfg.baseUrl)) return { ok: false, error: 'baseUrl must be a valid URL' };

  let result;
  try {
    result = await probeModels(cfg);
  } catch (e) {
    result = { ok: false, error: e.message || String(e) };
  }

  if (byId) {
    const store = loadStore();
    const rec = store.providers.find((p) => p.id === cfgOrId);
    if (rec) {
      rec.lastTestedAt = Date.now();
      rec.lastError = result.ok ? null : (result.error || 'unknown error');
      if (result.ok && Array.isArray(result.models) && result.models.length) rec.models = result.models;
      try { saveStore(store); } catch { /* the probe result is still returned even if persisting fails */ }
    }
  }

  return result.ok ? { ok: true, models: result.models || [] } : { ok: false, error: result.error };
}

/**
 * @param {string} id
 * @returns {Promise<string[]>} cached models, or a best-effort live probe if the
 *   cache is empty. Always resolves to an array — never throws.
 */
export async function listModels(id) {
  const rec = getRecord(id);
  if (!rec) return [];
  if (Array.isArray(rec.models) && rec.models.length) return rec.models.slice();
  try {
    const result = await probeModels({ kind: rec.kind, provider: rec.provider, baseUrl: rec.baseUrl, apiKey: resolveKey(rec) });
    if (result.ok && Array.isArray(result.models) && result.models.length) {
      const store = loadStore();
      const r2 = store.providers.find((p) => p.id === id);
      if (r2) { r2.models = result.models; r2.lastTestedAt = Date.now(); r2.lastError = null; try { saveStore(store); } catch { /* best effort */ } }
      return result.models.slice();
    }
  } catch { /* fall through to empty */ }
  return [];
}

/** @returns {Record<string,{providerId:string,model:string}|null>} every known capability, unset ones as null */
export function getDefaults() {
  const store = loadStore();
  const out = {};
  for (const cap of CAPABILITIES) out[cap] = store.defaults[cap] || null;
  for (const cap of Object.keys(store.defaults)) if (!(cap in out)) out[cap] = store.defaults[cap] || null;
  return out;
}

/**
 * @param {string} capability
 * @param {{providerId:string|null, model?:string}} selection — pass providerId:null to clear
 * @returns {{ok:boolean, error?:string}}
 */
export function setDefault(capability, selection = {}) {
  if (typeof capability !== 'string' || !capability.trim()) return { ok: false, error: 'capability is required' };
  const cap = capability.trim();
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return { ok: false, error: 'selection {providerId, model} is required' };

  const { providerId, model } = selection;
  const store = loadStore();

  if (providerId === null || providerId === undefined) {
    store.defaults[cap] = null;
    try { saveStore(store); } catch (e) { return { ok: false, error: e.message || String(e) }; }
    return { ok: true };
  }
  if (typeof providerId !== 'string') return { ok: false, error: 'providerId must be a string (or null to clear)' };
  if (typeof model !== 'string' || !model.trim()) return { ok: false, error: 'model is required' };
  if (!store.providers.some((p) => p.id === providerId)) return { ok: false, error: 'unknown providerId' };

  store.defaults[cap] = { providerId, model: model.trim() };
  try { saveStore(store); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  return { ok: true };
}

/**
 * Replaces a provider's model list. Used by integrations that curate which models are
 * actually servable right now (e.g. MATRIX registers only the models on disk, not the
 * engine's whole catalog).
 * @returns {{ok:boolean, count?:number, error?:string}}
 */
export function setModels(id, models) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
  if (!Array.isArray(models)) return { ok: false, error: 'models must be an array' };
  const list = [...new Set(models.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))].sort().slice(0, 500);
  const store = loadStore();
  const rec = store.providers.find((p) => p.id === id);
  if (!rec) return { ok: false, error: 'not found' };
  rec.models = list;
  rec.lastTestedAt = Date.now();
  rec.lastError = null;
  try { saveStore(store); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  return { ok: true, count: list.length };
}

/** @returns {{ok:boolean, error?:string}} */
export function setEnabled(id, enabled) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
  const store = loadStore();
  const rec = store.providers.find((p) => p.id === id);
  if (!rec) return { ok: false, error: 'not found' };
  rec.enabled = !!enabled;
  try { saveStore(store); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  return { ok: true };
}

/** Per-model activation: a disabled model stays listed but is not offered in pickers.
 * @returns {{ok:boolean, error?:string}} */
export function setModelEnabled(id, model, enabled) {
  if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
  if (!model || typeof model !== 'string') return { ok: false, error: 'model is required' };
  const store = loadStore();
  const rec = store.providers.find((p) => p.id === id);
  if (!rec) return { ok: false, error: 'not found' };
  if (!Array.isArray(rec.disabledModels)) rec.disabledModels = [];
  const off = rec.disabledModels.includes(model);
  if (enabled && off) rec.disabledModels = rec.disabledModels.filter((m) => m !== model);
  if (!enabled && !off) rec.disabledModels.push(model);
  try { saveStore(store); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  return { ok: true };
}

/**
 * Reflects the on-disk Anthropic "Brain" (managed by llm.mjs) for the Settings
 * Brain panel. Never returns the key. Lazily imports llm.mjs so a load-order
 * issue there never breaks importing this module.
 * @returns {Promise<{available:boolean, model:string|null}>}
 */
/**
 * Every place a model key lives on this machine, and which one the app actually uses.
 *
 * The owner pasted a new key and other screens kept saying they had one. Both were
 * telling the truth about different stores: a registered provider keeps its key in the
 * Keychain, while ~/.env.local can carry an independent copy the app read and never
 * showed. A key you cannot see is a key you cannot replace. Values NEVER leave here —
 * only the variable name and the file it sits in.
 *
 * `shadowed` means an env key is present but ignored, because a provider for the same
 * vendor is registered and registered providers always win (see model/port resolveTarget).
 */
export async function keyAudit() {
  const store = loadStore();
  const providers = store.providers.map((p) => ({
    id: p.id,
    provider: p.provider,
    label: p.label || p.provider,
    kind: p.kind,
    hasKey: !!p.apiKey,
    where: p.apiKey === KC_SENTINEL ? 'keychain' : (p.apiKey ? 'disk' : 'none'),
  }));
  let env = [];
  try {
    const m = await import('./llm.mjs');
    env = (m.envKeySources ? m.envKeySources() : []).map((e) => ({
      ...e,
      shadowed: providers.some((p) => p.provider === e.provider && p.kind === 'api'),
    }));
  } catch {}
  // What ask() would actually reach for right now, named the same way resolveTarget does.
  let active = { source: 'none' };
  const usable = store.providers.filter((p) => p.enabled !== false);
  if (usable.length) {
    const first = usable.find((p) => (p.models || []).length) || usable[0];
    active = { source: 'provider', provider: first.provider, id: first.id, label: first.label || first.provider };
  } else if (env.length) {
    active = { source: 'env', provider: env[0].provider, variable: env[0].name, file: env[0].source };
  }
  return { ok: true, providers, env, active };
}

export async function brainStatus() {
  try {
    const m = await import('./llm.mjs');
    const available = typeof m.hasBrain === 'function' ? !!m.hasBrain() : !!(m.loadKey && m.loadKey());
    return { available, model: m.DEFAULT_MODEL || null };
  } catch {
    return { available: false, model: null };
  }
}

export const Models = {
  listProviders,
  knownProviders,
  getProvider,
  addProvider,
  updateProvider,
  removeProvider,
  testProvider,
  listModels,
  getDefaults,
  setDefault,
  setEnabled,
  setModels,
  setModelEnabled,
  brainStatus,
  keyAudit,
  // server-only (RPC blocks _-prefixed): the model port + the chat relay use these
  //
  // _raw hands back a record whose apiKey is the REAL key, never the Keychain sentinel.
  // It used to be getRecord itself, and every one of its callers (all three live in
  // model/port.mjs) fed the record straight into an Authorization header — so the whole
  // brain route authenticated as `Bearer keychain:v1` and 401'd: POST /chat, and with it
  // tasks, style, compare, research, cookbook and every email summary. The truthiness
  // guard `if (kind === 'api' && !apiKey) throw` never fired, because the sentinel is a
  // non-empty string. Resolving here rather than at each call site means a future consumer
  // cannot reintroduce the same bug by forgetting.
  _raw: (id) => { const r = getRecord(id); return r ? { ...r, apiKey: resolveKey(r) } : null; },
  _isAnthropic: (provider, baseUrl) => isAnthropic(provider, baseUrl),
  _baseUrl: (u) => normalizeBaseUrl(u),
  _streamConfig: streamConfig,
};

// One-time migration: any provider still carrying a plaintext key moves it into
// the Keychain. Called by the DAEMON at startup — never at import time (an import
// side effect that execs `security` hung the test suite and littered the user's
// Keychain with test entries). Lossless: a Keychain failure keeps the key in the
// 0600 store as before. Counts are logged, keys never are.
function migrateKeysToKeychain() {
  try {
    const store = loadStore();
    let moved = 0;
    for (const r of store.providers || []) {
      if (r.kind === 'api' && r.apiKey && r.apiKey !== KC_SENTINEL) {
        if (kcStore(r.id, r.apiKey)) { r.apiKey = KC_SENTINEL; moved++; }
      }
    }
    if (moved) { saveStore(store); console.log(`[models] moved ${moved} provider key(s) into the macOS Keychain`); }
    return { ok: true, moved };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
}
Models._migrateKeys = migrateKeysToKeychain; // server-only (RPC blocks _-prefixed)

export default Models;
