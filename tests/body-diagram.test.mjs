// The Body tab showed STRUCTURE.md as a hundred lines of preformatted text. That tells
// you where a file is; it does not tell you what the app IS. The same text is now also
// drawn as an architecture diagram — face → hands → mind, with the wire between them.
//
// The one rule that makes it trustworthy: it is PARSED from the generated tree, never
// drawn beside it. A hand-drawn diagram goes stale the first time a folder moves, and a
// diagram nobody can trust is worse than no diagram at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const brain = read('web/panels/brain.js');
const structure = read('agent/STRUCTURE.md');
const distPath = path.join(HERE, '..', 'dist', 'index.html');
const dist = fs.existsSync(distPath) ? read('dist/index.html') : '';

// Run the panel's OWN renderer — a copy in the test would pass while the app broke.
function renderer() {
  const src = brain.slice(brain.indexOf('const ARCH=['), brain.indexOf('const docs={};'));
  assert.ok(src.length > 500, 'could not find the diagram block in the panel');
  const ctx = {
    escHtml: (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])),
    escAttr: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__api={archHTML,parseTree,partNote,trimRole};', ctx);
  return ctx.__api;
}

test('the real body tree parses into layers', () => {
  const { parseTree } = renderer();
  const roots = parseTree(structure);
  assert.ok(roots, 'STRUCTURE.md did not parse — the diagram would be dead');
  const byName = Object.fromEntries(roots.map((r) => [r.name, r]));
  for (const dir of ['web/', 'bridge/', 'agent/']) {
    assert.ok(byName[dir], 'the tree is missing ' + dir);
    assert.ok(byName[dir].note, dir + ' must carry its role note');
  }
  // web/ holds panels/ as a container whose children are the real parts.
  const panels = byName['web/'].kids.find((k) => k.name === 'panels/');
  assert.ok(panels && panels.kids.length > 10, 'the panels must be read as parts, not as one folder');
});

test('the diagram names every top-level folder — none is silently dropped', () => {
  const { archHTML, parseTree } = renderer();
  const html = archHTML(structure);
  assert.ok(html, 'the diagram did not render');
  for (const r of parseTree(structure)) {
    assert.ok(html.includes('>' + r.name + '<'), r.name + ' is in the tree but not in the diagram');
  }
});

test('the three layers and the wires between them are drawn', () => {
  const html = renderer().archHTML(structure);
  for (const title of ['The face', 'The hands', 'The mind', 'The workshop']) {
    assert.ok(html.includes('<b>' + title + '</b>'), 'missing the ' + title + ' layer');
  }
  // The port is read from the tree, not hardcoded twice — it can never disagree with it.
  const port = (structure.match(/127\.0\.0\.1:(\d{2,5})/) || [])[1];
  assert.ok(port, 'the tree must state the bridge port');
  assert.ok(html.includes('127.0.0.1:' + port), 'the wire must carry the real port');
  assert.equal((html.match(/class="brn-wire"/g) || []).length, 3, 'one wire between each pair of layers');
});

test('a note that only repeats the product name or the file name is dropped', () => {
  // Every bridge module opens "CLONE FRAME · HUB — …". Printing that 39 times is noise,
  // and a note that restates the file name costs a line and says nothing.
  const { partNote, archHTML } = renderer();
  assert.equal(partNote('browser.mjs', 'CLONE FRAME · HUB — browser'), '');
  assert.equal(partNote('email.mjs', 'CLONE FRAME · HUB Bridge — Email Engine'), 'Email Engine');
  assert.equal(partNote('goal.ts', 'goal — a self-sustaining goal loop'), 'goal — a self-sustaining goal loop');
  assert.ok(!archHTML(structure).includes('CLONE FRAME · HUB —'), 'the repeated prefix reached the diagram');
});

test('an unreadable tree falls back to the raw text, never to a blank panel', () => {
  const { archHTML } = renderer();
  for (const bad of ['', 'no fenced block here', '```\nnot a tree\n```', null, undefined]) {
    assert.equal(archHTML(bad), null, 'a tree it cannot parse must return null so the caller shows the text');
  }
  assert.match(brain, /const arch=name==='tree'&&d\.present&&d\.text&&!d\.tooBig\?archHTML\(d\.text\):null/,
    'the panel must only attempt the diagram when there is text to parse');
  assert.match(brain, /arch&&treeView==='map'\?arch:`<div class="brn-doc-body">\$\{escHtml\(d\.text\)\}<\/div>`/,
    'and fall through to the raw tree when the parse fails or the owner asks for files');
});

test('the owner can switch between the diagram and the files', () => {
  assert.match(brain, /data-tview="map"/, 'a Diagram control');
  assert.match(brain, /data-tview="files"/, 'and a Files control');
  assert.match(brain, /\[data-tview\]'\)\.forEach\(b=>b\.addEventListener\('click'/, 'both must be wired');
  assert.ok(!/data-tview/.test(brain.slice(0, brain.indexOf('const ARCH=['))),
    'the toggle belongs to the tree doc, not to every doc');
});

test('the shipped artifact carries the diagram', () => {
  if (!dist) return;
  for (const needle of ['function archHTML(', 'function parseTree(', 'brn-arch', 'brn-wire', 'brn-layer']) {
    assert.ok(dist.includes(needle), 'dist/index.html is missing: ' + needle);
  }
});
