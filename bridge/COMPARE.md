# Model Compare

Local-only module behind the sidebar **Compare** feature: run the *same*
prompt across several models at once and get their outputs **side-by-side**,
each with its own latency (`ms`) and, on failure, a per-model `error`. One
model erroring never sinks the others — every model is run independently and
in parallel. Persists to `~/.clone-frame-hub/compare.json` (dir `0700`, file
`0600`). Zero npm dependencies.

```js
import { Compare } from './compare.mjs';
// or: import Compare from './compare.mjs';                 (default export, same object)
// or: import { run, history, get, remove } from './compare.mjs';
```

The HUB Bridge routes to it generically: `POST /mod/compare {fn, args}` →
`Compare[fn](...args)`. Every method is directly callable with plain JSON args
and returns JSON-serializable values.

## Model resolution

`run()` lazily imports `./models.mjs` (if it exists) to turn each entry of
`models` — which may be a provider/model **alias** — into a concrete API model
id. It probes, in order, `Models.resolve(x)`, `Models.resolveModel(x)`,
`Models.get(x)`, then a scan of `Models.list()` (matching `id`/`alias`/`key`/
`name`/`model`), accepting the first that yields a usable id.

If `./models.mjs` is absent, half-built, or can't resolve an entry, the raw
string is used **literally** as the model id passed to `ask()`. So you can
always pass explicit ids like `claude-opus-4-8` / `claude-sonnet-5` with no
`models.mjs` present.

## Error model

- **Write-path** (`run`, `remove`) never throw for expected failures — they
  return `{ok: false, error}`. `run()` additionally isolates each model: a
  model that errors or times out yields a result with an `error` field while
  the others still return their `text`.
- **Read-path** (`history`, `get`) return values directly (`[]` / `null` on
  "nothing found") and never throw.
- A corrupt or missing store is treated as empty, never thrown.

## Security

- No secret (`apiKey`/`password`/`token`) is ever stored or returned. A run
  record holds only the prompt, the optional system prompt, the requested
  model ids, and the model outputs. `get()` additionally runs a defensive
  redaction pass that strips any secret-named key before returning.
- Nothing is logged.

## API

### `run({prompt, models, system?, maxTokens?, timeoutMs?}) -> Promise<{ok, id?, results, error?}>`
Runs `prompt` across every id in `models` (a non-empty `string[]`) in
parallel via `ask()`.

- `prompt` — required non-empty string.
- `models` — required non-empty `string[]`. Entries are trimmed, de-duplicated,
  and capped at **12** per run.
- `system` — optional system prompt applied to every model.
- `maxTokens` — optional per-model output cap (default `2048`).
- `timeoutMs` — optional per-model wall-clock cap (default `120000`); on
  expiry that model's result carries `error: "timed out after <n>ms"`.

Returns `{ok, id, results}` where `results` preserves the input order:

```ts
results: {
  model: string,          // the id you requested (column label)
  resolvedModel: string,  // the concrete id actually sent to ask()
  text: string,           // model output ('' on error)
  ms: number,             // latency in milliseconds
  error?: string,         // present only when that model failed
}[]
```

`ok` is `true` when **at least one** model produced output without error. Bad
input (missing prompt, empty/invalid `models`) returns
`{ok: false, error, results: []}` without throwing. Every run — including
all-error runs — is appended to history under the returned `id`.

### `history({limit = 20} = {}) -> {id, prompt, models, createdAt}[]`
Most-recent-first summaries of past runs (no `results` payload — lightweight
for list rendering). `limit` defaults to `20`.

### `get(id) -> object | null`
The full run record for `id` (including every `results` entry), or `null` if
unknown / `id` missing.

### `remove(id) -> {ok, error?}`
Deletes one run from history. `{ok: false, error}` if `id` is missing or
doesn't exist.

## Storage

- File: `~/.clone-frame-hub/compare.json`, dir `0700`, file `0600`.
- Shape: `{version: 1, runs: Run[]}` where a `Run` is
  `{id, prompt, system, models, results, createdAt}`.
- History is bounded to the **100** most recent runs; older runs are dropped on
  write.
- Writes are atomic: write to a pid/timestamp-suffixed temp file, `chmod 0600`,
  then `rename()` over the target — a crash mid-write can never corrupt the
  store or leave it partially written.
- A corrupt or missing store is read as empty (`{version: 1, runs: []}`).
