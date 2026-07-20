// Context test for bridge/acp.mjs AFTER its migration onto the shared
// platform/cli-gate.mjs port. Proves the consolidation is behavior-preserving
// for RPC clients and that every acp-specific guard survived — WITHOUT a real
// `acp` binary and WITHOUT touching the network.
//
// Two offline surfaces:
//   1. The REAL Acp.run(): its fail-closed gating decisions (auth / financial /
//      mutate / unknown / bad-argv) all return BEFORE execFile, so they run on
//      any machine, installed or not, and never spawn a process.
//   2. The REAL cliGateConfig wired to the in-memory fakeCli: proves the exec
//      path — the `--json` argv prefix, the `trade --dry-run` reclassify, the
//      needsSetup sentinel, the audit write, and auth-never-executes — with zero
//      real I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeGatedCli } from '../bridge/platform/cli-gate.mjs';
import { makeFakeGatedCli } from '../bridge/platform/fakeCli.mjs';

// Fresh tmp hub root + a fresh module instance so acp's module-level
// `hubPath('acp-audit.jsonl')` binds to a throwaway dir, never the dev's real
// ~/.clone-frame-hub. (None of the run() gating paths below actually write, but
// this keeps the whole test hermetic by construction.)
async function freshAcp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-acp-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/acp.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, Acp: mod.Acp, cliGateConfig: mod.cliGateConfig };
}

// A fake gate carrying acp's REAL config, so we exercise the actual policy
// (classMap, reclassify, buildExecArgv, detectSentinel) through the real port —
// only resolveBin/execFileImpl are faked. auditFile is redirected to tmp.
function fakeGate(cliGateConfig, { responses = {} } = {}) {
  const auditFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-acp-audit-')), 'acp-audit.jsonl');
  const g = makeFakeGatedCli(makeGatedCli, { ...cliGateConfig, auditFile }, { responses });
  return { g, auditFile };
}

// ── 1. REAL Acp.run — fail-closed gating, no binary, no network ───────────────
test('auth commands NEVER run from the app — needsTerminal sentinel, exact command string', async () => {
  const { Acp } = await freshAcp();
  const r = await Acp.run(['configure', 'start']);
  assert.equal(r.ok, false);
  assert.equal(r.needsTerminal, true);
  assert.equal(r.class, 'auth');
  assert.equal(r.command, 'acp configure start'); // binName 'acp' prefix preserved
  assert.match(r.error, /YOUR terminal/);
});

test('auth cannot be forced even with approved+confirm (fail-closed invariant)', async () => {
  const { Acp } = await freshAcp();
  const r = await Acp.run(['wallet', 'sign-message', '0xdead'], { approved: true, confirm: true });
  assert.equal(r.needsTerminal, true);
  assert.equal(r.class, 'auth');
});

test('financial without approval → needsApproval (funds never move unattended)', async () => {
  const { Acp } = await freshAcp();
  const r = await Acp.run(['trade', 'buy', '--amount', '1']);
  assert.deepEqual(
    { ok: r.ok, needsApproval: r.needsApproval, class: r.class, command: r.command },
    { ok: false, needsApproval: true, class: 'financial', command: 'trade' },
  );
});

test('mutate without confirm → needsConfirm; unknown → refused; bad argv rejected', async () => {
  const { Acp } = await freshAcp();
  const m = await Acp.run(['agent', 'create', 'ada']);
  assert.equal(m.needsConfirm, true);
  assert.equal(m.class, 'mutate');
  assert.equal(m.command, 'agent create');

  const u = await Acp.run(['job', 'watch']); // intentionally unclassified (streams forever)
  assert.match(u.error, /refused/);

  assert.match((await Acp.run([])).error, /bad argv/);
  assert.match((await Acp.run(['browse', 'a\0b'])).error, /bad argv/);
  assert.match((await Acp.run(Array(50).fill('x'))).error, /bad argv/);
});

// NOTE: Acp.status()/chains() are deliberately NOT exercised against the real
// module here — on a machine with `acp` installed AND configured they can spawn
// the CLI and reach the network (agent whoami / chain list). Their internal
// routing is proven offline by the "probe routing" test below, which asserts the
// exact argv they hand the gate resolves to safe read/version probes.

// ── 2. REAL cliGateConfig on the in-memory fakeCli — exec path & sentinels ────
test('read runs and gets the --json prefix (buildExecArgv preserved)', async () => {
  const { cliGateConfig } = await freshAcp();
  const { g } = fakeGate(cliGateConfig);
  const r = await g.run(['agent', 'list']);
  assert.equal(r.ok, true);
  assert.equal(r.class, 'read');
  assert.deepEqual(g.calls.at(-1).args, ['--json', 'agent', 'list']);
});

test('opts.json === false suppresses the --json prefix (exact argv)', async () => {
  const { cliGateConfig } = await freshAcp();
  const { g } = fakeGate(cliGateConfig);
  await g.run(['agent', 'list'], { json: false });
  assert.deepEqual(g.calls.at(-1).args, ['agent', 'list']);
});

test('trade --dry-run reclassifies financial→read and executes (quote, not a trade)', async () => {
  const { cliGateConfig } = await freshAcp();
  const { g } = fakeGate(cliGateConfig);
  const r = await g.run(['trade', 'buy', '--dry-run']);
  assert.equal(r.ok, true);
  assert.equal(r.class, 'read'); // downgraded — no approval needed
  assert.deepEqual(g.calls.at(-1).args, ['--json', 'trade', 'buy', '--dry-run']);
});

test('needsSetup sentinel surfaces on an unauthenticated non-zero exit', async () => {
  const { cliGateConfig } = await freshAcp();
  const { g } = fakeGate(cliGateConfig, {
    responses: { 'agent list': { stderr: 'error: not authenticated', code: 1 } },
  });
  const r = await g.run(['agent', 'list']);
  assert.equal(r.ok, false);
  assert.equal(r.needsSetup, true);
});

test('financial WITH approval executes (--json), and the run is audited', async () => {
  const { cliGateConfig } = await freshAcp();
  const { g, auditFile } = fakeGate(cliGateConfig, {
    responses: { 'trade buy': { stdout: '{"filled":true}', code: 0 } },
  });
  const r = await g.run(['trade', 'buy'], { approved: true });
  assert.equal(r.ok, true);
  assert.equal(r.class, 'financial');
  assert.deepEqual(g.calls.at(-1).args, ['--json', 'trade', 'buy']);
  const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(audit.at(-1).class, 'financial');
  assert.equal(audit.at(-1).cmd, 'trade buy'); // audits the caller argv, not the --json exec argv
});

test('auth NEVER reaches execFile even through the gate primitive', async () => {
  const { cliGateConfig } = await freshAcp();
  const { g } = fakeGate(cliGateConfig);
  await g.run(['configure'], { approved: true, confirm: true });
  assert.equal(g.calls.length, 0);
});

test('probe routing matches status()/chains(): read+bare-flag run, auth/mutate/financial refused', async () => {
  const { cliGateConfig } = await freshAcp();
  const { g } = fakeGate(cliGateConfig);
  assert.equal((await g.probe(['--version'])).ok, true);            // status()'s version probe
  assert.equal((await g.probe(['--json', 'agent', 'whoami'])).ok, true); // status()'s whoami probe
  assert.equal((await g.probe(['--json', 'chain', 'list'])).ok, true);   // chains()'s probe
  assert.match((await g.probe(['configure'])).error, /not probeable/);
  assert.match((await g.probe(['trade', 'buy'])).error, /not probeable/);
});
