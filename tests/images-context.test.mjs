// Context test for the Images (BYOK) domain module AFTER migrating its
// images.json store onto the shared json-store port (Wave-3). Proves the key
// round-trips to disk at 0600, is NEVER exposed by status(), and that a
// missing/corrupt store degrades to "unconfigured". Isolated to a throwaway dir
// via CLONE_FRAME_HUB_ROOT. No network call is made (generate() is not driven).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A dummy placeholder — never a real-looking credential.
const DUMMY_KEY = 'test-dummy-key';

async function freshImages() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-images-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/images.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, I: mod.Images, file: path.join(root, 'images.json') };
}

test('config persists the key to images.json (0600); status never exposes it', async () => {
  const { I, file } = await freshImages();
  assert.deepEqual(I.status(), { configured: false }); // no store yet, no throw

  const res = I.config({ provider: 'openai', apiKey: DUMMY_KEY, model: 'dall-e-3' });
  assert.equal(res.ok, true);
  assert.equal(res.apiKey, undefined); // config() never echoes the key back

  const st = I.status();
  assert.deepEqual(st, { configured: true, provider: 'openai', model: 'dall-e-3' });
  assert.equal('apiKey' in st, false); // status() must never carry the key

  // on-disk shape: {version:1, provider, apiKey, model}; key IS persisted (BYOK)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.provider, 'openai');
  assert.equal(onDisk.apiKey, DUMMY_KEY);
  // 0600 — the secret is protected at rest
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('providers() returns the static catalog without any key material', async () => {
  const { I } = await freshImages();
  const list = I.providers();
  assert.ok(Array.isArray(list));
  const openai = list.find((p) => p.id === 'openai');
  assert.ok(openai);
  assert.ok(Array.isArray(openai.models) && openai.models.length > 0);
  assert.equal('apiKey' in openai, false);
});

test('removeConfig clears the store and returns to unconfigured', async () => {
  const { I, file } = await freshImages();
  assert.equal(I.config({ provider: 'stability', apiKey: DUMMY_KEY }).ok, true);
  assert.equal(I.status().configured, true);
  assert.equal(I.removeConfig().ok, true);
  assert.deepEqual(I.status(), { configured: false });
  assert.equal(fs.existsSync(file), false);
  assert.equal(I.removeConfig().ok, true); // idempotent
});

test('a corrupt store degrades to unconfigured instead of throwing', async () => {
  const { I, file } = await freshImages();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not valid json');
  assert.deepEqual(I.status(), { configured: false });
  // and config() still recovers the store
  assert.equal(I.config({ provider: 'openai', apiKey: DUMMY_KEY }).ok, true);
  assert.equal(I.status().configured, true);
});
