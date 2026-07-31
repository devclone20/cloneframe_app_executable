// SETTINGS said this, in the owner's own copy, unqualified:
//
//   "An agent can only send from your account when Send email without asking is on in
//    Machine. With it off, everything it writes waits for you in APPROVAL."
//
// and agent/AGENTS.md told pi:
//
//   "With the `autoEmail` permission off, `email.send` refuses — so queue it."
//
// Neither was true. `Permissions.can('email')` had ZERO call sites in the entire bridge; the
// only autoEmail check in the codebase lived in web/panels/terminal.js's tool loop, which is
// the BYOK CODE path. pi does not go through it — it calls POST /mod/email {fn:'send'} itself
// through app_rpc. So a well-behaved agent, believing it would be refused, sent the mail
// instead of queueing it, with the owner's switch off, and the owner found out by reply.
//
// SETTINGS is right about the GENERAL rule and says so on screen — these toggles "shape what
// your agent reaches for … they are not a sandbox", and only ssh/MATRIX/root are enforced in
// the daemon. That design stands. Email is the exception because the app made a stronger
// promise about it, and because mail is irreversible and reaches other people.
//
// Three calls, not one: a gate the clock can walk around is not a gate, and an agent that can
// approve its own draft has not queued anything.
//
//   email.send           the direct path
//   scheduled.schedule   the same send, on a timer
//   approvals.approve    the agent must not approve the draft it wrote for the owner to read
//
// The owner's own interface never sends the x-cfhub-caller: agent header, so none of this
// touches the EMAIL panel's Send button or the APPROVAL panel's approve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

// A scratch hub root, so the gate can be exercised without reading — or writing — the
// developer's real permissions.json. permissions.mjs resolves through hubRoot() for exactly
// this reason, and its header records what it cost to learn.
const home = mkdtempSync(path.join(tmpdir(), 'cfhub-perm-'));
process.env.CLONE_FRAME_HUB_ROOT = home;
const { Permissions } = await import('../bridge/permissions.mjs');

test('every path that puts mail on the wire is gated for an agent caller', () => {
  for (const [mod, fn] of [['email', 'send'], ['scheduled', 'schedule'], ['approvals', 'approve']]) {
    assert.equal(Permissions.agentGateFor(mod, fn), 'email',
      `${mod}.${fn} sends mail on the owner's behalf and must need the owner's switch`);
  }
});

test('reading mail, listing it and QUEUEING it are not gated — the agent must still work', () => {
  // If drafting or queueing were refused too, the agent's only honest option would be to drop
  // the draft, which is the one failure the owner cannot recover from.
  for (const [mod, fn] of [['email', 'list'], ['email', 'message'], ['email', 'listAccounts'],
    ['approvals', 'add'], ['approvals', 'list'], ['scheduled', 'list'], ['scheduled', 'cancel'],
    ['notes', 'create'], ['brain', 'add']]) {
    assert.equal(Permissions.agentGateFor(mod, fn), null, `${mod}.${fn} must not be gated`);
  }
});

test('the switch is OFF by default, and the gate is closed with it', () => {
  Permissions.reset();
  assert.equal(Permissions.get().autoEmail, false, 'autoEmail must ship off');
  assert.equal(Permissions.can('email'), false, 'and the gate must be shut');
  // The master switch deliberately does NOT imply email — outbound to other people is its own
  // decision. This is pinned because it is the assumption a future refactor is most likely to
  // "simplify" away.
  Permissions.set({ machineControl: true });
  assert.equal(Permissions.can('email'), false,
    'Full machine control must not unlock sending mail as the owner');
  Permissions.set({ autoEmail: true });
  assert.equal(Permissions.can('email'), true, 'and turning it on must actually open it');
  Permissions.reset();
});

test('the router consults the gate, fails closed, and tells the agent the way out', () => {
  const hb = read('bridge/hub-bridge.mjs');
  assert.match(hb, /CP\.agentGateFor\(name, fn\)/,
    'the gate must be consulted on the agent branch of the /mod router');
  assert.match(hb, /if \(need && !CP\.can\(need\)\)/, 'and it must act on the answer');
  assert.match(hb, /CP\.agentGateAdvice\(need\)/,
    'a refusal must name the alternative — an agent told only "error" drops the draft');
  // …and the alternative must FIT the gate. The first version hardcoded the email advice, so a
  // files.write refusal told the agent to queue an email. The suite asserted the refusal and
  // not its sense; the live sweep read the sentence and caught it.
  const perms = read('bridge/permissions.mjs');
  assert.match(perms, /agentGateAdvice\(need\) \{/, 'the advice belongs beside the gate table');
  assert.match(perms, /queue it with approvals\.add/, 'email → the approval queue');
  assert.match(perms, /"Write files" in Machine/, 'fileWrite → the switch, not the email queue');
  assert.doesNotMatch(perms.match(/agentGateAdvice[\s\S]*?\n  \},/)[0].replace(/'queue it with approvals\.add[^']*'/, ''),
    /approvals\.add/, 'no other gate may inherit the email sentence');
  // The allowlist above it fails OPEN by design; this one must not inherit that.
  assert.match(hb, /catch \(e\) \{ return fail\(503, 'permission gate unavailable/,
    'an unreadable permission store must refuse the send, not wave it through');
});

test('the owner’s own interface is not touched by any of this', () => {
  const hb = read('bridge/hub-bridge.mjs');
  const branch = hb.match(/if \(String\(req\.headers\['x-cfhub-caller'\][\s\S]*?\n {2}\}/)[0];
  assert.match(branch, /=== 'agent'/,
    'the gate must live inside the agent-caller branch — the app drives the same route');
  assert.ok(branch.includes('agentGateFor'), 'and inside it, not beside it');
});

test('the curriculum now describes the behaviour the daemon actually has', () => {
  const agents = read('agent/AGENTS.md');
  assert.match(agents, /email\.send`?\s*\n?\s*refuses/,
    'AGENTS.md must still tell pi that sending is refused with the switch off — it is true now');
  assert.match(agents, /approvals\.add/, 'and must still point at the queue as the way through');
});

process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch {} });
