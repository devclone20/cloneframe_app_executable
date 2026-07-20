// Context test for the reminders domain module AFTER its migration onto the
// shared json-store port (Wave-3 / T-012 pim). Proves the migration is
// behavior-preserving end-to-end against a REAL filesystem store, isolated to a
// throwaway dir via CLONE_FRAME_HUB_ROOT (the hub-root seam). This is the
// template every Wave-3 context test follows: set the env root, dynamic-import
// the module fresh, exercise its public RPC surface, assert on-disk shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshReminders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-reminders-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/reminders.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, R: mod.Reminders, file: path.join(root, 'reminders.json') };
}

test('create → list → get round-trips, and persists to reminders.json', async () => {
  const { R, file } = await freshReminders();
  assert.deepEqual(R.list(), []); // empty store, no throw on missing file
  const res = R.create({ note: 'water the plants', remindAt: '2030-01-01T09:00:00Z' });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);
  const list = R.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].note, 'water the plants');
  assert.equal(list[0].status, 'pending');
  assert.equal(R.get(res.id).note, 'water the plants');
  // persisted shape: {version, reminders:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.reminders.length, 1);
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('update / markDone / snooze / remove preserve their contracts', async () => {
  const { R } = await freshReminders();
  const { id } = R.create({ note: 'call bank', remindAt: '2030-02-02T10:00:00Z' });
  assert.equal(R.update(id, { note: 'call the bank' }).ok, true);
  assert.equal(R.get(id).note, 'call the bank');
  assert.equal(R.markDone(id).ok, true);
  assert.equal(R.get(id).status, 'done');
  assert.ok(R.get(id).doneAt);
  const sn = R.snooze(id, 30);
  assert.equal(sn.ok, true);
  assert.equal(R.get(id).status, 'pending'); // re-armed
  assert.equal(R.get(id).snoozedCount, 1);
  assert.equal(R.remove(id).ok, true);
  assert.equal(R.get(id), null);
  assert.equal(R.remove(id).ok, false); // gone
});

test('due() and counts() honour the cutoff instant', async () => {
  const { R } = await freshReminders();
  R.create({ note: 'past', remindAt: '2020-01-01T00:00:00Z' });
  R.create({ note: 'future', remindAt: '2999-01-01T00:00:00Z' });
  const due = R.due('2025-01-01T00:00:00Z');
  assert.equal(due.length, 1);
  assert.equal(due[0].note, 'past');
  const c = R.counts('2025-01-01T00:00:00Z');
  assert.equal(c.total, 2);
  assert.equal(c.pending, 2);
  assert.equal(c.due, 1);
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { R, file } = await freshReminders();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(R.list(), []);
  // and a write still recovers the store
  assert.equal(R.create({ note: 'ok', remindAt: '2030-01-01T00:00:00Z' }).ok, true);
  assert.equal(R.list().length, 1);
});
