// Context test for the browser domain module AFTER its migration off the
// module-level cached `let store = load()` singleton onto the shared json-store
// port (read-per-call + atomic 0600 writes). Proves the migration is
// behavior-preserving against a REAL filesystem store, isolated to a throwaway
// dir via CLONE_FRAME_HUB_ROOT (the hub-root seam).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshBrowser() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-browser-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/browser.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, B: mod.Browser, file: path.join(root, 'browser.json') };
}

test('empty store: history/bookmarks read clean with no file present', async () => {
  const { B, file } = await freshBrowser();
  assert.deepEqual(B.history(), []);
  assert.deepEqual(B.bookmarks(), []);
  assert.equal(fs.existsSync(file), false); // pure reads never create the file
});

test('bookmarks round-trip through disk, dedupe, and file is 0600', async () => {
  const { B, file } = await freshBrowser();
  const add = B.addBookmark({ url: 'https://linear.app', title: 'Linear' });
  assert.equal(add.ok, true);
  assert.match(add.id, /^[0-9a-z]{8}$/);
  // second identical url is a no-op dedupe, not a second entry
  const dup = B.addBookmark({ url: 'https://linear.app', title: 'Linear again' });
  assert.deepEqual(dup, { ok: true, dup: true });
  assert.equal(B.addBookmark({}).ok, false); // missing url rejected

  const marks = B.bookmarks();
  assert.equal(marks.length, 1);
  assert.equal(marks[0].url, 'https://linear.app');

  // persisted shape on disk + version stamp from the port
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.bookmarks.length, 1);
  assert.ok(Array.isArray(onDisk.history));
  // atomic 0600 file perms (the gain over the old hand-rolled writer)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // remove is persisted too
  assert.equal(B.removeBookmark(marks[0].id).ok, true);
  assert.deepEqual(B.bookmarks(), []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bookmarks.length, 0);
});

test('visit() writes history, coalesces the head url, and clearHistory wipes it', async () => {
  const { B } = await freshBrowser();
  assert.deepEqual(B.visit({ url: 'ftp://nope' }), { ok: false }); // non-http rejected
  assert.equal(B.visit({ url: 'https://stripe.com', title: 'Stripe' }).ok, true);
  assert.equal(B.visit({ url: 'https://vercel.com' }).ok, true);
  let h = B.history();
  assert.equal(h.length, 2);
  assert.equal(h[0].url, 'https://vercel.com'); // most-recent first

  // same head url updates the title in place, does not add a row
  B.visit({ url: 'https://vercel.com', title: 'Vercel' });
  h = B.history();
  assert.equal(h.length, 2);
  assert.equal(h[0].title, 'Vercel');

  assert.equal(B.history({ limit: 1 }).length, 1); // limit projection honored
  assert.deepEqual(B.clearHistory(), { ok: true });
  assert.deepEqual(B.history(), []);
});

test('read-per-call sees an out-of-band write (the stale-singleton fix)', async () => {
  const { B, file } = await freshBrowser();
  B.addBookmark({ url: 'https://a.example', title: 'A' });
  // simulate a second process / hand-edit writing the same file
  const outOfBand = { version: 1, history: [], bookmarks: [{ id: 'zzz', url: 'https://b.example', title: 'B', ts: 1 }] };
  fs.writeFileSync(file, JSON.stringify(outOfBand));
  // old cached singleton would still report 'A'; read-per-call reflects disk
  const marks = B.bookmarks();
  assert.equal(marks.length, 1);
  assert.equal(marks[0].url, 'https://b.example');
});

test('a corrupt store degrades to empty instead of throwing, and writes recover it', async () => {
  const { B, file } = await freshBrowser();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(B.history(), []);
  assert.deepEqual(B.bookmarks(), []);
  assert.equal(B.addBookmark({ url: 'https://ok.example' }).ok, true);
  assert.equal(B.bookmarks().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bookmarks.length, 1);
});
