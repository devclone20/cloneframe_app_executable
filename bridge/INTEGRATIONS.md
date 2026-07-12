# CLONE FRAME · HUB Bridge — Integrations Registry

`integrations.mjs` is "all external service connections in one place." It
aggregates the user's connectors — email accounts (reflected read-only from
`email.mjs`), MCP tool servers, API services, and CalDAV/CardDAV endpoints —
with a status and a live `test()` per integration.

Zero new dependencies. Node built-ins only; live handshakes use the global
`fetch` (undici, built into Node). `email.mjs` is lazy dynamic-imported inside
`list()`/`get()` so this module never pulls in `imapflow`/`nodemailer` just to
render a list, and a load-order issue in `email.mjs` never breaks importing
this one.

## Import

```js
import { Integrations } from './integrations.mjs';
// or: import Integrations from './integrations.mjs';                 (default export, same object)
// or: import { list, add, test, remove } from './integrations.mjs';  (named exports)
```

## Persistence & secrets

Non-email integrations persist to `~/.clone-frame-hub/integrations.json`
(directory `chmod 700`, file `chmod 600`). The full `config` — secrets
included — is stored on disk. Every value handed back to a caller (`list()`,
`get()`, `add()`, `update()`) is a **sanitized** `Integration`: a `meta`
summary replaces `config`, and `password`, `apiKey`, `token`, `pass`,
`secret`, and `authHeader.value` are never returned or logged. The only place
the raw config is read back into memory is a module-private
`getConfigRecord()`, used exclusively inside `test()` to perform the live
handshake.

Email accounts are **not** stored here — they live in `accounts.json`,
owned by `email.mjs`. `integrations.mjs` only reflects them (read-only) by
calling `Email.listAccounts()`.

## Route contract

All functions are `async` and never throw for expected failure modes — they
resolve to an `{ok, error?}`-shaped result (or `null` for `get()` misses).

### `list() -> Promise<Integration[]>`
Returns custom integrations (newest `createdAt` first), followed by the
email-account group (contiguous, reflected from `email.mjs`). If `email.mjs`
can't be imported or has zero accounts, the email group is simply empty —
never an error.

### `get(id: string) -> Promise<Integration | null>`
`id` may be a stored integration id or an `email:<accountId>` id.

### `add({type, name, config}) -> Promise<{ok, id?, error?}>`
- `type`: one of `'mcp' | 'api' | 'caldav' | 'carddav' | 'contacts_import'`
  (`'email'` is not addable here — manage email accounts via `email.mjs`).
- `name`: non-empty string.
- `config`: shape depends on `type` — see below. Validated before storing;
  invalid shape → `{ok:false, error}`, nothing persisted.
- Sets `status: 'pending'`. First integration of a given `type` is
  automatically `isDefault: true`.

### `update(id: string, patch: {name?, config?, status?}) -> Promise<{ok, error?}>`
- `patch.config` is **shallow-merged** into the existing config, then
  re-validated for the integration's type.
- Changing `config` resets `status` to `'pending'` and clears `lastError`
  (the previous `test()` result is now stale).
- Rejects `email:*` ids (`{ok:false, error}` — read-only).

### `remove(id: string) -> Promise<{ok, error?}>`
- Rejects `email:*` ids (`{ok:false, error}` — manage via `email.mjs`).
- If the removed integration was the default for its `type`, promotes the
  next remaining integration of that type to default.

### `test(id: string) -> Promise<{ok, status, error?}>`
Performs a live handshake by type and **persists** the result
(`status`, `lastError`, `lastCheckedAt`) before returning. Never throws.

