// Context test for the servers domain module AFTER its migration off the
// module-level `let store = load()` singleton and onto the shared json-store
// port (read-per-call, atomic 0600 writes). Proves the migration is
// behavior-preserving end-to-end against a REAL filesystem store, isolated to a
// throwaway dir via CLONE_FRAME_HUB_ROOT (the hub-root seam). Follows the
// Wave-3 template: set the env root, dynamic-import the module fresh, exercise
// its public RPC surface, assert on-disk shape / perms / secret masking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshServers() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-servers-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/servers.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, S: mod.Servers, file: path.join(root, 'servers.json') };
}

test('add → list → get round-trips and persists to servers.json (0600, version stamped)', async () => {
  const { S, file } = await freshServers();
  assert.deepEqual(S.list(), { ok: true, servers: [] }); // empty store, no throw on missing file
  const res = S.add({ name: 'droplet-a', host: '10.0.0.1', user: 'root', keyPath: '/home/me/.ssh/id_ed25519', doToken: 'dop_v1_secret' });
  assert.equal(res.ok, true);
  assert.match(res.server.id, /^[0-9a-f]{18}$/);

  const list = S.list();
  assert.equal(list.ok, true);
  assert.equal(list.servers.length, 1);
  assert.equal(list.servers[0].name, 'droplet-a');

  const got = S.get(res.server.id);
  assert.equal(got.ok, true);
  assert.equal(got.server.host, '10.0.0.1');

  // on-disk shape: {version:1, servers:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.servers.length, 1);
  // file perms 0600 (atomicity + secrecy gained by the port)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('secrets are persisted but NEVER surfaced through the public projection', async () => {
  const { S, file } = await freshServers();
  const { server } = S.add({ name: 'secret-box', host: '1.2.3.4', keyPath: '/secrets/prod_key', doToken: 'dop_v1_topsecret' });

  // public projection masks: key by basename only, token as a boolean, no raw doToken
  assert.equal(server.keyPath, 'prod_key');
  assert.equal(server.hasKey, true);
  assert.equal(server.hasToken, true);
  assert.equal('doToken' in server, false);

  // ...but the raw secrets ARE on disk (needed for SSH/DO ops)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.servers[0].keyPath, '/secrets/prod_key');
  assert.equal(onDisk.servers[0].doToken, 'dop_v1_topsecret');
});

test('update / remove preserve their contracts and re-persist', async () => {
  const { S } = await freshServers();
  const { server } = S.add({ name: 'box', host: '5.5.5.5' });
  const id = server.id;

  const up = S.update(id, { name: 'box-renamed', port: 2222 });
  assert.equal(up.ok, true);
  assert.equal(up.server.name, 'box-renamed');
  assert.equal(up.server.port, 2222);
  assert.equal(S.get(id).server.port, 2222); // read-per-call sees the write

  assert.equal(S.update('nope', { name: 'x' }).ok, false);

  const rm = S.remove(id);
  assert.equal(rm.ok, true);
  assert.equal(rm.removed, true);
  assert.equal(S.get(id).ok, false);

  const rm2 = S.remove(id);
  assert.equal(rm2.ok, true);
  assert.equal(rm2.removed, false); // already gone
});

test('read-per-call: a second write is visible without re-import (no stale singleton)', async () => {
  const { S, file } = await freshServers();
  S.add({ name: 'first', host: '9.9.9.9' });

  // Simulate an out-of-band edit to the same file (the exact bug the port fixes:
  // the old `let store = load()` singleton would never see this until restart).
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  onDisk.servers.push({ id: 'abc123def456ghi789', name: 'injected', provider: 'ssh', host: '7.7.7.7', user: 'root', keyPath: '', port: 22, doToken: '', dropletId: null, createdAt: 1 });
  fs.writeFileSync(file, JSON.stringify(onDisk));

  const names = S.list().servers.map((x) => x.name).sort();
  assert.deepEqual(names, ['first', 'injected']);
});

test('a corrupt store degrades to empty instead of throwing, and a write recovers it', async () => {
  const { S, file } = await freshServers();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(S.list(), { ok: true, servers: [] });

  const res = S.add({ name: 'recovered', host: '8.8.8.8' });
  assert.equal(res.ok, true);
  assert.equal(S.list().servers.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
