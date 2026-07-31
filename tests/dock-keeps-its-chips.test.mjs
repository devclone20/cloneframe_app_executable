// The DOCK emptied itself as you used it.
//
// Clicking a chip restored the window and the chip vanished — so the dock was a list of the
// things you were NOT doing. The cause was two rules for one idea, in the open-panel handler:
//
//     MULTI type   → Grid.linkPanel(cell, key)   the square survives, it is the window's home
//     singleton    → Grid.release(cell)          "the launcher tile has served its purpose"
//
// Measured live before the fix: a NOTES square carried panelKey=null, so the click fell to the
// singleton branch, released the cell, and the chip went with it. A BROWSER square, same click,
// kept its chip. Same control, two behaviours, depending on a distinction the owner cannot see.
//
// Now: opening from a square LINKS the window to it and leaves it standing, for every type.
// A chip leaves the dock only through its own ✕ — which is also why cell:removed now closes an
// OPEN window, not just a hidden one: it used to only ever fire on a docked window.
//
// The rest of this file pins the four things the owner asked for that a screenshot cannot hold:
// no label, a running marker, a rail that clips instead of a list that grows, and no cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const harness = read('web/panels/harness.js');
const app = read('web/index.html');
const dist = read('dist/index.html');
const openPanelHandler = decomment(
  harness.slice(harness.indexOf("Bus.on('open-panel'"), harness.indexOf("Bus.on('cell:removed'")),
);

