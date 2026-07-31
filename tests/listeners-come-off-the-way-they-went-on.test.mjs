// Pan the dock rail once and clicking stopped working. Everywhere.
//
// The rail's pan gesture registered its window-level pointerup in the CAPTURE phase and took
// it off in the BUBBLE phase:
//
//     addEventListener('pointerup', mu, {capture:true});     // on
//     removeEventListener('pointerup', mu);                  // off — and it never matched
//
// removeEventListener matches on (type, handler, capture). A flag mismatch is not an error;
// it is a silent no-op. So every rail pointerdown installed one more PERMANENT capturing
// window-level pointerup handler, and each one that had engaged still ran its last two lines:
//
//     if(engaged){ev.preventDefault();ev.stopPropagation()}   // "a pan is not a click"
//
// stopPropagation in the capture phase, on window, kills the event before it reaches anything.
// After one completed pan, every later pointerup in the whole app was swallowed by a dead
// closure that thought it was still panning: buttons, chips, menus, the composer — nothing
// responded, with no error in the console and no way to recover but a reload.
//
// It needed the rail to actually overflow first (~16 docked chips at the default unit), which
// is why it survived every earlier dock sweep: the bug only exists once the dock is full.
//
// The fix is not "pass the flag to both" — that is the same trap one edit away. Both listeners
// now hang off ONE AbortController, so add and remove cannot disagree about anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const FILES = ['web/index.html', ...readdirSync(path.join(ROOT, 'web', 'panels')).filter((f) => f.endsWith('.js')).map((f) => 'web/panels/' + f)];

test('the dock rail pan cannot leak a listener — both hang off one AbortController', () => {
  const src = decomment(read('web/index.html'));
  const pan = src.match(/rail\.addEventListener\('pointerdown',e=>\{[\s\S]*?\n {4}\}\);/);
  assert.ok(pan, 'the rail pan handler must still exist');
  assert.match(pan[0], /new AbortController\(\)/,
    'add and remove must not be able to disagree about the capture flag — use one signal');
  assert.match(pan[0], /addEventListener\('pointerup',mu,\{capture:true,signal:/,
    'the pointerup must still be a capture listener (a pan is not a click) AND carry the signal');
  assert.doesNotMatch(pan[0], /removeEventListener\('pointerup',mu\)/,
    'the flagless removal is the defect itself');
});

// The general rule, so the next one is caught wherever it is written.
//
// Scoped by PROXIMITY, not by file. `mu` and `mm` are the house names for a drag's pointerup
// and pointermove, and index.html has six independent closures using them; the first draft of
// this test compared them file-wide and reported three healthy ones as broken. A gesture's add
// and remove always sit in the same small closure, so a window either side of the capture-add
// is the right neighbourhood to search — and a false alarm here would cost more than the bug.
const NEAR = 1400;

test('no listener in the app is added with capture and removed without it', () => {
  const offenders = [];
  for (const rel of FILES) {
    const src = decomment(read(rel));
    for (const add of src.matchAll(/addEventListener\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*,\s*(?:true|\{[^}]*capture\s*:\s*true[^}]*\})\s*\)/g)) {
      const [, type, handler] = add;
      const from = Math.max(0, add.index - NEAR);
      const near = src.slice(from, add.index + NEAR);
      const flagless = new RegExp(`removeEventListener\\(\\s*['"]${type}['"]\\s*,\\s*${handler}\\s*\\)`, 'g');
      for (const m of near.matchAll(flagless)) {
        offenders.push(`${rel}:${src.slice(0, from + m.index).split('\n').length}  ${type}/${handler}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'removeEventListener matches on (type, handler, capture). Dropping the flag removes nothing,\n' +
    'silently, and the listener stays for the life of the document:\n  ' + offenders.join('\n  '));
});
