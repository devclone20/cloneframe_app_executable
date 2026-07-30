// Three defects on the CONFIG / MY MACHINE seam, one theme: the app knew something the owner
// did not.
//
// 1 · SETTINGS shadowed the shared needBridge() with a local copy that did TWO things less than
//     the global one: it could not tell "no daemon" from "not paired", and it never subscribed
//     to 'bridge:changed'. So the owner paired the bridge and all twelve gated sections kept
//     showing "Connect the HUB Bridge" until he clicked away and back. The app had recovered;
//     CONFIG had not noticed.
//
//     The fix does NOT route to the global needBridge(el): that one re-mounts the whole panel,
//     which in SETTINGS would throw him back to the default section. It teaches the local one
//     the two things it was missing, and re-runs only the section he is actually on.
//
// 2 · The note under the key field said "keys live only in this browser session (sessionStorage)
//     — never persisted." Measured: with the bridge connected, CONNECT mirrors the key into the
//     machine registry, which is Keychain-backed (bridge/models.mjs, service "CLONE FRAME HUB").
//     The mirror is deliberate and correct — "ONE key, everywhere", so pi and scheduled tasks
//     can use it. The SENTENCE was the defect, not the design.
//
// 3 · And removal only cleared the browser copy. `Keys.del(rm)` plus a Store filter, with no
//     RPC('models','removeProvider'). So a key the owner believed he had deleted went on living
//     in his Keychain and went on working for the agent. The REPLACE path already removed its
//     twin — same operation, applied to one half.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const settings = read('web/panels/settings.js');
const machine = read('web/panels/machine.js');
const app = read('web/index.html');

test('SETTINGS tells the two bridge failures apart', () => {
  const fn = settings.match(/function needBridge\(\)\{[\s\S]*?\n {4}\}/)[0];
  assert.match(fn, /Bridge\.unpaired&&Bridge\.unpaired\(\)/, 'it must ask which situation this is');
  assert.match(fn, /is running — this window just is not paired/,
    '"Connect the HUB Bridge" is the wrong instruction for a running daemon');
  assert.match(fn, /data-setneedbridge/, 'and mark itself so recovery can find it');
});

test('SETTINGS recovers on pairing without a reload, and keeps the section', () => {
  assert.match(settings, /panelBus\(p\)\.on\('bridge:changed',\(\)=>\{/, 'one subscription per window');
  assert.match(settings, /go\(cur\)/, 'the section he is ON, not the default one');
  assert.match(settings, /function go\(name\)\{\s*\n?\s*cur=name;/, 'so `cur` must be recorded');
});

test('and it degrades in the other direction too', () => {
  // Measured live: with AGENT TOOLS open, Bridge.disconnect() left the permission toggles on
  // screen and clickable, writing to a daemon that was gone. The first version of this fix
  // handled unpaired→paired only; the mirror case is the same defect facing the other way.
  const sub = settings.match(/panelBus\(p\)\.on\('bridge:changed',\(\)=>\{[\s\S]*?\n {4}\}\);/)[0];
  assert.doesNotMatch(sub, /if\(!Bridge\.on\(\)[^)]*\)return/,
    'an early return on "not paired" is what left the dead toggles up');
  assert.match(sub, /Bridge\.on\(\)===showingCard/,
    'it must re-run whenever the screen and the bridge disagree, in either direction');
  assert.match(sub, /GATED\.includes\(cur\)/,
    'and leave the ungated sections (APPEARANCE, SHORTCUTS…) alone');
});

test('SETTINGS does not route to the global needBridge — that would lose his place', () => {
  // The global re-mounts via spec.mount(p). Correct for NOTES; wrong here.
  assert.doesNotMatch(settings, /needBridge\(pane\)|needBridge\(p\)/,
    'the global takes an element and re-mounts the panel');
});

test('the key note describes what actually happens', () => {
  assert.doesNotMatch(app, /keys live only in this browser session \(sessionStorage\) — never persisted/,
    'that sentence was false whenever the bridge was connected');
  const note = app.match(/<div class="secnote">the key stays in this browser session[^<]*(<b>remove<\/b>[^<]*)?<\/div>/)[0];
  assert.match(note, /macOS Keychain/, 'name where it really goes');
  assert.match(note, /While the HUB Bridge is connected/, 'and under which condition');
  assert.match(note, /remove<\/b> clears both/, 'and what the owner can do about it');
});

test('removing a key clears the machine copy too', () => {
  const h = machine.match(/if\(rm\)\{[\s\S]*?\n {6}\}/)[0];
  assert.match(h, /Keys\.del\(rm\)/, 'the browser copy, as before');
  assert.match(h, /RPC\('models','removeProvider',twin\.id\)/, 'and the Keychain-backed twin');
  assert.match(h, /if\(Bridge\.on\(\)\)/, 'only attempted when there is a machine to talk to');
  assert.match(h, /catch\(_\)/, 'a failed mirror-removal must not claim the local one failed');
  // it must read the row BEFORE filtering it out, or there is no label to match the twin by
  assert.ok(h.indexOf('b.providers.find(x=>x.id===rm)') < h.indexOf('b.providers=b.providers.filter'),
    'capture the provider before removing it from the Store');
});

test('the remove and replace paths now do the same thing', () => {
  // Replace already removed the twin. Removal not doing so is what made them diverge.
  assert.equal((machine.match(/RPC\('models','removeProvider'/g) || []).length, 2,
    'exactly two: one on replace, one on remove');
});

test('the note the fix relies on is still there', () => {
  // If "ONE key, everywhere" is ever removed, the sentence above becomes wrong again.
  assert.match(machine, /ONE key, everywhere/, 'the deliberate design this copy describes');
});

test('the built document carries it', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  const d = fs.readFileSync(dist, 'utf8');
  assert.ok(d.includes('macOS Keychain'), 'dist is stale — rebuild');
  assert.ok(d.includes('data-setneedbridge'), 'dist is missing the SETTINGS recovery marker');
});
