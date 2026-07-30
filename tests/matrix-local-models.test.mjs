// MATRIX knew what it had downloaded only by replaying the engine's own event log.
//
// Three consequences, all reported by the owner: a model already on disk went invisible
// whenever the log and the disk disagreed (an engine restart was enough); it could not be
// deleted AT ALL while the engine was down; and "deleted" meant the engine had been asked
// to forget it, not that the gigabytes had left the machine.
//
// bridge/matrix.mjs now reads and removes the weights itself. These tests pin the two
// properties that make that safe: it only ever touches a directory it resolved as an exo
// models root, and it never shrinks the picker list because a probe timed out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// HOME FIRST — before any bridge import. matrix.mjs resolves the exo model roots from the
// home directory at module load, so a test that skipped this would scan, and could delete
// from, the developer's REAL ~/.exo/models. permissions.mjs caches its store at import too.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-matrixlocal-home-'));
process.env.HOME = HOME;
process.env.CLONE_FRAME_HUB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-matrixlocal-'));
for (const v of ['EXO_HOME', 'EXO_DEFAULT_MODELS_DIR', 'EXO_MODELS_DIRS', 'EXO_MODELS_READ_ONLY_DIRS']) delete process.env[v];

// The engine must never be reached: on a developer machine it may genuinely be running,
// and a test has no business sending DELETE commands to a live cluster.
globalThis.fetch = async () => { throw new Error('offline in tests'); };

const MODELS = path.join(HOME, '.exo', 'models');
const HF = path.join(HOME, '.cache', 'huggingface', 'hub');
const { Matrix } = await import('../bridge/matrix.mjs');
const { default: Permissions } = await import('../bridge/permissions.mjs');

function seed(root, id, files) {
  const dir = path.join(root, id.replace(/\//g, '--'));
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, size] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size));
  return dir;
}
const ids = () => Matrix.localModels().models.map((m) => m.id);

test('the disk answers even though the engine never will', () => {
  seed(MODELS, 'mlx-community/Fake-3B-4bit', { 'model.safetensors': 4096, 'config.json': 100 });
  fs.mkdirSync(path.join(MODELS, 'caches', 'mlx-community--Fake-3B-4bit'), { recursive: true });
  fs.writeFileSync(path.join(MODELS, 'caches', 'mlx-community--Fake-3B-4bit', 'file_list.json'), '{}');

  const out = Matrix.localModels();
  assert.equal(out.ok, true);
  const m = out.models.find((x) => x.id === 'mlx-community/Fake-3B-4bit');
  assert.ok(m, 'a downloaded model must be listed from the disk alone');
  assert.equal(m.bytes, 4196, 'the size must be the real one on disk, not a catalog guess');
  assert.equal(m.files, 2);
  assert.equal(m.readOnly, false);
  // The paths handed to the UI must not carry the machine's user name.
  assert.ok(m.dirs.every((d) => d.startsWith('~/')), 'paths must be reported relative to home');
  assert.ok(!out.models.some((x) => x.id === 'caches'), 'the metadata cache directory is not a model');
});

test('without the matrix permission nothing is removed', async () => {
  Permissions.set({ matrix: false });
  const r = await Matrix.purgeModel('mlx-community/Fake-3B-4bit');
  assert.equal(r.ok, false);
  assert.match(r.error, /permission is off/);
  assert.ok(ids().includes('mlx-community/Fake-3B-4bit'), 'a refused purge must leave the weights alone');
});

test('an id that is not a model id never becomes a path', async () => {
  Permissions.set({ matrix: true });
  for (const bad of ['', '../../etc', 'a/b/c', '/etc/passwd', '.', '..', 'org/../..', 'org/name/../..', 'caches']) {
    const r = await Matrix.purgeModel(bad);
    assert.equal(r.ok, false, JSON.stringify(bad) + ' must be refused');
    assert.match(r.error, /invalid model id/);
  }
  assert.ok(fs.existsSync(MODELS), 'the models root itself must survive every rejected id');
  assert.ok(fs.existsSync(path.join(MODELS, 'caches')), "'caches' is the shared metadata directory of EVERY model, not a model");
  assert.ok(ids().includes('mlx-community/Fake-3B-4bit'));
});

