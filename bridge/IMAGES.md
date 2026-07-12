# CLONE FRAME · HUB Bridge — Image Generation (BYOK)

`images.mjs` generates images from a text prompt via a provider API key the
**user supplies** (Bring Your Own Key), then saves the result into the
existing **Gallery** (`gallery.mjs`). Zero npm dependencies — Node built-ins
only (`fs`, `path`, `os`) plus the global `fetch` (undici, built into Node).
`gallery.mjs` is lazy dynamic-imported inside `generate()` only, so importing
this module for `config()`/`status()`/`providers()` never pulls in Gallery's
blob-storage machinery.

No image API is ever called unless `config()` has been run first — there is
no default key, no bundled key, and no fallback to a paid call.

## Storage layout

| Path | Mode | Contents |
| --- | --- | --- |
| `~/.clone-frame-hub/` | dir `0700` | HUB config root (shared with other bridge modules) |
| `~/.clone-frame-hub/images.json` | file `0600` | `{provider, apiKey, model}` — the BYOK config |

The write is tmp-write-then-`rename` (atomic) and sets `0600`. A missing **or
corrupt** `images.json` degrades to "unconfigured" — it never throws.

## Import

```js
import { Images } from './images.mjs';
// or: import Images from './images.mjs';                                  (default export, same object)
// or: import { config, status, providers, generate, removeConfig } from './images.mjs';
```

`Images` is a plain object of the functions below. The HUB bridge routes RPC as
`Images.<fn>(...args)`, so each method is directly callable with plain JSON
args and returns JSON-serializable values.

## Error model

Every method returns a plain object and **never throws**. Write-path and
network-path methods (`config`, `generate`) return `{ok:boolean, error?:string}`
on failure. `generate()` additionally enforces a **60s timeout** and a
**prompt/size cap**, so a hung provider or an unbounded request can never
block the caller indefinitely. `status()`/`providers()` return values
directly (no `ok` wrapper — they cannot fail).

## Route contract

```
config({provider, apiKey, model?}) -> {ok, error?}
  Persists BYOK config. provider: 'openai' | 'stability'. apiKey is required
  and is never echoed back. model defaults to the provider's catalog default
  when omitted.

status() -> {configured:boolean, provider?:string, model?:string}
  Never includes the key.

providers() -> [{id, label, models:string[]}]
  Static catalog (no network call).

generate({prompt, size?}) -> Promise<{ok, id?, dataUri?, error?}>
  - prompt: required, trimmed, capped at 4000 chars.
  - size: optional "WIDTHxHEIGHT" (e.g. "1024x1024"), 64-2048px per side, or
    "auto" (OpenAI gpt-image-1 only). Defaults to "1024x1024".
  - Calls the configured provider, decodes the returned base64 image, saves
    it to the Gallery via a lazy `import('./gallery.mjs')` (Gallery.add),
    and returns a `data:image/png;base64,...` URI for immediate display.
  - {ok:false, error:'no image provider configured'} if config() was never
    run — no network call is made in this case.
  - If the provider call succeeds but the Gallery save fails, returns
    {ok:false, dataUri, error} so the caller can still display the image
    even though it wasn't persisted.

removeConfig() -> {ok:true}
  Deletes the persisted config. Idempotent — succeeds even if unset.
```

## Providers

| id | label | example models | default model |
| --- | --- | --- | --- |
| `openai` | OpenAI Images | `gpt-image-1`, `dall-e-3`, `dall-e-2` | `gpt-image-1` |
| `stability` | Stability AI | `stable-diffusion-xl-1024-v1-0`, `stable-diffusion-v1-6` | `stable-diffusion-xl-1024-v1-0` |

`config()` accepts any non-empty `model` string, not just the ones listed
above — the catalog is a UI hint, not a hardcoded allowlist, so a new vendor
model name never requires a code change.

- **OpenAI** — `POST https://api.openai.com/v1/images/generations`,
  `Authorization: Bearer <key>`. `response_format: 'b64_json'` is only sent
  for `dall-e-*` models (`gpt-image-1` always returns `b64_json` and rejects
  the param). Response image: `data[0].b64_json`.
- **Stability AI** — `POST https://api.stability.ai/v1/generation/<model>/text-to-image`,
  `Authorization: Bearer <key>`, body `{text_prompts:[{text}], width, height, samples:1}`.
  `size` is parsed into `width`/`height`. Response image: `artifacts[0].base64`.

Both providers return PNG bytes; `generate()` stores them in the Gallery as
`image/png` and tags the entry `['generated', <provider>]`.

## Safety notes

- **No key leakage.** The key is read from disk only inside `generate()`'s
  provider call. It is never included in `status()`, never echoed by
  `config()`, and provider error strings are truncated (300 chars) so a
  verbose upstream error body can't balloon the response — the key is never
  part of the request URL or body echoed by any provider, so truncation alone
  is sufficient here.
- **Bounded requests.** Prompt capped at 4000 chars; size capped at 64-2048px
  per side; a 60s `AbortController` timeout wraps every provider call.
- **Never throws.** Malformed input, network failures, timeouts, non-JSON
  responses, and a missing/corrupt config file all degrade to
  `{ok:false, error}` rather than throwing or crashing the caller.
- **No silent paid calls.** `generate()` only reaches the network after an
  explicit `config()` — there is no default provider or bundled key.

## Self-test

Run directly (no test framework, no deps):

```
node --check images.mjs
```

A one-off self-test (run under an isolated `$HOME` so it never touches the
real `~/.clone-frame-hub`) was run during development and is not shipped as
part of the module (no test-framework dependency was added, per the
zero-deps constraint). It verified: `status()` starts `{configured:false}`;
`providers()` returns the two-provider catalog; `generate()` with no config
returns `{ok:false, error:'no image provider configured'}` **without any
network call**; `config()` persists and returns `{ok:true}`; the store file
is `0600` and `~/.clone-frame-hub` is `0700`; `status()` reflects the saved
provider/model and never contains the key; invalid `config()` inputs
(`unknown provider`, empty `apiKey`, missing fields) are rejected; `generate()`
input validation (missing prompt, malformed size, out-of-bounds size) rejects
before any network call; `removeConfig()` deletes the file and is idempotent
when called again; the default export equals the named `Images` object.
