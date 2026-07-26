// PKCE (RFC 7636, S256) + single-use state coverage for the loopback flow in
// oauth.mjs. oauth-context.test.mjs deliberately excludes beginAuth() because
// it "hits Google" — this file exercises that exact path with ZERO network:
// the loopback server IS real (http.createServer on 127.0.0.1, same as
// production), but the two outbound calls it makes (token endpoint,
// userinfo endpoint) go through a stubbed `globalThis.fetch`, restored in a
// `finally` in every test that touches it.
//
// The test that matters is the cryptographic one: it does not just grep for
// a `code_challenge` query param, it recomputes base64url(sha256(verifier))
// from the code_verifier actually posted to the token endpoint and asserts
// it equals the code_challenge the module put in the authorization URL —
// a hardcoded constant could not pass that check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

async function freshOAuth() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-oauth-pkce-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/oauth.mjs?ctx=' + Math.random().toString(36).slice(2));
  return mod.OAuth;
}

function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

// Plain node:http client (never the stubbed global fetch) for the loopback
// redirect the "browser" would fire at oauth.mjs's temporary server.
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

test('authorization URL carries a base64url S256 code_challenge cryptographically tied to the verifier sent at token-exchange time; the verifier never leaks via status()/accounts()', async () => {
  const O = await freshOAuth();
  O.config({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'csecret' });

  const { ok, authUrl } = await O.beginAuth();
  assert.equal(ok, true);

  const authParams = new URL(authUrl).searchParams;
  const challenge = authParams.get('code_challenge');
  assert.equal(authParams.get('code_challenge_method'), 'S256');
  assert.ok(challenge, 'code_challenge must be present');
  // RFC 7636 base64url: no padding, no '+' or '/'.
  assert.match(challenge, /^[A-Za-z0-9_-]{43,}$/);

  let capturedBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    if (href.includes('/token')) {
      capturedBody = new URLSearchParams(opts.body);
      return jsonResponse(200, { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600 });
    }
    if (href.includes('userinfo')) return jsonResponse(200, { email: 'pkce-test@gmail.com' });
    throw new Error(`unexpected fetch to ${href}`);
  };

  try {
    const redirectUri = authParams.get('redirect_uri');
    const state = authParams.get('state');
    const res = await httpGet(`${redirectUri}?code=fake-auth-code&state=${encodeURIComponent(state)}`);
    assert.equal(res.status, 200);

    assert.ok(capturedBody, 'the token endpoint must have been called');
    const verifier = capturedBody.get('code_verifier');
    assert.ok(verifier, 'code_verifier must be sent in the authorization_code exchange');

    // THE assertion: recompute the challenge from the verifier actually
    // posted, and check it against the challenge minted earlier — proves the
    // two are cryptographically related, not just two independently-present params.
    const recomputed = createHash('sha256').update(verifier).digest('base64url');
    assert.equal(recomputed, challenge);

    // the verifier must never surface through any read-path projection
    assert.equal(JSON.stringify(O.status()).includes(verifier), false);
    assert.equal(JSON.stringify(O.accounts()).includes(verifier), false);
    assert.equal(O.pollAuth().email, 'pkce-test@gmail.com'); // sanity: the flow actually completed
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('two consecutive beginAuth() calls mint different code_challenge values (fresh verifier every call)', async () => {
  const O = await freshOAuth();
  O.config({ clientId: 'cid', clientSecret: 'csecret' });

  const first = await O.beginAuth();
  const second = await O.beginAuth(); // supersedes + closes the first server
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const c1 = new URL(first.authUrl).searchParams.get('code_challenge');
  const c2 = new URL(second.authUrl).searchParams.get('code_challenge');
  assert.notEqual(c1, c2);

  // close the still-open second server via a real "denied" callback, so the
  // test process has no lingering listener to exit around
  const params = new URL(second.authUrl).searchParams;
  const res = await httpGet(`${params.get('redirect_uri')}?error=access_denied&state=${encodeURIComponent(params.get('state'))}`);
  assert.equal(res.status, 400);
});

test('state is single-use: a duplicate redirect racing the first mid-exchange is rejected, the legitimate one still completes', async () => {
  const O = await freshOAuth();
  O.config({ clientId: 'cid', clientSecret: 'csecret' });

  const { authUrl } = await O.beginAuth();
  const params = new URL(authUrl).searchParams;
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');

  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let signalTokenCallStarted;
  const tokenCallStarted = new Promise((resolve) => { signalTokenCallStarted = resolve; });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    if (href.includes('/token')) {
      signalTokenCallStarted(); // fires AFTER stateUsed is set (same sync frame in the handler)
      await gate; // held open so the duplicate redirect below can race the real one
      return jsonResponse(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
    }
    if (href.includes('userinfo')) return jsonResponse(200, { email: 'race@gmail.com' });
    throw new Error(`unexpected fetch to ${href}`);
  };

  try {
    const callbackUrl = `${redirectUri}?code=real-code&state=${encodeURIComponent(state)}`;
    const firstReq = httpGet(callbackUrl); // in-flight, parked at the fetch gate mid-exchange
    await tokenCallStarted; // guarantees stateUsed=true has already run for the first request

    const dupRes = await httpGet(callbackUrl); // duplicate redirect while the first is still pending
    assert.equal(dupRes.status, 400);

    releaseGate();
    const firstRes = await firstReq;
    assert.equal(firstRes.status, 200, 'the legitimate, first-in callback must still complete');
    assert.equal(O.pollAuth().email, 'race@gmail.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
