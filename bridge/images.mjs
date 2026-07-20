// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Image Generation (BYOK)
//
// Text-to-image generation for the Gallery. The user supplies their own
// provider API key (OpenAI Images or Stability AI) — this module never ships
// a key and never calls a paid API unless `config()` has been run first.
//
// Dependencies: Node built-ins only (fs, path, os, crypto) + global `fetch`
// (undici, built into Node — no npm dependency). `./gallery.mjs` is lazy
// dynamic-imported inside generate() only, so importing this module never
// pulls gallery.mjs's fs/blob machinery in for callers that only need
// config()/status()/providers().
//
// Security: the BYOK key lives only in ~/.clone-frame-hub/images.json
// (0600, in a 0700 dir). It is never logged, never included in status(),
// never echoed back by config(), and the only place it is read into memory
// is generate()'s live provider call.
//
// Error model: every exported function returns a plain object and never
// throws. generate() additionally enforces a 60s timeout and a prompt/size
// cap so a single call can never hang or request an unbounded image.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// ── persistence ──────────────────────────────────────────────────────────────
// The BYOK key rides the shared atomic store (~/.clone-frame-hub/images.json,
// file 0600 in a 0700 dir, tmp-write-then-rename). It is written only by
// config(), read only by loadStore() for a live provider call, and is never
// logged, echoed back by config(), or exposed by status().
const store = openStore({ name: 'images', version: 1, shape: {}, root: hubRoot() });

const TIMEOUT_MS = 60_000;
const MAX_PROMPT_LEN = 4_000;
const MIN_DIM = 64;
const MAX_DIM = 2_048;
const DEFAULT_SIZE = '1024x1024';
const SIZE_RE = /^\d{2,5}x\d{2,5}$/;

// Static catalog. Model lists reflect each vendor's naming, not a hardcoded
// allowlist — config() and generate() accept any non-empty model string so a
// new vendor model name never requires a code change here.
const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI Images',
    models: ['gpt-image-1', 'dall-e-3', 'dall-e-2'],
    defaultModel: 'gpt-image-1',
  },
  stability: {
    id: 'stability',
    label: 'Stability AI',
    models: ['stable-diffusion-xl-1024-v1-0', 'stable-diffusion-v1-6'],
    defaultModel: 'stable-diffusion-xl-1024-v1-0',
  },
};

// The store guarantees only that read() returns a plain object; the provider
// whitelist + apiKey presence check below stay this module's job. An
// unconfigured, missing, or corrupt store surfaces as {version} with no
// provider, which fails these guards and yields null — treated as unconfigured,
// exactly as before.
function loadStore() {
  const data = store.read();
  if (!PROVIDERS[data.provider]) return null;
  if (typeof data.apiKey !== 'string' || !data.apiKey) return null;
  return {
    provider: data.provider,
    apiKey: data.apiKey,
    model: typeof data.model === 'string' && data.model ? data.model : PROVIDERS[data.provider].defaultModel,
  };
}

function saveStore(record) {
  store.write(record);
}

// ── input normalisation ──────────────────────────────────────────────────────

function normalizeSize(size) {
  if (size === undefined || size === null || size === '') return { ok: true, size: DEFAULT_SIZE };
  if (typeof size !== 'string') return { ok: false, error: 'generate: size must be a string like "1024x1024"' };
  if (size === 'auto') return { ok: true, size };
  if (!SIZE_RE.test(size)) return { ok: false, error: 'generate: invalid size format, expected WIDTHxHEIGHT' };
  const [w, h] = size.split('x').map(Number);
  if (w < MIN_DIM || h < MIN_DIM || w > MAX_DIM || h > MAX_DIM) {
    return { ok: false, error: `generate: size out of bounds (${MIN_DIM}-${MAX_DIM}px per side)` };
  }
  return { ok: true, size, width: w, height: h };
}

function normalizePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') return { ok: false, error: 'generate: prompt is required' };
  return { ok: true, prompt: prompt.trim().slice(0, MAX_PROMPT_LEN) };
}

// ── provider calls ───────────────────────────────────────────────────────────
// Each returns {ok:true, base64} or {ok:false, error}. Never throws — network
// and parse failures are caught and folded into the error string. The API key
// never appears in a returned error message.

async function callOpenAI({ apiKey, model, prompt, size, signal }) {
  const body = { model, prompt, size, n: 1 };
  if (model.startsWith('dall-e')) body.response_format = 'b64_json';
  let r;
  try {
    r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: networkErrorMessage(e) };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { ok: false, error: `openai ${r.status}${t ? ' ' + t.slice(0, 300) : ''}` };
  }
  let json;
  try { json = await r.json(); } catch { return { ok: false, error: 'openai: invalid JSON response' }; }
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64 || typeof b64 !== 'string') return { ok: false, error: 'openai: response did not include image data' };
  return { ok: true, base64: b64 };
}

