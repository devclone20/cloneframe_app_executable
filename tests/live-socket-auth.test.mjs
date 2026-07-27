// Every live socket in the app — the iT terminal, the BROWSER, the HARNESS stream, the `it`
// CLI control channel — needs the same two facts: where the bridge is, and what the token is.
//
// They each read window.__CFHUB_BRIDGE__ directly, and that global is a ONE-SHOT: the server
// injects it only during the launch window (PAIR_WINDOW_MS, 120s — bridge/transport/static.mjs).
// Any reload after that window served a page without it, so every live terminal pane printed
// "HUB Bridge not connected" while MY MACHINE and every RPC panel went on reporting connected,
// because the HTTP side reads sessionStorage + the app store instead. Same daemon, same token,
// two opposite answers on screen — and the app's own Settings text promises the opposite
// ("a reload reattaches to the SAME live shells").
//
// The stores survive a reload. The injected global is a bootstrap seed and nothing more.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
const app = read('web/index.html');
const dist = fs.existsSync(path.join(HERE, '..', 'dist', 'index.html')) ? read('dist/index.html') : '';

test('there is ONE accessor for live-socket auth, and it prefers the stores', () => {
  assert.match(app, /const wsAuth=\(\)=>\{/, 'BridgeClient must expose a single wsAuth accessor');
  const fn = app.slice(app.indexOf('const wsAuth=()=>{'), app.indexOf('};', app.indexOf('const wsAuth=()=>{')));
  // Order matters: the persistent stores first, the injected seed only as a fallback.
  assert.ok(fn.indexOf('endpoint()') < fn.indexOf('g&&g.endpoint'), 'the store must win over the injected global');
  assert.ok(fn.indexOf('token()') < fn.indexOf('g&&g.token'), 'sessionStorage must win over the injected global');
  assert.match(app, /return\{TKEY,NOT_PAIRED,token,setToken,endpoint,wsAuth,/, 'wsAuth must be exported');
});

test('no live socket reads the one-shot global on its own any more', () => {
  // Three legitimate mentions remain in index.html: the bootstrap seed that writes the stores,
  // setToken keeping a still-present global in step, and wsAuth's own fallback. Nothing else,
  // and nothing at all in the panels.
  for (const p of ['web/panels/shell.js', 'web/panels/harness.js', 'web/panels/browser.js']) {
    assert.doesNotMatch(read(p), /window\.__CFHUB_BRIDGE__/,
      p + ' still reads the one-shot global — its socket dies on any reload after the launch window');
    assert.match(read(p), /BridgeClient\.wsAuth\(\)/, p + ' must read the shared accessor');
  }
  // Count CODE only — the comments above these lines explain the history and mention it too.
  const code = app.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const mentions = (code.match(/window\.__CFHUB_BRIDGE__/g) || []).length;
  assert.equal(mentions, 4,
    'index.html should read the one-shot global in exactly three places — setToken keeping a ' +
    'present global in step (twice on one line), wsAuth\'s fallback, and the bootstrap seed. ' +
    'Found ' + mentions + ': a new direct reader means another socket that dies on reload.');
});

test('the terminal tells the two silences apart', () => {
  // "not connected" while MY MACHINE says connected sent people hunting for a pairing problem
  // that was never there. An expired session and an absent daemon are different sentences.
  assert.match(app, /HUB Bridge session expired/, 'a live session that lost its token must say so');
  assert.match(app, /HUB Bridge not connected — start it in MY MACHINE/, 'an unpaired app must point somewhere');
  assert.match(app, /const b=BridgeClient\.wsAuth\(\);\s*\n?\s*if\(!b\.token\)/, 'Term must read the shared accessor');
});

test('xterm is fetched from the same endpoint the socket uses', () => {
  assert.match(app, /const base=\(BridgeClient\.wsAuth\(\)\.endpoint\|\|''\)\+'\/vendor\/xterm\/'/,
    'xterm assets must resolve against the live endpoint, not a vanished global');
});

test('the shipped artifact carries it', () => {
  if (!dist) return;
  assert.ok(dist.includes('const wsAuth=()=>{'), 'dist/index.html is missing wsAuth');
  assert.ok(dist.includes('BridgeClient.wsAuth()'), 'dist/index.html never calls wsAuth');
});
