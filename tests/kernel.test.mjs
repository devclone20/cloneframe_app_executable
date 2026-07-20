// ─────────────────────────────────────────────────────────────────────────────
// web/core kernel — unit tests (L4 · T-040 / T-041 / T-046). Zero deps (node:test).
// Imports the ES module directly; the browser-exposure block is a no-op under node
// (no window). Covers the escaper security contract, the panelBus leak-prevention,
// and the three shared utils.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, escAttr, relTime, fetchWithTimeout, persisted, makePanelBus, dragGesture, safeMediaUrl, safeImageUrl } from '../web/scripts/core/kernel.js';

// ── escaping (T-041) ─────────────────────────────────────────────────────────
const DQ_XSS = `"><img src=x onerror=alert(1)>`;
const SQ_XSS = `'><img src=x onerror=alert(1)>`;

test('escHtml — escapes & < > only; ampersand first; coerces null/undefined to ""', () => {
  assert.equal(escHtml(`&<>`), '&amp;&lt;&gt;');
  assert.equal(escHtml('&lt;'), '&amp;lt;');                 // & first, no double-escape
  assert.equal(escHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});

test('escAttr — escapes & < > " \' ; safe in BOTH quote styles (closes the single-quote gap)', () => {
  assert.equal(escAttr(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escAttr('&lt;'), '&amp;lt;');                 // & first
  assert.equal(escAttr(null), '');
  assert.equal(escAttr(undefined), '');
});

test('escAttr — a double-quote payload cannot break out of a double-quoted attribute', () => {
  const html = `<div title="${escAttr(DQ_XSS)}"></div>`;
  assert.equal(html, '<div title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></div>');
  assert.equal((html.match(/"/g) || []).length, 2);          // only the two hard-coded delimiters
});

test('escAttr — a single-quote payload cannot break out of a single-quoted attribute', () => {
  const val = escAttr(SQ_XSS);
  assert.ok(!val.includes(`'`), 'the escaped value carries no raw single quote');
  assert.ok(!val.includes('>'), 'the escaped value carries no raw closing angle');
  const html = `<div title='${val}'></div>`;
  assert.equal((html.match(/'/g) || []).length, 2);          // only the two hard-coded delimiters
});

// ── relTime (T-046) ──────────────────────────────────────────────────────────
test('relTime — s/m/h/d/w/y buckets; "" for missing/invalid/future', () => {
  const now = Date.now();
  assert.equal(relTime(now - 5e3), '5s ago');
  assert.equal(relTime(now - 5 * 60e3), '5m ago');
  assert.equal(relTime(now - 5 * 3600e3), '5h ago');
  assert.equal(relTime(now - 3 * 86400e3), '3d ago');
  assert.equal(relTime(now - 2 * 604800e3), '2w ago');
  assert.equal(relTime(now - 2 * 31536000e3), '2y ago');
  assert.equal(relTime(null), '');
  assert.equal(relTime(''), '');
  assert.equal(relTime('not-a-date'), '');
  assert.equal(relTime(now + 60e3), '');                     // future → ''
  assert.equal(relTime(new Date(now - 60e3)), '1m ago');     // accepts a Date
});

// ── fetchWithTimeout (T-046) ─────────────────────────────────────────────────
test('fetchWithTimeout — ms falsy → plain fetch (no timer, opts passed through)', async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u, o) => { seen = { u, o }; return 'RES'; };
  try {
    const r = await fetchWithTimeout('u', { method: 'POST' });          // ms omitted → 0
    assert.equal(r, 'RES');
    assert.equal(seen.u, 'u');
    assert.equal(seen.o.method, 'POST');
    assert.equal(seen.o.signal, undefined);                              // no timer/signal injected
  } finally { globalThis.fetch = realFetch; }
});

test('fetchWithTimeout — aborts after ms; a caller signal also cancels', async () => {
  const realFetch = globalThis.fetch;
  // fetch that rejects when its signal aborts, else hangs
  globalThis.fetch = (u, o) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  try {
    await assert.rejects(fetchWithTimeout('u', {}, 10), /aborted/);      // timer fires
    const ctl = new AbortController();
    const p = fetchWithTimeout('u', { signal: ctl.signal }, 10_000);     // long timer, cancel via caller
    ctl.abort();
    await assert.rejects(p, /aborted/);
  } finally { globalThis.fetch = realFetch; }
});

// ── persisted (T-046) ────────────────────────────────────────────────────────
test('persisted — get returns default when absent/unparseable; set round-trips; clear removes', () => {
  const store = new Map();
  const realLS = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const cell = persisted('k', { a: 1 });
    assert.deepEqual(cell.get(), { a: 1 });                              // absent → default
    cell.set({ a: 2, b: [3] });
    assert.deepEqual(cell.get(), { a: 2, b: [3] });                      // round-trip
    store.set('k', '{bad json');
    assert.deepEqual(cell.get(), { a: 1 });                             // unparseable → default
    cell.clear();
    assert.equal(store.has('k'), false);
    assert.deepEqual(cell.get(), { a: 1 });
  } finally { globalThis.localStorage = realLS; }
});

test('persisted — a throwing localStorage (private mode) degrades to the default, never throws', () => {
  const realLS = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  try {
    const cell = persisted('k', 'DEF');
    assert.equal(cell.get(), 'DEF');
    assert.doesNotThrow(() => cell.set('x'));
    assert.doesNotThrow(() => cell.clear());
  } finally { globalThis.localStorage = realLS; }
});

// ── makePanelBus (T-040) ─────────────────────────────────────────────────────
// A minimal fake Bus (on/off/emit) + a fake document whose containment is toggled.
function fakeBus() {
  const m = {};
  return {
    on: (e, f) => { (m[e] = m[e] || []).push(f); },
    off: (e, f) => { const a = m[e]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } },
    emit: (e, d) => { (m[e] || []).slice().forEach((f) => f(d)); },
    count: (e) => (m[e] || []).length,
  };
}

test('panelBus — a live panel receives events; a detached panel does not', () => {
  const Bus = fakeBus();
  const live = new Set();
  globalThis.document = { body: { contains: (p) => live.has(p) } };
  globalThis.MutationObserver = undefined; // exercise the belt-and-suspenders guard, no observer
  try {
    const panelBus = makePanelBus(Bus);
    const p = { id: 'panel' }; live.add(p);
    let hits = 0;
    panelBus(p).on('x', () => { hits++; });
    Bus.emit('x'); assert.equal(hits, 1);
    live.delete(p);                       // panel detached
    Bus.emit('x'); assert.equal(hits, 1); // guard suppresses the call
  } finally { delete globalThis.document; delete globalThis.MutationObserver; }
});

test('panelBus — a detached panel is auto-unsubscribed by the observer (zero leaked handlers)', () => {
  const Bus = fakeBus();
  const live = new Set();
  let triggerSweep = null;
  globalThis.document = { body: { contains: (p) => live.has(p) } };
  globalThis.MutationObserver = class { constructor(cb) { triggerSweep = cb; } observe() {} disconnect() {} };
  try {
    const panelBus = makePanelBus(Bus);
    const p = { id: 'panel' }; live.add(p);
    panelBus(p).on('x', () => {}).on('y', () => {});
    assert.equal(Bus.count('x'), 1);
    assert.equal(Bus.count('y'), 1);
    live.delete(p);                       // panel removed from DOM
    triggerSweep();                       // observer fires
    assert.equal(Bus.count('x'), 0, 'handler unsubscribed on removal');
    assert.equal(Bus.count('y'), 0, 'all of the panel\'s handlers unsubscribed');
  } finally { delete globalThis.document; delete globalThis.MutationObserver; }
});

// ── URL-scheme guards (T-071) ────────────────────────────────────────────────
test('safeMediaUrl — passes http(s), rewrites ipfs, REJECTS every script-capable scheme', () => {
  assert.equal(safeMediaUrl('https://arweave.net/abc.mp4'), 'https://arweave.net/abc.mp4');
  assert.equal(safeMediaUrl('http://x.io/a'), 'http://x.io/a');
  assert.equal(safeMediaUrl('ipfs://QmHash/anim.html'), 'https://ipfs.io/ipfs/QmHash/anim.html'); // rewritten
  // a signed/presigned query string must survive unchanged (we return the cleaned original, not URL().href)
  assert.equal(safeMediaUrl('https://s3.x/a.mp4?X-Amz-Signature=AbC%2Fd&e=1'), 'https://s3.x/a.mp4?X-Amz-Signature=AbC%2Fd&e=1');
  // the whole point: every script-capable / non-http scheme is rejected → '' (verified via new URL()
  // so the browser's own control-char stripping and case-folding can't smuggle a scheme past it)
  for (const bad of [
    'javascript:alert(1)', 'JavaScript:alert(1)', '  javascript:alert(1)', '\tjavascript:alert(1)',
    'java\tscript:alert(1)', 'java\nscript:alert(1)', 'jav\rascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,iVBOR', // data:image is NOT allowed as a FRAME/media src (renderer would iframe it)
    'vbscript:msgbox(1)', 'blob:https://x/y', 'filesystem:https://x/y',
    '//evil.com/x', 'evil.com/x', '/relative/x',
  ]) assert.equal(safeMediaUrl(bad), '', `must reject: ${JSON.stringify(bad)}`);
});

test('safeImageUrl — like safeMediaUrl but ALSO allows data:image/ (img can\'t execute script)', () => {
  assert.equal(safeImageUrl('https://x.io/a.png'), 'https://x.io/a.png');
  assert.equal(safeImageUrl('ipfs://Qm/x.png'), 'https://ipfs.io/ipfs/Qm/x.png');
  assert.equal(safeImageUrl('data:image/png;base64,iVBOR'), 'data:image/png;base64,iVBOR');
  assert.equal(safeImageUrl('data:image/svg+xml,<svg/>'), 'data:image/svg+xml,<svg/>');
  // still rejects the dangerous ones
  assert.equal(safeImageUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeImageUrl('javascript:alert(1)'), '');
  assert.equal(safeImageUrl('\tdata:text/html,x'), '');
  assert.equal(safeImageUrl(null), '');
  assert.equal(safeImageUrl(undefined), '');
});

// ── dragGesture (T-045) ──────────────────────────────────────────────────────
// A minimal DOM harness: a fake `el`, window pointer listeners, and document with a
// stubbed elementFromPoint + body.appendChild, so the gesture can be driven headless.
function dragHarness(dropTarget) {
  const win = {};
  const listeners = { pointermove: null, pointerup: null };
  const appended = [];
  const g = globalThis;
  const saved = { window: g.window, document: g.document };
  g.window = {
    addEventListener: (e, f) => { listeners[e] = f; },
    removeEventListener: (e) => { listeners[e] = null; },
  };
  g.document = {
    body: { appendChild: (n) => { appended.push(n); n.isConnected = true; } },
    elementFromPoint: () => dropTarget,
  };
  let downHandler = null;
  const el = { addEventListener: (e, f) => { if (e === 'pointerdown') downHandler = f; }, removeEventListener: () => {} };
  return {
    el,
    down: (x, y) => downHandler({ button: 0, clientX: x, clientY: y }),
    move: (x, y) => listeners.pointermove && listeners.pointermove({ clientX: x, clientY: y }),
    up: (x, y) => listeners.pointerup && listeners.pointerup({ clientX: x, clientY: y }),
    listeners, appended,
    restore: () => { g.window = saved.window; g.document = saved.document; },
  };
}

test('dragGesture — no start below threshold; onStart/onMove/onDrop fire once past it', () => {
  const drop = { id: 'tri' };
  const h = dragHarness(drop);
  try {
    const seen = { start: 0, move: 0, drop: null };
    dragGesture(h.el, { threshold: 4, onStart: () => seen.start++, onMove: () => seen.move++, onDrop: (e, d) => { seen.drop = d; } });
    h.down(0, 0);
    h.move(2, 0);                       // below threshold → nothing
    assert.equal(seen.start, 0);
    assert.equal(seen.move, 0);
    h.move(10, 0);                      // past threshold → start + move
    assert.equal(seen.start, 1);
    assert.equal(seen.move, 1);
    h.move(20, 0);
    assert.equal(seen.move, 2);
    h.up(20, 0);                        // drop, with the element under the point
    assert.equal(seen.drop.target, drop);
    assert.equal(seen.drop.x, 20);
    assert.equal(h.listeners.pointermove, null, 'move listener cleaned up on drop');
  } finally { h.restore(); }
});

test('dragGesture — a plain click (no move past threshold) never drops; fires onTap instead', () => {
  const h = dragHarness(null);
  try {
    let dropped = false, tapped = 0;
    dragGesture(h.el, { onDrop: () => { dropped = true; }, onTap: () => { tapped++; } });
    h.down(5, 5); h.up(6, 6);           // 1px move → a tap, not a drag
    assert.equal(dropped, false);
    assert.equal(tapped, 1);
  } finally { h.restore(); }
});

test('dragGesture — ghost is appended, follows the cursor, and is removed before the drop hit-test', () => {
  const drop = { id: 'zone' };
  const h = dragHarness(drop);
  try {
    let removedBeforeHitTest = false;
    const ghostEl = { style: {}, isConnected: false, remove() { this.isConnected = false; } };
    dragGesture(h.el, {
      ghost: () => ghostEl, ghostOffset: [10, 10],
      onDrop: () => { removedBeforeHitTest = !ghostEl.isConnected; },
    });
    h.down(0, 0);
    h.move(50, 60);                     // start → ghost appended + positioned
    assert.equal(h.appended[0], ghostEl, 'ghost appended to body on start');
    assert.equal(ghostEl.style.left, '60px');   // 50 + offset 10
    assert.equal(ghostEl.style.top, '70px');     // 60 + offset 10
    h.up(50, 60);
    assert.equal(removedBeforeHitTest, true, 'ghost removed before elementFromPoint so it cannot intercept');
  } finally { h.restore(); }
});

test('panelBus — many open/close cycles leave zero registered handlers (no growth)', () => {
  const Bus = fakeBus();
  const live = new Set();
  let triggerSweep = null;
  globalThis.document = { body: { contains: (p) => live.has(p) } };
  globalThis.MutationObserver = class { constructor(cb) { triggerSweep = cb; } observe() {} disconnect() {} };
  try {
    const panelBus = makePanelBus(Bus);
    for (let i = 0; i < 100; i++) {
      const p = { i }; live.add(p);
      panelBus(p).on('tick', () => {});
      live.delete(p); triggerSweep();
    }
    assert.equal(Bus.count('tick'), 0, 'no handler accumulation across 100 cycles');
  } finally { delete globalThis.document; delete globalThis.MutationObserver; }
});
