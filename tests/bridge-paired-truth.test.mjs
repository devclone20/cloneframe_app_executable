// `Bridge.on()` is the app's single answer to "can this window act on the machine". Around
// forty call sites gate real work on it: which model CODE routes to, whether the shell is
// real, whether the PROJECT tree loads, whether MATRIX talks to the engine.
//
// It used to mean REACHABLE, not PAIRED. /health needs no token — it exists so an unpaired
// probe can learn a daemon is listening — and refresh() set `info` from it alone. So a window
// holding no valid token reported itself connected: every panel's `if(!Bridge.on())
// needBridge()` guard passed, and instead of the card telling the owner to pair, each panel
// fired an RPC that could only 401. NOTES, TASKS, REMINDERS and APPROVAL then printed the
// wire string — `notes.list 401 · unpaired` — into their bodies.
//
// Verified in the running app: with the token cleared, on() is false, unpaired() is true, and
// all four panels show the pairing card with a route to MY MACHINE; with the app auto-paired,
// on() is true and NOTES lists the owner's three real notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
// Line comments first: a prose line containing `/*` would otherwise open a block comment
// and swallow real code up to the next `*/`.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const app = decomment(read('web/index.html'));
const dist = fs.existsSync(path.join(APP, 'dist/index.html')) ? decomment(read('dist/index.html')) : '';

test('refresh() only reports connected when the PAIRING call succeeds', () => {
  assert.match(app, /info=\(h&&h\.ok&&pr&&pr\.ok\)\?Object\.assign\(h,pr\):null/,
    '/health alone proves a daemon exists, not that this window may talk to it');
  assert.doesNotMatch(app, /info=\(h&&h\.ok\)\?h:null/,
    'the reachable-means-connected assignment must be gone');
});

test('connect() refuses a token the daemon rejects instead of reporting success', () => {
  const fn = app.match(/async function connect\(pasted\)[\s\S]*?\n  \}/)[0];
  assert.match(fn, /if\(!pr\|\|!pr\.ok\)\{info=null;/, 'a bad token must not yield a connection');
  assert.match(fn, /refused this token/, 'and must say what to do about it');
  assert.doesNotMatch(fn, /const pr=await pairInfo\(ep\);if\(pr&&pr\.ok\)Object\.assign\(h,pr\);\s*\n\s*Store/,
    'the old always-succeed path must be gone');
});

test('the app can tell "no daemon" apart from "not paired"', () => {
  assert.match(app, /const unpaired=\(\)=>reachable&&!info/, 'the distinction must exist');
  assert.match(app, /return\{connect,refresh,disconnect,health,shell,chat,providerChat,piChat,interrupt,on,unpaired,/,
    'and be exported for the panels to use');
  assert.match(app, /reachable=!!\(h&&h\.ok\)/);
});

// This test used to assert the opposite, and it was wrong — it pinned `reachable=false` into
// place as if it were the contract. Clearing the token cannot tell you whether a daemon is
// still listening. Asserting it made unpaired() false in a window whose daemon was up, so
// MY MACHINE fell to "disconnected · run the command above" about a running daemon: the very
// conflation the rest of this file exists to prevent. Measured live before the change.
test('disconnect drops the session but does not claim the daemon went away', () => {
  const fn = app.match(/function disconnect\(\)\{[^}]*\}/)[0];
  assert.match(fn, /info=null/, 'the session is gone — that part it does know');
  assert.match(fn, /BridgeClient\.setToken\(''\)/, 'and the token with it');
  assert.doesNotMatch(fn, /reachable=false/,
    'reachability is measured by /health, never asserted by a local act');
  assert.match(fn, /refresh\(\)/, 'so it must re-measure instead of guessing');
});

test('the pairing card gives the right instruction for each case', () => {
  const fn = app.match(/function needBridge\(el\)[\s\S]*?\n  \}/)[0];
  assert.match(fn, /Bridge\.unpaired&&Bridge\.unpaired\(\)/, 'it must ask which situation this is');
  assert.match(fn, /not paired with it yet/, '"already running, not paired" is a different fix');
  assert.match(fn, /Needs the <b>HUB Bridge<\/b>/, 'and "not running at all" keeps its own copy');
});

test('an RPC failure keeps the human sentence the transport already produced', () => {
  const fn = app.match(/return async function\(mod,fn,\.\.\.args\)[\s\S]*?\n  \};/)[0];
  assert.match(fn, /if\(e&&e\.notPaired\)throw e/,
    'rewriting NOT_PAIRED into "<mod>.<fn> 401 · unpaired" is what reached the owner');
  assert.match(fn, /er\.status=e\.status;er\.serverError=e\.serverError;er\.mod=mod;er\.fn=fn/,
    'a technical failure keeps its detail attached for a bug report');
});

test('the shared error renderer shows a state, not a raw exception', () => {
  const fn = app.match(/function showErr\(el,e\)\{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /NOT CONNECTED TO THIS MACHINE/, 'an offline panel is waiting, not broken');
  assert.match(fn, /data-openmachine/, 'and it must offer the way out');
  assert.match(fn, /friendlyErr\(msg\)/, 'a real failure is still explained in human words');
  assert.doesNotMatch(fn, /color:var\(--accent\);padding:20px">'\+escHtml\(String/,
    'the raw accent-red dump must be gone');
});

test('every panel that renders failures goes through the shared renderer', () => {
  // one renderer, so a fix reaches all of them at once
  for (const p of ['notes', 'tasks', 'reminders', 'approval', 'brain', 'search', 'harness']) {
    const src = decomment(read('web/panels/' + p + '.js'));
    assert.match(src, /showErr\(|needBridge\(/, p + ' must use the shared error/empty states');
  }
});

test('the built document carries all of it', () => {
  if (!dist) return;
  for (const s of [
    'info=(h&&h.ok&&pr&&pr.ok)?Object.assign(h,pr):null',
    'const unpaired=()=>reachable&&!info',
    'if(e&&e.notPaired)throw e',
    'NOT CONNECTED TO THIS MACHINE',
    'not paired with it yet',
  ]) assert.ok(dist.includes(s), 'dist is missing: ' + s);
});
