// AUTOMATIONS was a demo wearing a panel's clothes.
//
// Four buttons proposed hardcoded samples — "Transfer 10 USDC to treasury",
// "partner@example.io" — into a SECOND approval queue that lived in the browser, separate
// from the real one in bridge/approvals.mjs that APPROVAL reads. Above them sat two
// switches, "Agent autonomy" and "Require approval", written by this panel and read by
// nothing: not the bridge, not any agent path, not the permission gate the daemon
// enforces. The panel told the owner their agent was on a leash it did not hold.
//
// Worse, EMAIL's "via approval" wrote to that browser queue, so a message sent for
// approval went somewhere nothing else could see: it never reached APPROVAL, and
// approving it there could never have sent it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
// A comment that names what was removed is the POINT of the comment — matching prose
// would fail on the explanation itself while the code stayed clean. Assertions about
// what is gone run against code with the comments stripped.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const auto = decomment(read('web/panels/automations.js'));
// index.html carries the block comment that explains the removal, and it quotes the very
// strings being asserted gone. Strip /* */ as well as // before checking absence.
const strip = (s) => decomment(s).replace(/\/\*[\s\S]*?\*\//g, '');
const indexRaw = read('web/index.html');
const index = strip(indexRaw);
const email = decomment(read('web/panels/email.js'));
const harness = decomment(read('web/panels/harness.js'));
const settings = decomment(read('web/panels/settings.js'));
const distPath = path.join(HERE, '..', 'dist', 'index.html');
const dist = fs.existsSync(distPath) ? read('dist/index.html') : '';

test('the fabricated proposals are gone', () => {
  for (const fake of ["partner@example.io'", 'Transfer 10 USDC to treasury', 'Accept ACP job #128',
    'Post the weekly update', 'SAMPLES={', 'PROPOSE AN ACTION', 'data-act="', 'executed (demo)']) {
    assert.ok(!auto.includes(fake), 'the demo content ' + JSON.stringify(fake) + ' is still in the panel');
    assert.ok(!index.includes(fake), 'the demo content ' + JSON.stringify(fake) + ' is still in the chrome');
  }
});

test('there is one approval queue, and it is the bridge’s', () => {
  assert.ok(!/const Approvals=\(\(\)=>\{/.test(index), 'the browser-side approval machine is back');
  assert.ok(!/Approvals\.(propose|approve|reject|pendingCount)\(/.test(email + auto + harness),
    'something still calls the browser-side queue');
  assert.ok(!/const Approvals=/.test(index), 'the browser-side queue is still defined');
  assert.match(email, /RPC\('approvals','add',\{type:'ai_email'/, 'EMAIL must queue into the real store');
  assert.match(harness, /RPC\('approvals','count'\)/, 'the frame squares must count the real queue');
  assert.match(auto, /RPC\('approvals','count'\)/, 'AUTOMATIONS must read the real queue');
});

test('the switches that controlled nothing are gone, and the real gate is shown instead', () => {
  for (const dead of ['autosw', 'apsw', 'autonomy.enabled', 'requireApproval']) {
    assert.ok(!auto.includes(dead), 'the dead control "' + dead + '" is still in the panel');
  }
  // The store shapes those switches wrote must be cleaned up, not left as a shape that
  // looks meaningful — the same treatment brainCfg got.
  assert.match(indexRaw, /for\(const k of \['autonomy','approvals','automations'\]\)if\(k in s\)delete s\[k\]/,
    'the dead store keys must be deleted on load');
  assert.match(indexRaw, /if\(s\.email&&'autonomy' in s\.email\)delete s\.email\.autonomy/,
    "the email autonomy value SETTINGS wrote and nobody read must go too");
  assert.match(auto, /RPC\('permissions','get'\)/, 'it must show the gate the daemon actually enforces');
  assert.match(auto, /ASKS FIRST/, 'and say plainly what happens when a gate is closed');
});

test('the permission gate has exactly one writer', () => {
  // Reading it in two places is fine. Writing it in two places is how the last one broke.
  assert.ok(!/RPC\('permissions','set'/.test(auto), 'AUTOMATIONS must not be a second writer');
  assert.match(auto, /SETTINGS → MACHINE/, 'it must point at the panel that owns it');
  // Pinned as a CONTRACT — the set and the announcement, in that order — not as one exact
  // concatenation. The literal version went red the moment a line was added between them to
  // keep the local `perms` snapshot in step, which is a false alarm with a maintenance cost.
  const writer = settings.match(/RPC\('permissions','set',\{\[k\]:on\}\)[\s\S]{0,120}/)[0];
  assert.match(writer, /Bus\.emit\('permissions:changed'\)/,
    'the one writer must announce the change, right after making it');
});

test('the four autonomy levels that did nothing are gone from SETTINGS', () => {
  for (const dead of ['emautb', 'autonomy:b.dataset.a', "['full-auto'", "['show-first'", 'const AUT=[']) {
    assert.ok(!settings.includes(dead), 'the dead email autonomy control "' + dead + '" survived');
  }
  assert.match(settings, /WHAT AN AGENT MAY DO WITH THIS/, 'it must be replaced by what is true');
  assert.match(settings, /Send email without asking/, 'naming the permission that really decides');
});

test('each panel announces what it changes, so the others are never a stale snapshot', () => {
  assert.match(read('web/panels/tasks.js'), /Bus\.emit\('tasks:changed'\)/, 'TASKS must announce');
  for (const evt of ['approvals:changed', 'tasks:changed', 'permissions:changed', 'bridge:changed']) {
    assert.ok(auto.includes("panelBus(p).on('" + evt + "'"), 'AUTOMATIONS must listen for ' + evt);
  }
  assert.match(email, /Bus\.emit\('approvals:changed'\)/, 'queueing an email must announce it');
});

test('AUTOMATIONS links to the panels that own each thing', () => {
  for (const [ctl, panel] of [['autoq', 'approval'], ['autotasks', 'tasks']]) {
    assert.ok(auto.includes("#" + ctl) && auto.includes("openPanel('" + panel + "')"),
      'the ' + ctl + ' control must open ' + panel);
  }
  assert.match(auto, /openPanel\('settings'\)/, 'and the gate must lead to where it is set');
  assert.match(harness, /Panels\.openPanel\('approval'\)/, 'the pending badge must open the queue it counts');
});

test('pi is taught these five, and no longer told about panels that were deleted', () => {
  const ext = read('agent/.pi/extensions/clone-frame.ts');
  // open_panel had the same rot: it listed calendar/contacts/library/cookbook/compare/
  // gallery/integrations as openable long after they were removed, so every one of those
  // calls failed. A tool description IS the agent's knowledge — stale here means wrong there.
  const openDesc = ext.slice(ext.indexOf('name: "open_panel"'), ext.indexOf('name: "read_screen"'));
  assert.match(openDesc, /There is no calendar, contacts, library, cookbook, compare, gallery or integrations panel/,
    'open_panel must say those are gone rather than list them as openable');
  for (const live of ['approval', 'automations', 'reminders', 'brain']) {
    assert.ok(openDesc.includes(live), 'open_panel must name the live panel ' + live);
  }
  const desc = ext.slice(ext.indexOf('name: "app_rpc"'), ext.indexOf('name: "web_navigate"'));
  for (const gone of ['library', 'calendar', 'contacts']) {
    assert.ok(!desc.includes(gone), 'app_rpc still advertises the deleted module "' + gone + '"');
  }
  for (const mod of ['brain', 'notes', 'tasks', 'reminders', 'approvals', 'scheduled']) {
    assert.ok(desc.includes(mod), 'app_rpc must name the ' + mod + ' module');
  }
  const guide = read('agent/AGENTS.md');
  assert.match(guide, /## 5\.1 The owner's five/, 'the curriculum must teach them');
  assert.match(guide, /Saying you will\nremember is not remembering/, 'and say why it matters');
  for (const call of ['brain.add', 'notes.create', 'tasks.add', 'reminders.create', 'approvals.add']) {
    assert.ok(guide.includes(call), 'the curriculum is missing ' + call);
  }
  // The map must be redrawable on demand, by pi and by the owner — a tree that only
  // refreshes on a build describes a body that has already moved.
  assert.match(read('bridge/pi.mjs'), /export const Pi = \{[^}]*\brefreshTree\b/, 'refreshTree must be callable');
  assert.match(read('bridge/pi.mjs'), /export const Pi = \{[^}]*\bdocPaths\b/, 'docPaths must be callable');
  assert.match(guide, /### 15\.1 Redraw it yourself/, 'the curriculum must teach the refresh');
  const brain = read('web/panels/brain.js');
  assert.match(brain, /RPC\('pi','refreshTree'\)/, 'BRAIN must offer the button');
  assert.match(brain, /RPC\('pi','docPaths'\)/, 'and say where each document lives');
});

test('the shipped artifact carries the rewiring', () => {
  if (!dist) return;
  assert.ok(dist.includes("RPC('approvals','add',{type:'ai_email'"), 'dist is missing the real queue call');
  // Comments ship with the splice, so assert on executable shapes only.
  assert.ok(!dist.includes('data-act="email"'), 'the demo buttons shipped');
  assert.ok(!/const Approvals=\(\(\)=>\{/.test(dist), 'the second queue shipped');
  assert.ok(!dist.includes('SAMPLES={'), 'the sample proposals shipped');
});
