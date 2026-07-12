# Deep Research (`research.mjs`)

Single-file, zero-dependency Deep Research engine that runs **inside** the hub
bridge Node process. Node built-ins only. `./llm.mjs`'s `ask()` is a static
import but is only ever *called* inside `run()`, never at module load — so a
missing API key can never break importing this module or its siblings.

Given a question, `run()` performs a **multi-step research pass** and synthesizes
a cited markdown report. There is no web-search key on this machine, so it works
in two modes:

- **`sources`** — the caller supplies `{title,url,text}[]`. Pipeline: decompose →
  extract evidence from the sources → synthesize a report that cites every
  non-trivial claim by source number `[1][2]`. The **Sources** list is appended
  **deterministically** from the cleaned input (never model-authored), so URLs
  are exact and never hallucinated.
- **`reason`** — no sources. Pipeline: decompose → structured analysis. The
  report always ends with an explicit **"What I could verify vs. what needs a
  source"** section so the reader knows what to confirm against a primary source.

If `mode` is omitted it is inferred: `sources` when at least one usable source is
passed, otherwise `reason`. An unknown `mode` value is treated as omitted.

## Wiring into `hub-bridge.mjs`

Routed through the generic module RPC (`POST /mod/research {fn, args}`). Register
the module in the bridge's `MODULES`/`MODEXPORT` maps:

```js
const MODULES   = { …, research: './research.mjs' };
const MODEXPORT = { …, research: 'Research' };
```

The server calls `Research[fn](...args)`, so every method takes plain JSON args
and returns JSON-serializable values. No `init()` needed — the store is loaded
lazily on each call.

## Storage (`~/.clone-frame-hub/research.json`, dir `0700`, file `0600`)

```jsonc
{
  "version": 1,
  "reports": [
    {
      "id": "uuid",
      "question": "…",
      "mode": "sources" | "reason",
      "model": "claude-…" | null,
      "sourceCount": 3,
      "markdown": "# …",        // the full assembled report
      "createdAt": "ISO"
    }
  ]
}
```

Atomic write (tmp → `rename`), file `0600`, dir `0700`. A **missing or corrupt**
store degrades to empty and never throws. The store is a ring buffer capped at
**100** reports (oldest dropped first).

**Privacy:** raw source bodies are used to synthesize the report and then
**discarded** — only the derived markdown (which contains the deterministic
title+URL Sources list, not full source text) is persisted. Nothing is logged;
no secret-shaped field is ever stored or returned.

## API

`Research` object (and matching named exports):

| Function | Args | Returns |
|---|---|---|
| `run(input)` | `{question:string, sources?:{title,url,text}[], mode?:'sources'\|'reason', model?:string}` | `Promise<{ok:true, reportId, markdown} \| {ok:false, error}>` |
| `list()` | — | `{id, question, createdAt}[]` (newest first) |
| `get(id)` | `id:string` | `{id, question, markdown, createdAt, mode, model, sourceCount} \| null` |
| `remove(id)` | `id:string` | `{ok:true} \| {ok:false, error}` |

### `run(input)`

- Validates `question` (required, non-empty; trimmed and capped at 4 000 chars).
- Cleans `sources`: coerces `title`/`url`/`text` to strings, strips control
  chars, caps at **20 sources**, **8 000 chars/source**, **80 000 chars total**.
  A source with neither title nor text is dropped.
- `mode:'sources'` with zero usable sources → `{ok:false, error}` (never throws).
- `model` (optional) overrides the Claude model for this run; otherwise the
  bridge default (`llm.mjs` `DEFAULT_MODEL`) is used.
- On success persists the report and returns `{ok:true, reportId, markdown}`. If
  persistence fails, the caller still receives the markdown (best-effort store).
- Never throws for expected failures (bad input, no API key, network error) —
  always returns `{ok:false, error}`.

### Report shape (assembled markdown)

```
# <question>

> Deep Research · <mode> mode · <n source(s) | no external sources> · <ISO>

<model-authored body, cited [1][2] in sources mode>

## Sources                 (sources mode only — deterministic, not model-authored)
1. [Title](<https://…>)
```

## Security & safety

- Output is **markdown**; untrusted source `text`/`title`/`url` is never emitted
  as raw HTML. Source titles are stripped of `[` `]` for link-text safety.
- Only `http(s):`, `mailto:`, `ftp:` URLs are linkified; other schemes (e.g.
  `javascript:`) are rendered as inert inline code, blocking link injection if
  the host renders the markdown to HTML.
- No secrets are read, written, returned, or logged by this module.

## Failure semantics

- `list()` / `get()` on a missing/corrupt store → `[]` / `null`.
- `get(unknownId)` → `null`. `remove(unknownId)` → `{ok:false, error:'not found'}`.
- `run()` wraps the whole pass in try/catch; the final synthesis call is the
  gate: if the brain is unavailable it surfaces as `{ok:false, error}`.

MIT.
