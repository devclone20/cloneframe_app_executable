# CLONE FRAME · HUB Bridge — Email Engine

`email.mjs` is a real IMAP/SMTP client for the HUB's Mail app. It runs locally and
talks directly to the user's own mail provider — no relay, no third-party inbox
service. Credentials live only on this machine, in `~/.clone-frame-hub/accounts.json`
(`chmod 600`, directory `chmod 700`), and are **never** logged or returned by any
function.

Real dependencies, not mocks: [`imapflow`](https://imapflow.com) (IMAP),
[`nodemailer`](https://nodemailer.com) (SMTP + MIME composition),
[`mailparser`](https://nodemailer.com/extras/mailparser/) (MIME parsing).

## Import

```js
import { Email } from './email.mjs';
// or: import Email from './email.mjs';           (default export, same object)
// or: import { list, send, folders } from './email.mjs';  (named exports)
```

`Email` is a plain object of the functions below — pick whichever import style
fits `hub-bridge.mjs`'s existing router style.

## Error model

- **Write-path** functions (`addAccount`, `removeAccount`, `setDefault`, `send`,
  `flag`, `move`, `saveDraft`, `deleteDraft`, `testAccount`) never throw for
  expected failure modes (bad host, bad credentials, unknown id). They always
  resolve to `{ok: false, error: string}`.
- **Read-path** functions (`list`, `message`, `attachment`, `folders`,
  `idleSince`) throw `EmailError` (exported) for unknown accounts, missing
  folders, or genuine protocol failures — the server is expected to
  `try { ... } catch (e) { res.writeHead(...) }` these.

## Account config shape

This is the exact JSON shape `addAccount(cfg)` / `testAccount(cfg)` expect, and
what the UI's "add account" form should collect:

```jsonc
{
  "email": "you@example.com",       // required
  "display": "Your Name",           // optional, defaults to email
  "provider": "gmail",              // optional. "gmail" auto-fills imap/smtp
                                     // host+port+secure below if you omit them.
  "user": "you@example.com",        // required (IMAP/SMTP login; usually = email)
  "pass": "app-password-or-pass",   // required. For Gmail: a 16-char App Password
                                     // (Google Account → Security → App passwords),
                                     // NOT your normal login password (2FA required).
  "imapHost": "imap.gmail.com",     // required unless provider:"gmail"
  "imapPort": 993,                  // required unless provider:"gmail"
  "imapSecure": true,               // optional, default true (implicit TLS)
  "smtpHost": "smtp.gmail.com",     // required unless provider:"gmail"
  "smtpPort": 465,                  // required unless provider:"gmail"
  "smtpSecure": true,               // optional, default true. false => STARTTLS
                                     // is *required* (never falls back to plaintext)
  "isDefault": false                // optional. First account added is always default.
}
```

`provider: "gmail"` fills in `imap.gmail.com:993` (implicit TLS) and
`smtp.gmail.com:465` (implicit TLS/SSL) for any of those fields left unset. Use
port `587` + `smtpSecure: false` instead of `465` if you prefer STARTTLS.

`getAccount(id)` returns this same shape (plus `id`) **minus `pass`**.
`listAccounts()` returns only `{id, email, display, isDefault}` — never the
full config, never the password.

## API

```ts
listAccounts(): Promise<{id, email, display, isDefault}[]>

getAccount(id): Promise<AccountConfig | null>  // AccountConfig minus `pass`

testAccount(cfg): Promise<{ok, imap, smtp, error?}>
// Actually connects (IMAP login + SMTP verify) in parallel. Never throws.

addAccount(cfg): Promise<{ok, id?, error?}>
// Validates shape, then calls testAccount() — only persists on success.

removeAccount(id): Promise<{ok, error?}>
setDefault(id): Promise<{ok, error?}>

folders(accountId): Promise<{path, name, specialUse, unread, total}[]>
// specialUse is one of \Inbox \Sent \Trash \Junk \Drafts \All \Important
// \Flagged (mirrors IMAP RFC 6154 SPECIAL-USE; Gmail sends these natively,
// name-pattern fallback for servers that don't).

list(accountId, folder, {limit=50, offset=0, search=''}): Promise<MessageSummary[]>
// Newest UID first. search matches subject/from/body via IMAP SEARCH (OR).

message(accountId, folder, uid): Promise<{
  uid, headers: {from, to, cc, subject, date}, // from/to/cc: {name,address}[]
  text, html, attachments: {partId, filename, mimeType, size}[]
}>
// Downloads full RFC822 source, parses with mailparser. Marks \Seen as a
// side effect (like opening a message in any real mail client).

attachment(accountId, folder, uid, partId): Promise<{filename, mimeType, contentBase64}>
// Targeted IMAP FETCH of just that MIME part — does not re-download the
// whole message. partId comes from message().attachments[i].partId.

send(accountId, {to, cc, bcc, subject, text, html, inReplyTo, references, attachments})
  : Promise<{ok, messageId?, error?}>
// to/cc/bcc: comma-separated string or string[] of plain addresses.
// attachments: [{filename, mimeType, contentBase64}]. Composes once via
// nodemailer's MailComposer, sends that exact raw MIME buffer over SMTP,
// then appends the SAME buffer to Sent (skipped for Gmail, which appends
// server-side automatically).

flag(accountId, folder, uid, {seen?, flagged?, answered?, deleted?}): Promise<{ok, error?}>
// true => add flag, false => remove flag, omitted => untouched.

move(accountId, folder, uid, targetFolder): Promise<{ok, error?}>

saveDraft(accountId, draft): Promise<{ok, uid?, folder?, error?}>
// Real IMAP APPEND to the Drafts folder (auto-resolved via SPECIAL-USE).
listDrafts(accountId, {limit, offset, search}): Promise<MessageSummary[]>
deleteDraft(accountId, uid): Promise<{ok, error?}>
// Targeted UID EXPUNGE — permanent, not a move to Trash.

idleSince(accountId, folder, sinceUid): Promise<MessageSummary[]>
// Polling helper (no persistent IMAP IDLE): returns messages with uid >
// sinceUid, newest first. Call on an interval from the server for "refresh".

closeAll(): Promise<void>
// Closes every pooled IMAP connection. Call on server shutdown.
```

`MessageSummary` (shared by `list`, `listDrafts`, `idleSince`):

```ts
{
  uid: number,
  from: {name, address},
  to: {name, address}[],
  subject: string,
  date: string | null,   // ISO 8601
  snippet: string,       // best-effort plain-text preview, ~180 chars
  unread: boolean,
  flagged: boolean,
  answered: boolean,
  hasAttachments: boolean,
}
```

## Design notes / trade-offs

- **One pooled IMAP connection per account**, all operations against that
  account serialized through an internal queue (`withAccountLock`). IMAP is a
  single stateful connection (one selected mailbox at a time) — this is a
  correctness requirement, not a performance knob. Connections reconnect
  lazily on next use if dropped.
- **`send()`/`saveDraft()` compose once, reuse the same raw MIME buffer** for
  the SMTP transmission and the Sent/Drafts IMAP append, so the two copies are
  byte-identical (same `Message-ID`, same `Date`) rather than two independent
  renders that could drift.
- **`idleSince()` is a poll, not a push.** No persistent IMAP `IDLE` connection
  is held open. For a local single-user desktop app, polling every 15–30s from
  the caller is simpler and more robust than managing a long-lived IDLE
  socket through sleep/wake cycles. Revisit if the HUB ever needs sub-second
  "new mail" latency.
- **`list()` snippets cost one small targeted `download()` per message**
  (capped at 4 KB, not the full body) — cheap for the default page size of 50.
- **STARTTLS is never optional-plaintext**: when `smtpSecure: false`,
  `requireTLS: true` is forced so the SMTP connection either upgrades to TLS
  or fails — it never silently sends credentials/mail in the clear.

## Node 26 / ESM caveats

- All three dependencies (`imapflow`, `nodemailer`, `mailparser`) resolve
  cleanly as ESM under Node 26 with named exports (`ImapFlow`, `default`
  export for `nodemailer`, `simpleParser`/`MailParser` for `mailparser`).
- `nodemailer` ships CommonJS only and has **no `exports` map** in its
  `package.json`, so deep-path imports resolve normally. This module uses one
  deep import — `nodemailer/lib/mail-composer/index.js` — to get raw MIME
  composition (`MailComposer`) without duplicating nodemailer's own address
  formatting/encoding logic. This is undocumented-but-stable nodemailer
  internals (used by nodemailer itself internally); if a future nodemailer
  major version adds an `exports` map or moves this file, this import is the
  one place that would need updating.
- No ESM/CJS interop issues were hit otherwise — `node --check email.mjs`
  passes and the module imports cleanly with plain `import()`.

## Self-test

A signature + persistence + graceful-failure self-test was run (not checked
into this repo — lives in the session scratchpad). It:

1. Imports the real module and asserts all 18 documented functions exist as
   both named exports and `Email.*` methods, and that `EmailError` is a real
   `Error` subclass.
2. Exercises `~/.clone-frame-hub/` creation, confirms directory mode `0700`
   and `accounts.json` mode `0600`, confirms `listAccounts()`/`getAccount()`
   never leak a `pass` field, and confirms a failed `addAccount()` (bad host)
   does not persist a partial record. The user's real `accounts.json` (if any)
   is backed up before the run and restored after.
3. Calls `testAccount()` against a non-resolving hostname — a **real** DNS/TCP
   attempt, not a mock — and confirms it resolves to
   `{ok:false, imap:false, smtp:false, error:"..."}` rather than throwing.
4. Calls `testAccount()` against **real** `imap.gmail.com`/`smtp.gmail.com`
   with an invalid (fake) account, confirming Google's actual
   `535-5.7.8 Username and Password not accepted` response is surfaced as
   `ok:false` — proving the network path is genuinely live, not stubbed.
5. Confirms `list()`/`folders()` throw `EmailError` for unknown account ids.

Result: **76/76 checks passed.**
