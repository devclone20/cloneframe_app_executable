// The agent's `web_navigate` advertises four things as one control:
//
//     web_navigate{url} | {dir:'back'|'forward'|'reload'}
//
// Three of the four resolved the tab one way and the fourth resolved it another.
//
//     navigate()      (id != null ? _tab(id) : _primaryTab())   ← and says so in a comment:
//                                                                 "id omitted → the on-screen tab"
//     _historyStep()  (id != null ? _tab(id) : _primaryTab())   ← back and forward
//     reload()        _tab(id)                                  ← no fallback
//
// So `web_navigate{dir:'reload'}` with no id answered {"ok":false,"error":"no such tab"} while
// its two siblings worked. Found by `pi` during Project B of the forge: it reloaded a page it
// had just navigated to and was told the tab did not exist.
//
// Two things were wrong. The behaviour, and the words: "no such tab" to a caller that named no
// tab reads as "your tab is gone" rather than "I need an id", which is why the agent went
// looking for a dead tab instead of passing one.
//
// The panel always passes {id: t.eid} (web/panels/browser.js — Reload button, ⌘R, the tab menu),
// so this changes nothing on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const eng = fs.readFileSync(path.join(APP, 'bridge/webengine.mjs'), 'utf8');
const ext = fs.readFileSync(path.join(APP, 'agent/.pi/extensions/clone-frame.ts'), 'utf8');

const RESOLVE = /\(\s*id\s*!=\s*null\s*\?\s*_tab\(id\)\s*:\s*_primaryTab\(\)\s*\)/;

test('every fn behind web_navigate resolves the tab the same way', () => {
  const navigate = eng.match(/async navigate\(\{[\s\S]*?\n {2}\},/)[0];
  const reload = eng.match(/async reload\(\{[\s\S]*?\n {2}\},/)[0];
  const historyStep = eng.match(/async function _historyStep\([\s\S]*?\n\}/)[0];

  for (const [name, src] of [['navigate', navigate], ['reload', reload], ['_historyStep', historyStep]]) {
    assert.match(src, RESOLVE, `${name} must fall back to the on-screen tab when no id is given`);
  }
  assert.doesNotMatch(reload, /const tab = _tab\(id\);/,
    'reload must not be the one sibling that demands an id');
});

test('back and forward really do route through the shared resolver', () => {
  assert.match(eng, /async back\(\{ id \} = \{\}\) \{ return _historyStep\(id, -1\); \}/);
  assert.match(eng, /async forward\(\{ id \} = \{\}\) \{ return _historyStep\(id, \+1\); \}/);
});

test('"no such tab" is only said to a caller that named one', () => {
  const reload = eng.match(/async reload\(\{[\s\S]*?\n {2}\},/)[0];
  assert.match(reload, /id != null \? 'no such tab' : 'no tab open'/,
    'a caller that named no tab must be told there is no tab open, not that its tab is missing');
});

test('the tool still advertises all four, so the contract is the thing under test', () => {
  assert.match(ext, /web_navigate\{url\} \| \{dir:'back'\|'forward'\|'reload'\}/);
  assert.match(ext, /dir === "back" \|\| dir === "forward" \|\| dir === "reload"/);
});

test('the panel is unaffected — it always names its tab', () => {
  const panel = fs.readFileSync(path.join(APP, 'web/panels/browser.js'), 'utf8');
  const calls = panel.match(/eng\('reload'[^)]*\)/g) || [];
  assert.ok(calls.length >= 3, 'the Reload button, the shortcut and the menu all reload');
  for (const c of calls) assert.match(c, /id:\s*t\.eid/, 'every panel reload passes an explicit id');
});

// ── the same defect, one function over, found the next sweep ─────────────────────────────
//
// `input` was the other strict resolver, and `click` and `type` both pass their id straight
// through to it. The agent's tools name no tab:
//
//     web_click{x,y}  → web('click', {x, y})   → input({id: undefined, …})
//     web_type{text}  → web('type',  {text})   → input({id: undefined, …})
//
// `_tab(undefined)` is `S.tabs.get('')`, which is null, so BOTH answered "no such tab" every
// single time, on a browser the agent had just opened and could read. `web_click{ref}` worked
// (clickRef resolves like navigate), which is what made it look intermittent rather than broken.

test('typing and clicking resolve the tab like navigating does', () => {
  const input = eng.match(/async input\(\{[\s\S]*?\n {2}\},/)[0];
  assert.match(input, RESOLVE,
    'input must fall back to the on-screen tab — web_click{x,y} and web_type{text} name none');
  assert.match(input, /id != null \? 'no such tab' : 'no tab open'/,
    'and it must not tell a caller that named no tab that its tab is missing');
});

test('the agent tools that drive input still name no tab, which is why input must default', () => {
  assert.match(ext, /await web\("click", \{ x: params\.x, y: params\.y \}\)/);
  assert.match(ext, /await web\("type", \{ text: params\.text \}\)/);
});

test('per-tab plumbing stays strict on purpose — this is not a blanket rule', () => {
  // frame/castStart/castStop/setViewport are the panel's own per-tab machinery and it always
  // passes an id. Defaulting them would hand back ANOTHER tab's pixels or resize the wrong
  // page, which is worse than an error. Pinned so nobody "finishes the job" later.
  for (const fn of ['castStart', 'castStop', 'setViewport']) {
    const src = eng.match(new RegExp('async ' + fn + '\\(\\{[\\s\\S]*?\\n {2}\\},'))[0];
    assert.match(src, /const tab = _tab\(id\);/, fn + ' is per-tab plumbing and must stay strict');
  }
  assert.match(eng.match(/frame\(\{ id, since = 0 \} = \{\}\) \{[\s\S]*?\n {2}\},/)[0],
    /const tab = _tab\(id\);/, 'frame must stay strict — a default would return another tab’s pixels');
});
