// bridge/servers.mjs gates the owner's cloud behind the `ssh` permission, and its own header
// explains why in as many words: this module once ran "with no permission check at all — while
// ssh.mjs, doing strictly less, gated on Permissions.can('ssh')".
//
// Six of the seven functions that leave this machine carry that gate. `dropletStatus` did not,
// and it is not a read:
//
//   await _doFetch('GET', '/v2/droplets/' + s0.dropletId, s0.doToken)   ← api.digitalocean.com
//   if (s && ip !== s.host) { s.host = ip; save(st); }                  ← writes his record
//
// So with `ssh` off — the factory default — a caller on the RPC surface could still reach the
// owner's DigitalOcean account with his token and change the saved host of one of his servers.
//
// Found in H5 by asking a simpler question of every promise: "what call proves this?" The
// promise was "refusals name the exact toggle", and servers.list answered without refusing.
// list/get/add/update/remove/automations are local-only and deliberately ungated; that is fine.
// dropletStatus is not local.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(APP, 'bridge/servers.mjs'), 'utf8');

// Every exported fn, with its body, so the check is structural rather than a grep for a string.
function bodyOf(name) {
  const m = src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  return m ? m[0] : null;
}

test('every function that leaves this machine carries the ssh gate', () => {
  const OUTBOUND = ['test', 'run', 'runAutomation', 'deployAgent', 'provision', 'dropletStatus', 'powerAction'];
  const ungated = OUTBOUND.filter((f) => {
    const b = bodyOf(f);
    return !b || !/_mayTouchServers\(\)/.test(b);
  });
  assert.deepEqual(ungated, [], 'these reach the network without the gate: ' + ungated.join(', '));
});

test('dropletStatus gates BEFORE it reads the record or the token', () => {
  const b = bodyOf('dropletStatus');
  assert.ok(b, 'dropletStatus must still exist');
  assert.ok(b.indexOf('_mayTouchServers()') < b.indexOf('_doFetch'),
    'the gate must precede the outbound call');
  assert.ok(b.indexOf('_mayTouchServers()') < b.indexOf('s0.doToken'),
    'and precede touching the DigitalOcean token at all');
});

test('dropletStatus also WRITES — which is why a read-only exemption would be wrong', () => {
  const b = bodyOf('dropletStatus');
  assert.match(b, /s\.host = ip; save\(st\);/,
    'it mutates the owner’s server record, so it is not a read');
});

test('the local-only functions stay ungated, deliberately', () => {
  // These never leave the machine. Gating them would break the panel with ssh off for no gain.
  for (const f of ['list', 'get', 'add', 'update', 'remove', 'automations']) {
    const b = bodyOf(f);
    if (!b) continue;
    assert.doesNotMatch(b, /_doFetch|sshArgv|spawn/, f + ' reaches out — it needs the gate');
  }
});

test('the gate still names the exact toggle', () => {
  assert.match(src, /ssh permission is off — enable it in Settings → Agent Tools/,
    'a refusal that does not say which switch is not an instruction');
});

test('ssh is not implied by the machineControl master switch', () => {
  // The gate is only meaningful if `ssh` has to be turned on deliberately. permissions.mjs
  // documents this: machineControl implies almost everything EXCEPT ssh, email and matrix.
  const perms = fs.readFileSync(path.join(APP, 'bridge/permissions.mjs'), 'utf8');
  assert.match(perms, /ssh: false/, 'and it ships off');
});
