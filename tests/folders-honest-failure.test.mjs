// FOLDERS told the owner a permissions story about a folder the app had never asked for.
//
//   async function ls(dir){ const r = await RPC('files','list',dir).catch(()=>null);
//                           if(!r||!r.ok) return {ok:false, err:(r&&r.error)||'cannot read', …} }
//
// `.catch(()=>null)` threw away WHY. So every failure — including "there is no daemon", or
// "this window is not paired" — arrived at the caller as the same shrug, and the caller then
// guessed:
//
//   cannot read
//   This folder may be protected or unreadable.
//
// Measured in the unpaired sweep: with Bridge.disconnect(), FOLDERS opened and said exactly
// that. It is the only panel in the twenty that answered a transport failure with a
// filesystem explanation, and the static audit showed why — it had no needBridge guard and no
// showErr call at all, while NOTES, TASKS, REMINDERS, APPROVAL, SEARCH and BRAIN all had both.
//
// The fix keeps the folder sentence for a folder the daemon really looked at and refused, and
// routes a transport failure to showErr(), which already distinguishes "no daemon" from "not
// paired" and offers the way to MY MACHINE.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(APP, 'web/panels/folders.js'), 'utf8');

test('ls() keeps the reason instead of swallowing it', () => {
  const fn = src.match(/async function ls\(dir\)\{[\s\S]*?\n {4}\}/)[0];
  assert.doesNotMatch(fn, /RPC\('files','list',dir\)\.catch\(\(\)=>null\)/,
    'that catch is what erased the difference between a folder and a daemon');
  assert.match(fn, /catch\(e\)\{return\{ok:false,transport:e/,
    'a transport failure must be labelled as one');
  assert.match(fn, /if\(!r\|\|!r\.ok\)return\{ok:false,err:\(r&&r\.error\)\|\|'cannot read'/,
    'a real {ok:false} from the daemon is still a folder-level failure');
});

test('a transport failure goes to the shared renderer', () => {
  assert.match(src, /if\(!r\.ok&&r\.transport\)\{showErr\(areaEl,r\.transport\);return\}/,
    'showErr already knows how to say it and where to send him');
  // and it must come FIRST, or the guess wins
  const list = src.match(/async function renderList\(\)\{[\s\S]*?protected or unreadable[^\n]*\n/)[0];
  assert.ok(list.indexOf('r.transport') < list.indexOf('protected or unreadable'),
    'the transport branch must be checked before the folder sentence');
});

test('the folder sentence survives for the case it is actually about', () => {
  assert.match(src, /This folder may be protected or unreadable/,
    'a folder the daemon looked at and refused still deserves this');
});

test('FOLDERS now uses the shared failure surface at all', () => {
  // The static audit across all 20 panels: folders had needBridge:0 showErr:0, alone among
  // the panels that read from the daemon.
  assert.ok((src.match(/showErr\(/g) || []).length >= 1, 'it had none before');
});

test('the built document carries it', () => {
  const dist = path.join(APP, 'dist/index.html');
  if (!fs.existsSync(dist)) return;
  assert.ok(fs.readFileSync(dist, 'utf8').includes('if(!r.ok&&r.transport){showErr(areaEl,r.transport);return}'),
    'dist is stale — rebuild');
});
