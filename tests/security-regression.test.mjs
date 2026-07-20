// ─────────────────────────────────────────────────────────────────────────────
// T-071 (L7) · Security regression suite — GAP-FILLING ONLY.
//
// The 8 PLAN §8 invariants each need BOTH a positive (allowed path works) and a
// negative (attack blocked) regression. Most already exist; this file adds ONLY
// the cases that were missing, and never duplicates what other suites already own.
//
// Coverage already owned elsewhere (NOT repeated here):
//   1. loopback bind + pairing-token auth  → tests/ssrf-and-auth.test.mjs
//   2. constant-time token compare         → tests/ssrf-and-auth.test.mjs (authed())
//   3. SSRF first-URL block                → tests/ssrf-and-auth.test.mjs (fetchUrl literals)
//   4. soul-origin base allow/deny         → tests/nft-fork.test.mjs (configSoul irys/evil)
//   5. cli-gate fail-closed                → tests/cli-gate-port.test.mjs (full)
//   6. catastrophic guard block/allow      → tests/destructive-guard.test.mjs + shell-guard-port
//   7. redact / scrubText                  → tests/redact-port.test.mjs (full)
//   8. media-URL scheme guard              → tests/kernel.test.mjs (safeMediaUrl/safeImageUrl, full)
//
// GAPS this file closes (see per-section headers):
//   • INV-1  Sec-Fetch-Dest gate on the static server (positive + negative) — untested.
//   • INV-3  SSRF PER-REDIRECT re-validation (a 30x to a private host mid-chain must be
//            rejected, not just the first URL) — positive follow + negative block, untested.
//   • INV-4  soul-origin GitHub-org sub-allowlist boundary + scheme normalization — untested.
//   • INV-6  catastrophic guard is invoked UNCONDITIONALLY (root mode cannot bypass it) — untested.
//
// Hermetic: no network (globalThis.fetch is fully mocked and restored), no real FS
// writes outside an os.tmpdir() throwaway, no live keys/secrets.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { serveStatic } from '../bridge/transport/static.mjs';
import { isDestructive } from '../bridge/platform/shell-guard.mjs';

const { fetchUrl } = await import(new URL('../bridge/web.mjs', import.meta.url));

const PTY_PATH = new URL('../bridge/pty.mjs', import.meta.url);
const SSH_PATH = new URL('../bridge/ssh.mjs', import.meta.url);

// A distinctive, obviously-fake fixture token. NOT a real secret.
const FAKE_TOKEN = 'PAIRTOKEN_test_fixture_not_a_real_secret_000';

// ═════════════════════════════════════════════════════════════════════════════
// INV-1 · Sec-Fetch-Dest gate on the bridge's static server.
// serveStatic() injects the pairing token into served HTML ONLY on a REAL top-level
// navigation (sec-fetch-dest: 'document'). A malicious page's fetch() sends
// dest:'empty' (a forbidden header it cannot forge) and a non-browser client sends
// nothing — both must be denied the token inject, or the token leaks cross-origin /
// cross-user. This gate lives in bridge/transport/static.mjs and had no test.
// ═════════════════════════════════════════════════════════════════════════════

