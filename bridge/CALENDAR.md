# CLONE FRAME · HUB Bridge — Calendar Engine (CalDAV)

`calendar.mjs` is the HUB's calendar (Settings → Calendar). It connects to a
single **CalDAV collection**, lists events in a date range, and creates/deletes
events — over the real CalDAV protocol (`PROPFIND` / `REPORT calendar-query` /
`PUT` / `DELETE`) using the global `fetch`. Zero npm dependencies: the
multistatus XML and the iCalendar `VEVENT` bodies are parsed by hand-rolled
scanners in this file (no `ical`, no `xml2js`).

## Import

```js
import { Calendar } from './calendar.mjs';
// or: import Calendar from './calendar.mjs';   // default export — same object
```

The server routes generic RPC as `Calendar.fn(...args)`, so every method is
directly callable with plain JSON args and returns JSON-serializable values.

## Storage & secrets

Two files under `~/.clone-frame-hub/` (dir `chmod 700`, both files `chmod 600`,
written tmp-then-rename):

| File | Contents |
|---|---|
| `calendar.json` | **non-secret** — `{ connection: { url, connectedAt } \| null, events: [cache] }` |
| `calendar.secret.json` | **credentials only** — `{ url, user, pass }` |

The credentials live in their own `0600` file and are **never returned** by any
method. `status()` exposes the `url` and nothing else; the main store is
verified to contain no secret. Nothing is ever logged.

## Error model

- **Write-path** (`connect`, `disconnect`, `createEvent`, `deleteEvent`) always
  returns `{ ok: boolean, ... }` and **never throws** — expected failures resolve
  to `{ ok: false, error }`.
- **Read-path** (`status`, `events`, `upcoming`) returns values directly and
  never throws. Not connected, a network/parse failure, or a corrupt store all
  degrade to `{ connected: false }` / `[]` rather than throwing. `events()` and
  `upcoming()` fall back to the local cache when the server is unreachable.

## Route contract

```
connect({url, user, pass}) -> Promise<{ok, error?}>
  Validates reachability + auth with a Depth:0 PROPFIND, then persists the
  creds (separate 0600 file) and the non-secret url. 401/403 -> auth error;
  non-2xx/207 -> error. url must be http(s).

status() -> {connected, url?}
  connected iff both the connection record and the credential file exist.
  Never returns user/pass.

disconnect() -> {ok}
  Removes the credential file and clears the cached connection + events.
  Always resolves {ok:true} (local operation).

events({from, to}) -> Promise<Event[]>
  Live REPORT calendar-query with a VEVENT time-range filter over [from, to],
  refreshes the local cache, returns events overlapping the window (soonest
  first). from/to accept ISO strings, epoch ms, or Date; defaults to
  [now-7d, now+60d] when omitted. Not connected -> []. On network/parse
  failure -> cached events in range.

createEvent({summary, start, end, location?}) -> Promise<{ok, uid?, error?}>
  Builds a minimal VEVENT and PUTs it to <collection>/<uid>.ics with
  If-None-Match:* (a fresh uuid can't clobber an existing resource). start/end
  accept a bare "YYYY-MM-DD" (all-day DATE value) or any datetime (normalized
  to a UTC instant). Rejects missing summary, unparseable dates, and end<start.

deleteEvent(uid) -> Promise<{ok, error?}>
  DELETE by href — the cached href when known, else the derived
  <collection>/<uid>.ics. A 404 is treated as success (idempotent).

upcoming({limit=10}) -> Promise<Event[]>
  The next `limit` events from now (includes in-progress events), soonest
  first. Built on events(); limit is clamped to 0..500.
```

## Event shape

```jsonc
{
  "uid": "mock-1",
  "summary": "Standup",
  "start": "2026-08-01T10:00:00Z",   // UTC instant, or "YYYY-MM-DD" (all-day),
                                     //   or naive "YYYY-MM-DDTHH:MM:SS" (TZID/floating)
  "end": "2026-08-01T11:00:00Z",     // DTEND, or DTSTART+DURATION, or = start
  "location": "HQ",
  "href": "https://dav.example.com/cal/mock-1.ics"
}
```

## Date/time handling

`DTSTART`/`DTEND` are parsed into ISO-ish strings without pulling in a timezone
library: UTC values (`…Z`) become proper ISO instants; `VALUE=DATE` all-day
values become `YYYY-MM-DD`; `TZID`-qualified or floating local times are
preserved as **naive wall-clock** (`YYYY-MM-DDTHH:MM:SS`) rather than guessed —
resolving an arbitrary IANA zone is out of scope with zero dependencies. On the
wire, outgoing `createEvent` start/end are always emitted as UTC (`…Z`) or as an
all-day `VALUE=DATE`. iCalendar text values are escaped/unescaped (`\, \; \\ \n`)
and long lines are folded per RFC 5545.

## Caveats

- **Single collection.** One connection at a time. Point `url` at a specific
  calendar collection (not the calendar-home) so the `REPORT`/`PUT`/`DELETE`
  paths resolve correctly.
- **Basic auth only.** `user:pass` over HTTPS. No OAuth/Digest.
- **Recurrence.** `RRULE` expansion is not performed — recurring events are
  returned as their master `VEVENT`. Server-side expansion (when the server
  returns expanded instances in the REPORT) flows through unchanged.
- Non-UTC (`TZID`) times are naive; do arithmetic on `…Z` values for exactness.

## Self-test

```
node --check calendar.mjs
```

A standalone self-test (spins up an in-process mock CalDAV server and exercises
connect → status → events → upcoming → createEvent → deleteEvent → disconnect;
asserts all seven methods exist, that both files are `0600` in a `0700` dir,
that the secret file holds the password while the main store and `status()` do
not, and that bad input / unreachable host / corrupt store all degrade without
throwing) was run during development — 47/47 assertions pass. It is not shipped
as part of the module (no test-framework dependency was added, per the zero-deps
constraint).
```

MIT.