test('purge takes the weights, the metadata cache and the Hugging Face copy', async () => {
  Permissions.set({ matrix: true });
  // A tokenizer pulled through transformers/mlx lands in the shared HF cache. Left behind,
  // it is exactly the leftover the owner asked never to be left.
  fs.mkdirSync(path.join(HF, 'models--mlx-community--Fake-3B-4bit'), { recursive: true });
  fs.writeFileSync(path.join(HF, 'models--mlx-community--Fake-3B-4bit', 'tokenizer.json'), Buffer.alloc(512));
  fs.mkdirSync(path.join(HF, '.locks', 'models--mlx-community--Fake-3B-4bit'), { recursive: true });
  // A second model must be untouched — a purge is one model, not a sweep.
  seed(MODELS, 'mlx-community/Keep-Me-8bit', { 'model.safetensors': 2048 });

  const r = await Matrix.purgeModel('mlx-community/Fake-3B-4bit');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.freed, 4196 + 2 + 512, 'the freed figure must be measured, not estimated');
  assert.equal(r.removed.length, 4, 'weights, metadata cache, HF copy and HF lock');
  assert.ok(r.removed.every((x) => x.path.startsWith('~/')));

  assert.ok(!fs.existsSync(path.join(MODELS, 'mlx-community--Fake-3B-4bit')), 'the weights must be gone');
  assert.ok(!fs.existsSync(path.join(MODELS, 'caches', 'mlx-community--Fake-3B-4bit')), 'the metadata cache must be gone');
  assert.ok(!fs.existsSync(path.join(HF, 'models--mlx-community--Fake-3B-4bit')), 'the HF copy must be gone');
  assert.ok(!fs.existsSync(path.join(HF, '.locks', 'models--mlx-community--Fake-3B-4bit')), 'the HF lock must be gone');
  assert.deepEqual(ids(), ['mlx-community/Keep-Me-8bit'], 'and only that model');
});

test('purging what is already gone is honest, not an error', async () => {
  Permissions.set({ matrix: true });
  const r = await Matrix.purgeModel('mlx-community/Fake-3B-4bit');
  assert.equal(r.ok, true);
  assert.equal(r.freed, 0);
  assert.equal(r.notFound, true, 'the panel must be able to say "not here" instead of "deleted"');
  assert.deepEqual(r.removed, [], 'nothing to remove is not the same as a failure');
});

test('the freed figure is what left the machine, even when the engine deletes first', async () => {
  Permissions.set({ matrix: true });
  const dir = seed(MODELS, 'race/Engine-Wins', { 'model.safetensors': 8192 });
  // Caught on the machine, not in a test: the engine honoured the delete command and
  // rmtree'd the weights before the size was read, so a 5MB model reported 1KB freed.
  // Measuring up front is the fix; this is its tripwire.
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/state')) return { ok: true, json: async () => ({ instances: {}, downloads: { n1: [] } }) };
    if (u.endsWith('/node_id')) return { ok: true, json: async () => 'n1' };
    if (u.includes('/download/') && opts && opts.method === 'DELETE') {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: true, json: async () => ({}) };
    }
    if (u.includes('/models?status=downloaded')) return { ok: true, json: async () => ({ data: [] }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const r = await Matrix.purgeModel('race/Engine-Wins');
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.engine.reached, true, 'the engine answered and did the deleting');
    assert.equal(r.freed, 8192, 'the report must be the bytes that left, whoever removed them');
    assert.ok(!fs.existsSync(dir));
  } finally { globalThis.fetch = async () => { throw new Error('offline in tests'); }; }
});

