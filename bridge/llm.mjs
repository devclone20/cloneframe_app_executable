// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — shared, provider-agnostic model helper (non-streaming)
// A tiny BYOK primitive for background modules (tasks, style, compare, research,
// cookbook). As of Wave-3 (T-019) `ask()` is NO LONGER Claude-locked: it routes
// through the shared model port, which dispatches to whatever provider the user
// configured (Anthropic / OpenAI-compatible / local), falling back to the env
// ANTHROPIC_API_KEY only when that is literally all there is. loadKey() stays the
// env-Anthropic reader the port itself consumes for that last-resort fallback and
// NEVER leaves this machine. See bridge/model/port.mjs + [[model_agnostic_invariant]].
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Read a single env VAR: process.env first, then ~/.env.local, then ~/.env (first wins).
// The value is trimmed and unquoted; never logged. This is the ONE env/BYOK reader.
function readEnv(name) {
  const p = process.env[name];
  if (p && p.trim()) return p.trim();
  for (const f of [path.join(homedir(), '.env.local'), path.join(homedir(), '.env')]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(new RegExp('^\\s*' + name + '\\s*=\\s*(.+?)\\s*$', 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {}
  }
  return null;
}

export function loadKey() { return readEnv('ANTHROPIC_API_KEY'); }

// Well-known OpenAI-compatible providers: env var → sensible base + a default model.
// The base/model are always overridable by CFHUB_LLM_BASE_URL / CFHUB_LLM_MODEL.
const WELL_KNOWN_ENV = [
  { env: 'DEEPSEEK_API_KEY',   provider: 'deepseek',   baseUrl: 'https://api.deepseek.com',                          model: 'deepseek-chat' },
  { env: 'OPENAI_API_KEY',     provider: 'openai',     baseUrl: 'https://api.openai.com/v1',                         model: 'gpt-4o-mini' },
  { env: 'GROQ_API_KEY',       provider: 'groq',       baseUrl: 'https://api.groq.com/openai/v1',                    model: 'llama-3.3-70b-versatile' },
  { env: 'OPENROUTER_API_KEY', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',                      model: 'auto' },
  { env: 'XAI_API_KEY',        provider: 'xai',        baseUrl: 'https://api.x.ai/v1',                               model: 'grok-2-latest' },
  { env: 'MISTRAL_API_KEY',    provider: 'mistral',    baseUrl: 'https://api.mistral.ai/v1',                         model: 'mistral-large-latest' },
  { env: 'GEMINI_API_KEY',     provider: 'gemini',     baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
  { env: 'TOGETHER_API_KEY',   provider: 'together',   baseUrl: 'https://api.together.xyz/v1',                       model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { env: 'FIREWORKS_API_KEY',  provider: 'fireworks',  baseUrl: 'https://api.fireworks.ai/inference/v1',             model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { env: 'PERPLEXITY_API_KEY', provider: 'perplexity', baseUrl: 'https://api.perplexity.ai',                         model: 'sonar' },
  { env: 'CEREBRAS_API_KEY',   provider: 'cerebras',   baseUrl: 'https://api.cerebras.ai/v1',                        model: 'llama-3.3-70b' },
  { env: 'DEEPINFRA_API_KEY',  provider: 'deepinfra',  baseUrl: 'https://api.deepinfra.com/v1/openai',               model: 'meta-llama/Llama-3.3-70B-Instruct' },
  { env: 'NEBIUS_API_KEY',     provider: 'nebius',     baseUrl: 'https://api.studio.nebius.ai/v1',                   model: 'meta-llama/Llama-3.3-70B-Instruct' },
];

/**
 * A generic BYOK provider configured purely via env / ~/.env.local, so the app works
 * with ANY provider (or a local OpenAI-compatible server) without touching Settings.
 * This is what "link my DeepSeek key to the LLM" resolves to. Precedence:
 *   1. explicit generic config: CFHUB_LLM_API_KEY + CFHUB_LLM_BASE_URL (+ _MODEL, _PROVIDER)
 *      — also covers a LOCAL model: CFHUB_LLM_BASE_URL=http://localhost:11434/v1, key can be "local".
 *   2. a well-known key (DEEPSEEK_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, …) → its default base+model.
 * Anthropic is unchanged (loadKey / ANTHROPIC_API_KEY). Keys are never logged.
 * @returns {null | {provider:string, baseUrl:string, apiKey:string, model:string}}
 */
export function loadEnvProvider() {
  const overrideBase = readEnv('CFHUB_LLM_BASE_URL');
  const overrideModel = readEnv('CFHUB_LLM_MODEL');
  const genericKey = readEnv('CFHUB_LLM_API_KEY');
  if (genericKey && overrideBase) {
    return { provider: readEnv('CFHUB_LLM_PROVIDER') || 'custom', baseUrl: overrideBase, apiKey: genericKey, model: overrideModel || 'auto' };
  }
  for (const w of WELL_KNOWN_ENV) {
    const k = readEnv(w.env);
    if (k) return { provider: w.provider, baseUrl: overrideBase || w.baseUrl, apiKey: k, model: overrideModel || w.model };
  }
  return null;
}

// The concrete model used ONLY for the env-Anthropic last-resort path (that API
// requires a model id and the bare env key carries none). A configured provider
// always uses its OWN default instead — so this is not a silent Claude lock, it
// is the model for "an env ANTHROPIC_API_KEY is all there is". Overridable via env.
export const DEFAULT_MODEL = process.env.HUB_BRIDGE_MODEL || 'claude-sonnet-5';

// ask(messages, {system, model, maxTokens, signal}) -> string
// messages: [{role:'user'|'assistant', content:string}]
// Provider-agnostic: delegates to the shared model port. Throws (key-free) when
// no provider is configured/reachable or the wire errors. Returns the text.
export async function ask(messages, opts = {}) {
  const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];
  // Lazy import breaks the llm.mjs <-> model/port.mjs import cycle (the port reads
  // loadKey from here); by call time both modules are fully loaded.
  const { modelPort } = await import('./model/port.mjs');
  const port = await modelPort();
  const target = port.resolveTarget({});
  if (!target) throw new Error('no model configured — add a provider in Settings → Add Models, or set ANTHROPIC_API_KEY');
  // Supply a concrete default model ONLY when the resolved target is Anthropic
  // (its env-key fallback has no model); every other provider uses its own
  // configured default (pass model:undefined so the port picks it). This keeps
  // the background helpers agnostic while preserving prior env-only behavior.
  const model = opts.model || (target.anthropic ? DEFAULT_MODEL : undefined);
  return port.ask(msgs, { system: opts.system, model, maxTokens: opts.maxTokens || 1024, signal: opts.signal });
}

export function hasBrain() { return !!(loadKey() || loadEnvProvider()); }

export default { ask, loadKey, loadEnvProvider, hasBrain, DEFAULT_MODEL };
