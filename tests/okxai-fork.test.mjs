// Context test for bridge/okxai.mjs after its consolidation onto
// platform/cli-gate.mjs (makeGatedCli). Exercises ONLY the offline surface
// against a throwaway CLONE_FRAME_HUB_ROOT and a fake `onchainos` that merely
// echoes its argv — the real binary holds live wallet sessions and MUST never
// be spawned here (it exists on the dev host at ~/.local/bin/onchainos), and
// no network/funds are ever touched.
//
// Focus: the SECURITY-CRITICAL fail-closed gate (auth never executes,
// financial/mutate stay gated, unknown is refused, argv caps), EXACT argv
// passthrough (no request-shape drift), audit-on-mutation, the needsAuth
// session sentinel, and the (deliberately un-migrated) local drafts store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-okxai-'));
const BIN = path.join(ROOT, 'fake-onchainos');
const AUDIT = path.join(ROOT, 'okxai-audit.jsonl');

// A fake onchainos: records every invocation's argv to FAKE_ONCHAINOS_LOG and
// echoes it back so the caller can assert byte-exact argv passthrough. Never
// touches a network or a wallet — it is a pure argv mirror.
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_ONCHAINOS_LOG) fs.appendFileSync(process.env.FAKE_ONCHAINOS_LOG, JSON.stringify(argv) + '\\n');
if (process.env.FAKE_ONCHAINOS_MODE === 'session') { process.stderr.write('session expired, please login'); process.exit(1); }
if (argv[0] === '--version') { process.stdout.write('onchainos 4.2.0'); process.exit(0); }
const key = argv.filter(a => !a.startsWith('-')).slice(0, 2).join(' ');
if (key === 'wallet status') { process.stdout.write(JSON.stringify({ data: { loggedIn: true, address: '0xABC' } })); process.exit(0); }
process.stdout.write(JSON.stringify({ ok: true, data: [{ id: 'a1' }], argv }));
`;
fs.writeFileSync(BIN, FAKE, { mode: 0o755 });
fs.chmodSync(BIN, 0o755);

process.env.CLONE_FRAME_HUB_ROOT = ROOT;
process.env.OKX_ONCHAINOS_BIN = BIN;
delete process.env.FAKE_ONCHAINOS_MODE;

const { OkxAi } = await import('../bridge/okxai.mjs?ctx=okxai-fork');

let logSeq = 0;
// Point the fake at a fresh log file, run `fn`, and return the argv-lines the
// fake actually saw (empty array = the binary was never spawned).
async function withSpawnLog(fn) {
  const log = path.join(ROOT, `spawns-${logSeq++}.jsonl`);
  process.env.FAKE_ONCHAINOS_LOG = log;
  const r = await fn();
  const spawns = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { r, spawns };
}

// ── fail-closed gate: the security core ───────────────────────────────────────
test('SECURITY — auth command returns needsTerminal and NEVER spawns the binary', async () => {
  const { r, spawns } = await withSpawnLog(() => OkxAi.run(['wallet', 'login']));
  assert.equal(r.ok, false);
  assert.equal(r.needsTerminal, true);
  assert.equal(r.class, 'auth');
  assert.equal(r.command, 'onchainos wallet login');
  assert.equal(spawns.length, 0);
});

test('SECURITY — auth cannot be forced to execute with approved/confirm', async () => {
  const { r, spawns } = await withSpawnLog(() => OkxAi.run(['wallet', 'login'], { approved: true, confirm: true }));
  assert.equal(r.needsTerminal, true);
  assert.equal(spawns.length, 0);
});

test('SECURITY — financial (wallet send) needs approval and does NOT spawn until approved', async () => {
  const { r, spawns } = await withSpawnLog(() => OkxAi.run(['wallet', 'send', '0xdead', '1']));
  assert.equal(r.ok, false);
  assert.equal(r.needsApproval, true);
  assert.equal(r.class, 'financial');
  assert.equal(r.command, 'wallet send');
  assert.equal(spawns.length, 0);
});

test('SECURITY — mutate needs confirm and does NOT spawn until confirmed', async () => {
  const { r, spawns } = await withSpawnLog(() => OkxAi.run(['agent', 'update', 'x']));
  assert.equal(r.needsConfirm, true);
  assert.equal(r.class, 'mutate');
  assert.equal(r.command, 'agent update');
  assert.equal(spawns.length, 0);
});

test('SECURITY — unknown command is refused (fail-closed), never spawned', async () => {
  const { r, spawns } = await withSpawnLog(() => OkxAi.run(['wallet', 'drain-everything']));
  assert.equal(r.ok, false);
  assert.match(r.error, /refused: unknown or unsupported/);
  assert.equal(spawns.length, 0);
});

test('SECURITY — over-long argv and NUL bytes are rejected before classification', async () => {
  const { r: r1, spawns: s1 } = await withSpawnLog(() => OkxAi.run(Array(50).fill('x')));
  assert.match(r1.error, /bad argv/);
  assert.equal(s1.length, 0);
  const { r: r2, spawns: s2 } = await withSpawnLog(() => OkxAi.run(['wallet', 'status\0evil']));
  assert.match(r2.error, /bad argv/);
  assert.equal(s2.length, 0);
});

// ── EXACT argv passthrough (no request-shape drift) ───────────────────────────
test('read runs, and argv reaches the binary byte-identical', async () => {
  const argv = ['agent', 'get-my-agents'];
  const { r, spawns } = await withSpawnLog(() => OkxAi.run(argv));
  assert.equal(r.ok, true);
  assert.equal(r.class, 'read');
  assert.deepEqual(r.json.argv, argv, 'binary received the exact argv it was given');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0], argv, 'no --json or any injected flag — argv unmodified');
});

// ── audit-on-mutation (financial/mutate audited, read not) ────────────────────
test('mutate+confirm and financial+approved run and are audited; read is not', async () => {
  fs.rmSync(AUDIT, { force: true });
  await OkxAi.run(['agent', 'update', 'x'], { confirm: true });
  await OkxAi.run(['wallet', 'send', '0xdead', '1'], { approved: true });
  await OkxAi.run(['agent', 'get-my-agents']); // read → must NOT audit

  const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, 'only the two mutating commands were audited');
  assert.equal(lines[0].class, 'mutate');
  assert.equal(lines[0].cmd, 'agent update x');
  assert.equal(lines[0].ok, true);
  assert.equal(lines[1].class, 'financial');
  assert.equal(lines[1].cmd, 'wallet send 0xdead 1');
  // audit file is owner-only
  assert.equal(fs.statSync(AUDIT).mode & 0o777, 0o600);
});

// ── needsAuth session sentinel (detectSentinel wiring) ────────────────────────
test('a dead-session non-zero exit surfaces needsAuth', async () => {
  process.env.FAKE_ONCHAINOS_MODE = 'session';
  try {
    const r = await OkxAi.run(['wallet', 'status']);
    assert.equal(r.ok, false);
    assert.equal(r.needsAuth, true);
    assert.equal(r.class, 'read');
  } finally {
    delete process.env.FAKE_ONCHAINOS_MODE;
  }
});

// ── status() posture (uses the port's read-only probe, never the raw exec) ────
test('status reports installed/authenticated/address from probe calls', async () => {
  const s = await OkxAi.status();
  assert.equal(s.ok, true);
  assert.equal(s.installed, true);
  assert.equal(s.bin, BIN);
  assert.equal(s.version, '4.2.0');
  assert.equal(s.authenticated, true);
  assert.equal(s.address, '0xABC');
});

test('agents() unwraps the data list from get-my-agents', async () => {
  const r = await OkxAi.agents();
  assert.equal(r.ok, true);
  assert.deepEqual(r.agents, [{ id: 'a1' }]);
});

// ── local drafts store (deliberately un-migrated: dynamic-key map) ────────────
test('local drafts CRUD round-trips on the throwaway root and stays a clean map', async () => {
  assert.deepEqual(OkxAi.localDrafts().drafts, []);

  const created = OkxAi.localDraft('atlas', { description: 'hi', services: ['x'] });
  assert.equal(created.ok, true);
  assert.equal(created.draft.name, 'atlas');
  assert.equal(created.draft.description, 'hi');
  assert.equal(typeof created.draft.createdAt, 'number');

  const got = OkxAi.localDraft('atlas');
  assert.equal(got.ok, true);
  assert.equal(got.draft.description, 'hi');

  // openStore was NOT adopted here: the on-disk top-level object must be the raw
  // draft map (no injected `version` key that Object.values would surface as a
  // phantom draft).
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'okxai-drafts.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk), ['atlas']);
  assert.equal('version' in onDisk, false);
  assert.equal(OkxAi.localDrafts().drafts.length, 1);

  const removed = OkxAi.localDraft('atlas', null);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 'atlas');
  assert.deepEqual(OkxAi.localDrafts().drafts, []);
});

test('local draft removal of a missing name fails cleanly', () => {
  const r = OkxAi.localDraft('nope', null);
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});
