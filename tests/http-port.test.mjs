// ─────────────────────────────────────────────────────────────────────────────
// Wave-2 · Contract tests — bridge/platform/http.mjs (fetchJson + describeFetchError)
//
// Runs the IDENTICAL assertion battery against two implementations of the
// same small interface:
//   - the REAL module   (bridge/platform/http.mjs), driven by monkey-patching
//     `globalThis.fetch` — same technique as tests/anthropic-wire.test.mjs,
//     restored in `finally`, no real network call is ever made.
//   - the FAKE module    (bridge/platform/fakeHttp.mjs), driven by its own
//     seed/seedSequence API instead of touching `fetch` at all.
//
// A single `defineContractSuite(driver)` is called once per driver; both runs
// must produce byte-identical results for every case, which is the whole
// point of shipping a fake alongside the real port — code written against
// `fetchJson()` can be tested with the fake and trust that the real module
// behaves the same way in production.
//
// Both driver "run()" implementations share the exact same tiny queue
// semantics (a url's canned-entry queue is consumed FIFO once it has more
// than one entry; a single-entry queue replays forever) so that a
// retry-recovery scenario is expressible identically for both.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';

const HTTP_PATH = new URL('../bridge/platform/http.mjs', import.meta.url);
const FAKE_PATH = new URL('../bridge/platform/fakeHttp.mjs', import.meta.url);

const { fetchJson: realFetchJson, describeFetchError: realDescribeFetchError } = await import(HTTP_PATH);
const {
  fetchJson: fakeFetchJson,
  describeFetchError: fakeDescribeFetchError,
  reset: fakeReset,
  seedSequence: fakeSeedSequence,
  callCount: fakeCallCount,
} = await import(FAKE_PATH);

// ── shared helpers ───────────────────────────────────────────────────────────

function buildError(spec = {}) {
  const e = new Error(spec.message || 'network error');
  if (spec.name) e.name = spec.name;
  if (spec.cause) e.cause = spec.cause;
  return e;
}

function bodyText(body) {
  if (body === undefined) return '';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

// Response double matching exactly what http.mjs reads off a real fetch()
// Response: .ok, .status, async .text().
function fakeResponse(status, body) {
  const s = status ?? 200;
  return { ok: s >= 200 && s < 300, status: s, text: async () => bodyText(body) };
}

async function withFetchMock(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ── drivers ──────────────────────────────────────────────────────────────────
// entries: array of { status?, body? } | { throws: {name?, message?, cause?} }
// Same "shift while >1, else peek" queue rule the fake module implements.

const realDriver = {
  label: 'real (bridge/platform/http.mjs)',
  describeFetchError: realDescribeFetchError,
  async run(url, entries, options = {}) {
    const queue = [...entries];
    let callCount = 0;
    const impl = async () => {
      callCount++;
      const entry = queue.length > 1 ? queue.shift() : queue[0];
      if (!entry) throw new Error('test setup error: no entry queued');
      if (entry.throws) throw buildError(entry.throws);
      return fakeResponse(entry.status, entry.body);
    };
    const result = await withFetchMock(impl, () => realFetchJson(url, options));
    return { result, callCount };
  },
};

const fakeDriver = {
  label: 'fake (bridge/platform/fakeHttp.mjs)',
  describeFetchError: fakeDescribeFetchError,
  async run(url, entries, options = {}) {
    fakeReset();
    if (entries.length) {
      fakeSeedSequence(
        url,
        entries.map((e) => (e.throws ? { throws: buildError(e.throws) } : { status: e.status, body: e.body })),
      );
    }
    const result = await fakeFetchJson(url, options);
    return { result, callCount: fakeCallCount(url) };
  },
};

// ── the shared contract ──────────────────────────────────────────────────────

function defineContractSuite(driver) {
  test(`${driver.label} — 2xx JSON body -> { ok:true, status, data }`, async () => {
    const { result } = await driver.run('https://example.test/ok', [{ status: 200, body: { hello: 'world' } }]);
    assert.deepEqual(result, { ok: true, status: 200, data: { hello: 'world' } });
  });

  test(`${driver.label} — 2xx empty body -> data:null (not a failure)`, async () => {
    const { result } = await driver.run('https://example.test/empty', [{ status: 204 }]);
    assert.deepEqual(result, { ok: true, status: 204, data: null });
  });

  test(`${driver.label} — non-2xx surfaces status + best-effort parsed body, error "http <status>"`, async () => {
    const { result } = await driver.run('https://example.test/404', [{ status: 404, body: { message: 'not found' } }]);
    assert.deepEqual(result, { ok: false, status: 404, error: 'http 404', data: { message: 'not found' } });
  });

  test(`${driver.label} — non-2xx with empty body -> data:null, still status+error`, async () => {
    const { result } = await driver.run('https://example.test/500', [{ status: 500 }]);
    assert.deepEqual(result, { ok: false, status: 500, error: 'http 500', data: null });
  });

  test(`${driver.label} — 2xx malformed JSON is an EXPLICIT invalid-json failure, never silently swallowed`, async () => {
    const { result } = await driver.run('https://example.test/badjson', [{ status: 200, body: 'not { json' }]);
    assert.deepEqual(result, { ok: false, status: 200, error: 'invalid-json', data: null });
  });

  test(`${driver.label} — abort/timeout classified as "timeout", no status field`, async () => {
    const { result } = await driver.run('https://example.test/timeout', [
      { throws: { name: 'TimeoutError', message: 'The operation was aborted due to timeout' } },
    ]);
    assert.deepEqual(result, { ok: false, error: 'timeout' });
  });

  test(`${driver.label} — network failure with a Node error cause -> "<code>: <message>"`, async () => {
    const { result } = await driver.run('https://example.test/econnrefused', [
      { throws: { message: 'fetch failed', cause: { code: 'ECONNREFUSED' } } },
    ]);
    assert.deepEqual(result, { ok: false, error: 'ECONNREFUSED: fetch failed' });
  });

  test(`${driver.label} — retries:1 recovers after one network failure (2 attempts made)`, async () => {
    const { result, callCount } = await driver.run(
      'https://example.test/flaky',
      [{ throws: { message: 'fetch failed' } }, { status: 200, body: { recovered: true } }],
      { retries: 1 },
    );
    assert.deepEqual(result, { ok: true, status: 200, data: { recovered: true } });
    assert.equal(callCount, 2);
  });

  test(`${driver.label} — retries:1 does NOT retry a well-formed non-2xx response (1 attempt only)`, async () => {
    const { result, callCount } = await driver.run(
      'https://example.test/no-retry-on-http-error',
      [{ status: 400, body: { message: 'bad request' } }, { status: 200, body: { unexpected: true } }],
      { retries: 1 },
    );
    assert.deepEqual(result, { ok: false, status: 400, error: 'http 400', data: { message: 'bad request' } });
    assert.equal(callCount, 1);
  });

  test(`${driver.label} — retries exhausted -> classified network error, no status (2 attempts made)`, async () => {
    const { result, callCount } = await driver.run(
      'https://example.test/always-down',
      [{ throws: { message: 'fetch failed' } }],
      { retries: 1 },
    );
    assert.deepEqual(result, { ok: false, error: 'fetch failed' });
    assert.equal(callCount, 2);
  });

  test(`${driver.label} — empty/invalid url is rejected before any I/O`, async () => {
    const { result, callCount } = await driver.run('', [], {});
    assert.deepEqual(result, { ok: false, error: 'invalid-url' });
    assert.equal(callCount, 0);
  });

  test(`${driver.label} — describeFetchError classifies all shapes consistently`, () => {
    assert.equal(driver.describeFetchError({ status: 403, ok: false }), 'http 403');
    assert.equal(driver.describeFetchError(Object.assign(new Error('x'), { name: 'AbortError' })), 'timeout');
    assert.equal(
      driver.describeFetchError(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })),
      'ENOTFOUND: fetch failed',
    );
    assert.equal(driver.describeFetchError(new Error('plain failure')), 'plain failure');
    assert.equal(driver.describeFetchError(null), 'unknown error');
  });
}

