// Context test for the approvals domain module AFTER its migration onto the
// shared json-store port (Wave-3). Proves the persistence swap is behavior-
// preserving end-to-end against a REAL filesystem store, isolated to a throwaway
// dir via CLONE_FRAME_HUB_ROOT (the hub-root seam). Follows the reminders
// template: set the env root, dynamic-import the module fresh, exercise its
// public RPC surface, assert on-disk shape. approve() is intentionally not
// exercised here — it lazy-imports email.mjs and performs a real send, which is
// outside the persistence surface under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshApprovals() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-approvals-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/approvals.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, A: mod.Approvals, file: path.join(root, 'approvals.json') };
}

test('add → list → get round-trips, and persists to approvals.json', async () => {
  const { A, file } = await freshApprovals();
  assert.deepEqual(A.list(), []); // empty store, no throw on missing file
  assert.deepEqual(A.count(), { pending: 0, total: 0 });

  const res = A.add({ accountId: 'acct-1', to: 'a@b.co', subject: 'hi', body: 'draft body' });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const list = A.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].accountId, 'acct-1');
  assert.equal(list[0].status, 'pending');
  assert.equal(A.get(res.id).body, 'draft body');
  assert.deepEqual(A.count(), { pending: 1, total: 1 });

  // persisted shape: {version, items:[...]}; version is the port's stamp
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.items[0].status, 'pending');
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('add validation, edit / reject / remove preserve their contracts', async () => {
  const { A } = await freshApprovals();
  assert.equal(A.add({ to: 'a@b.co', body: 'x' }).ok, false); // missing accountId
  assert.equal(A.add({ accountId: 'acct-1', body: 'x' }).ok, false); // missing to
  assert.equal(A.add({ accountId: 'acct-1', to: 'a@b.co' }).ok, false); // missing body

  const { id } = A.add({ accountId: 'acct-1', to: 'a@b.co', subject: 'draft', body: 'v1' });
  assert.equal(A.edit(id, { subject: 'edited' }).ok, true);
  assert.equal(A.get(id).subject, 'edited');
  assert.equal(A.edit(id, { body: '' }).ok, false); // body cannot be empty

  assert.equal(A.reject(id).ok, true);
  assert.equal(A.get(id).status, 'rejected');
  assert.ok(A.get(id).decidedAt);
  // a decided item can no longer be edited or rejected again
  assert.equal(A.edit(id, { subject: 'x' }).ok, false);
  assert.equal(A.reject(id).ok, false);

  assert.equal(A.remove(id).ok, true);
  assert.equal(A.get(id), null);
  assert.equal(A.remove(id).ok, false); // gone
});

test('list filters by status and returns [] for unknown status', async () => {
  const { A } = await freshApprovals();
  const p = A.add({ accountId: 'acct-1', to: 'a@b.co', body: 'pending one' });
  const r = A.add({ accountId: 'acct-1', to: 'a@b.co', body: 'reject one' });
  A.reject(r.id);
  assert.equal(A.list({ status: 'pending' }).length, 1);
  assert.equal(A.list({ status: 'pending' })[0].id, p.id);
  assert.equal(A.list({ status: 'rejected' }).length, 1);
  assert.deepEqual(A.list({ status: 'nonsense' }), []);
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { A, file } = await freshApprovals();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(A.list(), []);
  assert.deepEqual(A.count(), { pending: 0, total: 0 });
  // and a write still recovers the store
  assert.equal(A.add({ accountId: 'acct-1', to: 'a@b.co', body: 'ok' }).ok, true);
  assert.equal(A.list().length, 1);
});
