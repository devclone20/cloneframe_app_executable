// "There are places that still say I have the old key."
//
// He was right, and both stores were telling the truth about themselves. addProvider
// pushed unconditionally, so pasting a fresh key for a provider you already had left the
// previous record in place with its previous key — two Anthropic rows, two Keychain
// entries, and whichever sorted first decided which key the app used. Meanwhile
// ~/.env.local can carry an independent copy that the app read and never showed.
//
// A key you cannot see is a key you cannot replace. These tests pin both halves: a new
// key destroys the old one, and every copy on the machine is reportable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-key-'));
process.env.CLONE_FRAME_HUB_ROOT = ROOT;
// Keep the test off the real login Keychain: with no entry written, the record keeps its
// key on disk, which is the same code path minus the macOS call.
const { Models } = await import('../bridge/models.mjs');
const STORE = path.join(ROOT, 'models.json');

const wipe = () => fs.writeFileSync(STORE, JSON.stringify({ version: 1, providers: [], defaults: {} }), { mode: 0o600 });
const raw = () => JSON.parse(fs.readFileSync(STORE, 'utf8')).providers;
const add = (apiKey, over = {}) => Models.addProvider({ kind: 'api', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey, ...over });

test('a new key replaces the old one instead of stacking beside it', () => {
  wipe();
  const first = add('KEY-THE-OLD-ONE');
  assert.equal(first.ok, true);
  const second = add('KEY-THE-NEW-ONE');
  assert.equal(second.ok, true);
  assert.equal(second.replaced, 1, 'it must report that it superseded a record');

  const rows = raw();
  assert.equal(rows.length, 1, 'two records for the same provider is how the old key kept winning');
  assert.equal(rows[0].id, second.id);
  const onDisk = fs.readFileSync(STORE, 'utf8');
  assert.ok(!onDisk.includes('KEY-THE-OLD-ONE'), 'the old key is still on disk');
  assert.ok(onDisk.includes('KEY-THE-NEW-ONE'), 'the new key was not stored');
});

test('the same vendor at a different base URL is a different provider', () => {
  wipe();
  add('KEY-A');
  const other = add('KEY-B', { baseUrl: 'https://gateway.example.test/anthropic' });
  assert.equal(other.replaced, 0, 'a different endpoint is not the same provider');
  assert.equal(raw().length, 2);
});

test('replacing a key keeps the models and the choices made around it', () => {
  wipe();
  const a = add('KEY-A');
  Models.setModels(a.id, ['claude-opus-5', 'claude-sonnet-5']);
  Models.setModelEnabled(a.id, 'claude-sonnet-5', false);
  Models.setDefault('chat', { providerId: a.id, model: 'claude-opus-5' });

  const b = add('KEY-B');
  const rows = raw();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].models, ['claude-opus-5', 'claude-sonnet-5'], 'a new key must not wipe the model list');
  assert.deepEqual(rows[0].disabledModels, ['claude-sonnet-5'], 'nor the per-model switches');
  // A job pointing at the record that was replaced must follow the replacement, not
  // fall back to "whichever provider sorts first".
  assert.equal(Models.getDefaults().chat.providerId, b.id, 'AI Defaults must follow the replacement');
  assert.equal(Models.getDefaults().chat.model, 'claude-opus-5');
});

test('removing a provider takes its key with it', () => {
  wipe();
  const a = add('KEY-TO-DELETE');
  assert.equal(Models.removeProvider(a.id).ok, true);
  assert.equal(raw().length, 0);
  assert.ok(!fs.readFileSync(STORE, 'utf8').includes('KEY-TO-DELETE'), 'the key outlived the record');
});

test('every copy of a key on the machine is reportable, and none of them by value', async () => {
  wipe();
  const a = add('KEY-AUDIT-ME');
  const audit = await Models.keyAudit();
  assert.equal(audit.ok, true);
  assert.equal(audit.providers.length, 1);
  assert.equal(audit.providers[0].hasKey, true);
  assert.ok(['keychain', 'disk'].includes(audit.providers[0].where), 'it must say WHERE the key is');
  assert.equal(audit.active.source, 'provider');
  assert.equal(audit.active.id, a.id);
  assert.ok(!JSON.stringify(audit).includes('KEY-AUDIT-ME'), 'the audit leaked the key itself');
  for (const e of audit.env) {
    assert.ok(e.name && e.source, 'an env copy must name its variable and its file');
    assert.equal(typeof e.shadowed, 'boolean', 'and say whether the app ignores it');
  }
});

test('an environment copy is found by name and file, never read out', () => {
  const llm = read('bridge/llm.mjs');
  assert.match(llm, /export function envKeySource\(name\)/, 'the reporter must exist');
  const fn = llm.slice(llm.indexOf('export function envKeySource('), llm.indexOf('export function envKeySources'));
  assert.ok(!/return\s*\{[^}]*value/.test(fn), 'it must never hand back the value');
  assert.match(fn, /source: f\.replace\(homedir\(\), '~'\)/, 'and it must name the file it found it in');
});

test('the audit reaches the screens that report a key', () => {
  const brain = read('web/panels/brain.js');
  assert.match(brain, /RPC\('models','keyAudit'\)/, 'BRAIN must read the audit');
  assert.match(brain, /ALSO ON THIS MACHINE/, 'and show the copies it does not own');
  assert.match(brain, /IGNORED/, 'saying plainly which ones the app ignores');
  assert.match(read('bridge/models.mjs'), /export const Models = \{[\s\S]{0,600}?keyAudit/, 'and it must be on the RPC surface');
});

test('the command line can see and replace a key without ever echoing it', () => {
  const cli = read('tools/key.mjs');
  assert.match(cli, /rl\._writeToOutput = \(s\) =>/, 'the prompt must swallow the echo of the key');
  assert.match(cli, /if \(!t \|\| !t\.ok\)/, 'a key must be checked with the provider before anything is destroyed');
  assert.ok(cli.indexOf('Models.testProvider') < cli.indexOf('Models.addProvider'),
    'a key that does not work must never be able to take out the key that does');
  assert.match(cli, /this command will not/, 'it must say it does not edit the owner’s env files');
  const pkg = JSON.parse(read('package.json'));
  for (const s of ['key', 'key:set', 'key:reset']) assert.ok(pkg.scripts[s], 'missing npm script: ' + s);
});
