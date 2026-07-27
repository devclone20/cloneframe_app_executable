// BYOK: the key the user pasted has to be the key that authenticates.
//
// It was not. models.mjs deliberately moves every API key into the macOS Keychain and
// writes the sentinel string "keychain:v1" to disk in its place. Exactly one reader
// resolved that sentinel back into a key (streamConfig, which is why /provider-chat
// worked). The MODEL PORT — which backs POST /chat and, through llm.mjs, tasks, style,
// compare, research, cookbook and every email summary — read the record raw and sent
// `Authorization: Bearer keychain:v1`. Every one of those calls 401'd, and the port's
// own guard (`if (kind === 'api' && !apiKey) throw`) never fired, because a sentinel is
// a perfectly truthy string.
//
// tests/model-port.test.mjs could not have caught this: it injects a fake registry, so
// it never sees what the real one hands over. This suite uses the REAL registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENTINEL = 'keychain:v1';

// A throwaway root, seeded before the module loads — models.mjs binds its store at import.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-byok-'));
fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({
  version: 1,
  providers: [
    { id: 'kc', provider: 'openai', kind: 'api', baseUrl: 'https://api.openai.com/v1',
      apiKey: SENTINEL, models: ['gpt-x'], enabled: true, label: 'Sentinel' },
    { id: 'plain', provider: 'deepseek', kind: 'api', baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-PLAINTEXT-KEY', models: ['deepseek-x'], enabled: true, label: 'Plain' },
  ],
  defaults: {},
}));
process.env.CLONE_FRAME_HUB_ROOT = root;
const Models = (await import('../bridge/models.mjs')).default;
const { createModelPort } = await import('../bridge/model/port.mjs');

test('_raw never hands the Keychain sentinel out as an API key', () => {
  const rec = Models._raw('kc');
  assert.ok(rec, 'the seeded provider should be readable');
  assert.notEqual(rec.apiKey, SENTINEL,
    'the sentinel escaped into a record the port will put in an Authorization header');
});

test('a plaintext key still comes through untouched', () => {
  // On a test root the Keychain is off by design (kcEnabled() is false whenever
  // CLONE_FRAME_HUB_ROOT is set), so keys live in the 0600 store. Resolution must be a
  // no-op there rather than blanking the key.
  assert.equal(Models._raw('plain').apiKey, 'sk-PLAINTEXT-KEY');
});

test('the port never puts the sentinel on the wire', async () => {
  const seen = [];
  const port = createModelPort({
    registry: Models,
    fetchImpl: async (url, opts) => {
      seen.push({ url, headers: opts.headers || {} });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    },
  });
  const target = port.resolveTarget({ providerId: 'kc' });
  assert.notEqual(target.apiKey, SENTINEL, 'resolveTarget leaked the sentinel');
  try { await port.ask({ providerId: 'kc', messages: [{ role: 'user', content: 'hi' }] }); } catch { /* wire shape is not what this test is about */ }
  for (const c of seen) {
    const blob = JSON.stringify(c.headers);
    assert.ok(!blob.includes(SENTINEL), 'the sentinel reached an outgoing request header: ' + blob);
  }
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
