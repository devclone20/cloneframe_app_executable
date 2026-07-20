// Context test for the admin domain module AFTER its admin.json store was
// migrated onto the shared json-store port (Wave-3). Proves the swap is
// behavior-preserving end-to-end against a REAL filesystem, isolated to a
// throwaway dir via CLONE_FRAME_HUB_ROOT (the hub-root seam). Exercises ONLY the
// admin.json-store-touching surface (tools/setToolEnabled/addTool/removeTool/
// users/setProfile) — NOT the scrub/env/log surface, which was left untouched.
//
// admin.json holds NO secret fields (the tool registry is capability metadata:
// name/kind/scopes/flags; the profile is name/role). The projection assertions
// below therefore guard against a *stray field* leaking into the public view or
// onto disk, the same shape oauth's secret-projection test enforces.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOL_VIEW_KEYS = ['id', 'name', 'kind', 'enabled', 'scopes', 'isBuiltin', 'description', 'createdAt', 'updatedAt'];
const PROFILE_VIEW_KEYS = ['id', 'name', 'role', 'updatedAt'];
const BUILTIN_NAMES = ['email.send', 'shell.run', 'web.fetch'];

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshAdmin() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-admin-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/admin.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, A: mod.Admin, file: path.join(root, 'admin.json') };
}

test('a pure read (tools/users) self-heals built-ins in memory and never writes admin.json', async () => {
  const { A, file } = await freshAdmin();
  const list = A.tools();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((t) => t.name).sort(), [...BUILTIN_NAMES].sort());
  for (const t of list) {
    assert.equal(t.isBuiltin, true);
    assert.equal(t.enabled, false); // seeded DISABLED, opt-in only
    assert.deepEqual(Object.keys(t).sort(), [...TOOL_VIEW_KEYS].sort());
  }
  const roster = A.users();
  assert.equal(roster.length, 1);
  assert.equal(roster[0].id, 'local');
  assert.equal(roster[0].role, 'owner');
  assert.equal(roster[0].updatedAt, null);
  assert.deepEqual(Object.keys(roster[0]).sort(), [...PROFILE_VIEW_KEYS].sort());
  // Read paths stay pure: no dir/file side-effect until a write happens.
  assert.equal(fs.existsSync(file), false);
});

test('setToolEnabled persists to admin.json at 0600 with the {version,tools,profile} shape', async () => {
  const { A, file } = await freshAdmin();
  const target = A.tools().find((t) => t.name === 'web.fetch');
  const res = A.setToolEnabled(target.id, true);
  assert.equal(res.ok, true);
  assert.equal(res.id, target.id);
  assert.equal(res.enabled, true);
  // reload reflects the flip
  assert.equal(A.tools().find((t) => t.id === target.id).enabled, true);

  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk), ['version', 'tools', 'profile']); // exact order + set
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.profile, null);
  const persisted = onDisk.tools.find((t) => t.name === 'web.fetch');
  assert.equal(persisted.enabled, true);
  // no stray key ever lands on disk beyond the whitelisted projection
  for (const t of onDisk.tools) assert.deepEqual(Object.keys(t).sort(), [...TOOL_VIEW_KEYS].sort());

  // unknown id / empty id are soft failures, never throw
  assert.equal(A.setToolEnabled('nope', true).ok, false);
  assert.equal(A.setToolEnabled('', true).ok, false);
});

test('addTool creates a DISABLED custom tool; reserved + duplicate names are rejected', async () => {
  const { A, file } = await freshAdmin();
  const add = A.addTool({ name: 'My Deploy!', kind: 'ops', scopes: ['ops:deploy', 'ops:deploy'], description: 'x' });
  assert.equal(add.ok, true);
  assert.match(add.id, /^tool_[0-9a-f-]{36}$/);

  const created = A.tools().find((t) => t.id === add.id);
  assert.equal(created.name, 'mydeploy'); // slug-sanitized
  assert.equal(created.enabled, false);   // never live until explicitly enabled
  assert.equal(created.isBuiltin, false);
  assert.deepEqual(created.scopes, ['ops:deploy']); // de-duped

  assert.equal(A.addTool({ name: 'email.send' }).ok, false); // reserved by a built-in
  assert.equal(A.addTool({ name: 'My Deploy' }).ok, false);  // duplicate (same slug)
  assert.equal(A.addTool({ name: '  ' }).ok, false);         // empty after sanitize

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.tools.filter((t) => t.name === 'mydeploy').length, 1);
});

test('removeTool deletes custom tools and protects built-ins', async () => {
  const { A } = await freshAdmin();
  const { id } = A.addTool({ name: 'scratch' });
  assert.equal(A.removeTool(id).ok, true);
  assert.equal(A.tools().some((t) => t.id === id), false);
  assert.equal(A.removeTool(id).ok, false); // already gone

  const builtin = A.tools().find((t) => t.isBuiltin);
  const guard = A.removeTool(builtin.id);
  assert.equal(guard.ok, false);
  assert.match(guard.error, /built-in/);
  assert.equal(A.tools().some((t) => t.id === builtin.id), true); // still there
});

test('setProfile round-trips and persists only the whitelisted profile fields', async () => {
  const { A, file } = await freshAdmin();
  const bad = A.setProfile({ name: '   ' });
  assert.equal(bad.ok, false);

  const res = A.setProfile({ name: '  Ada Lovelace  ', role: '  architect  ' });
  assert.equal(res.ok, true);
  assert.equal(res.user.name, 'Ada Lovelace'); // trimmed
  assert.equal(res.user.role, 'architect');
  assert.deepEqual(Object.keys(res.user).sort(), [...PROFILE_VIEW_KEYS].sort());

  const roster = A.users();
  assert.equal(roster[0].name, 'Ada Lovelace');
  assert.equal(roster[0].role, 'architect');
  assert.ok(roster[0].updatedAt);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.profile).sort(), ['id', 'name', 'role', 'createdAt', 'updatedAt'].sort());
  assert.equal(onDisk.profile.name, 'Ada Lovelace');
  assert.equal(onDisk.profile.id, 'local');

  // role defaults to the previous value when omitted on a later update
  A.setProfile({ name: 'Ada' });
  assert.equal(A.users()[0].role, 'architect');
});

test('a corrupt/hand-edited store degrades to defaults instead of throwing, and a write recovers it', async () => {
  const { A, file } = await freshAdmin();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not valid json');

  // reads degrade: built-ins re-appear, profile falls back to the synthesized local user
  assert.equal(A.tools().length, 3);
  assert.equal(A.users()[0].role, 'owner');

  // a subsequent write heals the file back to a valid store
  const { id } = A.addTool({ name: 'recovered' });
  assert.equal(A.tools().some((t) => t.id === id), true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.tools.some((t) => t.name === 'recovered'), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
