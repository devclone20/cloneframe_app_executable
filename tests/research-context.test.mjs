// Context test for the research domain module AFTER its migration onto the
// shared json-store port. Proves the LOCAL-STORE surface (list / get / remove —
// the CRUD that touches ~/.clone-frame-hub/research.json) is behavior-preserving
// against a REAL filesystem store, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam). The network pass (run() → ask()) is
// deliberately NOT exercised here: this test only covers the storage swap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A report record as run() persists it (loadStore keeps only objects with a
// string id; the views below read question/markdown/createdAt/mode/model/count).
function report(id, createdAt) {
  return {
    id,
    question: `question ${id}`,
    markdown: `# question ${id}\n\nbody`,
    createdAt,
    mode: 'reason',
    model: null,
    sourceCount: 0,
  };
}

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshResearch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-research-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/research.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, R: mod.Research, file: path.join(root, 'research.json') };
}

function seed(file, reports) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, reports }, null, 2));
}

test('empty store: list/get/remove degrade cleanly on a missing file', async () => {
  const { R } = await freshResearch();
  assert.deepEqual(R.list(), []);
  assert.equal(R.get('nope'), null);
  assert.equal(R.get(42), null); // non-string id
  assert.equal(R.remove('nope').ok, false);
});

test('list is newest-first, get returns the full view, none leak raw sources', async () => {
  const { R, file } = await freshResearch();
  seed(file, [report('r1', '2020-01-01T00:00:00Z'), report('r2', '2021-01-01T00:00:00Z')]);

  const list = R.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'r2'); // newest first
  assert.equal(list[1].id, 'r1');
  assert.deepEqual(Object.keys(list[0]).sort(), ['createdAt', 'id', 'question']);

  const full = R.get('r1');
  assert.equal(full.question, 'question r1');
  assert.equal(full.mode, 'reason');
  assert.equal(full.model, null);
  assert.equal(full.sourceCount, 0);
  assert.match(full.markdown, /body/);
  // getView must never carry a raw `sources` / `text` field.
  assert.equal('sources' in full, false);
  assert.equal('text' in full, false);
});

test('remove writes {version, reports} atomically at 0600', async () => {
  const { R, file } = await freshResearch();
  seed(file, [report('r1', '2020-01-01T00:00:00Z'), report('r2', '2021-01-01T00:00:00Z')]);

  assert.equal(R.remove('r1').ok, true);
  assert.equal(R.get('r1'), null);
  assert.equal(R.list().length, 1);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.reports.length, 1);
  assert.equal(onDisk.reports[0].id, 'r2');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal(R.remove('r1').ok, false); // already gone
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { R, file } = await freshResearch();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(R.list(), []);
  assert.equal(R.get('r1'), null);
});
