// F-002 — MY MACHINE is the panel every other panel's error state points at, so the one
// sentence it must never get wrong is "what is actually wrong".
//
// `Bridge.info()` is null in TWO different situations: no daemon at all, and a daemon that
// is up and answering /health while this window holds no token. Wave W added
// `Bridge.unpaired()` precisely to tell those apart, and taught `needBridge()` to give the
// right instruction for each. MY MACHINE never got the same treatment: `paintBridge()` had
// an `if (inf) … else …` and the else branch said "disconnected · run the command above,
// then paste the link it prints".
//
// So with the daemon running and the window simply not paired, the owner was told to start
// a daemon that was already running — measured live on 2026-07-30: /health ok:true,
// stale:false, Bridge.unpaired() === true, and the panel showing "● disconnected · run the
// command above". The pairing field was on screen, two lines below the sentence sending him
// to a terminal.
//
// This is the E1/E2 pair from the promise ledger: E1 (no daemon) must say "run the HUB
// Bridge"; E2 (running, not paired) must say "paste the link". One panel, two truths.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
// Line comments FIRST — a prose line containing a /* would otherwise open a block comment
// and swallow real code up to the next */ (this has produced bogus failures here before).
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const machine = decomment(read('web/panels/machine.js'));
const distPath = path.join(APP, 'dist/index.html');

function paintBridge(src) {
  const m = src.match(/function paintBridge\(\)\{[\s\S]*?\n {4}\}/);
  assert.ok(m, 'paintBridge() not found in web/panels/machine.js');
  return m[0];
}

test('paintBridge asks whether the daemon is merely unpaired', () => {
  assert.match(
    paintBridge(machine),
    /Bridge\.unpaired\(\)/,
    'MY MACHINE must consult Bridge.unpaired(); Bridge.info() alone cannot tell the two failures apart',
  );
});

test('the unpaired state does not tell the owner to start a running daemon', () => {
  const fn = paintBridge(machine);
  // Split at the unpaired branch: everything after it is the not-paired + no-daemon copy.
  const idx = fn.indexOf('Bridge.unpaired()');
  const unpairedArm = fn.slice(idx, fn.indexOf('else', idx) === -1 ? fn.length : fn.indexOf('else', idx));
  assert.doesNotMatch(
    unpairedArm,
    /run the command above/,
    'that instruction belongs to the no-daemon case only',
  );
  assert.match(
    unpairedArm,
    /is running|already running/,
    'the unpaired sentence must say the daemon is up, so the owner stops looking at his terminal',
  );
  assert.match(unpairedArm, /pair/i, 'and must name pairing as the thing to do');
});

test('the no-daemon state keeps its own, different instruction', () => {
  const fn = paintBridge(machine);
  assert.match(fn, /run the command above/, 'the no-daemon copy must survive');
  // Three distinct status words, so the two failures never read identically.
  assert.match(fn, /not paired/, 'the unpaired status word');
  assert.match(fn, /disconnected/, 'the no-daemon status word');
  assert.match(fn, /connected/, 'the healthy status word');
});

test('no new control was added to carry the message', () => {
  // RULE 3: words inside an existing state may change; the surface may not grow.
  // paintBridge only ever writes into #brstat and #brinfo — it must still only do that.
  const fn = paintBridge(machine);
  const targets = [...fn.matchAll(/\b(brStat|brInfo|brEp)\b/g)].map((m) => m[1]);
  assert.ok(targets.length > 0, 'paintBridge should still paint the existing nodes');
  assert.deepEqual(
    [...new Set(targets)].sort(),
    ['brEp', 'brInfo', 'brStat'],
    'paintBridge must not reach for any node other than the three it already owned',
  );
});

test('the built artefact carries the fix (build ran after the edit)', (t) => {
  if (!fs.existsSync(distPath)) return t.skip('dist/index.html not built in this environment');
  const dist = decomment(read('dist/index.html'));
  // Deliberately the panel's own distinctive sentence, not a generic `Bridge.unpaired()`
  // match: other code already calls that, so a loose assertion here would pass green
  // against an unbuilt artefact and prove nothing.
  assert.match(
    dist,
    /it just has not paired with this window/,
    'dist/index.html does not carry the MY MACHINE fix — run npm run build after editing web/',
  );
});
