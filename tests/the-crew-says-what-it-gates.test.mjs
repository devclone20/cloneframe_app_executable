// KNOWN-ISSUES called this "the one that changes a documented promise": the HARNESS gates
// do not apply when a CODE session runs on `pi`. That was true, and the reason turns out to
// be structural rather than an omission — which changes what the right fix is.
//
// agentRun drives the BYOK tool loop: it holds GATED_TOOLS, calls harnessGates(cur), and puts
// an APPROVE/REJECT card in the chat before run_shell / write_file / send_email / server_*.
// piRun does not use that loop at all. It streams pi's own agentic loop, and pi's own tools —
// its bash, its editor — execute inside pi's process. They never cross the bridge. There is
// no seam between pi and its shell for CLONE FRAME to stand in, and inventing one would mean
// pi routing its tools back through the daemon, which is pi's architecture, not ours.
//
// What pi does to the APP does cross the bridge, through the clone-frame extension, and every
// one of those tools is now gated in the daemon:
//
//     app_rpc → POST /mod/<module>   with x-cfhub-caller: agent
//       email.send · scheduled.schedule · approvals.approve        → the email switch
//       files.write/writeB64/mkdir/remove/move/copy                 → the fileWrite switch
//       servers.* · ssh.*                                           → the ssh switch
//       matrix engine control                                       → the matrix switch
//       rpcallow.set/reset                                          → refused outright
//       every shell path                                            → the catastrophic blocklist
//
// So the honest fix is not a gate that cannot exist. It is to stop the interface implying one.
// A crew chip that reads the same next to `pi` as next to a connected model is the lie; the
// gate table above is the substance. Both halves are pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const terminal = read('web/panels/terminal.js');

test('pi is given no shell by CLONE FRAME — which is why no crew can gate one', () => {
  const ext = read('agent/.pi/extensions/clone-frame.ts');
  const tools = [...ext.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(tools.length >= 10, 'the extension must still register its tools');
  for (const forbidden of ['run_shell', 'shell', 'exec', 'bash', 'applescript', 'write_file']) {
    assert.ok(!tools.includes(forbidden),
      `the extension must not hand pi a "${forbidden}" tool — if it ever does, this test is the ` +
      'place to notice, because then a bridge-side gate becomes both possible and required');
  }
});

test('the crew chip stops implying a gate it cannot hold', () => {
  assert.match(terminal, /hEl\.textContent=\(hOn\|\|'No harness'\)\+\(hOn&&mv==='pi'\?' · off for pi':''\)/,
    'a crew selected on a pi session must say so on the chip itself');
  assert.match(terminal, /pi runs its own tools in its own process/,
    'and the tooltip must say why, not merely that');
  assert.match(terminal, /This session runs <b>pi<\/b>/,
    'the crew picker must say it at the point of choice, not only after the choice');
  // …and it must still be plain about the case where it DOES apply.
  assert.match(terminal, /This crew\\'s gates apply to every gated tool in this session\./);
  assert.match(terminal, /No crew: gated tools run without an approval card\./);
});

test('the BYOK loop still gates everything it always did', () => {
  // The fix must not have quietly weakened the path where the gates are real.
  const gated = terminal.match(/const GATED_TOOLS=new Set\(\[[^\]]+\]\)/)[0];
  for (const tool of ['run_shell', 'applescript', 'write_file', 'send_email', 'server_run']) {
    assert.ok(gated.includes(`'${tool}'`), tool + ' must stay gated in the BYOK loop');
  }
  assert.match(terminal, /if\(GATED_TOOLS\.has\(c\.name\)&&gates===null\)/,
    '"I never found out what the gates are" must still be a CLOSED gate, not an open one');
});

test('everything pi does to the app passes a daemon gate', () => {
  const perms = read('bridge/permissions.mjs');
  const hb = read('bridge/hub-bridge.mjs');
  // The table the comment above promises.
  for (const [call, gate] of [
    ['email.send', 'email'], ['scheduled.schedule', 'email'], ['approvals.approve', 'email'],
    ['files.write', 'fileWrite'], ['files.remove', 'fileWrite'], ['files.move', 'fileWrite'],
  ]) assert.ok(perms.includes(`'${call}': '${gate}'`), call + ' must need the ' + gate + ' switch');

  assert.match(hb, /Permissions\.agentGateFor\(name, fn\)/, 'and the router must consult it');
  assert.match(read('bridge/ssh.mjs'), /Permissions\.can\('ssh'\)/);
  assert.match(read('bridge/servers.mjs'), /isDestructive\(/);
  assert.match(read('bridge/matrix.mjs'), /Permissions\.can\('matrix'\)/);
  assert.match(hb, /fn === 'set' \|\| fn === 'reset'/, 'and the agent may not rewrite its own allowlist');
});
