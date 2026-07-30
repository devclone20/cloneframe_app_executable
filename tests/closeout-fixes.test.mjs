// The close-out pass: the remaining open findings, fixed.
//
// 1 · An oversized curriculum could be blanked by the panel that shows it.
//     Past MAX_DOC, doc() returns text:'' with editable:true, so the Body tab opened an EMPTY
//     textarea over a real 600 KB AGENTS.md and one Save wrote zero bytes — and saveDoc never
//     re-records the sha, so ownerEdited() then treated the empty file as the owner's own work
//     and ensureWorkspace() protected it from being restored. The fleet ran it end to end under
//     an isolated HOME: 614417 → 0.
//     Three separate defects in one path: the panel offered Edit on a document it had not been
//     given, the daemon accepted the write, and the two sides measured different units — doc()
//     bytes (st.size) against saveDoc's text.length (UTF-16), so multi-byte text could pass the
//     check and land above the limit, becoming unreadable by the panel that had just saved it.
//
// 2 · On the machine-brain CODE path the model could widen its own tools. create_harness,
//     update_harness and use_harness were not gated, so with a crew active it could move itself
//     to a crew with different gates, or rewrite the one constraining it, without approval.
//
// 3 · Grid.occupy had no occupancy test. The owner's canvas was protected only by every call
//     site happening to be careful, and the drag-drop path was not.
//
// 4 · Docking a BROWSER window wrote the visited URL into localStorage, where it survived
//     quitting — against the browser's own "leaves no trace" promise.
//
// 5 · A task created paused still advertised a next run. setState() has always enforced
//     "paused ⇒ nextRunAt null"; the three paths that CREATE or edit a task did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

// ── 1 · the curriculum cliff ─────────────────────────────────────────────────