| type              | handshake                                                                                      | reachable-but-unauthenticated |
|-------------------|-------------------------------------------------------------------------------------------------|--------------------------------|
| `api`             | `fetch(config.baseUrl, {method: config.method ?? 'GET'})`                                       | any HTTP response (incl. 401/403/404) → `ok:true, status:'connected'` |
| `mcp` (`http`/`ws`) | JSON-RPC `initialize` `POST` to `config.url` (`ws`/`wss` rewritten to `http`/`https` first — `fetch` can't open a WebSocket handshake) | any HTTP response → `ok:true, status:'connected'` |
| `mcp` (`stdio`)   | resolves `config.command` on `PATH` (or as an absolute/relative path); **never spawns**          | found → `ok:true, status:'configured'` (liveness of the process itself is not verified) |
| `caldav`/`carddav`| `PROPFIND` (`Depth: 0`, Basic auth if `username`/`password` set) against `config.url`            | any HTTP response (incl. 207/200/401) → `ok:true, status:'connected'` |
| `contacts_import` | if `config.path` set, checks the path exists on disk; otherwise a no-op                          | `ok:true, status:'configured'` |

Only a network-level failure (DNS, connection refused, timeout after 8s)
resolves to `{ok:false, status:'error', error}`.

### `setDefault(id: string) -> Promise<{ok, error?}>`
Default is scoped **within `type`** — setting a default `mcp` integration
does not affect the default `api` integration. Rejects `email:*` ids
(email defaults are managed via `email.mjs`).

## Integration shape (returned by `list()`/`get()`/internally by `add()`)

```jsonc
{
  "id": "uuid | email:<accountId>",
  "type": "email | mcp | api | caldav | carddav | contacts_import",
  "name": "string",
  "status": "connected | pending | error | configured | disabled",
  "isDefault": false,
  "readOnly": false,          // true only for type:"email"
  "meta": { /* type-specific, secret-free — see below */ },
  "lastError": null,          // string | null
  "lastCheckedAt": null,      // epoch ms | null — set by test()
  "createdAt": 1720000000000  // epoch ms | null (email entries: null, owned by email.mjs)
}
```

`meta` per type:

| type              | meta fields                                                       |
|-------------------|--------------------------------------------------------------------|
| `email`           | `{ email, display }`                                               |
| `api`             | `{ baseUrl, host, method, hasAuth }`                                |
| `mcp`             | `{ transport, url, command, host, hasAuth }` (`url`/`host` null for `stdio`; `command` null otherwise) |
| `caldav`/`carddav`| `{ url, host, username, hasAuth }`                                  |
| `contacts_import` | `{ source, path, hasAuth: false }`                                  |

## Config field expectations (per type, passed to `add()`/`update()`)

```jsonc
// type: "mcp"
{
  "transport": "http",        // required: "http" | "ws" | "stdio"
  "url": "https://mcp.example.com/rpc",  // required for "http"/"ws"
  "command": "my-mcp-server", // required for "stdio" (binary name on PATH, or absolute/relative path)
  "args": ["--flag"],         // optional, informational only (not used by test())
  "token": "•••"              // optional, secret — sent as `Authorization: Bearer` on http/ws test()
}

// type: "api"
{
  "baseUrl": "https://api.example.com/v1",  // required, must be a valid URL
  "method": "GET",            // optional, "GET" | "HEAD", default "GET"
  "apiKey": "•••",            // optional, secret — sent as `Authorization: Bearer <apiKey>` if authHeader absent
  "authHeader": { "name": "X-Api-Key", "value": "•••" }  // optional, secret; takes precedence over apiKey
}

// type: "caldav" | "carddav"
{
  "url": "https://caldav.example.com/dav/principal/",  // required, must be a valid URL
  "username": "user",         // optional
  "password": "•••"           // optional, secret — sent as HTTP Basic auth alongside username
}

// type: "contacts_import"
{
  "source": "vcard-file",     // optional, free-form label, default "file"
  "path": "/absolute/path/to/contacts.vcf"  // optional — if set, test() checks it exists
}
```

Fields treated as secrets everywhere (stripped from every returned value,
persisted only on disk): `password`, `apiKey`, `token`, `pass`, `secret`,
`authHeader.value`.
