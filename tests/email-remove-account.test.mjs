// Removing an email account did not remove it.
//
// The app keeps accounts in TWO stores: a password account is a row in accounts.json,
// and a Google sign-in lives in oauth.json and surfaces in the account list as a
// virtual `oauth:<email>` row. removeAccount() searched accounts.json only, so removing
// a Gmail account found nothing, returned `not found` — and the panel announced
// "Account removed" anyway, because it never read the answer. The account was still
// there on the next redraw.
//
// Two defects, and the second is the worse one: a failure that reads as a success is
// invisible. These tests pin both — the routing, and the reporting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');

// ONE throwaway hub root for the whole file, seeded fresh per test.
//
// A cache-busting query on email.mjs gives a new instance of THAT module, but the
// oauth.mjs it imports resolves to the one already in the module cache — bound to
// whichever root loaded first. So a per-test root silently tested the first test's
// directory forever after. The stores read from disk on every call, so re-seeding
// the two files is both simpler and closer to what the daemon actually does.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-emrm-'));
process.env.CLONE_FRAME_HUB_ROOT = ROOT;
const OAUTH_FILE = path.join(ROOT, 'oauth.json');
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');
const { Email: E } = await import('../bridge/email.mjs');

function seed({ oauthEmails = [], passwordAccounts = [] } = {}) {
  fs.writeFileSync(OAUTH_FILE, JSON.stringify({
    version: 1,
    accounts: oauthEmails.map((email) => ({ email, refresh_token: 'dummy', access_token: 'dummy', expiry: 0 })),
  }), { mode: 0o600 });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({
    version: 1, accounts: passwordAccounts, defaultId: null,
  }), { mode: 0o600 });
}

const pwAcct = (id, email) => ({
  id, email, display: email, provider: 'custom',
  imapHost: 'imap.example.test', imapPort: 993, imapSecure: true,
  user: email, pass: 'dummy-not-a-real-password',
  smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecure: true,
});

test('a Google sign-in can actually be removed', async () => {
  seed({ oauthEmails: ['owner@gmail.test'] });
  const before = await E.listAccounts();
  assert.equal(before.length, 1, 'the sign-in must appear as an account');
  assert.equal(before[0].id, 'oauth:owner@gmail.test');

  const r = await E.removeAccount('oauth:owner@gmail.test');
  assert.equal(r.ok, true, 'removing it must succeed — this returned {ok:false,"not found"}');

  assert.deepEqual(await E.listAccounts(), [], 'and it must be gone from the list');
  const oauth = JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8'));
  assert.equal(oauth.accounts.length, 0, 'and gone from oauth.json, not just hidden');
});

test('a stored address that kept its capitals is still removed', async () => {
  // oauth.removeAccount lowercased only the argument, so a stored "Owner@..." survived
  // a removal that reported ok. The account came back on the next render.
  seed({ oauthEmails: ['Owner@Gmail.test'] });
  const r = await E.removeAccount('oauth:Owner@Gmail.test');
  assert.equal(r.ok, true);
  assert.deepEqual(await E.listAccounts(), [], 'case must not decide whether a removal happens');
});

test('removing a Google sign-in gives the password account back', async () => {
  // OAuth supersedes a password record for the same address in the merged list. That
  // record is never touched, so removing the sign-in must restore it, not orphan it.
  seed({ oauthEmails: ['owner@gmail.test'], passwordAccounts: [pwAcct('a1', 'owner@gmail.test')] });
  const before = await E.listAccounts();
  assert.equal(before.length, 1, 'one row per address while both exist');
  assert.equal(before[0].id, 'oauth:owner@gmail.test', 'the token account wins');

  assert.equal((await E.removeAccount('oauth:owner@gmail.test')).ok, true);
  const after = await E.listAccounts();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'a1', 'the password account must come back');
});

test('a password account is still removable', async () => {
  seed({ passwordAccounts: [pwAcct('a1', 'one@example.test'), pwAcct('a2', 'two@example.test')] });
  assert.equal((await E.removeAccount('a1')).ok, true);
  const rows = await E.listAccounts();
  assert.deepEqual(rows.map((a) => a.id), ['a2']);
});

test('an id that names nothing is refused, never reported as removed', async () => {
  seed({ oauthEmails: ['owner@gmail.test'] });
  for (const id of ['oauth:someone@else.test', 'nope', '', null]) {
    const r = await E.removeAccount(id);
    assert.equal(r.ok, false, JSON.stringify(id) + ' must not report success');
    assert.equal(r.error, 'not found');
  }
  assert.equal((await E.listAccounts()).length, 1, 'and nothing may be removed as a side effect');
});

test('a Google account can be made the default', async () => {
  // The default used to be a flag on each stored row — a shape that cannot name an
  // account which is never written to that store. "make default" on a Gmail account
  // did nothing at all.
  seed({ oauthEmails: ['owner@gmail.test'], passwordAccounts: [pwAcct('a1', 'work@example.test')] });
  assert.equal((await E.setDefault('oauth:owner@gmail.test')).ok, true);
  const rows = await E.listAccounts();
  assert.equal(rows.find((a) => a.isDefault).id, 'oauth:owner@gmail.test');

  assert.equal((await E.setDefault('a1')).ok, true);
  assert.equal((await E.listAccounts()).find((a) => a.isDefault).id, 'a1');
  assert.equal((await E.setDefault('ghost')).ok, false, 'and an unknown id is refused');
});

test('removing the default leaves another account as default', async () => {
  seed({ passwordAccounts: [pwAcct('a1', 'one@example.test'), pwAcct('a2', 'two@example.test')] });
  await E.setDefault('a1');
  await E.removeAccount('a1');
  const rows = await E.listAccounts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isDefault, true, 'the app must never be left with no default');
});

test('the default lives in one place, not one flag per row', () => {
  const src = read('bridge/email.mjs');
  assert.match(src, /store\.defaultId/, 'the default must be a single store-level field');
  assert.match(src, /const \{ isDefault, \.\.\.rest \} = a;/,
    'the legacy per-row flag must be stripped on write so it cannot drift back');
  assert.match(src, /if \(id\.startsWith\('oauth:'\)\)/, 'removeAccount must route by id');
  assert.match(src, /if \(oauthAccountEmails\(\)\.includes\(email\)\) return \{ ok: false/,
    'and verify the removal against the store rather than trusting the return');
});

test('both remove buttons report what actually happened', () => {
  // The panel is where the lie was visible. A toast that says "removed" regardless of
  // the answer is worse than no toast: it tells the owner the app did something it did not.
  for (const p of ['web/panels/settings.js', 'web/panels/email.js']) {
    const src = read(p);
    assert.match(src, /Could not remove it: /, p + ' must surface a failed removal');
    assert.ok(!/await Mail\.removeAccount\([^)]*\);\s*Toast\.show\('Account removed'\)/.test(src),
      p + ' still announces success without reading the result');
    assert.match(src, /Bus\.emit\('email:accounts'\)/, p + ' must tell the other door the list changed');
  }
  assert.match(read('web/panels/email.js'), /panelBus\(p\)\.on\('email:accounts'/,
    'the EMAIL panel must redraw when SETTINGS removes an account');
});
