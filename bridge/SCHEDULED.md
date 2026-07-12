# CLONE FRAME · HUB Bridge — Scheduled Send Engine

`scheduled.mjs` powers the Mail app's **Scheduled** folder: emails composed now
but held for delivery at a future instant. `schedule()` records the intent;
`tick()` — called by the host server on an interval, this module owns no timer
of its own — sends every pending item whose `sendAt` has arrived, via
`./email.mjs`'s `Email.send()`. Zero npm dependencies — Node built-ins only
(`fs`, `path`, `os`, `crypto`). `./email.mjs` is imported **lazily, only inside
`tick()`**, so simply loading `scheduled.mjs` never pulls in the IMAP/SMTP
stack.

Scheduled emails persist to `~/.clone-frame-hub/scheduled.json` (`chmod 600`,
directory `chmod 700`) via an atomic tmp-write-then-rename. A missing or
corrupt store degrades to empty — it never throws. Bodies, addresses, and
subjects are never logged; a failed send records its error string on the
record itself, never to stdout/stderr.

## Routing

Intended to be served by `hub-bridge.mjs`'s generic module RPC:
`POST /mod/scheduled { fn, args }`, which invokes `Scheduled[fn](...args)`.
Every method is directly callable with plain JSON arguments and returns
JSON-serializable values. **This module does not register itself with
hub-bridge.mjs** — wiring the route and the `tick()` interval into the host
server is a separate step.

## Import

```js
import { Scheduled } from './scheduled.mjs';
// or: import Scheduled from './scheduled.mjs';                                          (default export, same object)
// or: import { schedule, list, get, cancel, reschedule, due, tick } from './scheduled.mjs';
```

`Scheduled` is a plain object of the functions below — use whichever import
style fits the existing router.

## Error model

- **Write-path** (`schedule`, `cancel`, `reschedule`) always returns
  `{ok, ...}` and **never throws** for an expected failure — a missing field,
  a past `sendAt`, an unknown id, a non-pending id, or a disk error resolves
  to `{ok:false, error:string}`.
- **Read-path** (`list`, `get`, `due`) returns values directly; a missing or
  corrupt store resolves to `[]` / `null`, never a throw.
- **`tick()`** never throws. A send failure (bad account, network error, SMTP
  rejection) is caught per item and recorded on that item; one bad record
  cannot stall or crash the rest of the batch. Even a hard failure to import
  `./email.mjs` itself is caught and treated as a failed attempt for every due
  item in that pass.

## Route contract

```
schedule({accountId, to, cc?, bcc?, subject, body, sendAt}) -> {ok, id?, error?}
  Requires a non-empty accountId, to, subject, and body, and a sendAt that
  parses (see Instant formats) and is strictly in the future. New records
  start status:'pending', attempts:0. Returns the new id on success.

list({status='all'}={}) -> ScheduledEmail[]
  Newest sendAt first (unparseable sendAt sorts last, createdAt tiebreak).
  `status` is one of 'all' | 'pending' | 'sent' | 'failed' | 'canceled'; an
  unknown value is treated as 'all'.

get(id) -> ScheduledEmail | null
  The full record, or null when the id is unknown.

cancel(id) -> {ok, error?}
  Only a 'pending' item can be canceled -> status:'canceled'.
  {ok:false,'cancel: unknown id'} / {ok:false,"cancel: item is '<status>', not 'pending'"}.

reschedule(id, sendAt) -> {ok, error?}
  Only a 'pending' item can be rescheduled; sendAt must parse and be strictly
  in the future. Same id/status error shapes as cancel().

due(now?) -> ScheduledEmail[]
  Pending items whose sendAt has arrived (sendAt <= now), newest-first (same
  ordering as list()). Read-only — does not send anything or mutate the
  store. `now` is optional — an ISO string or epoch-ms number; missing or
  unparseable falls back to the current time.

tick() -> Promise<{sent, failed}>
  Called by the host server on an interval. Finds every pending, due item;
  lazily `import('./email.mjs')`; sends each via
  `Email.send(accountId, {to, cc, bcc, subject, text: body})`.
  - On success: status -> 'sent', sentAt stamped, sentMessageId stored,
    error cleared, `sent` counter incremented.
  - On failure: `attempts` incremented; if attempts < 3 the record stays
    'pending' (retried on the next tick()); at attempts === 3 it becomes
    'failed' and is never retried again. `error` stores the failure message.
    `failed` counter incremented either way.
  Returns {sent, failed} — counts for that pass only. Never throws.
```

