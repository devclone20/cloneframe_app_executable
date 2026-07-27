// The app had THREE places to add a model, over TWO registries, and only two of them
// checked the key. A provider added in MY MACHINE did not appear in the other two, and
// nothing on screen explained why — "my key works in one screen and not the other".
//
// The two registries are not a duplicate to delete; they do different jobs:
//   Store.brain + Keys  — in the browser. What makes the app work with NO bridge at all.
//   the bridge registry — the only one pi, scheduled tasks, research, recipes and COMPARE
//                         can read, because those run server-side.
// So the fix is one DOOR, writing to both: MY MACHINE → BRAIN checks the key with the
// provider and registers it in both places. The other two stop being doors.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const machine = read('web/panels/machine.js');
const brain = read('web/panels/brain.js');
const settings = read('web/panels/settings.js');

test('the one door registers the key in both registries', () => {
  const fn = machine.slice(machine.indexOf('const hit=PROV.find'), machine.indexOf('// ---- HUB BRIDGE ----'));
  assert.match(fn, /if\(Bridge\.on\(\)\)\{/, 'it must mirror to the bridge when the bridge is up');
  assert.match(fn, /RPC\('models','addProvider',\{kind:'api',provider:id,label:hit\[1\],baseUrl:hit\[2\],apiKey:key\}\)/,
    'with the same provider, base and key it just verified');
  assert.match(fn, /if\(models\.length\)await RPC\('models','setModels',r\.id,models\)/,
    'and the model list it just probed, so the bridge does not have to probe again');
});

test('replacing a key does not leave the old one on the machine', () => {
  const fn = machine.slice(machine.indexOf('const hit=PROV.find'), machine.indexOf('// ---- HUB BRIDGE ----'));
  assert.match(fn, /if\(twin\)await RPC\('models','removeProvider',twin\.id\)/,
    'the previous bridge-side entry for that provider must go, or two keys answer to one name');
});

test('the mirror can never break connecting a model', () => {
  // The browser-side key is what makes the app work with no bridge. A failure to mirror is
  // a degraded state, not a failed CONNECT.
  const fn = machine.slice(machine.indexOf('const hit=PROV.find'), machine.indexOf('// ---- HUB BRIDGE ----'));
  assert.match(fn, /catch\(_\)\{\/\* the browser-side key still works — never fail CONNECT over the mirror \*\/\}/,
    'a mirror failure must be swallowed, with the reason written down');
  assert.match(fn, /shared\?' · shared with your machine':''/, 'and the owner told whether it was shared');
});

test('the second door is gone', () => {
  // BRAIN → Settings → CONNECTED MODELS was a form that stored whatever was typed.
  assert.ok(!brain.includes("id=\"bradd\""), 'the BRAIN add-provider form is back');
  assert.ok(!brain.includes("RPC('models','addProvider'"), 'BRAIN must not add providers any more');
  assert.match(brain, /OPEN MY MACHINE/, 'it must point at the one door instead');
  assert.match(brain, /RPC\('models','removeProvider'/, 'removing from the machine stays — that is not a second door');
});

test('the third place says what it is for', () => {
  assert.match(settings, /This page is for what that cannot do: a <b>local<\/b> server, a custom base URL, or a provider by hand/,
    'Settings → Add Models must read as the advanced view, not a competing place to put a key');
  assert.match(settings, /use <b>MY MACHINE → BRAIN<\/b>/, 'and name the one door for a cloud key');
});