test('it waits for the engine instead of deleting the directory out from under it', async () => {
  Permissions.set({ matrix: true });
  const dir = seed(MODELS, 'race/Slow-Engine', { 'model.safetensors': 2048 });
  // This is the whole reason the wait exists. exo's delete_model walks these directories
  // with shutil.rmtree(ignore_errors=False): removing one mid-walk raises FileNotFoundError
  // inside the engine and kills the daemon. It happened on 2026-07-29 — the engine went
  // down on the first live delete. The bridge must not touch a path the engine still holds.
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.endsWith('/state')) return { ok: true, json: async () => ({ instances: {}, downloads: { n1: [] } }) };
    if (u.endsWith('/node_id')) return { ok: true, json: async () => 'n1' };
    if (u.includes('/models?status=downloaded')) return { ok: true, json: async () => ({ data: [{ id: 'race/Slow-Engine' }] }) };
    if (u.includes('/download/') && opts && opts.method === 'DELETE') {
      setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 600); // the engine takes its time
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const t0 = Date.now();
  try {
    const r = await Matrix.purgeModel('race/Slow-Engine');
    assert.equal(r.engine.settled, true, 'it must observe the engine finishing, not assume it');
    assert.ok(Date.now() - t0 >= 500, 'it returned before the engine was done — that is the crash');
    assert.equal(r.freed, 2048, 'and still report what left the machine');
    assert.ok(!fs.existsSync(dir));
  } finally { globalThis.fetch = async () => { throw new Error('offline in tests'); }; }
});

test('a read-only models directory is listed and never deleted from', async () => {
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-matrix-ro-'));
  process.env.EXO_MODELS_READ_ONLY_DIRS = ro;
  try {
    seed(ro, 'shared/Team-Model-4bit', { 'model.safetensors': 1024 });
    const row = Matrix.localModels().models.find((m) => m.id === 'shared/Team-Model-4bit');
    assert.ok(row, 'a shared read-only model must still be visible');
    assert.equal(row.readOnly, true);
    Permissions.set({ matrix: true });
    const r = await Matrix.purgeModel('shared/Team-Model-4bit');
    assert.equal(r.ok, false, 'reporting success for a delete that cannot happen is the lie we are removing');
    assert.equal(r.readOnly, true);
    assert.match(r.error, /read-only/);
    assert.equal(r.freed, 0, 'the engine never writes to a read-only root, and neither may we');
    assert.ok(fs.existsSync(path.join(ro, 'shared--Team-Model-4bit', 'model.safetensors')));
  } finally { delete process.env.EXO_MODELS_READ_ONLY_DIRS; }
});

test('a probe that times out must never empty the pickers', async () => {
  const { Models } = await import('../bridge/models.mjs');
  const add = Models.addProvider({ kind: 'local', provider: 'matrix', label: 'MATRIX Cluster', baseUrl: 'http://127.0.0.1:52415/v1' });
  assert.equal(add.ok, true);
  Models.setModels(add.id, ['mlx-community/Keep-Me-8bit', 'mlx-community/Deleted-70B-4bit']);
  Models.setDefault('chat', { providerId: add.id, model: 'mlx-community/Deleted-70B-4bit' });

  // fetch still throws: this is the engine-is-down path. Writing [] here is what took every
  // MATRIX model out of CODE and LAB on a single 3s timeout.
  const r = await Matrix.syncModels();
  assert.equal(r.ok, true);
  assert.equal(r.engine, false, 'the engine did not answer');
  assert.deepEqual(r.models, ['mlx-community/Keep-Me-8bit'], 'what is still on disk stays selectable');
  // A silent engine is not evidence. Clearing the owner's chosen model here — a write no
  // restart undoes — cost them their default every time the engine was merely stopped.
  assert.equal(r.cleared, 0, 'a default must never be cleared on a probe that did not answer');
  assert.deepEqual(Models.getDefaults().chat, { providerId: add.id, model: 'mlx-community/Deleted-70B-4bit' });
});