function fakeRes() {
  const rec = { status: null, headers: null, body: null, ended: false };
  return {
    _rec: rec,
    writeHead(status, headers) { rec.status = status; rec.headers = headers; },
    end(data) { rec.body = data; rec.ended = true; },
  };
}
function fakeReq(dest) {
  return { headers: dest === undefined ? {} : { 'sec-fetch-dest': dest } };
}
function staticRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head></head><body>hub</body></html>');
  return root;
}
function serveIndex(dest) {
  const root = staticRoot();
  try {
    const res = fakeRes();
    const handled = serveStatic(fakeReq(dest), res, '/index.html', {
      root, host: '127.0.0.1', port: 8765, token: FAKE_TOKEN,
    });
    return { handled, rec: res._rec, body: res._rec.body ? Buffer.from(res._rec.body).toString('utf8') : '' };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('INV-1 POSITIVE — a real top-level navigation (sec-fetch-dest:document) gets the pairing token injected', () => {
  const { handled, rec, body } = serveIndex('document');
  assert.equal(handled, true);
  assert.equal(rec.status, 200);
  assert.match(body, /__CFHUB_BRIDGE__/, 'the bridge bootstrap must be injected on a document navigation');
  assert.ok(body.includes(FAKE_TOKEN), 'the pairing token must reach a legitimate browser navigation');
  assert.equal(rec.headers['Content-Type'], 'text/html; charset=utf-8');
});

test('INV-1 NEGATIVE — a cross-origin fetch (sec-fetch-dest:empty) is served HTML but NEVER the token', () => {
  const { handled, rec, body } = serveIndex('empty');
  assert.equal(handled, true);
  assert.equal(rec.status, 200);
  assert.doesNotMatch(body, /__CFHUB_BRIDGE__/, 'no bootstrap may be injected for a fetch/XHR context');
  assert.ok(!body.includes(FAKE_TOKEN), 'the token must never be scrapeable via a forged fetch');
});

test('INV-1 NEGATIVE — a non-browser client (no sec-fetch-dest header) is also denied the token inject', () => {
  // curl run by ANOTHER local user sends no Sec-Fetch-* headers → dest undefined → no inject.
  const { handled, body } = serveIndex(undefined);
  assert.equal(handled, true);
  assert.ok(!body.includes(FAKE_TOKEN), 'a header-less client must not receive the token (anti cross-user theft)');
});

test('INV-1 — the injected call-back endpoint is the browser Host (loopback), NEVER the 0.0.0.0 bind address', () => {
  // Container mode binds 0.0.0.0, but a browser cannot fetch/WebSocket 0.0.0.0. serveStatic must
  // hand the page the origin the browser actually opened (its validated Host header), so RPC + the
  // terminal WS point at a real loopback. Regression guard for the container-mode endpoint fix.
  const root = staticRoot();
  try {
    const res = fakeRes();
    serveStatic({ headers: { 'sec-fetch-dest': 'document', host: '127.0.0.1:8765' } }, res, '/index.html',
      { root, host: '0.0.0.0', port: 8765, token: FAKE_TOKEN });
    const body = res._rec.body ? Buffer.from(res._rec.body).toString('utf8') : '';
    assert.ok(body.includes('"endpoint":"http://127.0.0.1:8765"'), 'endpoint must be the loopback Host the browser opened');
    assert.ok(!body.includes('0.0.0.0'), 'the 0.0.0.0 bind address must never be handed to the browser');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// INV-3 · SSRF guard re-validates on EVERY redirect hop.
// The first-URL block is already covered (ssrf-and-auth.test.mjs). The dangerous,
// subtler case is a PUBLIC first URL that 30x-redirects to a private/loopback/
// link-local host: web.mjs follows redirects manually (redirect:'manual') and must
// re-run assertSafeUrl() before each hop, so the private hop is rejected BEFORE any
// request is made to it. Driven through the REAL exported fetchUrl() with a fully
// mocked globalThis.fetch (documentation-range literal IPs → the SSRF pre-check
// never does DNS; zero real network I/O).
// ═════════════════════════════════════════════════════════════════════════════

// Response double shaped exactly like what web.mjs reads off a manual-redirect fetch:
// .status/.ok, .headers.get('location'|'content-type'|'set-cookie'), .headers.getSetCookie(), .body.
function mkRes({ status = 200, location = null, contentType = 'text/html', body = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(k) {
        const key = String(k).toLowerCase();
        if (key === 'location') return location;
        if (key === 'content-type') return contentType;
        return null; // incl. set-cookie
      },
      getSetCookie: () => [],
    },
    body, // null → web.mjs's readCapped returns '' (no stream needed)
  };
}

// Route by exact URL; records every URL fetch() is actually asked to hit so we can
// prove the private hop was blocked BEFORE the network call, not after.
function installRoutedFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const spec = routes[u];
    if (!spec) throw Object.assign(new Error('unrouted (test would have made a real call): ' + u), { code: 'ENOTFOUND' });
    return mkRes(spec);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const PUBLIC_A = 'http://203.0.113.10/start';   // TEST-NET-3 — public to the guard, never a real host
const PUBLIC_B = 'http://198.51.100.20/final';  // TEST-NET-2 — same

test('INV-3 NEGATIVE — a 30x from a PUBLIC url to a private/loopback/link-local host is rejected mid-redirect (no request to the private hop)', async () => {
  const privateTargets = [
    'http://127.0.0.1/internal',
    'http://10.0.0.5/admin',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata pivot
    'http://[::1]/x',
    'http://localhost/x',
  ];
  for (const evil of privateTargets) {
    const { calls, restore } = installRoutedFetch({
      [PUBLIC_A]: { status: 302, location: evil },
      // NOTE: `evil` is deliberately NOT routed — if the guard let the redirect through,
      // fetch() would be asked to hit it and the routing table would throw, failing loudly.
    });
    try {
      const r = await fetchUrl(PUBLIC_A);
      assert.equal(r.ok, false, `redirect to ${evil} must fail`);
      assert.equal(r.error, 'blocked', `redirect to ${evil} must be classified 'blocked'`);
      assert.deepEqual(calls, [PUBLIC_A], `the private hop (${evil}) must NEVER be fetched — guard re-checks before the hop`);
    } finally {
      restore();
    }
  }
});

test('INV-3 POSITIVE — a 30x between two PUBLIC hosts is followed to completion (guard does not over-block)', async () => {
  const { calls, restore } = installRoutedFetch({
    [PUBLIC_A]: { status: 302, location: PUBLIC_B },
    [PUBLIC_B]: { status: 200, contentType: 'text/html', body: null },
  });
  try {
    const r = await fetchUrl(PUBLIC_A);
    assert.equal(r.ok, true, 'a public→public redirect must succeed');
    assert.deepEqual(calls, [PUBLIC_A, PUBLIC_B], 'both public hops are fetched, in order');
  } finally {
    restore();
  }
});

test('INV-3 NEGATIVE — a redirect chain whose FINAL hop is private is still blocked (multi-hop, public→public→loopback)', async () => {
  const MID = 'http://203.0.113.77/mid';
  const { calls, restore } = installRoutedFetch({
    [PUBLIC_A]: { status: 301, location: MID },
    [MID]: { status: 302, location: 'http://127.0.0.1:8765/pair' }, // pivot at the LAST hop
    // the loopback pair endpoint is intentionally unrouted — must never be reached.
  });
  try {
    const r = await fetchUrl(PUBLIC_A);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'blocked');
    assert.deepEqual(calls, [PUBLIC_A, MID], 'the loopback pairing endpoint must never be fetched');
  } finally {
    restore();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// INV-4 · Soul-origin allowlist — GitHub-org sub-allowlist boundary + scheme
// normalization. The base allow (irys) / deny (evil.example.com) is already in
// nft-fork.test.mjs. UNTESTED: raw.githubusercontent.com is allowed ONLY under the
// owner org (SOUL_GH_PREFIX = .../devclone20/). A soul becomes a SYSTEM PROMPT
// (privileged input), so a lookalike/other-org GitHub URL smuggling a hostile soul
// must be refused. Exercised through the REAL exported NFT.configSoul() (which runs
// soulUrl()∘soulOriginOk()), with $HOME pointed at a throwaway dir BEFORE import so
// the module's JSON store writes only inside temp (mirrors nft-fork.test.mjs).
// ═════════════════════════════════════════════════════════════════════════════

async function freshNft() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-soul-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const mod = await import('../bridge/nft.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { NFT: mod.NFT, home, restore: () => { process.env.HOME = savedHome; fs.rmSync(home, { recursive: true, force: true }); } };
}

test('INV-4 POSITIVE — a soul URL under the owner GitHub org (devclone20) is allowlisted', async () => {
  const { NFT, restore } = await freshNft();
  try {
    const r = NFT.configSoul({ tokenId: 55101, url: 'https://raw.githubusercontent.com/devclone20/iclone/main/agent/iclone/neural_soul.md' });
    assert.equal(r.ok, true, 'the owner org must be allowed to serve souls');
  } finally { restore(); }
});

test('INV-4 NEGATIVE — a DIFFERENT GitHub org cannot serve a soul (org boundary holds)', async () => {
  const { NFT, restore } = await freshNft();
  try {
    const r = NFT.configSoul({ tokenId: 55101, url: 'https://raw.githubusercontent.com/attacker/evil-agent/main/neural_soul.md' });
    assert.deepEqual(r, { ok: false, error: 'origin not allowlisted for souls' });
  } finally { restore(); }
});

test('INV-4 NEGATIVE — org-prefix glue and lookalike host cannot slip past the startsWith allowlist', async () => {
  const { NFT, restore } = await freshNft();
  try {
    // "devclone20-evil" shares the org PREFIX but the required trailing "/" forces a real boundary.
    assert.deepEqual(
      NFT.configSoul({ tokenId: 55101, url: 'https://raw.githubusercontent.com/devclone20-evil/x/main/neural_soul.md' }),
      { ok: false, error: 'origin not allowlisted for souls' },
      'devclone20-evil must not be mistaken for devclone20',
    );
    // A domain that merely CONTAINS the trusted host as a subdomain-of-attacker.
    assert.deepEqual(
      NFT.configSoul({ tokenId: 55101, url: 'https://raw.githubusercontent.com.evil.example/devclone20/x/neural_soul.md' }),
      { ok: false, error: 'origin not allowlisted for souls' },
      'a lookalike host suffix must not be accepted',
    );
  } finally { restore(); }
});

test('INV-4 — scheme normalization preserves the allowlist (ar:// allowed, non-https / non-allowlisted refused)', async () => {
  const { NFT, restore } = await freshNft();
  try {
    // ar:// normalizes to arweave.net (an allowlisted origin) → allowed.
    assert.equal(NFT.configSoul({ tokenId: 55101, url: 'ar://' + 'a'.repeat(43) }).ok, true, 'ar:// → arweave.net is allowlisted');
    // A plaintext http:// pointer is not a fetchable soul scheme (soulUrl → '') → refused.
    assert.deepEqual(
      NFT.configSoul({ tokenId: 55101, url: 'http://gateway.irys.xyz/abc' }),
      { ok: false, error: 'origin not allowlisted for souls' },
      'a non-https irys pointer must not be treated as allowlisted',
    );
  } finally { restore(); }
});

// ═════════════════════════════════════════════════════════════════════════════
// INV-6 · The catastrophic-command guard is applied ALWAYS — including with root
// mode on. Block/allow behavior is covered (destructive-guard.test.mjs). What is
// NOT pinned: that pty.mjs/ssh.mjs invoke the guard UNCONDITIONALLY and never wire
// it behind the rootMode permission (rootMode means "sudo is permitted", never
// "skip the safety guard"). A live PTY under root mode can't be spawned hermetically,
// so the closest sound assertion is (a) the guard is a mode-FREE pure function, and
// (b) a source-level tripwire that its call in both exec paths is not coupled to
// rootMode. LIMITATION: this pins structure, not a running root-mode spawn.
// ═════════════════════════════════════════════════════════════════════════════

test('INV-6 — the catastrophic guard is a mode-free pure function (no root/flag argument can weaken it)', () => {
  for (const cmd of ['rm -rf /', 'rm -rf /*', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=/dev/sda', ':(){ :|:& };:'])
    assert.equal(isDestructive(cmd), true, `must block regardless of any mode: ${cmd}`);
  assert.equal(isDestructive.length, 1, 'isDestructive takes ONE argument — there is no mode/root switch to bypass it');
});

test('INV-6 — pty.mjs and ssh.mjs call the guard UNCONDITIONALLY; rootMode cannot skip it (source tripwire)', () => {
  const ptySrc = fs.readFileSync(PTY_PATH, 'utf8');
  const sshSrc = fs.readFileSync(SSH_PATH, 'utf8');
  // the refusal is present in both exec entry points...
  assert.match(ptySrc, /if \(isDestructive\(line\)\) return \{ ok: false/, 'pty.mjs must refuse catastrophic lines');
  assert.match(sshSrc, /if \(isDestructive\(cmd\)\) return \{ ok: false/, 'ssh.mjs must refuse catastrophic commands');
  // ...and NEITHER module couples that guard to rootMode. If a future edit introduces
  // `rootMode` into these modules to gate the guard, this tripwire fires (rootMode is
  // owned exclusively by permissions.mjs and must never reach the exec path here).
  assert.ok(!/rootMode/.test(ptySrc), 'pty.mjs must not reference rootMode near the exec/guard path');
  assert.ok(!/rootMode/.test(sshSrc), 'ssh.mjs must not reference rootMode near the exec/guard path');
});
