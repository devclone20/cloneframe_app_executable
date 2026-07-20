// Context test for the contacts domain module AFTER its migration onto the
// shared json-store port (Wave-3). Proves the migration is behavior-preserving
// end-to-end against a REAL filesystem store, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam). It exercises ONLY the local-store
// CRUD surface (add/list/get/update/remove/importVCard/importCSV/count) — the
// CardDAV network path (carddavSync) is deliberately never called here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshContacts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-contacts-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/contacts.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, C: mod.Contacts, file: path.join(root, 'contacts.json') };
}

test('add → list → get round-trips, and persists to contacts.json at 0600', async () => {
  const { C, file } = await freshContacts();
  assert.deepEqual(C.list(), []);        // empty store, no throw on missing file
  assert.equal(C.count(), 0);

  const res = C.add({ displayName: 'Ada Lovelace', emails: ['ada@example.com'], phones: ['+123'], org: 'Analytical' });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const list = C.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].displayName, 'Ada Lovelace');
  assert.deepEqual(list[0].emails, ['ada@example.com']);
  assert.equal(list[0].source, 'manual');
  assert.equal(C.get(res.id).org, 'Analytical');
  assert.equal(C.count(), 1);

  // persisted shape: {version, contacts:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.contacts.length, 1);
  assert.equal(onDisk.contacts[0].displayName, 'Ada Lovelace');
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('update / remove preserve their contracts', async () => {
  const { C } = await freshContacts();
  const { id } = C.add({ displayName: 'Grace', emails: ['grace@navy.mil'] });

  assert.equal(C.update(id, { displayName: 'Grace Hopper', phones: ['+1-555'] }).ok, true);
  assert.equal(C.get(id).displayName, 'Grace Hopper');
  assert.deepEqual(C.get(id).phones, ['+1-555']);
  assert.equal(C.update('does-not-exist', { org: 'x' }).ok, false);

  assert.equal(C.remove(id).ok, true);
  assert.equal(C.get(id), null);
  assert.equal(C.remove(id).ok, false); // already gone
  assert.equal(C.count(), 0);
});

test('importVCard / importCSV parse, merge (dedupe by primary email), and persist', async () => {
  const { C, file } = await freshContacts();

  const vcard = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Alan Turing', 'EMAIL:alan@example.com', 'TEL:+44', 'END:VCARD',
  ].join('\r\n');
  const v = C.importVCard(vcard);
  assert.equal(v.ok, true);
  assert.equal(v.imported, 1);
  assert.equal(C.count(), 1);

  // same primary email → merged, not duplicated
  const csv = 'name,email,phone,org\nAlan M. Turing,alan@example.com,+44-2,Bletchley\nKaty,katy@example.com,,Acme\n';
  const c = C.importCSV(csv);
  assert.equal(c.ok, true);
  assert.equal(c.imported, 2);
  assert.equal(C.count(), 2); // Alan merged, Katy new

  const alan = C.list({ search: 'alan@example.com' })[0];
  assert.equal(alan.org, 'Bletchley');
  assert.equal(alan.phones.includes('+44'), true);
  assert.equal(alan.phones.includes('+44-2'), true);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.contacts.length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { C, file } = await freshContacts();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(C.list(), []);
  assert.equal(C.count(), 0);
  // and a write still recovers the store
  assert.equal(C.add({ displayName: 'Recovered' }).ok, true);
  assert.equal(C.count(), 1);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.contacts.length, 1);
});
