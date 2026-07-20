// Contract + SECURITY regression tests for the cli-gate port (T-022).
// Proves the fail-closed invariant AND that the two holes Opus found in the draft are
// closed: (1) reclassify() can never downgrade an 'auth' command; (2) an unknown reclassify
// return can never produce an ungated class; (3) no public exec() primitive is exposed.
// Uses an inline execFile spy so "0 executions" is asserted precisely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { makeGatedCli } from '../bridge/platform/cli-gate.mjs';

const CMAP = { 'wallet login': 'auth', 'balance': 'read', 'send': 'financial', 'set name': 'mutate' };

function gate({ classMap = CMAP, reclassify } = {}) {
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => { calls.push({ file, args }); cb(null, '{"ok":true}', ''); };
  const auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cligate-')), 'audit.jsonl');
  const g = makeGatedCli({ resolveBin: () => '/fake/cli', classMap, reclassify, auditFile, execFileImpl, binName: 'cli' });
  return { g, calls };
}

// ── the fail-closed invariant ─────────────────────────────────────────────────
test('auth command returns needsTerminal and NEVER calls execFile', async () => {
  const { g, calls } = gate();
  const r = await g.run(['wallet', 'login']);
  assert.equal(r.needsTerminal, true);
  assert.equal(r.class, 'auth');
  assert.equal(calls.length, 0);
});

test('auth cannot be executed even with opts.approved/opts.confirm', async () => {
  const { g, calls } = gate();
  await g.run(['wallet', 'login'], { approved: true, confirm: true });
  assert.equal(calls.length, 0);
});

// ── HOLE 1 (Opus): reclassify must not downgrade auth ─────────────────────────
test('SECURITY — reclassify CANNOT downgrade auth (a malicious "make everything read" still refuses)', async () => {
  const { g, calls } = gate({ reclassify: () => 'read' });
  const r = await g.run(['wallet', 'login']);
  assert.equal(r.needsTerminal, true, 'auth must stay auth');
  assert.equal(calls.length, 0, 'auth must never reach execFile');
});

// ── HOLE 2 (Opus): unknown reclassify return must be coerced, never ungated ───
test('SECURITY — reclassify returning an unrecognized class is coerced back (financial stays gated)', async () => {
  const { g, calls } = gate({ reclassify: () => 'quote' }); // 'quote' ∉ {read,mutate,financial}
  const r = await g.run(['send', '1', 'eth']);
  assert.equal(r.needsApproval, true, 'must coerce back to the matched financial class');
  assert.equal(r.class, 'financial');
  assert.equal(calls.length, 0, 'an unknown class must never execute ungated');
});

test('reclassify CAN legitimately downgrade financial→read among executable classes (dry-run runs)', async () => {
  const { g, calls } = gate({ reclassify: (k, cls, argv) => (argv.includes('--dry-run') ? 'read' : undefined) });
  const r = await g.run(['send', '--dry-run']);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
});

// ── HOLE 3 (Opus): no ungated exec() on the public surface ────────────────────
test('SECURITY — the gate exposes no ungated exec() primitive', () => {
  const { g } = gate();
  assert.equal(typeof g.exec, 'undefined');
  assert.deepEqual(Object.keys(g).sort(), ['audit', 'bin', 'classify', 'probe', 'run']);
});

test('probe runs read/unknown but REFUSES auth/mutate/financial', async () => {
  const { g, calls } = gate();
  assert.equal((await g.probe(['--version'])).ok, true);        // unknown flag → probeable
  assert.equal((await g.probe(['balance'])).ok, true);          // read → probeable
  assert.match((await g.probe(['wallet', 'login'])).error, /not probeable/); // auth → refused
  assert.match((await g.probe(['set', 'name', 'x'])).error, /not probeable/); // mutate → refused
  assert.match((await g.probe(['send', '1'])).error, /not probeable/);        // financial → refused
  assert.equal(calls.length, 2); // only the two safe probes reached exec
});

// ── the rest of the four-class gate ───────────────────────────────────────────
test('four-class gate — read runs, mutate needs confirm, financial needs approval, unknown refused', async () => {
  const { g } = gate();
  assert.equal((await g.run(['balance'])).ok, true);
  assert.equal((await g.run(['set', 'name', 'x'])).needsConfirm, true);
  assert.equal((await g.run(['set', 'name', 'x'], { confirm: true })).ok, true);
  assert.equal((await g.run(['send', '1'])).needsApproval, true);
  assert.equal((await g.run(['send', '1'], { approved: true })).ok, true);
  assert.match((await g.run(['bogus', 'cmd'])).error, /refused/);
});

test('argv caps — over-long argv and NUL bytes are rejected before classification', async () => {
  const { g, calls } = gate();
  assert.match((await g.run(Array(50).fill('x'))).error, /bad argv/);
  assert.match((await g.run(['balance', 'a\0b'])).error, /bad argv/);
  assert.equal(calls.length, 0);
});
