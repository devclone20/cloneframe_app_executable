// The daemon reports a refusal as {ok:false, error} and does NOT throw. Measured directly
// against the real modules:
//
//   reminders.create({})          {"ok":false,"error":"create: note is required"}
//   reminders.markDone('nope')    {"ok":false,"error":"markDone: reminder not found"}
//   notes.remove('nope')          {"ok":false,"error":"remove: note not found"}
//   notes.update('nope',{})       {"ok":false,"error":"update: note not found"}
//   tasks.setState('nope','paused') {"ok":false,"error":"not found"}
//   tasks.remove('nope')          {"ok":false,"error":"not found"}
//   tasks.runNow('nope')          {"ok":false,"error":"not found"}
//
// Seven good human sentences the owner never saw. The panels wrote
//
//   await RPC('notes','remove', id); Toast.show('Deleted');
//
// so a refusal reloaded the list unchanged under the word "Deleted". The try/catch wrapped
// around several of these never fired, because nothing throws — which is worse than no
// try/catch, since it reads like handling.
//
// TASKS was the loudest: RUN said "run: ok" on a task that had not run, because the default
// in `(r.run && r.run.status) || 'ok'` filled in for the missing answer.
//
// One helper rather than a check at each of the fifteen sites. Per-site checking is exactly
// what let the search box be the one place NOTES forgot (see notes-selection-visible), and
// the next call site added would forget again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
// Line comments FIRST — a prose line containing `/*` would otherwise open a block comment and
// swallow real code to the next `*/`. And a comment that QUOTES the old code (as the ones next
// to these fixes do, deliberately) would otherwise make a doesNotMatch assertion fail forever.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const app = read('web/index.html');

test('act() exists once, next to the other shared failure renderers', () => {
  const fn = app.match(/async function act\(mod,fn,\.\.\.args\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(fn, /if\(r&&r\.ok===false\)/, 'the refusal shape is the whole point');
  assert.match(fn, /Toast\.show\(friendlyErr\(r\.error/, 'and it must reach the owner in words');
  assert.match(fn, /return null/, 'so callers can stop with a single check');
  assert.match(fn, /catch\(e\)\{Toast\.show\(friendlyErr\(/, 'a thrown failure is still a failure');
  assert.match(fn, /return r===undefined\?\{ok:true\}:r/,
    'a module that returns nothing on success must not read as a refusal');
  assert.equal((app.match(/async function act\(mod,fn/g) || []).length, 1, 'exactly one definition');
});

test('every mutating call in the three panels goes through it', () => {
  const MUTATORS = /(remove|update|create|setState|runNow|markDone|snooze|pauseAll)/;
  for (const p of ['notes', 'tasks', 'reminders']) {
    const src = read('web/panels/' + p + '.js');
    for (const line of src.split('\n')) {
      const m = line.match(/await RPC\('(\w+)','(\w+)'/g) || [];
      for (const call of m) {
        const fn = call.match(/,'(\w+)'/)[1];
        if (!MUTATORS.test(fn)) continue;
        // allowed only when the very same line captures the answer, so the next lines can
        // check r.ok — a bare `await RPC('notes','remove',id)` has thrown the answer away
        assert.ok(/\bconst r=|\blet r\b/.test(line),
          p + '.js still fires a bare mutating RPC (' + fn + '): ' + line.trim().slice(0, 90));
      }
    }
  }
});

test('bulk actions report what actually happened, not what was attempted', () => {
  const notes = read('web/panels/notes.js');
  const tasks = read('web/panels/tasks.js');
  // "Deleted" over four of six is its own lie
  assert.match(notes, /Toast\.show\(gone===want\?'Deleted':\('Deleted '\+gone\+' of '\+want\)\)/);
  assert.match(notes, /Toast\.show\(done===want\?word:\(word\+' '\+done\+' of '\+want\)\)/);
  assert.match(tasks, /Toast\.show\(done===want\?\('Selected '\+word\):\(done\+' of '\+want\+' '\+word\)\)/);
  assert.match(tasks, /gone===want\?'Deleted \(built-ins kept\)'/);
});

test('RUN no longer defaults a missing answer to "ok"', () => {
  const tasks = decomment(read('web/panels/tasks.js'));
  assert.doesNotMatch(tasks, /\(r\.run&&r\.run\.status\)\|\|'ok'/,
    "'ok' as the fallback is how a task that did not run reported success");
  assert.match(tasks, /const r=await act\('tasks','runNow'.*\);if\(r\)Toast\.show/,
    'no result, no claim');
});

test('read-only calls are left alone — their failures belong to showErr', () => {
  const reminders = read('web/panels/reminders.js');
  assert.match(reminders, /items=await RPC\('reminders','list'/, 'list must stay a plain RPC');
  assert.match(reminders, /catch\(e\)\{showErr\(body,e\);return\}/,
    'and keep rendering through the shared error state');
});

test('the built document carries act()', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  assert.ok(fs.readFileSync(dist, 'utf8').includes('async function act(mod,fn,...args)'),
    'dist is stale — rebuild');
});
