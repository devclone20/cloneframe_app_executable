// Ten panels gate their entire mount on Bridge.on() and return early, showing a "Needs the
// HUB Bridge" card. Nothing listened for the bridge arriving — so a newcomer who opened
// NOTES first, then paired, watched TASKS and EMAIL come alive while NOTES, REMINDERS,
// CONTACTS, CALENDAR, COMPARE, INTEGRATIONS, LIBRARY, SEARCH, APPROVAL and HARNESS stayed on
// that card forever. The only way out was to close the window and open it again, and nothing
// on screen said so. That is the first five minutes of the app for anyone who has not paired
// yet, which is everyone, once.
//
// The recovery lives in needBridge itself rather than in ten files, so every caller inherits
// it and so does every panel written afterwards. Verified in the running app: all ten opened
// unpaired, one bridge:changed, all ten re-mounted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const app = read('web/index.html');
const dist = fs.existsSync(path.join(HERE, '..', 'dist', 'index.html')) ? read('dist/index.html') : '';
const fn = app.slice(app.indexOf('function needBridge(el){'), app.indexOf('function showErr('));

test('needBridge registers the recovery itself', () => {
  assert.ok(fn.length > 200, 'could not isolate needBridge — this test needs updating');
  assert.match(fn, /panelBus\(p\)\.on\('bridge:changed'/, 'needBridge must subscribe to the bridge arriving');
  assert.match(fn, /REG\.get\(p\.dataset\.type\)/, 'recovery must re-run the panel own registered mount');
  assert.match(fn, /spec\.mount\(p\)/, 'the mount must actually be called');
});

test('it subscribes exactly once per window', () => {
  // A card can be drawn more than once in a window's life; each redraw must not add another
  // subscriber, or a single reconnect would mount the panel several times over.
  assert.match(fn, /if\(!p\|\|p\._nbWatch\)return;/, 'a second card in the same window must not subscribe again');
  assert.match(fn, /p\._nbWatch=true;/, 'the guard flag must be set');
});

test('it never re-mounts a panel that already recovered on its own', () => {
  // TASKS and EMAIL subscribe to the same event themselves — and TASKS subscribes BEFORE the
  // card is drawn, so its handler always runs first and replaces the card. Re-mounting after
  // that would stack its listeners and its timers.
  assert.match(fn, /if\(!p\.querySelector\('\[data-needbridge\]'\)\)return;/,
    'recovery must check the card is still on screen before mounting');
  assert.match(app, /data-needbridge/, 'the card must carry the marker the check looks for');
});

test('it does nothing when the bridge is not actually up', () => {
  assert.match(fn, /if\(!Bridge\.on\(\)\|\|!p\.isConnected\)return;/,
    'a disconnect event, or a closed window, must not trigger a mount');
});

test('every bridge-gated panel goes through needBridge', () => {
  // The recovery is inherited by calling needBridge. A panel that hand-rolls its own empty
  // state gets nothing, which is exactly how these ten came to be stranded.
  const gated = ['notes', 'reminders', 'approval', 'search', 'harness'];
  for (const name of gated) {
    const src = read('web/panels/' + name + '.js');
    assert.match(src, /needBridge\(/, name + '.js gates on the bridge without using needBridge — it will strand');
  }
});

test('the shipped artifact carries it', () => {
  if (!dist) return;
  assert.ok(dist.includes("panelBus(p).on('bridge:changed'"), 'dist/index.html has no recovery in needBridge');
  assert.ok(dist.includes('data-needbridge'), 'dist/index.html is missing the card marker');
});
