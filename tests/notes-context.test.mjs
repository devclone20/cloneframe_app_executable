// Context test for the notes domain module AFTER its migration onto the shared
// json-store port (Wave-3). Proves the migration is behavior-preserving end-to-
// end against a REAL filesystem store, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam). Follows the reminders-context
// template: set the env root, dynamic-import the module fresh, exercise its
// public RPC surface, assert on-disk shape + perms.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshNotes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-notes-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/notes.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, N: mod.Notes, file: path.join(root, 'notes.json') };
}

test('create → list → get round-trips, and persists to notes.json', async () => {
  const { N, file } = await freshNotes();
  assert.deepEqual(N.list(), []); // empty store, no throw on missing file
  const res = N.create({ title: 'Groceries', body: '# Milk\nand **eggs**', tags: ['home', 'HOME', 'shopping'] });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const list = N.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Groceries');
  assert.deepEqual(list[0].tags, ['home', 'shopping']); // dedup case-insensitive, first-cased kept
  assert.equal(list[0].snippet.includes('*'), false); // markdown stripped for the preview

  const full = N.get(res.id);
  assert.equal(full.body, '# Milk\nand **eggs**'); // full body preserved (not the snippet)

  // persisted shape: {version, notes:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.notes.length, 1);
  assert.equal(onDisk.notes[0].title, 'Groceries');
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('update / remove / tags preserve their contracts', async () => {
  const { N } = await freshNotes();
  const a = N.create({ title: 'A', body: 'alpha', tags: ['x'] });
  const b = N.create({ title: 'B', body: 'beta', tags: ['y', 'x'] });
  assert.deepEqual(N.tags(), ['x', 'y']); // sorted, de-duplicated union

  assert.equal(N.update(a.id, { title: 'A2', tags: ['z'] }).ok, true);
  assert.equal(N.get(a.id).title, 'A2');
  assert.deepEqual(N.get(a.id).tags, ['z']); // arrays replace, not merge
  assert.equal(N.update('nope', { title: 'x' }).ok, false); // unknown id

  assert.equal(N.remove(b.id).ok, true);
  assert.equal(N.get(b.id), null);
  assert.equal(N.remove(b.id).ok, false); // gone
  assert.equal(N.list().length, 1);
});

test('list honours search + tag filters', async () => {
  const { N } = await freshNotes();
  N.create({ title: 'Recipe', body: 'roast the garlic', tags: ['food'] });
  N.create({ title: 'Meeting', body: 'sync with team', tags: ['work'] });

  const bySearch = N.list({ search: 'GARLIC' }); // case-insensitive across body
  assert.equal(bySearch.length, 1);
  assert.equal(bySearch[0].title, 'Recipe');

  const byTag = N.list({ tag: 'work' });
  assert.equal(byTag.length, 1);
  assert.equal(byTag[0].title, 'Meeting');
});

test('create rejects an empty note without touching the store', async () => {
  const { N, file } = await freshNotes();
  const res = N.create({ title: '   ', body: '   ' });
  assert.equal(res.ok, false);
  assert.match(res.error, /required/);
  assert.equal(fs.existsSync(file), false); // nothing persisted
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { N, file } = await freshNotes();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(N.list(), []);
  // and a write still recovers the store
  assert.equal(N.create({ title: 'ok', body: 'recovered' }).ok, true);
  assert.equal(N.list().length, 1);
});
