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

## 2. Bundled integrations (`integrations/<tool>/`)

CLONE FRAME bundles the integrations below today. Each is used at arm's length — via
its files or Google's official download — and is **not linked in-process**.

| Tool | Path | Origin | License | Frame |
|---|---|---|---|---|
| **Framer** (our extension) | `integrations/framer` | pattern per github.com/MartinWie/Framer | MIT | BROWSER |
| **Chrome for Testing** (runtime) | `integrations/runtime` | https://googlechromelabs.github.io/chrome-for-testing/ | Google Chrome for Testing ToS (Chromium: BSD-3-Clause) | app runtime |

The Framer extension is our own code (MIT). Chrome for Testing is downloaded from
Google's official storage at install time and is **not** redistributed in this repo.

> **Note — EXO LAB · Manaflow · TMUX:** these appear as **"coming soon"** in the
> INTEGRATIONS tab and are **not bundled** in this build — no source, no submodule, no
> runtime, and therefore no third-party license obligation here. Their notices return
> when the integrations ship.
