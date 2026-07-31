# search.mjs — global cross-module search

Stateless, read-only aggregator. One query in, results from every content
module the HUB knows about, out. Zero new dependencies. Sibling modules are
loaded lazily (only inside `query()`, only when a query actually runs), each
behind its own `try/catch`, so a missing file or a broken store in one module
can never take down the search as a whole — that module's group is simply
left out of the response.

## Import

```js
import Search, { query, modules } from './search.mjs';
// or: import { Search } from './search.mjs';   (Search === default export)
```

## Contract

### `Search.query(q, { limit = 8 } = {}) -> Promise<{ groups: Group[] }>`

- `q` — search string. Matching is case-insensitive. Empty/blank `q` resolves
  immediately to `{ groups: [] }` without touching any module.
- `limit` — max results per module group (default `8`). Non-finite or ≤0
  values fall back to the default.
- Never throws. Never rejects. A module that is missing, or whose lazy
  `import()` throws, or whose `list()`/`search()` call throws, contributes no
  group — every other module's results are unaffected.
- Modules with zero matches are omitted from `groups` (no empty groups).

```ts
type Group = {
  module: string;   // e.g. 'notes'
  label: string;    // e.g. 'Notes'
  results: { id: string; title: string; snippet: string }[];
};
```

### `Search.modules() -> string[]`

Returns the fixed set of module keys this aggregator searches, in query
order: `['notes', 'tasks', 'reminders', 'research']`.

> This listed seven for a long time. `library`, `contacts` and `cookbook` are not modules in
> this bridge — there are no such files — so three rows of the mapping below described calls
> that could never be made. Nothing user-facing reads `modules()`; a contributor trusting the
> "Verified" heading would have.

## Module → field mapping

| module      | source call                                              | filtered on              | `title`         | `snippet`             |
|-------------|-----------------------------------------------------------|---------------------------|------------------|------------------------|
| `notes`     | `Notes.list({ search: q })`                               | module-native search      | `title`          | `snippet`              |
| `tasks`     | `Tasks.list()` then filtered locally                        | `name`, `category`        | `name`           | `category`             |
| `reminders` | `Reminders.list()` then filtered locally                    | `note`, `status`          | `note`           | `status`                |
| `research`  | `Research.list()` then filtered locally                     | `question`                | `question`       | `createdAt`             |

Modules that expose their own `{search}` filter (`notes`) delegate matching to
them. Modules that only expose a plain
`list()` (`tasks`, `reminders`, `research`) are filtered locally
with a case-insensitive substring match across the fields listed above.

## Verified

- `node --check search.mjs` passes.
- `Search.query('x')` returns a well-formed `{ groups: [...] }` shape even
  when every sibling store is empty (groups are simply omitted, never
  malformed).
- `Search.query('')` short-circuits to `{ groups: [] }`.
- Resilience: with a sibling `import()` path deliberately pointed at a
  non-existent file, that module's group is silently omitted while every
  other module's group is returned unaffected and the top-level shape stays
  well-formed. (Verified against a temporary in-place copy; no permanent
  file was altered.)
