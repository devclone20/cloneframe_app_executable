#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME · HUB — local app launcher
# Starts the local server (if not already up) and opens the HUB in a Chrome
# app window. Everything runs on THIS machine. The window auto-pairs.
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

# ── Preferred: the BUNDLED Chromium runtime (Chrome for Testing) ──────────────
# CLONE FRAME launches in its own bundled browser so the Framer extension loads
# (branded Google Chrome 142+ refuses --load-extension). Self-contained: install
# once with integrations/runtime/install.sh. If it isn't there yet, fall back to a
# system browser (the Tier-1 in-app browser still works; Framer needs this runtime
# or Brave/Edge/Chromium).
CFT_ARCH="mac-arm64"; [ "$(uname -m)" = "x86_64" ] && CFT_ARCH="mac-x64"
CFT_BIN="$SCRIPT_DIR/../integrations/runtime/chrome-$CFT_ARCH/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
EXTDIR="$SCRIPT_DIR/../integrations/framer"
if [ -x "$CFT_BIN" ]; then
  echo "launching bundled Chrome for Testing"
  FRAMER=()
  [ -d "$EXTDIR" ] && { FRAMER=(--load-extension="$EXTDIR"); echo "  + Framer extension (full in-app browser)"; }
  ( nohup "$CFT_BIN" \
      --app="$URL" \
      --user-data-dir="$CONF/cft" \
      --no-first-run --no-default-browser-check \
      "${FRAMER[@]}" >/dev/null 2>&1 & )
  echo "done"
  exit 0
fi

# ── Fallback: a system browser (independent LaunchServices process) ───────────
# Framer (the bundled in-app-browser extension) needs a browser that still honors
# --load-extension: branded Google Chrome 137+/142+ IGNORES it ("--load-extension is
# not allowed in Google Chrome, ignoring") — only Brave / Edge / Chromium / Chrome for
# Testing still load unpacked extensions. So when HUB_FRAMER=1 we pick one of those first.
CHROME_LIST=("Google Chrome" "Google Chrome Canary" "Brave Browser" "Microsoft Edge")
FRAMER_LIST=("Brave Browser" "Microsoft Edge" "Chromium" "Google Chrome for Testing")
APPNAME=""
if [ "${HUB_FRAMER:-0}" = "1" ]; then
  for a in "${FRAMER_LIST[@]}"; do [ -d "/Applications/${a}.app" ] && APPNAME="$a" && break; done
  if [ -z "$APPNAME" ]; then
    echo "Framer needs Brave / Edge / Chromium — branded Chrome ignores --load-extension; launching WITHOUT Framer"
    osascript -e 'display alert "CLONE FRAME HUB — Framer" message "The in-app browser extension needs Brave, Edge, or Chromium. Branded Google Chrome (137+) no longer loads it from the command line. Install Brave or Edge to enable full in-app browsing, or continue without it."' >/dev/null 2>&1 || true
    HUB_FRAMER=0
  fi
fi
[ -z "$APPNAME" ] && for a in "${CHROME_LIST[@]}"; do [ -d "/Applications/${a}.app" ] && APPNAME="$a" && break; done

if [ -n "$APPNAME" ]; then
  echo "opening $APPNAME app window"
  # HUB_PROFILE=main  → use the real Chrome profile (your wallet extensions are here)
  # HUB_PROFILE=clean → dedicated isolated profile (no extensions)
  PROFILE="${HUB_PROFILE:-main}"
  # HUB_FRAMER=1 → load the bundled Framer extension (Tier-2: embed anti-framing sites
  # directly in the in-app browser). It strips X-Frame-Options/CSP on FRAMED sub-resources
  # ONLY, and forces the ISOLATED profile so it never touches your everyday browsing
  # (trade-off: no wallet extensions in that window). --load-extension applies only on a
  # fresh Chrome, which the dedicated --user-data-dir guarantees. Default (unset) = off.
  EXTDIR="$SCRIPT_DIR/../integrations/framer"
  FRAMER_ARGS=()
  if [ "${HUB_FRAMER:-0}" = "1" ] && [ -d "$EXTDIR" ]; then
    PROFILE="clean"
    FRAMER_ARGS=(--load-extension="$EXTDIR" --disable-features=DisableLoadExtensionCommandLineSwitch)
    echo "Framer (Tier-2 embedding) enabled — isolated profile"
  fi
  if [ "$PROFILE" = "clean" ]; then
    /usr/bin/open -na "$APPNAME" --args \
      --app="$URL" \
      --user-data-dir="$CONF/chrome" \
      --no-first-run --no-default-browser-check \
      "${FRAMER_ARGS[@]}"
  else
    # reuse the default profile so MetaMask / wallet extensions are available
    /usr/bin/open -na "$APPNAME" --args \
      --app="$URL" \
      --no-first-run --no-default-browser-check
  fi
else
  echo "no chromium browser found — opening default browser"
  /usr/bin/open "$URL"
fi
echo "done"
