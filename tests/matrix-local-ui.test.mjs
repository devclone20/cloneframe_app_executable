// The MATRIX rail never said what the machine already had.
//
// After an engine restart there is no instance, so INSTANCES was empty and LOAD MODEL read
// "— SELECT MODEL —" over a catalog of 123. A model the owner had downloaded, that was
// sitting right there on disk, could only be found by expanding the right group in a modal
// and reading a small "✓ on disk" marker. There was no way to load it, use it or delete it
// from the rail at all, and DELETE only ever meant "delete the running instance".
//
// These tests pin the panel to the disk: one section for what you own, one delete that goes
// through the bridge (so it works with the engine down and takes the caches with it), and a
// chat that loads a downloaded model on the first message instead of demanding a LAUNCH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');
// A comment that names what was removed is the POINT of the comment; matching prose would
// fail on the explanation itself while the code stayed clean.
const decomment = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const mx = decomment(read('web/panels/matrix.js'));
const bridge = read('bridge/matrix.mjs');
const code = decomment(read('web/panels/terminal.js'));
const distPath = path.join(HERE, '..', 'dist', 'index.html');
const dist = fs.existsSync(distPath) ? read('dist/index.html') : '';

test('the rail has a section for what this machine already holds', () => {
  assert.match(mx, /ON THIS MACHINE/, 'the owner must see what they own without opening a picker');
  assert.match(mx, /function localSection\(/, 'and it must be its own render, not buried in the card');
  assert.match(mx, /\+localSection\(disk\)/, 'renderAside must actually place it');
  for (const act of ['data-mxlmload', 'data-mxlmuse', 'data-mxlmrm']) {
    assert.ok(mx.includes(act), 'a local model must be loadable, usable and removable from the rail (' + act + ')');
  }
});

test('the disk is a witness the panel actually asks', () => {
  assert.match(mx, /RPC\('matrix','localModels'\)/, 'the panel must read the disk through the bridge');
  assert.match(mx, /function onDisk\(\)/, 'and merge it with the engine log and the live instances');
  // The old answer consulted only the engine's download map plus a READY instance — both
  // of which an engine restart can empty while the weights sit untouched on disk.
  assert.ok(!mx.includes('function isDownloaded('), 'the engine-only answer must be gone');
  assert.match(mx, /st\.tickN%5===2\)refreshLocal\(\)/, 'and be refreshed on a clock, not once at boot');
  assert.match(bridge, /export const Matrix = \{[^}]*\blocalModels\b/, 'localModels must be callable over RPC');
});

test('delete is one call, it reaches the disk, and it survives the engine being down', () => {
  assert.match(mx, /RPC\('matrix','purgeModel',modelId\)/, 'the panel must delegate the whole delete to the bridge');
  // The browser used to issue the engine's DELETE itself, which could not touch the weights
  // and did nothing at all with the engine stopped.
  assert.ok(!/fetch\(API\+'\/download\/'/.test(mx), 'the browser-side weight delete must be gone');
  assert.ok(!mx.includes('function dlDelete('), 'and its helper with it');
  // The offline guard must sit AFTER the disk action, or deleting is impossible exactly when
  // it matters most.
  const handler = mx.slice(mx.indexOf("const dla=t.closest('[data-mxdla]')"), mx.indexOf("const opt=t.closest('[data-mxopt]')"));
  assert.ok(handler.indexOf("==='disk'") < handler.indexOf('MATRIX engine is offline'),
    'the disk action must be handled before the engine-offline guard');
  assert.match(bridge, /export const Matrix = \{[^}]*\bpurgeModel\b/, 'purgeModel must be callable over RPC');
});

test('a deleted model leaves nothing behind in the app either', () => {
  const purge = mx.slice(mx.indexOf('async function purgeModel('), mx.indexOf('async function refreshEng('));
  assert.match(purge, /st\.selModel=null/, 'the selection must not survive the model');
  assert.match(purge, /delete dlMeta\[k\]/, 'nor the shard metadata kept for retries');
  assert.match(purge, /Bus\.emit\('models:changed'\)/, 'and every picker must be told');
  assert.match(purge, /refreshProv\(\)/, 'the provider card must be re-read, not guessed');
  // CODE stores its choice as providerId::model and never checked it still existed: the
  // button read "machine" while the request went to the dead id and returned 404.
  assert.match(code, /provsLoaded&&cur&&cur\.model&&cur\.model\.includes\('::'\)&&!models\.some/,
    'CODE must drop a selection whose model is gone');
  assert.match(code, /provsLoaded=true/, 'and only when the registry actually answered');
});

test('one reconciliation, in the bridge, that a timeout cannot empty', () => {
  assert.match(mx, /RPC\('matrix','syncModels'/, 'the panel must ask the bridge to reconcile');
  assert.ok(!/RPC\('models','setModels'/.test(mx), 'the panel must not be a second writer of the model list');
  assert.ok(!/RPC\('models','addProvider'/.test(mx), 'nor register the provider behind the bridge’s back');
  assert.match(bridge, /export const Matrix = \{[^}]*\bsyncModels\b/);
  assert.ok(!mx.includes('provSig'), 'the panel-side signature cache goes with it');
});

test('a downloaded model answers on the first message', () => {
  assert.match(mx, /async function ensureLive\(modelId,signal\)/, 'the chat must be able to bring a model up itself');
  assert.match(mx, /function chatModel\(\)\{return st\.selModel\?st\.selModel\.id:readyModel\(\)\}/,
    'the label and the request must name the same model — the selection wins');
  assert.match(mx, /if\(!liveNow\(model\)\)\{/, 'and load it when it is not resident');
  // The refusal named a phase that shipped long ago and pointed at a dashboard the app replaced.
  assert.ok(!mx.includes('model ops land in the next phase'), 'the stale refusal must be gone');
  assert.ok(!mx.includes('use the engine dashboard for now'), 'and its dead advice');
});

test('a model on disk is never something you have to hunt for', () => {
  assert.match(mx, /◆ ON THIS MACHINE/, 'the picker must pin what is already downloaded above the catalog');
  assert.match(mx, /E\.plist\.innerHTML=mineHTML/, 'pinned first, before RECOMMENDED and OTHER');
  // Selecting must work with the engine down, when there is no catalog to look the model up in.
  const pick = mx.slice(mx.indexOf('function pickModel('), mx.indexOf('root.addEventListener'));
  assert.match(pick, /const r=onDisk\(\)\.find/, 'a local model must be selectable without the catalog');
});

test('the shipped artifact carries all of it', () => {
  if (!dist) return;
  for (const shape of ["RPC('matrix','localModels')", "RPC('matrix','purgeModel',modelId)",
    'data-mxlmrm', 'async function ensureLive(', 'ON THIS MACHINE', '.mx-lmb']) {
    assert.ok(dist.includes(shape), 'dist is missing ' + JSON.stringify(shape));
  }
  assert.ok(!dist.includes('function isDownloaded('), 'the engine-only answer shipped');
  assert.ok(!dist.includes('model ops land in the next phase'), 'the stale refusal shipped');
});
