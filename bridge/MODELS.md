# CLONE FRAME · HUB Bridge — Model-Provider Registry & AI Defaults

`models.mjs` is the BYOK registry of AI model providers plus the
per-capability **default map** that powers Settings ("Add Models",
"Added Models", "AI Defaults") and the "Brain".

Two kinds of provider:

- **`local`** — an OpenAI-compatible base URL with **no key** (Ollama,
  llama.cpp, vLLM). Base URLs are prefilled to the usual localhost ports.
- **`api`** — a hosted provider needing a **base URL + apiKey** (OpenAI,
  Anthropic, DeepSeek, OpenRouter, Groq, Gemini, xAI). Base URLs are prefilled.

Zero new dependencies. Node built-ins only; live probes use the global `fetch`
(undici, built into Node). `./llm.mjs` is lazy dynamic-imported inside
`brainStatus()`, so a load-order issue there never breaks importing this module.

## Import

```js
import { Models } from './models.mjs';
// or: import Models from './models.mjs';                       (default export, same object)
// or: import { addProvider, testProvider } from './models.mjs'; (named exports)
```

The HUB Bridge routes to it generically: `POST /mod/models {fn, args}` →
`Models[fn](...args)`. (Requires the `models` entry to be registered in the
bridge's module map; the module itself is drop-in and needs no other change.)

## Persistence & secrets

State persists to `~/.clone-frame-hub/models.json` (directory `chmod 700`, file
`chmod 600`, written tmp-then-rename). A **missing or corrupt** store degrades
to empty — it never throws.

The `apiKey` of an `api` provider is stored **on disk only**. It is **never
logged** and **never returned**: every value handed to a caller carries
`hasApiKey: boolean` in its place. The raw key is read back into memory only by
a module-private `getRecord()`, used solely by `testProvider()` / `listModels()`
to run the live probe.

## Route contract

Write-path methods always return `{ok, ...}` and never throw for expected
failures (they resolve to `{ok:false, error}`). Read-path methods return the
value directly (`[]` / `null` on a miss).

### `listProviders() -> Provider[]`
Sanitized providers, newest `createdAt` first. Never includes `apiKey`.

### `knownProviders() -> KnownProvider[]`
The prefill catalog for the "Add Models" picker:
`{provider, label, kind, baseUrl, keyless, docsUrl}`. `keyless` is `true` for
the `local` providers.

### `getProvider(id: string) -> Provider | null`
Sanitized provider by id, or `null`.

### `addProvider({kind, provider?, label?, baseUrl?, apiKey?}) -> {ok, id?, error?}`
- `kind`: `'local' | 'api'` (required).
- `provider`: known key (`openai`, `anthropic`, `deepseek`, `openrouter`,
  `groq`, `gemini`, `xai`, `ollama`, `llamacpp`, `vllm`) or any string for a
  custom endpoint. Defaults to `'custom'`.
- `baseUrl`: required — but auto-filled from the catalog when `provider` is
  known and `baseUrl` is omitted. Must be a valid URL. Trailing slashes trimmed.
- `label`: display name; defaults to the known label, else the provider name,
  else the host.
- `apiKey`: **required for `kind:'api'`**, ignored for `kind:'local'`.
- New providers start `enabled:true` with an empty `models` cache.

### `updateProvider(id, {label?, baseUrl?, apiKey?, enabled?}) -> {ok, error?}`
Edits a saved provider. Changing `baseUrl` or `apiKey` invalidates the cached
`models`/`lastTestedAt`/`lastError` (the last probe is now stale). Setting
`apiKey` on a `local` provider is rejected.

### `removeProvider(id) -> {ok, error?}`
Deletes the provider and clears any `defaults` entry that referenced it.

### `testProvider(cfgOrId) -> {ok, models?, error?}`
Live-probes the model list. `cfgOrId` is **either**:

- a stored provider `id` (string) — uses its saved key and **persists** the
  result (`lastTestedAt`, `lastError`, and the fetched `models`), or
- a raw config object `{kind, provider?, baseUrl?, apiKey?}` — used by the "Add
  Models" flow to test **before** saving. A missing `baseUrl` is filled from the
  catalog when `provider` is known.

Probe behaviour:

| provider              | request                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| OpenAI-compatible (all api + all local) | `GET {baseUrl}/models` with `Authorization: Bearer <apiKey>` for `api`. If the base carries no `/vN`, `GET {baseUrl}/v1/models` is tried on a `404`. |
| Anthropic (`api.anthropic.com`)         | `GET {baseUrl}/v1/models` with `x-api-key` + `anthropic-version`. If that path is unavailable, a tiny `POST /v1/messages` ping validates the key. |

A `401/403` (bad key), `429`, `5xx`, or a network failure (DNS, refused,
timeout after 10s) resolves to `{ok:false, error}`. Never throws.

### `listModels(id) -> string[]`
Returns the provider's cached `models`; if the cache is empty, runs a
best-effort live probe (and caches the result). Always resolves to an array —
never throws.

### `getDefaults() -> Record<capability, {providerId, model} | null>`
Always includes `chat`, `email_summary`, `email_reply`, `email_tags` (unset →
`null`), plus any custom capability previously set.

### `setDefault(capability, {providerId, model}) -> {ok, error?}`
Sets the default provider+model for a capability. `providerId` must reference an
existing provider. Pass `{providerId:null}` to clear the capability.

### `setEnabled(id, enabled: boolean) -> {ok, error?}`
Toggles a provider on/off without deleting it.

### `brainStatus() -> {available, model}`
Reflects the on-disk Anthropic "Brain" (managed by `llm.mjs`) for the Settings
Brain panel. Never returns the key.

## Provider shape (returned by `listProviders()` / `getProvider()`)

```jsonc
{
  "id": "uuid",
  "kind": "local | api",
  "provider": "openai | anthropic | ... | custom",
  "label": "OpenAI",
  "baseUrl": "https://api.openai.com/v1",
  "enabled": true,
  "hasApiKey": true,        // apiKey is NEVER returned — this stands in for it
  "models": ["gpt-4o", "..."],
  "modelCount": 2,
  "lastTestedAt": 1720000000000,  // epoch ms | null
  "lastError": null,              // string | null
  "createdAt": 1720000000000
}
```

## Prefilled base URLs

| provider     | kind  | baseUrl                                                        |
|--------------|-------|----------------------------------------------------------------|
| `openai`     | api   | `https://api.openai.com/v1`                                    |
| `anthropic`  | api   | `https://api.anthropic.com`                                    |
| `deepseek`   | api   | `https://api.deepseek.com`                                     |
| `openrouter` | api   | `https://openrouter.ai/api/v1`                                 |
| `groq`       | api   | `https://api.groq.com/openai/v1`                               |
| `gemini`     | api   | `https://generativelanguage.googleapis.com/v1beta/openai`     |
| `xai`        | api   | `https://api.x.ai/v1`                                          |
| `ollama`     | local | `http://localhost:11434/v1`                                   |
| `llamacpp`   | local | `http://localhost:8080/v1`                                    |
| `vllm`       | local | `http://localhost:8000/v1`                                    |

## Notes & caveats

- **Anthropic** is the one non-OpenAI wire protocol (auth header + `/v1/models`
  path differ); it is detected by `provider === 'anthropic'` or host
  `api.anthropic.com`, and probed accordingly.
- `setDefault` does **not** verify the `model` string against the provider's
  live list — the cache can be stale and the user may legitimately name a model
  not yet listed. It only verifies the `providerId` exists.
- `enabled` is advisory metadata for the UI; this module does not itself gate
  usage on it — the consuming caller decides.
- Fields treated as secret (persisted on disk only, stripped from every returned
  value, never logged): `apiKey`.
```
