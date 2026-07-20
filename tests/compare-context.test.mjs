// Context test for the compare domain module AFTER its migration onto the
// shared json-store port (Wave-3). Proves the migration is behavior-preserving
// end-to-end against a REAL filesystem store, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam). Follows the reminders-context
// template: set the env root, dynamic-import the module fresh, exercise its
// public RPC surface, assert on-disk shape.
//
// run() calls the live LLM via ./llm.mjs, so it is NOT exercised here — the
// history/get/remove persistence surface is driven directly through appendRun's
// on-disk shape, which is what this migration touches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshCompare() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-compare-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/compare.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, C: mod.Compare, file: path.join(root, 'compare.json') };
}

// Seed a run record directly on disk in the store's own shape, then read it back
// through the public API — the round-trip that appendRun()/loadStore() perform.
function seedRun(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, runs: [] };
  existing.runs.push(record);
  fs.writeFileSync(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
}

test('empty store: history/get/remove degrade cleanly on a missing file', async () => {
  const { C } = await freshCompare();
  assert.deepEqual(C.history(), []); // no throw on missing file
  assert.equal(C.get('nope'), null);
  assert.equal(C.remove('nope').ok, false);
});

test('history() returns newest-first summaries and persists file shape + 0600 perms', async () => {
  const { C, file } = await freshCompare();
  seedRun(file, { id: 'r1', prompt: 'first', system: null, models: ['a'], results: [{ model: 'a', text: 'x', ms: 1 }], createdAt: '2030-01-01T00:00:00Z' });
  seedRun(file, { id: 'r2', prompt: 'second', system: null, models: ['b', 'c'], results: [{ model: 'b', text: 'y', ms: 2 }], createdAt: '2030-01-02T00:00:00Z' });

  const h = C.history();
  assert.equal(h.length, 2);
  assert.equal(h[0].id, 'r2'); // newest first
  assert.deepEqual(h[0].models, ['b', 'c']);
  assert.equal(h[1].id, 'r1');
  // summary is a projection, not the full record
  assert.deepEqual(Object.keys(h[0]).sort(), ['createdAt', 'id', 'models', 'prompt']);

  // limit is honoured
  assert.equal(C.history({ limit: 1 }).length, 1);

  // persisted shape: {version, runs:[...]} and 0600 perms
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.runs.length, 2);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('get() returns the full record with secrets stripped; remove() deletes and re-stamps', async () => {
  const { C, file } = await freshCompare();
  seedRun(file, {
    id: 'r1', prompt: 'p', system: 'sys', models: ['a'],
    results: [{ model: 'a', text: 'out', ms: 5, apiKey: 'sk-should-be-gone' }],
    createdAt: '2030-01-01T00:00:00Z',
  });

  const full = C.get('r1');
  assert.equal(full.prompt, 'p');
  assert.equal(full.system, 'sys');
  assert.equal(full.results[0].text, 'out');
  assert.equal('apiKey' in full.results[0], false); // stripSecrets applied

  const rm = C.remove('r1');
  assert.equal(rm.ok, true);
  assert.equal(C.get('r1'), null);

  // write after remove keeps the versioned container shape + 0600 perms
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.runs, []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { C, file } = await freshCompare();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(C.history(), []);
  assert.equal(C.get('anything'), null);
});
