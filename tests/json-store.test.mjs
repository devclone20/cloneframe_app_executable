// ─────────────────────────────────────────────────────────────────────────────
// T-006 · Characterization tests — atomic 0600 json-store idiom
// Targets (READ, never modified):
//   /Users/you/Desktop/iFRAME/apps/clone-frame-hub/bridge/permissions.mjs
//   /Users/you/Desktop/iFRAME/apps/clone-frame-hub/bridge/notes.mjs
//
// Both modules share the SAME persistence idiom (this is exactly what Wave-2 is
// expected to extract into one shared "jsonStore" helper):
//   1. directory ~/.clone-frame-hub created with mode 0700 (mkdirSync recursive)
//   2. write to a *.pid.tmp / *.pid.ts.tmp sibling file with mode 0600
//   3. fs.renameSync(tmp, final) — atomic swap, no half-written file is ever
//      visible under the real name
//   4. a missing or corrupt store file degrades to an empty/default store —
//      load() NEVER throws
//
// Because both modules compute their on-disk paths from os.homedir() at
// MODULE-TOP-LEVEL (`path.join(homedir(), '.clone-frame-hub')`), we redirect
// HOME to a throwaway temp directory *before* each dynamic import and use a
// cache-busting query string so every test gets its own fresh module instance
// bound to its own fresh HOME. This never touches the real
// ~/.clone-frame-hub on the machine running these tests.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERMISSIONS_URL = new URL('../bridge/permissions.mjs', import.meta.url).href;
const NOTES_URL = new URL('../bridge/notes.mjs', import.meta.url).href;

let importCounter = 0;
/** Fresh module instance (bypasses Node's ESM module cache via a query string). */
function freshImport(url) {
  return import(`${url}?instance=${++importCounter}`);
}

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfh-jsonstore-'));
}

// IMPORTANT: this must `await fn()` (and therefore must itself be async) —
// `fn` returns a dynamic-import() promise, and module evaluation (including
// the top-level `homedir()` call that computes DIR/FILE) happens on a later
// microtask. A synchronous `return fn()` inside try/finally would restore
// process.env.HOME before that evaluation ever runs, silently falling
// through to the REAL machine's ~/.clone-frame-hub.
async function withHome(home, fn) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = prevHome;
  }
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

test('permissions.mjs — defaults, atomic write, 0700/0600 perms', async (t) => {
  const home = makeTmpHome();
  const storeDir = path.join(home, '.clone-frame-hub');
  const storeFile = path.join(storeDir, 'permissions.json');

  await t.test('no file on disk -> get() returns the documented all-false defaults', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    assert.deepEqual(Permissions.get(), {
      machineControl: false,
      fullAccess: false,
      rootMode: false,
      autoEmail: false,
      autoAutomations: false,
      fileWrite: false,
      webAccess: false,
      ssh: false,
      matrix: false,
    });
  });

  await t.test('set() persists to disk with dir 0700 / file 0600, and no .tmp leftover', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    const result = Permissions.set({ machineControl: true, rootMode: true, unknownKey: true });
    assert.equal(result.ok, true);
    // unknown keys are silently ignored — only DEFAULTS keys are ever copied in.
    assert.equal(result.perms.unknownKey, undefined);
    assert.equal(result.perms.machineControl, true);
    assert.equal(result.perms.rootMode, true);

    assert.ok(fs.existsSync(storeFile), 'permissions.json must exist after set()');
    assert.equal(modeOf(storeDir), 0o700, 'store dir must be 0700');
    assert.equal(modeOf(storeFile), 0o600, 'store file must be 0600');

    const leftovers = fs.readdirSync(storeDir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'atomic rename must leave no .tmp file behind');
  });

  await t.test('a fresh module instance (simulated restart) reads back what was persisted', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    const p = Permissions.get();
    assert.equal(p.machineControl, true);
    assert.equal(p.rootMode, true);
    assert.equal(p.fullAccess, false); // untouched keys stay at default
  });

  await t.test('set() coerces every value to boolean', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    const result = Permissions.set({ webAccess: 'yes', ssh: 0, matrix: 1 });
    assert.equal(result.perms.webAccess, true);
    assert.equal(result.perms.ssh, false);
    assert.equal(result.perms.matrix, true);
  });

  await t.test('set() rejects a non-object patch without throwing', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    assert.deepEqual(Permissions.set(null), { ok: false, error: 'bad patch' });
    assert.deepEqual(Permissions.set('nope'), { ok: false, error: 'bad patch' });
  });

  await t.test('a corrupt permissions.json degrades to defaults instead of throwing', async () => {
    fs.writeFileSync(storeFile, '{ this is not json', { mode: 0o600 });
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    assert.deepEqual(Permissions.get(), {
      machineControl: false, fullAccess: false, rootMode: false, autoEmail: false,
      autoAutomations: false, fileWrite: false, webAccess: false, ssh: false, matrix: false,
    });
  });

  await t.test('can() — the master switch (machineControl) unlocks everything EXCEPT email/ssh/matrix', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    Permissions.reset();
    Permissions.set({ machineControl: true });
    assert.equal(Permissions.can('shell'), true);
    assert.equal(Permissions.can('root'), true);
    assert.equal(Permissions.can('fileWrite'), true);
    assert.equal(Permissions.can('web'), true);
    assert.equal(Permissions.can('open'), true);
    // NOT unlocked by the master switch — each keeps its own independent gate.
    assert.equal(Permissions.can('email'), false);
    assert.equal(Permissions.can('ssh'), false);
    assert.equal(Permissions.can('matrix'), false);
    // (documented gap) the master-switch fast path checks only the action
    // NAME against the email/ssh/matrix exclusion list — it does not first
    // verify the action is even in `map`. So with machineControl on, ANY
    // unrecognized action string also passes, wide open. This is exactly
    // the kind of implicit contract a Wave-2 refactor could tighten (or
    // could accidentally invert) — pinned here so that's a deliberate change.
    assert.equal(Permissions.can('nonsense-action'), true);
  });

  await t.test('can() — with the master switch off, each action follows its own flag', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    Permissions.reset();
    assert.equal(Permissions.can('shell'), false);
    Permissions.set({ fullAccess: true });
    assert.equal(Permissions.can('shell'), true);
    assert.equal(Permissions.can('open'), true); // 'open' also maps to fullAccess
    assert.equal(Permissions.can('root'), false); // rootMode still off
    // with the master switch off, an unmapped action correctly denies —
    // the "any unrecognized action passes" gap above is specific to the
    // machineControl fast path, not a general property of can().
    assert.equal(Permissions.can('nonsense-action'), false);
  });

  await t.test('reset() restores every flag to false and persists it', async () => {
    const { Permissions } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    Permissions.set({ machineControl: true, ssh: true });
    const r = Permissions.reset();
    assert.equal(r.ok, true);
    assert.deepEqual(Permissions.get(), {
      machineControl: false, fullAccess: false, rootMode: false, autoEmail: false,
      autoAutomations: false, fileWrite: false, webAccess: false, ssh: false, matrix: false,
    });
    const { Permissions: reloaded } = await withHome(home, () => freshImport(PERMISSIONS_URL));
    assert.equal(reloaded.get().machineControl, false, 'reset() must persist, not just reset in-memory state');
  });

  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
});

