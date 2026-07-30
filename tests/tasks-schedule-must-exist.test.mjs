// A schedule with no run date is not a schedule.
//
// parseCron only checks the SHAPE. `0 0 30 2 *` — 30 February — parses fine, describes a date
// that does not exist, and was accepted: the task stored nextRunAt:null, rendered as ACTIVE in
// TASKS and RUNNING in AUTOMATIONS, and never fired. No error, no run-log entry, no warning.
// The owner would find out by noticing, months later, that something never happened.
//
// Worse, and this is what the search turned up rather than the original report: the same null
// came back for `0 0 29 2 *` — 29 February, a perfectly LEGITIMATE schedule — because the
// search window was one year and the next leap day can be up to four years out. Measured from
// 2026-07-30, before the change:
//
//   0 9 * * *     → Fri Jul 31 2026 09:00:00   (3 ms)
//   0 0 29 2 *    → null                      (61 ms)   ← legitimate, and dead
//   0 0 30 2 *    → null                      (58 ms)
//   0 0 31 4 *    → null                      (56 ms)
//
// So the fix is two-sided: widen the window so real leap-day schedules resolve, and refuse
// the ones that genuinely never come round — refusing before widening would have rejected a
// valid cron with a confident error message, which is worse than the original bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { nextRun, parseCron } from '../bridge/tasks.mjs';

const APP = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(APP, 'bridge/tasks.mjs'), 'utf8');

test('a legitimate leap-day cron resolves', () => {
  // from a fixed non-leap date, so this test does not change meaning with the calendar
  const from = new Date('2026-07-30T12:00:00Z');
  const n = nextRun('0 0 29 2 *', from);
  assert.ok(n, '29 February must be schedulable');
  assert.equal(n.getMonth(), 1, 'February');
  assert.equal(n.getDate(), 29, 'the 29th');
  assert.ok(n.getFullYear() % 4 === 0, 'and a leap year: ' + n.getFullYear());
});

test('an ordinary cron is unaffected and still cheap', () => {
  const from = new Date('2026-07-30T12:00:00Z');
  const t0 = Date.now();
  const n = nextRun('0 9 * * *', from);
  assert.ok(n && n.getHours() === 9);
  assert.ok(Date.now() - t0 < 200, 'the common case must not pay for the widened window');
});

test('a date that never arrives still returns null', () => {
  const from = new Date('2026-07-30T12:00:00Z');
  for (const c of ['0 0 30 2 *', '0 0 31 2 *', '0 0 31 4 *', '0 0 31 6 *', '0 0 31 9 *', '0 0 31 11 *']) {
    assert.equal(nextRun(c, from), null, c + ' describes a date that does not exist');
  }
});

test('the window covers a full leap cycle', () => {
  assert.match(src, /const CAP = 1462 \* 24 \* 60 \+ 1/, '1462 days = 4 years');
  assert.doesNotMatch(src, /const CAP = 366 \* 24 \* 60 \+ 1/, 'the one-year window killed 29 Feb');
});

test('add() refuses a schedule that never comes round', () => {
  const add = src.match(/export function add\(\{[\s\S]*?\n\}/)[0];
  assert.match(add, /if \(!nextRun\(cron\)\)/, 'shape is not enough — it must have a run date');
  assert.match(add, /never comes round/, 'and say so in words the owner can act on');
  // the shape check must still run first, so a malformed cron keeps its specific message
  assert.ok(add.indexOf('parseCron(cron)') < add.indexOf('!nextRun(cron)'),
    'a syntax error deserves the syntax message, not the calendar one');
});

test('update() refuses it too — editing a live task must not retire it in silence', () => {
  const upd = src.match(/export function update\(id, patch = \{\}\)[\s\S]*?\n\}/)[0];
  assert.match(upd, /if \(!nextRun\(patch\.cron\)\)/);
  assert.match(upd, /never comes round/);
});

test('parseCron still accepts the shape — the two checks are separate concerns', () => {
  assert.doesNotThrow(() => parseCron('0 0 30 2 *'), 'shape is valid; the calendar is not');
  assert.throws(() => parseCron('not a cron'), 'a malformed expression is a different failure');
});