async function callStability({ apiKey, model, prompt, width, height, signal }) {
  const w = width || 1024;
  const h = height || 1024;
  let r;
  try {
    r = await fetch(`https://api.stability.ai/v1/generation/${model}/text-to-image`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ text_prompts: [{ text: prompt }], width: w, height: h, samples: 1 }),
    });
  } catch (e) {
    return { ok: false, error: networkErrorMessage(e) };
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { ok: false, error: `stability ${r.status}${t ? ' ' + t.slice(0, 300) : ''}` };
  }
  let json;
  try { json = await r.json(); } catch { return { ok: false, error: 'stability: invalid JSON response' }; }
  const b64 = json?.artifacts?.[0]?.base64;
  if (!b64 || typeof b64 !== 'string') return { ok: false, error: 'stability: response did not include image data' };
  return { ok: true, base64: b64 };
}

function networkErrorMessage(e) {
  if (e && e.name === 'AbortError') return 'generate: image provider timed out';
  return 'generate: network error contacting image provider' + (e && e.message ? ` (${e.message})` : '');
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Persist BYOK provider config. The key is written to disk (0600) and never
 * returned to the caller.
 * @param {{provider:string, apiKey:string, model?:string}} input
 * @returns {{ok:boolean, error?:string}}
 */
export function config(input = {}) {
  try {
    if (!input || typeof input !== 'object') return { ok: false, error: 'config: object argument required' };
    const provider = input.provider;
    if (typeof provider !== 'string' || !PROVIDERS[provider]) {
      return { ok: false, error: `config: provider must be one of ${Object.keys(PROVIDERS).join(', ')}` };
    }
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!apiKey) return { ok: false, error: 'config: apiKey is required' };
    let model = PROVIDERS[provider].defaultModel;
    if (input.model !== undefined) {
      if (typeof input.model !== 'string' || !input.model.trim()) {
        return { ok: false, error: 'config: model must be a non-empty string' };
      }
      model = input.model.trim();
    }
    saveStore({ provider, apiKey, model });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Current configuration status. Never includes the key.
 * @returns {{configured:boolean, provider?:string, model?:string}}
 */
export function status() {
  const store = loadStore();
  if (!store) return { configured: false };
  return { configured: true, provider: store.provider, model: store.model };
}

/**
 * Static provider/model catalog for building a config UI.
 * @returns {Array<{id:string, label:string, models:string[]}>}
 */
export function providers() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, models: [...p.models] }));
}

/**
 * Generate an image from a text prompt via the configured BYOK provider,
 * save it to the Gallery, and return a data URI for immediate display.
 * Never throws. Degrades to {ok:false, error:'no image provider configured'}
 * when config() has not been run.
 * @param {{prompt:string, size?:string}} input
 * @returns {Promise<{ok:boolean, id?:string, dataUri?:string, error?:string}>}
 */
export async function generate(input = {}) {
  try {
    const store = loadStore();
    if (!store) return { ok: false, error: 'no image provider configured' };

    if (!input || typeof input !== 'object') return { ok: false, error: 'generate: object argument required' };
    const p = normalizePrompt(input.prompt);
    if (!p.ok) return { ok: false, error: p.error };
    const s = normalizeSize(input.size);
    if (!s.ok) return { ok: false, error: s.error };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let result;
    try {
      if (store.provider === 'openai') {
        result = await callOpenAI({
          apiKey: store.apiKey, model: store.model, prompt: p.prompt, size: s.size, signal: controller.signal,
        });
      } else if (store.provider === 'stability') {
        result = await callStability({
          apiKey: store.apiKey, model: store.model, prompt: p.prompt,
          width: s.width, height: s.height, signal: controller.signal,
        });
      } else {
        result = { ok: false, error: 'generate: unknown configured provider' };
      }
    } finally {
      clearTimeout(timer);
    }

    if (!result.ok) return { ok: false, error: result.error };

    const dataUri = `data:image/png;base64,${result.base64}`;

    let saved;
    try {
      const { Gallery } = await import('./gallery.mjs');
      saved = Gallery.add({
        prompt: p.prompt,
        mimeType: 'image/png',
        contentBase64: result.base64,
        tags: ['generated', store.provider],
      });
    } catch (e) {
      saved = { ok: false, error: e && e.message ? e.message : String(e) };
    }

    if (!saved || !saved.ok) {
      return { ok: false, dataUri, error: `generate: image created but gallery save failed: ${saved && saved.error ? saved.error : 'unknown error'}` };
    }

    return { ok: true, id: saved.id, dataUri };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Remove the persisted BYOK config (idempotent — succeeds even if unset).
 * @returns {{ok:boolean}}
 */
export function removeConfig() {
  try {
    fs.rmSync(store.path, { force: true });
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

export const Images = { config, status, providers, generate, removeConfig };
export default Images;