## ScheduledEmail JSON shape

`get(id)` / `list(...)` / `due(...)` return the full record:

```jsonc
{
  "id": "b3e1...",                        // randomUUID()
  "accountId": "acct_abc123",             // as passed to schedule()
  "to": "person@example.com",             // as-authored (string, comma-joined)
  "cc": "",                               // as-authored, "" when omitted
  "bcc": "",                              // as-authored, "" when omitted
  "subject": "Q3 roadmap",
  "body": "Hey — following up on...",     // plain text, sent as `text`
  "sendAt": "2026-07-10T09:00:00.000Z",   // canonical UTC ISO
  "status": "pending",                    // pending | sent | failed | canceled
  "attempts": 0,                          // send attempts made so far (max 3)
  "createdAt": "2026-07-09T18:32:10.512Z",
  "sentAt": null,                         // ISO once sent, else null
  "sentMessageId": null,                  // Email.send()'s messageId, else null
  "error": null                           // last failure message, else null
}
```

`to`/`cc`/`bcc` are stored exactly as authored (string, or an array joined
with `, `) and only split into individual addresses by `email.mjs` itself at
send time — this module does not parse or validate address syntax beyond
"non-empty" for `to`.

### Instant formats (`sendAt`, `now`)

`sendAt` accepts an ISO / RFC-2822 date string or an **epoch-milliseconds**
number. It is stored canonically as a UTC ISO string. `schedule()` and
`reschedule()` both reject a `sendAt` that is not strictly after the current
time. `due(now)` accepts the same string/number forms; a missing or
unparseable `now` falls back to the current time.

### Field rules

- `accountId`, `to`, `subject`, `body` — required, trimmed where applicable.
  `subject` capped at **998** chars (RFC 5322 header-line ceiling), `body`
  capped at **500,000** chars, `to`/`cc`/`bcc` each capped at **4,000** chars.
- `status` — `pending` | `sent` | `failed` | `canceled`. New records are
  `pending`. `cancel()`/`reschedule()` only operate on `pending`.
- `attempts` — incremented once per `tick()` send attempt against that
  record; capped by policy at **3**, after which the record is marked
  `failed` and excluded from future `due()`/`tick()` passes.

## Storage

`~/.clone-frame-hub/scheduled.json`

```jsonc
{ "version": 1, "items": [ /* ScheduledEmail[] */ ] }
```

Written atomically (`scheduled.json.<pid>.<ts>.tmp` → `rename`), file mode
`0600`, directory mode `0700`. On read, entries missing an `id` are dropped
and the rest are defensively re-typed to the shape above, so a partially
hand-edited file still loads cleanly instead of poisoning a read.

## Host wiring (not done by this module)

This module intentionally does not start its own timer or register its own
route — both are the host server's responsibility:

```js
import Scheduled from './scheduled.mjs';

setInterval(() => { Scheduled.tick().catch(() => {}); }, 60_000);
```

Wire the interval and (if desired) the `/mod/scheduled` RPC route into
`hub-bridge.mjs` separately; `scheduled.mjs` itself is not modified for that.

## Self-test

Zero test-framework dependency (per the zero-deps constraint). Validate with:

```
node --check scheduled.mjs
```

A one-off self-test was run during development against a backed-up store: it
asserts `schedule()` rejects a past `sendAt` and missing required fields;
creates two future items and checks `list()` orders them newest-`sendAt`-first;
confirms `get()` returns a record / `null` for an unknown id; confirms
`scheduled.json` is written `0600` inside a `0700` directory and that the
persisted JSON contains the scheduled item; exercises `cancel()` (succeeds
once, then fails on an already-canceled item) and `reschedule()` (succeeds,
then rejects a past `sendAt`); force-dates a record into the past with an
unknown `accountId` and confirms `due()` lists it without mutating it; calls
`tick()` and confirms it lazily imports `email.mjs`, attempts a real
`Email.send()` against the unknown account, catches the failure without
throwing, and records `status:'pending'`, `attempts:1`, and a non-body-leaking
`error` string; runs `tick()` two more times and confirms the record flips to
`status:'failed'` at `attempts:3` and is excluded from all further ticks; and
confirms `list({status:...})` filtering. The original store is restored
afterwards.
