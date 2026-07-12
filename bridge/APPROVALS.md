# Email Approval Queue

Human-in-the-loop gate for AI-drafted email. An AI drafter (reply composer,
autonomous email agent, etc.) calls `add()` instead of sending directly. The
item sits as `'pending'` in `~/.clone-frame-hub/approvals.json` until a human
calls `approve()` (→ actually sends via `email.mjs`) or `reject()`.

No email is ever sent except through `approve()`. Nothing in this module
sends on `add()`.

```js
import { Approvals } from './approvals.mjs';
```

## Storage

- File: `~/.clone-frame-hub/approvals.json`, dir `0700`, file `0600`.
- Capped at ~200 items. When over cap, oldest **non-pending** items are
  dropped first — items still awaiting a human decision are never discarded
  by the cap.
- A corrupt/missing store is treated as empty rather than thrown — the queue
  must never crash the app on read.
- Email bodies and account credentials are never logged by this module.

## ApprovalItem shape

```ts
{
  id: string,                 // uuid
  type: 'ai_reply' | 'ai_email',
  accountId: string,
  to: string | string[],
  cc?: string | string[] | null,
  bcc?: string | string[] | null,
  subject: string,
  body: string,                // plain text; passed to Email.send as `text`
  sourceUid: string | null,    // originating message uid, for ai_reply
  folder: string | null,       // originating folder, for ai_reply
  generatedBy: string | null,  // free-form label, e.g. model name
  inReplyTo: string | null,    // Message-Id being replied to
  status: 'pending' | 'approved' | 'rejected' | 'sent',
  createdAt: number,           // ms epoch
  decidedAt: number | null,    // ms epoch, set on approve/reject
  sentMessageId: string | null,
  error: string | null,        // last send error, if any
}
```

`status: 'approved'` is reserved in the enum for callers/UIs that want a
distinct "approved, send in flight" state; this module's own `approve()`
transitions `pending` directly to `sent` (or back to `pending` with `error`
set on send failure) since sending is synchronous from the caller's point of
view.

## API

### `list({status} = {}) -> ApprovalItem[]`
Newest first (`createdAt` desc). Pass `status` to filter
(`'pending' | 'approved' | 'rejected' | 'sent'`). No matches → `[]`. Never throws.

### `get(id) -> ApprovalItem | null`
Never throws.

### `add(item) -> {ok, id?, error?}`
```
item = {
  type: 'ai_reply' | 'ai_email',
  accountId: string,
  to: string | string[],
  cc?, bcc?,
  subject: string,
  body: string,
  sourceUid?, folder?, generatedBy?, inReplyTo?,
}
```
Requires `accountId`, non-empty `to`, non-empty `body`. Sets
`status: 'pending'`, `createdAt: Date.now()`. Returns `{ok:false, error}` on
validation failure — never throws.

### `approve(id) -> {ok, messageId?, error?}`
Only valid from `status: 'pending'`. Lazy `await import('./email.mjs')`, then
`Email.send(accountId, {to, cc, bcc, subject, text: body, inReplyTo})`.
- Success → `status: 'sent'`, `decidedAt`, `sentMessageId` set, returns
  `{ok:true, messageId}`.
- Failure (unknown account, SMTP error, missing `email.mjs`, etc.) → item
  stays `'pending'` with `error` recorded, returns `{ok:false, error}`.

### `reject(id) -> {ok, error?}`
Only valid from `status: 'pending'`. Sets `status: 'rejected'`, `decidedAt`.

### `edit(id, patch) -> {ok, error?}`
Only valid while `status: 'pending'`. `patch` may include any of
`to | cc | bcc | subject | body`. Re-validates `to`/`body` are non-empty
after the patch is applied.

### `remove(id) -> {ok, error?}`
Deletes the item regardless of status. `{ok:false, error:'not found'}` if
the id doesn't exist.

### `count() -> {pending, total}`

## Guarantees

- Every function returns a plain JSON-serializable object; only `list`/`get`
  return their value directly (a bare array or `ApprovalItem | null`).
- No function throws for expected failures — errors are returned as
  `{ok:false, error}`.
- `email.mjs` is only ever imported lazily, inside `approve()`, so a
  load-order or dependency issue in the mail engine can never prevent this
  module from being imported or used for queueing/listing.
