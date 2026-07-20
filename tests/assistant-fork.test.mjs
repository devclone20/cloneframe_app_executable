// Context test for the Personal Assistant module (bridge/assistant.mjs).
//
// This module was reviewed for the cli-gate consolidation (the "launch the Pi
// coding agent / assistant binary" execFile path). It was LEFT on local code —
// see the report — because assistant.mjs has NO gated execution surface: it
// never spawns the agent (launching is delegated to a user-run bash launcher in
// bin/<name>), and its only child_process call is a SYNCHRONOUS `command -v pi`
// PATH-existence probe inside the synchronous RPC fn status(). Routing that
// through makeGatedCli (async, four-class classification of the target binary)
// would break the sync RPC shape and gate a shell builtin, not a classified
// command — i.e. force the port. So there is nothing to migrate here.
//
// What this test DOES: pin the behavior-preserving OFFLINE RPC surface against a
// throwaway home root, proving the module is testable in isolation and that its
// exported fn names + return shapes are the byte-identical contract RPC clients
// depend on. assistant.mjs binds its paths from os.homedir() at load, and Node's
// os.homedir() honours $HOME on POSIX, so we point HOME at a fresh tmp dir and
// dynamic-import fresh (cache-busting query). No network, no real pi binary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function freshAssistant() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-assistant-'));
  process.env.HOME = home;
  const mod = await import('../bridge/assistant.mjs?ctx=' + Math.random().toString(36).slice(2));
  const dir = path.join(home, '.clone-frame-hub');
  return {
    home,
    A: mod.Assistant,
    cfg: path.join(dir, 'assistant.json'),
    soul: path.join(dir, 'assistant-soul.md'),
    bin: path.join(dir, 'bin'),
  };
}

test('exports the exact RPC surface (name contract)', async () => {
  const { A } = await freshAssistant();
  assert.deepEqual(Object.keys(A).sort(), ['getConfig', 'getSoul', 'install', 'saveConfig', 'saveSoul', 'status', 'uninstall']);
});

test('getConfig defaults on a fresh root; saveConfig round-trips to assistant.json', async () => {
  const { A, cfg } = await freshAssistant();
  assert.deepEqual(A.getConfig(), { name: 'iCLONE', repoPath: '', linked: null });
  const r = A.saveConfig({ name: 'Nova' });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Nova');
  assert.equal(A.getConfig().name, 'Nova');
  // read-per-call: the on-disk store is the source of truth, not a module cache
  const onDisk = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(onDisk.name, 'Nova');
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
});

test('saveConfig rejects a non-existent repoPath (validation preserved)', async () => {
  const { A } = await freshAssistant();
  const r = A.saveConfig({ repoPath: '/no/such/folder/anywhere' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a folder:/);
});

test('saveConfig links only when a tokenId is present, else null', async () => {
  const { A } = await freshAssistant();
  assert.deepEqual(A.saveConfig({ linked: { contract: '0xabc', tokenId: '7', name: 'X' } }).linked,
    { contract: '0xabc', tokenId: '7', name: 'X' });
  assert.equal(A.saveConfig({ linked: { contract: '0xabc' } }).linked, null);
});

test('getSoul returns the iCLONE default, saveSoul customises, empty resets', async () => {
  const { A, soul } = await freshAssistant();
  const def = A.getSoul();
  assert.equal(def.custom, false);
  assert.match(def.soul, /You are an iCLONE/);
  assert.equal(A.saveSoul('be terse').custom, true);
  assert.equal(A.getSoul().soul, 'be terse');
  assert.equal(fs.statSync(soul).mode & 0o777, 0o600);
  assert.equal(A.saveSoul('').custom, false);
  assert.equal(A.getSoul().custom, false);
  assert.throws(() => fs.statSync(soul)); // reset unlinks the file
});

test('saveSoul refuses an oversized soul', async () => {
  const { A } = await freshAssistant();
  const r = A.saveSoul('x'.repeat(64 * 1024 + 1));
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/);
});

test('install writes the name launcher + iclone alias and persists config', async () => {
  const { A, home, bin } = await freshAssistant();
  const r = A.install({ name: 'Nova', repoPath: home }); // home is a real dir → valid repo
  assert.equal(r.ok, true);
  assert.equal(r.command, 'nova');
  assert.deepEqual(r.aliases, ['iclone']);
  const body = fs.readFileSync(path.join(bin, 'nova'), 'utf8');
  assert.match(body, /^#!\/usr\/bin\/env bash/);
  assert.match(body, /exec pi -a/);           // argv construction preserved
  assert.ok(body.includes(JSON.stringify(home))); // AGENT_REPO wired
  assert.equal(fs.statSync(path.join(bin, 'nova')).mode & 0o777, 0o755);
  assert.ok(fs.statSync(path.join(bin, 'iclone')).isFile());
  assert.equal(A.getConfig().name, 'Nova');
});

test('uninstall removes the launcher(s) but leaves config + soul', async () => {
  const { A, bin, cfg } = await freshAssistant();
  A.install({ name: 'Nova' });
  assert.equal(A.uninstall({ name: 'Nova' }).ok, true);
  assert.throws(() => fs.statSync(path.join(bin, 'nova')));
  assert.throws(() => fs.statSync(path.join(bin, 'iclone')));
  assert.ok(fs.statSync(cfg).isFile()); // config survives
});

test('status reports a stable shape; piInstalled is a boolean either way', async () => {
  const { A } = await freshAssistant();
  const s = A.status();
  assert.deepEqual(Object.keys(s).sort(),
    ['command', 'hasCustomSoul', 'launcherInstalled', 'linked', 'name', 'piInstalled', 'repoPath']);
  assert.equal(typeof s.piInstalled, 'boolean');
  assert.equal(s.name, 'iCLONE');
  assert.equal(s.command, 'iclone');
  assert.equal(s.launcherInstalled, false);
  assert.equal(s.hasCustomSoul, false);
  A.install({ name: 'Nova' });
  A.saveSoul('hi');
  const s2 = A.status();
  assert.equal(s2.command, 'nova');
  assert.equal(s2.launcherInstalled, true);
  assert.equal(s2.hasCustomSoul, true);
});
