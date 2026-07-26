// The owner's own app_rpc allowlist (bridge/rpcallow.mjs).
//
// CLONE FRAME ships pi in YOLO and this module does NOT change that: the first test
// below is the one that matters most — out of the box, with no configuration, nothing
// is refused. Everything after it only happens because a user chose it in Settings.
//
// Scope, stated so no test here is mistaken for a security boundary: enforcement keys
// off a header the agent sets on its own calls. It constrains what the agent reaches
// for; it does not contain a caller that already holds the pairing token. See the
// module header.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function freshPolicy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-rpcallow-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/rpcallow.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, A: mod.RpcAllow };
}

test('ships WIDE OPEN — an unconfigured install refuses nothing (YOLO is the default)', async () => {
  const { A } = await freshPolicy();
  assert.deepEqual(A.get(), { ok: true, mode: 'open', allow: [], deny: [] });
  for (const [m, f] of [['web', 'search'], ['files', 'read'], ['servers', 'run'], ['pty', 'spawn']]) {
    assert.deepEqual(A.check(m, f), { allowed: true }, `${m}.${f} must be allowed by default`);
  }
});

test('open mode — a deny entry blocks exactly what it names, and nothing else', async () => {
  const { A } = await freshPolicy();
  A.set({ deny: ['servers.run'] });
  assert.equal(A.check('servers', 'run').allowed, false);
  assert.equal(A.check('servers', 'list').allowed, true, 'a sibling function stays allowed');
  assert.equal(A.check('web', 'search').allowed, true, 'other modules are untouched');
});

test('open mode — a bare module name in deny blocks every function on it', async () => {
  const { A } = await freshPolicy();
  A.set({ deny: ['servers'] });
  assert.equal(A.check('servers', 'run').allowed, false);
  assert.equal(A.check('servers', 'list').allowed, false);
  assert.equal(A.check('notes', 'list').allowed, true);
});

test('allowlist mode — nothing is allowed except what the owner named', async () => {
  const { A } = await freshPolicy();
  A.set({ mode: 'allowlist', allow: ['notes', 'web.search'] });
  assert.equal(A.check('notes', 'list').allowed, true, 'bare module covers all its functions');
  assert.equal(A.check('notes', 'add').allowed, true);
  assert.equal(A.check('web', 'search').allowed, true, 'module.fn covers exactly that function');
  assert.equal(A.check('web', 'fetchUrl').allowed, false, 'a sibling function is NOT implied');
  assert.equal(A.check('servers', 'run').allowed, false);
});

test('the refusal says which module.fn and where to change it', async () => {
  const { A } = await freshPolicy();
  A.set({ deny: ['pty.spawn'] });
  const r = A.check('pty', 'spawn');
  assert.equal(r.allowed, false);
  assert.match(r.reason, /pty\.spawn/);
  assert.match(r.reason, /Settings/, 'a refusal the owner cannot act on is a dead end');
});

test('entries are normalised: case, whitespace, duplicates and junk', async () => {
  const { A } = await freshPolicy();
  const r = A.set({ deny: ['  Servers.RUN  ', 'servers.run', 'not a module!', '../../etc/passwd', ''] });
  assert.deepEqual(r.deny, ['servers.run'], 'lowercased, trimmed, de-duplicated, junk dropped');
  assert.equal(A.check('SERVERS', 'Run').allowed, false, 'matching is case-insensitive too');
});

test('mode only accepts the two real values; a bogus one leaves it unchanged', async () => {
  const { A } = await freshPolicy();
  A.set({ mode: 'allowlist', allow: ['notes'] });
  A.set({ mode: 'anything-goes' });
  assert.equal(A.get().mode, 'allowlist', 'an unrecognised mode must never silently open the gate');
});

test('reset returns to the shipped default', async () => {
  const { A } = await freshPolicy();
  A.set({ mode: 'allowlist', allow: ['notes'], deny: ['web'] });
  assert.deepEqual(A.reset(), { ok: true, mode: 'open', allow: [], deny: [] });
  assert.equal(A.check('servers', 'run').allowed, true);
});

test('the policy survives a reload — it is the owner\'s config, not session state', async () => {
  const { root, A } = await freshPolicy();
  A.set({ mode: 'allowlist', allow: ['notes'] });
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const again = (await import('../bridge/rpcallow.mjs?ctx=' + Math.random().toString(36).slice(2))).RpcAllow;
  assert.equal(again.get().mode, 'allowlist');
  assert.equal(again.check('servers', 'run').allowed, false);
});
