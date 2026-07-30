// Regression test for F-001 — the SEARCH panel was dead at the root.
//
// `bridge/search.mjs` listed `notes: searchNotes` in its SEARCHERS map but the
// function was never defined. SEARCHERS is a module-level `const`, so the bad
// reference was evaluated at IMPORT time: every `import('./search.mjs')` threw
// `ReferenceError: searchNotes is not defined`. The module's own header promises
// "Never throws: a failing/missing module simply contributes no group" — it could
// not even load. Downstream, SEARCH showed an error for every query and Settings'
// "everything indexed (notes · tasks · reminders · research)" was false.
//
// These assertions fail against the old code on the FIRST LINE that imports the
// module, which is the point: a missing searcher must be a red test, not a dead panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The hub-root seam has to be set BEFORE any bridge module is imported — several
// resolve their store directory at module load, so a later assignment is too late.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-search-'));
process.env.CLONE_FRAME_HUB_ROOT = ROOT;

test('search.mjs imports, and every key in SEARCHERS resolves to a function', async () => {
  const mod = await import('../bridge/search.mjs');
  assert.equal(typeof mod.query, 'function');
  // The aggregator advertises four modules; each one needs a searcher behind it.
  assert.deepEqual(mod.modules(), ['notes', 'tasks', 'reminders', 'research']);
});

test('a note is findable through the aggregator (the notes searcher runs)', async () => {
  const { Notes } = await import('../bridge/notes.mjs');
  const created = Notes.create({ title: 'Landing checklist', body: 'ship the KNOWN-ISSUES file' });
  assert.equal(created.ok, true);

  const { query } = await import('../bridge/search.mjs');
  const r = await query('landing');
  const g = r.groups.find((x) => x.module === 'notes');
  assert.ok(g, 'no notes group came back — searchNotes did not run');
  assert.equal(g.label, 'Notes');
  assert.equal(g.results.length, 1);
  assert.equal(g.results[0].title, 'Landing checklist');
  // The row shape must match the other three searchers: {id, title, snippet}.
  assert.equal(g.results[0].snippet, 'ship the KNOWN-ISSUES file');
  assert.ok(g.results[0].id);
});

test('the note body is searched, not only the title', async () => {
  const { query } = await import('../bridge/search.mjs');
  const r = await query('KNOWN-ISSUES');
  assert.ok(
    r.groups.find((x) => x.module === 'notes'),
    'a body-only match should still surface the note (Notes.list does the matching)',
  );
});

test('a blank query returns no groups at all', async () => {
  const { query } = await import('../bridge/search.mjs');
  assert.deepEqual((await query('   ')).groups, []);
});
