// CODE quietly threw away the model you chose, and wrote the loss to disk.
//
// syncPickers() drops a session's model when that model is no longer in the registry — right,
// and deliberate: a MATRIX weight you deleted must not stay selected while requests keep going
// to a dead id. The guard on it was
//
//     if (provsLoaded && cur && cur.model && cur.model.includes('::') && !models.some(…))
//         { cur.model=''; saveSt(); }
//
// Two representations of one question. `provsLoaded` answers "has the registry EVER answered"
// — set true on the first success and never set back. `models` answers "what do we know RIGHT
// NOW" — and loadModels() used to EMPTY it at the top and refill it after two awaits.
//
// So for the length of two round trips, the panel's answer to "which models exist" was "only
// the machine", while the flag guarding against exactly that still said "we know the list".
// Anything calling syncPickers() in that window — loadHarnesses() finishing first, or a
// bridge:changed event — found the session's model missing from a list that was merely
// half-built, cleared it, and PERSISTED the clear. The owner's picked model became "machine"
// and stayed there across reloads, with no message.
//
// The fix is not a third flag. The list is built into a local and published in one assignment,
// so "half-built" stops being a state the rest of the panel can observe. This test pins that
// shape, and pins the deliberate behaviour it must not break.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'web/panels/terminal.js'), 'utf8');
const loadModels = src.match(/async function loadModels\(\)\{[\s\S]*?\n {4}\}/)[0];

test('the model list is never observably half-built', () => {
  assert.doesNotMatch(loadModels, /^\s*models=\[\{v:''/m,
    'emptying `models` at the top is the defect — anything that runs during the awaits sees a list of one');
  assert.match(loadModels, /const next=\[\{v:''/,
    'build into a local');
  assert.match(loadModels, /\n\s*models=next;/,
    'and publish it in ONE assignment, after every await has landed');
  // Nothing may push into the live list while it is being rebuilt.
  assert.doesNotMatch(loadModels, /models\.push\(/,
    'a push into the live list during the rebuild reopens the same window');
});

test('the deliberate part still stands: a model that really is gone is still dropped', () => {
  // This is not a bug — it is why the guard exists. A MATRIX weight the owner deleted must not
  // stay selected while the request goes to a dead id and returns "bridge http 404".
  assert.match(src, /if\(provsLoaded&&cur&&cur\.model&&cur\.model\.includes\('::'\)&&!models\.some\(m=>m\.v===cur\.model\)\)\{cur\.model='';saveSt\(\)\}/,
    'the drop-a-dead-model rule must survive the fix');
});

test('a failed probe is still not an answer', () => {
  // The neighbouring lesson, already learnt once and pinned here so the rebuild did not undo it:
  // provsLoaded is only set inside the success path, so a registry that never answered cannot
  // be mistaken for a registry that answered "nothing".
  const providers = loadModels.match(/try\{const provs=await RPC\('models','listProviders'\)[\s\S]*?catch\(_\)\{\}/)[0];
  assert.match(providers, /provsLoaded=true\}catch\(_\)\{\}/,
    'provsLoaded must be set on success only — never in the catch');
});
