# CLONE FRAME · HUB Bridge — Image Gallery

`gallery.mjs` powers the sidebar **Gallery**: a local store of generated /
imported images. Zero npm dependencies — Node built-ins only (`fs`, `path`,
`os`, `crypto`). No image is ever decoded or rendered in this module; bytes are
written to disk and handed back as data URIs, so the UI's `<img>` tag is the
only consumer.

## Storage layout

| Path | Mode | Contents |
| --- | --- | --- |
| `~/.clone-frame-hub/` | dir `0700` | HUB config root |
| `~/.clone-frame-hub/gallery.json` | file `0600` | **light index** — metadata only, never bytes |
| `~/.clone-frame-hub/gallery/` | dir `0700` | one blob file per image |
| `~/.clone-frame-hub/gallery/<uuid>.<ext>` | file `0600` | raw image bytes |

Keeping the bytes out of the JSON index makes `list()` cheap regardless of how
large the images are. All writes are tmp-write-then-`rename` (atomic) and set
`0600`. A missing **or corrupt** `gallery.json` degrades to an empty gallery —
it never throws and never overwrites the file on read.

## Import

```js
import { Gallery } from './gallery.mjs';
// or: import Gallery from './gallery.mjs';                 (default export, same object)
// or: import { list, get, add, remove, generate } from './gallery.mjs';
```

`Gallery` is a plain object of the functions below. The HUB bridge routes RPC as
`Gallery.<fn>(...args)`, so each method is directly callable with plain JSON args
and returns JSON-serializable values.

## Error model

Write-path methods (`add`, `remove`, `generate`) **never throw** for expected
failures — they return `{ok:false, error:string}`. Read-path methods (`list`,
`get`, `count`) return values directly; `get` returns `null` for an unknown id
or a missing blob. No method logs or returns secrets (there are none in image
metadata).

## Route contract

```
list() -> Item[]
  Item = {id, prompt, filename, mimeType, byteSize, tags, source, createdAt}
  Newest first. Metadata only — NEVER image bytes.

get(id) -> {id, prompt, dataUri, mimeType, filename, byteSize, tags, createdAt} | null
  Reads the blob and returns it as `data:<mimeType>;base64,<...>`.
  Unknown id or missing blob -> null (no throw).

add({prompt?, mimeType, contentBase64, tags?}) -> {ok, id?, error?}
  Imports an image.
  - contentBase64: raw base64 OR a full `data:<mime>;base64,<payload>` URI.
    base64url is normalised to standard base64; whitespace is stripped.
  - mimeType: declared type (see whitelist). Optional if the bytes/URI carry it.
  - prompt: optional caption/prompt (trimmed, capped at 2000 chars).
  - tags: optional string[] (trimmed, deduped, max 32 tags × 64 chars).

remove(id) -> {ok, error?}
  Deletes the index entry and the blob file. Unknown id -> {ok:false,'not found'}.
  A blob that is already gone still clears the index entry.

generate({prompt}) -> {ok:false, error:'no image provider configured'}
  No external image API is configured on this machine, so generation degrades
  gracefully. Import (`add`) is the supported path for putting images in.

count() -> number
  Total images in the gallery.
```

## MIME whitelist & self-healing

Only image types are accepted; each maps to a fixed file extension:

| MIME | ext | MIME | ext |
| --- | --- | --- | --- |
| `image/png` | png | `image/bmp` | bmp |
| `image/jpeg` | jpg | `image/svg+xml` | svg |
| `image/gif` | gif | `image/x-icon` | ico |
| `image/webp` | webp | `image/tiff` | tiff |
| `image/avif` | avif | `image/heic` | heic |
| | | `image/heif` | heif |

On `add`, the stored `mimeType` is resolved from the **real bytes first** (magic-
byte sniffing of PNG/JPEG/GIF/WebP/BMP/ICO/TIFF/AVIF/HEIC/HEIF, plus SVG text
detection), then the caller's declared `mimeType`, then the type embedded in a
`data:` URI. This self-heals a mislabeled import so the data URI returned by
`get()` always renders. Anything that resolves to a non-image type is rejected.

## Safety notes

- **No path traversal.** Blob filenames are always `${uuid}.${ext}` generated in
  this module — never derived from caller input. `get`/`remove` additionally
  validate the stored filename against `^[A-Za-z0-9][A-Za-z0-9._-]*$` and confirm
  the resolved path stays inside `~/.clone-frame-hub/gallery/`, so a hand-tampered
  index cannot escape the blob directory.
- **Size bound.** Decoded images over 32 MiB are rejected, so a single import
  cannot exhaust the disk.
- **Atomic + orphan-safe.** The blob is written before the index; if the index
  write fails, the orphan blob is unlinked so the store never drifts.
- **No auto-pruning.** Images are user assets, so the gallery never silently
  drops old entries; the store grows until the user removes items.

## Self-test

Run directly (no test framework, no deps):

```
node --check gallery.mjs
```

A one-off self-test (assert every documented method exists; `add` a 1×1 PNG and
assert `{ok:true,id}`; `list` shows it with no bytes; `get` returns a
`data:image/png;base64,` URI; verify `gallery.json` is `0600`, the `gallery/`
dir is `0700`, and the blob is `0600`; `remove` clears both entry and blob;
`generate` returns the exact graceful error; malformed input and a corrupt index
both degrade without throwing) was run during development and is not shipped as
part of the module (no test-framework dependency was added, per the zero-deps
constraint).
