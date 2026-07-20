// Context test for the style domain module AFTER its migration onto the shared
// json-store port (Wave-3). Proves the persistence swap is behavior-preserving
// end-to-end against a REAL filesystem store, isolated to a throwaway dir via
// CLONE_FRAME_HUB_ROOT (the hub-root seam). Follows the reminders template.
// extractFromSent() is intentionally not exercised — it lazy-imports email.mjs
// and calls the LLM (ask), both outside the persistence surface under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshStyle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-style-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/style.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, S: mod.Style, file: path.join(root, 'style.json') };
}

test('saveSignature → signatures → defaultSignature round-trips, persists to style.json', async () => {
  const { S, file } = await freshStyle();
  assert.deepEqual(S.signatures(), []); // empty store, no throw on missing file
  assert.equal(S.defaultSignature('acct-1'), null);

  const res = S.saveSignature({ accountId: 'acct-1', name: 'Work', text: 'Best,\nAlex', isDefault: true });
  assert.equal(res.ok, true);
  assert.match(res.id, /[0-9a-f-]{36}/);

  const all = S.signatures('acct-1');
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'Work');
  assert.equal(all[0].isDefault, true);
  assert.equal(S.defaultSignature('acct-1').id, res.id);

  // persisted shape: {version, signatures, toneRules, profiles}
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.signatures.length, 1);
  assert.deepEqual(onDisk.toneRules, []);
  assert.deepEqual(onDisk.profiles, {});
  // file perms 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('saveSignature validation + removeSignature contracts', async () => {
  const { S } = await freshStyle();
  assert.equal(S.saveSignature({ name: '', text: 'x' }).ok, false); // name required
  assert.equal(S.saveSignature({ name: 'A', text: '  ' }).ok, false); // text required

  const { id } = S.saveSignature({ name: 'Personal', text: 'Cheers' });
  assert.equal(S.saveSignature({ id, name: 'Personal 2', text: 'Cheers!' }).ok, true); // update in place
  assert.equal(S.signatures().length, 1);
  assert.equal(S.signatures()[0].name, 'Personal 2');
  assert.equal(S.saveSignature({ id: 'nope', name: 'X', text: 'Y' }).ok, false); // unknown id

  assert.equal(S.removeSignature(id).ok, true);
  assert.equal(S.signatures().length, 0);
  assert.equal(S.removeSignature(id).ok, false); // gone
});

test('tone rules round-trip, getProfile empty, draftPrompt composes', async () => {
  const { S } = await freshStyle();
  assert.deepEqual(S.getToneRules(), []);
  assert.equal(S.getProfile('acct-1'), null); // nothing learned
  assert.equal(S.draftPrompt('acct-1'), ''); // nothing to say yet

  assert.equal(S.setToneRules('nope').ok, false); // must be string[]
  assert.equal(S.setToneRules(['  be concise  ', '', 'no emoji']).ok, true);
  assert.deepEqual(S.getToneRules(), ['be concise', 'no emoji']); // trimmed + blanks dropped

  S.saveSignature({ accountId: 'acct-1', name: 'Work', text: 'Best,\nAlex', isDefault: true });
  const prompt = S.draftPrompt('acct-1');
  assert.match(prompt, /Best,\nAlex/);
  assert.match(prompt, /be concise/);
});

test('a corrupt store degrades to empty instead of throwing', async () => {
  const { S, file } = await freshStyle();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(S.signatures(), []);
  assert.deepEqual(S.getToneRules(), []);
  assert.equal(S.getProfile('acct-1'), null);
  // and a write still recovers the store
  assert.equal(S.saveSignature({ name: 'ok', text: 'sig' }).ok, true);
  assert.equal(S.signatures().length, 1);
});
