// bridge/webengine.mjs states its own invariant, in its own words: the profile is disposable,
// everything lives in an in-memory private context, and the on-disk profile "should hold
// nothing". That was true while the engine ran and false the rest of the time.
//
// It was erased on LAUNCH only. So everything the engine had written sat on disk from the moment
// it exited until the next launch — which can be days.
//
// Measured, with NO engine running:
//
//   ~/.clone-frame-hub/web-engine/Default/Cookies   7 rows, all click.endnote.com
//                                                   written 15 min earlier by an engine that
//                                                   had since exited
//   Default/History                                 0 rows  ← browsing itself never persisted
//
// So the ephemeral promise held for what the owner browses, and leaked around the edges: a
// link-redirect domain a research flow had passed through, left behind by a dead process.
//
// Two gaps, both closed:
//   · webengine.stop() now wipes, not just start
//   · the daemon takes the engine down on SIGINT/SIGTERM — nothing was calling stop() at all
//     when the daemon exited, so a Ctrl-C left the whole profile behind
//
// Verified live: daemon up → engine open → 14M profile on disk → SIGTERM the daemon → daemon
// gone, engine gone, profile WIPED.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const engine = read('bridge/webengine.mjs');
const bridge = read('bridge/hub-bridge.mjs');

test('the profile is wiped on stop, not only on start', () => {
  const stop = engine.match(/async stop\(\) \{[\s\S]*?\n {2}\},/)[0];
  assert.match(stop, /fs\.rmSync\(path\.join\(hubRoot\(\), 'web-engine'\), \{ recursive: true, force: true \}\)/,
    'leaving it until the next launch is what left cookies on disk for days');
  assert.match(stop, /fs\.rmSync\(uploadDir\(\)/, 'staged uploads die with the session too');
  // and only AFTER the process is actually gone, or we would be deleting a live profile
  assert.ok(stop.indexOf('_waitExit') < stop.indexOf("'web-engine'"),
    'wait for the exit before erasing what it was using');
  assert.match(stop, /catch \{ \/\* next start \*\/ \}/, 'cleanup must never fail a stop');
});

test('the start-side wipe is still there — both ends, not one instead of the other', () => {
  assert.match(engine, /try \{ fs\.rmSync\(profile, \{ recursive: true, force: true \}\); \} catch/,
    'a file held by a dying previous engine survives one boot and dies on the next');
});

test('the daemon takes the engine down with it', () => {
  assert.match(bridge, /process\.on\('SIGINT', \(\) => bye\('SIGINT'\)\)/);
  assert.match(bridge, /process\.on\('SIGTERM', \(\) => bye\('SIGTERM'\)\)/);
  assert.match(bridge, /m\.Webengine\.stop\(\)/, 'and it must call the function that wipes');
});

test('quitting can never hang on cleanup', () => {
  const blk = bridge.match(/\{\s*\n\s*let leaving = false;[\s\S]*?\n\}/)[0];
  assert.match(blk, /setTimeout\(done, 3000\)/, 'time-boxed');
  assert.match(blk, /if \(leaving\) return; leaving = true;/, 'a second signal must not re-enter');
  assert.match(blk, /catch \{ \/\* not running \*\/ \}/, 'no engine is not an error');
  assert.match(blk, /clearTimeout\(timer\); done\(\);/, 'and a clean finish beats the deadline');
});

test('the invariant this defends is still written down next to the code', () => {
  assert.match(engine, /the on-disk profile is pure Chrome scaffolding that should hold nothing/,
    'if this sentence goes, the wipes lose their reason');
});

test('the profile is not in the repo and never was', () => {
  // Belt and braces: the residue lived under ~/.clone-frame-hub, never in the tree.
  assert.ok(!fs.existsSync(path.join(APP, 'web-engine')), 'no engine profile inside the repo');
});
