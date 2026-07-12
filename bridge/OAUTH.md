# Gmail OAuth2 (`oauth.mjs`)

Sign in to Gmail with real Google OAuth instead of an App Password, using the
loopback / installed-app flow (RFC 8252), and send mail over SMTP with XOAUTH2.

BYOK — the user brings their own Google OAuth **Desktop app** Client ID +
Secret. Creds and tokens are stored in `~/.clone-frame-hub/oauth.json`
(directory `0700`, file `0600`). Secrets and tokens are **never logged** and
**never** returned by `status()` / `accounts()`.

```js
import { OAuth } from './oauth.mjs';        // named
import OAuth from './oauth.mjs';            // or default
```

## Contract

| Method | Signature | Notes |
| --- | --- | --- |
| `config` | `({clientId, clientSecret}) -> {ok, error?}` | Persist BYOK Google creds. Write-path. |
| `status` | `() -> {configured, accounts}` | `configured` = has clientId. `accounts` = signed-in emails. No secrets/tokens. |
| `accounts` | `() -> {email}[]` | Signed-in addresses only. |
| `removeAccount` | `(email) -> {ok}` | Drop an account's stored tokens. |
| `beginAuth` | `() -> Promise<{ok, authUrl?, error?}>` | Starts loopback server, returns Google auth URL. Open it in the browser. |
| `pollAuth` | `() -> {done, email?, error?}` | Poll after opening `authUrl` to learn when sign-in finished. |
| `accessToken` | `(email) -> Promise<{ok, token?, error?}>` | Valid access token, auto-refreshed. |
| `sendMail` | `(email, {to, cc?, bcc?, subject, text, html, inReplyTo?}) -> Promise<{ok, messageId?, error?}>` | SMTP XOAUTH2 send. Never throws. |

Write-path calls resolve to `{ok, ...}` and never throw. Read-path
(`status`/`accounts`/`pollAuth`) returns directly. A corrupt store degrades to
empty rather than throwing.

## Flow

```js
OAuth.config({ clientId, clientSecret });            // once
const { ok, authUrl } = await OAuth.beginAuth();     // open authUrl in browser
// ...user consents; Google redirects to http://127.0.0.1:<port>/
let r; do { r = OAuth.pollAuth(); } while (!r.done); // r.email on success
await OAuth.sendMail(r.email, { to: 'x@y.com', subject: 'hi', text: 'hi' });
```

`beginAuth()` spins up a temporary `http` server on `127.0.0.1:<ephemeral>`,
returns immediately with the auth URL, exchanges the `?code=` on redirect,
persists `{email, refresh_token, access_token, expiry, clientRef}`, shows a
"podes fechar esta janela" page, and closes. The temp server times out after
~180s. Only one sign-in runs at a time; a new `beginAuth()` supersedes any
in-flight one.

Scopes requested: `https://mail.google.com/ openid email` — full-access is
required for SMTP/IMAP XOAUTH2; `openid`+`email` resolve the signed-in address.
`access_type=offline` + `prompt=consent` guarantee a `refresh_token`.

## Google Cloud setup (one-time)

1. https://console.cloud.google.com → create/select a project.
2. **APIs & Services → OAuth consent screen**:
   - User type **External** (or Internal for a Workspace org).
   - Fill app name + support email. While in **Testing**, add your Gmail
     address under **Test users** (published apps skip this).
   - Add scope `https://mail.google.com/` (plus `openid`, `email`).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - Name it, Create. Copy the **Client ID** and **Client secret**.
   - Desktop clients use the loopback redirect (`http://127.0.0.1:<port>/`) —
     **no fixed redirect URI needs to be registered**.
4. Feed those into `OAuth.config({ clientId, clientSecret })`.

Gmail's SMTP/IMAP endpoints work with OAuth out of the box; you do **not** need
to enable the Gmail API for send-via-SMTP.

## Caveat

IMAP-read XOAUTH2 is **not** wired into `email.mjs` yet. Sending works today via
`OAuth.sendMail`. Reading mailboxes still goes through the existing
app-password accounts in `email.mjs`. Bridging `accessToken(email)` into the
IMAP client is a follow-up.
