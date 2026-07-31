// Two panels read a name nobody publishes, so two features were dead and neither said so.
//
// 1 · MATRIX rendered every finished answer as escaped plain text.
//
//     const body = m.done ? (window.MDLite ? MDLite.render(m.content) : escHtml(m.content)) : …
//
//     MDLite is `const MDLite = (function(){…})()` at the TOP LEVEL of a classic script
//     (web/index.html:3002). A top-level const in a classic script lives in the global
//     LEXICAL environment and is NOT a property of window — and nothing anywhere assigns
//     window.MDLite. So the guard was false forever and the ternary always took escHtml.
//     LAB, CODE and BRAIN call the bare `MDLite` and render markdown correctly; MATRIX
//     alone asked for it through window and therefore never reached the renderer it wanted.
//     matrix.js:934 even repaints once at the end "for the markdown pass" — into escHtml.
//
// 2 · SETTINGS' search box never showed a single cross-module hit.
//
//     (r && r.groups || []).forEach(g => { (g.items || []).slice(0,4) … })
//
//     bridge/search.mjs documents and returns {groups:[{module, label, results:[…]}]}. The
//     key is `results`. `g.items` is always undefined, `(undefined||[])` is always [], and
//     the whole thing sits inside `catch(_){}` so there was never an error to notice.
//     web/panels/search.js — the other reader of the same payload — reads `g.results`.
//
// Same shape both times: two readers of one producer, and the one that was wrong failed
// SILENTLY, because `undefined || []` and `window.X ? … : fallback` are both designed not
// to complain. This file pins the names against the producers that publish them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('nobody reaches for MDLite through window — it was never put there', () => {
  const index = read('web/index.html');
  // The producer: a top-level const in the classic script, not a window property.
  assert.match(index, /^const MDLite=/m, 'MDLite must still be a top-level const in the classic script');
  assert.doesNotMatch(index, /window\.MDLite\s*=/, 'if it is ever published on window, revisit this test');
  assert.equal((read('web/scripts/core/kernel.js').match(/\bMDLite\b/g) || []).length, 0,
    'MDLite is not a kernel helper — it is declared in index.html, already in the panels’ scope');

  for (const f of ['matrix.js', 'lab.js', 'terminal.js', 'brain.js']) {
    const src = decomment(read('web/panels/' + f));
    assert.doesNotMatch(src, /window\.MDLite/,
      f + ' guards on window.MDLite, which is undefined forever — the markdown branch is dead');
  }
});

test('MATRIX renders a finished answer through the same renderer as LAB, CODE and BRAIN', () => {
  const mx = decomment(read('web/panels/matrix.js'));
  assert.match(mx, /m\.done\?MDLite\.render\(m\.content\)/,
    'a finished MATRIX answer must go through MDLite, like every other chat surface');
});

test('every reader of search.query reads the key search.mjs actually returns', () => {
  const bridge = read('bridge/search.mjs');
  // The producer, stated in its own contract line and in the code.
  assert.match(bridge, /groups:\[\{module, label, results:/, 'the documented shape must still name `results`');

  for (const f of ['search.js', 'settings.js']) {
    const src = decomment(read('web/panels/' + f));
    if (!/RPC\('search','query'/.test(src)) continue;
    assert.doesNotMatch(src, /g\.items/,
      f + ' reads g.items; search.mjs returns g.results, so this list is always empty');
    assert.match(src, /g\.results/, f + ' must read the published key');
  }
});
