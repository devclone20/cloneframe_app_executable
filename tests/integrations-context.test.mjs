// Context test for the integrations registry AFTER its local JSON store was
// migrated onto the shared json-store port (Wave-3). Proves the swap is
// behavior-preserving against a REAL filesystem store, isolated to a throwaway
// dir via CLONE_FRAME_HUB_ROOT (the hub-root seam). Exercises ONLY the module's
// own local-store CRUD (add/list/get/update/remove/setDefault) — never the live
// handshake test() nor the chain/DAV/network paths. Secrets are dummy strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Dummy secrets — must persist on disk (test() needs them for the live
// handshake) but must NEVER surface in the sanitized public projection.
const API_KEY_SECRET = 'sk-DUMMY-apikey-must-not-leak-0001';
const HEADER_SECRET = 'DUMMY-authheader-value-must-not-leak-0002';
const DAV_PASS_SECRET = 'DUMMY-caldav-password-must-not-leak-0003';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshIntegrations() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-integrations-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/integrations.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, I: mod.Integrations, file: path.join(root, 'integrations.json') };
}

test('add → list → get round-trips, and persists to integrations.json', async () => {
  const { I, file } = await freshIntegrations();
  assert.deepEqual(await I.list(), []); // empty store, no throw on missing file

  const res = await I.add({
    type: 'api',
    name: 'Example API',
    config: { baseUrl: 'https://api.example.test', method: 'GET', apiKey: API_KEY_SECRET },
  });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const list = await I.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, res.id);
  assert.equal(list[0].name, 'Example API');
  assert.equal(list[0].type, 'api');
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].isDefault, true); // first of its type
  assert.equal(list[0].meta.hasAuth, true);

  const got = await I.get(res.id);
  assert.equal(got.id, res.id);
  assert.equal(got.meta.baseUrl, 'https://api.example.test');

  // persisted shape: {version, integrations:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.integrations.length, 1);
  assert.equal(onDisk.integrations[0].id, res.id);
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('update / setDefault / remove preserve their contracts and re-elect a default', async () => {
  const { I } = await freshIntegrations();
  const a = await I.add({ type: 'api', name: 'first', config: { baseUrl: 'https://a.test' } });
  const b = await I.add({ type: 'api', name: 'second', config: { baseUrl: 'https://b.test' } });
  assert.equal((await I.get(a.id)).isDefault, true); // first of type
  assert.equal((await I.get(b.id)).isDefault, false);

  assert.equal((await I.update(a.id, { name: 'first renamed' })).ok, true);
  assert.equal((await I.get(a.id)).name, 'first renamed');

  assert.equal((await I.setDefault(b.id)).ok, true);
  assert.equal((await I.get(a.id)).isDefault, false);
  assert.equal((await I.get(b.id)).isDefault, true);

  // removing the current default re-elects the next of the same type
  assert.equal((await I.remove(b.id)).ok, true);
  assert.equal(await I.get(b.id), null);
  assert.equal((await I.get(a.id)).isDefault, true);

  assert.equal((await I.remove(b.id)).ok, false); // gone
  assert.equal((await I.list()).length, 1);
});

test('a corrupt store degrades to empty instead of throwing, and a write recovers it', async () => {
  const { I, file } = await freshIntegrations();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(await I.list(), []);

  const res = await I.add({ type: 'api', name: 'ok', config: { baseUrl: 'https://ok.test' } });
  assert.equal(res.ok, true);
  assert.equal((await I.list()).length, 1);
});

test('stored secrets persist on disk at 0600 but NEVER appear in the public projection', async () => {
  const { I, file } = await freshIntegrations();

  const api = await I.add({
    type: 'api',
    name: 'secret api',
    config: {
      baseUrl: 'https://secret.test',
      apiKey: API_KEY_SECRET,
      authHeader: { name: 'X-Api-Key', value: HEADER_SECRET },
    },
  });
  const dav = await I.add({
    type: 'caldav',
    name: 'secret dav',
    config: { url: 'https://dav.test/cal', username: 'alice', password: DAV_PASS_SECRET },
  });
  assert.equal(api.ok, true);
  assert.equal(dav.ok, true);

  // The public read projections (list + get) carry meta only — never raw config.
  const publicListJson = JSON.stringify(await I.list());
  const publicGetJson = JSON.stringify(await I.get(api.id)) + JSON.stringify(await I.get(dav.id));
  for (const secret of [API_KEY_SECRET, HEADER_SECRET, DAV_PASS_SECRET]) {
    assert.equal(publicListJson.includes(secret), false, `list() leaked ${secret}`);
    assert.equal(publicGetJson.includes(secret), false, `get() leaked ${secret}`);
  }
  // hasAuth flag is still surfaced (derived, non-reversible), not the secret.
  assert.equal((await I.get(api.id)).meta.hasAuth, true);
  assert.equal((await I.get(dav.id)).meta.hasAuth, true);

  // …yet the secrets ARE persisted on disk (test() needs them for the live
  // handshake), and the file stays 0600.
  const onDiskJson = fs.readFileSync(file, 'utf8');
  for (const secret of [API_KEY_SECRET, HEADER_SECRET, DAV_PASS_SECRET]) {
    assert.equal(onDiskJson.includes(secret), true, `store failed to persist ${secret}`);
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
