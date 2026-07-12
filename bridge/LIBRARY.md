# CLONE FRAME · HUB Bridge — Document Library / Knowledge Base

`library.mjs` powers the sidebar **Library**: a local knowledge base of text
documents the user pastes or imports. Each document carries a `name`,
`mimeType`, byte `size`, `tags`, and — for textual content types — extracted,
searchable `text`. Zero npm dependencies (Node built-ins only). Full-text
search is a hand-rolled term/occurrence scanner in this file (no `lunr`/
`flexsearch`/etc.).

Documents persist to `~/.clone-frame-hub/library.json` (`chmod 600`, directory
`chmod 700`, atomic tmp-write-then-rename). A missing or corrupt store degrades
to empty rather than throwing.

## Import

```js
import { Library } from './library.mjs';
// or: import Library from './library.mjs';                 (default export, same object)
// or: import { list, add, get, search, remove } from './library.mjs'; (named exports)
```

`Library` is a plain object of the functions below — every method is directly
callable with plain JSON args (the generic `/mod/<name>` RPC calls
`obj.fn(...args)`) and returns JSON-serializable values.

## Error model

Write-path methods (`add`, `update`, `remove`) return `{ok, ...}` and **never
throw** for expected failures — a missing id, an empty name, or an
oversized document all resolve to `{ok:false, error:string}`. Read-path methods
(`list`, `get`, `search`, `count`) return values directly; `get` returns `null`
for an unknown id, and the others return empty results rather than throwing.

## Text extraction rule

- `text` (a string) is always taken verbatim as the document's content.
- `contentBase64` is decoded (a `data:<mime>;base64,…` URI prefix and embedded
  whitespace are accepted). Only **textual** MIME types are extracted into
  searchable text: every `text/*`, any `*+json` / `*+xml`, and a small
  allowlist (`application/json`, `application/xml`, `application/yaml`,
  `application/javascript`, `application/markdown`, `application/sql`,
  `application/toml`, `application/x-sh`, `application/csv`, …).
- **Non-textual binary is stored as metadata only** — `name`, `mimeType`,
  `size`, `tags`. The blob itself is never persisted (the store stays lean).
  Such a document has `hasText:false` and `get().text === ''`.
- Supplying neither `text` nor `contentBase64` creates a valid empty note
  (`size:0`), still searchable by name and tags.

MIME type is resolved from the explicit `mimeType`, then a `data:` URI mime,
then the filename extension, finally defaulting to `text/plain` (text input) or
`application/octet-stream` (binary input).

## Route contract

```
list({search='', tag='', limit=500}={}) -> Doc[]
  Metadata + snippet only (NO full text). Newest first.
  search: case-insensitive full-text filter over name + tags + content; ALL
          whitespace-separated terms must match (AND).
  tag:    narrow to documents carrying this exact tag (case-insensitive).
  limit:  max rows returned (post-filter).

get(id) -> Doc | null
  Full document, including `text` (empty string for metadata-only binary).

add({name, mimeType?, text?, contentBase64?, tags?}) -> {ok, id?, error?}
  name is required. tags may be an array or a comma-separated string.
  Rejects documents whose content exceeds 8 MiB with {ok:false,error:'document too large'}.

update(id, patch) -> {ok, error?}
  patch: any subset of {name, mimeType, text, tags}. Providing `text` recomputes
  size and marks the document as text-bearing.

remove(id) -> {ok, error?}

search(query) -> {docId, name, excerpts:string[]}[]
  Full-text search over name + tags + content (AND across terms). Ranked by
  total term frequency, newest first as a tiebreak, capped at 50 results.
  `excerpts` are up to 3 collapsed-whitespace context windows (~60 chars each
  side) around the matches, ellipsis-marked. When a match comes only from the
  name/tags (or a metadata-only doc), a single preview excerpt is returned.

count() -> number
```

## Document JSON shape

```jsonc
// list() — metadata + snippet, no full text
{
  "id": "b3e1...",                        // randomUUID()
  "name": "Q3 Strategy.md",
  "mimeType": "text/markdown",
  "size": 4096,                           // byte size of the original content
  "tags": ["strategy", "2026"],
  "hasText": true,                        // false for metadata-only binary
  "textLength": 3980,                     // characters of extracted text
  "snippet": "Executive summary …",       // single-line preview (≤200 chars)
  "createdAt": "2026-07-09T18:32:10.512Z",
  "updatedAt": "2026-07-09T18:32:10.512Z"
}

// get() — same, minus `snippet`, plus the full `text`
{ "...": "...", "text": "# Q3 Strategy\n\nExecutive summary …" }
```

## Security notes

- Documents carry no credential fields; `list`/`get`/`search` project each
  record explicitly (never spread the raw object) so nothing unexpected can
  leak. The store file is `0600` inside a `0700` directory.
- Content is the user's own knowledge base and is returned verbatim by `get`
  and `search` — this module does not sanitize document text for HTML/JS. Any
  UI rendering the content is responsible for escaping/sanitizing at the
  boundary.
- No secrets are ever logged.

## Self-test

Run directly (no test framework, no deps):

```
node --check library.mjs
```

A one-off self-test (assert every documented method exists; add a text doc and
a metadata-only binary doc; list/get/search/remove them; confirm
`~/.clone-frame-hub/library.json` is written `0600` in a `0700` directory; and
verify malformed input — e.g. `add()` with no name, `get(undefined)`,
`search('')`, `remove('nope')` — degrades gracefully without throwing) was run
during development and is not shipped as part of this module (no test-framework
dependency was added, per the zero-deps constraint).
