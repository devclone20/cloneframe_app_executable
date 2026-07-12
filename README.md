# CLONE FRAME · HUB

**A visual interface between you and your machine — a Unix with a face.**

CLONE FRAME HUB is a local, double-click desktop app: one `index.html` and one
zero-trust local daemon (the **HUB Bridge**). It turns your machine into an
AI-agent workstation — real terminal, your own LLM (bring your own key or run a
local model), an in-app browser, e-mail, wallet & iNFT agents, harnesses
(crews of agents with safety gates), automations, and a folder system that
lives transparently on your disk.

There is **no embedded assistant**. You connect *your* model — an API key that
never leaves your machine, or a local model served from your own hardware.

---

## Quick start

```bash
git clone https://github.com/devclone20/cloneframe_app_executable.git
cd cloneframe_app_executable/bridge
npm install          # three e-mail deps; everything else is Node built-ins
./launch.sh          # starts the bridge on 127.0.0.1 and opens the app window
```

Or build the double-click macOS app:

```bash
cd bridge && ./make-app.sh   # produces "CLONE FRAME HUB.app"
```

Requirements: Node ≥ 18, macOS (Chrome/Brave/Edge for the app window).

## What's inside

| Piece | What it is |
|---|---|
| `index.html` | The entire app UI — a single file: frame grid, CODE (chat · terminal · project diff · browser), LAB (local models, cluster, iNFT agents), Email, Harness, Automations, Settings, and more |
| `bridge/hub-bridge.mjs` | The local daemon: real shell, file access, e-mail engine, web proxy — bound to `127.0.0.1` only, paired with the window by token |
| `bridge/*.mjs` | One module per capability (models, folders, servers, nft, web, proxy, …) — each documented by its sibling `.md` |
| `bridge/launch.sh` / `make-app.sh` | Launcher and `.app` bundler |

## Security model (short version)

- The bridge listens on **127.0.0.1 only**, behind a pairing token.
- **All permissions default OFF** — shell, file-write, web, e-mail autonomy are
  opt-in switches in Settings.
- API keys live in your session/`~/.env.local`; they are never written into the
  app, logs, or this repository.
- Catastrophic commands (`rm -rf /`, `mkfs`, `dd` to disk) are blocked even in
  root mode.
- The in-app browser renders pages in an **opaque-origin sandbox** through an
  SSRF-guarded proxy — page JavaScript can never reach your token or the bridge.

Read [SECURITY.md](SECURITY.md) for the full model and how to report issues.

## Folder system

On first run the app creates `~/CloneFrame/` — Models, Agents, Data, Cache,
Harnesses, Servers, Downloads, Logs — plain folders you can open in Finder and
that every part of the app reads from and writes to. Your data stays yours, on
your disk, in files you can see.

## License

[MIT](LICENSE)
