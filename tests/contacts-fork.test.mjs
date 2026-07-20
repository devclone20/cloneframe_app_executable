// Fork-consolidation test for contacts.mjs AFTER its CardDAV code moved onto
// platform/dav.mjs (carddavSync's inline REPORT fetch + regex multistatus
// scanner + XML entity decoder are gone; davFetch + parseMultistatus now do
// that work). Proves the swap is behavior-preserving for RPC clients:
//   • the outgoing REPORT request shape is byte-identical (method, Depth,
//     Content-Type, Basic auth, body) — a wrong DAV argv breaks live hosts;
//   • the vCard multistatus → merge → persist pipeline yields the same
//     contacts, written to a throwaway CLONE_FRAME_HUB_ROOT store;
//   • the former NO-TIMEOUT bug is fixed — davFetch always attaches an
//     AbortSignal timeout, so a dead host can no longer hang the caller.
//
// Fully OFFLINE: globalThis.fetch is stubbed (davFetch wraps it), so the real
// port transport runs without a socket. No real network is ever touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { authHeader } from '../bridge/platform/dav.mjs';
import { CARDDAV_MULTISTATUS_XML } from '../bridge/platform/fakeDav.mjs';

async function freshContacts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-contacts-fork-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/contacts.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, C: mod.Contacts, file: path.join(root, 'contacts.json') };
}

function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return { calls, restore() { globalThis.fetch = orig; } };
}

function davResponse({ status = 207, statusText = '', body = '' } = {}) {
  return { ok: status >= 200 && status < 300, status, statusText, async text() { return body; } };
}

function header(headers, name) {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === name.toLowerCase());
  return k ? headers[k] : undefined;
}

test('carddavSync: REPORT request shape is preserved and now carries a timeout signal', async () => {
  const { C } = await freshContacts();
  const net = stubFetch(() => davResponse({ status: 207, body: CARDDAV_MULTISTATUS_XML }));
  try {
    const res = await C.carddavSync({ url: 'https://dav.example.com/card/', user: 'alex', pass: 's3cr3t' });
    assert.deepEqual(res, { ok: true, imported: 1 });

    assert.equal(net.calls.length, 1);
    const { url, opts } = net.calls[0];
    assert.equal(url, 'https://dav.example.com/card/');
    assert.equal(opts.method, 'REPORT');
    assert.equal(opts.redirect, 'follow');
    assert.equal(header(opts.headers, 'Depth'), '1');
    assert.equal(header(opts.headers, 'Content-Type'), 'application/xml; charset=utf-8');
    assert.equal(header(opts.headers, 'Authorization'), authHeader({ user: 'alex', pass: 's3cr3t' }));
    assert.match(opts.body, /addressbook-query/);
    assert.match(opts.body, /<C:address-data\/>/);

    // the no-timeout bug fix: davFetch always attaches an AbortSignal timeout.
    assert.ok(opts.signal instanceof AbortSignal, 'a timeout signal must be attached');
  } finally {
    net.restore();
  }
});

test('carddavSync: multistatus → vCard → merge → persist yields the parsed contact', async () => {
  const { C, file } = await freshContacts();
  const net = stubFetch(() => davResponse({ status: 207, body: CARDDAV_MULTISTATUS_XML }));
  try {
    const res = await C.carddavSync({ url: 'https://dav.example.com/card/', user: 'a', pass: 'b' });
    assert.equal(res.imported, 1);

    const list = C.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].displayName, 'Ada Lovelace');
    assert.deepEqual(list[0].emails, ['ada@example.com']);
    assert.equal(list[0].org, 'Analytical Engines & Co'); // &amp; decoded by the port
    assert.equal(list[0].source, 'carddav');

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.contacts.length, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    net.restore();
  }
});

test('carddavSync: no creds → no Authorization header (request shape preserved)', async () => {
  const { C } = await freshContacts();
  const net = stubFetch(() => davResponse({ status: 207, body: '<multistatus/>' }));
  try {
    const res = await C.carddavSync({ url: 'https://dav.example.com/card/' });
    assert.deepEqual(res, { ok: true, imported: 0 });
    assert.equal(header(net.calls[0].opts.headers, 'Authorization'), undefined);
  } finally {
    net.restore();
  }
});

test('carddavSync: non-2xx/207 status returns the same HTTP error shape, without touching the store', async () => {
  const { C } = await freshContacts();
  const net = stubFetch(() => davResponse({ status: 401, statusText: 'Unauthorized', body: '' }));
  try {
    const res = await C.carddavSync({ url: 'https://dav.example.com/card/', user: 'x', pass: 'y' });
    assert.deepEqual(res, { ok: false, error: 'carddavSync: HTTP 401 Unauthorized' });
    assert.equal(C.count(), 0);
  } finally {
    net.restore();
  }
});

test('carddavSync: url guard rejects before any network call (offline, no fetch)', async () => {
  const { C } = await freshContacts();
  const net = stubFetch(() => { throw new Error('fetch must not be called'); });
  try {
    assert.deepEqual(C.carddavSync ? await C.carddavSync({}) : null, {
      ok: false,
      error: 'carddavSync: url is required',
    });
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test('carddavSync: adopting the port widens entity decoding to numeric refs (superset)', async () => {
  // The old inline decoder handled only the 5 named XML entities; the port
  // also decodes decimal/hex numeric character refs. Proven here so the
  // widening is intentional, not accidental.
  const { C } = await freshContacts();
  const xml = CARDDAV_MULTISTATUS_XML.replace('FN:Ada Lovelace', 'FN:&#65;da Lovelace');
  const net = stubFetch(() => davResponse({ status: 207, body: xml }));
  try {
    await C.carddavSync({ url: 'https://dav.example.com/card/', user: 'a', pass: 'b' });
    assert.equal(C.list()[0].displayName, 'Ada Lovelace'); // &#65; → 'A'
  } finally {
    net.restore();
  }
});
