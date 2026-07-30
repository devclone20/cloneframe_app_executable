// NOTES bulk-delete iterates the selection Set, not what is on screen.
//
//   selbar #ntbdel → for (const id of [...sel]) await RPC('notes','remove', id)
//
// Two handlers cleared `sel` when the visible set changed — the archive toggle (L91) and the
// select-mode toggle (L93). The search box did not:
//
//   search.addEventListener('input', () => { clearTimeout(search._t);
//                                            search._t = setTimeout(load, 250) })
//
// so: enter select mode → Select all → type a word that matches one note → Delete.
// Everything selected before the search is gone. No confirmation, no undo, no trash.
//
// Measured live in the app before the fix, with three decoy notes alongside the owner's three:
//   after Select all      → bar: "6 Selected"
//   after typing UNIQUEWORD → rows on screen: 1, bar STILL: "6 Selected"
// The delete was not executed — the state is the proof, and running it would have destroyed
// the owner's real notes.
//
// The fix prunes in load() rather than clearing in each handler, because "one clear per
// filter" is exactly the shape that let the search box be forgotten. The invariant is
// stated once, where `view` is computed: the selection may never hold a note the owner
// cannot see.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(APP, 'web/panels/notes.js'), 'utf8');

test('the selection is pruned to the visible set every time the view is computed', () => {
  const load = src.match(/async function load\(\)\{[\s\S]*?\n {6}paintBar\(\);/)[0];
  assert.match(load, /const vis=new Set\(view\.map\(n=>n\.id\)\)/,
    'the prune must key off `view`, the thing actually rendered');
  assert.match(load, /\[\.\.\.sel\]\.forEach\(id=>\{if\(!vis\.has\(id\)\)sel\.delete\(id\)\}\)/);
  // and it must run BEFORE the bar is painted, or the count would lie for one frame
  assert.ok(load.indexOf('vis.has(id)') < load.indexOf('paintBar()'),
    'prune before paintBar, so the count on screen is never stale');
});

test('bulk delete still iterates the selection — the prune is what makes that safe', () => {
  // The CONTRACT, not the call form: this test first pinned the exact
  // `await RPC('notes','remove',id)` expression and went red the moment that call was routed
  // through act(). A test that fails on a correct change is defending the wrong thing.
  assert.match(src, /for\(const id of \[\.\.\.sel\]\)/,
    'if this ever iterates `view` instead, the prune above is redundant, not wrong');
  assert.match(src, /\('notes','remove',id\)/, 'and it is still notes.remove that runs');
});

test('the search box is reachable while selecting — this is why it mattered', () => {
  // The chips are hidden in select mode (chips.style.display=selMode?'none':'flex'), so the
  // search box was the ONE filter the owner could still change mid-selection. Verified live.
  assert.match(src, /chips\.style\.display=selMode\?'none':'flex'/);
  assert.doesNotMatch(src, /search\.style\.display=selMode/,
    'if the search box is ever hidden in select mode too, revisit this test, not the fix');
});

test('the two handlers that already cleared still do — belt and braces', () => {
  assert.match(src, /archBtn\.addEventListener\('click',\(\)=>\{[^}]*sel\.clear\(\)/);
  assert.match(src, /selBtn\.addEventListener\('click',\(\)=>\{selMode=!selMode;sel\.clear\(\)/);
});

test('the built document carries it', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  const d = fs.readFileSync(dist, 'utf8');
  assert.ok(d.includes('const vis=new Set(view.map(n=>n.id))'), 'dist is stale — rebuild');
});
