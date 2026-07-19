#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME · HUB — local app launcher
# Starts the local server (if not already up) and opens the HUB as a Google
# Chrome app window. Everything runs on THIS machine. The window auto-pairs.
#
# Branded Google Chrome ONLY. The bundled Chrome-for-Testing runtime was
# removed on purpose: its permanent "for automated testing" banner and
# Google's 403 on sign-in flows (disallowed user agent) made it unusable as
# a daily driver. Chrome's main profile also brings the user's wallet
# extensions and Google session into the app window for free.
#
# Detaches both the server and the browser so they survive a double-click
# launch (launchd reaps the short-lived app process otherwise).
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="${0:A:h}"          # …/clone-frame-hub/bridge
PORT="${HUB_BRIDGE_PORT:-8765}"
URL="http://127.0.0.1:${PORT}"
CONF="$HOME/.clone-frame-hub"
mkdir -p "$CONF"
exec >> "$CONF/launch.log" 2>&1
echo "── launch $(date '+%F %T') ──"

# resolve node (GUI launches have a minimal PATH)
NODE="$(command -v node 2>/dev/null || true)"
[ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
[ -z "$NODE" ] && [ -x /usr/local/bin/node ] && NODE=/usr/local/bin/node
if [ -z "$NODE" ]; then
  osascript -e 'display alert "CLONE FRAME HUB" message "Node.js not found. Install Node and try again."' >/dev/null 2>&1
  exit 1
fi
echo "node: $NODE"

# start the server if not already healthy — orphan it via a subshell so it
# outlives this launcher process (survives double-click / launchd).
if ! /usr/bin/curl -s "${URL}/health" >/dev/null 2>&1; then
  echo "starting server…"
  ( cd "$SCRIPT_DIR" && nohup "$NODE" hub-bridge.mjs > "$CONF/server.log" 2>&1 & )
  for i in $(seq 1 60); do
    /usr/bin/curl -s "${URL}/health" >/dev/null 2>&1 && break
    sleep 0.2
  done
fi
/usr/bin/curl -s "${URL}/health" >/dev/null 2>&1 && echo "server up" || echo "server DID NOT come up"

# ── DEFAULT: the NATIVE Electron shell (REAL in-app browser) ──────────────────
# The daily driver is the Electron shell because the in-app Browser is a REAL top-level
# WebContentsView — full pages, real navigation, no reader/proxy fallback. A Chrome --app
# window can only embed sites in an iframe, so any site that forbids framing (GitHub, most
# apps) degrades to a read-only preview — which is exactly what the owner does NOT want.
# The whole app (terminal, LAB, panels, Gmail-via-OAuth) runs identically here.
# Escape hatch: HUB_SHELL=chrome ./launch.sh  → the app in a Chrome --app window instead.
# CFHUB_DEBUG=<port> adds a local remote-debugging port to Electron (testing only).
APP_DIR="${SCRIPT_DIR:h}/electron"
ELECTRON_APP="$APP_DIR/node_modules/electron/dist/Electron.app"
ELECTRON_CLI="$APP_DIR/node_modules/electron/cli.js"
if [ "${HUB_SHELL:-}" != "chrome" ] && [ -d "$ELECTRON_APP" ]; then
  # `open` makes macOS treat it as a proper (self-responsible) app launch — needed for
  # any WebAuthn/Touch ID prompt inside the view; a nohup spawn makes the terminal the
  # responsible process and macOS silently refuses those prompts.
  echo "launching native Electron shell (self-responsible)"
  /usr/bin/open -na "$ELECTRON_APP" --args "$APP_DIR" ${CFHUB_DEBUG:+--remote-debugging-port=$CFHUB_DEBUG}
  echo "done"
  exit 0
elif [ "${HUB_SHELL:-}" != "chrome" ] && [ -f "$ELECTRON_CLI" ]; then
  # fallback: run cli.js through the resolved node (PATH-independent); no passkeys
  echo "launching native Electron shell (node cli fallback)"
  ( cd "$APP_DIR" && nohup "$NODE" "$ELECTRON_CLI" . >> "$CONF/electron.log" 2>&1 & )
  echo "done"
  exit 0
fi

# ── Fallback: Google Chrome app window ────────────────────────────────────────
if [ -d "/Applications/Google Chrome.app" ]; then
  # HUB_PROFILE=app  (default) → the HUB's own dedicated Chrome profile at
  #                   $CONF/chrome (migrated from the retired CfT profile, so
  #                   the app's Store/sessions carried over). Isolated from the
  #                   user's everyday browsing, and lets us seed profile prefs
  #                   the app needs without ever touching the real profile.
  # HUB_PROFILE=main → the user's real Chrome profile (wallet extensions +
  #                   existing Google session inside the app window).
  PROFILE="${HUB_PROFILE:-app}"
  echo "opening Google Chrome app window (profile: $PROFILE)"
  if [ "$PROFILE" = "main" ]; then
    /usr/bin/open -na "Google Chrome" --args \
      --app="$URL" \
      --no-first-run --no-default-browser-check
  else
    # Allow third-party cookies in the app profile (cookie_controls_mode 0):
    # anti-bot walls (Cloudflare Turnstile) and site logins set their cookies
    # from INSIDE the embedded frame — with 3P cookies blocked those cookies
    # never land and challenges/logins loop forever. Solving once must be
    # enough. Idempotent: only writes when the pref isn't already 0.
    mkdir -p "$CONF/chrome/Default"
    "$NODE" -e 'const f=process.argv[1],fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}j.profile=j.profile||{};if(j.profile.cookie_controls_mode!==0){j.profile.cookie_controls_mode=0;fs.writeFileSync(f,JSON.stringify(j))}' "$CONF/chrome/Default/Preferences" 2>/dev/null || true
    /usr/bin/open -na "Google Chrome" --args \
      --app="$URL" \
      --user-data-dir="$CONF/chrome" \
      --no-first-run --no-default-browser-check
  fi
else
  echo "Google Chrome not found — opening default browser"
  osascript -e 'display alert "CLONE FRAME HUB" message "Google Chrome is not installed. Opening in your default browser — install Chrome for the full app-window experience."' >/dev/null 2>&1 || true
  /usr/bin/open "$URL"
fi
echo "done"
