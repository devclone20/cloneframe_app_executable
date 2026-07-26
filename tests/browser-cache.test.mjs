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

test('empty store: bookmarks read clean with no file present', async () => {
  const { B, file } = await freshBrowser();
  assert.deepEqual(B.bookmarks(), []);
  assert.equal(fs.existsSync(file), false); // pure reads never create the file
});

// The browser keeps NO history (owner's order, 2026-07-25): there is no api to write
// or read one, and an install that has one on disk from an older version loses it the
// first time the module loads.
test('no history surface at all, and a legacy history array is dropped on load', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-browser-'));
  const file = path.join(root, 'browser.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    history: [{ id: 'aaaaaaaa', url: 'https://private.example', title: 'Private', ts: 1 }],
    bookmarks: [{ id: 'bbbbbbbb', url: 'https://keep.example', title: 'Keep', ts: 2 }],
  }));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/browser.mjs?ctx=' + Math.random().toString(36).slice(2));
  const B = mod.Browser;

  assert.equal(typeof B.history, 'undefined');
  assert.equal(typeof B.visit, 'undefined');
  assert.equal(typeof B.clearHistory, 'undefined');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.history, undefined);      // the past is erased too
  assert.equal(onDisk.bookmarks.length, 1);     // everything else survives untouched
  assert.deepEqual(B.bookmarks().map((b) => b.url), ['https://keep.example']);
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
  // atomic 0600 file perms (the gain over the old hand-rolled writer)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // remove is persisted too
  assert.equal(B.removeBookmark(marks[0].id).ok, true);
  assert.deepEqual(B.bookmarks(), []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bookmarks.length, 0);
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
  assert.deepEqual(B.bookmarks(), []);
  assert.equal(B.addBookmark({ url: 'https://ok.example' }).ok, true);
  assert.equal(B.bookmarks().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bookmarks.length, 1);
});
