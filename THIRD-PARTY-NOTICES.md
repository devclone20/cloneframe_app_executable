# Third-Party Notices — CLONE FRAME HUB

CLONE FRAME HUB is open source and bundles / vendors the third-party components below.
Each keeps its own license. Two classes:

1. **npm dependencies** — of the bridge daemon (`bridge/package.json`), of the login
   bundle (`login-island/`, built offline into the vendored `privy-login.js`), and
   vendored browser assets (`vendor/`). Listed here in full.

Only components CLONE FRAME actually distributes get a notice here. A tool the app can
optionally drive on the user's own machine — because the user separately installed it —
carries no notice; nothing of it ships in this repo.

---

## 1. npm dependencies + vendored assets

| Component | Where | Version (spec / installed) | License |
|---|---|---|---|
| **node-pty** | `bridge/package.json` dep | `^1.1.0` (1.1.0) | MIT |
| **ws** | `bridge/package.json` dep | `^8` (8.21.1) | MIT |
| **imapflow** | `bridge/package.json` dep | `^1.4.6` (1.4.6) | MIT |
| **mailparser** | `bridge/package.json` dep | `^3.9.14` (3.9.14) | MIT |
| **nodemailer** | `bridge/package.json` dep | `^9.0.3` (9.0.3) | MIT-0 |
| **@xterm/xterm** | `vendor/xterm/xterm.js` + `xterm.css` | 6.0.0 | MIT |
| **@xterm/addon-fit** | `vendor/xterm/addon-fit.js` | 0.11.0 | MIT |
| **react** + **react-dom** | bundled into `privy-login.js` (built by `login-island/`) | 18.3.1 | MIT |
| **@privy-io/react-auth** | bundled into `privy-login.js` (built by `login-island/`) | 3.35.0 | Apache-2.0 |

Full license texts: node-pty, ws, imapflow and mailparser MIT texts live in
`bridge/node_modules/<pkg>/LICENSE` after `npm install` in `bridge/`; the xterm MIT
text is checked in at `vendor/xterm/LICENSE`; react, react-dom and
`@privy-io/react-auth` license texts live in `login-island/node_modules/<pkg>/LICENSE`
after `npm install` in `login-island/` (no upstream `NOTICE` file ships with
`@privy-io/react-auth`, so there is nothing beyond the license text itself to carry
forward). nodemailer ships as **MIT-0** — the MIT terms below, minus the requirement
to reproduce the copyright/permission notice. The MIT template every MIT component
above follows:

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

### Build/provenance note — `privy-login.js` (vendored bundle)

`privy-login.js` at the repo root is a single minified IIFE, built offline by
`login-island/build.mjs` (esbuild) from `react` + `react-dom` +
`@privy-io/react-auth`, and served by the bridge next to `index.html`. `login-island/`
itself — its JSX source and its `node_modules` — is a build-machine-only tool and is
never shipped as source; its **output**, this one bundled file, is what actually ships
with the app, which is why the three packages it is built from are listed above.

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

## 3. iT — CLONE FRAME's own terminal (no third-party code)

**iT** is CLONE FRAME's own terminal multiplexer — workspaces, split panes, tabs, and
a real TTY per tab — implemented entirely in this repo. No terminal-multiplexer source
from any other project is bundled, vendored, or linked into it.

Session persistence is likewise our own: `bridge/keeper.mjs` runs each shell's PTY
inside a small detached daemon, spawned unref'd with its stdio ignored, so a session's
shell keeps running when its client disconnects **and** when the bridge itself
restarts. On reattach the daemon replays the session's scrollback ring before handing
control back to the terminal, so nothing is lost across a reload or a bridge restart.

---

*Full paths verified against `bridge/package.json`, `login-island/package.json`,
`vendor/xterm/`, and the installed `node_modules` on this machine.*
