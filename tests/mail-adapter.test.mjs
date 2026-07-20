// ─────────────────────────────────────────────────────────────────────────────
// domains/mail/mail — the /mod adapter for the email engine (T-033)
//
// Locks the contract that replaced the bespoke /email/* shadow switch:
//   • READ methods degrade a throw to {ok:false,error} (served at HTTP 200 by
//     /mod, never a 500) — the renderer's Mail client re-throws {ok:false}
//   • WRITE/action methods pass through email.mjs untouched (still functions)
//   • the lifecycle helper closeAll is NOT on the /mod surface (the old switch
//     had no route for it; internal callers reach it via email.mjs directly)
//
// Hermetic: exercises only the synchronous `folder is required` guard, so no
// account store is read and no IMAP/SMTP connection is attempted.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import Email from '../bridge/domains/mail/mail.mjs';

test('READ list: a throw degrades to {ok:false,error} instead of propagating', async () => {
  const r = await Email.list('acct', '', { limit: 5 });   // '' folder → email.mjs throws synchronously
  assert.equal(r.ok, false);
  assert.match(r.error, /folder is required/);
});

test('READ message: a throw degrades to {ok:false,error}', async () => {
  const r = await Email.message('acct', '', 1);
  assert.equal(r.ok, false);
  assert.match(r.error, /folder is required/);
});

test('READ idleSince: a throw degrades to {ok:false,error}', async () => {
  const r = await Email.idleSince('acct', '', 0);
  assert.equal(r.ok, false);
  assert.match(r.error, /folder is required/);
});

test('lifecycle helper closeAll is NOT on the /mod surface (matches the old switch)', () => {
  assert.equal(typeof Email.closeAll, 'undefined');
});

test('write/action methods pass through (present, not soft-wrapped)', () => {
  for (const fn of ['send', 'flag', 'move', 'addAccount', 'testAccount', 'removeAccount', 'setDefault', 'saveDraft', 'deleteDraft']) {
    assert.equal(typeof Email[fn], 'function', fn + ' must be exposed on the /mod surface');
  }
});

test('read methods are all exposed', () => {
  for (const fn of ['listAccounts', 'getAccount', 'folders', 'list', 'message', 'attachment', 'listDrafts', 'idleSince']) {
    assert.equal(typeof Email[fn], 'function', fn + ' must be exposed on the /mod surface');
  }
});
