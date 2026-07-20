// T-019 companion test: with NO provider configured but an env ANTHROPIC_API_KEY
// present, ask() still falls back to Anthropic with the concrete DEFAULT_MODEL —
// preserving the exact prior behavior for env-only users (the "an env key is all
// there is" last resort of the model-agnostic invariant). Separate file so the
// model port's lazy singleton binds to THIS test's empty registry (node runs
// each test file in its own process). The env path targets api.anthropic.com, so
// fetch is stubbed to capture the outbound request rather than hit the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Env vars that would make loadEnvProvider() short-circuit to a non-Anthropic
// provider. Cleared so this test proves the env-Anthropic LAST resort in isolation —
// otherwise a real ~/.env.local (or an inherited shell var) with e.g. DEEPSEEK_API_KEY
// would correctly win and there would be no Anthropic fallback to observe.
const PROVIDER_VARS = [
  'CFHUB_LLM_BASE_URL', 'CFHUB_LLM_API_KEY', 'CFHUB_LLM_MODEL', 'CFHUB_LLM_PROVIDER',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY',
  'XAI_API_KEY', 'MISTRAL_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'PERPLEXITY_API_KEY', 'CEREBRAS_API_KEY',
  'DEEPINFRA_API_KEY', 'NEBIUS_API_KEY',
];

test('ask() falls back to Anthropic + DEFAULT_MODEL when only an env key exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-llm-env-'));
  // Hermetic env: HOME points at the temp root (no real ~/.env.local is read via
  // readEnv → homedir()), and every well-known provider var is unset — so the ONLY
  // credential in scope is the env ANTHROPIC_API_KEY set below. Saved/restored so the
  // in-process env is left exactly as found.
  const saved = { HOME: process.env.HOME, CLONE_FRAME_HUB_ROOT: process.env.CLONE_FRAME_HUB_ROOT, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  for (const v of PROVIDER_VARS) saved[v] = process.env[v];
  process.env.HOME = root;
  process.env.CLONE_FRAME_HUB_ROOT = root;
  process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
  for (const v of PROVIDER_VARS) delete process.env[v];
  // empty registry — no configured providers, so the env-Anthropic last resort applies
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ version: 1, providers: [], defaults: {} }));

  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: true, async json() { return { content: [{ type: 'text', text: 'ENV-OK' }] }; }, async text() { return ''; } };
  };
  try {
    const { ask, DEFAULT_MODEL } = await import('../bridge/llm.mjs?ctx=' + Math.random().toString(36).slice(2));
    const out = await ask([{ role: 'user', content: 'hi' }], { maxTokens: 32 });
    assert.equal(out, 'ENV-OK');
    assert.match(seen.url, /api\.anthropic\.com\/v1\/messages$/, 'env fallback uses the Anthropic wire');
    assert.equal(seen.headers['x-api-key'], 'env-anthropic-key', 'the env key is used, never logged');
    assert.equal(seen.body.model, DEFAULT_MODEL, 'a concrete default model — never "auto"');
    assert.notEqual(seen.body.model, 'auto');
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