test('opening from a square never releases it — one rule for every type', () => {
  assert.doesNotMatch(openPanelHandler, /Grid\.release/,
    'a square is the window home; only its ✕ takes it away');
  assert.match(openPanelHandler, /Grid\.linkPanel\(d\.cell,\s*p\.dataset\.key\)/,
    'every type links its window to the square it was opened from');
  // ONE link site, and it is not inside the MULTI-only branch — that is what makes it one rule
  assert.equal((openPanelHandler.match(/Grid\.linkPanel\(/g) || []).length, 1,
    'one CALL site — a second would be the two-rules shape growing back');
  const multiOnly = openPanelHandler.slice(
    openPanelHandler.indexOf('if(MULTI.has(type)){'),
    openPanelHandler.indexOf('}else p=openPanel(type)'),
  );
  assert.ok(multiOnly.length > 0, 'the MULTI branch is still there — it opens a new instance');
  assert.doesNotMatch(multiOnly, /Grid\.linkPanel/,
    'the link sits after the branch, so a singleton is linked too');
});

test('a square ✕ closes its window whether it is hidden or on screen', () => {
  const h = decomment(harness);
  assert.match(h, /Bus\.on\('cell:removed',\s*pk=>\{const p=open\[pk\];if\(p\)close\(p\)/,
    'the old guard only closed a window that was docked — an open one leaked');
  assert.doesNotMatch(h, /cell:removed[^\n]*p\.dataset\.docked\)close/,
    'the docked-only condition is gone');
});

test('the dock carries no label', () => {
  assert.doesNotMatch(app, /wdk-hd/, 'the DOCK caption and its CSS are gone');
  assert.doesNotMatch(dist, /wdk-hd/, 'and gone from the build');
  assert.match(app, /class="wdk-grab"/, 'a grab bar does the dragging the caption used to do');
  assert.match(app, /function wireGrabDrag\(\)/);
  assert.match(app, /el\.querySelector\('\.wdk-grab'\)/, 'the drag is wired to the bar, not the caption');
});

test('a chip says whether its window is open, in its own colour', () => {
  assert.match(app, /\.wdk-chip\[data-open="1"\]\{[^}]*--h:var\(--chip-hue,\s*\d+\)/,
    'an open chip lights in its own hue — a row of distinct apps, not one accent repeated');
  assert.match(app, /const CHIP_HUE=\{/, 'the hues are a named table, not a hash of the type string');
  // every panel in DEFS must have one, or a dock full of open windows has a hole in it
  const defs = app.slice(app.indexOf('const DEFS='), app.indexOf('\n  };', app.indexOf('const DEFS=')));
  const types = [...defs.matchAll(/(?:^|[,{])\s*\n?\s*([a-z][a-zA-Z0-9]*)\s*:\s*\{\s*icon:/g)].map(m => m[1]);
  const table = app.slice(app.indexOf('const CHIP_HUE={'), app.indexOf('};', app.indexOf('const CHIP_HUE={')));
  assert.ok(types.length >= 20, `expected the full panel set, parsed ${types.length}`);
  const missing = types.filter(t => !new RegExp('\\b' + t + ':\\s*\\d+').test(table));
  assert.deepEqual(missing, [], 'every panel needs its own hue');
  // Distinguishable: distinct DESTINATIONS need distinct colours. Two keys may share a hue
  // on purpose — `agent` and `terminal` both open CODE — so compare the unique values.
  const hues = [...new Set([...table.matchAll(/\b[a-z][a-zA-Z0-9]*:\s*(\d+)/g)].map(m => +m[1]))]
    .sort((a, b) => a - b);
  const tooClose = hues.filter((h, i) => i > 0 && h - hues[i - 1] < 5);
  assert.deepEqual(tooClose, [], 'distinct hues must be at least 5 apart to read as different colours');
  assert.match(app, /agent:265,terminal:265/, 'the auto-seeded square wears the colour of what it opens');
  assert.match(app, /function litCells\(cells\)/);
  assert.match(app, /Bus\.on\('panels:changed',markOpen\)/,
    'the dock repaints on a panel event instead of rebuilding');
  // the event must actually be emitted by the four things that change a window's state
  const emits = (app.match(/Bus\.emit\('panels:changed'\)/g) || []).length;
  assert.ok(emits >= 4, `openPanel, focus-existing, close and minimize must all announce it (found ${emits})`);
  assert.match(harness, /Bus\.emit\('panels:changed'\)/, 'and the open-panel path too');
});

test('one window lights exactly one chip', () => {
  // It was decided per chip: match panelKey, else light ANY square whose type had a window
  // open. Two squares leading to the same window then both lit from one window — opening the
  // auto-seeded AGENT square lit AGENT *and* CODE, because AGENT routes to CODE and the CODE
  // square had no key. Reproduced live: 1 window open, 2 chips lit. Now it is decided for the
  // whole dock by claim, so the lit chips can never outnumber the open windows.
  const fn = app.match(/function litCells\(cells\)\{[\s\S]*?\n {2}\}/)[0];
  assert.doesNotMatch(app, /function isOpenFor/, 'the per-chip decision is gone');
  assert.match(fn, /!p\.dataset\.docked/, 'hidden in its square is not open');
  assert.match(fn, /const claimed=new Set\(\)/, 'a window can be claimed once');
  assert.match(fn, /if\(p&&!claimed\.has\(p\)\)\{claimed\.add\(p\);lit\.add\(cell\)\}/,
    'pass 1 — a square that knows its window takes it');
  // A KEY THAT MATCHED NOTHING IS NOT A CLAIM. Pass 2 used to skip any square carrying a
  // panelKey, so a square holding a handle to a window long closed could never light again.
  // Photographed by the owner: three iT squares with stale keys, two fresh windows opened
  // from inside iT, and only the one whose key happened to be reused lit up — 2 windows,
  // 1 chip. Eligibility is "pass 1 did not light it", nothing more.
  assert.match(fn, /if\(lit\.has\(cell\)\)return/, 'pass 2 considers every square pass 1 left dark');
  assert.doesNotMatch(fn, /lit\.has\(cell\)\|\|cell\.dataset\.panelKey/,
    'a dead handle must not disqualify a square from claiming a live window');
  assert.match(fn, /live\.find\(x=>x\.dataset\.type===want&&!claimed\.has\(x\)\)/,
    'a keyless square may take only a window nobody claimed');
  assert.match(app, /OPEN_ALIAS=\{agent:'terminal',browser:'research'\}/,
    'the aliases mirror openPanel, so a keyless AGENT square can claim the CODE window');
  assert.match(app, /const cells=occCells\(\),lit=litCells\(cells\)/,
    'markOpen asks once for the whole dock, not once per chip');
});

test('the chips ride a rail that clips — so there is no cap', () => {
  assert.match(app, /class="wdk-rail"/);
  assert.match(app, /class="wdk-track"/);
  assert.match(app, /\.wdk-rail\{[^}]*overflow:hidden/, 'the rail clips');
  assert.match(app, /\.wdk-track\{[^}]*will-change:transform/, 'the track slides');
  assert.doesNotMatch(app, /#wdock\{[^}]*max-height:82vh/, 'the old fixed ceiling is gone');
  // nothing anywhere may slice the chip list
  const refresh = app.match(/function refresh\(\)\{[\s\S]*?\n {2}\}/)[0];
  assert.doesNotMatch(refresh, /\.slice\(0,\s*\d+\)/, 'the dock must never truncate the squares');
});

test('a magnified icon takes real space, so the rail can never cut it', () => {
  // It grew by transform:scale — no layout cost, but it painted outside its own box, and the
  // rail (which must clip along the scroll axis so hidden chips stay hidden) sliced the sides
  // off. Reported twice from the running app: first the top, then the left. macOS does not
  // scale in place, it reflows — the box grows and the neighbours move over.
  assert.match(app, /\.wdk-chip\{[^}]*width:calc\(var\(--wdk-unit\) \* var\(--mag,1\)\)/,
    'the chip box itself grows');
  assert.doesNotMatch(app, /\.wdk-chip\{[^}]*transform:scale\(var\(--mag/,
    'growth by transform is what got clipped — it must not come back');
  assert.doesNotMatch(app, /mag-origin/, 'a box that grows in the flow needs no transform-origin');
  assert.match(app, /\.wdk-chip svg\{[^}]*var\(--mag,1\) \* \.47\)/, 'the icon rides the box');
  // the bar keeps its thickness while the icon rises out of it
  assert.match(app, /\.wdk-rail\{[^}]*box-sizing:content-box/,
    'the app sets border-box globally, which would make the lift eat the chip row');
  assert.match(app, /--wdk-lift:calc\(var\(--wdk-unit\) \* 0\.62\)/,
    'headroom above the peak magnification of 1.55');
  // and it must not thrash: one pass per frame, not one per pointermove
  assert.match(app, /if\(!magQueued\)\{magQueued=true;requestAnimationFrame\(magnify\)\}/,
    'sizing costs layout now — it belongs on a frame');
});

test('every chip owns its own ✕, and it is reachable', () => {
  // `all:unset` was written AFTER `position:relative` and reset it to static, so no chip was
  // ever a positioning context: every absolutely-positioned ✕ landed against the DOCK. One ✕
  // at the dock's corner, for every chip — exactly what the owner saw. Then it sat at
  // top:-5 right:-5, OUTSIDE the box that reveals it, so reaching for it ended the hover and
  // the target vanished — worse once chips magnified and the geometry moved as you approached.
  const chip = app.match(/\.wdk-chip\{[^}]*\}/)[0];
  assert.match(chip, /^\.wdk-chip\{all:unset;position:relative/,
    'all:unset must come FIRST or it wipes the positioning context');
  const x = app.match(/\.wdk-x\{[^}]*\}/)[0];
  assert.match(x, /position:absolute/);
  assert.doesNotMatch(x, /top:-|right:-/, 'the ✕ sits inside its chip, never outside it');
  assert.match(x, /top:calc\(3px \* var\(--mag,1\)\);right:calc\(3px \* var\(--mag,1\)\)/);
  assert.match(x, /width:calc\(15px \* var\(--mag,1\)\)/, 'it grows with the chip, so it stays hittable');
});

test('colours never run out — one per window, for any number of windows', () => {
  assert.match(app, /const GOLDEN=137\.508/, 'the golden angle: stepping by it never repeats');
  assert.match(app, /const chipHue=\(type,nth\)=>/);
  assert.match(app, /GOLDEN\*nth/, 'each further window of a type steps on from the last');
  assert.match(app, /hueOfName/, 'a type nobody named still gets a stable hue of its own');
  assert.match(app, /const n=\(nth\[type\]=\(nth\[type\]\|\|0\)\+1\)-1/,
    'the index is per type, counted while the dock is built');
  assert.match(app, /\.wdk-chip:hover\{--h:var\(--chip-hue,265\)/,
    'hover wears the chip own hue — an app must not change identity under the pointer');
  // the generator, run here: 24 windows of one type must give 24 distinct hues
  const GOLDEN = 137.508, hue = (base, n) => Math.round((base + GOLDEN * n) % 360 + 360) % 360;
  const hues = Array.from({ length: 24 }, (_, n) => hue(285, n));
  assert.equal(new Set(hues).size, 24, 'twenty-four iT tabs, twenty-four colours');
  const sorted = [...hues].sort((a, b) => a - b);
  const gaps = sorted.map((h, i) => (i ? h - sorted[i - 1] : 360 - sorted[sorted.length - 1] + sorted[0]));
  assert.ok(Math.min(...gaps) >= 5, 'and none of them collide on the wheel');
});

test('panning is clamped to what is actually hidden', () => {
  const fn = app.match(/function applyPan\(\)\{[\s\S]*?\n {2}\}/)[0];
  assert.match(fn, /Math\.max\(-m\.over,Math\.min\(0,panOff\)\)/,
    'never past the last chip, never before the first');
  assert.match(app, /rail\.classList\.toggle\('pans',m\.over>0\)/,
    'the fade mask appears only when something is actually hidden');
  const wheel = app.match(/rail\.addEventListener\('wheel'[\s\S]*?\{passive:false\}\)/)[0];
  assert.match(wheel, /if\(!m\|\|!m\.over\)return/,
    'with nothing hidden the wheel belongs to the page, not to us');
});
