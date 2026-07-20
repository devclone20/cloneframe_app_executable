// Context test for the Library domain module AFTER its migration onto the
// shared json-store port (Wave-3). Proves the migration is behavior-preserving
// end-to-end against a REAL filesystem store, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam). Same template as reminders-context.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-library-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/library.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, L: mod.Library, file: path.join(root, 'library.json') };
}

test('add → list → get round-trips, and persists to library.json (0600)', async () => {
  const { L, file } = await freshLibrary();
  assert.deepEqual(L.list(), []); // empty store, no throw on missing file
  const res = L.add({ name: 'notes.txt', text: 'hello searchable world', tags: ['alpha', 'beta'] });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const list = L.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'notes.txt');
  assert.equal(list[0].mimeType, 'text/plain'); // resolved from .txt extension
  assert.equal(list[0].hasText, true);
  assert.deepEqual(list[0].tags, ['alpha', 'beta']);
  assert.equal(list[0].text, undefined); // list view never carries full text

  const doc = L.get(res.id);
  assert.equal(doc.text, 'hello searchable world'); // get view carries full text

  // persisted shape: {version:1, docs:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.docs.length, 1);
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('update / remove preserve their contracts', async () => {
  const { L } = await freshLibrary();
  const { id } = L.add({ name: 'draft.md', text: 'first' });
  assert.equal(L.update(id, { name: 'final.md', text: 'second draft' }).ok, true);
  const doc = L.get(id);
  assert.equal(doc.name, 'final.md');
  assert.equal(doc.text, 'second draft');
  assert.equal(doc.textLength, 'second draft'.length);
  assert.equal(L.count(), 1);
  assert.equal(L.remove(id).ok, true);
  assert.equal(L.get(id), null);
  assert.equal(L.remove(id).ok, false); // gone → not found
  assert.equal(L.count(), 0);
});

test('search finds a term across the persisted store', async () => {
  const { L } = await freshLibrary();
  L.add({ name: 'a', text: 'quantum entanglement notes' });
  L.add({ name: 'b', text: 'grocery list milk eggs' });
  const hits = L.search('quantum');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'a');
  assert.ok(Array.isArray(hits[0].excerpts));
  assert.ok(hits[0].excerpts.length >= 1);
  assert.deepEqual(L.search('nonexistentterm'), []);
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { L, file } = await freshLibrary();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(L.list(), []);
  // and a write still recovers the store
  assert.equal(L.add({ name: 'ok', text: 'recovered' }).ok, true);
  assert.equal(L.list().length, 1);
});
