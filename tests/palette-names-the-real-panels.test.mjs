// The ⌘K palette said it was generated from the panel registry. It was not.
//
//   const defs=(typeof DEFS!=='undefined'&&DEFS)?DEFS:null;
//   const keys=defs?Object.keys(defs):Object.keys(PANEL_KW);
//   ... 'Open '+((defs&&defs[k]&&defs[k].title)||k.toUpperCase())
//
// `DEFS` lives inside the Panels IIFE. web/panels/harness.js *closes that IIFE* partway
// through itself, and the palette is defined after the close — so `typeof DEFS` was always
// 'undefined', the ternary always took the fallback, and every row came from the hand-kept
// PANEL_KW list, labelled by upper-casing the internal key.
//
// Measured live in the running app before the fix — 20 of 20 rows, not one real title:
//
//   Open TERMINAL   (the window says CODE)        Open RESEARCH    (the window says BROWSER)
//   Open SHELL      (the window says iT)          Open AGENTVIEW   (the window says AGENT)
//   Open MACHINE    (MY MACHINE)                  Open AGENTS      (MY AGENTS)
//
// Two consequences. The owner reads one name on the window and another in the palette — and
// the AGENT panel, whose only pointing route needs a wallet connected and an iNFT pinned,
// was listed under a name that appears nowhere else in the product.
//
// The second is worse: a panel added to DEFS but not to PANEL_KW gets NO palette row, which
// is exactly BUG-L0-003 ("it listed 7, notes found nothing") waiting to happen again — while
// the comment above it told the next engineer the list was automatic.
//
// Panels.catalog() already existed and already returned key+title+sub. The agent's
// list_panels tool used it. The human's palette did not. Two implementations of one idea,
// and the wrong one had the reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const harness = fs.readFileSync(path.join(APP, 'web/panels/harness.js'), 'utf8');
// Line comments FIRST, then block comments — the other order leaves `/*` inside a `//` line
// and eats the rest of the file. The comment above this test names DEFS; without stripping,
// the prose would satisfy the very assertion that must fail when the CODE names it.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const paletteBlock = decomment(harness.slice(
  harness.indexOf('const Palette=(()=>{'),
  harness.indexOf('const Shortcuts=(()=>{'),
));

test('the palette lists panels from the registry, not from a hand-kept key list', () => {
  assert.match(paletteBlock, /Panels\.catalog\(\)/, 'panel rows must come from Panels.catalog()');
  assert.doesNotMatch(paletteBlock, /\bDEFS\b/,
    'DEFS is out of scope here — a reference to it is dead code that silently falls back');
  assert.doesNotMatch(paletteBlock, /keys=[^;]*Object\.keys\(PANEL_KW\)/,
    'PANEL_KW must never be the source of WHICH panels exist');
});

test('DEFS really is out of scope where the palette is defined', () => {
  // The root cause, pinned structurally so nobody "fixes" this by reading DEFS again.
  const dist = fs.readFileSync(path.join(APP, 'dist/index.html'), 'utf8');
  const panelsAt = dist.indexOf('const Panels=(()=>{');
  const paletteAt = dist.indexOf('const Palette=(()=>{');
  assert.ok(panelsAt > 0 && paletteAt > panelsAt);
  // first column-0 `})();` after the Panels IIFE opens = the Panels IIFE closing
  const closeAt = dist.indexOf('\n})();', panelsAt);
  assert.ok(closeAt > 0, 'the Panels IIFE must close');
  assert.ok(paletteAt > closeAt,
    'the palette is defined AFTER Panels closes — so it can only see the public API');
});

test('one source feeds both the palette and the agent — they cannot drift', () => {
  const uses = harness.match(/Panels\.catalog\(\)/g) || [];
  assert.ok(uses.length >= 2, 'both the palette and list_panels read the same catalog');
  assert.match(harness, /if\(action==='list_panels'\)return\{ok:true,panels:Panels\.catalog\(\)\}/);
});

test('catalog() carries the icon, so the palette needs no icon table of its own', () => {
  assert.match(harness, /catalog:\(\)=>Object\.keys\(DEFS\)\.map\(k=>\(\{[^}]*icon:DEFS\[k\]\.icon/);
  assert.doesNotMatch(paletteBlock, /PANEL_ICON/, 'the second hand-kept table is gone');
});

// The behaviour, run for real: build the entries against a fake catalog.
function buildEntries() {
  const from = harness.indexOf('  const PANEL_KW='), to = harness.indexOf('  const EXTRAS=[');
  assert.ok(from > 0 && to > from,
    'the palette must build its panel rows in a named panelEntries() between PANEL_KW and EXTRAS');
  const src = harness.slice(from, to);
  const opened = [];
  const Panels = {
    catalog: () => ([
      { key: 'terminal', title: 'CODE', sub: 'agent chat', icon: '#i-term' },
      { key: 'research', title: 'BROWSER', sub: 'the web', icon: '#i-globe' },
      { key: 'shell', title: 'iT', sub: 'multiplexer', icon: '#i-term2' },
      { key: 'agentview', title: 'AGENT', sub: 'iNFT identity · traits · soul', icon: '#i-agent' },
      { key: 'lab', title: 'LAB', sub: 'deck', icon: '#i-lab' },
      // a panel nobody remembered to add to PANEL_KW — the BUG-L0-003 shape
      { key: 'newcomer', title: 'NEWCOMER', sub: 'shipped last night', icon: '#i-new' },
    ]),
    openPanel: (k) => opened.push(k),
  };
  const fn = new Function('Panels', src + '\nreturn panelEntries;')(Panels);
  return { rows: fn(), opened, Panels };
}

test('every panel in the catalog gets exactly one row, under its real name', () => {
  const { rows } = buildEntries();
  assert.equal(rows.length, 6, 'one row per catalogued panel — none dropped');
  const labels = rows.map(r => r.l);
  assert.deepEqual(labels.slice(0, 5).sort(), [
    'Open AGENT', 'Open BROWSER', 'Open CODE', 'Open LAB', 'Open iT',
  ], 'the palette must call panels what their windows call them');
  assert.ok(!labels.some(l => /RESEARCH|SHELL|AGENTVIEW|TERMINAL/.test(l)),
    'no row may be labelled by upper-casing the internal key');
});

test('a panel missing from PANEL_KW still lists — it just sorts last', () => {
  const { rows } = buildEntries();
  assert.equal(rows[rows.length - 1].l, 'Open NEWCOMER',
    'unknown panels go to the end, never off the list');
  assert.equal(rows[0].l, 'Open CODE', 'the curated order still leads');
});

test('a row is findable by key, by title, by subtitle and by keyword', () => {
  const { rows } = buildEntries();
  const agent = rows.find(r => r.l === 'Open AGENT');
  for (const q of ['agentview', 'agent', 'inft', 'traits', 'soul', 'identity', 'card']) {
    assert.ok(agent.k.includes(q), `"${q}" must find the AGENT panel`);
  }
  assert.equal(agent.i, '#i-agent', 'the icon comes from the panel def');
  assert.equal(rows.find(r => r.l === 'Open NEWCOMER').i, '#i-new',
    'a panel with no entry in any hand-kept table still gets its own icon');
});

test('running a row opens that panel', () => {
  const { rows, opened } = buildEntries();
  rows.find(r => r.l === 'Open AGENT').run();
  rows.find(r => r.l === 'Open iT').run();
  assert.deepEqual(opened, ['agentview', 'shell']);
});
