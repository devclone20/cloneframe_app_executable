// Context test for bridge/matrix.mjs AFTER its migration of the matrix.json
// engine-config store onto the shared json-store port (read-per-call + atomic
// 0600). Proves the migration is behavior-preserving end-to-end against a REAL
// filesystem store, isolated to throwaway dirs via CLONE_FRAME_HUB_ROOT (the
// hub-root seam). Follows the Wave-3 template: set the env root, dynamic-import
// the module fresh, exercise its public RPC surface, assert on-disk shape.
//
// HOME is redirected to a throwaway dir BEFORE any bridge import so that
// permissions.mjs (an unmigrated real-home singleton that matrix.mjs consults
// for its 'matrix' gate) can be flipped on for the write path without ever
// writing to the developer's real ~/.clone-frame-hub/permissions.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERM_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-matrix-home-'));
process.env.HOME = PERM_HOME;

function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-matrix-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  return root;
}

// Cache-busting query so the module-level openStore({ root: hubRoot() }) rebinds
// to the current throwaway root on each import.
async function freshMatrix(root) {
  const mod = await import('../bridge/matrix.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { M: mod.Matrix, file: path.join(root, 'matrix.json') };
}

function makeExe(root, name) {
  const p = path.join(root, name);
  fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

test('no config: status reports the default engine path and never throws on a missing file', async () => {
  const root = freshRoot();
  const { M, file } = await freshMatrix(root);
  assert.equal(fs.existsSync(file), false); // pure read must not create the file
  const st = await M.status();
  assert.match(st.enginePath, /exo$/); // fell through to DEFAULT_BIN
  assert.equal(st.engineFound, false); // DEFAULT_BIN doesn't exist under our HOME
  assert.equal(st.api, 'http://127.0.0.1:52415');
});

test('setEnginePath round-trips through matrix.json: atomic write, 0600, version-stamped, read back', async () => {
  const root = freshRoot();
  const exe = makeExe(root, 'fake-engine');
  const { default: Permissions } = await import('../bridge/permissions.mjs');
  Permissions.set({ matrix: true });
  const { M, file } = await freshMatrix(root);

  const res = M.setEnginePath(exe);
  assert.equal(res.ok, true);

  // read-per-call: a fresh RPC sees the just-written value (via status, since
  // enginePath is internal). engineFound proves the path is a real executable.
  const st = await M.status();
  assert.equal(st.enginePath, exe);
  assert.equal(st.engineFound, true);

  // on-disk shape: free-form container + the port's version stamp, perms 0600
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.enginePath, exe);
  assert.equal(onDisk.version, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // update (CRUD): overwriting with a second executable replaces the value
  const exe2 = makeExe(root, 'fake-engine-2');
  assert.equal(M.setEnginePath(exe2).ok, true);
  assert.equal((await M.status()).enginePath, exe2);
});

test('read-per-call: an external edit to matrix.json is visible without re-import', async () => {
  const root = freshRoot();
  const exe = makeExe(root, 'engine-a');
  const { default: Permissions } = await import('../bridge/permissions.mjs');
  Permissions.set({ matrix: true });
  const { M, file } = await freshMatrix(root);

  assert.equal(M.setEnginePath(exe).ok, true);
  assert.equal((await M.status()).enginePath, exe);

  // Simulate a second process (or a hand edit) rewriting the store file. A
  // module-level cached singleton would keep serving `exe`; read-per-call must
  // reflect the new value on the very next call.
  const exeB = makeExe(root, 'engine-b');
  fs.writeFileSync(file, JSON.stringify({ enginePath: exeB, version: 1 }), { mode: 0o600 });
  assert.equal((await M.status()).enginePath, exeB);
});

test('setEnginePath rejects a non-executable path without writing the store', async () => {
  const root = freshRoot();
  const { default: Permissions } = await import('../bridge/permissions.mjs');
  Permissions.set({ matrix: true });
  const { M, file } = await freshMatrix(root);

  const notExe = path.join(root, 'not-executable.txt');
  fs.writeFileSync(notExe, 'plain', { mode: 0o644 });
  const res = M.setEnginePath(notExe);
  assert.equal(res.ok, false);
  assert.match(res.error, /not an executable file/);
  assert.equal(fs.existsSync(file), false); // validation happens before any save
});

test('a corrupt matrix.json degrades to the default engine path instead of throwing', async () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, 'matrix.json'), '{ this is not json', { mode: 0o600 });
  const { M } = await freshMatrix(root);
  const st = await M.status(); // must not throw on the corrupt read
  assert.match(st.enginePath, /exo$/);
});
