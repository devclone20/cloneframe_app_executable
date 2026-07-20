// Context test for the Gallery domain module AFTER migrating ONLY its JSON
// index (gallery.json) onto the shared json-store port (Wave-3). The raw image
// blobs still live as separate files under <root>/gallery/ — this test drives
// them through the real public API so the index round-trip is exercised exactly
// as production does it. Isolated to a throwaway dir via CLONE_FRAME_HUB_ROOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Minimal valid 1x1 PNG — add() requires decodable image bytes (magic-byte
// sniff → image/png). The point under test is the JSON INDEX round-trip, not
// the pixels; this is the smallest input that lets add() reach the index store.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function freshGallery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-gallery-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/gallery.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, G: mod.Gallery, file: path.join(root, 'gallery.json'), blobDir: path.join(root, 'gallery') };
}

test('add → list → get round-trips through the index, persists to gallery.json (0600)', async () => {
  const { G, file, blobDir } = await freshGallery();
  assert.deepEqual(G.list(), []); // empty store, no throw on missing index

  const res = G.add({ prompt: 'a test image', mimeType: 'image/png', contentBase64: PNG_1x1, tags: ['x'] });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const list = G.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].prompt, 'a test image');
  assert.equal(list[0].mimeType, 'image/png');
  assert.equal(list[0].source, 'import');
  assert.deepEqual(list[0].tags, ['x']);

  const got = G.get(res.id);
  assert.ok(got.dataUri.startsWith('data:image/png;base64,'));
  assert.equal(got.mimeType, 'image/png');

  // index persisted shape: {version:1, items:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.items.length, 1);
  // index file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // blob still lives as a separate file in the gallery/ subdir (not in the index)
  assert.equal(fs.existsSync(path.join(blobDir, list[0].filename)), true);
});

test('remove clears the index entry and count reflects it', async () => {
  const { G } = await freshGallery();
  const { id } = G.add({ prompt: 'p', mimeType: 'image/png', contentBase64: PNG_1x1 });
  assert.equal(G.count(), 1);
  assert.equal(G.remove(id).ok, true);
  assert.equal(G.get(id), null);
  assert.deepEqual(G.list(), []);
  assert.equal(G.count(), 0);
  assert.equal(G.remove(id).ok, false); // gone → not found
});

test('a corrupt index degrades to empty instead of throwing', async () => {
  const { G, file } = await freshGallery();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not valid json');
  assert.deepEqual(G.list(), []);
  // and a subsequent add still recovers the index
  assert.equal(G.add({ prompt: 'ok', mimeType: 'image/png', contentBase64: PNG_1x1 }).ok, true);
  assert.equal(G.list().length, 1);
});
