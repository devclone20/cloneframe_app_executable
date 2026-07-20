// ─────────────────────────────────────────────────────────────────────────────
// Model-agnostic env provider — the port resolves ANY provider (DeepSeek / any
// OpenAI-compat / local) configured purely via env, so the app works with no
// Anthropic key and no Settings entry. Locks the precedence + target shape.
//
// Hermetic: the port's registry/env resolvers are injected (no real files, no
// network). A subprocess with an empty HOME verifies llm.loadEnvProvider's real
// env reading + well-known mapping.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createModelPort } from '../bridge/model/port.mjs';

const reg = (providers = []) => ({
  _raw: (id) => providers.find((p) => p.id === id) || null,
  _isAnthropic: (prov, base) => prov === 'anthropic' || /anthropic\.com/.test(String(base || '')),
  getDefaults: () => ({}),
  listProviders: () => providers.map((p) => ({ id: p.id, enabled: p.enabled !== false })),
});
const DEEPSEEK = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', model: 'deepseek-chat' };

test('env generic provider (DeepSeek) resolves as OpenAI-compat when no registry provider', () => {
  const port = createModelPort({ registry: reg([]), envProvider: () => DEEPSEEK });
  const t = port.resolveTarget({});
  assert.equal(t.provider, 'deepseek');
  assert.equal(t.anthropic, false);
  assert.equal(t.baseUrl, 'https://api.deepseek.com');
  assert.equal(t.model, 'deepseek-chat');
  assert.equal(t.apiKey, 'sk-x');
});

test('a Settings registry provider WINS over an env provider (env is the last resort)', () => {
  const port = createModelPort({
    registry: reg([{ id: 'r1', provider: 'openai', kind: 'api', baseUrl: 'https://api.openai.com/v1', apiKey: 'rk', models: ['gpt-4o'], enabled: true }]),
    envProvider: () => DEEPSEEK, envAnthropicKey: () => 'anth-key',
  });
  const t = port.resolveTarget({});
  assert.equal(t.providerId, 'r1');
  assert.equal(t.provider, 'openai');
});

test('env provider is preferred over a bare env ANTHROPIC_API_KEY', () => {
  const port = createModelPort({ registry: reg([]), envProvider: () => DEEPSEEK, envAnthropicKey: () => 'anth-key' });
  assert.equal(port.resolveTarget({}).provider, 'deepseek');
});

test('bare env ANTHROPIC_API_KEY still resolves (back-compat) when no provider + no env provider', () => {
  const port = createModelPort({ registry: reg([]), envProvider: () => null, envAnthropicKey: () => 'anth-key' });
  const t = port.resolveTarget({});
  assert.equal(t.provider, 'anthropic');
  assert.equal(t.anthropic, true);
  assert.equal(t.apiKey, 'anth-key');
});

test('an Anthropic-shaped env provider (base api.anthropic.com) resolves anthropic:true', () => {
  const port = createModelPort({ registry: reg([]), envProvider: () => ({ provider: 'custom', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-x' }) });
  assert.equal(port.resolveTarget({}).anthropic, true);
});

test('nothing configured → null (no silent Claude default)', () => {
  const port = createModelPort({ registry: reg([]), envProvider: () => null, envAnthropicKey: () => null });
  assert.equal(port.resolveTarget({}), null);
});

test('a local model via env (CFHUB_LLM_BASE_URL=localhost) resolves OpenAI-compat, key optional', () => {
  const port = createModelPort({ registry: reg([]), envProvider: () => ({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', apiKey: 'local', model: 'llama3' }) });
  const t = port.resolveTarget({});
  assert.equal(t.anthropic, false);
  assert.equal(t.baseUrl, 'http://localhost:11434/v1');
});

test('llm.loadEnvProvider reads env + maps well-known keys (hermetic subprocess, empty HOME)', () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-home-'));
  const llmUrl = new URL('../bridge/llm.mjs', import.meta.url).href;
  const run = (env) => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import(${JSON.stringify(llmUrl)}).then(m=>process.stdout.write(JSON.stringify(m.loadEnvProvider())))`],
      { env: { HOME: emptyHome, ...env }, encoding: 'utf8' });
    return JSON.parse(out);
  };
  try {
    // DEEPSEEK_API_KEY → deepseek base + default model
    const ds = run({ DEEPSEEK_API_KEY: 'sk-test' });
    assert.equal(ds.provider, 'deepseek');
    assert.equal(ds.baseUrl, 'https://api.deepseek.com');
    assert.equal(ds.model, 'deepseek-chat');
    assert.equal(ds.apiKey, 'sk-test');
    // explicit generic config wins + CFHUB_LLM_MODEL override
    const gen = run({ CFHUB_LLM_API_KEY: 'k', CFHUB_LLM_BASE_URL: 'https://x.example/v1', CFHUB_LLM_MODEL: 'm1', CFHUB_LLM_PROVIDER: 'x' });
    assert.equal(gen.provider, 'x');
    assert.equal(gen.baseUrl, 'https://x.example/v1');
    assert.equal(gen.model, 'm1');
    // nothing set (empty HOME → no ~/.env.local) → null
    assert.equal(run({}), null);
  } finally { fs.rmSync(emptyHome, { recursive: true, force: true }); }
});
