// ─────────────────────────────────────────────────────────────────────────────
// T-006 · Characterization tests — the Anthropic wire shape
// Target (READ, never modified):
//   /Users/you/Desktop/iFRAME/apps/clone-frame-hub/bridge/llm.mjs
//   (mirrors the non-streaming half of hub-bridge.mjs's own loadKey()+fetch —
//   see tests/sse-stream-parse.test.mjs for the streaming half of hub-bridge.mjs)
//
// llm.mjs's `ask()` is a small, DIRECTLY IMPORTABLE, dependency-free function —
// unlike hub-bridge.mjs it has no top-level server-start side effects, so we
// exercise the REAL exported function against a mocked global.fetch rather
// than re-implementing its logic. This pins:
//   • the endpoint URL
//   • the exact request headers (content-type, x-api-key, anthropic-version)
//   • the request body shape (model / max_tokens / messages / optional system)
//   • default model + default max_tokens when the caller omits them
//   • response parsing: only `type:"text"` content blocks are kept and joined
//   • the error path: !r.ok -> throws with status + a 300-char body snippet
//   • the "no key" path: throws a specific message, no network call attempted
//
// Zero dependencies: global.fetch is monkey-patched for the duration of each
// test and restored in `finally`. No real network call is ever made.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LLM_PATH = new URL('../bridge/llm.mjs', import.meta.url);
const HUB_BRIDGE_PATH = new URL('../bridge/hub-bridge.mjs', import.meta.url);

// llm.mjs reads ANTHROPIC_API_KEY at CALL time (not import time), so no fresh
// import / cache-busting is needed here — one shared import is fine.
const { ask, hasBrain } = await import(LLM_PATH);

function withFetchMock(mockFn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mockFn;
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original; });
}

function withEnv(vars, run) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test('ask() — request shape: URL, headers, anthropic-version, body', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'sk-test-key-123' }, async () => {
    let captured = null;
    await withFetchMock(
      async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          json: async () => ({ content: [{ type: 'text', text: 'hi there' }] }),
        };
      },
      async () => {
        const out = await ask([{ role: 'user', content: 'hello' }], {
          system: 'be nice', model: 'claude-x-1', maxTokens: 77,
        });
        assert.equal(out, 'hi there');
      },
    );

    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.init.method, 'POST');
    assert.deepEqual(captured.init.headers, {
      'content-type': 'application/json',
      'x-api-key': 'sk-test-key-123',
      'anthropic-version': '2023-06-01',
    });
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body, {
      model: 'claude-x-1',
      max_tokens: 77,
      messages: [{ role: 'user', content: 'hello' }],
      system: 'be nice',
    });
    // non-streaming: llm.mjs's ask() never sets `stream:true` on the body —
    // that only happens in hub-bridge.mjs's handleChat (see sse-stream-parse test).
    assert.equal('stream' in body, false);
  });
});

test('ask() — defaults: model falls back to DEFAULT_MODEL, max_tokens to 1024, system omitted when absent', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k', HUB_BRIDGE_MODEL: undefined }, async () => {
    let captured = null;
    await withFetchMock(
      async (url, init) => {
        captured = init;
        return { ok: true, json: async () => ({ content: [] }) };
      },
      () => ask([{ role: 'user', content: 'hi' }]),
    );
    const body = JSON.parse(captured.body);
    assert.equal(body.model, 'claude-sonnet-5'); // DEFAULT_MODEL fallback baked into llm.mjs
    assert.equal(body.max_tokens, 1024);
    assert.equal('system' in body, false);
  });
});

test('ask() — response parsing keeps only text-type content blocks, in order', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k' }, async () => {
    const out = await withFetchMock(
      async () => ({
        ok: true,
        json: async () => ({
          content: [
            { type: 'text', text: 'part one. ' },
            { type: 'tool_use', id: 'x', name: 'whatever', input: {} },
            { type: 'text', text: 'part two.' },
          ],
        }),
      }),
      () => ask([{ role: 'user', content: 'irrelevant to this test' }]),
    );
    assert.equal(out, 'part one. part two.');
  });
});

test('ask() — a non-array `messages` arg is wrapped as a single user message', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k' }, async () => {
    let captured = null;
    await withFetchMock(
      async (url, init) => { captured = init; return { ok: true, json: async () => ({ content: [] }) }; },
      () => ask('plain string prompt'),
    );
    const body = JSON.parse(captured.body);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'plain string prompt' }]);
  });
});

test('ask() — !r.ok throws with the HTTP status and a <=300-char body snippet', async () => {
  await withEnv({ ANTHROPIC_API_KEY: 'k' }, async () => {
    await withFetchMock(
      async () => ({ ok: false, status: 529, text: async () => 'x'.repeat(500) }),
      async () => {
        await assert.rejects(
          () => ask([{ role: 'user', content: 'hi' }]),
          (err) => {
            assert.match(err.message, /^anthropic 529 /);
            // exactly 300 chars of the body are kept, never the full 500.
            assert.equal(err.message.length, 'anthropic 529 '.length + 300);
            return true;
          },
        );
      },
    );
  });
});

test('ask() — with no ANTHROPIC_API_KEY reachable, throws before ever calling fetch', async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cfh-nokey-'));
  try {
    await withEnv({ ANTHROPIC_API_KEY: undefined, HOME: emptyHome }, async () => {
      let fetchCalled = false;
      await withFetchMock(
        async () => { fetchCalled = true; return { ok: true, json: async () => ({ content: [] }) }; },
        async () => {
          await assert.rejects(() => ask([{ role: 'user', content: 'hi' }]), /no ANTHROPIC_API_KEY on this machine/);
        },
      );
      assert.equal(fetchCalled, false);
      assert.equal(hasBrain(), false);
    });
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
});

// ── source-level pin: hub-bridge.mjs's OWN copy of this wire shape ──────────
// hub-bridge.mjs is not safely `import`-able here (top-level side effects:
// binds a real TCP port, writes a pairing token to ~/.clone-frame-hub — see
// the module header). Its streaming variant is characterized behaviorally in
// sse-stream-parse.test.mjs; this is a cheap tripwire so that if someone
// changes the endpoint, the API version, or the header set in hub-bridge.mjs
// WITHOUT updating llm.mjs (or vice versa), this test fails loudly instead of
// the two copies silently drifting apart before Wave-2 unifies them.
test('hub-bridge.mjs source still uses the same endpoint / api version as llm.mjs', () => {
  const src = fs.readFileSync(HUB_BRIDGE_PATH, 'utf8');
  assert.match(src, /https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(src, /'anthropic-version':\s*'2023-06-01'/);
  assert.match(src, /'x-api-key':\s*KEY/);
});
