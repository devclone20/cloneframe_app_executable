// Two things the app persisted and then lied about.
//
// HARNESS GATE — a gated harness pauses an irreversible tool for an inline APPROVE/REJECT
// card, and the card is saved with the session. After a reload it came back with both
// buttons live, wired to a pendingGates map that a reload had emptied. Clicking did
// nothing. Worse, the run it belonged to had died with the reload, so there was nothing
// left to approve — in the one part of the app that is meant to be real governance.
//
// iT FILES — the tree cached every directory listing for the life of the session, and the
// listing it cached on failure was an empty array. A folder first read while the bridge was
// down stayed empty forever; a file dropped in Finder never appeared, though the ⤢ button
// says it will.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const term = read('web/panels/terminal.js');
const shell = read('web/panels/shell.js');
const app = read('web/index.html');

// ── HARNESS GATE ─────────────────────────────────────────────────────────────
test('a gate that outlived its run is retired on load', () => {
  assert.match(term, /if\(m&&m\.role==='gate'&&!m\.resolved\)\{m\.resolved='expired';n\+\+\}/,
    'unresolved gates must be marked expired when the panel loads its state');
  assert.match(term, /if\(n\)saveSt\(\);/, 'the retirement must be persisted, or it un-expires on the next load');
});

test('an expired gate shows no buttons and does not claim the owner decided', () => {
  // Anchored on the RENDERER, not on the first mention of a gate — the load-time sweep
  // above matches that too, and a slice that lands there asserts nothing while looking green.
  const at = term.indexOf('<div class="cdgate');
  assert.ok(at > 0, 'could not find the gate card renderer — this test needs updating');
  const card = term.slice(at, at + 900);
  assert.match(card, /m\.resolved==='expired'\?'⏱ the session ended before you answered — this was never run'/,
    'an expired gate must say what actually happened');
  // The old renderer had exactly two outcomes, so anything not 'approved' read as
  // "rejected by owner" — which would be a lie about a decision nobody made.
  assert.match(card, /m\.resolved==='approved'\?'✓ approved by owner':m\.resolved==='expired'\?/,
    'expired must be tested BEFORE falling through to the rejected copy');
  assert.match(card, /\$\{m\.resolved\?/, 'any resolved gate must render its outcome, never the buttons');
  assert.match(app, /\.cdgate\.expired\{/, 'an expired card must not keep the live-gate accent border');
});

test('nothing is ever silently approved', () => {
  // The safe direction is the only acceptable one: an unanswered gate becomes 'expired',
  // never 'approved'. This assertion is the whole security property of the change.
  assert.doesNotMatch(term, /m\.resolved='approved';n\+\+/, 'a restore path must never resolve a gate as approved');
});

// ── iT FILES tree ────────────────────────────────────────────────────────────
// Behavioural, not textual: the shipped lsDir is lifted out and run against stubs, with
// Date injected so the TTL can be exercised without waiting.
function makeLsDir({ tree, RPC, clock }) {
  const start = shell.indexOf('const LS_TTL=4000;');
  const end = shell.indexOf('function expandTo(dir){');
  assert.ok(start > 0 && end > start, 'could not isolate lsDir — this test needs updating');
  const body = shell.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function('tree', 'RPC', 'Date', body + '\nreturn lsDir;')(tree, RPC, clock);
}
const clockAt = (ref) => ({ now: () => ref.t });

test('a failed listing is not cached, and does not become an empty folder', async () => {
  const ref = { t: 1000 };
  const tree = { kids: new Map() };
  let mode = 'fail', calls = 0;
  const RPC = async () => { calls++; if (mode === 'fail') throw new Error('bridge down'); return { ok: true, entries: [{ name: 'a.txt', type: 'file' }] }; };
  const lsDir = makeLsDir({ tree, RPC, clock: clockAt(ref) });

  assert.deepEqual(await lsDir('/x'), [], 'a failure should read as empty on screen for now');
  assert.equal(tree.kids.has('/x'), false, 'but it must NOT be cached — that is the bug');
  mode = 'ok';
  const after = await lsDir('/x');
  assert.equal(after.length, 1, 'once the bridge is back the folder must fill in');
  assert.equal(calls, 2, 'the second look must actually ask again');
});

test('a failure after a success keeps the last good listing', async () => {
  const ref = { t: 1000 };
  const tree = { kids: new Map() };
  let mode = 'ok';
  const RPC = async () => { if (mode === 'fail') return { ok: false, error: 'nope' }; return { ok: true, entries: [{ name: 'a.txt', type: 'file' }] }; };
  const lsDir = makeLsDir({ tree, RPC, clock: clockAt(ref) });
  assert.equal((await lsDir('/x')).length, 1);
  mode = 'fail'; ref.t += 9999;                       // past the TTL, so it re-asks and fails
  assert.equal((await lsDir('/x')).length, 1, 'a blip must not blank a folder the owner is looking at');
});

test('the listing expires, so a file created outside the app shows up', async () => {
  const ref = { t: 1000 };
  const tree = { kids: new Map() };
  let entries = [{ name: 'a.txt', type: 'file' }], calls = 0;
  const RPC = async () => { calls++; return { ok: true, entries }; };
  const lsDir = makeLsDir({ tree, RPC, clock: clockAt(ref) });

  assert.equal((await lsDir('/x')).length, 1);
  entries = [{ name: 'a.txt', type: 'file' }, { name: 'dropped-in-finder.png', type: 'file' }];
  ref.t += 500;
  assert.equal((await lsDir('/x')).length, 1, 'within the TTL it must serve the cache — this is not a re-fetch per keystroke');
  assert.equal(calls, 1);
  ref.t += 5000;
  assert.equal((await lsDir('/x')).length, 2, 'past the TTL the new file must appear');
  assert.equal(calls, 2);
});

test('force ignores the cache', async () => {
  const ref = { t: 1000 };
  const tree = { kids: new Map() };
  let calls = 0;
  const RPC = async () => { calls++; return { ok: true, entries: [] }; };
  const lsDir = makeLsDir({ tree, RPC, clock: clockAt(ref) });
  await lsDir('/x'); await lsDir('/x', true);
  assert.equal(calls, 2, 'an explicit refresh must always hit the bridge');
});

test('concurrent asks for the same folder share one request', async () => {
  // drawLevel walks every open folder on every render, and the filter box renders on each
  // keystroke. Without this, one keypress could fan out into a burst of identical calls.
  const ref = { t: 1000 };
  const tree = { kids: new Map() };
  let calls = 0;
  const RPC = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, entries: [] }; };
  const lsDir = makeLsDir({ tree, RPC, clock: clockAt(ref) });
  await Promise.all([lsDir('/x'), lsDir('/x'), lsDir('/x'), lsDir('/x')]);
  assert.equal(calls, 1, 'four simultaneous asks must produce one request');
  // and the in-flight entry must be released, or the folder is stuck on a stale promise
  ref.t += 5000;
  await lsDir('/x');
  assert.equal(calls, 2);
});
