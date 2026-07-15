# CLONE FRAME — Integrations

Every integration ships **in its own folder here**, bundled with CLONE FRAME. A fresh
download comes with EXO LAB and every integration ready to install into its folder, so
the app runs self‑contained — nothing has to be fetched from elsewhere at runtime by hand.

```
integrations/
├── registry.json           # the list of bundled integrations (load order)
├── install-all.sh          # installs every integration into its own folder
├── runtime/                # Browser Runtime — bundled Chrome for Testing (Chromium)
│   ├── integration.json    #   the browser CLONE FRAME launches in, so Framer loads
│   ├── NOTICE.md           #   (branded Chrome 142+ refuses --load-extension)
│   ├── install.sh          #   downloads Chrome for Testing (~172MB) into this folder
│   └── chrome-mac-arm64/   #   Google Chrome for Testing.app (created by install.sh)
├── exo/                    # EXO LAB — local AI cluster (Apache-2.0)
│   ├── integration.json    #   manifest (name, license, port, bridge module, …)
│   ├── NOTICE.md           #   upstream license/attribution
│   ├── install.sh          #   populates this folder (clone → src/, build → .venv/)
│   ├── src/                #   upstream source (created by install.sh)
│   └── .venv/              #   built runtime (created by install.sh)
├── framer/                 # Framer — bundled Chrome extension (in-app browser embedding)
│   ├── integration.json
│   ├── manifest.json rules.json marker.js frame-nav.js   # the extension itself
│   └── README.md
├── tmux-orchestrator/      # TMUX — agent crews in tmux (MIT)
│   └── integration.json NOTICE.md install.sh
└── manaflow/               # MANAFLOW — agent workflows (MIT)
    └── integration.json NOTICE.md install.sh
```

## How it works

- **One folder per integration.** Each is self‑describing via `integration.json`
  (id, name, license, upstream repo, the bridge module that controls it, port, and its
  `install.sh`). The INTEGRATIONS tab in the app reads these to list and open each one.
- **The bridge is the only thing that runs them.** A folder never talks to the UI
  directly — its lifecycle (install / launch / stop / status) goes through its
  `bridgeModule` (e.g. `bridge/exo.mjs`), which resolves paths inside this folder.
- **"Comes installed."** `install-all.sh` runs each integration's `install.sh`, which
  clones the pinned upstream into `src/` and builds the runtime (`.venv/`, `node_modules/`)
  **inside that integration's folder**. Run it once after download, or as a release‑build
  step so the shipped bundle is already populated. Built artefacts are git‑ignored (they're
  large and reproducible); the upstream source keeps its own LICENSE (see `NOTICE.md` and
  the top‑level `THIRD-PARTY-NOTICES.md`).
- **Framer is special.** It's a Chrome extension (not a server), loaded into the CLONE
  FRAME window at launch (`HUB_FRAMER=1`) rather than run by the bridge. It makes the
  in‑app browser embed any site and keeps links inside the app.

## Install everything

```sh
zsh integrations/install-all.sh
```

Or install one:

```sh
zsh integrations/exo/install.sh
```
