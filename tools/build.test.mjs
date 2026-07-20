// CLONE FRAME HUB — build assertions (node:test, zero deps). Run after `node tools/build.mjs`.
// Locks in the guarantees that keep the app a single self-contained document that the bridge
// can still inject the pairing token into. See ARCHITECTURE/ (T-005).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'index.html');
const html = readFileSync(OUT, 'utf8');

// A1 — identity: the built document matches the frozen golden hash (byte-for-byte with the
// monolith at Step 0, and with the intended artifact after any reviewed re-freeze).
test('A1 identity — dist matches the frozen golden sha256', () => {
  const golden = readFileSync(path.join(ROOT, 'tools', 'golden', 'index.sha256'), 'utf8').trim();
  const got = createHash('sha256').update(html).digest('hex');
  assert.equal(got, golden, 'dist/index.html drifted from tools/golden/index.sha256 — rebuild, or re-freeze the golden deliberately in this commit');
});

// A2 — exactly one HTML file ships.
test('A2 single HTML — dist/ has exactly one .html', () => {
  const htmls = readdirSync(DIST).filter(f => f.endsWith('.html'));
  assert.deepEqual(htmls, ['index.html']);
});

// A3 — self-contained: no markup pulls app code over the network. Only data: URIs allowed.
test('A3 self-contained — no external <script src>/<link href> to app code', () => {
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*"([^"]*)"/gi)].map(m => m[1]);
  const external = refs.filter(u => !u.startsWith('data:'));
  assert.deepEqual(external, [], `unexpected external markup ref(s): ${external.join(', ')}`);
});

// A4 — the token-injection anchor survives: exactly one literal <head>, before </head>, and
// the bridge's literal replace('<head>', '<head>'+inject) lands __CFHUB_BRIDGE__ inside <head>.
test('A4 injection anchor — one literal <head> and it accepts the token inject', () => {
  const heads = [...html.matchAll(/<head>/g)];
  assert.equal(heads.length, 1, 'expected exactly one literal <head>');
  assert.ok(html.indexOf('<head>') < html.indexOf('</head>'), '<head> must precede </head>');
  const inject = '<script>window.__CFHUB_BRIDGE__={};</script>';
  const injected = html.replace('<head>', '<head>' + inject);
  const headBlock = injected.slice(injected.indexOf('<head>'), injected.indexOf('</head>'));
  assert.ok(headBlock.includes('__CFHUB_BRIDGE__'), 'inject did not land inside <head>');
});
