# Signatures & Writing Style

Local-only module for "sign emails with…", tone rules, and "Extract from
Sent" — learning the user's writing voice from their own Sent folder so the
AI can draft in their voice. Persists to `~/.clone-frame-hub/style.json`
(dir `0700`, file `0600`). Zero npm dependencies.

```js
import { Style } from './style.mjs';
// or: import Style from './style.mjs';                      (default export, same object)
// or: import { signatures, saveSignature, draftPrompt } from './style.mjs';
```

## Privacy

`extractFromSent()` reads the last N Sent messages, sends their plain-text
bodies to Claude **once** to derive a style *summary*, then discards the raw
bodies. Only the derived `StyleProfile` is ever persisted — raw email
content is never written to disk, logged, or included in any return value
after extraction completes.

## Error model

- **Write-path** (`saveSignature`, `removeSignature`, `setToneRules`,
  `extractFromSent`) never throw. They always resolve/return
  `{ok: false, error: string}` on failure.
- **Read-path** (`signatures`, `defaultSignature`, `getToneRules`,
  `getProfile`, `draftPrompt`) return values directly (`[]` / `null` / `''`
  on "nothing found") and never throw.

## Signature shape

```ts
{
  id: string,               // uuid
  accountId: string | null, // null = global (applies to every account)
  name: string,             // e.g. "Work", "Casual"
  text: string,             // plain text signature body
  html: string | null,
  isDefault: boolean,       // at most one default per accountId value
  createdAt: string,        // ISO 8601
}
```

## StyleProfile shape

```ts
{
  accountId: string,
  greeting: string,             // e.g. "Hi {name},"
  closing: string,               // e.g. "Best,"
  formality: 'casual' | 'neutral' | 'formal',
  avgSentenceLen: number,        // approx. words per sentence
  emojiUse: 'none' | 'some' | 'lots',
  punctuation: string,           // free-form note, e.g. "uses em dashes, no Oxford comma"
  commonPhrases: string[],       // up to 20
  sampleTone: string,            // free-form one-line tone description
  extractedFromSent: number,     // how many sent messages this was derived from
  learnedAt: string,             // ISO 8601
}
```

No raw email text is stored on this object — only the fields above.

## API

### `signatures(accountId?) -> Signature[]`
All signatures if `accountId` omitted. If given, returns that account's
signatures **plus** any global (`accountId: null`) ones.

### `saveSignature({id?, accountId?, name, text, html?, isDefault?}) -> {ok, id?, error?}`
Creates (no `id`) or updates (`id` given, must exist) a signature.
`name`/`text` are required non-empty strings. When `isDefault: true`, unsets
`isDefault` on every other signature sharing the same `accountId` value
(global signatures and account signatures are separate default slots).

### `removeSignature(id) -> {ok, error?}`
`{ok: false, error}` if `id` doesn't exist.

### `defaultSignature(accountId) -> Signature | null`
Prefers that account's own default; falls back to the global default; `null`
if neither exists.

### `getToneRules() -> string[]`
Global tone rules (not per-account), e.g.
`["sem pontos de exclamação", "conciso"]`.

### `setToneRules(rules: string[]) -> {ok, error?}`
Replaces the full rule list. Empty/whitespace-only entries are dropped.

### `getProfile(accountId) -> StyleProfile | null`
The last profile learned for that account, or `null` if none yet.

### `extractFromSent(accountId, {n?: number} = {}) -> Promise<{ok, profile?, error?}>`
Lazily imports `./email.mjs`, resolves that account's Sent folder
(`specialUse === '\\Sent'`, else name/path matching `/sent|enviad/i`), pulls
the last `n` (default 15) sent messages' plain text, and asks Claude (via
`ask()` from `./llm.mjs`) for a strict-JSON style summary. The JSON parser
strips code fences and extracts the first balanced `{...}` block, so minor
model formatting drift doesn't break extraction. On success, stores and
returns the `StyleProfile`. On any failure (unknown account, no Sent folder,
no messages, unparsable model output, no `ANTHROPIC_API_KEY`) resolves
`{ok: false, error}` — never throws, never crashes the caller.

### `draftPrompt(accountId) -> string`
Builds a system-prompt fragment combining the account's default signature,
the global tone rules, and the learned `StyleProfile` (if any), for other
modules (e.g. a compose/reply drafter) to prepend to their own system
prompt. Returns `''` if nothing has been saved/learned yet — callers can
safely always prepend the result with no conditional.

## Storage

- File: `~/.clone-frame-hub/style.json`, dir `0700`, file `0600`.
- Shape: `{signatures: Signature[], toneRules: string[], profiles: {[accountId]: StyleProfile}}`.
- A corrupt/missing store is treated as empty rather than thrown.
- Writes are atomic (write to a pid-suffixed temp file, `chmod 0600`, then
  `rename()` over the target) — a crash mid-write can never corrupt the
  store or leave it partially written.
