# T-006 — Characterization tests (Wave-1 draft)

Zero-dependency `node:test` files that **pin the CURRENT behavior** of five
mechanics Wave-2 is expected to extract out of the monolith. They characterize
what the app does today — including a few sharp edges and outright gaps —
not what it *should* do. If a Wave-2 refactor changes any of these behaviors
on purpose, update the test alongside the change; if one goes red
unexpectedly, that refactor just broke something real.

All five targets were read from the actual repo before writing a single
assertion:

- `bridge/permissions.mjs`
- `bridge/notes.mjs`
- `bridge/llm.mjs`
- `bridge/hub-bridge.mjs`
- `index.html`
- `bridge/pty.mjs`
- `bridge/ssh.mjs`
- `bridge/web.mjs`

None of these files were modified. Nothing here touches the real
`~/.clone-frame-hub` on the machine running the tests — every test that
persists to disk redirects `HOME` to a throwaway `mkdtemp()` directory first
(see "How HOME redirection works" below), and everything else is either a
pure function or a mocked-`fetch` unit test.

## Running

```bash
cd tests
node --test
```

Requires Node 18+ (global `fetch`); this repo runs Node 26, well past that.
No `npm install` needed — every file imports only `node:*` built-ins plus the
real modules under test by absolute path. Run a single file with
`node --test json-store.test.mjs`.

Current status: **65/65 passing** against the code as of this draft
(2026-07-20).

## Files

### `json-store.test.mjs` — atomic 0600 json-store idiom
Targets **permissions.mjs** and **notes.mjs** — chosen together because they
are two independent implementations of the exact same idiom Wave-2 should
unify into one shared `jsonStore` helper: `mkdirSync(dir, {mode:0o700})` →
write a `*.pid[.ts].tmp` sibling at `mode:0o600` → `renameSync` for an atomic
swap → a missing/corrupt file degrades to defaults/empty, never throws.

Pins:
- dir mode `0o700`, file mode `0o600`, no leftover `.tmp` after a write
- a "simulated restart" (fresh module instance, same HOME) reads back exactly
  what a prior instance persisted
- corrupt JSON on disk degrades gracefully (defaults for permissions, `[]` for
  notes) and the store is still writable afterward
- `permissions.mjs`'s `can()` gating logic, including a real gap: the
  `machineControl` master-switch fast path only excludes the literal action
  names `email`/`ssh`/`matrix` — it does **not** check whether the action is
  even a recognized key, so `can('typo-action')` returns `true` whenever the
  master switch is on. Pinned as-is; tightening this is a legitimate Wave-2
  fix, but it must be a deliberate one.
- `notes.mjs` CRUD round trip + tag normalization (case-insensitive dedupe,
  first-seen casing preserved, empty tags dropped)

### `anthropic-wire.test.mjs` — the non-streaming Anthropic call
Targets **llm.mjs**'s `ask()` — the one BYOK primitive that's directly
`import`-able with no side effects, exercised against a monkey-patched
`global.fetch` (restored after every test; no real network call is ever
made). Pins the endpoint, the three request headers
(`content-type` / `x-api-key` / `anthropic-version: 2023-06-01`), the request
body shape (`model` / `max_tokens` / `messages` / optional `system`, no
`stream` key), the default model/token-limit fallbacks, the "only `type:text`
blocks survive, joined" response parsing, the `!r.ok` error message shape
(`anthropic <status> <=300 chars of body>`), and the no-key failure path
(throws before ever calling `fetch`). Ends with a source-grep tripwire
confirming `hub-bridge.mjs`'s own (separate, streaming) copy of this wire
shape still uses the same endpoint/header literals.

### `sse-stream-parse.test.mjs` — the streaming half, from hub-bridge.mjs
Targets **hub-bridge.mjs**'s `handleChat()` SSE→plain-text parsing loop
(~lines 263-277). `hub-bridge.mjs` cannot be safely `import`ed in a test
process — importing it runs top-level side effects (binds a real TCP socket,
writes a pairing-token file, imports `ws`) — and the loop itself is inlined,
not its own function. So this file transcribes the loop **verbatim** into a
small pure `makeSseParser()` and feeds it synthetic SSE chunks. Pins: only
`data:` lines are inspected, `[DONE]` is swallowed without a `JSON.parse`
attempt, malformed JSON on a line is swallowed (not fatal to the stream),
only `content_block_delta` + `delta.type==='text_delta'` events emit text,
`type:'error'` events emit a `\x00ERR\x00<message>` sentinel (falling back to
`'stream error'` when the event carries no message), and a line split across
two network chunks is buffered and completes correctly. Ends with a
source-grep tripwire against the real literals driving this in
`hub-bridge.mjs` today.

### `html-escape.test.mjs` — the esc / esc2 / escAttr family
Targets three distinct HTML-escaping lambdas grepped out of
**index.html** (a single monolithic `<script>`, not an ES module, so they
cannot be `import`ed — transcribed verbatim instead, one citation per
definition site):

| name | escapes | text-node safe | double-quoted-attr safe | single-quoted-attr safe |
|---|---|---|---|---|
| `esc` (4301) | `& < > " '` | yes | yes | yes |
| `esc2` (4718, redefined identically elsewhere) | `& < >` | yes | no | no |
| `escAttr` (9286) | `& " < >` | yes | yes | **no** |

