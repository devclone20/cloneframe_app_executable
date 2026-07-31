// Three pieces of state kept referring to a window that was already gone.
//
// 1 · iT lost your layout if you reopened it too quickly.
//     The cross-window ownership lease lives in localStorage with a 9-second life, and NOTHING
//     released it: `p._dispose` did not touch it, and the 3-second heartbeat went on RE-WRITING
//     it for up to one more tick after the window was gone. Reopen inside that window and the
//     new iT found a lease it did not own, demoted itself to live-only, and restored no
//     workspaces. A reload read as "my layout is gone".
//
// 2 · A closed window's frame square adopted the next window of the same type.
//     Keys are recycled — `open[type] ? type+'#'+(++iseq) : type` — so the bare key returns to
//     circulation the moment the first instance closes. A square kept its panelKey for ever,
//     so it hijacked an unrelated new window, and its ✕ closed it. Docking ALSO routes through
//     close(), and there the link is the whole point, so only a real close releases.
//
// 3 · Docking CODE mid-answer let a dead closure overwrite the live one.
//     `st` is per-mount. Dock runs close(p), the streaming turn keeps writing into the orphaned
//     closure, and its final saveSt() overwrote whatever the reopened window had written since.
//     Silencing the orphan is not right either: if nothing else mounts, that last write is how
//     the finished answer survives the dock. So the store has an OWNER — the most recent mount —
//     and the orphan writes until someone takes over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

test('iT hands its ownership lease back when the window closes', () => {
  const sh = decomment(read('web/panels/shell.js'));
  assert.match(sh, /const itRelease=\(\)=>\{/, 'there must be one place that releases it');
  assert.match(sh, /localStorage\.removeItem\(IT_OWNER\)/, 'and it must actually clear the lease');
  assert.match(sh, /if\(o&&o\.id===itSelf\)/,
    'only if we still hold it — clearing another window’s lease is the same bug pointed the other way');
  assert.match(sh, /p\._dispose=\(\)=>\{itRelease\(\);/,
    'dispose must release it FIRST, before the teardown that can throw');
  assert.match(sh, /if\(itHb\)\{clearInterval\(itHb\);itHb=null\}/,
    'and stop the heartbeat immediately, not on its next tick up to 3s later');
});

test('a real close releases the squares that pointed at that window; docking does not', () => {
  const idx = decomment(read('web/index.html'));
  const close = idx.match(/function close\(p\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(close, /if\(!p\.dataset\.docking&&p\.dataset\.key/,
    'docking routes through close() too, and there the link is the entire point');
  assert.match(close, /Grid\.linkPanel\(c,null\)/, 'release through the one accessor, not by hand');
  assert.match(close, /CSS\.escape\(k\)/, 'a key contains a # — it must be escaped in a selector');
  // linkPanel(el,null) must still be the documented way to unlink.
  assert.match(idx, /else\{delete el\.dataset\.panelKey;if\(rec\)delete rec\.panelKey\}/,
    'Grid.linkPanel(el,null) is the unlink and must stay that way');
});

test('the CODE session store has exactly one owner, and it is the newest mount', () => {
  const t = decomment(read('web/panels/terminal.js'));
  assert.match(t, /\n {2}let codeMountSeq=0;/,
    'the counter must live OUTSIDE wireTerminal — it exists to survive a close and reopen');
  assert.match(t, /codeMountSeq\+\+; const myMount=codeMountSeq;/, 'every mount takes the next number');
  assert.match(t, /const saveSt=\(\)=>\{ if\(myMount!==codeMountSeq\)return; stCell\.set\(st\) \};/,
    'and a write from an older mount must be dropped, not applied');
  // The orphan must NOT be silenced outright — that would lose the answer the dock was meant to keep.
  assert.doesNotMatch(t, /p\._dispose[\s\S]{0,200}codeMountSeq\+\+/,
    'bumping the counter on dispose would silence an orphan that nobody replaced');
});
