# Admin Engine — `admin.mjs`

The **Settings › ADMIN** backend for the CLONE FRAME HUB Bridge. A single, small,
zero-dependency module that powers three panes: **Agent Tools**, **Users**, and
**System**.

It is routed by `hub-bridge.mjs` like every other module — one token-gated call
per method:

```
POST /mod/admin   { "fn": "<method>", "args": [ ... ] }  →  JSON
```

The server invokes `Admin.<fn>(...args)`, so **every argument is plain JSON and
every return value is JSON-serializable**.

> To wire it up, add `admin: './admin.mjs'` to `MODULES` and `admin: 'Admin'` to
> `MODEXPORT` in `hub-bridge.mjs`. This module ships those edits nowhere — it is
> self-contained and import-safe. (Making that edit is the operator's call.)

---

## Design guarantees

- **Zero dependencies** — Node built-ins only (`fs`, `path`, `os`, `crypto`, `url`).
- **Import-safe** — no side effects at import time, no top-level `await`, no
  sibling imports. Load order can never break it.
- **Store** — `~/.clone-frame-hub/admin.json`, directory `0700`, file `0600`,
  written atomically (tmp file → `rename`).
- **Read paths never write.** `tools()`, `users()`, `system()`, `logs()` never
  mutate the store. Built-in tools and the default user are synthesized in
  memory; they are only persisted when an actual write happens.
- **Write paths never throw for expected failures.** They return
  `{ ok: false, error }`. They only ever return `{ ok: true, ... }` on success.
- **Corrupt / missing store degrades to empty** — it never throws.
- **Secrets** are never persisted, never returned, and are scrubbed out of log
  output. This module has no secret-bearing fields by design; only whitelisted
  fields ever leave it.

---

## Methods

### `tools() -> Tool[]`
Returns the capability registry, built-ins first, then custom tools A→Z.

```ts
type Tool = {
  id: string;            // "builtin:<name>" for seeds, "tool_<uuid>" for custom
  name: string;          // slug: [a-z0-9._-]
  kind: string;          // "email" | "shell" | "http" | "custom" | ...
  enabled: boolean;      // seeds ship false — opt-in only
  scopes: string[];      // e.g. ["email:send"]
  isBuiltin: boolean;
  description: string;
  createdAt: string | null;  // ISO
  updatedAt: string | null;  // ISO
};
```

Seeded **DISABLED** built-ins: `email.send` (kind `email`), `shell.run`
(kind `shell`), `web.fetch` (kind `http`). Built-ins self-heal — they are always
present, never duplicated, and cannot be removed (only disabled).

### `setToolEnabled(id, enabled) -> { ok, id?, enabled?, error? }`
Toggle one tool by id. `enabled` is coerced to boolean. Unknown id → `{ok:false}`.

### `addTool({ name, kind?, scopes?, description? }) -> { ok, id?, error? }`
Register a **custom** tool. Always created **disabled**. `name` is required and
slug-sanitized; a reserved built-in name or a duplicate is rejected. `scopes` are
sanitized, de-duplicated, and capped (32 × 64 chars). Returns the new
`tool_<uuid>` id.

### `removeTool(id) -> { ok, error? }`
Remove a custom tool. Built-ins are protected (`{ok:false}` — disable instead).
Unknown id → `{ok:false}`.

### `users() -> User[]`
The local single-user roster — always exactly one entry. When no profile has been
saved, one is synthesized from the OS username (role `owner`); this read does not
write to disk.

```ts
type User = { id: string; name: string; role: string; updatedAt: string | null };
```

### `setProfile({ name, role? }) -> { ok, user?, error? }`
Update the local profile. `name` is required (trimmed, ≤120 chars). `role` is
optional (trimmed, ≤40 chars; default `owner`, preserved across updates).

### `system() -> SystemStatus`
Read-only status.

```ts
type SystemStatus = {
  node: string;                              // process.version, e.g. "v26.0.0"
  uptimeSec: number;                         // whole seconds
  configDir: string;                         // ~/.clone-frame-hub
  stores: { name: string; bytes: number }[]; // every *.json in configDir, A→Z
  schedulerHealthy: boolean;                 // see below
  version: string;                           // bridge package.json version
};
```

**`schedulerHealthy`** is a decoupled, side-effect-free probe: it reads
`tasks.json` from disk and reports `false` only when a **running** task is overdue
past a 5-minute grace window (a strong signal the in-process scheduler tick has
stalled). Missing / all-paused / unreadable stores read as healthy — no false
alarms. It does **not** import or start `tasks.mjs`.

### `logs({ lines = 80 }) -> string[]`
The last `N` lines of `~/.clone-frame-hub/server.log`, **scrubbed**. `lines` is
clamped to `[1, 2000]`. Missing/unreadable log → `[]`. Accepts a bare number or a
`{lines}` object; bad input never throws.

Scrubbing pipeline, per line: ANSI colour codes stripped → literal on-machine
secrets redacted (bridge pairing token, `ANTHROPIC_API_KEY`) → pattern redaction
of `sk-ant-…` / `sk-…` keys, JWTs, AWS/GitHub/Slack tokens, `Bearer …`,
`token=…`, and `apiKey/password/secret/authorization: …` assignments. Only the
trailing ≤1 MiB of the log is read, so large logs stay cheap.

---

## Error & failure model

| Situation                        | Behaviour                                  |
| -------------------------------- | ------------------------------------------ |
| Corrupt/missing `admin.json`     | Degrades to seeded defaults, no throw       |
| Unknown id / bad args on writes  | `{ ok: false, error }` (never throws)       |
| Missing `server.log`             | `logs()` → `[]`                             |
| Missing `tasks.json`             | `schedulerHealthy` → `true`                 |
| Inaccessible config dir          | `system().stores` → `[]`                    |

## Exports

```js
import { Admin } from './admin.mjs';   // named
import Admin from './admin.mjs';       // default (same object)
```

Both expose exactly: `tools`, `setToolEnabled`, `addTool`, `removeTool`,
`users`, `setProfile`, `system`, `logs`.
