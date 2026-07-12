# CLONE FRAME · HUB Bridge — Notes Engine

`notes.mjs` powers the HUB's **Notes** sidebar: Markdown notes with a title,
body, tags and timestamps. Full CRUD plus case-insensitive text search and a
tag index. Zero npm dependencies — Node built-ins only (`fs`, `path`, `os`,
`crypto`).

Notes persist to `~/.clone-frame-hub/notes.json` (`chmod 600`, directory
`chmod 700`) via an atomic tmp-write-then-rename. A missing or corrupt store
degrades to empty — it never throws. There are no secret fields in a note, so
nothing is stripped or redacted; the module logs nothing.

## Routing

Served by `hub-bridge.mjs`'s generic module RPC: `POST /mod/notes { fn, args }`,
which invokes `Notes[fn](...args)`. Every method is therefore directly callable
with plain JSON arguments and returns JSON-serializable values.

## Import

```js
import { Notes } from './notes.mjs';
// or: import Notes from './notes.mjs';                        (default export, same object)
// or: import { list, get, create, update, remove, tags } from './notes.mjs';
```

`Notes` is a plain object of the functions below — use whichever import style
fits the existing router.

## Error model

- **Write-path** (`create`, `update`, `remove`) always returns `{ok, ...}` and
  **never throws** for an expected failure — a missing id, an empty note, or a
  disk error resolves to `{ok:false, error:string}`.
- **Read-path** (`list`, `get`, `tags`) returns values directly; a missing or
  corrupt store resolves to `[]` / `null`, never a throw.

## Route contract

```
list({search='', tag=''}={}) -> Note[]
  Newest first (by updatedAt desc, then createdAt desc). Each item is a LIST
  VIEW: the full body is replaced by a `snippet` (see below). Both filters are
  optional and combine with AND:
    search: case-insensitive substring match against title, body and tags.
    tag:    case-insensitive EXACT match against one of the note's tags.

get(id) -> Note | null
  The full note, including the complete `body`. null when the id is unknown.

create({title, body, tags?}) -> {ok, id?, error?}
  Requires at least one non-empty of `title` / `body`. `tags` may be a string
  array or a comma-separated string; both are normalized (see Tag rules).

update(id, patch) -> {ok, error?}
  patch: any subset of {title, body, tags}. Provided fields replace the old
  value (tags are re-normalized/deduped, not appended); `updatedAt` is bumped.
  {ok:false,'update: note not found'} when the id is unknown.

remove(id) -> {ok, error?}
  {ok:false,'remove: note not found'} when the id is unknown.

tags() -> string[]
  Sorted, de-duplicated union of every tag across all notes (original casing
  preserved, deduped case-insensitively).
```

## Note JSON shape

`get(id)` returns the full record:

```jsonc
{
  "id": "b3e1...",                       // randomUUID()
  "title": "Launch checklist",
  "body": "# Ship\n- [ ] audit\n- [ ] tag release",   // raw Markdown
  "tags": ["release", "ops"],
  "createdAt": "2026-07-09T18:32:10.512Z",
  "updatedAt": "2026-07-09T18:40:02.001Z"
}
```

`list(...)` returns the **list view** of each note — identical, except `body`
is dropped in favour of a `snippet`:

```jsonc
{
  "id": "b3e1...",
  "title": "Launch checklist",
  "snippet": "Ship audit tag release",   // Markdown-stripped, whitespace-collapsed, ≤220 chars
  "tags": ["release", "ops"],
  "createdAt": "2026-07-09T18:32:10.512Z",
  "updatedAt": "2026-07-09T18:40:02.001Z"
}
```

### Snippet rule

The `snippet` is a plain-text preview derived from the Markdown body: fenced and
inline code, images, link URLs (link text kept), heading/blockquote/list markers
and emphasis marks are stripped, whitespace is collapsed to single spaces, and
the result is truncated to **220 characters** on a word boundary with a trailing
`…`. It is display-only — the canonical content is always the raw `body` from
`get(id)`.

### Tag rules

Tags accept either a `string[]` or a comma-separated `string`. Each tag is
trimmed, capped at **64 characters**, and empty tags are dropped. A note keeps
at most **50** tags. Deduplication is case-insensitive but the first-seen
casing is preserved for display.

## Storage

`~/.clone-frame-hub/notes.json`

```jsonc
{ "version": 1, "notes": [ /* Note[] */ ] }
```

Written atomically (`notes.json.<pid>.<ts>.tmp` → `rename`), file mode `0600`,
directory mode `0700`. On read, entries missing an `id` are dropped and the rest
are defensively coerced to the shape above, so a partially hand-edited file
still loads cleanly.

## Self-test

Zero test-framework dependency (per the zero-deps constraint). Validate with:

```
node --check notes.mjs
```

A one-off self-test was run during development against a backed-up store: it
asserts every documented method exists; exercises create → list → get → update →
remove; checks `list` is newest-first with a truncated snippet; checks `tags()`
dedupes; verifies `notes.json` is written `0600` inside a `0700` directory;
corrupts the store file and confirms `list()` degrades to `[]`; and confirms
`create({})`, `update('missing', …)` and `remove('missing')` all return
`{ok:false, error}` (and `get('missing')` returns `null`) without throwing. The
original store is restored afterwards.
