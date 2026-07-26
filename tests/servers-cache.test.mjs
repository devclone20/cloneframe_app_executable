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

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION (2026-07-26). This module reaches the owner's PRODUCTION machines
// and his wallet: run() executes arbitrary commands over SSH, provision() creates a
// paid droplet, powerAction() can switch one off. Every one of them used to be
// reachable with no permission check at all, while ssh.mjs — doing strictly less —
// already gated on Permissions.can('ssh').
//
// These tests are the boundary. Each asserts BOTH directions, because a gate that
// only ever refuses is indistinguishable from a broken module: refused when the
// permission is off, and reaching the real code path when it is on.
// NOTE the import specifiers. servers.mjs imports './permissions.mjs' verbatim, so the
// gate reads THAT module instance. Importing '../bridge/permissions.mjs?ctx=…' here would
// create a SECOND instance, and set() would flip a permission the gate never reads — a
// test that passes or fails for reasons unrelated to the code under test. The permissions
// specifier is therefore deliberately un-busted: same URL, same instance, same in-memory
// perms object that can() consults. (The root is set first so the file it writes is the
// throwaway one, never the developer's real ~/.clone-frame-hub/permissions.json.)
async function freshServersWithPerms(sshOn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-servers-perm-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const P = (await import('../bridge/permissions.mjs')).Permissions;
  P.set({ ssh: !!sshOn });
  const S = (await import('../bridge/servers.mjs?ctx=' + Math.random().toString(36).slice(2))).Servers;
  return { root, S, P };
}

const DENIED = 'ssh permission is off — enable it in Settings → Agent Tools';

test('servers — every remote-touching call is refused while the ssh permission is off', async () => {
  const { S } = await freshServersWithPerms(false);
  const added = S.add({ name: 'prod', host: '203.0.113.9', user: 'ops' });
  const id = added.server.id;

  // run / runAutomation / deployAgent / provision / powerAction all refuse identically
  assert.deepEqual(await S.run(id, 'whoami'), { ok: false, error: DENIED });
  assert.deepEqual(await S.runAutomation(id, 'restart'), { ok: false, error: DENIED });
  assert.deepEqual(await S.deployAgent(id, {}), { ok: false, error: DENIED });
  assert.deepEqual(await S.provision({ name: 'x' }), { ok: false, error: DENIED });
  assert.deepEqual(await S.powerAction(id, 'power_off'), { ok: false, error: DENIED });

  // test() keeps its own shape so the UI can say WHY rather than "unreachable"
  assert.deepEqual(await S.test(id), { ok: true, reachable: false, detail: 'ssh permission is off' });
});

test('servers — the gate refuses BEFORE any ssh is attempted, not after it times out', async () => {
  const { S } = await freshServersWithPerms(false);
  const id = S.add({ name: 'prod', host: '203.0.113.9' }).server.id;   // TEST-NET-3, unroutable
  const t0 = Date.now();
  const r = await S.run(id, 'sleep 30');
  const elapsed = Date.now() - t0;
  assert.deepEqual(r, { ok: false, error: DENIED });
  // An unroutable host would burn the 10s ConnectTimeout before failing. Returning
  // instantly is the proof that nothing was dialled at all.
  assert.ok(elapsed < 1000, `refusal must be immediate, took ${elapsed}ms — the gate ran too late`);
});

// Unlike the three above, this one passes with OR without the gate — deliberately. It is
// not a gate test; it guards the opposite failure, a future change that over-gates and
// makes the app unusable with ssh off. Keeping the two purposes labelled matters: an
// unfalsifiable test is only worthless when it is pretending to prove something else.
test('servers — reads and local config edits stay open with ssh off', async () => {
  const { S } = await freshServersWithPerms(false);
  const added = S.add({ name: 'prod', host: '203.0.113.9' });
  assert.equal(added.ok, true, 'adding a server is local config, not a remote touch');
  assert.equal(S.list().ok, true);
  assert.equal(S.get(added.server.id).ok, true);
  assert.equal(S.automations().ok, true);
});

test('servers — with ssh ON the gate steps aside and the module answers for itself', async () => {
  const { S } = await freshServersWithPerms(true);
  // An unknown id is rejected by the MODULE, not the gate — and instantly, with no
  // network. So the two directions are distinguishable without dialling anything:
  //   ssh off -> the permission error   |   ssh on -> the module's own error
  const r = await S.run('no-such-server', 'whoami');
  assert.equal(r.ok, false);
  assert.notEqual(r.error, DENIED, 'the ssh permission must no longer be what blocks this');
  assert.equal(r.error, 'server not found');

  const off = await freshServersWithPerms(false);
  assert.deepEqual(await off.S.run('no-such-server', 'whoami'), { ok: false, error: DENIED },
    'and with ssh off the SAME call never reaches that lookup');
});