defineContractSuite(realDriver);
defineContractSuite(fakeDriver);

// ── options superset sanity (real module only — request-shape details the
// fake doesn't need to model since it never touches globalThis.fetch) ────────

test('real fetchJson — POST with a plain-object body is JSON.stringify\'d and gets a content-type header (unless caller set one)', async () => {
  let captured = null;
  await withFetchMock(
    async (url, init) => {
      captured = { url, init };
      return fakeResponse(200, { ok: true });
    },
    () => realFetchJson('https://example.test/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } }),
  );
  assert.equal(captured.url, 'https://example.test/rpc');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.body, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
  assert.equal(captured.init.headers['content-type'], 'application/json');
});

test('real fetchJson — a caller-supplied content-type header is never overridden', async () => {
  let captured = null;
  await withFetchMock(
    async (url, init) => {
      captured = init;
      return fakeResponse(200, {});
    },
    () => realFetchJson('https://example.test/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.custom+json' },
      body: { a: 1 },
    }),
  );
  assert.equal(captured.headers['Content-Type'], 'application/vnd.custom+json');
  assert.equal(Object.keys(captured.headers).filter((k) => k.toLowerCase() === 'content-type').length, 1);
});

test('real fetchJson — a string body is sent verbatim, no content-type injected', async () => {
  let captured = null;
  await withFetchMock(
    async (url, init) => {
      captured = init;
      return fakeResponse(200, {});
    },
    () => realFetchJson('https://example.test/raw', { method: 'POST', body: 'already-a-string' }),
  );
  assert.equal(captured.body, 'already-a-string');
  assert.equal(hasContentType(captured.headers), false);
});

function hasContentType(headers) {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
}

test('real fetchJson — GET is the default method when omitted', async () => {
  let captured = null;
  await withFetchMock(
    async (url, init) => {
      captured = init;
      return fakeResponse(200, {});
    },
    () => realFetchJson('https://example.test/default-method'),
  );
  assert.equal(captured.method, 'GET');
});
