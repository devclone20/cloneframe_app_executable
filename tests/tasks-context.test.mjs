// Context test for the tasks/cron domain module AFTER its migration of the
// tasks.json container onto the shared json-store port (Wave-3). Proves the
// migration is behavior-preserving end-to-end against a REAL filesystem store,
// isolated to a throwaway dir via CLONE_FRAME_HUB_ROOT (the hub-root seam).
// Exercises only the LLM-free surface (CRUD / control / cron / persistence) —
// runNow()/the scheduler call ask() and are out of scope for a storage refactor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` and `ROOT = hubRoot()` bind to
// our throwaway dir, and the module's `loaded` flag starts false.
async function freshTasks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-tasks-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/tasks.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, T: mod.Tasks, file: path.join(root, 'tasks.json') };
}

test('init seeds the 3 built-ins and persists tasks.json {version, pausedAll, tasks}', async () => {
  const { T, file } = await freshTasks();
  const seeded = T.list(); // triggers lazy init()
  assert.equal(seeded.length, 3);
  assert.ok(seeded.every((t) => t.isBuiltin === true));
  assert.deepEqual(
    seeded.map((t) => t.id).sort(),
    ['builtin-email-auto-reply', 'builtin-email-summary', 'builtin-email-tags'],
  );

  // persisted shape: {version, pausedAll, tasks:[...]}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.pausedAll, false);
  assert.equal(onDisk.tasks.length, 3);
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('add → get → update → setState → remove round-trip on a custom task', async () => {
  const { T, file } = await freshTasks();
  const res = T.add({ name: 'Nightly digest', cron: '0 3 * * *', action: 'custom', prompt: 'summarize my day' });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const view = T.get(res.id);
  assert.equal(view.name, 'Nightly digest');
  assert.equal(view.cron, '0 3 * * *');
  assert.equal(view.state, 'paused'); // never runs unattended until enabled
  assert.equal(view.isBuiltin, false);

  assert.equal(T.update(res.id, { cron: '30 4 * * *', name: 'Renamed' }).ok, true);
  assert.equal(T.get(res.id).cron, '30 4 * * *');
  assert.equal(T.get(res.id).name, 'Renamed');
  // This used to assert `nextRunAt` was TRUTHY here — on a task that is still paused. That
  // contradicted the invariant setState() has always enforced (paused ⇒ nextRunAt null), and it
  // pinned the phantom "· next 12:00:00 PM" a never-enabled task advertised: a time nothing
  // would honour, going stale forever. The intent of the line was "the cron change took
  // effect", and that is what it checks now — the schedule is only computed when the task is
  // actually going to run, which the setState assertions below prove.
  assert.equal(T.get(res.id).nextRunAt, null); // still paused → nothing scheduled

  assert.equal(T.update(res.id, { cron: 'not a cron' }).ok, false); // invalid cron rejected

  assert.equal(T.setState(res.id, 'running').ok, true);
  assert.equal(T.get(res.id).state, 'running');
  assert.ok(T.get(res.id).nextRunAt);
  assert.equal(T.setState(res.id, 'sideways').ok, false); // only running|paused

  assert.equal(T.remove(res.id).ok, true);
  assert.equal(T.get(res.id), null);

  // survives a fresh reload from disk: 3 built-ins, custom gone
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.tasks.length, 3);
});

test('add validates input and built-ins cannot be removed', async () => {
  const { T } = await freshTasks();
  assert.equal(T.add({ cron: '* * * * *', action: 'custom', prompt: 'x' }).ok, false); // no name
  assert.equal(T.add({ name: 'x', action: 'custom', prompt: 'x' }).ok, false);          // no cron
  assert.equal(T.add({ name: 'x', cron: 'bad' }).ok, false);                            // invalid cron
  assert.equal(T.add({ name: 'x', cron: '* * * * *', action: 'custom' }).ok, false);    // custom needs prompt
  assert.equal(T.remove('builtin-email-summary').ok, false);                            // built-in protected
});

test('pauseAll / isPausedAll persist and round-trip', async () => {
  const { T, file } = await freshTasks();
  assert.equal(T.isPausedAll(), false);
  assert.deepEqual(T.pauseAll(true), { ok: true, pausedAll: true });
  assert.equal(T.isPausedAll(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pausedAll, true);
});

test('cron helpers are unchanged by the migration', async () => {
  const { T } = await freshTasks();
  assert.deepEqual([...T.parseCron('*/15 0 1 1 *').minute], [0, 15, 30, 45]);
  assert.equal(T.isDue('30 9 * * *', new Date('2030-06-01T09:30:00')), true);
  assert.equal(T.isDue('30 9 * * *', new Date('2030-06-01T09:31:00')), false);
  const next = T.nextRun('0 0 1 1 *', new Date('2030-06-01T00:00:00'));
  assert.equal(next.getMonth(), 0); // January
  assert.equal(next.getDate(), 1);
});

test('a corrupt tasks.json degrades to the built-in seeds instead of throwing', async () => {
  const { T, file } = await freshTasks();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not valid json at all');
  const list = T.list(); // triggers init(), must not throw
  assert.equal(list.length, 3);
  assert.ok(list.every((t) => t.isBuiltin));
  // and it heals the store back to a valid file
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.tasks.length, 3);
});