test('saveDoc refuses to write back a document it never handed out', () => {
  const fn = read('bridge/pi.mjs').match(/function saveDoc\(name, text\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(fs\.statSync\(file\)\.size > MAX_DOC\)/,
    'key on the file on disk, not on the text being empty — a deliberate clear of a SMALL doc must still work');
  assert.match(fn, /too large to edit here/);
  // and it must check before writing, obviously
  assert.ok(fn.indexOf('statSync(file).size > MAX_DOC') < fn.indexOf('writeFileSync'));
});

test('saveDoc and doc() finally measure the same unit', () => {
  const pi = read('bridge/pi.mjs');
  assert.match(pi, /if \(Buffer\.byteLength\(text\) > MAX_DOC\)/, 'bytes, like doc()');
  assert.doesNotMatch(pi, /if \(text\.length > MAX_DOC\)/,
    'UTF-16 units let multi-byte text past a byte-sized limit');
});

test('the panel does not offer Edit on a document it was not given', () => {
  const b = read('web/panels/brain.js');
  assert.match(b, /d\.editable&&!d\.tooBig\?`<button class="btn mini" data-dedit=/);
});

test('and the tooBig message is reachable at last', () => {
  const b = read('web/panels/brain.js');
  assert.match(b, /d\.present&&\(d\.text\|\|d\.tooBig\)/,
    'it was dead code behind `d.present&&d.text`, so a 600 KB file read as "Not on this machine yet."');
  assert.match(b, /Too large to show here — open it in FOLDERS/);
});

test('the whole path, exercised — an oversized doc cannot be blanked', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-doc-'));
  const prev = process.env.HOME;
  try {
    process.env.HOME = tmp;
    const dir = path.join(tmp, '.clone-frame-hub', 'agent');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'AGENTS.md');
    const big = '# BIG\n' + 'x'.repeat(600 * 1024);
    fs.writeFileSync(file, big);
    const { Pi } = await import('../bridge/pi.mjs?doc=' + Date.now());

    const d = Pi.doc('curriculum');
    assert.equal(d.tooBig, true, 'the bridge must flag it');
    assert.equal(d.text, '', 'and hand out nothing');

    const r = Pi.saveDoc('curriculum', '');            // exactly what the empty box would send
    assert.equal(r.ok, false, 'the write must be refused');
    assert.equal(fs.statSync(file).size, Buffer.byteLength(big), 'the file must be untouched');
  } finally {
    process.env.HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 2 · the model may not widen its own tools ────────────────────────────────

test('the tools that change the RULES are gated like the ones that change the machine', () => {
  const t = read('web/panels/terminal.js');
  const set = t.match(/const GATED_TOOLS=new Set\(\[[^\]]*\]\)/)[0];
  for (const tool of ['create_harness', 'update_harness', 'use_harness']) {
    assert.ok(set.includes("'" + tool + "'"), tool + ' can change which gates apply to the agent');
  }
  // the machine-side ones must still be there
  for (const tool of ['run_shell', 'write_file', 'send_email', 'applescript']) {
    assert.ok(set.includes("'" + tool + "'"), tool + ' must stay gated');
  }
});

// ── 3 · the owner's canvas ───────────────────────────────────────────────────

test('occupy refuses an occupied square and says so by its return value', () => {
  const app = read('web/index.html');
  const fn = app.match(/function occupy\(el,type,meta\)\{[\s\S]*?\n  \}/)[0];
  assert.match(fn, /if\(!el\|\|el\.classList\.contains\('occ'\)\)return false/);
  assert.match(fn, /return true;/, 'so a caller can pick somewhere else');
});

test('the drag-drop path honours the refusal instead of overwriting', () => {
  const app = read('web/index.html');
  assert.match(app, /if\(!Grid\.occupy\(cell,type\)\)\{Toast\.show\('That square is taken/);
});

// ── 4 · the browser leaves nothing on disk ───────────────────────────────────

test('a visited URL is not written to the persisted cell record', () => {
  const app = read('web/index.html');
  const fn = app.match(/function occupy\(el,type,meta\)\{[\s\S]*?\n  \}/)[0];
  assert.doesNotMatch(fn, /c\.url=meta\.url/, 'that survived quitting the app');
  assert.match(fn, /if\(meta&&meta\.cwd\)c\.cwd=meta\.cwd/, 'a cwd is not a browsing trace — it stays');
});

test('but a browser square dragged WITHIN a session still remembers its window', () => {
  const app = read('web/index.html');
  const mv = app.match(/function move\(src,dst\)\{[\s\S]*?\n  \}/)[0];
  assert.match(mv, /const uA=src\.dataset\.url\|\|'',uB=dst\.dataset\.url\|\|''/);
  assert.match(mv, /if\(uA\)dst\.dataset\.url=uA/);
});

// ── 5 · paused means no next run ─────────────────────────────────────────────

test('every path that creates or edits a task honours "paused ⇒ no next run"', () => {
  const t = read('bridge/tasks.mjs');
  assert.doesNotMatch(t, /nextRunAt: nextRunISO\(cron\)/, 'add() creates paused');
  assert.doesNotMatch(t, /nextRunAt: nextRunISO\(t\.cron\)/, 'and so do the built-in seeds');
  assert.match(t, /t\.nextRunAt = t\.state === 'running' \? nextRunISO\(t\.cron\) : null;/,
    'update() must not resurrect it when the cron changes');
  // the invariant setState has always enforced, unchanged
  assert.match(t, /t\.nextRunAt = state === 'running' \? nextRunISO\(t\.cron\) : null;/);
});

test('a fresh task really has no next run, and starting it gives it one', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-task-'));
  const prev = process.env.HOME;
  try {
    process.env.HOME = tmp;
    const { Tasks } = await import('../bridge/tasks.mjs?paused=' + Date.now());
    const made = Tasks.add({ name: 'zz-closeout', category: 'custom', cron: '0 9 * * *', action: 'custom', prompt: 'x' });
    assert.equal(made.ok, true);
    const t0 = Tasks.list().find((x) => x.id === made.id);
    assert.equal(t0.state, 'paused');
    assert.equal(t0.nextRunAt, null, 'a paused task advertised a time nothing would honour');
    Tasks.setState(made.id, 'running');
    const t1 = Tasks.list().find((x) => x.id === made.id);
    assert.ok(t1.nextRunAt, 'starting it must fill the next run in');
  } finally {
    process.env.HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('existing records are normalised too — a paused task loses a stale next run', async () => {
  // My fix stopped NEW tasks getting one; records written before it kept theirs. On this machine
  // the two built-in email tasks the owner had never enabled were advertising 2026-07-09 —
  // three weeks in the past and getting staler daily. Clearing it destroys nothing: by the
  // module's own rule the value was meaningless while paused.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-norm-'));
  const prev = process.env.HOME;
  try {
    process.env.HOME = tmp;
    const dir = path.join(tmp, '.clone-frame-hub');
    fs.mkdirSync(dir, { recursive: true });
    // a store as it would have been written before the invariant was enforced at creation
    fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({
      version: 1, pausedAll: false,
      tasks: [{ id: 'stale', name: 'zz-stale', cron: '0 9 * * *', action: 'custom', prompt: 'x',
                state: 'paused', isBuiltin: false, sessionId: 'stale',
                lastRunAt: null, nextRunAt: '2026-07-09T21:00:00.000Z', config: {}, description: '' }],
    }));
    const { Tasks } = await import('../bridge/tasks.mjs?norm=' + Date.now());
    const t = Tasks.list().find((x) => x.id === 'stale');
    assert.ok(t, 'the record must survive — only the phantom time goes');
    assert.equal(t.state, 'paused', 'and its state is untouched');
    assert.equal(t.nextRunAt, null, 'the stale time must be cleared on load');
  } finally {
    process.env.HOME = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
