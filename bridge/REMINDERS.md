# CLONE FRAME · HUB Bridge — Reminders Engine

`reminders.mjs` powers the HUB's **Settings → Reminders** panel and the sidebar
**bell**: time-based reminders with a `note`, a `remindAt` instant and a
lifecycle `status`. Full CRUD plus `snooze`, a `due()` method the server polls,
and a `counts()` for the bell badge. Zero npm dependencies — Node built-ins only
(`fs`, `path`, `os`, `crypto`).

Reminders persist to `~/.clone-frame-hub/reminders.json` (`chmod 600`, directory
`chmod 700`) via an atomic tmp-write-then-rename. A missing or corrupt store
degrades to empty — it never throws. A reminder has no secret fields; the public
view is nonetheless a strict whitelist, so any stray key from a hand-edited store
never leaves the module. The module logs nothing.

## Routing

Served by `hub-bridge.mjs`'s generic module RPC: `POST /mod/reminders { fn, args }`,
which invokes `Reminders[fn](...args)`. Every method is therefore directly
callable with plain JSON arguments and returns JSON-serializable values.

## Import

```js
import { Reminders } from './reminders.mjs';
// or: import Reminders from './reminders.mjs';                                  (default export, same object)
// or: import { list, get, create, update, remove, snooze, markDone, due, counts } from './reminders.mjs';
```

`Reminders` is a plain object of the functions below — use whichever import style
fits the existing router.

## Error model

- **Write-path** (`create`, `update`, `remove`, `snooze`, `markDone`) always
  returns `{ok, ...}` and **never throws** for an expected failure — a missing
  id, an empty note, an unparseable `remindAt`, a bad `minutes`, or a disk error
  resolves to `{ok:false, error:string}`.
- **Read-path** (`list`, `get`, `due`, `counts`) returns values directly; a
  missing or corrupt store resolves to `[]` / `null` / zeroed counts, never a
  throw.

## Route contract

```
list({status='all'}={}) -> Reminder[]
  Soonest first (by remindAt asc; unparseable remindAt sorts last, createdAt
  tiebreak). `status` is one of 'all' | 'pending' | 'done' | 'dismissed'; an
  unknown value is treated as 'all'.

get(id) -> Reminder | null
  The full reminder, or null when the id is unknown.

create({note, remindAt, refType?, refId?}) -> {ok, id?, error?}
  Requires a non-empty `note` and a parseable `remindAt` (see Instant formats).
  New reminders start `status:'pending'`. `refType`/`refId` are optional
  free-form links back to the source object (e.g. an email uid or task id),
  trimmed and capped at 200 chars each; omitted → null.

update(id, patch) -> {ok, error?}
  patch: any subset of {note, remindAt, status, refType, refId}. Provided fields
  replace the old value; `updatedAt` is bumped. `remindAt` is re-validated;
  `status` must be pending|done|dismissed; `note` cannot be emptied. Setting
  status to 'done' stamps `doneAt`, any other status clears it.
  {ok:false,'update: reminder not found'} when the id is unknown.

remove(id) -> {ok, error?}
  {ok:false,'remove: reminder not found'} when the id is unknown.

snooze(id, minutes) -> {ok, remindAt?, error?}
  Re-arms the reminder: sets remindAt = now + `minutes`, status → 'pending',
  clears `doneAt`, and increments `snoozedCount`. `minutes` must be a positive
  finite number ≤ 525600 (one year). Returns the new `remindAt` on success.

markDone(id) -> {ok, error?}
  Idempotently sets status 'done' and stamps `doneAt` (first time only).
  {ok:false,'markDone: reminder not found'} when the id is unknown.

due(now?) -> Reminder[]
  Pending reminders whose remindAt has arrived (remindAt <= now), soonest first.
  `now` is optional — an ISO string or epoch-ms number; missing/unparseable
  falls back to the current time. Reminders with an unparseable remindAt are
  never considered due. This is the method the server polls.

counts(now?) -> {total, pending, due, done, dismissed}
  Badge counts for the sidebar bell. `due` counts pending reminders already at or
  past `now` (same rule as due()). `now` behaves as in due().
```

## Reminder JSON shape

`get(id)` / `list(...)` return the full record (there is no separate list view —
reminders are small):

```jsonc
{
  "id": "b3e1...",                        // randomUUID()
  "note": "Ping the OKX hackathon team",
  "remindAt": "2026-07-10T09:00:00.000Z", // canonical UTC ISO
  "status": "pending",                    // pending | done | dismissed
  "refType": "email",                     // optional source link, or null
  "refId": "182",                         // optional source id, or null
  "snoozedCount": 0,                      // times snoozed
  "createdAt": "2026-07-09T18:32:10.512Z",
  "updatedAt": "2026-07-09T18:40:02.001Z",
  "doneAt": null                          // ISO once marked done, else null
}
```

### Instant formats (`remindAt`, `now`)

`remindAt` accepts an ISO / RFC-2822 date string, a bare `YYYY-MM-DD` (→ UTC
midnight), or an **epoch-milliseconds** number. It is stored canonically as a
UTC ISO string. `due(now)` / `counts(now)` accept the same string forms or an
epoch-ms number; a missing or unparseable `now` falls back to the current time.

### Field rules

- `note` — trimmed, required, capped at **4000** characters. It cannot be emptied
  via `update`.
- `status` — `pending` | `done` | `dismissed`. New reminders are `pending`.
  `due()` only ever returns `pending` ones.
- `refType` / `refId` — optional strings, trimmed, capped at **200** characters;
  anything falsy becomes `null`.

## Storage

`~/.clone-frame-hub/reminders.json`

```jsonc
{ "version": 1, "reminders": [ /* Reminder[] */ ] }
```

Written atomically (`reminders.json.<pid>.<ts>.tmp` → `rename`), file mode
`0600`, directory mode `0700`. On read, entries missing an `id` are dropped and
the rest are defensively re-typed to the shape above, so a partially hand-edited
file still loads cleanly instead of poisoning a read.

## Self-test

Zero test-framework dependency (per the zero-deps constraint). Validate with:

```
node --check reminders.mjs
```

A one-off self-test was run during development against a backed-up store: it
asserts every documented method exists; exercises create → list → get → snooze →
markDone → update → remove; checks `due()` returns a past-due pending reminder
and excludes a future one; verifies the `status` filter on `list()`; confirms
`reminders.json` is written `0600` inside a `0700` directory; corrupts the store
file and confirms `list()`/`due()` degrade to `[]`; and confirms `create({})`,
`create({note})` (no `remindAt`), an unparseable `remindAt`, `update('missing')`,
`remove('missing')`, `snooze('missing', 5)`, `snooze(id, 'abc')` and
`markDone('missing')` all return `{ok:false, error}` (and `get('missing')`
returns `null`) without throwing. The original store is restored afterwards.
```