test('a default is cleared only when both witnesses say the model is gone', async () => {
  const { Models } = await import('../bridge/models.mjs');
  const prov = Models.listProviders().find((p) => p.provider === 'matrix');
  globalThis.fetch = async (url) => {
    if (String(url).includes('/models?status=downloaded')) return { ok: true, json: async () => ({ data: ['mlx-community/Keep-Me-8bit'].map((id) => ({ id })) }) };
    throw new Error('unmocked fetch: ' + url);
  };
  try {
    const r = await Matrix.syncModels();
    assert.equal(r.engine, true, 'this time the engine answered');
    assert.equal(r.cleared, 1, 'engine and disk both say it is gone — now the default is dead weight');
    assert.equal(Models.getDefaults().chat, null);
    assert.equal(Models.getProvider(prov.id).models.includes('mlx-community/Deleted-70B-4bit'), false);
  } finally { globalThis.fetch = async () => { throw new Error('offline in tests'); }; }
});

test('an engine that has not finished scanning cannot empty the pickers', async () => {
  const { Models } = await import('../bridge/models.mjs');
  const prov = Models.listProviders().find((p) => p.provider === 'matrix');
  Models.setDefault('chat', { providerId: prov.id, model: 'mlx-community/Keep-Me-8bit' });
  // The seconds right after a restart: the engine is up and answers, truthfully, with an
  // empty list. Treating that as authoritative wiped every MATRIX model from CODE and LAB
  // and nulled the owner's default on a routine engine restart.
  globalThis.fetch = async (url) => {
    if (String(url).includes('/models?status=downloaded')) return { ok: true, json: async () => ({ data: [] }) };
    throw new Error('unmocked fetch: ' + url);
  };
  try {
    const r = await Matrix.syncModels();
    assert.deepEqual(r.models, ['mlx-community/Keep-Me-8bit'], 'the disk is the second witness, and it still has it');
    assert.equal(r.cleared, 0);
    assert.deepEqual(Models.getDefaults().chat, { providerId: prov.id, model: 'mlx-community/Keep-Me-8bit' });
  } finally { globalThis.fetch = async () => { throw new Error('offline in tests'); }; }
});

test('with the engine up the list is exactly what it can serve', async () => {
  const { Models } = await import('../bridge/models.mjs');
  const prov = Models.listProviders().find((p) => p.provider === 'matrix');
  globalThis.fetch = async (url) => {
    if (String(url).includes('/models?status=downloaded')) {
      return { ok: true, json: async () => ({ data: [{ id: 'mlx-community/Keep-Me-8bit' }, { id: 'brand/New-Model' }] }) };
    }
    throw new Error('unmocked fetch: ' + url);
  };
  try {
    const r = await Matrix.syncModels();
    assert.equal(r.engine, true);
    assert.deepEqual(r.models, ['brand/New-Model', 'mlx-community/Keep-Me-8bit']);
    assert.equal(r.changed, true);
    assert.deepEqual(Models.getProvider(prov.id).models, ['brand/New-Model', 'mlx-community/Keep-Me-8bit']);
  } finally { globalThis.fetch = async () => { throw new Error('offline in tests'); }; }
});

test('a directory that is not a model is neither listed nor deletable', async () => {
  Permissions.set({ matrix: true });
  // exo lets the owner park weights on another volume (EXO_MODELS_DIRS), and people put
  // other things beside them. Treating every subdirectory as an owned model put a DELETE
  // button on the owner's own data — the worst defect this subsystem could have.
  const vol = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-matrix-vol-'));
  process.env.EXO_MODELS_DIRS = vol;
  try {
    fs.mkdirSync(path.join(vol, 'datasets'), { recursive: true });
    fs.writeFileSync(path.join(vol, 'datasets', 'corpus.txt'), Buffer.alloc(4096));
    fs.mkdirSync(path.join(vol, 'scratch', 'notes'), { recursive: true });
    fs.writeFileSync(path.join(vol, 'scratch', 'notes', 'todo.md'), '# mine');
    // and one real model in the same root, to prove the filter is not just "refuse everything"
    seed(vol, 'vendor/Real-Model-4bit', { 'model.safetensors': 2048, 'config.json': 20 });

    const listed = Matrix.localModels().models.map((m) => m.id);
    assert.ok(listed.includes('vendor/Real-Model-4bit'), 'a real model in an extra root must be listed');
    assert.ok(!listed.includes('datasets'), 'a data directory is not a model');
    assert.ok(!listed.includes('scratch'), 'nor is a scratch directory');

    for (const notAModel of ['datasets', 'scratch']) {
      const r = await Matrix.purgeModel(notAModel);
      assert.equal(r.notFound, true, notAModel + ' must not resolve to anything deletable');
      assert.equal(r.freed, 0);
    }
    assert.ok(fs.existsSync(path.join(vol, 'datasets', 'corpus.txt')), "the owner's data must be untouched");
    assert.ok(fs.existsSync(path.join(vol, 'scratch', 'notes', 'todo.md')));
  } finally { delete process.env.EXO_MODELS_DIRS; }
});