test('notes.mjs — atomic write, 0700/0600 perms, corrupt-store resilience, CRUD round trip', async (t) => {
  const home = makeTmpHome();
  const storeDir = path.join(home, '.clone-frame-hub');
  const storeFile = path.join(storeDir, 'notes.json');

  await t.test('no file on disk -> list()/tags() return empty, never throw', async () => {
    const Notes = await withHome(home, () => freshImport(NOTES_URL));
    assert.deepEqual(Notes.list(), []);
    assert.deepEqual(Notes.tags(), []);
    assert.equal(Notes.get('does-not-exist'), null);
  });

  await t.test('create() persists atomically: dir 0700, file 0600, no .tmp leftover', async () => {
    const Notes = await withHome(home, () => freshImport(NOTES_URL));
    const created = Notes.create({ title: 'Hello', body: 'World', tags: ['a', 'A', ' b ', ''] });
    assert.equal(created.ok, true);
    assert.ok(created.id);

    assert.ok(fs.existsSync(storeFile));
    assert.equal(modeOf(storeDir), 0o700);
    assert.equal(modeOf(storeFile), 0o600);
    const leftovers = fs.readdirSync(storeDir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'atomic rename must leave no .tmp file behind');

    // tag normalization: case-insensitive dedupe keeps first-seen casing, drops empties.
    const note = Notes.get(created.id);
    assert.deepEqual(note.tags, ['a', 'b']);
    assert.equal(note.title, 'Hello');
    assert.equal(note.body, 'World');
  });

  await t.test('a fresh module instance (simulated restart) reads back the persisted note', async () => {
    const Notes = await withHome(home, () => freshImport(NOTES_URL));
    const [row] = Notes.list();
    assert.equal(row.title, 'Hello');
    assert.equal(row.snippet, 'World');
  });

  await t.test('update()/remove() round trip and report not-found without throwing', async () => {
    const Notes = await withHome(home, () => freshImport(NOTES_URL));
    const { id } = Notes.create({ title: 'T2', body: 'B2' });
    assert.deepEqual(Notes.update(id, { body: 'B2 updated' }), { ok: true });
    assert.equal(Notes.get(id).body, 'B2 updated');
    assert.deepEqual(Notes.update('missing-id', { body: 'x' }), { ok: false, error: 'update: note not found' });
    assert.deepEqual(Notes.remove(id), { ok: true });
    assert.deepEqual(Notes.remove(id), { ok: false, error: 'remove: note not found' });
  });

  await t.test('create() requires a non-empty title or body', async () => {
    const Notes = await withHome(home, () => freshImport(NOTES_URL));
    assert.deepEqual(Notes.create({ title: '  ', body: '' }), {
      ok: false, error: 'create: title or body is required',
    });
  });

  await t.test('a corrupt notes.json degrades to an empty store instead of throwing', async () => {
    fs.writeFileSync(storeFile, 'not json at all {{{', { mode: 0o600 });
    const Notes = await withHome(home, () => freshImport(NOTES_URL));
    assert.deepEqual(Notes.list(), []);
    // and it's still writable afterward — one bad read must not wedge the store.
    const created = Notes.create({ title: 'recovered', body: '' });
    assert.equal(created.ok, true);
  });

  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
});
