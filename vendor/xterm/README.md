# vendor/xterm — local xterm.js (no CDN)

Vendored terminal renderer for the HUB interactive terminal (LAB / ORCHESTRATOR
frames). Served as **local files** — no runtime CDN, to satisfy CSP and offline
use. All MIT-licensed.

## Files

| File            | Source (npm)                | Exposes global     |
|-----------------|-----------------------------|--------------------|
| `xterm.js`      | `@xterm/xterm@6.0.0` → `lib/xterm.js` (UMD) | `window.Terminal` |
| `xterm.css`     | `@xterm/xterm@6.0.0` → `css/xterm.css`      | — (stylesheet)     |
| `addon-fit.js`  | `@xterm/addon-fit@0.11.0` → `lib/addon-fit.js` (UMD) | `window.FitAddon` |
| `LICENSE`       | MIT text of both packages   | —                  |

## Wiring into index.html (for the integrator)

```html
<link rel="stylesheet" href="vendor/xterm/xterm.css" />
<script src="vendor/xterm/xterm.js"></script>
<script src="vendor/xterm/addon-fit.js"></script>
```

Load order: `xterm.js` before `addon-fit.js`. After both load, `Terminal` and
`FitAddon` are globals — no bundler needed.

```js
const term = new Terminal({ /* theme built from CSS vars */ });
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(el);
fit.fit();
```

## Re-vendoring (bump versions)

```sh
cd $(mktemp -d)
npm pack @xterm/xterm @xterm/addon-fit
tar -xzf xterm-xterm-*.tgz -C x_core --strip-components=1   # mkdir x_core first
tar -xzf xterm-addon-fit-*.tgz -C x_fit --strip-components=1
# copy x_core/lib/xterm.js, x_core/css/xterm.css, x_fit/lib/addon-fit.js here
# and refresh LICENSE from x_core/LICENSE + x_fit/LICENSE
```

Do not edit these files in place — they are third-party build artifacts.
