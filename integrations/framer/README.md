# CLONE FRAME Framer (optional Tier‑2 browser extension)

A tiny MV3 Chrome extension that lets the CLONE FRAME **in‑app browser** embed sites
that would otherwise refuse to be framed (Google, X, YouTube, most SPAs behind
`X-Frame-Options` / CSP `frame-ancestors`).

## What it does

- **`rules.json`** — a `declarativeNetRequest` rule that removes `X-Frame-Options`,
  `Content-Security-Policy`, and `Content-Security-Policy-Report-Only` **only on
  `sub_frame` responses** (i.e. content loaded *inside an iframe*). Top‑level page
  loads are never touched, so your normal browsing keeps its full security headers.
  → lets the in‑app browser embed Google / X / YouTube / anti‑framing SPAs directly.
- **`frame-nav.js`** — a `world: "MAIN"`, `all_frames` content script (the direct‑iframe
  twin of the proxy's injected controller). It runs INSIDE each framed page and
  re‑routes `window.open` / `target="_blank"` / link clicks to the HUB's own tab
  system via the `{__cfhub:1,type:"navigate",…}` protocol — so **links open inside
  CLONE FRAME, never the OS browser, and are never dead**, while same‑frame SPA
  routing keeps working. Guarded by `location.ancestorOrigins` so it only ever acts
  inside HUB frames. This is the piece that makes "click a link" work in direct mode.
- **`marker.js`** — a content script on the HUB origin (`127.0.0.1` / `localhost`) that
  sets `document.documentElement.dataset.cfFramer = '1'`. The HUB reads that flag and
  switches its browser to *direct‑iframe everything*. Without the extension the HUB
  falls back to its Tier‑1 hybrid (direct for frame‑friendly sites, proxy reader for
  the rest) — the app works either way; the extension raises the ceiling.

## How it's loaded

The extension is **not** installed into your normal Chrome. It is loaded *unpacked*,
for the CLONE FRAME window only, via the launcher (`HUB_FRAMER=1`):

```
open -a "Brave Browser" --args \
  --app=http://127.0.0.1:8765 \
  --user-data-dir="$HOME/.clone-frame-hub/chrome" \
  --load-extension="<app>/integrations/framer"
```

**IMPORTANT — branded Google Chrome no longer works for this.** Chrome **137** turned
`--load-extension` into a warning and Chrome **142** removed it (and the
`--disable-features=DisableLoadExtensionCommandLineSwitch` escape) from *branded* Google
Chrome — it now logs `--load-extension is not allowed in Google Chrome, ignoring` and the
extension silently does not load (verified on Chrome 150). Only **Brave · Microsoft Edge ·
Chromium · Chrome for Testing** still load unpacked extensions from the command line, so
the launcher (`bridge/launch.sh`) auto‑selects one of those when `HUB_FRAMER=1`, and warns
if none is installed. The alternative for branded Chrome is a one‑time Web‑Store install.

Notes / caveats:
- `--load-extension` only applies when the browser starts **fresh**, so Framer uses a
  **dedicated isolated profile** (`--user-data-dir`), never your main profile. The wallet
  still works there because CLONE FRAME uses a **Privy embedded wallet** (no MetaMask
  browser extension required — see `login-island/`).
- The browser may show a dismissible "disable developer‑mode extensions" bubble; the
  extension keeps working.

## Security posture

Removing framing headers only *relaxes* how a page may be embedded; it cannot grant
a framed site any access to the HUB. Cross‑origin framed sites run in **their own
origin**, walled off from the HUB's page and its pairing token by the browser's
Same‑Origin Policy. The rule is scoped to `sub_frame` so it never weakens a
top‑level navigation.

Pattern based on the MIT‑licensed "Framer" approach
(github.com/MartinWie/Framer), hardened here to sub‑frame scope + report‑only CSP.
