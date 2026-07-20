// Context test for the harness registry AFTER its migration off the module-level
// `let store = load()` cached singleton onto the shared json-store port
// (read-per-call + atomic 0600 writes). Proves the migration is behavior-
// preserving end-to-end against a REAL filesystem store, isolated to a throwaway
// dir via CLONE_FRAME_HUB_ROOT (the hub-root seam).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-harness-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/harness.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, H: mod.Harness, file: path.join(root, 'harness.json') };
}

test('fresh store seeds the builtin ENGINE and persists to harness.json', async () => {
  const { H, file } = await freshHarness();
  const list = H.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'harness-engine');
  assert.equal(list[0].isBuiltin, true);
  assert.equal(list[0].activeForTerminal, true);
  // import-time save() created the file with {version, harnesses:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.harnesses.length, 1);
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('add → get → list round-trips and persists', async () => {
  const { H, file } = await freshHarness();
  const bad = H.add({});
  assert.equal(bad.ok, false);
  const res = H.add({ name: 'Recon Crew', description: 'scouts', roles: [{ name: 'SCOUT', gate: false }, { name: 'GUARD', gate: true }] });
  assert.equal(res.ok, true);
  assert.match(res.id, /^h_/);
  const got = H.get(res.id);
  assert.equal(got.name, 'Recon Crew');
  assert.equal(got.isBuiltin, false);
  assert.deepEqual(got.gates, ['GUARD']); // derived from gated roles
  assert.equal(got.activeForTerminal, false);
  // re-read from a SECOND fresh module instance proves it hit disk, not a cache
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.harnesses.some(h => h.id === res.id), true);
  assert.equal(H.list().length, 2); // ENGINE + new
});

test('update edits custom crews and refuses to rewrite the builtin', async () => {
  const { H } = await freshHarness();
  const { id } = H.add({ name: 'Alpha' });
  assert.equal(H.update(id, { name: 'Alpha Prime' }).ok, true);
  assert.equal(H.get(id).name, 'Alpha Prime');
  // updating a custom crew's roles re-derives gates
  assert.equal(H.update(id, { roles: [{ name: 'A', gate: true }, { name: 'B', gate: false }] }).ok, true);
  assert.deepEqual(H.get(id).gates, ['A']);
  // builtin crew edits are rejected
  const rej = H.update('harness-engine', { name: 'hacked' });
  assert.equal(rej.ok, false);
  assert.equal(H.get('harness-engine').name, 'HARNESS ENGINE');
});

test('duplicate clones any crew (incl. builtin) into an editable custom one', async () => {
  const { H } = await freshHarness();
  const dup = H.duplicate('harness-engine', 'My Engine');
  assert.equal(dup.ok, true);
  const copy = H.get(dup.id);
  assert.equal(copy.isBuiltin, false);
  assert.equal(copy.name, 'My Engine');
  assert.equal(copy.kind, 'custom'); // spine → custom
  assert.equal(copy.activeForTerminal, false);
  assert.deepEqual(copy.roles.map(r => r.name), ['ORCHESTRATOR', 'SAFETY / HACKER', 'EVALUATOR', 'TREASURY', 'OWNER', 'RESEARCH', 'DELIVERY']);
  assert.equal(H.duplicate('nope').ok, false);
});

test('remove deletes custom crews and protects the builtin', async () => {
  const { H } = await freshHarness();
  const { id } = H.add({ name: 'Temp' });
  assert.equal(H.remove(id).ok, true);
  assert.equal(H.get(id), null);
  assert.equal(H.remove('harness-engine').ok, false); // protected
  assert.ok(H.get('harness-engine')); // still there
});

test('setActiveForTerminal makes exactly one crew active', async () => {
  const { H } = await freshHarness();
  const { id } = H.add({ name: 'Ops' });
  assert.equal(H.setActiveForTerminal(id).ok, true);
  assert.equal(H.activeForTerminal().id, id);
  // the builtin, previously active, is now inactive
  assert.equal(H.get('harness-engine').activeForTerminal, false);
  // switching back to the builtin re-arms it and deactivates the custom crew
  H.setActiveForTerminal('harness-engine');
  assert.equal(H.activeForTerminal().id, 'harness-engine');
  assert.equal(H.get(id).activeForTerminal, false);
  // on:false clears the active flag entirely
  assert.equal(H.setActiveForTerminal('harness-engine', false).ok, true);
  assert.equal(H.activeForTerminal(), null);
});

test('a corrupt store degrades to the seeded builtin instead of throwing', async () => {
  const { H, file } = await freshHarness();
  fs.writeFileSync(file, '{ this is not json');
  const list = H.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'harness-engine');
  // and a write still recovers the store
  assert.equal(H.add({ name: 'Recovered' }).ok, true);
  assert.equal(H.list().length, 2);
});