The three are *not* interchangeable — `escAttr` in particular still lets a
raw `'` through, so it is only safe inside a double-quoted attribute (which is
the only way every current call site in `index.html` uses it). Pinned with a
double-quote-breakout payload against each of the two attribute-safe
escapers, plus an explicit test proving the single-quote gap in `escAttr`.
Ends with a cheap existence check (not exact-text, so it tolerates
reformatting) that all three names are still defined in `index.html`.

### `destructive-guard.test.mjs` — the catastrophic-command guard
Targets `isDestructive()` in **pty.mjs** (~line 106) and its verbatim mirror
`destructive()` in **ssh.mjs** (~line 125) — identical, unexported regex
guards, transcribed here and driven directly, plus a source-grep pin proving
the two copies are still byte-identical today (that duplication is itself
what Wave-2 should collapse into one shared guard). Confirms the documented
blocked patterns (`rm -rf /`, `mkfs`, `dd ... of=/dev/*`, the compact fork
bomb) and several correctly-allowed scoped commands (`rm -rf ./build`,
`rm -rf /home` is *not* a bare `/` segment, etc.) — and pins three real gaps
found while writing this suite, which any tightening pass needs to know
about:
- the flag character class is **case-sensitive**: `rm -Rf /` and `rm -rF /`
  (which `rm` itself treats identically to `-rf`) are **not** caught
- the fork-bomb pattern requires no internal whitespace around the pipe:
  `:(){ : | : & };:` (functionally identical to the classic form) **evades**
  detection, only the compact `:(){ :|:& };:` is caught
- a trailing quote defeats the end-of-token check: `git commit -m "rm -rf /"`
  is **not** caught, because the guard requires whitespace-or-end-of-string
  immediately after the path, and a `"` satisfies neither

### `ssrf-and-auth.test.mjs` — web SSRF guard + bridge auth
**Part 1** targets **web.mjs**'s SSRF guard through its real, exported
`fetchUrl()` — every case is a URL the guard rejects before any network I/O
(literal loopback/private/link-local/CGNAT/cloud-metadata IPv4 and IPv6
addresses, `localhost`/`*.localhost`, non-`http(s)` schemes, unparsable
URLs), so this makes zero real network calls. **Part 2** targets
`hub-bridge.mjs`'s `authed()` (constant-time-ish bearer/query token compare)
and `localOnly()` (anti-DNS-rebinding Host+socket check) — both unexported
closures over module state, so (same reasoning as the SSE file)
transcribed verbatim and driven with plain mock `req` objects. Pins: Bearer
header takes precedence over `?token=`; a length mismatch short-circuits
before any character comparison; a single differing character in an
equal-length token still fails; `localOnly()` requires BOTH the exact
loopback `Host` header AND a loopback socket `remoteAddress` (rejects a
spoofed `Host` from a loopback socket, and a correct `Host` from a
non-loopback socket). Ends with source-grep pins against both real files.

## How HOME redirection works (json-store.test.mjs only)

`permissions.mjs` and `notes.mjs` both compute their on-disk paths from
`os.homedir()` at **module top-level** (`path.join(homedir(), '.clone-frame-hub')`).
`os.homedir()` reads `process.env.HOME` fresh on every call, so setting
`process.env.HOME` to a temp dir *before* a module is first evaluated
redirects it permanently for that module instance. Two things make this
reliable:

1. **Cache-busting the import.** Node's ESM loader caches a module by its
   resolved URL, so re-importing the same path a second time would return the
   *already-evaluated* instance (bound to whatever HOME was set the first
   time). Each test appends a `?instance=N` query string to force a genuinely
   fresh module evaluation.
2. **`await`ing before restoring HOME.** `import()` returns a promise, but the
   actual file read + top-level evaluation happens on a later microtask — a
   naive `try { return fn() } finally { process.env.HOME = prev }` restores
   HOME *before* that evaluation runs, silently falling through to the real
   machine's `~/.clone-frame-hub`. This was caught and fixed while writing
   this suite (see the comment on `withHome()`) — it's exactly the kind of
   bug that's invisible until you check what actually landed on disk.

## Known non-goals of this draft

- No test spins up the real `hub-bridge.mjs` HTTP daemon (it has top-level
  side effects — binds a real TCP port, writes a pairing-token file, does a
  dynamic `import('ws')`). Every hub-bridge.mjs behavior here is instead
  pinned via (a) a verbatim transcription of the specific closure/loop being
  characterized, driven directly, plus (b) a source-grep tripwire against the
  real file so the transcription can't silently drift from reality. If
  Wave-2 gives these functions real exports, these tests are the ones to
  convert to direct imports first.
- `web.mjs`'s "allowed" path (an actual successful fetch of a public URL) is
  intentionally not tested — that would require real network egress, which
  a test suite shouldn't depend on. Only the guard's rejections are pinned,
  which is also the security-critical half.
- `notes.mjs`'s Markdown→snippet stripping (`toSnippet`) isn't pinned here;
  it's cosmetic list-view behavior, not part of the json-store idiom or a
  named ticket item.
