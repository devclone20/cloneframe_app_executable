// Docking a multi-window panel (iT, BROWSER) does not close it — it HIDES it. The window
// stays alive with its pty sessions and its Chrome tabs, and the only handle back to it is
// the frame square carrying its panelKey.
//
// That key lived on the element and nowhere else, and Grid.build() destroys every element
// and rebuilds it from the stored cell record. So any rebuild — a density change, a layout
// reset, resizing the app by about 32px — quietly cut the last link to a hidden window:
// clicking its square opened a SECOND window, the square's ✕ closed nothing, and the
// original went on holding real resources where nobody could reach it.
//
// The key now rides in the record. These assertions are the shape of that guarantee; the
// behaviour itself was verified in the running app (dock → Grid.build() → the same window
// comes back, and no second one is created).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const app = read('web/index.html');
const harness = read('web/panels/harness.js');
const dist = fs.existsSync(path.join(HERE, '..', 'dist', 'index.html')) ? read('dist/index.html') : '';

test('the live-window handle is persisted with the cell, not only on the element', () => {
  assert.match(app, /if\(meta&&meta\.panelKey\)c\.panelKey=meta\.panelKey/,
    'Grid.occupy must store panelKey in the cell record — the element does not survive a rebuild');
  assert.match(app, /if\(meta&&meta\.panelKey\)el\.dataset\.panelKey=meta\.panelKey/,
    'occupyEl must restore panelKey when the grid is rebuilt from the record');
});

test('docking hands the handle to the record', () => {
  assert.match(app, /if\(MULTI\.has\(type\)\)meta\.panelKey=p\.dataset\.key/,
    'minimizeToCell must put the window key in the meta that reaches Grid.occupy');
});

test('linking a square to a window writes both sides', () => {
  // Every caller that stamped cell.dataset.panelKey by hand was one rebuild from losing
  // that window. One function, both sides, always.
  assert.match(app, /function linkPanel\(el,pk\)\{/, 'Grid must expose a linkPanel that writes element AND record');
  assert.match(app, /dockNew,pickFree,linkPanel,/, 'linkPanel must be exported from Grid');
  assert.match(harness, /Grid\.linkPanel\(d\.cell,p\.dataset\.key\)/,
    'the new-window branch must persist the link instead of stamping the element');
  assert.doesNotMatch(harness, /d\.cell\.dataset\.panelKey=p\.dataset\.key/,
    'a hand-written dataset stamp is back — it will not survive a rebuild');
});

test('an unclaimed hidden window is never left running', () => {
  // The persistence is the fix; this is the guarantee. A docked window nothing points at
  // is closed, which runs its dispose hook and reaps the pty sessions and tabs it held.
  const fn = harness.slice(harness.indexOf("Bus.on('dock:refresh'"), harness.indexOf("Bus.on('dock:refresh'") + 900);
  assert.ok(fn.startsWith("Bus.on('dock:refresh'"), 'there must be a dock:refresh reaper');
  assert.match(fn, /dataset\.docked/, 'the reaper must only consider docked (hidden) windows');
  assert.match(fn, /claimed\.has\(k\)/, 'the reaper must compare against the keys the squares actually carry');
  assert.match(fn, /close\(p\)/, 'an unclaimed hidden window must be closed, not merely forgotten');
  // Never reap a window that is simply on screen.
  assert.match(fn, /if\(!p\|\|!p\.dataset\.docked\|\|!p\.isConnected\)continue/,
    'a visible window must be skipped outright');
});

test('the shipped artifact carries it', () => {
  if (!dist) return;
  for (const needle of ['function linkPanel(el,pk){', 'if(meta&&meta.panelKey)c.panelKey=meta.panelKey',
    'if(meta&&meta.panelKey)el.dataset.panelKey=meta.panelKey']) {
    assert.ok(dist.includes(needle), 'dist/index.html is missing: ' + needle);
  }
});
