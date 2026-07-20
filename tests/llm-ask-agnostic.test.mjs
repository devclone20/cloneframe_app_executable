// T-019 integration test: llm.ask() is provider-AGNOSTIC (no longer Claude-locked).
// Proves the lock removal end-to-end: with a non-Anthropic (OpenAI-compatible)
// provider configured in the registry, ask() dispatches to THAT provider's
// /chat/completions with the provider's OWN model — never api.anthropic.com,
// never DEFAULT_MODEL. A real local HTTP server stands in for the provider (no
// stubbing of globals). Node's test runner isolates each file in its own process,
// so the model port's lazy singleton binds cleanly to this test's tmp registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('ask() honours a configured OpenAI-compatible provider (not Anthropic, not DEFAULT_MODEL)', async () => {
  // 1) a local "provider" that records what it was asked and answers OpenAI-style.
  let seen = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'AGNOSTIC-OK' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 2) a throwaway registry configuring ONLY that provider.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-llm-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  delete process.env.ANTHROPIC_API_KEY; // ensure no env-Anthropic fallback is even available
  fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({
    version: 1,
    providers: [{ id: 'local-oai', provider: 'openai', baseUrl, apiKey: 'test-key', kind: 'api', models: ['my-local-model'], enabled: true }],
    defaults: {},
  }));

  // 3) call the freshly-imported ask() and assert the agnostic dispatch.
  const { ask } = await import('../bridge/llm.mjs?ctx=' + Math.random().toString(36).slice(2));
  const out = await ask([{ role: 'user', content: 'hi' }], { system: 'be brief', maxTokens: 64 });

  assert.equal(out, 'AGNOSTIC-OK', 'must return the configured provider response');
  assert.ok(seen, 'the configured provider must have been called');
  assert.match(seen.url, /\/chat\/completions$/, 'OpenAI-compatible wire, not /v1/messages');
  assert.equal(seen.auth, 'Bearer test-key', 'the provider Bearer key, not an x-api-key');
  assert.equal(seen.body.model, 'my-local-model', 'the provider OWN model — NOT DEFAULT_MODEL/claude');
  assert.doesNotMatch(JSON.stringify(seen.body), /claude/i, 'no Claude model id leaked into the request');

  await new Promise((r) => server.close(r));
});
