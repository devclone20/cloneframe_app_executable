// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Model Compare
//
// The sidebar "Compare" feature: run the SAME prompt across multiple models at
// once and get their outputs side-by-side, each with its own latency (ms) and,
// on failure, a per-model error — one model erroring never sinks the others.
//
// Zero npm deps. Node built-ins only. `ask()` from ./llm.mjs is imported
// eagerly (same tier as this module, always present). `./models.mjs` is
// imported LAZILY, only inside run(), to resolve provider/model aliases to real
// model ids IF that module exists — if it doesn't (or is half-built), we fall
// back to using the caller's strings as literal model ids, so load-order can
// never break this module or the compare run.
//
// Persistence: ~/.clone-frame-hub/compare.json (dir 0700, file 0600, atomic
// tmp-write-then-rename). A corrupt/missing store degrades to empty, never
// throws. No secret (apiKey/password/token) is ever stored or returned — a run
// record holds only the prompt, the requested model ids, and the model outputs.
// Nothing here is logged.
//
// Public surface: `Compare` object + named exports. See COMPARE.md.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ask } from './llm.mjs';

// ── persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const STORE_FILE = path.join(CONFIG_DIR, 'compare.json');

const STORE_VERSION = 1;
const RUNS_CAP = 100;          // keep history bounded; oldest runs are dropped
const MAX_MODELS = 12;         // hard ceiling on models per run
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 120_000; // per-model wall-clock cap

// Defensive redaction on read — this module never stores credentials, but if a
// future field ever carried one we strip it before it can leave the process.
const SECRET_KEYS = new Set(['apiKey', 'apikey', 'password', 'pass', 'token', 'secret', 'authorization']);

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on shared/odd filesystems */ }
}

function emptyStore() {
  return { version: STORE_VERSION, runs: [] };
}

function loadStore() {
  ensureConfigDir();
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { version: STORE_VERSION, runs: Array.isArray(data.runs) ? data.runs : [] };
  } catch {
    // ENOENT or corrupt/garbage JSON → start clean; a bad store must never throw.
    return emptyStore();
  }
}

function saveStore(store) {
  ensureConfigDir();
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* best effort */ }
}

// appendRun has no `await` inside — JS single-threading makes it atomic w.r.t.
// other appendRun calls, so concurrent run()s can't lose each other's writes.
function appendRun(record) {
  const store = loadStore();
  store.runs.push(record);
  if (store.runs.length > RUNS_CAP) store.runs.splice(0, store.runs.length - RUNS_CAP);
  saveStore(store);
}

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k)) continue;
      out[k] = v && typeof v === 'object' ? stripSecrets(v) : v;
    }
    return out;
  }
  return value;
}

// ── model resolution (best-effort, via optional ./models.mjs) ────────────────
async function loadModels() {
  try {
    const mod = await import('./models.mjs');
    return mod.Models || mod.default || mod;
  } catch {
    return null; // module absent or broken → callers' strings are used literally
  }
}

function pickId(candidate) {
  if (!candidate) return null;
  if (typeof candidate === 'string') return candidate.trim() || null;
  if (typeof candidate === 'object') {
    for (const k of ['model', 'modelId', 'apiId', 'id', 'name']) {
      if (typeof candidate[k] === 'string' && candidate[k].trim()) return candidate[k].trim();
    }
  }
  return null;
}

// Resolve one requested id/alias to a concrete API model id. Tries a few shapes
// ./models.mjs might expose (resolve/get/list). Any failure falls back to the
// raw string, so an unknown alias is simply passed through to ask() as-is.
async function resolveModelId(Models, requested) {
  const raw = String(requested).trim();
  if (!raw || !Models) return raw;
  for (const fn of ['resolve', 'resolveModel', 'get']) {
    if (typeof Models[fn] === 'function') {
      try {
        const id = pickId(await Models[fn](raw));
        if (id) return id;
      } catch { /* try the next resolver */ }
    }
  }
  if (typeof Models.list === 'function') {
    try {
      const all = await Models.list();
      if (Array.isArray(all)) {
        const hit = all.find((m) => m && [m.id, m.alias, m.key, m.name, m.model].includes(raw));
        const id = pickId(hit);
        if (id) return id;
      }
    } catch { /* fall through to raw */ }
  }
  return raw;
}

function normalizeModels(models) {
  const out = [];
  const seen = new Set();
  for (const m of models) {
    if (typeof m !== 'string') continue;
    const t = m.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

// ── run ──────────────────────────────────────────────────────────────────────
/**
 * Run one prompt across several models in parallel.
 * @param {{prompt:string, models:string[], system?:string, maxTokens?:number, timeoutMs?:number}} input
 * @returns {Promise<{ok:boolean, id?:string, results:{model:string, text:string, ms:number, error?:string}[], error?:string}>}
 */
export async function run(input = {}) {
  const { prompt, models, system, maxTokens, timeoutMs } = input || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { ok: false, error: 'prompt is required', results: [] };
  }
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, error: 'models must be a non-empty string[]', results: [] };
  }
  const requested = normalizeModels(models);
  if (!requested.length) {
    return { ok: false, error: 'no valid model ids provided', results: [] };
  }

  const sys = typeof system === 'string' && system.trim() ? system : undefined;
  const tokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const messages = [{ role: 'user', content: prompt }];

  const Models = await loadModels();
  const resolved = [];
  for (const reqId of requested) {
    resolved.push({ requested: reqId, model: await resolveModelId(Models, reqId) });
  }

  const results = await Promise.all(resolved.map(async ({ requested: reqId, model }) => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const opts = { model, maxTokens: tokens, signal: controller.signal };
      if (sys) opts.system = sys;
      const text = await ask(messages, opts);
      return { model: reqId, resolvedModel: model, text: String(text ?? ''), ms: Date.now() - started };
    } catch (e) {
      const error = controller.signal.aborted ? `timed out after ${timeout}ms` : (e?.message || String(e));
      return { model: reqId, resolvedModel: model, text: '', ms: Date.now() - started, error };
    } finally {
      clearTimeout(timer);
    }
  }));

  const record = {
    id: randomUUID(),
    prompt,
    system: sys || null,
    models: requested,
    results,
    createdAt: new Date().toISOString(),
  };
  try { appendRun(record); } catch { /* history is best-effort; never fail the run over it */ }

  const ok = results.some((r) => !r.error);
  return { ok, id: record.id, results };
}

// ── history / get / remove ───────────────────────────────────────────────────
/**
 * Most-recent-first summaries of past runs.
 * @param {{limit?:number}} [opts]
 * @returns {{id:string, prompt:string, models:string[], createdAt:string}[]}
 */
export function history({ limit = 20 } = {}) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  return loadStore().runs
    .slice(-n)
    .reverse()
    .map((r) => ({ id: r.id, prompt: r.prompt, models: Array.isArray(r.models) ? r.models : [], createdAt: r.createdAt }));
}

/**
 * The full run record (prompt, system, models, results), or null if unknown.
 * @param {string} id
 * @returns {object|null}
 */
export function get(id) {
  if (typeof id !== 'string' || !id) return null;
  const run = loadStore().runs.find((r) => r.id === id);
  return run ? stripSecrets(run) : null;
}

/**
 * Delete one run from history.
 * @param {string} id
 * @returns {{ok:boolean, error?:string}}
 */
export function remove(id) {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'id is required' };
  const store = loadStore();
  const idx = store.runs.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, error: `unknown run: ${id}` };
  store.runs.splice(idx, 1);
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
export const Compare = {
  run,
  history,
  get,
  remove,
};

export default Compare;