test('an unfinished download is visible but never offered as usable', () => {
  const dir = seed(MODELS, 'mlx-community/Half-Way-4bit', { 'config.json': 120 });
  fs.writeFileSync(path.join(dir, 'model.safetensors.partial'), Buffer.alloc(9000));
  const row = Matrix.localModels().models.find((m) => m.id === 'mlx-community/Half-Way-4bit');
  assert.ok(row, 'the owner must see the space a half-downloaded model is using');
  assert.equal(row.partial, true, 'and it must be flagged, or the panel offers it for chat');
  assert.equal(row.bytes, 9120, 'the bytes are real bytes on disk, whether or not they are finished');
});

test('an absolute EXO_HOME resolves the way exo resolves it', () => {
  // Python's `Path.home() / EXO_HOME` discards the left side when the right is absolute.
  // path.join does not, so an absolute EXO_HOME made every model invisible — and every
  // delete a silent no-op reported as success.
  const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-matrix-exohome-'));
  process.env.EXO_HOME = alt;
  try {
    seed(path.join(alt, 'models'), 'alt/Elsewhere-4bit', { 'model.safetensors': 512 });
    assert.ok(Matrix.localModels().models.some((m) => m.id === 'alt/Elsewhere-4bit'),
      'a models root on another volume must be found, not hidden under ~/');
  } finally { delete process.env.EXO_HOME; }
});

test('a pid we cannot identify as the engine is never signalled', async () => {
  Permissions.set({ matrix: true });
  // The pidfile used to hold a bare integer. Pids are recycled; after a reboot the number
  // can belong to anything, and stop() would SIGTERM then SIGKILL a stranger. This test
  // records THIS process — a live pid that is provably not the engine.
  fs.mkdirSync(process.env.CLONE_FRAME_HUB_ROOT, { recursive: true });
  const pf = path.join(process.env.CLONE_FRAME_HUB_ROOT, 'matrix-engine.pid');
  fs.writeFileSync(pf, JSON.stringify({ pid: process.pid, bin: '/nowhere/exo', startedAt: Date.now() }), { mode: 0o600 });

  const s = await Matrix.status();
  assert.equal(s.ownedPid, null, 'a pid whose command is not the engine is not ours');
  assert.equal(fs.existsSync(pf), false, 'and the stale record is dropped rather than left armed on a button');

  fs.writeFileSync(pf, JSON.stringify({ pid: process.pid, bin: '/nowhere/exo' }), { mode: 0o600 });
  const r = await Matrix.stop();
  assert.equal(r.ok, false, 'stop must refuse rather than signal a stranger');
  assert.match(r.error, /not running/);
  assert.equal(process.killed === true, false, 'and this very test process is still here to assert it');
});

test('the engine log is read from the end, whatever its size', () => {
  const lf = path.join(process.env.CLONE_FRAME_HUB_ROOT, 'matrix-engine.log');
  // 3MB of noise then the line that matters. readFileSync on the whole file blocked the
  // daemon for its full size and, past Node's string cap, would have thrown outright.
  fs.writeFileSync(lf, 'x'.repeat(3 * 1024 * 1024) + '\nRuntimeError: the real reason\n');
  const out = Matrix.logs(5);
  assert.equal(out.ok, true);
  assert.ok(out.lines.join('\n').includes('RuntimeError: the real reason'), 'the tail must survive a huge log');
  assert.ok(out.lines.length <= 5);
});
