// Context test for the cookbook domain module AFTER its migration onto the
// shared json-store port (Wave-3). Proves the migration is behavior-preserving
// end-to-end against a REAL filesystem store, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam). Follows the reminders-context
// template: set the env root, dynamic-import the module fresh, exercise its
// public RPC surface, assert on-disk shape.
//
// run() calls the live LLM via ./llm.mjs, so it is NOT exercised here — the
// add/update/remove/list persistence surface is what this migration touches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshCookbook() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-cookbook-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/cookbook.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, CB: mod.Cookbook, file: path.join(root, 'cookbook.json') };
}

test('built-ins list without a store file; only user recipes persist', async () => {
  const { CB, file } = await freshCookbook();
  const builtins = CB.list();
  assert.ok(builtins.length >= 8); // curated built-ins ship in code
  assert.ok(builtins.every((r) => r.isBuiltin === true));
  assert.equal(fs.existsSync(file), false); // reads never create the file
});

test('add → list → get round-trips and persists to cookbook.json {version, recipes} + 0600', async () => {
  const { CB, file } = await freshCookbook();
  const res = CB.add({ name: 'My Greeting', category: 'custom', template: 'Hello {{who}}', tags: ['Hi', 'hi'] });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const got = CB.get(res.id);
  assert.equal(got.name, 'My Greeting');
  assert.equal(got.isBuiltin, false);
  assert.deepEqual(got.variables, ['who']); // extracted from the template
  assert.deepEqual(got.tags, ['hi']); // normTags dedupes + lowercases

  // user recipe is appended after the built-ins
  const all = CB.list();
  assert.ok(all.some((r) => r.id === res.id && r.isBuiltin === false));

  // persisted shape: {version, recipes:[...]} with ONLY the user recipe on disk
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.recipes.length, 1);
  assert.equal(onDisk.recipes[0].id, res.id);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('update / remove enforce their contracts and built-ins stay immutable', async () => {
  const { CB } = await freshCookbook();
  const { id } = CB.add({ name: 'Draft', template: 'x {{a}}' });

  assert.equal(CB.update(id, { name: 'Renamed', tags: ['b'] }).ok, true);
  assert.equal(CB.get(id).name, 'Renamed');
  assert.deepEqual(CB.get(id).tags, ['b']);

  // built-ins cannot be edited or removed
  const someBuiltin = CB.list().find((r) => r.isBuiltin);
  assert.equal(CB.update(someBuiltin.id, { name: 'nope' }).ok, false);
  assert.equal(CB.remove(someBuiltin.id).ok, false);

  assert.equal(CB.remove(id).ok, true);
  assert.equal(CB.get(id), null);
  assert.equal(CB.remove(id).ok, false); // gone
});

test('isSaneRecord filter + corrupt store both degrade to built-ins only', async () => {
  const { CB, file } = await freshCookbook();

  // hand-written store with one sane and one junk record — junk is filtered out
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    recipes: [
      { id: 'u1', name: 'Kept', category: 'custom', template: 'ok {{v}}', tags: [], system: '', isBuiltin: false, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' },
      { id: 'u2', name: 'Broken' }, // no template → dropped by isSaneRecord
    ],
  }, null, 2), { mode: 0o600 });
  const users = CB.list().filter((r) => !r.isBuiltin);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, 'u1');

  // now corrupt it entirely → only built-ins survive, no throw
  fs.writeFileSync(file, '{ not json at all');
  const afterCorrupt = CB.list();
  assert.ok(afterCorrupt.every((r) => r.isBuiltin === true));
});
