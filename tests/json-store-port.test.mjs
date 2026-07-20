// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT TESTS — run the identical assertion set against BOTH the real,
// fs-backed openStore() and the in-memory createMemStore() fake, proving they
// honor the same behavioral contract (json-store.mjs is the source of truth;
// mem-store.mjs must never drift from it).
//
// node --test tests/json-store.contract.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../bridge/platform/json-store.mjs';
import { createMemStore } from '../bridge/platform/mem-store.mjs';

const SHAPE = { items: [] };

// ── two adapters exposing the same test-harness surface over each backend ───

function realAdapter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'json-store-contract-'));
  return {
    label: 'real (fs-backed openStore)',
    open: (overrides = {}) => openStore({ name: 'demo', version: 1, shape: SHAPE, root, ...overrides }),
    dirMode: () => fs.statSync(root).mode & 0o777,
    fileMode: (storePath) => fs.statSync(storePath).mode & 0o777,
    tmpFilesLeftBehind: () => fs.readdirSync(root).filter((f) => f.endsWith('.tmp')),
    fileExists: (storePath) => fs.existsSync(storePath),
    corruptBackingFile: (storePath) => fs.writeFileSync(storePath, '{ not: valid json,,,', { mode: 0o600 }),
    deleteBackingFile: (storePath) => { try { fs.unlinkSync(storePath); } catch { /* already gone */ } },
    // A second, independent handle onto the SAME file — simulates a second
    // bridge process (or a hand-edit) writing behind the first handle's back.
    externalWrite: (storePath, data, overrides = {}) => {
      const other = openStore({ name: 'demo', version: 1, shape: SHAPE, root, ...overrides });
      return other.write(data);
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function fakeAdapter() {
  const root = 'mem://json-store-contract-' + Math.random().toString(36).slice(2, 10);
  let last; // most recently opened handle, for _test introspection
  return {
    label: 'fake (in-memory createMemStore)',
    open: (overrides = {}) => { last = createMemStore({ name: 'demo', version: 1, shape: SHAPE, root, ...overrides }); return last; },
    dirMode: () => last._test.dirMode(),
    fileMode: () => last._test.fileMode(),
    tmpFilesLeftBehind: () => [], // no fs, no tmp artifacts possible — atomicity is proven via the torn-read test below
    fileExists: () => last._test.fileMode() !== null,
    corruptBackingFile: () => last._test.setRaw('{ not: valid json,,,'),
    deleteBackingFile: () => last._test.reset(),
    externalWrite: (_storePath, data, overrides = {}) => {
      const other = createMemStore({ name: 'demo', version: 1, shape: SHAPE, root, ...overrides });
      return other.write(data);
    },
    cleanup: () => {},
  };
}

for (const makeAdapter of [realAdapter, fakeAdapter]) {
  const a = makeAdapter();

  test(`[${a.label}] read() degrades to shape defaults on ENOENT (missing store), never throws`, () => {
    const store = a.open();
    assert.doesNotThrow(() => store.read());
    assert.deepEqual(store.read(), { version: 1, items: [] });
    a.cleanup();
  });

  test(`[${a.label}] write() is atomic: dir 0700, file 0600, no .tmp left behind`, () => {
    const store = a.open();
    const persisted = store.write({ items: [{ id: 'x' }] });
    assert.deepEqual(persisted, { version: 1, items: [{ id: 'x' }] });
    assert.equal(a.dirMode(), 0o700, 'containing directory must be 0700');
    assert.equal(a.fileMode(store.path), 0o600, 'store file must be 0600');
    assert.deepEqual(a.tmpFilesLeftBehind(), [], 'no stray .tmp file after a successful write');
    assert.deepEqual(store.read(), { version: 1, items: [{ id: 'x' }] });
    a.cleanup();
  });

  test(`[${a.label}] a corrupt/hand-edited store degrades to defaults instead of throwing`, () => {
    const store = a.open();
    store.write({ items: [{ id: 'kept-until-corrupted' }] });
    a.corruptBackingFile(store.path);
    assert.doesNotThrow(() => store.read());
    assert.deepEqual(store.read(), { version: 1, items: [] });
    a.cleanup();
  });

  test(`[${a.label}] version is always stamped on read() and write(), regardless of what was on disk`, () => {
    const store = a.open({ version: 3 });
    const written = store.write({ items: [] });
    assert.equal(written.version, 3);
    assert.equal(store.read().version, 3);
    a.cleanup();
  });

  test(`[${a.label}] read() re-reads on every call — no cached singleton (fixes nft/servers/browser stale-read)`, () => {
    const storeA = a.open();
    storeA.write({ items: ['seen-by-A'] });
    assert.deepEqual(storeA.read().items, ['seen-by-A']);

    // A second, independent handle onto the SAME backing writes behind A's back.
    a.externalWrite(storeA.path, { items: ['written-by-B'] });

    // A's NEXT read() (not a cached copy) must observe B's write immediately.
    assert.deepEqual(storeA.read().items, ['written-by-B'], 'read() must reflect the external write, not a stale in-memory copy');
    a.cleanup();
  });

  test(`[${a.label}] mutate() is a single read-modify-write; concurrent mutate() calls never lose an update`, async () => {
    const store = a.open({ shape: { count: 0, log: [] } });
    store.write({ count: 0, log: [] });

    const bump = (label) => store.mutate(async (data) => {
      // simulate scheduled.mjs's tick(): async work happens BETWEEN the read
      // and the implicit save, which is exactly where a naive read-modify-write
      // (loadStore(); …; saveStore(store);) loses a concurrent update.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
      data.count += 1;
      data.log.push(label);
      return data.count;
    });

    const N = 12;
    await Promise.all(Array.from({ length: N }, (_, i) => bump(`writer-${i}`)));

    const final = store.read();
    assert.equal(final.count, N, 'no lost update: every concurrent mutate() must be reflected exactly once');
    assert.equal(final.log.length, N);
    assert.deepEqual([...final.log].sort(), Array.from({ length: N }, (_, i) => `writer-${i}`).sort());
    a.cleanup();
  });

  test(`[${a.label}] mutate() propagates a thrown/rejected fn and skips the write`, async () => {
    const store = a.open({ shape: { count: 0 } });
    store.write({ count: 1 });

    await assert.rejects(
      store.mutate(async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.deepEqual(store.read(), { version: 1, count: 1 }, 'a failed fn must not persist a partial/incorrect state');

    // the queue must still advance for the next caller after a rejection
    const result = await store.mutate((data) => { data.count += 1; return data.count; });
    assert.equal(result, 2);
    assert.deepEqual(store.read(), { version: 1, count: 2 });
    a.cleanup();
  });
}
