# Third-Party Notices — CLONE FRAME HUB

CLONE FRAME HUB is open source and bundles / vendors the third-party components below.
Each keeps its own license. Two classes:

1. **npm runtime dependencies** of the bridge daemon (`bridge/package.json`) and
   **vendored browser assets** (`vendor/`) — MIT, listed here in full.
2. **Engine submodules** under `integrations/<tool>/` — added at ship time via
   `git submodule add` (see [Ship-time step](#ship-time-step-git-submodules)). Each
   ships its own upstream `LICENSE`; a per-tool `integrations/<tool>/NOTICE.md` records origin,
   license, and our integration boundary.

---

## 1. npm dependencies (bridge) + vendored assets — all MIT

| Component | Where | Version (spec / installed) | License |
|---|---|---|---|
| **node-pty** | `bridge/package.json` dep | `^1.1.0` (1.1.0) | MIT |
| **ws** | `bridge/package.json` dep | `^8` (8.21.1) | MIT |
| **@xterm/xterm** | `vendor/xterm/xterm.js` + `xterm.css` | 6.0.0 | MIT |
| **@xterm/addon-fit** | `vendor/xterm/addon-fit.js` | 0.11.0 | MIT |

Full license texts: node-pty and ws MIT texts live in
`bridge/node_modules/<pkg>/LICENSE` after `npm install`; the xterm MIT text is checked
in at `vendor/xterm/LICENSE`. The MIT template each follows:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Build/runtime note — node-pty (native module)

`node-pty` is a native addon. On this target (macOS arm64, **Node v26**) it installs
from the **prebuilt N-API binary bundled in the npm tarball**
(`node_modules/node-pty/prebuilds/darwin-arm64/pty.node`) — no `node-gyp` compile and
no Xcode CLT is needed for the binary to load. Fallback for platforms without a
prebuild is `node-gyp rebuild` (needs Xcode Command Line Tools), wired by node-pty's
own `install` script (`node scripts/prebuild.js || node-gyp rebuild`).

**Known packaging quirk (must be handled in the launch/install path):** the bundled
`spawn-helper` extracts **without the execute bit** (`0644`), which makes the first
`pty.spawn(...)` fail with `posix_spawnp failed`. Restore it after install:

```sh
chmod +x bridge/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper
# generic (all platforms):
# find bridge/node_modules/node-pty/prebuilds -name spawn-helper -exec chmod +x {} +
```

---

## 2. Engine submodules (`integrations/<tool>/`)

Engines are vendored as **unmodified git submodules**, never copied source (which would
drop their `LICENSE`). Each is used at arm's length — via its CLI / HTTP server / local
socket — and is **not linked in-process**.

| Tool | Path | Origin | License | Frame |
|---|---|---|---|---|
| **EXO** | `integrations/exo` | https://github.com/exo-explore/exo | Apache-2.0 | LAB |
| **Tmux-Orchestrator** | `integrations/tmux-orchestrator` | https://github.com/Jedward23/Tmux-Orchestrator | MIT (README-only) | HARNESS → ORCHESTRATOR |
| **Manaflow** | `integrations/manaflow` | https://github.com/manaflow-ai/manaflow | MIT | CODE |
| **Framer** (our extension) | `integrations/framer` | pattern per github.com/MartinWie/Framer | MIT | BROWSER |
| **Chrome for Testing** (runtime) | `integrations/runtime` | https://googlechromelabs.github.io/chrome-for-testing/ | Google Chrome for Testing ToS (Chromium: BSD-3-Clause) | app runtime |

Each engine is now **cloned by its `install.sh`** into `integrations/<tool>/src` (not a git
submodule — clone-frame-hub isn't its own repo), keeping the upstream `LICENSE`. The Framer
extension is our own code (MIT); Chrome for Testing is downloaded from Google's official
storage at install time and is **not** redistributed in this repo.

- **EXO (Apache-2.0):** keep the upstream `integrations/exo/LICENSE` **and** `integrations/exo/NOTICE`
  verbatim — Apache-2.0 §4(d) requires propagating the upstream NOTICE. See
  `integrations/exo/NOTICE.md`.
- **Tmux-Orchestrator (MIT):** upstream has no standalone `LICENSE` file; the MIT text
  is reproduced in `integrations/tmux-orchestrator/NOTICE.md` (and below).
- **Manaflow (MIT):** keep the upstream `integrations/manaflow/LICENSE` verbatim. This is the
  MIT `manaflow-ai/manaflow` project — **not** the GPL `manaflow-ai/cmux` terminal.

### Tmux-Orchestrator — reproduced MIT text

```
MIT License

Copyright (c) Tmux-Orchestrator authors
(https://github.com/Jedward23/Tmux-Orchestrator)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Runtime-only dependency: tmux (ISC) — attribution only

Tmux-Orchestrator drives **tmux**, which is **not bundled** — it must already be
installed on the host. tmux is licensed **ISC** (https://github.com/tmux/tmux):

```
Copyright (c) tmux contributors

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## Ship-time step (git submodules)

> **Do NOT run these while `apps/clone-frame-hub` is only a subfolder of the
> enclosing home git repo** — the submodules must be added in the repo that will own
> them (see [Repository-boundary decision](#repository-boundary-decision-for-the-owner)
> first). At authoring time these are documented, not executed, so the enclosing repo
> is not polluted.

Run from the repo root that owns `apps/`:

```sh
git submodule add https://github.com/exo-explore/exo              integrations/exo
git submodule add https://github.com/Jedward23/Tmux-Orchestrator  integrations/tmux-orchestrator
git submodule add https://github.com/manaflow-ai/manaflow         integrations/manaflow
git commit -m "chore: vendor exo / tmux-orchestrator / manaflow as submodules"
```

Update / pin refresh (also the bridge install/update path):

```sh
git submodule update --init --remote integrations/exo
git submodule update --init --remote integrations/tmux-orchestrator
git submodule update --init --remote integrations/manaflow
```

After adding, verify:

```sh
git submodule status   # lists integrations/exo, integrations/tmux-orchestrator, integrations/manaflow
```

Reference commits observed at authoring time (2026-07-14), for sanity only — the
actual pin is whatever the gitlink records:

- exo `b5375f8c` (latest tag `v0.0.10-alpha`)
- Tmux-Orchestrator `71935302`
- Manaflow `23e83e46`

---

## Repository-boundary decision (for the owner)

`apps/clone-frame-hub` currently lives **inside** the user's home git repo. Git
submodules **cannot** be added cleanly here without polluting that enclosing repo.
Two options — **decision required before the ship-time step above**:

- **A (recommended):** promote `apps/clone-frame-hub` to its **own git repository**
  (it is already being sterilized toward a public repo). Submodules then live at that
  repo's root under `apps/` with a clean `.gitmodules`.
- **B:** add the three submodules to the **enclosing** repo. Only viable if that repo
  is intended to track them; otherwise it pollutes an unrelated home-directory repo.

Until this is decided, `integrations/exo/`, `integrations/tmux-orchestrator/`, and `integrations/manaflow/`
hold only their `NOTICE.md` (origin + license + attribution), documenting where each
submodule will live.
