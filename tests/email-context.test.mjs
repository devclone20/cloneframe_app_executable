// Context test for the email domain module's ACCOUNT STORE after its migration
// onto the shared json-store port (Wave-3). Exercises ONLY the store-touching,
// NON-network surface (listAccounts/getAccount/setDefault/removeAccount) against
// a real filesystem store isolated to a throwaway dir via CLONE_FRAME_HUB_ROOT
// (the hub-root seam). The IMAP/SMTP paths (addAccount → testAccount probes,
// send, list/message/…) hit the network and are deliberately NOT called here.
//
// Critically asserts the stored IMAP/SMTP `pass` is persisted at rest (0600) but
// NEVER surfaces in the public list projection or in getAccount(). All secrets
// used are dummy strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh tmp root + a fresh module instance (cache-busting query) so the
// module-level `openStore({ root: hubRoot() })` binds to our throwaway dir.
async function freshEmail() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-email-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/email.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, E: mod.Email, file: path.join(root, 'accounts.json') };
}

// A full password-account record, exactly the shape addAccount() writes.
function acct(id, email, pass, isDefault = false) {
  return {
    id, email, display: email, provider: 'custom',
    imapHost: 'imap.example.test', imapPort: 993, imapSecure: true,
    user: email, pass,
    smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecure: true,
    isDefault,
  };
}

// Seed accounts.json the way a prior write would have left it (minus the version
// stamp the migrated store now adds), to drive the read/mutate paths without
// touching the network via addAccount().
function seed(file, accounts) {
  fs.writeFileSync(file, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
}

test('list/getAccount never leak `pass`; a store write stamps {version, accounts} at 0600 with the credential persisted at rest', async () => {
  const { E, file } = await freshEmail();
  seed(file, [
    acct('acc-1', 'a@example.test', 'DUMMY-PASS-1', true),
    acct('acc-2', 'b@example.test', 'DUMMY-PASS-2', false),
  ]);

  const list = await E.listAccounts();
  assert.equal(list.length, 2);
  // public projection shape: exactly {id,email,display,isDefault} — no `pass`.
  assert.deepEqual(Object.keys(list[0]).sort(), ['display', 'email', 'id', 'isDefault']);
  assert.equal('pass' in list[0], false);
  assert.equal(JSON.stringify(list).includes('DUMMY-PASS'), false);

  // getAccount returns the full config MINUS the password.
  const g = await E.getAccount('acc-1');
  assert.equal(g.email, 'a@example.test');
  assert.equal(g.imapHost, 'imap.example.test'); // config round-trips
  assert.equal('pass' in g, false);
  assert.equal(JSON.stringify(g).includes('DUMMY-PASS'), false);

  // A store write (setDefault) stamps version:1 and re-chmods 0600, and the
  // password stays persisted AT REST (only the client-facing projection hides it).
  assert.equal((await E.setDefault('acc-2')).ok, true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.accounts.length, 2);
  assert.equal(onDisk.accounts[0].pass, 'DUMMY-PASS-1'); // credential kept at rest
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('setDefault / removeAccount round-trip through the store', async () => {
  const { E, file } = await freshEmail();
  seed(file, [
    acct('acc-1', 'a@example.test', 'DUMMY-PASS-1', true),
    acct('acc-2', 'b@example.test', 'DUMMY-PASS-2', false),
  ]);

  assert.equal((await E.setDefault('acc-2')).ok, true);
  assert.equal((await E.getAccount('acc-1')).isDefault, false);
  assert.equal((await E.getAccount('acc-2')).isDefault, true);

  assert.equal((await E.removeAccount('acc-1')).ok, true);
  const list = await E.listAccounts();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'acc-2');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.accounts.length, 1);
  assert.equal(onDisk.accounts[0].id, 'acc-2');
  assert.equal(onDisk.accounts[0].pass, 'DUMMY-PASS-2'); // survivor's credential intact

  assert.equal((await E.removeAccount('acc-1')).ok, false); // already gone
});

test('empty store: list is [] and getAccount is null, no file, no throw', async () => {
  const { E } = await freshEmail();
  assert.deepEqual(await E.listAccounts(), []);
  assert.equal(await E.getAccount('nope'), null);
});

test('a corrupt store degrades to empty instead of throwing, and the write path recovers a clean file', async () => {
  const { E, file } = await freshEmail();
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(await E.listAccounts(), []); // tolerated, no throw
  assert.equal(await E.getAccount('acc-1'), null);

  // A subsequent real write over the corrupt file produces a clean, versioned
  // {version, accounts:[]} at 0600 — the corruption bricked nothing.
  seed(file, [acct('acc-1', 'a@example.test', 'DUMMY-PASS-1', true)]);
  assert.equal((await E.removeAccount('acc-1')).ok, true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk.accounts, []);
  assert.equal(onDisk.version, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
