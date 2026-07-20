// Context test for the models domain module AFTER its migration onto the shared
// json-store port. Proves the LOCAL-STORE surface (add / list / get / update /
// remove providers + defaults + enable/model toggles — the CRUD that touches
// ~/.clone-frame-hub/models.json) is behavior-preserving against a REAL fs store
// isolated via CLONE_FRAME_HUB_ROOT. The live-probe/network paths (testProvider,
// listModels, brainStatus, the Anthropic wire) are deliberately NOT exercised.
//
// Secret handling is a first-class assertion: a dummy apiKey is passed in and we
// assert it NEVER surfaces in any projection (listProviders / getProvider /
// getDefaults). It legitimately lives in the 0600 on-disk record — that is the
// module's documented design ("apiKey lives ONLY in the on-disk store").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DUMMY_KEY = 'sk-DUMMY-not-a-real-key-000000000000';
const DUMMY_KEY_2 = 'sk-DUMMY-rotated-111111111111';

async function freshModels() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-models-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/models.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, M: mod.Models, file: path.join(root, 'models.json') };
}

test('addProvider → list/get round-trip; the apiKey never leaks into a projection', async () => {
  const { M, file } = await freshModels();
  assert.deepEqual(M.listProviders(), []); // empty store, no throw on missing file

  const res = M.addProvider({ kind: 'api', provider: 'openai', apiKey: DUMMY_KEY });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const list = M.listProviders();
  assert.equal(list.length, 1);
  assert.equal(list[0].provider, 'openai');
  assert.equal(list[0].baseUrl, 'https://api.openai.com/v1'); // filled from KNOWN catalog
  assert.equal(list[0].enabled, true);
  assert.equal(list[0].hasApiKey, true);
  assert.equal(list[0].apiKey, undefined); // masked

  const one = M.getProvider(res.id);
  assert.equal(one.hasApiKey, true);
  assert.equal(one.apiKey, undefined);

  // No projection anywhere may contain the raw key.
  assert.ok(!JSON.stringify(M.listProviders()).includes(DUMMY_KEY));
  assert.ok(!JSON.stringify(M.getProvider(res.id)).includes(DUMMY_KEY));
  assert.ok(!JSON.stringify(M.getDefaults()).includes(DUMMY_KEY));

  // Persisted shape: {version, providers, defaults}; the 0600 on-disk record
  // legitimately holds the key (that is where it is meant to live).
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.providers.length, 1);
  assert.equal(onDisk.providers[0].apiKey, DUMMY_KEY);
  assert.deepEqual(onDisk.defaults, {});
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('defaults: set/get, and removeProvider clears any default that referenced it', async () => {
  const { M } = await freshModels();
  const { id } = M.addProvider({ kind: 'api', provider: 'openai', apiKey: DUMMY_KEY });

  // Every known capability is present and null until set.
  const empty = M.getDefaults();
  for (const cap of ['chat', 'email_summary', 'email_reply', 'email_tags']) {
    assert.equal(empty[cap], null);
  }

  assert.equal(M.setDefault('chat', { providerId: id, model: 'gpt-4o' }).ok, true);
  assert.deepEqual(M.getDefaults().chat, { providerId: id, model: 'gpt-4o' });

  assert.equal(M.setDefault('chat', { providerId: null }).ok, true); // clear
  assert.equal(M.getDefaults().chat, null);

  M.setDefault('chat', { providerId: id, model: 'gpt-4o' });
  assert.equal(M.removeProvider(id).ok, true);
  assert.equal(M.getDefaults().chat, null); // cleared on removal
  assert.deepEqual(M.listProviders(), []);
});

test('updateProvider / setEnabled / setModels / setModelEnabled round-trip', async () => {
  const { M } = await freshModels();
  const { id } = M.addProvider({ kind: 'api', provider: 'openai', apiKey: DUMMY_KEY });

  assert.equal(M.updateProvider(id, { label: 'My OpenAI', apiKey: DUMMY_KEY_2 }).ok, true);
  const updated = M.getProvider(id);
  assert.equal(updated.label, 'My OpenAI');
  assert.equal(updated.hasApiKey, true);
  assert.ok(!JSON.stringify(updated).includes(DUMMY_KEY_2)); // rotated key still masked

  assert.equal(M.setEnabled(id, false).ok, true);
  assert.equal(M.getProvider(id).enabled, false);

  assert.equal(M.setModels(id, ['b', 'a', 'a', '  ']).count, 2); // deduped + trimmed
  assert.deepEqual(M.getProvider(id).models, ['a', 'b']); // sorted

  assert.equal(M.setModelEnabled(id, 'a', false).ok, true);
  assert.deepEqual(M.getProvider(id).disabledModels, ['a']);
  assert.equal(M.setModelEnabled(id, 'a', true).ok, true);
  assert.deepEqual(M.getProvider(id).disabledModels, []);
});

test('a corrupt store degrades to empty instead of throwing, and a write recovers it', async () => {
  const { M, file } = await freshModels();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ providers: not-json');

  assert.deepEqual(M.listProviders(), []);
  const defaults = M.getDefaults();
  for (const cap of ['chat', 'email_summary', 'email_reply', 'email_tags']) {
    assert.equal(defaults[cap], null);
  }

  assert.equal(M.addProvider({ kind: 'local', provider: 'ollama' }).ok, true);
  assert.equal(M.listProviders().length, 1);
});
