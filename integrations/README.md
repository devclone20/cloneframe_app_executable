# CLONE FRAME — Integrations

Every integration ships **in its own folder here**, bundled with CLONE FRAME. A fresh
download comes with each bundled integration ready to install into its folder, so the
app runs self‑contained — nothing has to be fetched from elsewhere at runtime by hand.

```
integrations/
├── registry.json           # the list of bundled integrations (load order)
├── install-all.sh          # installs every integration into its own folder
└── framer/                 # Framer — bundled Chrome extension (in-app browser embedding)
    ├── integration.json
    ├── manifest.json rules.json marker.js frame-nav.js   # the extension itself
    └── README.md
```

> **Direction change — no more bundled third-party apps.** Capabilities we want from
> other tools are now built **from scratch as our own engines**, mapping the design and
> the open-source code instead of shipping the upstream app: tmux's capabilities became
> the **iT** terminal engine, and exo's became the **MATRIX** cluster surface — own code,
> own command paths, no upstream folder, no bridge wrapper. The old Browser Runtime
> (Chrome for Testing) was retired in v0.49 — the app launches branded Google Chrome.

## How it works

- **One folder per integration.** Each is self‑describing via `integration.json`
  (id, name, license, upstream repo, the bridge module that controls it, port, and its
  `install.sh`). The INTEGRATIONS tab in the app reads these to list and open each one.
- **The bridge is the only thing that runs them.** A folder never talks to the UI
  directly — its lifecycle (install / launch / stop / status) goes through its
  `bridgeModule`, which resolves paths inside this folder.
- **"Comes installed."** `install-all.sh` runs each integration's `install.sh`, which
  populates the folder and builds any runtime **inside that integration's folder**. Run
  it once after download, or as a release‑build step so the shipped bundle is already
  populated. Built artefacts are git‑ignored (they're large and reproducible); any
  upstream source keeps its own LICENSE (see `NOTICE.md` and the top‑level
  `THIRD-PARTY-NOTICES.md`).
- **Framer is special.** It's a Chrome extension (not a server), loaded into the CLONE
  FRAME window at launch (`HUB_FRAMER=1`) rather than run by the bridge. It makes the
  in‑app browser embed any site and keeps links inside the app.

## Install everything

```sh
zsh integrations/install-all.sh
```

Or install one:

```sh
zsh integrations/runtime/install.sh
```
