// F-003 — the anti-wipe guard fires and the owner is never told.
//
// POST /shell reports five out-of-band conditions with a \x00ERR\x00 marker:
//
//   · refused: catastrophic pattern blocked for safety   ← THE ANTI-WIPE GUARD
//   · root/sudo is OFF. Enable "Root mode" …
//   · command timed out (2m)                             ← the process was SIGKILLed
//   · output capped (512 KiB)                            ← the output you see is partial
//   · the child's own spawn error
//
// BridgeClient's marker parser turns that into `marks.err`. CODE renders it
// (`web/panels/terminal.js`, `'⚠ ' + marks.err`). iT's `run()` read `marks.needSudo` and
// `marks.cwd` and dropped `marks.err` on the floor.
//
// So in iT, typing `rm -rf /` printed the echoed prompt and nothing else — indistinguishable
// from a command that ran and produced no output. Same for a two-minute build that was
// actually killed, and for output silently truncated at 512 KiB. The guard was working
// perfectly; its sentence never arrived. That is the worst shape of this app's worst defect
// class: a refusal the owner cannot see is, from where he sits, a command that ran.
//
// This test pins all three layers plus the parity between the two shells, so neither side
// can lose the message again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
// Line comments FIRST: a prose line containing a /* would otherwise open a block comment.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const shellMod = read('bridge/domains/chat/shell.mjs');           // comments kept: we assert on strings
const app = decomment(read('web/index.html'));
const itPanel = decomment(read('web/panels/shell.js'));
const codePanel = decomment(read('web/panels/terminal.js'));

test('layer 1 — the daemon still refuses catastrophic commands, and says so out of band', () => {
  assert.match(
    shellMod,
    /if \(isDestructive\(cmd\)\) \{\s*\n?\s*res\.end\('\\x00ERR\\x00refused: catastrophic pattern blocked for safety/,
    'the anti-wipe guard must stay armed and must report through the ERR marker',
  );
  // The other four conditions travel the same channel; if any moves, this test should know.
  for (const phrase of ['root/sudo is OFF', 'command timed out', 'output capped']) {
    assert.ok(shellMod.includes(phrase), `the daemon should still report: ${phrase}`);
  }
});

test('layer 2 — the client parser turns the ERR marker into marks.err', () => {
  assert.match(
    app,
    /k==='ERR'\)o\.err=/,
    'BridgeClient must keep parsing ERR into .err (and keep appending, not overwriting)',
  );
});

test('layer 3 — iT renders marks.err instead of swallowing it', () => {
  const m = itPanel.match(/async function run\(t,cmd\)\{[\s\S]*?\n {4}\}/);
  assert.ok(m, 'run(t,cmd) not found in web/panels/shell.js');
  const run = m[0];
  assert.match(
    run,
    /marks\.err/,
    'iT drops every refusal, timeout and truncation notice unless run() reads marks.err',
  );
  // It is machine-supplied text (it carries the child's own error message), so it must be
  // escaped — appendOut takes HTML, unlike CODE's accumulator which is escaped at paint.
  assert.match(
    run,
    /marks\.err[\s\S]{0,80}?escHtml|escHtml\([^)]*marks\.err/,
    'marks.err must be escaped before it reaches appendOut',
  );
});

test('parity — both shells surface it, so neither can regress alone', () => {
  assert.match(codePanel, /marks\.err/, 'CODE must keep rendering marks.err');
  assert.match(itPanel, /marks\.err/, 'iT must render marks.err');
});

test('the refusal is not downgraded to a dim aside', () => {
  const run = itPanel.match(/async function run\(t,cmd\)\{[\s\S]*?\n {4}\}/)[0];
  const line = run.split('\n').find((l) => l.includes('marks.err'));
  assert.ok(line, 'expected a line rendering marks.err');
  assert.doesNotMatch(
    line,
    /class="dim"/,
    'a blocked rm -rf is not a hint — it must not render in the muted style used for asides',
  );
});
