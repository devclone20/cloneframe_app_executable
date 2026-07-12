# Prompt Cookbook

Local-only module powering the **Cookbook** sidebar: a library of reusable
prompt recipes ("skills"). Each recipe has a name, category, description, a
prompt **template with `{{variables}}`**, and tags. `run(id, vars)` fills the
variables and calls Claude via `./llm.mjs` (BYOK, non-streaming).

Ships ~8 curated **built-in** recipes: Email Reply, Summarize,
Translate → PT (Portugal), Code Review, Brainstorm, Rewrite Formal,
Extract Action Items, Meeting Notes. Built-ins are defined in code —
improvements to them ship with the module and they can never drift on disk.

```js
import { Cookbook } from './cookbook.mjs';
// or: import Cookbook from './cookbook.mjs';           (default export, same object)
// or: import { list, get, add, update, remove, run, categories } from './cookbook.mjs';
```

Routed by the bridge as `POST /mod/cookbook {fn, args}` → `Cookbook.<fn>(...args)`.
Every method is directly callable with plain JSON args and returns
JSON-serializable values.

## Storage

- File: `~/.clone-frame-hub/cookbook.json`, dir `0700`, file `0600`.
- Shape on disk: `{version: 1, recipes: UserRecipe[]}` — **only user-created
  recipes are persisted**. Built-ins live in code and are merged in at read time.
- Writes are atomic: write to a pid+timestamp temp file, `chmod 0600`, then
  `rename()` over the target — a crash mid-write can never corrupt the store.
- A missing or corrupt store degrades to **empty** (built-ins still appear);
  it never throws.

## Error model

- **Write-path** (`add`, `update`, `remove`) and `run` never throw for expected
  failures — they return `{ok: false, error: string}`.
- **Read-path** (`list`, `get`, `categories`) return values directly and never
  throw (`[]` / `null` on "nothing found").

## Recipe shape (returned by `list` / `get`)

```ts
{
  id: string,            // stable "builtin-*" id, or uuid for user recipes
  name: string,
  category: string,      // e.g. "email" | "code" | "productivity" | "custom"
  description: string,
  template: string,      // prompt text containing {{variables}}
  variables: string[],   // DERIVED from template, in first-seen order
  tags: string[],        // lowercased, de-duplicated
  system: string,        // optional system prompt used by run()
  isBuiltin: boolean,    // true → not editable, not removable
  createdAt: string|null,// ISO 8601 (null for built-ins)
  updatedAt: string|null,
}
```

## Variables

Variables are written `{{name}}` in the template (whitespace-tolerant:
`{{ name }}`). Names may contain letters, digits, `_`, `.`, `-`. The
`variables` array on every recipe is derived from the template, so the UI can
render one input per variable.

`run(id, vars)` substitutes each declared variable **once** (a value that itself
contains `{{...}}` is never re-scanned — no nested substitution / injection).
Value coercion: strings verbatim; numbers/booleans stringified; arrays joined by
newlines; objects `JSON.stringify`-ed; `null`/`undefined` → `""`. Any variable
declared in the template but **absent** from `vars` makes `run` fail loudly with
`{ok:false, error:"missing variables: …"}` rather than sending a half-filled
prompt to the model.

## API

### `list({category = ''} = {}) -> Recipe[]`
All recipes (built-ins first in curated order, then user recipes newest-first).
`category` filters by exact category (case-insensitive); `''` returns all.

### `get(id) -> Recipe | null`
The recipe with that id, or `null`.

### `categories() -> string[]`
Sorted, de-duplicated list of all categories in use (built-in + user).

### `add({name, category?, description?, template, tags?, system?}) -> {ok, id?} | {ok:false, error}`
Creates a user recipe. `name` and `template` are required non-empty strings
(`template` ≤ 20 000 chars). `category` defaults to `"custom"`. `tags` are
lowercased and de-duplicated. Unknown fields are ignored (never persisted).

### `update(id, patch) -> {ok} | {ok:false, error}`
Patches a user recipe. Editable keys: `name`, `category`, `description`,
`template`, `tags`, `system` (any other keys in `patch` are ignored). Empty
`name`/`template` are rejected. **Built-in → `{ok:false}`.** Missing id →
`{ok:false, error:"not found"}`.

### `remove(id) -> {ok} | {ok:false, error}`
Deletes a user recipe. **Built-in → `{ok:false}`.** Missing id →
`{ok:false, error:"not found"}`.

### `run(id, vars) -> Promise<{ok, output?} | {ok:false, error}>`
Fills the recipe's template with `vars`, then calls Claude via `ask()` from
`./llm.mjs` with the recipe's optional `system` prompt (default `maxTokens`
1024). Returns `{ok:true, output}` with the model's text. Returns
`{ok:false, error}` for: unknown id, missing template variables, no
`ANTHROPIC_API_KEY` on the machine, or any upstream/network error. Never throws.

## Security & privacy

- Purely local. No secrets are stored, logged, or returned — recipes contain no
  credential fields. The Anthropic key is read by `./llm.mjs` from the machine
  and never touches this module's store or return values.
- Values are substituted single-pass, so recipe output cannot recursively expand
  attacker-supplied `{{...}}` markers.
