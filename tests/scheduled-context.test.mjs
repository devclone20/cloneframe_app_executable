// Context test for the scheduled-send domain module AFTER its migration onto the
// json-store port + the lost-update fix (Wave-3 / T-011 mail). Proves the public
// contract is preserved and that every WRITE-path method now routes through
// store.mutate() (schedule/cancel/reschedule became async — the RPC dispatcher
// awaits them; the only in-process caller already `await S.tick()`s).
//
// The lost-update guarantee itself (mutate() serializes a read-modify-write even
// across an awaited I/O inside tick()) is proven deterministically at the port
// level in json-store-port.test.mjs ("concurrent mutate() calls never lose an
// update", which awaits INSIDE the mutation). This test's job is to prove the
// routing + contracts, not to re-prove the primitive — and to do so without the
// IMAP/SMTP stack (tick()'s real send path is exercised elsewhere; here we drive
// due() read-only and tick()'s no-work fast path, the same discipline the
// approvals/style tests use for approve()/extractFromSent()).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

async function freshScheduled() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-scheduled-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/scheduled.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, S: mod.Scheduled, file: path.join(root, 'scheduled.json') };
}

// Seed a store file directly (schedule() refuses a past sendAt, so a due item
// can only be created out-of-band — exactly how a real backlog looks after time
// passes).
function seed(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, items }, null, 2), { mode: 0o600 });
}

test('schedule → list → get round-trips and persists {version,items} at 0600', async () => {
  const { S, file } = await freshScheduled();
  assert.deepEqual(S.list(), []);
  const res = await S.schedule({ accountId: 'acct1', to: 'a@b.com', subject: 'hi', body: 'later', sendAt: FUTURE });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);
  const list = S.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].subject, 'hi');
  assert.equal(S.get(res.id).body, 'later');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.items.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('schedule rejects a past sendAt and missing required fields', async () => {
  const { S } = await freshScheduled();
  assert.equal((await S.schedule({ accountId: 'a', to: 't@x', subject: 's', body: 'b', sendAt: '2000-01-01T00:00:00Z' })).ok, false);
  assert.equal((await S.schedule({ to: 't@x', subject: 's', body: 'b', sendAt: FUTURE })).ok, false); // no accountId
  assert.equal((await S.schedule({ accountId: 'a', subject: 's', body: 'b', sendAt: FUTURE })).ok, false); // no to
  assert.deepEqual(S.list(), []);
});

test('cancel / reschedule honour the pending-only rule (both async now)', async () => {
  const { S } = await freshScheduled();
  const { id } = await S.schedule({ accountId: 'a', to: 't@x', subject: 's', body: 'b', sendAt: FUTURE });
  const later = new Date(Date.now() + 7200_000).toISOString();
  assert.equal((await S.reschedule(id, later)).ok, true);
  assert.equal(S.get(id).sendAt, later);
  assert.equal((await S.cancel(id)).ok, true);
  assert.equal(S.get(id).status, 'canceled');
  assert.equal((await S.cancel(id)).ok, false); // not pending anymore
  assert.equal((await S.reschedule(id, later)).ok, false);
});

test('due() returns past-due pending items (read-only, no send)', async () => {
  const { S, file } = await freshScheduled();
  seed(file, [
    { id: 'past1', accountId: 'a', to: 't@x', subject: 'p', body: 'b', sendAt: '2000-01-01T00:00:00Z', status: 'pending' },
    { id: 'fut1', accountId: 'a', to: 't@x', subject: 'f', body: 'b', sendAt: FUTURE, status: 'pending' },
    { id: 'sent1', accountId: 'a', to: 't@x', subject: 's', body: 'b', sendAt: '2000-01-01T00:00:00Z', status: 'sent' },
  ]);
  const due = S.due();
  assert.equal(due.length, 1);
  assert.equal(due[0].id, 'past1');
  // due() must not mutate the store
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.items.length, 3);
});

test('tick() fast path: nothing due → {sent:0,failed:0} and the store is not rewritten', async () => {
  const { S, file } = await freshScheduled();
  seed(file, [{ id: 'fut1', accountId: 'a', to: 't@x', subject: 'f', body: 'b', sendAt: FUTURE, status: 'pending' }]);
  const mtimeBefore = fs.statSync(file).mtimeMs;
  const res = await S.tick();
  assert.deepEqual(res, { sent: 0, failed: 0 });
  // fast path takes no mutate() lock and performs no write
  assert.equal(fs.statSync(file).mtimeMs, mtimeBefore);
});

test('concurrent write-path calls all land (mutate routing, no lost update)', async () => {
  const { S } = await freshScheduled();
  const mk = (n) => S.schedule({ accountId: 'a', to: 't@x', subject: 's' + n, body: 'b', sendAt: FUTURE });
  const ids = (await Promise.all([mk(0), mk(1), mk(2), mk(3), mk(4)])).map((r) => r.id);
  assert.equal(S.list().length, 5);
  // cancel two of them concurrently with two more schedules
  const [c1, c2, s5, s6] = await Promise.all([S.cancel(ids[0]), S.cancel(ids[1]), mk(5), mk(6)]);
  assert.ok(c1.ok && c2.ok && s5.ok && s6.ok);
  assert.equal(S.list().length, 7);
  assert.equal(S.list({ status: 'canceled' }).length, 2);
  assert.equal(S.list({ status: 'pending' }).length, 5);
});

test('corrupt store degrades to empty instead of throwing', async () => {
  const { S, file } = await freshScheduled();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json at all');
  assert.deepEqual(S.list(), []);
  assert.equal((await S.schedule({ accountId: 'a', to: 't@x', subject: 's', body: 'b', sendAt: FUTURE })).ok, true);
  assert.equal(S.list().length, 1);
});
