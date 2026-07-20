// ─────────────────────────────────────────────────────────────────────────────
// domains/chat/shell — per-session cwd (T-030 follow-up)
//
// Locks the contract the app depends on:
//   • a stable `sid` gets its OWN tracked cwd (two tabs never stomp each other)
//   • an id-less / sid-less one-shot uses the AMBIENT session
//   • AMBIENT follows the most-recently-active keyed `cd` (so "run where I am"
//     tracks the terminal you last used)
//   • cwd() (read by /pair + the boot banner) reports the AMBIENT cwd
//
// Drives the `cd`/`pwd` built-ins only — they res.end() synchronously with no
// spawn, so no child process (or zsh) is needed.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import Shell from '../bridge/domains/chat/shell.mjs';

const HOME = process.env.HOME || os.homedir();

// Two real, always-present, distinct directories to cd into.
const DIR_A = os.tmpdir();
const DIR_B = '/';

// Minimal req/res doubles. The built-in cd/pwd path is fully synchronous, so the
// captured body is ready as soon as handleShell() returns control.
function drive(cmd, sid) {
  let body = '';
  const res = { writeHead() {}, write(s) { body += String(s); }, end(s) { if (s != null) body += String(s); } };
  const req = { on() {} };
  Shell.handleShell(req, res, sid ? { cmd, sid } : { cmd }, { streamHead() {} });
  return body;
}

// The last \x00CWD\x00<dir> marker in a response is the session's tracked cwd.
function cwdMark(body) {
  const parts = body.split('\x00CWD\x00');
  return parts.length > 1 ? parts[parts.length - 1] : null;
}

test('a keyed session tracks its own cwd across calls', () => {
  drive('cd ' + DIR_A, 'sessA');
  assert.equal(cwdMark(drive('pwd', 'sessA')), DIR_A);
});

test('a second session is isolated — it does not see the first session\'s cd', () => {
  drive('cd ' + DIR_A, 'A2');
  const b = cwdMark(drive('pwd', 'B2'));   // never cd'd → opens at HOME
  assert.equal(b, HOME);
  assert.notEqual(b, DIR_A);
});

test('isolation holds when a second session cds away', () => {
  drive('cd ' + DIR_A, 'A3');
  drive('cd ' + DIR_B, 'B3');
  assert.equal(cwdMark(drive('pwd', 'A3')), DIR_A);   // A3 unmoved
  assert.equal(cwdMark(drive('pwd', 'B3')), DIR_B);   // B3 at /
});

test('an id-less one-shot uses AMBIENT, which follows the last keyed cd', () => {
  drive('cd ' + DIR_A, 'A4');
  assert.equal(cwdMark(drive('pwd')), DIR_A);          // ambient followed A4
  drive('cd ' + DIR_B, 'B4');
  assert.equal(cwdMark(drive('pwd')), DIR_B);          // ambient now follows B4
});

test('cwd() reports the AMBIENT cwd', () => {
  drive('cd ' + DIR_A, 'A5');
  assert.equal(Shell.cwd(), DIR_A);
  drive('cd ' + DIR_B, 'B5');
  assert.equal(Shell.cwd(), DIR_B);
});

test('cd to a non-directory does not move the session', () => {
  drive('cd ' + DIR_A, 'A6');
  const out = drive('cd /this/does/not/exist/at/all', 'A6');
  assert.match(out, /no such file or directory/);
  assert.equal(cwdMark(drive('pwd', 'A6')), DIR_A);    // still DIR_A
});
