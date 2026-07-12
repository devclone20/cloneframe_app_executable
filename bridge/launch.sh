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

# open a standalone Chrome app window (independent LaunchServices process).
APPNAME=""
for a in "Google Chrome" "Google Chrome Canary" "Brave Browser" "Microsoft Edge"; do
  [ -d "/Applications/${a}.app" ] && APPNAME="$a" && break
done

if [ -n "$APPNAME" ]; then
  echo "opening $APPNAME app window"
  # HUB_PROFILE=main  → use the real Chrome profile (your wallet extensions are here)
  # HUB_PROFILE=clean → dedicated isolated profile (no extensions)
  PROFILE="${HUB_PROFILE:-main}"
  if [ "$PROFILE" = "clean" ]; then
    /usr/bin/open -na "$APPNAME" --args \
      --app="$URL" \
      --user-data-dir="$CONF/chrome" \
      --no-first-run --no-default-browser-check
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
